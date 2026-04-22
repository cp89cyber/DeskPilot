import fs from "node:fs";
import path from "node:path";

import {
  chromium,
  type BrowserContext,
  type Page,
} from "playwright-core";

import type { DeskPilotConfig } from "../../types/config.js";
import { CALENDAR_URL, GMAIL_URL } from "./targets.js";

const DEFAULT_BROWSER_VALIDATION_TIMEOUT_MS = 5 * 60 * 1000;

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

async function ensureProfileDir(profileDir: string): Promise<void> {
  await fs.promises.mkdir(profileDir, { recursive: true });
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

  constructor(private readonly config: DeskPilotConfig) {}

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

    const context = await this.contextPromise;
    await context.close();
    this.contextPromise = undefined;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (!this.contextPromise) {
      this.contextPromise = this.launchContext();
    }

    return await this.contextPromise;
  }

  private async launchContext(): Promise<BrowserContext> {
    await ensureProfileDir(this.profileDir);
    return await chromium.launchPersistentContext(
      this.profileDir,
      persistentContextOptions(this.executablePath),
    );
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
