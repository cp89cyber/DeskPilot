import { EventEmitter } from "node:events";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeskPilotRepositories } from "../../src/storage/repositories.js";
import type { DeskPilotConfig } from "../../src/types/config.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

import { runWorkflow } from "../../src/codex/runner.js";

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  exitCode: number | null;
}

const originalTimeout = process.env.DESKPILOT_CODEX_TIMEOUT_MS;

function makeConfig(): DeskPilotConfig {
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
      profileDir: "/tmp/home/browser/google-chrome",
    },
  };
}

function makeRepositories(priorSession?: { workflow: "chat"; codexSessionId: string; lastUsedAt: string }): DeskPilotRepositories {
  return {
    sessions: {
      get: vi.fn(() => priorSession),
      upsert: vi.fn((workflow, codexSessionId) => ({
        workflow,
        codexSessionId,
        lastUsedAt: "2026-04-23T00:00:00.000Z",
      })),
    },
  } as unknown as DeskPilotRepositories;
}

function makeChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DESKPILOT_CODEX_TIMEOUT_MS;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalTimeout === undefined) {
    delete process.env.DESKPILOT_CODEX_TIMEOUT_MS;
  } else {
    process.env.DESKPILOT_CODEX_TIMEOUT_MS = originalTimeout;
  }
});

describe("runWorkflow", () => {
  it("streams JSONL events and captures the Codex thread", async () => {
    const child = makeChildProcess();
    mocks.spawn.mockReturnValueOnce(child);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const resultPromise = runWorkflow(
      makeConfig(),
      makeRepositories(),
      {
        workflow: "chat",
        prompt: "Say ready.",
      },
    );

    child.stdout.emit("data", Buffer.from('{"type":"thread.started","thread_id":"thread-1"}\n'));
    child.stdout.emit(
      "data",
      Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}\n'),
    );
    child.emit("exit", 0);

    const result = await resultPromise;

    expect(result.sessionId).toBe("thread-1");
    expect(result.finalMessage).toBe("ready");
    expect(stderrSpy).toHaveBeenCalledWith("Starting Codex workflow: chat\n");
    expect(stderrSpy).toHaveBeenCalledWith("Codex thread: thread-1\n");
    expect(mocks.spawn).toHaveBeenCalledWith(
      "codex",
      expect.arrayContaining([
        "exec",
        "-m",
        "gpt-5.4",
        "-C",
        path.join("/tmp/home", "runtime"),
      ]),
      expect.objectContaining({
        cwd: path.join("/tmp/home", "runtime"),
      }),
    );
  });

  it("surfaces Codex error events and stderr on failure", async () => {
    const child = makeChildProcess();
    mocks.spawn.mockReturnValueOnce(child);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const resultPromise = runWorkflow(
      makeConfig(),
      makeRepositories(),
      {
        workflow: "chat",
        prompt: "Say ready.",
      },
    );

    child.stdout.emit("data", Buffer.from('{"type":"thread.started","thread_id":"thread-2"}\n'));
    child.stdout.emit("data", Buffer.from('{"type":"error","message":"MCP startup failed"}\n'));
    child.stderr.emit("data", Buffer.from("native addon mismatch\n"));
    child.emit("exit", 1);

    await expect(resultPromise).rejects.toThrow(/MCP startup failed/);
    await expect(resultPromise).rejects.toThrow(/native addon mismatch/);
  });

  it("terminates the child process when the workflow timeout expires", async () => {
    vi.useFakeTimers();
    process.env.DESKPILOT_CODEX_TIMEOUT_MS = "25";
    const child = makeChildProcess();
    mocks.spawn.mockReturnValueOnce(child);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const resultPromise = runWorkflow(
      makeConfig(),
      makeRepositories(),
      {
        workflow: "chat",
        prompt: "Say ready.",
      },
    );

    await vi.advanceTimersByTimeAsync(25);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("exit", null);
    await expect(resultPromise).rejects.toThrow(/timed out/);
  });

  it("starts a fresh session when resume is disabled and passes extra args", async () => {
    const child = makeChildProcess();
    mocks.spawn.mockReturnValueOnce(child);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const repositories = makeRepositories({
      workflow: "chat",
      codexSessionId: "prior-thread",
      lastUsedAt: "2026-04-22T00:00:00.000Z",
    });

    const resultPromise = runWorkflow(
      makeConfig(),
      repositories,
      {
        workflow: "chat",
        prompt: "Say ready.",
        resume: false,
        extraArgs: ["-c", "mcp_servers.deskpilot-workspace.enabled=false"],
      },
    );

    child.stdout.emit("data", Buffer.from('{"type":"thread.started","thread_id":"fresh-thread"}\n'));
    child.stdout.emit(
      "data",
      Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}\n'),
    );
    child.emit("exit", 0);

    const result = await resultPromise;
    const args = mocks.spawn.mock.calls[0]?.[1] as string[];

    expect(result.sessionId).toBe("fresh-thread");
    expect(result.resumed).toBe(false);
    expect(repositories.sessions.get).not.toHaveBeenCalled();
    expect(args).toContain("-c");
    expect(args).toContain("mcp_servers.deskpilot-workspace.enabled=false");
    expect(args.slice(0, 2)).toEqual(["exec", "-m"]);
    expect(args).not.toContain("resume");
  });

  it("rejects results when Codex reports a cancelled MCP tool call", async () => {
    const child = makeChildProcess();
    mocks.spawn.mockReturnValueOnce(child);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const repositories = makeRepositories();

    const resultPromise = runWorkflow(
      makeConfig(),
      repositories,
      {
        workflow: "chat",
        prompt: "Say ready.",
      },
    );

    child.stdout.emit("data", Buffer.from('{"type":"thread.started","thread_id":"thread-3"}\n'));
    child.stdout.emit(
      "data",
      Buffer.from(
        '{"type":"item.completed","item":{"type":"tool_call_output","text":"user cancelled MCP tool call"}}\n',
      ),
    );
    child.emit("exit", 0);

    await expect(resultPromise).rejects.toThrow(/noninteractive Codex run attempted to use a tool/);
    expect(repositories.sessions.upsert).not.toHaveBeenCalled();
  });
});
