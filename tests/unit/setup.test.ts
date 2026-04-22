import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../src/logger.js";
import type { DeskPilotConfig } from "../../src/types/config.js";

const mocks = vi.hoisted(() => ({
  createBaseContext: vi.fn(),
  createRuntimeContext: vi.fn(),
  ensureCodexInstalled: vi.fn(),
  ensureCodexLoggedIn: vi.fn(),
  ensureGoogleBrowserAvailable: vi.fn(),
  ensureWorkspaceMcpRegistered: vi.fn(),
  ensureWorkspaceServerBuilt: vi.fn(),
  registerWorkspaceMcpServer: vi.fn(),
  resolvedGoogleBrowserDetails: vi.fn(),
}));

vi.mock("../../src/runtime.js", () => ({
  createBaseContext: mocks.createBaseContext,
  createRuntimeContext: mocks.createRuntimeContext,
}));

vi.mock("../../src/prereqs.js", () => ({
  ensureCodexInstalled: mocks.ensureCodexInstalled,
  ensureCodexLoggedIn: mocks.ensureCodexLoggedIn,
  ensureGoogleBrowserAvailable: mocks.ensureGoogleBrowserAvailable,
  ensureWorkspaceMcpRegistered: mocks.ensureWorkspaceMcpRegistered,
  ensureWorkspaceServerBuilt: mocks.ensureWorkspaceServerBuilt,
  registerWorkspaceMcpServer: mocks.registerWorkspaceMcpServer,
  resolvedGoogleBrowserDetails: mocks.resolvedGoogleBrowserDetails,
}));

import { registerSetupCommand } from "../../src/commands/setup.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function makeConfig(repoRoot: string, deskpilotHome: string): DeskPilotConfig {
  return {
    repoRoot,
    deskpilotHome,
    runtimeDir: path.join(deskpilotHome, "runtime"),
    logsDir: path.join(deskpilotHome, "logs"),
    dbPath: path.join(deskpilotHome, "state.db"),
    googleTokenPath: path.join(deskpilotHome, "google-oauth.json"),
    configFilePath: path.join(deskpilotHome, "config.json"),
    model: "gpt-5.4",
    codexBinary: "codex",
    mcpServerName: "deskpilot-workspace",
    googleMode: "oauth",
    googleBrowser: {
      profileDir: path.join(deskpilotHome, "browser-profile"),
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

afterEach(() => {
  vi.restoreAllMocks();

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe("setup command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureCodexInstalled.mockResolvedValue(undefined);
    mocks.ensureCodexLoggedIn.mockResolvedValue(undefined);
    mocks.ensureGoogleBrowserAvailable.mockImplementation(() => undefined);
    mocks.ensureWorkspaceMcpRegistered.mockResolvedValue(false);
    mocks.ensureWorkspaceServerBuilt.mockResolvedValue(undefined);
    mocks.registerWorkspaceMcpServer.mockResolvedValue(undefined);
    mocks.resolvedGoogleBrowserDetails.mockReturnValue({
      executablePath: "/usr/bin/google-chrome",
      profileDir: "/tmp/browser-profile",
    });
  });

  it("bootstraps setup without calling the runtime storage path", async () => {
    const repoRoot = makeTempDir("deskpilot-setup-repo-");
    const deskpilotHome = makeTempDir("deskpilot-setup-home-");
    const logger = makeLogger();
    const config = makeConfig(repoRoot, deskpilotHome);

    fs.mkdirSync(path.join(repoRoot, "templates"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "templates", "runtime-AGENTS.md"), "# runtime\n", "utf8");

    mocks.createBaseContext.mockReturnValue({ config, logger });
    mocks.createRuntimeContext.mockImplementation(() => {
      throw new Error("createRuntimeContext should not be called during setup");
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = new Command();
    registerSetupCommand(program);
    await program.parseAsync(["node", "deskpilot", "setup"]);

    logSpy.mockRestore();

    expect(mocks.createBaseContext).toHaveBeenCalledTimes(1);
    expect(mocks.createRuntimeContext).not.toHaveBeenCalled();
    expect(mocks.ensureCodexInstalled).toHaveBeenCalledWith(config);
    expect(mocks.ensureCodexLoggedIn).toHaveBeenCalledWith(config);
    expect(mocks.ensureWorkspaceServerBuilt).toHaveBeenCalledWith(config);
    expect(mocks.registerWorkspaceMcpServer).toHaveBeenCalledWith(config);
    expect(fs.existsSync(config.dbPath)).toBe(false);
    expect(fs.existsSync(path.join(config.runtimeDir, "AGENTS.md"))).toBe(true);
  });
});
