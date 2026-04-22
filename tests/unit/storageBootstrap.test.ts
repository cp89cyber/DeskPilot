import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initializeStorage } from "../../src/storage/bootstrap.js";
import type { DeskPilotConfig } from "../../src/types/config.js";

const tempDirs: string[] = [];

function makeConfig(): DeskPilotConfig {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskpilot-storage-bootstrap-"));
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

describe("initializeStorage", () => {
  it("returns an opened database and repositories when storage modules load", async () => {
    const config = makeConfig();

    const storage = await initializeStorage(config);

    expect(fs.existsSync(config.dbPath)).toBe(true);
    expect(storage.repositories.followups.list()).toEqual([]);
    storage.db.close();
  });

  it("normalizes better-sqlite3 ABI mismatch errors", async () => {
    const config = makeConfig();

    await expect(
      initializeStorage(config, async () => {
        const error = Object.assign(
          new Error(
            "The module '/tmp/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 127.",
          ),
          {
            code: "ERR_DLOPEN_FAILED",
          },
        );
        throw error;
      }),
    ).rejects.toThrow(/better-sqlite3/);

    try {
      await initializeStorage(config, async () => {
        const error = Object.assign(
          new Error(
            "The module '/tmp/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 127.",
          ),
          {
            code: "ERR_DLOPEN_FAILED",
          },
        );
        throw error;
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(process.execPath);
      expect(message).toContain(process.version);
      expect(message).toContain(process.versions.modules);
      expect(message).toContain("npm rebuild better-sqlite3");
      expect(message).toContain("Original error:");
      expect(message).toContain("NODE_MODULE_VERSION 137");
    }
  });
});
