import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBaseContext, createRuntimeContext } from "../../src/runtime.js";

const tempDirs: string[] = [];
const originalDeskPilotHome = process.env.DESKPILOT_HOME;

function makeTempHome(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskpilot-runtime-test-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function restoreDeskPilotHome(): void {
  if (originalDeskPilotHome === undefined) {
    delete process.env.DESKPILOT_HOME;
    return;
  }

  process.env.DESKPILOT_HOME = originalDeskPilotHome;
}

afterEach(() => {
  restoreDeskPilotHome();

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe("runtime context", () => {
  it("creates directories and logger context without creating the database", () => {
    const homeDir = makeTempHome();
    process.env.DESKPILOT_HOME = homeDir;

    const context = createBaseContext();
    context.logger.info("runtime ready");

    expect(fs.existsSync(context.config.deskpilotHome)).toBe(true);
    expect(fs.existsSync(context.config.runtimeDir)).toBe(true);
    expect(fs.existsSync(context.config.logsDir)).toBe(true);
    expect(fs.existsSync(context.config.googleBrowser.profileDir)).toBe(true);
    expect(fs.existsSync(path.join(context.config.logsDir, "deskpilot.log"))).toBe(true);
    expect(fs.existsSync(context.config.dbPath)).toBe(false);
  });

  it("creates the database for DB-backed runtime contexts", async () => {
    const homeDir = makeTempHome();
    process.env.DESKPILOT_HOME = homeDir;

    const context = await createRuntimeContext();

    expect(fs.existsSync(context.config.dbPath)).toBe(true);
    expect(context.repositories.followups.list()).toEqual([]);
    context.db.close();
  });
});
