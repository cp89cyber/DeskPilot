import type Database from "better-sqlite3";

import { ensureDeskPilotDirectories, loadDeskPilotConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { openDatabase } from "./storage/db.js";
import { createRepositories, type DeskPilotRepositories } from "./storage/repositories.js";
import type { DeskPilotConfig } from "./types/config.js";

export interface RuntimeContext {
  config: DeskPilotConfig;
  db: Database.Database;
  repositories: DeskPilotRepositories;
  logger: Logger;
}

export function createRuntimeContext(): RuntimeContext {
  const config = loadDeskPilotConfig();
  ensureDeskPilotDirectories(config);
  const logger = createLogger(config);
  const db = openDatabase(config);
  const repositories = createRepositories(db);

  return {
    config,
    db,
    repositories,
    logger,
  };
}
