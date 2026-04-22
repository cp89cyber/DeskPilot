import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeskPilotConfig } from "../../src/types/config.js";

const mocks = vi.hoisted(() => ({
  BrowserProfileInUseError: class BrowserProfileInUseError extends Error {
    readonly host?: string;

    readonly pid?: number;

    readonly profileDir: string;

    constructor(profileDir: string, host?: string, pid?: number) {
      super("profile in use");
      this.name = "BrowserProfileInUseError";
      this.profileDir = profileDir;
      this.host = host;
      this.pid = pid;
    }
  },
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
  BrowserProfileInUseError: mocks.BrowserProfileInUseError,
  validateBrowserGoogleProfile: mocks.validateBrowserGoogleProfile,
}));

import { authenticateBrowserProfile } from "../../src/google/browser/auth.js";
import {
  terminateBrowserProcess,
  waitForProcessExit,
} from "../../src/google/browser/auth.js";

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

function makeLaunchedProcess(pid?: number) {
  return {
    pid,
    unref: vi.fn(),
  };
}

function makeErrno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("browser auth helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStdinTty(true);
    mocks.execa.mockReturnValue(makeLaunchedProcess());
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
        "--disable-background-mode",
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

  it("prints the isolated profile warning and launched pid when available", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runtime = {
      execa: vi.fn().mockReturnValue(makeLaunchedProcess(91234)),
      platform: "linux" as NodeJS.Platform,
      kill: vi.fn().mockImplementation(() => {
        throw makeErrno("ESRCH");
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
    };

    await authenticateBrowserProfile(makeConfig(), runtime);

    expect(logSpy).toHaveBeenCalledWith(
      "DeskPilot uses an isolated Chrome profile and will not reuse your regular Chrome session.",
    );
    expect(logSpy).toHaveBeenCalledWith("PID: 91234");

    logSpy.mockRestore();
  });

  it("validates the saved profile only after user confirmation", async () => {
    const prompt = {
      close: vi.fn(),
      question: vi.fn().mockResolvedValue(""),
    };
    mocks.createInterface.mockReturnValue(prompt);

    let alive = true;
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      now += ms;
      alive = false;
    });
    const runtime = {
      execa: vi.fn().mockReturnValue(makeLaunchedProcess(91234)),
      platform: "linux" as NodeJS.Platform,
      kill: vi.fn().mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 0 || signal === undefined) {
          if (alive) {
            return true;
          }
          throw makeErrno("ESRCH");
        }
        return true;
      }),
      sleep,
    };

    await authenticateBrowserProfile(makeConfig(), runtime);

    expect(prompt.question).toHaveBeenCalledTimes(1);
    expect(prompt.question.mock.invocationCallOrder[0]).toBeLessThan(
      sleep.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(sleep.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.validateBrowserGoogleProfile.mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );

    nowSpy.mockRestore();
  });

  it("gracefully terminates the launched Chrome process when it still holds the profile", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let alive = true;
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      now += ms;
    });
    const kill = vi.fn().mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 || signal === undefined) {
        if (alive) {
          return true;
        }
        throw makeErrno("ESRCH");
      }

      if (signal === "SIGTERM") {
        alive = false;
      }

      return true;
    });
    const runtime = {
      execa: vi.fn().mockReturnValue(makeLaunchedProcess(91234)),
      platform: "linux" as NodeJS.Platform,
      kill,
      sleep,
    };

    await authenticateBrowserProfile(makeConfig(), runtime);

    expect(kill).toHaveBeenCalledWith(91234, "SIGTERM");
    expect(logSpy).toHaveBeenCalledWith(
      "DeskPilot is closing the dedicated Chrome process still holding the profile (PID: 91234).",
    );
    expect(mocks.validateBrowserGoogleProfile).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("falls back cleanly when the launched Chrome process does not expose a pid", async () => {
    const runtime = {
      execa: vi.fn().mockReturnValue(makeLaunchedProcess()),
      platform: "linux" as NodeJS.Platform,
      kill: vi.fn(),
      sleep: vi.fn().mockResolvedValue(undefined),
    };

    await authenticateBrowserProfile(makeConfig(), runtime);

    expect(runtime.kill).not.toHaveBeenCalled();
    expect(mocks.validateBrowserGoogleProfile).toHaveBeenCalledTimes(1);
  });

  it("fails fast when stdin is not interactive", async () => {
    setStdinTty(false);

    await expect(authenticateBrowserProfile(makeConfig())).rejects.toThrow(
      "DeskPilot browser auth requires an interactive terminal.",
    );
    expect(mocks.execa).not.toHaveBeenCalled();
  });

  it("maps profile-in-use validation failures to a close-the-window instruction", async () => {
    mocks.validateBrowserGoogleProfile.mockRejectedValue(
      new mocks.BrowserProfileInUseError(
        "/tmp/home/browser/google-chrome",
        "penguin",
        445,
      ),
    );
    const authentication = authenticateBrowserProfile(makeConfig());

    await expect(authentication).rejects.toThrow(
      "DeskPilot could not validate the saved Chrome profile because Chrome is still using it.",
    );
    await expect(authentication).rejects.toThrow(
      "Holding PID: 445 on penguin",
    );
    await expect(authentication).rejects.toThrow(
      "Fully quit every DeskPilot Chrome window using /tmp/home/browser/google-chrome",
    );
  });
});

describe("browser auth process helpers", () => {
  it("waits for a process to exit", async () => {
    let alive = true;
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const runtime = {
      execa: vi.fn(),
      platform: "linux" as NodeJS.Platform,
      kill: vi.fn().mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 0 || signal === undefined) {
          if (alive) {
            return true;
          }
          throw makeErrno("ESRCH");
        }
        return true;
      }),
      sleep: vi.fn().mockImplementation(async (ms: number) => {
        now += ms;
        alive = false;
      }),
    };

    await expect(waitForProcessExit(445, 5_000, 250, runtime)).resolves.toBe(true);

    nowSpy.mockRestore();
  });

  it("uses taskkill on Windows when terminating a browser process", async () => {
    const runtime = {
      execa: vi.fn().mockResolvedValue({ exitCode: 0 }),
      platform: "win32" as NodeJS.Platform,
      kill: vi.fn(),
      sleep: vi.fn().mockResolvedValue(undefined),
    };

    await terminateBrowserProcess(445, runtime);

    expect(runtime.execa).toHaveBeenCalledWith("taskkill", ["/PID", "445", "/T"], {
      reject: false,
    });
    expect(runtime.kill).not.toHaveBeenCalled();
  });
});
