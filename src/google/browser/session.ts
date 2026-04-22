import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  chromium,
  type BrowserContext,
  type Page,
} from "playwright-core";

import type { DeskPilotConfig } from "../../types/config.js";
import { CALENDAR_URL, GMAIL_URL } from "./targets.js";

const DEFAULT_BROWSER_VALIDATION_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PROFILE_AVAILABILITY_TIMEOUT_MS = 30_000;
const DEFAULT_PROFILE_AVAILABILITY_POLL_INTERVAL_MS = 500;
const PROFILE_SINGLETON_ARTIFACTS = [
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
] as const;

const KNOWN_CHROME_PATHS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  linux: [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/snap/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Chromium\\Application\\chrome.exe",
  ],
};

function executableInPath(name: string): string | undefined {
  const searchPath = process.env.PATH;
  if (!searchPath) {
    return undefined;
  }

  const extensions = process.platform === "win32"
    ? ["", ".exe", ".cmd", ".bat"]
    : [""];

  for (const dir of searchPath.split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function knownExecutablePaths(): string[] {
  const platformCandidates = KNOWN_CHROME_PATHS[process.platform] ?? [];
  const pathCandidates = process.platform === "win32"
    ? ["chrome"]
    : ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];

  return [
    ...platformCandidates,
    ...pathCandidates
      .map((candidate) => executableInPath(candidate))
      .filter((candidate): candidate is string => Boolean(candidate)),
  ];
}

export function resolveChromeExecutablePath(config: DeskPilotConfig): string {
  const configured = config.googleBrowser.executablePath;
  if (configured) {
    if (!fs.existsSync(configured)) {
      throw new Error(
        `Configured Google browser executable does not exist: ${configured}`,
      );
    }
    return configured;
  }

  const discovered = knownExecutablePaths().find((candidate) => fs.existsSync(candidate));
  if (discovered) {
    return discovered;
  }

  throw new Error(
    "Google Chrome was not found. Set DESKPILOT_GOOGLE_BROWSER_PATH or google.browser.executablePath in your DeskPilot config.",
  );
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function ensureProfileDir(profileDir: string): Promise<void> {
  await fs.promises.mkdir(profileDir, { recursive: true });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

function isProfileSingletonError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ProcessSingleton|SingletonLock|profile directory.*another instance of Chromium/i.test(
    message,
  );
}

interface BrowserSessionRuntime {
  hostname(): string;
  isProcessAlive(pid: number): boolean;
  launchPersistentContext(
    profileDir: string,
    options: Parameters<typeof chromium.launchPersistentContext>[1],
  ): Promise<BrowserContext>;
  sleep(ms: number): Promise<void>;
}

const defaultBrowserSessionRuntime: BrowserSessionRuntime = {
  hostname: () => os.hostname(),
  isProcessAlive,
  launchPersistentContext: async (profileDir, options) =>
    await chromium.launchPersistentContext(profileDir, options),
  sleep: async (ms) => await delay(ms),
};

type BrowserProfileLockState = "free" | "in_use" | "stale";

interface BrowserProfileLockInspection {
  artifacts: string[];
  host?: string;
  pid?: number;
  state: BrowserProfileLockState;
}

interface BrowserProfileAvailabilityOptions {
  pollIntervalMs: number;
  timeoutMs: number;
}

interface BrowserGoogleSessionManagerOptions {
  profileAvailabilityPollIntervalMs?: number;
  profileAvailabilityTimeoutMs?: number;
  runtime?: BrowserSessionRuntime;
}

function singletonArtifactPath(
  profileDir: string,
  artifact: typeof PROFILE_SINGLETON_ARTIFACTS[number],
): string {
  return path.join(profileDir, artifact);
}

async function existingSingletonArtifacts(profileDir: string): Promise<string[]> {
  const entries = await Promise.all(
    PROFILE_SINGLETON_ARTIFACTS.map(async (artifact) => {
      try {
        await fs.promises.lstat(singletonArtifactPath(profileDir, artifact));
        return artifact;
      } catch (error) {
        if (isNotFoundError(error)) {
          return undefined;
        }
        throw error;
      }
    }),
  );

  return entries.filter(
    (
      artifact,
    ): artifact is typeof PROFILE_SINGLETON_ARTIFACTS[number] =>
      artifact !== undefined,
  );
}

function parseSingletonLockTarget(linkTarget: string): { host: string; pid: number } | undefined {
  const target = path.basename(linkTarget);
  const separatorIndex = target.lastIndexOf("-");
  if (separatorIndex <= 0 || separatorIndex === target.length - 1) {
    return undefined;
  }

  const host = target.slice(0, separatorIndex);
  const pid = Number.parseInt(target.slice(separatorIndex + 1), 10);
  if (!host || Number.isNaN(pid) || pid <= 0) {
    return undefined;
  }

  return { host, pid };
}

async function inspectBrowserProfileLock(
  profileDir: string,
  runtime: BrowserSessionRuntime,
): Promise<BrowserProfileLockInspection> {
  const artifacts = await existingSingletonArtifacts(profileDir);
  if (artifacts.length === 0) {
    return {
      artifacts: [],
      state: "free",
    };
  }

  if (process.platform === "win32") {
    return {
      artifacts,
      state: "in_use",
    };
  }

  if (!artifacts.includes("SingletonLock")) {
    return {
      artifacts,
      state: "stale",
    };
  }

  const lockPath = singletonArtifactPath(profileDir, "SingletonLock");

  let linkTarget: string;
  try {
    linkTarget = await fs.promises.readlink(lockPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return await inspectBrowserProfileLock(profileDir, runtime);
    }

    return {
      artifacts,
      state: "stale",
    };
  }

  const owner = parseSingletonLockTarget(linkTarget);
  if (!owner) {
    return {
      artifacts,
      state: "stale",
    };
  }

  if (owner.host !== runtime.hostname()) {
    return {
      artifacts,
      host: owner.host,
      pid: owner.pid,
      state: "stale",
    };
  }

  if (!runtime.isProcessAlive(owner.pid)) {
    return {
      artifacts,
      host: owner.host,
      pid: owner.pid,
      state: "stale",
    };
  }

  return {
    artifacts,
    host: owner.host,
    pid: owner.pid,
    state: "in_use",
  };
}

async function removeStaleSingletonArtifacts(profileDir: string): Promise<void> {
  await Promise.all(
    PROFILE_SINGLETON_ARTIFACTS.map(async (artifact) => {
      try {
        await fs.promises.unlink(singletonArtifactPath(profileDir, artifact));
      } catch (error) {
        if (isNotFoundError(error)) {
          return;
        }
        throw error;
      }
    }),
  );
}

function browserProfileInUseMessage(
  profileDir: string,
  host?: string,
  pid?: number,
): string {
  const details = [
    `DeskPilot could not access the Chrome profile because it is still in use: ${profileDir}.`,
  ];

  if (pid !== undefined) {
    details.push(
      `Chrome is still holding that profile${host ? ` on ${host}` : ""} with PID ${pid}.`,
    );
  } else if (host) {
    details.push(`Chrome may still be holding that profile on ${host}.`);
  }

  details.push(
    "Fully quit every DeskPilot Chrome window using that profile, wait a few seconds, and try again.",
  );

  return details.join(" ");
}

export class BrowserProfileInUseError extends Error {
  readonly host?: string;

  readonly pid?: number;

  readonly profileDir: string;

  constructor(profileDir: string, host?: string, pid?: number) {
    super(browserProfileInUseMessage(profileDir, host, pid));
    this.name = "BrowserProfileInUseError";
    this.profileDir = profileDir;
    this.host = host;
    this.pid = pid;
  }
}

async function waitForBrowserProfileAvailability(
  profileDir: string,
  runtime: BrowserSessionRuntime,
  options: BrowserProfileAvailabilityOptions,
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  let lastInspection: BrowserProfileLockInspection = {
    artifacts: [],
    state: "free",
  };

  while (true) {
    const inspection = await inspectBrowserProfileLock(profileDir, runtime);
    lastInspection = inspection;

    if (inspection.state === "free") {
      return;
    }

    if (inspection.state === "stale") {
      await removeStaleSingletonArtifacts(profileDir);
      continue;
    }

    if (Date.now() >= deadline) {
      throw new BrowserProfileInUseError(
        profileDir,
        lastInspection.host,
        lastInspection.pid,
      );
    }

    await runtime.sleep(options.pollIntervalMs);
  }
}

async function waitForAppHost(
  page: Page,
  host: string,
  timeoutMs: number,
  actionDescription: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const currentUrl = page.url();
    try {
      const currentHost = new URL(currentUrl).host;
      if (currentHost === host) {
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        return;
      }
    } catch {
      // Ignore invalid intermediate URLs during navigation.
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `${actionDescription} timed out waiting for ${host}. Complete Google sign-in in the opened browser, then try again.`,
  );
}

function persistentContextOptions(
  executablePath: string,
): Parameters<typeof chromium.launchPersistentContext>[1] {
  return {
    executablePath,
    headless: false,
    viewport: { width: 1440, height: 960 },
    args: [
      "--disable-features=Translate,OptimizationHints",
      "--start-maximized",
    ],
  };
}

export class BrowserGoogleSessionManager {
  private contextPromise?: Promise<BrowserContext>;

  private operationQueue: Promise<void> = Promise.resolve();

  private readonly profileAvailabilityPollIntervalMs: number;

  private readonly profileAvailabilityTimeoutMs: number;

  private readonly runtime: BrowserSessionRuntime;

  constructor(
    private readonly config: DeskPilotConfig,
    options: BrowserGoogleSessionManagerOptions = {},
  ) {
    this.profileAvailabilityPollIntervalMs =
      options.profileAvailabilityPollIntervalMs ??
      DEFAULT_PROFILE_AVAILABILITY_POLL_INTERVAL_MS;
    this.profileAvailabilityTimeoutMs =
      options.profileAvailabilityTimeoutMs ??
      DEFAULT_PROFILE_AVAILABILITY_TIMEOUT_MS;
    this.runtime = options.runtime ?? defaultBrowserSessionRuntime;
  }

  get executablePath(): string {
    return resolveChromeExecutablePath(this.config);
  }

  get profileDir(): string {
    return this.config.googleBrowser.profileDir;
  }

  async withPage<T>(task: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const context = await this.ensureContext();
      const page = context.pages()[0] ?? await context.newPage();
      await page.bringToFront().catch(() => undefined);
      return await task(page, context);
    };

    const chained = this.operationQueue.then(run, run);
    this.operationQueue = chained.then(
      () => undefined,
      () => undefined,
    );

    return await chained;
  }

  async close(): Promise<void> {
    if (!this.contextPromise) {
      return;
    }

    const contextPromise = this.contextPromise;
    this.contextPromise = undefined;

    try {
      const context = await contextPromise;
      await context.close();
    } catch {
      // Ignore launch failures when closing a never-opened context.
    }
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (!this.contextPromise) {
      const contextPromise = this.launchContext();
      this.contextPromise = contextPromise;

      try {
        return await contextPromise;
      } catch (error) {
        if (this.contextPromise === contextPromise) {
          this.contextPromise = undefined;
        }
        throw error;
      }
    }

    return await this.contextPromise;
  }

  private async launchContext(): Promise<BrowserContext> {
    await ensureProfileDir(this.profileDir);
    const launch = async (): Promise<BrowserContext> =>
      await this.runtime.launchPersistentContext(
        this.profileDir,
        persistentContextOptions(this.executablePath),
      );

    const availabilityOptions = {
      pollIntervalMs: this.profileAvailabilityPollIntervalMs,
      timeoutMs: this.profileAvailabilityTimeoutMs,
    };

    await waitForBrowserProfileAvailability(
      this.profileDir,
      this.runtime,
      availabilityOptions,
    );

    try {
      return await launch();
    } catch (error) {
      if (!isProfileSingletonError(error)) {
        throw error;
      }
    }

    await waitForBrowserProfileAvailability(
      this.profileDir,
      this.runtime,
      availabilityOptions,
    );

    try {
      return await launch();
    } catch (error) {
      if (!isProfileSingletonError(error)) {
        throw error;
      }

      const inspection = await inspectBrowserProfileLock(this.profileDir, this.runtime);
      if (inspection.state === "in_use") {
        throw new BrowserProfileInUseError(
          this.profileDir,
          inspection.host,
          inspection.pid,
        );
      }

      throw error;
    }
  }
}

export async function validateBrowserGoogleProfile(
  session: BrowserGoogleSessionManager,
  timeoutMs = DEFAULT_BROWSER_VALIDATION_TIMEOUT_MS,
): Promise<void> {
  await session.withPage(async (page) => {
    await page.goto(GMAIL_URL, { waitUntil: "domcontentloaded" });
    await waitForAppHost(
      page,
      "mail.google.com",
      timeoutMs,
      "DeskPilot browser profile validation",
    );

    await page.goto(CALENDAR_URL, { waitUntil: "domcontentloaded" });
    await waitForAppHost(
      page,
      "calendar.google.com",
      timeoutMs,
      "DeskPilot browser profile validation",
    );
  });
}

export async function assertBrowserGoogleAuthenticated(
  session: BrowserGoogleSessionManager,
): Promise<void> {
  await session.withPage(async (page) => {
    await page.goto(GMAIL_URL, { waitUntil: "domcontentloaded" });
    await waitForAppHost(
      page,
      "mail.google.com",
      15_000,
      "DeskPilot browser access",
    );
  });
}
