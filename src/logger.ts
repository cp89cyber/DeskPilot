import fs from "node:fs";
import path from "node:path";

import type { DeskPilotConfig } from "./types/config.js";

export interface Logger {
  info(message: string, metadata?: unknown): void;
  warn(message: string, metadata?: unknown): void;
  error(message: string, metadata?: unknown): void;
}

function formatMetadata(metadata: unknown): string {
  if (metadata === undefined) {
    return "";
  }

  try {
    return ` ${JSON.stringify(metadata)}`;
  } catch {
    return ` ${String(metadata)}`;
  }
}

export function createLogger(config: DeskPilotConfig): Logger {
  const logPath = path.join(config.logsDir, "deskpilot.log");

  function append(level: string, message: string, metadata?: unknown): void {
    fs.mkdirSync(config.logsDir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${formatMetadata(metadata)}\n`;
    fs.appendFileSync(logPath, line, "utf8");
  }

  return {
    info(message, metadata) {
      append("info", message, metadata);
    },
    warn(message, metadata) {
      append("warn", message, metadata);
    },
    error(message, metadata) {
      append("error", message, metadata);
    },
  };
}
