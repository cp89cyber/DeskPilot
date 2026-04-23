import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

import { resolveChromeExecutablePath } from "./google/browser/session.js";
import type { DeskPilotConfig } from "./types/config.js";

export function workspaceServerScriptPath(config: DeskPilotConfig): string {
  return path.join(config.repoRoot, "dist", "mcp", "workspaceServer.js");
}

interface CodexMcpRegistration {
  enabled?: boolean;
  transport?: {
    type?: string;
    command?: string;
    args?: unknown;
  };
}

export type WorkspaceMcpRegistrationStatus = "missing" | "ready" | "stale";

export interface WorkspaceMcpRegistrationInspection {
  status: WorkspaceMcpRegistrationStatus;
  registration?: CodexMcpRegistration;
  reasons: string[];
}

export interface WorkspaceMcpRepairResult {
  action: "registered" | "repaired" | "unchanged";
  inspection: WorkspaceMcpRegistrationInspection;
}

function commandDiagnostics(stdout?: string, stderr?: string): string {
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

function parseMcpRegistration(rawJson: string): CodexMcpRegistration {
  const parsed = JSON.parse(rawJson) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Codex returned an invalid MCP registration response.");
  }

  return parsed as CodexMcpRegistration;
}

function firstTransportArg(registration: CodexMcpRegistration): string | undefined {
  const args = registration.transport?.args;
  if (!Array.isArray(args)) {
    return undefined;
  }

  const first = args[0];
  return typeof first === "string" ? first : undefined;
}

function inspectRegistrationShape(
  config: DeskPilotConfig,
  registration: CodexMcpRegistration,
): WorkspaceMcpRegistrationInspection {
  const expectedScriptPath = workspaceServerScriptPath(config);
  const reasons: string[] = [];
  const transport = registration.transport;

  if (registration.enabled === false) {
    reasons.push(`MCP server '${config.mcpServerName}' is disabled in Codex.`);
  }

  if (transport?.type !== "stdio") {
    reasons.push(
      `MCP server '${config.mcpServerName}' must use stdio transport, but Codex has '${transport?.type ?? "unknown"}'.`,
    );
  }

  if (transport?.command !== process.execPath) {
    reasons.push(
      `MCP server '${config.mcpServerName}' is registered with '${transport?.command ?? "unknown"}', but DeskPilot is running with '${process.execPath}'.`,
    );
  }

  const actualScriptPath = firstTransportArg(registration);
  if (actualScriptPath !== expectedScriptPath) {
    reasons.push(
      `MCP server '${config.mcpServerName}' points at '${actualScriptPath ?? "unknown"}', but DeskPilot expected '${expectedScriptPath}'.`,
    );
  }

  return {
    status: reasons.length === 0 ? "ready" : "stale",
    registration,
    reasons,
  };
}

function workspaceMcpRepairHint(): string {
  return [
    "Run DeskPilot setup again from the same shell and Node.js runtime used for install/build:",
    "`node dist/cli.js setup`.",
  ].join(" ");
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
  if (result.exitCode !== 0) {
    const diagnostics = commandDiagnostics(result.stdout, result.stderr);
    const message = diagnostics
      ? `Codex is not logged in. Run \`codex login\` first.\n\n${diagnostics}`
      : "Codex is not logged in. Run `codex login` first.";
    throw new Error(message);
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

export async function inspectWorkspaceMcpRegistration(
  config: DeskPilotConfig,
): Promise<WorkspaceMcpRegistrationInspection> {
  const result = await execa(
    config.codexBinary,
    ["mcp", "get", config.mcpServerName, "--json"],
    {
      reject: false,
    },
  );

  if (result.exitCode !== 0) {
    return {
      status: "missing",
      reasons: [
        `MCP server '${config.mcpServerName}' is not registered with Codex.`,
      ],
    };
  }

  try {
    return inspectRegistrationShape(config, parseMcpRegistration(result.stdout));
  } catch (error) {
    const parseMessage = error instanceof Error ? error.message : String(error);
    const diagnostics = commandDiagnostics(result.stdout, result.stderr);
    return {
      status: "stale",
      reasons: [
        `Could not parse Codex MCP registration for '${config.mcpServerName}': ${parseMessage}.`,
        diagnostics,
      ].filter(Boolean),
    };
  }
}

export async function assertWorkspaceMcpReady(config: DeskPilotConfig): Promise<void> {
  const inspection = await inspectWorkspaceMcpRegistration(config);
  if (inspection.status === "ready") {
    return;
  }

  throw new Error(
    [
      `DeskPilot MCP server '${config.mcpServerName}' is ${inspection.status === "missing" ? "not registered" : "not registered correctly"}.`,
      ...inspection.reasons,
      workspaceMcpRepairHint(),
    ].join("\n"),
  );
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

async function removeWorkspaceMcpServer(config: DeskPilotConfig): Promise<void> {
  const result = await execa(
    config.codexBinary,
    ["mcp", "remove", config.mcpServerName],
    {
      reject: false,
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(`Failed to remove stale MCP server registration:\n${result.stderr || result.stdout}`);
  }
}

export async function repairWorkspaceMcpRegistration(
  config: DeskPilotConfig,
): Promise<WorkspaceMcpRepairResult> {
  const inspection = await inspectWorkspaceMcpRegistration(config);
  if (inspection.status === "ready") {
    return {
      action: "unchanged",
      inspection,
    };
  }

  if (inspection.status === "stale") {
    await removeWorkspaceMcpServer(config);
  }

  await registerWorkspaceMcpServer(config);
  return {
    action: inspection.status === "missing" ? "registered" : "repaired",
    inspection,
  };
}

function appendChunk(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > 20_000 ? next.slice(-20_000) : next;
}

function formatSmokeFailure(reason: string, stdout: string, stderr: string): Error {
  const diagnostics = commandDiagnostics(stdout, stderr);
  const message = diagnostics
    ? `${reason}\n\n${diagnostics}`
    : reason;
  return new Error(message);
}

export async function smokeTestWorkspaceMcpServer(
  config: DeskPilotConfig,
  timeoutMs = 5_000,
): Promise<void> {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "deskpilot-mcp-smoke-"));
  const subprocess = spawn(process.execPath, [workspaceServerScriptPath(config)], {
    cwd: config.repoRoot,
    env: {
      ...process.env,
      DESKPILOT_HOME: tempHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let settled = false;

  const cleanup = async (): Promise<void> => {
    if (subprocess.exitCode === null && !subprocess.killed) {
      subprocess.kill("SIGTERM");
    }
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  };

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(
        formatSmokeFailure(
          `DeskPilot MCP server did not finish startup within ${timeoutMs}ms.`,
          stdout,
          stderr,
        ),
      );
    }, timeoutMs);

    subprocess.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendChunk(stdout, chunk);
    });

    subprocess.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendChunk(stderr, chunk);
      if (!settled && stderr.includes("DeskPilot MCP server running on stdio")) {
        settled = true;
        clearTimeout(timeout);
        resolve();
      }
    });

    subprocess.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    subprocess.once("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(
        formatSmokeFailure(
          `DeskPilot MCP server exited before startup completed with code ${code ?? "unknown"}${signal ? ` and signal ${signal}` : ""}.`,
          stdout,
          stderr,
        ),
      );
    });
  }).finally(async () => {
    await cleanup();
  });
}

export function resolvedGoogleBrowserDetails(config: DeskPilotConfig): {
  executablePath: string;
  profileDir: string;
} {
  return {
    executablePath: resolveChromeExecutablePath(config),
    profileDir: config.googleBrowser.profileDir,
  };
}

export function ensureGoogleBrowserAvailable(config: DeskPilotConfig): void {
  resolvedGoogleBrowserDetails(config);
}
