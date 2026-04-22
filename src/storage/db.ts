import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { DeskPilotConfig } from "../types/config.js";
import { migrateDatabase } from "./migrations.js";

export function openDatabase(config: DeskPilotConfig): Database.Database {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrateDatabase(db);
  return db;
}
