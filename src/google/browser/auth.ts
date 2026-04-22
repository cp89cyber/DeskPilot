import { createInterface } from "node:readline/promises";

import { execa } from "execa";

import type { DeskPilotConfig } from "../../types/config.js";
import {
  BrowserGoogleSessionManager,
  BrowserProfileInUseError,
  validateBrowserGoogleProfile,
} from "./session.js";
import { browserAuthTargets } from "./targets.js";

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
): Promise<void> {
  try {
    const subprocess = execa(executablePath, nativeChromeArgs(profileDir), {
      detached: true,
      reject: false,
      stdio: "ignore",
    });
    subprocess.unref();
  } catch (error) {
    throw new Error(
      `Failed to open Google Chrome for DeskPilot browser auth. ${toErrorMessage(error)}`,
    );
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

export async function authenticateBrowserProfile(config: DeskPilotConfig): Promise<void> {
  requiresInteractiveTerminal();

  const session = new BrowserGoogleSessionManager(config);
  const targets = browserAuthTargets();

  console.log("Opening dedicated Chrome profile for DeskPilot Google browser auth.");
  console.log(`Chrome: ${session.executablePath}`);
  console.log(`Profile: ${session.profileDir}`);
  console.log(`Gmail: ${targets.gmailUrl}`);
  console.log(`Calendar: ${targets.calendarUrl}`);

  await launchNativeChrome(session.executablePath, session.profileDir);

  console.log("Sign in to Gmail and Google Calendar in the opened Chrome window.");
  console.log("When both load successfully, close every DeskPilot Chrome window using that profile.");
  console.log("After you press Enter, DeskPilot will wait briefly for Chrome to fully release the profile.");
  await waitForUserConfirmation();

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
