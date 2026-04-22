import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeskPilotConfig } from "../../src/types/config.js";

const mocks = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
}));

vi.mock("playwright-core", () => ({
  chromium: {
    launchPersistentContext: mocks.launchPersistentContext,
  },
}));

import {
  BrowserGoogleSessionManager,
  BrowserProfileInUseError,
} from "../../src/google/browser/session.js";

const SINGLETON_ARTIFACTS = [
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
] as const;

const tempDirs: string[] = [];

function makeConfig(profileDir: string): DeskPilotConfig {
  return {
    repoRoot: "/tmp/repo",
    deskpilotHome: "/tmp/home",
    runtimeDir: "/tmp/home/runtime",
    logsDir: "/tmp/home/logs",
    dbPath: "/tmp/home/state.db",
    googleTokenPath: "/tmp/home/google-oauth.json",
    configFilePath: "/tmp/home/config.json",
    model: "gpt-5.4",
    codexBinary: "codex",
    mcpServerName: "deskpilot-workspace",
    googleMode: "browser",
    googleBrowser: {
      executablePath: process.execPath,
      profileDir,
    },
  };
}

async function createProfileDir(): Promise<string> {
  const profileDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "deskpilot-browser-session-"),
  );
  tempDirs.push(profileDir);
  return profileDir;
}

async function removeSingletonArtifacts(profileDir: string): Promise<void> {
  await Promise.all(
    SINGLETON_ARTIFACTS.map(async (artifact) => {
      await fs.promises.rm(path.join(profileDir, artifact), { force: true });
    }),
  );
}

async function createSingletonArtifacts(
  profileDir: string,
  lockTarget: string,
): Promise<void> {
  await fs.promises.symlink(lockTarget, path.join(profileDir, "SingletonLock"));
  await fs.promises.writeFile(
    path.join(profileDir, "SingletonCookie"),
    "cookie",
  );
  await fs.promises.writeFile(
    path.join(profileDir, "SingletonSocket"),
    "socket",
  );
}

async function existingArtifacts(profileDir: string): Promise<string[]> {
  const artifacts = await Promise.all(
    SINGLETON_ARTIFACTS.map(async (artifact) => {
      try {
        await fs.promises.lstat(path.join(profileDir, artifact));
        return artifact;
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    }),
  );

  return artifacts.filter((artifact): artifact is string => Boolean(artifact));
}

function makePage() {
  return {
    bringToFront: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext(page = makePage()) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(page),
    pages: vi.fn().mockReturnValue([page]),
  };
}

describe("BrowserGoogleSessionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (profileDir) => {
        await fs.promises.rm(profileDir, { force: true, recursive: true });
      }),
    );
  });

  it("cleans stale singleton artifacts when the lock pid is dead", async () => {
    const profileDir = await createProfileDir();
    await createSingletonArtifacts(
      profileDir,
      `${os.hostname()}-99999999`,
    );
    mocks.launchPersistentContext.mockResolvedValue(makeContext());

    const session = new BrowserGoogleSessionManager(makeConfig(profileDir), {
      profileAvailabilityPollIntervalMs: 1,
      profileAvailabilityTimeoutMs: 50,
    });

    await session.withPage(async () => undefined);

    expect(mocks.launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(await existingArtifacts(profileDir)).toEqual([]);
  });

  it("cleans stale singleton artifacts when the lock host does not match", async () => {
    const profileDir = await createProfileDir();
    await createSingletonArtifacts(
      profileDir,
      `remote-host-${process.pid}`,
    );
    mocks.launchPersistentContext.mockResolvedValue(makeContext());

    const session = new BrowserGoogleSessionManager(makeConfig(profileDir), {
      profileAvailabilityPollIntervalMs: 1,
      profileAvailabilityTimeoutMs: 50,
    });

    await session.withPage(async () => undefined);

    expect(mocks.launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(await existingArtifacts(profileDir)).toEqual([]);
  });

  it("waits for a live singleton lock to disappear before launching", async () => {
    const profileDir = await createProfileDir();
    await createSingletonArtifacts(
      profileDir,
      `${os.hostname()}-${process.pid}`,
    );
    mocks.launchPersistentContext.mockResolvedValue(makeContext());

    setTimeout(() => {
      void removeSingletonArtifacts(profileDir);
    }, 15);

    const session = new BrowserGoogleSessionManager(makeConfig(profileDir), {
      profileAvailabilityPollIntervalMs: 5,
      profileAvailabilityTimeoutMs: 200,
    });

    await session.withPage(async () => undefined);

    expect(mocks.launchPersistentContext).toHaveBeenCalledTimes(1);
  });

  it("retries once when Playwright still reports a singleton race", async () => {
    const profileDir = await createProfileDir();
    mocks.launchPersistentContext
      .mockRejectedValueOnce(
        new Error(
          "browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory.",
        ),
      )
      .mockResolvedValueOnce(makeContext());

    const session = new BrowserGoogleSessionManager(makeConfig(profileDir), {
      profileAvailabilityPollIntervalMs: 1,
      profileAvailabilityTimeoutMs: 50,
    });

    await session.withPage(async () => undefined);

    expect(mocks.launchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it("times out with BrowserProfileInUseError and preserves host and pid", async () => {
    const profileDir = await createProfileDir();
    await createSingletonArtifacts(
      profileDir,
      `${os.hostname()}-${process.pid}`,
    );

    const session = new BrowserGoogleSessionManager(makeConfig(profileDir), {
      profileAvailabilityPollIntervalMs: 1,
      profileAvailabilityTimeoutMs: 15,
    });

    const operation = session.withPage(async () => undefined);

    await expect(operation).rejects.toBeInstanceOf(
      BrowserProfileInUseError,
    );
    await expect(operation).rejects.toMatchObject({
      host: os.hostname(),
      pid: process.pid,
      profileDir,
    });
    expect(mocks.launchPersistentContext).not.toHaveBeenCalled();
  });
});
