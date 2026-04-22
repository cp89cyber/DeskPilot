import type Database from "better-sqlite3";

import { ensureDeskPilotDirectories, loadDeskPilotConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { initializeStorage } from "./storage/bootstrap.js";
import type { DeskPilotRepositories } from "./storage/repositories.js";
import type { DeskPilotConfig } from "./types/config.js";

export interface BaseContext {
  config: DeskPilotConfig;
  logger: Logger;
}

export interface RuntimeContext extends BaseContext {
  db: Database.Database;
  repositories: DeskPilotRepositories;
}

export function createBaseContext(): BaseContext {
  const config = loadDeskPilotConfig();
  ensureDeskPilotDirectories(config);
  const logger = createLogger(config);

  return {
    config,
    logger,
  };
}

export async function createRuntimeContext(): Promise<RuntimeContext> {
  const baseContext = createBaseContext();
  const storage = await initializeStorage(baseContext.config);

  return {
    ...baseContext,
    ...storage,
  };
}
