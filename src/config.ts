import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  DeskPilotConfig,
  DeskPilotConfigFile,
  GoogleCredentials,
} from "./types/config.js";

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_MCP_SERVER_NAME = "deskpilot-workspace";
const DEFAULT_GOOGLE_REDIRECT_PORT = 8765;

function findRepoRoot(): string {
  const currentDir = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    path.resolve(currentDir, ".."),
    path.resolve(currentDir, "../.."),
    process.cwd(),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "prompts"))) {
      return candidate;
    }
  }

  return candidates[0] ?? process.cwd();
}

function readConfigFile(configFilePath: string): DeskPilotConfigFile {
  if (!fs.existsSync(configFilePath)) {
    return {};
  }

  const raw = fs.readFileSync(configFilePath, "utf8");
  return JSON.parse(raw) as DeskPilotConfigFile;
}

function resolveGoogleCredentials(configFile: DeskPilotConfigFile): GoogleCredentials | undefined {
  const clientId =
    process.env.DESKPILOT_GOOGLE_CLIENT_ID ??
    process.env.GOOGLE_CLIENT_ID ??
    configFile.google?.clientId;
  const clientSecret =
    process.env.DESKPILOT_GOOGLE_CLIENT_SECRET ??
    process.env.GOOGLE_CLIENT_SECRET ??
    configFile.google?.clientSecret;
  const redirectPortRaw =
    process.env.DESKPILOT_GOOGLE_REDIRECT_PORT ??
    configFile.google?.redirectPort?.toString();
  const redirectPort = Number.parseInt(
    redirectPortRaw ?? String(DEFAULT_GOOGLE_REDIRECT_PORT),
    10,
  );

  if (!clientId || !clientSecret) {
    return undefined;
  }

  return {
    clientId,
    clientSecret,
    redirectPort: Number.isNaN(redirectPort) ? DEFAULT_GOOGLE_REDIRECT_PORT : redirectPort,
  };
}

export function loadDeskPilotConfig(): DeskPilotConfig {
  const repoRoot = findRepoRoot();
  const deskpilotHome =
    process.env.DESKPILOT_HOME ?? path.join(os.homedir(), ".deskpilot");
  const configFilePath = path.join(deskpilotHome, "config.json");
  const configFile = readConfigFile(configFilePath);
  const googleCredentials = resolveGoogleCredentials(configFile);

  return {
    repoRoot,
    deskpilotHome,
    runtimeDir: path.join(deskpilotHome, "runtime"),
    logsDir: path.join(deskpilotHome, "logs"),
    dbPath: path.join(deskpilotHome, "state.db"),
    googleTokenPath: path.join(deskpilotHome, "google-oauth.json"),
    configFilePath,
    model: process.env.DESKPILOT_MODEL ?? configFile.model ?? DEFAULT_MODEL,
    codexBinary: process.env.DESKPILOT_CODEX_BIN ?? "codex",
    mcpServerName: DEFAULT_MCP_SERVER_NAME,
    googleCredentials,
  };
}

export function ensureDeskPilotDirectories(config: DeskPilotConfig): void {
  fs.mkdirSync(config.deskpilotHome, { recursive: true });
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  fs.mkdirSync(config.logsDir, { recursive: true });
}

export function templatePath(config: DeskPilotConfig, relativePath: string): string {
  return path.join(config.repoRoot, relativePath);
}

export function writeJsonFileSecure(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}
