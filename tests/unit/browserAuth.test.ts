import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeskPilotConfig } from "../../src/types/config.js";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createInterface: vi.fn(),
  execa: vi.fn(),
  validateBrowserGoogleProfile: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: mocks.execa,
}));

vi.mock("node:readline/promises", () => ({
  createInterface: mocks.createInterface,
}));

vi.mock("../../src/google/browser/session.js", () => ({
  BrowserGoogleSessionManager: class {
    readonly executablePath: string;

    readonly profileDir: string;

    constructor(config: DeskPilotConfig) {
      this.executablePath = config.googleBrowser.executablePath ?? "/usr/bin/google-chrome";
      this.profileDir = config.googleBrowser.profileDir;
    }

    async close(): Promise<void> {
      await mocks.close();
    }
  },
  validateBrowserGoogleProfile: mocks.validateBrowserGoogleProfile,
}));

import { authenticateBrowserProfile } from "../../src/google/browser/auth.js";

const originalIsTTY = process.stdin.isTTY;

function setStdinTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value,
  });
}

function makeConfig(): DeskPilotConfig {
  return {
    repoRoot: "/tmp/repo",
    deskpilotHome: "/tmp/home",
    runtimeDir: "/tmp/home/runtime",
    logsDir: "/tmp/home/logs",
    dbPath: "/tmp/home/state.db",
    googleTokenPath: "/tmp/home/google-oauth.json",
    configFilePath: "/tmp/home/config.json",
    model: "gpt-5.4",
    codexBinary: "codex",
    mcpServerName: "deskpilot-workspace",
    googleMode: "browser",
    googleBrowser: {
      executablePath: "/usr/bin/google-chrome",
      profileDir: "/tmp/home/browser/google-chrome",
    },
  };
}

describe("browser auth helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStdinTty(true);
    mocks.execa.mockReturnValue({
      unref: vi.fn(),
    });
    mocks.createInterface.mockReturnValue({
      close: vi.fn(),
      question: vi.fn().mockResolvedValue(""),
    });
    mocks.validateBrowserGoogleProfile.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
  });

  afterEach(() => {
    setStdinTty(originalIsTTY);
  });

  it("launches native Chrome with the dedicated profile and Google targets", async () => {
    await authenticateBrowserProfile(makeConfig());

    expect(mocks.execa).toHaveBeenCalledWith(
      "/usr/bin/google-chrome",
      [
        "--user-data-dir=/tmp/home/browser/google-chrome",
        "--new-window",
        "--no-first-run",
        "--no-default-browser-check",
        "https://mail.google.com/mail/u/0/#inbox",
        "https://calendar.google.com/calendar/u/0/r",
      ],
      {
        detached: true,
        reject: false,
        stdio: "ignore",
      },
    );
  });

  it("validates the saved profile only after user confirmation", async () => {
    const prompt = {
      close: vi.fn(),
      question: vi.fn().mockResolvedValue(""),
    };
    mocks.createInterface.mockReturnValue(prompt);

    await authenticateBrowserProfile(makeConfig());

    expect(prompt.question).toHaveBeenCalledTimes(1);
    expect(prompt.question.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.validateBrowserGoogleProfile.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("fails fast when stdin is not interactive", async () => {
    setStdinTty(false);

    await expect(authenticateBrowserProfile(makeConfig())).rejects.toThrow(
      "DeskPilot browser auth requires an interactive terminal.",
    );
    expect(mocks.execa).not.toHaveBeenCalled();
  });

  it("maps validation failures to a close-the-window instruction", async () => {
    mocks.validateBrowserGoogleProfile.mockRejectedValue(new Error("SingletonLock"));
    const authentication = authenticateBrowserProfile(makeConfig());

    await expect(authentication).rejects.toThrow(
      "DeskPilot could not validate the saved Chrome profile.",
    );
    await expect(authentication).rejects.toThrow(
      "Close every DeskPilot Chrome window using /tmp/home/browser/google-chrome",
    );
  });
});
