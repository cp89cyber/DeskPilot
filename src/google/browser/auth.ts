import { createInterface } from "node:readline/promises";

import { execa } from "execa";

import type { DeskPilotConfig } from "../../types/config.js";
import {
  BrowserGoogleSessionManager,
  BrowserProfileInUseError,
  validateBrowserGoogleProfile,
} from "./session.js";
import { browserAuthTargets } from "./targets.js";

const NATIVE_BROWSER_EXIT_GRACE_MS = 5_000;
const NATIVE_BROWSER_TERMINATE_GRACE_MS = 10_000;
const NATIVE_BROWSER_POLL_INTERVAL_MS = 250;

interface NativeChromeLaunchHandle {
  pid?: number;
}

interface BrowserAuthRuntime {
  readonly execa: typeof execa;
  readonly platform: NodeJS.Platform;
  kill(pid: number, signal?: NodeJS.Signals | number): boolean;
  sleep(ms: number): Promise<void>;
}

const defaultBrowserAuthRuntime: BrowserAuthRuntime = {
  execa,
  platform: process.platform,
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: async (ms) =>
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiresInteractiveTerminal(): void {
  if (process.stdin.isTTY) {
    return;
  }

  throw new Error(
    "DeskPilot browser auth requires an interactive terminal. Re-run `deskpilot auth google` in a local shell, or use `deskpilot auth google --provider oauth` instead.",
  );
}

function nativeChromeArgs(profileDir: string): string[] {
  const targets = browserAuthTargets();
  return [
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    targets.gmailUrl,
    targets.calendarUrl,
  ];
}

async function launchNativeChrome(
  executablePath: string,
  profileDir: string,
  runtime: BrowserAuthRuntime = defaultBrowserAuthRuntime,
): Promise<NativeChromeLaunchHandle> {
  try {
    const subprocess = runtime.execa(executablePath, nativeChromeArgs(profileDir), {
      detached: true,
      reject: false,
      stdio: "ignore",
    });
    subprocess.unref();
    return {
      pid: typeof subprocess.pid === "number" ? subprocess.pid : undefined,
    };
  } catch (error) {
    throw new Error(
      `Failed to open Google Chrome for DeskPilot browser auth. ${toErrorMessage(error)}`,
    );
  }
}

export function isProcessAlive(
  pid: number,
  runtime: BrowserAuthRuntime = defaultBrowserAuthRuntime,
): boolean {
  try {
    runtime.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  pollIntervalMs = NATIVE_BROWSER_POLL_INTERVAL_MS,
  runtime: BrowserAuthRuntime = defaultBrowserAuthRuntime,
): Promise<boolean> {
  if (!isProcessAlive(pid, runtime)) {
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await runtime.sleep(pollIntervalMs);
    if (!isProcessAlive(pid, runtime)) {
      return true;
    }
  }

  return !isProcessAlive(pid, runtime);
}

export async function terminateBrowserProcess(
  pid: number,
  runtime: BrowserAuthRuntime = defaultBrowserAuthRuntime,
): Promise<void> {
  if (runtime.platform === "win32") {
    await runtime.execa("taskkill", ["/PID", String(pid), "/T"], {
      reject: false,
    });
    return;
  }

  try {
    runtime.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ESRCH") {
      return;
    }
    throw error;
  }
}

async function waitForUserConfirmation(): Promise<void> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    await prompt.question(
      "Press Enter after Gmail and Calendar are signed in and every DeskPilot Chrome window using this profile is closed: ",
    );
  } finally {
    prompt.close();
  }
}

async function releaseLaunchedChromeProcess(
  launchHandle: NativeChromeLaunchHandle,
  runtime: BrowserAuthRuntime,
): Promise<void> {
  if (launchHandle.pid === undefined) {
    return;
  }

  const exitedNormally = await waitForProcessExit(
    launchHandle.pid,
    NATIVE_BROWSER_EXIT_GRACE_MS,
    NATIVE_BROWSER_POLL_INTERVAL_MS,
    runtime,
  );
  if (exitedNormally) {
    return;
  }

  console.log(
    `DeskPilot is closing the dedicated Chrome process still holding the profile (PID: ${launchHandle.pid}).`,
  );

  try {
    await terminateBrowserProcess(launchHandle.pid, runtime);
  } catch (error) {
    console.warn(
      `DeskPilot could not gracefully close the dedicated Chrome process (PID: ${launchHandle.pid}). Continuing to profile validation. ${toErrorMessage(error)}`,
    );
    return;
  }

  await waitForProcessExit(
    launchHandle.pid,
    NATIVE_BROWSER_TERMINATE_GRACE_MS,
    NATIVE_BROWSER_POLL_INTERVAL_MS,
    runtime,
  );
}

function browserValidationError(profileDir: string, error: unknown): Error {
  const originalMessage = toErrorMessage(error);
  return new Error(
    [
      "DeskPilot could not validate the saved Chrome profile.",
      `Close every DeskPilot Chrome window using ${profileDir}, make sure Gmail and Calendar are signed in there, then rerun \`deskpilot auth google --provider browser\`.`,
      `Original error: ${originalMessage}`,
    ].join("\n"),
  );
}

function browserProfileInUseValidationError(
  profileDir: string,
  error: BrowserProfileInUseError,
): Error {
  const details = [
    "DeskPilot could not validate the saved Chrome profile because Chrome is still using it.",
    `Profile: ${profileDir}`,
  ];

  if (error.pid !== undefined) {
    details.push(
      `Holding PID: ${error.pid}${error.host ? ` on ${error.host}` : ""}`,
    );
  } else if (error.host) {
    details.push(`Holding host: ${error.host}`);
  }

  details.push(
    `Fully quit every DeskPilot Chrome window using ${profileDir}, wait a few seconds, and rerun \`deskpilot auth google --provider browser\`.`,
  );

  return new Error(details.join("\n"));
}

export async function authenticateBrowserProfile(
  config: DeskPilotConfig,
  runtime: BrowserAuthRuntime = defaultBrowserAuthRuntime,
): Promise<void> {
  requiresInteractiveTerminal();

  const session = new BrowserGoogleSessionManager(config);
  const targets = browserAuthTargets();

  console.log("Opening dedicated Chrome profile for DeskPilot Google browser auth.");
  console.log(`Chrome: ${session.executablePath}`);
  console.log(`Profile: ${session.profileDir}`);
  console.log("DeskPilot uses an isolated Chrome profile and will not reuse your regular Chrome session.");
  console.log(`Gmail: ${targets.gmailUrl}`);
  console.log(`Calendar: ${targets.calendarUrl}`);

  const launchHandle = await launchNativeChrome(
    session.executablePath,
    session.profileDir,
    runtime,
  );
  if (launchHandle.pid !== undefined) {
    console.log(`PID: ${launchHandle.pid}`);
  }

  console.log("Sign in to Gmail and Google Calendar in the opened Chrome window.");
  console.log("When both load successfully, close every DeskPilot Chrome window using that profile.");
  console.log("After you press Enter, DeskPilot will wait briefly for Chrome to fully release the profile.");
  await waitForUserConfirmation();
  await releaseLaunchedChromeProcess(launchHandle, runtime);

  try {
    await validateBrowserGoogleProfile(session);
  } catch (error) {
    if (error instanceof BrowserProfileInUseError) {
      throw browserProfileInUseValidationError(session.profileDir, error);
    }
    throw browserValidationError(session.profileDir, error);
  } finally {
    await session.close();
  }
}
