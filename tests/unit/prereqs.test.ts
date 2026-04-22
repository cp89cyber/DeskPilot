import { describe, expect, it, vi } from "vitest";

import type { DeskPilotConfig } from "../../src/types/config.js";

const mocks = vi.hoisted(() => ({
  execa: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: mocks.execa,
}));

vi.mock("../../src/google/browser/session.js", () => ({
  resolveChromeExecutablePath: vi.fn(),
}));

import { ensureCodexLoggedIn } from "../../src/prereqs.js";

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
      profileDir: "/tmp/home/browser/google-chrome",
    },
  };
}

describe("ensureCodexLoggedIn", () => {
  it("accepts successful login status when success text is only in stderr", async () => {
    mocks.execa.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "",
      stderr: "Logged in using ChatGPT",
    });

    await expect(ensureCodexLoggedIn(makeConfig())).resolves.toBeUndefined();
    expect(mocks.execa).toHaveBeenCalledWith("codex", ["login", "status"], {
      reject: false,
    });
  });

  it("accepts successful login status when success text is only in stdout", async () => {
    mocks.execa.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "Logged in using ChatGPT",
      stderr: "",
    });

    await expect(ensureCodexLoggedIn(makeConfig())).resolves.toBeUndefined();
  });

  it("accepts successful login status with no output", async () => {
    mocks.execa.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    await expect(ensureCodexLoggedIn(makeConfig())).resolves.toBeUndefined();
  });

  it("includes command diagnostics when login status fails", async () => {
    mocks.execa.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "Not logged in",
    });

    await expect(ensureCodexLoggedIn(makeConfig())).rejects.toThrow(
      "Codex is not logged in. Run `codex login` first.\n\nNot logged in",
    );
  });
});
