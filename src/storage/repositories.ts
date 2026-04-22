import crypto from "node:crypto";

import type Database from "better-sqlite3";

import type {
  CalendarEventPayload,
  GmailDraftPayload,
  PendingAction,
  PendingActionKind,
} from "../types/actions.js";
import type { DeskPilotSession, CodexWorkflow } from "../types/config.js";
import type { FollowupDraft, FollowupItem } from "../types/results.js";

interface SessionRow {
  workflow: CodexWorkflow;
  codex_session_id: string;
  last_used_at: string;
}

interface PendingActionRow {
  id: string;
  kind: PendingActionKind;
  status: "staged" | "applied";
  preview_markdown: string;
  payload_json: string;
  source_refs_json: string;
  created_at: string;
  applied_at: string | null;
}

interface FollowupRow {
  id: string;
  title: string;
  due_at: string | null;
  status: string;
  source_refs_json: string;
  fingerprint: string;
  created_at: string;
  completed_at: string | null;
}

interface CacheEntryRow {
  cache_key: string;
  revision: string | null;
  etag: string | null;
  mime_type: string | null;
  content_json: string;
  updated_at: string;
}

function parseStringArray(jsonText: string): string[] {
  return JSON.parse(jsonText) as string[];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function actionFromRow(row: PendingActionRow): PendingAction {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    previewMarkdown: row.preview_markdown,
    payloadJson: row.payload_json,
    sourceRefs: parseStringArray(row.source_refs_json),
    createdAt: row.created_at,
    appliedAt: row.applied_at ?? undefined,
  };
}

function followupFromRow(row: FollowupRow): FollowupItem {
  return {
    id: row.id,
    title: row.title,
    dueAt: row.due_at ?? undefined,
    status: row.status,
    sourceRefs: parseStringArray(row.source_refs_json),
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

export class SessionsRepository {
  constructor(private readonly db: Database.Database) {}

  get(workflow: CodexWorkflow): DeskPilotSession | undefined {
    const row = this.db
      .prepare("SELECT workflow, codex_session_id, last_used_at FROM sessions WHERE workflow = ?")
      .get(workflow) as SessionRow | undefined;

    if (!row) {
      return undefined;
    }

    return {
      workflow: row.workflow,
      codexSessionId: row.codex_session_id,
      lastUsedAt: row.last_used_at,
    };
  }

  upsert(workflow: CodexWorkflow, codexSessionId: string): DeskPilotSession {
    const lastUsedAt = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO sessions (workflow, codex_session_id, last_used_at)
        VALUES (@workflow, @codex_session_id, @last_used_at)
        ON CONFLICT(workflow) DO UPDATE SET
          codex_session_id = excluded.codex_session_id,
          last_used_at = excluded.last_used_at
      `)
      .run({
        workflow,
        codex_session_id: codexSessionId,
        last_used_at: lastUsedAt,
      });

    return {
      workflow,
      codexSessionId,
      lastUsedAt,
    };
  }
}

export class PendingActionsRepository {
  constructor(private readonly db: Database.Database) {}

  create(record: {
    kind: PendingActionKind;
    previewMarkdown: string;
    payload: GmailDraftPayload | CalendarEventPayload;
    sourceRefs: string[];
  }): PendingAction {
    const action: PendingAction = {
      id: crypto.randomUUID(),
      kind: record.kind,
      status: "staged",
      previewMarkdown: record.previewMarkdown,
      payloadJson: JSON.stringify(record.payload, null, 2),
      sourceRefs: uniqueStrings(record.sourceRefs),
      createdAt: new Date().toISOString(),
    };

    this.db
      .prepare(`
        INSERT INTO pending_actions (
          id, kind, status, preview_markdown, payload_json, source_refs_json, created_at, applied_at
        ) VALUES (
          @id, @kind, @status, @preview_markdown, @payload_json, @source_refs_json, @created_at, @applied_at
        )
      `)
      .run({
        id: action.id,
        kind: action.kind,
        status: action.status,
        preview_markdown: action.previewMarkdown,
        payload_json: action.payloadJson,
        source_refs_json: JSON.stringify(action.sourceRefs),
        created_at: action.createdAt,
        applied_at: null,
      });

    return action;
  }

  get(id: string): PendingAction | undefined {
    const row = this.db
      .prepare("SELECT * FROM pending_actions WHERE id = ?")
      .get(id) as PendingActionRow | undefined;
    return row ? actionFromRow(row) : undefined;
  }

  list(): PendingAction[] {
    const rows = this.db
      .prepare("SELECT * FROM pending_actions ORDER BY created_at DESC")
      .all() as PendingActionRow[];
    return rows.map(actionFromRow);
  }

  markApplied(id: string): PendingAction | undefined {
    const appliedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE pending_actions SET status = 'applied', applied_at = ? WHERE id = ?")
      .run(appliedAt, id);
    return this.get(id);
  }
}

export class FollowupsRepository {
  constructor(private readonly db: Database.Database) {}

  static fingerprintFromDraft(draft: FollowupDraft): string {
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          title: draft.title.trim().toLowerCase(),
          dueAt: draft.dueAt ?? null,
          sourceRefs: uniqueStrings(draft.sourceRefs),
        }),
      )
      .digest("hex");
  }

  upsertMany(drafts: FollowupDraft[]): FollowupItem[] {
    const transaction = this.db.transaction((items: FollowupDraft[]) => {
      const inserted: FollowupItem[] = [];
      for (const draft of items) {
        const fingerprint = FollowupsRepository.fingerprintFromDraft(draft);
        const existing = this.db
          .prepare("SELECT * FROM followups WHERE fingerprint = ?")
          .get(fingerprint) as FollowupRow | undefined;

        if (existing) {
          inserted.push(followupFromRow(existing));
          continue;
        }

        const row: FollowupRow = {
          id: crypto.randomUUID(),
          title: draft.title,
          due_at: draft.dueAt ?? null,
          status: draft.status,
          source_refs_json: JSON.stringify(uniqueStrings(draft.sourceRefs)),
          fingerprint,
          created_at: new Date().toISOString(),
          completed_at: null,
        };

        this.db
          .prepare(`
            INSERT INTO followups (id, title, due_at, status, source_refs_json, fingerprint, created_at, completed_at)
            VALUES (@id, @title, @due_at, @status, @source_refs_json, @fingerprint, @created_at, @completed_at)
          `)
          .run(row);
        inserted.push(followupFromRow(row));
      }
      return inserted;
    });

    return transaction(drafts);
  }

  list(status?: string): FollowupItem[] {
    const rows = (status
      ? this.db
          .prepare("SELECT * FROM followups WHERE status = ? ORDER BY created_at DESC")
          .all(status)
      : this.db.prepare("SELECT * FROM followups ORDER BY created_at DESC").all()) as FollowupRow[];
    return rows.map(followupFromRow);
  }

  complete(id: string): FollowupItem | undefined {
    const completedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE followups SET status = 'completed', completed_at = ? WHERE id = ?")
      .run(completedAt, id);

    const row = this.db
      .prepare("SELECT * FROM followups WHERE id = ?")
      .get(id) as FollowupRow | undefined;
    return row ? followupFromRow(row) : undefined;
  }
}

export interface CacheEntryRecord {
  cacheKey: string;
  revision?: string;
  etag?: string;
  mimeType?: string;
  content: unknown;
  updatedAt: string;
}

export class CacheRepository {
  constructor(private readonly db: Database.Database) {}

  get(cacheKey: string): CacheEntryRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM cache_entries WHERE cache_key = ?")
      .get(cacheKey) as CacheEntryRow | undefined;
    if (!row) {
      return undefined;
    }

    return {
      cacheKey: row.cache_key,
      revision: row.revision ?? undefined,
      etag: row.etag ?? undefined,
      mimeType: row.mime_type ?? undefined,
      content: JSON.parse(row.content_json) as unknown,
      updatedAt: row.updated_at,
    };
  }

  upsert(record: CacheEntryRecord): void {
    this.db
      .prepare(`
        INSERT INTO cache_entries (cache_key, revision, etag, mime_type, content_json, updated_at)
        VALUES (@cache_key, @revision, @etag, @mime_type, @content_json, @updated_at)
        ON CONFLICT(cache_key) DO UPDATE SET
          revision = excluded.revision,
          etag = excluded.etag,
          mime_type = excluded.mime_type,
          content_json = excluded.content_json,
          updated_at = excluded.updated_at
      `)
      .run({
        cache_key: record.cacheKey,
        revision: record.revision ?? null,
        etag: record.etag ?? null,
        mime_type: record.mimeType ?? null,
        content_json: JSON.stringify(record.content),
        updated_at: record.updatedAt,
      });
  }
}

export interface DeskPilotRepositories {
  sessions: SessionsRepository;
  pendingActions: PendingActionsRepository;
  followups: FollowupsRepository;
  cache: CacheRepository;
}

export function createRepositories(db: Database.Database): DeskPilotRepositories {
  return {
    sessions: new SessionsRepository(db),
    pendingActions: new PendingActionsRepository(db),
    followups: new FollowupsRepository(db),
    cache: new CacheRepository(db),
  };
}
