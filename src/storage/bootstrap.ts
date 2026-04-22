import type Database from "better-sqlite3";

import type { DeskPilotRepositories } from "./repositories.js";
import type { DeskPilotConfig } from "../types/config.js";

export interface StorageModules {
  openDatabase(config: DeskPilotConfig): Database.Database;
  createRepositories(db: Database.Database): DeskPilotRepositories;
}

export interface InitializedStorage {
  db: Database.Database;
  repositories: DeskPilotRepositories;
}

export type StorageModuleLoader = () => Promise<StorageModules>;

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isBetterSqliteRuntimeError(message: string, code?: string): boolean {
  const normalizedMessage = message.toLowerCase();
  return (
    code === "ERR_DLOPEN_FAILED" ||
    normalizedMessage.includes("better_sqlite3.node") ||
    normalizedMessage.includes("better-sqlite3") ||
    message.includes("NODE_MODULE_VERSION")
  );
}

function formatBetterSqliteRuntimeError(originalMessage: string): string {
  return [
    "DeskPilot could not load its local SQLite storage because `better-sqlite3` does not match the active Node.js runtime.",
    "",
    "Current runtime:",
    `- node: ${process.execPath}`,
    `- version: ${process.version}`,
    `- NODE_MODULE_VERSION: ${process.versions.modules}`,
    "",
    "Use this same `node` binary for install, build, and runtime, then rebuild or reinstall dependencies:",
    "- `which node`",
    "- `node -v`",
    "- `npm rebuild better-sqlite3`",
    "- if rebuild is not enough, reinstall dependencies with this same Node version and rerun `npm install`",
    "",
    "Original error:",
    originalMessage,
  ].join("\n");
}

function normalizeStorageError(error: unknown): Error {
  const message = errorMessage(error);
  const code = errorCode(error);
  if (!isBetterSqliteRuntimeError(message, code)) {
    return error instanceof Error ? error : new Error(message);
  }

  return new Error(formatBetterSqliteRuntimeError(message), {
    cause: error instanceof Error ? error : undefined,
  });
}

export async function loadStorageModules(): Promise<StorageModules> {
  const [dbModule, repositoriesModule] = await Promise.all([
    import("./db.js"),
    import("./repositories.js"),
  ]);

  return {
    openDatabase: dbModule.openDatabase,
    createRepositories: repositoriesModule.createRepositories,
  };
}

export async function initializeStorage(
  config: DeskPilotConfig,
  loadModules: StorageModuleLoader = loadStorageModules,
): Promise<InitializedStorage> {
  try {
    const { openDatabase, createRepositories } = await loadModules();
    const db = openDatabase(config);

    return {
      db,
      repositories: createRepositories(db),
    };
  } catch (error) {
    throw normalizeStorageError(error);
  }
}
