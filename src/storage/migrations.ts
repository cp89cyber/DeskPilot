import type Database from "better-sqlite3";

const SCHEMA_VERSION = 1;

export function migrateDatabase(db: Database.Database): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (currentVersion >= SCHEMA_VERSION) {
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      workflow TEXT PRIMARY KEY,
      codex_session_id TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_actions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      preview_markdown TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      applied_at TEXT
    );

    CREATE TABLE IF NOT EXISTS followups (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      due_at TEXT,
      status TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS cache_entries (
      cache_key TEXT PRIMARY KEY,
      revision TEXT,
      etag TEXT,
      mime_type TEXT,
      content_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}
