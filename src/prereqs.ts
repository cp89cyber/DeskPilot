import fs from "node:fs";
import path from "node:path";

import { execa } from "execa";

import type { DeskPilotConfig } from "./types/config.js";

export function workspaceServerScriptPath(config: DeskPilotConfig): string {
  return path.join(config.repoRoot, "dist", "mcp", "workspaceServer.js");
}

export async function ensureCodexInstalled(config: DeskPilotConfig): Promise<void> {
  const result = await execa(config.codexBinary, ["--version"], {
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Codex CLI is not available on PATH as \`${config.codexBinary}\`.`);
  }
}

export async function ensureCodexLoggedIn(config: DeskPilotConfig): Promise<void> {
  const result = await execa(config.codexBinary, ["login", "status"], {
    reject: false,
  });
  if (result.exitCode !== 0 || !/Logged in/i.test(result.stdout)) {
    throw new Error("Codex is not logged in. Run `codex login` first.");
  }
}

export async function ensureWorkspaceServerBuilt(config: DeskPilotConfig): Promise<void> {
  if (fs.existsSync(workspaceServerScriptPath(config))) {
    return;
  }

  const result = await execa("npm", ["run", "build"], {
    cwd: config.repoRoot,
    reject: false,
  });
  if (result.exitCode !== 0 || !fs.existsSync(workspaceServerScriptPath(config))) {
    throw new Error(
      `Failed to build DeskPilot before MCP registration.\n${result.stderr || result.stdout}`,
    );
  }
}

export async function ensureWorkspaceMcpRegistered(config: DeskPilotConfig): Promise<boolean> {
  const result = await execa(
    config.codexBinary,
    ["mcp", "get", config.mcpServerName, "--json"],
    {
      reject: false,
    },
  );

  return result.exitCode === 0;
}

export async function registerWorkspaceMcpServer(config: DeskPilotConfig): Promise<void> {
  const scriptPath = workspaceServerScriptPath(config);
  const result = await execa(
    config.codexBinary,
    [
      "mcp",
      "add",
      config.mcpServerName,
      "--",
      process.execPath,
      scriptPath,
    ],
    {
      reject: false,
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(`Failed to register MCP server:\n${result.stderr || result.stdout}`);
  }
}
