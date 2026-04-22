#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { stageCalendarEvent, stageGmailDraft } from "../actions/staging.js";
import { ensureDeskPilotDirectories, loadDeskPilotConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { openDatabase } from "../storage/db.js";
import {
  createRepositories,
  type DeskPilotRepositories,
} from "../storage/repositories.js";
import type { AvailabilitySlot, CalendarEventSummary } from "../google/calendar.js";
import type { DriveFileContent, DriveFileSummary } from "../google/drive.js";
import type { GmailThreadDetail, GmailThreadSummary } from "../google/gmail.js";
import {
  createGoogleWorkspaceProvider,
  type GoogleWorkspaceCapabilities,
  type GoogleWorkspaceProvider,
} from "../google/provider.js";
import type { CalendarEventPayload, GmailDraftPayload, PendingAction } from "../types/actions.js";
import type { FollowupItem } from "../types/results.js";

interface WorkspaceServices {
  capabilities: GoogleWorkspaceCapabilities;
  gmail?: {
    listThreads(args: { query?: string; maxResults?: number }): Promise<GmailThreadSummary[]>;
    getThread(threadId: string): Promise<GmailThreadDetail>;
  };
  calendar?: {
    listEvents(args: { timeMin?: string; timeMax?: string; maxResults?: number }): Promise<CalendarEventSummary[]>;
    findAvailability(args: {
      durationMinutes: number;
      timeMin?: string;
      timeMax?: string;
      limit?: number;
    }): Promise<AvailabilitySlot[]>;
  };
  drive?: {
    search(args: { query: string; maxResults?: number }): Promise<DriveFileSummary[]>;
    getFile(fileId: string): Promise<DriveFileContent>;
  };
  followups: {
    list(status?: string): Promise<FollowupItem[]>;
  };
  stage: {
    gmailDraft(payload: GmailDraftPayload, sourceRefs: string[]): Promise<PendingAction>;
    calendarEvent(payload: CalendarEventPayload, sourceRefs: string[]): Promise<PendingAction>;
  };
}

function jsonContent<T extends object>(structuredContent: T) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}

function createWorkspaceServices(
  provider: GoogleWorkspaceProvider,
  repositories: DeskPilotRepositories,
): WorkspaceServices {
  return {
    capabilities: provider.capabilities,
    gmail: provider.gmail
      ? {
          async listThreads(args) {
            return await provider.gmail!.listThreads(args);
          },
          async getThread(threadId) {
            return await provider.gmail!.getThread(threadId);
          },
        }
      : undefined,
    calendar: provider.calendar
      ? {
          async listEvents(args) {
            return await provider.calendar!.listEvents(args);
          },
          async findAvailability(args) {
            return await provider.calendar!.findAvailability(args);
          },
        }
      : undefined,
    drive: provider.drive
      ? {
          async search(args) {
            return await provider.drive!.search(args);
          },
          async getFile(fileId) {
            return await provider.drive!.getFile(fileId);
          },
        }
      : undefined,
    followups: {
      async list(status) {
        return repositories.followups.list(status);
      },
    },
    stage: {
      async gmailDraft(payload, sourceRefs) {
        return stageGmailDraft(repositories.pendingActions, payload, sourceRefs);
      },
      async calendarEvent(payload, sourceRefs) {
        return stageCalendarEvent(repositories.pendingActions, payload, sourceRefs);
      },
    },
  };
}

export function createWorkspaceServer(services: WorkspaceServices): McpServer {
  const server = new McpServer({
    name: "deskpilot-workspace",
    version: "0.1.0",
  });

  if (services.gmail) {
    server.registerTool(
      "gmail_list_threads",
      {
        description: "List Gmail threads for the authenticated DeskPilot user.",
        inputSchema: {
          query: z.string().optional(),
          maxResults: z.number().int().min(1).max(50).optional(),
        },
      },
      async ({ query, maxResults }) => {
        const threads = await services.gmail!.listThreads({ query, maxResults });
        return jsonContent({ threads });
      },
    );

    server.registerTool(
      "gmail_get_thread",
      {
        description: "Get the full contents of a Gmail thread by ID.",
        inputSchema: {
          threadId: z.string(),
        },
      },
      async ({ threadId }) => {
        const thread = await services.gmail!.getThread(threadId);
        return jsonContent({
          ...thread,
          messages: thread.messages.map((message) => ({ ...message })),
        });
      },
    );
  }

  if (services.calendar) {
    server.registerTool(
      "calendar_list_events",
      {
        description: "List events on the user's primary Google Calendar.",
        inputSchema: {
          timeMin: z.string().optional(),
          timeMax: z.string().optional(),
          maxResults: z.number().int().min(1).max(100).optional(),
        },
      },
      async ({ timeMin, timeMax, maxResults }) => {
        const events = await services.calendar!.listEvents({ timeMin, timeMax, maxResults });
        return jsonContent({ events });
      },
    );

    server.registerTool(
      "calendar_find_availability",
      {
        description: "Find open time slots on the user's calendar.",
        inputSchema: {
          durationMinutes: z.number().int().positive(),
          timeMin: z.string().optional(),
          timeMax: z.string().optional(),
          limit: z.number().int().min(1).max(10).optional(),
        },
      },
      async ({ durationMinutes, timeMin, timeMax, limit }) => {
        const slots = await services.calendar!.findAvailability({
          durationMinutes,
          timeMin,
          timeMax,
          limit,
        });
        return jsonContent({ slots });
      },
    );
  }

  if (services.drive) {
    server.registerTool(
      "drive_search",
      {
        description: "Search Google Drive files by query string.",
        inputSchema: {
          query: z.string(),
          maxResults: z.number().int().min(1).max(20).optional(),
        },
      },
      async ({ query, maxResults }) => {
        const files = await services.drive!.search({ query, maxResults });
        return jsonContent({ files });
      },
    );

    server.registerTool(
      "drive_get_file",
      {
        description: "Download and normalize a Drive file by ID.",
        inputSchema: {
          fileId: z.string(),
        },
      },
      async ({ fileId }) => {
        const file = await services.drive!.getFile(fileId);
        return jsonContent({ ...file });
      },
    );
  }

  server.registerTool(
    "followups_list",
    {
      description: "List locally persisted DeskPilot follow-up items.",
      inputSchema: {
        status: z.string().optional(),
      },
    },
    async ({ status }) => {
      const followups = await services.followups.list(status);
      return jsonContent({ followups });
    },
  );

  server.registerTool(
    "stage_gmail_draft",
    {
      description: "Stage a Gmail draft without sending it.",
      inputSchema: {
        to: z.array(z.string()).min(1),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string(),
        bodyText: z.string(),
        threadId: z.string().optional(),
        sourceRefs: z.array(z.string()).optional(),
      },
    },
    async ({ to, cc, bcc, subject, bodyText, threadId, sourceRefs }) => {
      const action = await services.stage.gmailDraft(
        { to, cc, bcc, subject, bodyText, threadId },
        sourceRefs ?? [],
      );
      return jsonContent({
        actionId: action.id,
        kind: action.kind,
        previewMarkdown: action.previewMarkdown,
        sourceRefs: action.sourceRefs,
      });
    },
  );

  server.registerTool(
    "stage_calendar_event",
    {
      description: "Stage a calendar event without creating it yet.",
      inputSchema: {
        summary: z.string(),
        description: z.string().optional(),
        start: z.string(),
        end: z.string(),
        attendees: z.array(z.string()).optional(),
        location: z.string().optional(),
        sourceRefs: z.array(z.string()).optional(),
      },
    },
    async ({ summary, description, start, end, attendees, location, sourceRefs }) => {
      const action = await services.stage.calendarEvent(
        { summary, description, start, end, attendees, location },
        sourceRefs ?? [],
      );
      return jsonContent({
        actionId: action.id,
        kind: action.kind,
        previewMarkdown: action.previewMarkdown,
        sourceRefs: action.sourceRefs,
      });
    },
  );

  return server;
}

async function main(): Promise<void> {
  const config = loadDeskPilotConfig();
  ensureDeskPilotDirectories(config);
  const logger = createLogger(config);
  const db = openDatabase(config);
  const repositories = createRepositories(db);
  const provider = createGoogleWorkspaceProvider(config, {
    cacheRepository: repositories.cache,
  });
  const server = createWorkspaceServer(createWorkspaceServices(provider, repositories));
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await provider.close?.().catch(() => undefined);
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  try {
    await server.connect(transport);
    logger.info("DeskPilot MCP server started");
    console.error("DeskPilot MCP server running on stdio");
  } catch (error) {
    await shutdown();
    throw error;
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && currentFile === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error("DeskPilot MCP server failed:", error);
    process.exitCode = 1;
  });
}
