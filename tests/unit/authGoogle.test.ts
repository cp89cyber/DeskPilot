import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../src/logger.js";
import type { DeskPilotConfig } from "../../src/types/config.js";

const mocks = vi.hoisted(() => ({
  authenticateBrowserProfile: vi.fn(),
  authenticateGoogle: vi.fn(),
  createBaseContext: vi.fn(),
  ensureTokenFilePermissions: vi.fn(),
}));

vi.mock("../../src/google/browser/auth.js", () => ({
  authenticateBrowserProfile: mocks.authenticateBrowserProfile,
}));

vi.mock("../../src/google/oauth.js", () => ({
  authenticateGoogle: mocks.authenticateGoogle,
  ensureTokenFilePermissions: mocks.ensureTokenFilePermissions,
}));

vi.mock("../../src/runtime.js", () => ({
  createBaseContext: mocks.createBaseContext,
}));

import { registerAuthCommand } from "../../src/commands/authGoogle.js";

function makeConfig(googleMode: DeskPilotConfig["googleMode"]): DeskPilotConfig {
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
    googleMode,
    googleBrowser: {
      executablePath: "/usr/bin/google-chrome",
      profileDir: "/tmp/home/browser/google-chrome",
    },
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function runCommand(args: string[], googleMode: DeskPilotConfig["googleMode"]) {
  const logger = makeLogger();
  mocks.createBaseContext.mockReturnValue({
    config: makeConfig(googleMode),
    logger,
  });

  const program = new Command();
  registerAuthCommand(program);
  await program.parseAsync(["node", "deskpilot", "auth", "google", ...args]);

  return { logger };
}

describe("auth google command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateBrowserProfile.mockResolvedValue(undefined);
    mocks.authenticateGoogle.mockResolvedValue(undefined);
    mocks.ensureTokenFilePermissions.mockImplementation(() => undefined);
  });

  it("uses browser mode from config when --provider is omitted", async () => {
    await runCommand([], "browser");

    expect(mocks.authenticateBrowserProfile).toHaveBeenCalledTimes(1);
    expect(mocks.authenticateGoogle).not.toHaveBeenCalled();
  });

  it("uses oauth mode from config when --provider is omitted", async () => {
    await runCommand([], "oauth");

    expect(mocks.authenticateGoogle).toHaveBeenCalledTimes(1);
    expect(mocks.ensureTokenFilePermissions).toHaveBeenCalledTimes(1);
    expect(mocks.authenticateBrowserProfile).not.toHaveBeenCalled();
  });

  it("lets an explicit oauth provider override browser config", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await runCommand(["--provider", "oauth"], "browser");

    warnSpy.mockRestore();

    expect(mocks.authenticateGoogle).toHaveBeenCalledTimes(1);
    expect(mocks.authenticateBrowserProfile).not.toHaveBeenCalled();
  });

  it("lets an explicit browser provider override oauth config", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await runCommand(["--provider", "browser"], "oauth");

    warnSpy.mockRestore();

    expect(mocks.authenticateBrowserProfile).toHaveBeenCalledTimes(1);
    expect(mocks.authenticateGoogle).not.toHaveBeenCalled();
  });

  it("rejects invalid providers", async () => {
    await expect(runCommand(["--provider", "bogus"], "browser")).rejects.toThrow(
      "Unsupported Google auth provider: bogus. Use `browser` or `oauth`.",
    );
  });

  it("warns when an explicit provider differs from google.mode", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await runCommand(["--provider", "oauth"], "browser");

    expect(warnSpy).toHaveBeenCalledWith(
      "Authenticated with OAuth, but `google.mode` is still `browser`. DeskPilot commands will keep using browser mode until you change config.",
    );

    warnSpy.mockRestore();
  });
});
