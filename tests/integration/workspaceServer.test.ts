import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createWorkspaceServer } from "../../src/mcp/workspaceServer.js";

describe("workspace MCP server", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        await server.close();
      }
    }
  });

  it("exposes read and stage tools through MCP", async () => {
    const server = createWorkspaceServer({
      capabilities: {
        mode: "oauth",
        gmail: true,
        calendar: true,
        drive: true,
      },
      gmail: {
        async listThreads() {
          return [
            {
              threadId: "thread-1",
              subject: "Budget review",
              from: "finance@example.com",
              snippet: "Please review the spreadsheet",
              receivedAt: "2026-04-22T10:00:00.000Z",
            },
          ];
        },
        async getThread(threadId: string) {
          return {
            threadId,
            snippet: "Budget review details",
            messages: [
              {
                id: "msg-1",
                from: "finance@example.com",
                to: "me@example.com",
                subject: "Budget review",
                date: "Wed, 22 Apr 2026 10:00:00 -0400",
                bodyText: "Please review the spreadsheet before noon.",
                snippet: "Please review the spreadsheet",
              },
            ],
          };
        },
      },
      calendar: {
        async listEvents() {
          return [
            {
              id: "event-1",
              title: "Standup",
              start: "2026-04-22T09:00:00.000Z",
              end: "2026-04-22T09:15:00.000Z",
              attendees: ["team@example.com"],
            },
          ];
        },
        async findAvailability() {
          return [
            {
              start: "2026-04-22T15:00:00.000Z",
              end: "2026-04-22T15:30:00.000Z",
            },
          ];
        },
      },
      drive: {
        async search() {
          return [
            {
              id: "file-1",
              name: "Q2 Plan",
              mimeType: "application/vnd.google-apps.document",
            },
          ];
        },
        async getFile(fileId: string) {
          return {
            id: fileId,
            name: "Q2 Plan",
            mimeType: "application/vnd.google-apps.document",
            contentText: "Q2 plan text",
            truncated: false,
          };
        },
      },
      followups: {
        async list() {
          return [
            {
              id: "followup-1",
              title: "Review budget",
              status: "open",
              sourceRefs: ["thread:thread-1"],
              fingerprint: "fp-1",
              createdAt: "2026-04-22T10:05:00.000Z",
            },
          ];
        },
      },
      stage: {
        async gmailDraft(payload, sourceRefs) {
          return {
            id: "action-1",
            kind: "gmail_draft",
            status: "staged",
            previewMarkdown: `# Gmail Draft\n\n${payload.subject}`,
            payloadJson: JSON.stringify(payload),
            sourceRefs,
            createdAt: "2026-04-22T10:06:00.000Z",
          };
        },
        async calendarEvent(payload, sourceRefs) {
          return {
            id: "action-2",
            kind: "calendar_event",
            status: "staged",
            previewMarkdown: `# Calendar Event\n\n${payload.summary}`,
            payloadJson: JSON.stringify(payload),
            sourceRefs,
            createdAt: "2026-04-22T10:06:00.000Z",
          };
        },
      },
    });

    servers.push(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "deskpilot-test-client", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

    expect(toolNames).toContain("gmail_list_threads");
    expect(toolNames).toContain("stage_gmail_draft");
    expect(tools.tools.find((tool) => tool.name === "gmail_list_threads")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools.tools.find((tool) => tool.name === "followups_list")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools.tools.find((tool) => tool.name === "stage_gmail_draft")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });

    const gmailListResult = await client.callTool({
      name: "gmail_list_threads",
      arguments: { query: "label:inbox" },
    });
    const gmailListText = gmailListResult.content[0];
    expect(gmailListText?.type).toBe("text");
    if (gmailListText?.type === "text") {
      expect(gmailListText.text).toContain("Budget review");
    }

    const stageResult = await client.callTool({
      name: "stage_gmail_draft",
      arguments: {
        to: ["finance@example.com"],
        subject: "Re: Budget review",
        bodyText: "Draft reply",
        sourceRefs: ["thread:thread-1"],
      },
    });
    const stageText = stageResult.content[0];
    expect(stageText?.type).toBe("text");
    if (stageText?.type === "text") {
      expect(stageText.text).toContain("action-1");
      expect(stageText.text).toContain("thread:thread-1");
    }
  });

  it("omits Drive tools when Drive is unavailable", async () => {
    const server = createWorkspaceServer({
      capabilities: {
        mode: "browser",
        gmail: true,
        calendar: true,
        drive: false,
      },
      gmail: {
        async listThreads() {
          return [];
        },
        async getThread(threadId: string) {
          return {
            threadId,
            snippet: "",
            messages: [],
          };
        },
      },
      calendar: {
        async listEvents() {
          return [];
        },
        async findAvailability() {
          return [];
        },
      },
      followups: {
        async list() {
          return [];
        },
      },
      stage: {
        async gmailDraft(payload, sourceRefs) {
          return {
            id: "action-1",
            kind: "gmail_draft",
            status: "staged",
            previewMarkdown: payload.subject,
            payloadJson: JSON.stringify(payload),
            sourceRefs,
            createdAt: "2026-04-22T10:06:00.000Z",
          };
        },
        async calendarEvent(payload, sourceRefs) {
          return {
            id: "action-2",
            kind: "calendar_event",
            status: "staged",
            previewMarkdown: payload.summary,
            payloadJson: JSON.stringify(payload),
            sourceRefs,
            createdAt: "2026-04-22T10:06:00.000Z",
          };
        },
      },
    });

    servers.push(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "deskpilot-test-client", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

    expect(toolNames).toContain("gmail_list_threads");
    expect(toolNames).toContain("calendar_list_events");
    expect(toolNames).not.toContain("drive_search");
    expect(toolNames).not.toContain("drive_get_file");
  });
});
