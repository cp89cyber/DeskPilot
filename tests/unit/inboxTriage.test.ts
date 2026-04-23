import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_INBOX_QUERY,
  MAX_INBOX_MAX_RESULTS,
  triageInbox,
} from "../../src/inbox/triage.js";
import type { GmailThreadDetail, GmailThreadSummary } from "../../src/google/gmail.js";
import type { GoogleWorkspaceProvider } from "../../src/google/provider.js";
import type { DeskPilotRepositories } from "../../src/storage/repositories.js";
import type { DeskPilotConfig } from "../../src/types/config.js";
import type { PendingAction } from "../../src/types/actions.js";
import type { FollowupDraft, FollowupItem } from "../../src/types/results.js";

function makeConfig(): DeskPilotConfig {
  return {
    repoRoot: process.cwd(),
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

function makeRepositories(): DeskPilotRepositories {
  let actionCount = 0;
  return {
    pendingActions: {
      create: vi.fn((record) => {
        actionCount += 1;
        return {
          id: `action-${actionCount}`,
          kind: record.kind,
          status: "staged",
          previewMarkdown: record.previewMarkdown,
          payloadJson: JSON.stringify(record.payload),
          sourceRefs: record.sourceRefs,
          createdAt: "2026-04-23T12:00:00.000Z",
        } satisfies PendingAction;
      }),
    },
    followups: {
      upsertMany: vi.fn((drafts: FollowupDraft[]) =>
        drafts.map(
          (draft, index) =>
            ({
              id: `followup-${index + 1}`,
              title: draft.title,
              dueAt: draft.dueAt,
              status: draft.status,
              sourceRefs: draft.sourceRefs,
              fingerprint: `fp-${index + 1}`,
              createdAt: "2026-04-23T12:00:00.000Z",
            }) satisfies FollowupItem,
        ),
      ),
    },
  } as unknown as DeskPilotRepositories;
}

function makeProvider(
  summaries: GmailThreadSummary[],
  detailsByThreadId: Record<string, GmailThreadDetail>,
): GoogleWorkspaceProvider {
  return {
    capabilities: {
      mode: "oauth",
      gmail: true,
      calendar: true,
      drive: true,
    },
    gmail: {
      listThreads: vi.fn(async () => summaries),
      getThread: vi.fn(async (threadId: string) => detailsByThreadId[threadId]!),
      createDraft: vi.fn(),
    },
  };
}

function summary(): GmailThreadSummary {
  return {
    threadId: "thread-1",
    subject: "Budget review",
    from: "Finance Team <finance@example.com>",
    snippet: "Please review the spreadsheet",
    receivedAt: "2026-04-22T10:00:00.000Z",
  };
}

function detail(): GmailThreadDetail {
  return {
    threadId: "thread-1",
    snippet: "Please review the spreadsheet",
    messages: [
      {
        id: "msg-1",
        from: "Finance Team <finance@example.com>",
        to: "DeskPilot User <me@example.com>",
        cc: "Manager <manager@example.com>",
        subject: "Budget review",
        date: "Wed, 22 Apr 2026 10:00:00 -0400",
        bodyText: `${"a".repeat(4010)} Please review the spreadsheet before noon.`,
        snippet: "Please review the spreadsheet",
      },
    ],
  };
}

function validAnalysis() {
  return {
    overview: "One budget thread needs a reply.",
    urgentThreads: [
      {
        threadId: "thread-1",
        subject: "Budget review",
        reason: "The sender asked for a review before noon.",
      },
    ],
    replyRecommendations: [
      {
        threadId: "thread-1",
        recommendation: "Send a concise acknowledgement with a review ETA.",
        draft: {
          threadId: "thread-1",
          to: ["finance@example.com"],
          cc: ["manager@example.com"],
          bcc: [],
          subject: "Re: Budget review",
          bodyText: "Thanks. I will review this before noon.",
        },
      },
    ],
    followUps: [
      {
        title: "Review budget spreadsheet",
        dueAt: null,
        status: "open",
        sourceRefs: ["thread:thread-1"],
      },
    ],
    sourceRefs: ["thread:thread-1"],
  };
}

describe("triageInbox", () => {
  it("fetches Gmail threads, analyzes them without MCP, stages drafts, and persists follow-ups", async () => {
    const repositories = makeRepositories();
    const provider = makeProvider([summary()], { "thread-1": detail() });
    const runWorkflow = vi.fn(async () => ({
      workflow: "inbox" as const,
      sessionId: "codex-thread-1",
      finalMessage: "",
      parsedOutput: validAnalysis(),
      events: [],
      resumed: false,
    }));

    const execution = await triageInbox(
      {
        config: makeConfig(),
        repositories,
        provider,
        runWorkflow,
      },
      {
        query: DEFAULT_INBOX_QUERY,
        maxResults: MAX_INBOX_MAX_RESULTS + 10,
      },
    );

    expect(provider.gmail?.listThreads).toHaveBeenCalledWith({
      query: DEFAULT_INBOX_QUERY,
      maxResults: MAX_INBOX_MAX_RESULTS,
    });
    expect(provider.gmail?.getThread).toHaveBeenCalledWith("thread-1");

    const workflowOptions = runWorkflow.mock.calls[0]?.[2];
    expect(workflowOptions).toMatchObject({
      workflow: "inbox",
      resume: false,
      extraArgs: ["-c", "mcp_servers.deskpilot-workspace.enabled=false"],
    });
    expect(workflowOptions?.outputSchema?.path).toBe(`${process.cwd()}/schemas/inbox-analysis.json`);
    expect(workflowOptions?.prompt).toContain("Do not call tools.");
    expect(workflowOptions?.prompt).toContain('"truncated": true');

    expect(repositories.pendingActions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gmail_draft",
        payload: expect.objectContaining({
          to: ["finance@example.com"],
          cc: ["manager@example.com"],
          bcc: [],
          subject: "Re: Budget review",
          threadId: "thread-1",
        }),
        sourceRefs: ["thread:thread-1"],
      }),
    );
    expect(repositories.followups.upsertMany).toHaveBeenCalledWith([
      {
        title: "Review budget spreadsheet",
        dueAt: undefined,
        status: "open",
        sourceRefs: ["thread:thread-1"],
      },
    ]);
    expect(execution).toMatchObject({
      persistedFollowUps: 1,
      sessionId: "codex-thread-1",
      resumed: false,
      result: {
        overview: "One budget thread needs a reply.",
        stagedActionIds: ["action-1"],
        sourceRefs: ["thread:thread-1"],
      },
    });
    expect(execution.result.replyRecommendations[0]?.stagedActionId).toBe("action-1");
  });

  it("returns a deterministic empty result without calling Codex when no threads match", async () => {
    const repositories = makeRepositories();
    const provider = makeProvider([], {});
    const runWorkflow = vi.fn();

    const execution = await triageInbox(
      {
        config: makeConfig(),
        repositories,
        provider,
        runWorkflow,
      },
      {
        query: DEFAULT_INBOX_QUERY,
      },
    );

    expect(runWorkflow).not.toHaveBeenCalled();
    expect(repositories.pendingActions.create).not.toHaveBeenCalled();
    expect(repositories.followups.upsertMany).not.toHaveBeenCalled();
    expect(execution).toEqual({
      result: {
        overview: `No inbox threads matched query "${DEFAULT_INBOX_QUERY}".`,
        urgentThreads: [],
        replyRecommendations: [],
        followUps: [],
        stagedActionIds: [],
        sourceRefs: [],
      },
      persistedFollowUps: 0,
      sessionId: "",
      resumed: false,
    });
  });

  it("rejects unknown thread IDs before staging actions", async () => {
    const repositories = makeRepositories();
    const provider = makeProvider([summary()], { "thread-1": detail() });
    const analysis = validAnalysis();
    analysis.urgentThreads[0]!.threadId = "thread-2";
    const runWorkflow = vi.fn(async () => ({
      workflow: "inbox" as const,
      sessionId: "codex-thread-1",
      finalMessage: "",
      parsedOutput: analysis,
      events: [],
      resumed: false,
    }));

    await expect(
      triageInbox({ config: makeConfig(), repositories, provider, runWorkflow }, {}),
    ).rejects.toThrow(/unknown thread "thread-2"/);
    expect(repositories.pendingActions.create).not.toHaveBeenCalled();
  });

  it("rejects unknown source refs before staging actions", async () => {
    const repositories = makeRepositories();
    const provider = makeProvider([summary()], { "thread-1": detail() });
    const analysis = validAnalysis();
    analysis.followUps[0]!.sourceRefs = ["thread:thread-2"];
    const runWorkflow = vi.fn(async () => ({
      workflow: "inbox" as const,
      sessionId: "codex-thread-1",
      finalMessage: "",
      parsedOutput: analysis,
      events: [],
      resumed: false,
    }));

    await expect(
      triageInbox({ config: makeConfig(), repositories, provider, runWorkflow }, {}),
    ).rejects.toThrow(/unknown thread "thread-2"/);
    expect(repositories.pendingActions.create).not.toHaveBeenCalled();
  });

  it("rejects draft recipients that were not present in the thread", async () => {
    const repositories = makeRepositories();
    const provider = makeProvider([summary()], { "thread-1": detail() });
    const analysis = validAnalysis();
    analysis.replyRecommendations[0]!.draft!.to = ["external@example.com"];
    const runWorkflow = vi.fn(async () => ({
      workflow: "inbox" as const,
      sessionId: "codex-thread-1",
      finalMessage: "",
      parsedOutput: analysis,
      events: [],
      resumed: false,
    }));

    await expect(
      triageInbox({ config: makeConfig(), repositories, provider, runWorkflow }, {}),
    ).rejects.toThrow(/unknown draft recipient "external@example.com"/);
    expect(repositories.pendingActions.create).not.toHaveBeenCalled();
  });
});
