import type { DeskPilotConfig } from "../../types/config.js";
import type {
  GoogleWorkspaceProvider,
  GoogleWorkspaceProviderOptions,
} from "../provider.js";
import {
  createCalendarEvent,
  findCalendarAvailability,
  listCalendarEvents,
} from "../calendar.js";
import { getDriveFile, searchDriveFiles } from "../drive.js";
import { createGmailDraft, getGmailThread, listGmailThreads } from "../gmail.js";
import { resolveGoogleWorkspaceCapabilities } from "../provider.js";

export class OAuthGoogleWorkspaceProvider implements GoogleWorkspaceProvider {
  readonly capabilities: GoogleWorkspaceProvider["capabilities"];

  readonly gmail: GoogleWorkspaceProvider["gmail"];

  readonly calendar: GoogleWorkspaceProvider["calendar"];

  readonly drive: GoogleWorkspaceProvider["drive"];

  constructor(
    private readonly config: DeskPilotConfig,
    private readonly options: GoogleWorkspaceProviderOptions = {},
  ) {
    this.capabilities = resolveGoogleWorkspaceCapabilities(config);

    this.gmail = {
      listThreads: async (args) =>
        await listGmailThreads(this.config, {
          query: args.query,
          maxResults: args.maxResults,
        }),
      getThread: async (threadId) => await getGmailThread(this.config, threadId),
      createDraft: async (payload) => await createGmailDraft(this.config, payload),
    };

    this.calendar = {
      listEvents: async (args) => await listCalendarEvents(this.config, args),
      findAvailability: async (args) => await findCalendarAvailability(this.config, args),
      createEvent: async (payload) => await createCalendarEvent(this.config, payload),
    };

    this.drive = {
      search: async (args) =>
        await searchDriveFiles(this.config, {
          query: args.query,
          pageSize: args.maxResults,
        }),
      getFile: async (fileId) => {
        if (!this.options.cacheRepository) {
          throw new Error("Drive file access requires a cache repository.");
        }

        return await getDriveFile(this.config, this.options.cacheRepository, fileId);
      },
    };
  }
}
