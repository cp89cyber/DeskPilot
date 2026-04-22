import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/storage/db.js";
import { createRepositories } from "../../src/storage/repositories.js";
import type { DeskPilotConfig } from "../../src/types/config.js";

const tempDirs: string[] = [];

function makeConfig(): DeskPilotConfig {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskpilot-test-"));
  tempDirs.push(tempDir);
  return {
    repoRoot: tempDir,
    deskpilotHome: tempDir,
    runtimeDir: path.join(tempDir, "runtime"),
    logsDir: path.join(tempDir, "logs"),
    dbPath: path.join(tempDir, "state.db"),
    googleTokenPath: path.join(tempDir, "google-oauth.json"),
    configFilePath: path.join(tempDir, "config.json"),
    model: "gpt-5.4",
    codexBinary: "codex",
    mcpServerName: "deskpilot-workspace",
    googleMode: "browser",
    googleBrowser: {
      profileDir: path.join(tempDir, "browser-profile"),
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe("repositories", () => {
  it("deduplicates follow-ups by fingerprint", () => {
    const config = makeConfig();
    const db = openDatabase(config);
    const repositories = createRepositories(db);

    const firstInsert = repositories.followups.upsertMany([
      {
        title: "Reply to contract email",
        status: "open",
        sourceRefs: ["thread:abc123"],
      },
    ]);
    const secondInsert = repositories.followups.upsertMany([
      {
        title: "Reply to contract email",
        status: "open",
        sourceRefs: ["thread:abc123"],
      },
    ]);

    expect(firstInsert).toHaveLength(1);
    expect(secondInsert).toHaveLength(1);
    expect(firstInsert[0]?.id).toBe(secondInsert[0]?.id);
    expect(repositories.followups.list()).toHaveLength(1);
  });

  it("stores and applies pending actions", () => {
    const config = makeConfig();
    const db = openDatabase(config);
    const repositories = createRepositories(db);

    const action = repositories.pendingActions.create({
      kind: "gmail_draft",
      previewMarkdown: "# Gmail Draft",
      payload: {
        to: ["ops@example.com"],
        subject: "Status update",
        bodyText: "Draft body",
      },
      sourceRefs: ["thread:abc123"],
    });

    expect(action.status).toBe("staged");

    const applied = repositories.pendingActions.markApplied(action.id);
    expect(applied?.status).toBe("applied");
    expect(applied?.appliedAt).toBeTruthy();
  });
});
