import type { CacheRepository } from "../../storage/repositories.js";
import type { DeskPilotConfig } from "../../types/config.js";
import { getDriveFile, searchDriveFiles } from "../drive.js";
import type {
  DriveWorkspaceService,
  GoogleWorkspaceCapabilities,
  GoogleWorkspaceProvider,
  GoogleWorkspaceProviderOptions,
} from "../provider.js";
import { resolveGoogleWorkspaceCapabilities } from "../provider.js";
import {
  createBrowserCalendarEvent,
  findBrowserCalendarAvailability,
  listBrowserCalendarEvents,
} from "../browser/calendar.js";
import {
  createBrowserGmailDraft,
  getBrowserGmailThread,
  listBrowserGmailThreads,
} from "../browser/gmail.js";
import { BrowserGoogleSessionManager } from "../browser/session.js";

function createDriveService(
  config: DeskPilotConfig,
  cacheRepository?: CacheRepository,
): DriveWorkspaceService | undefined {
  if (!cacheRepository) {
    return undefined;
  }

  return {
    search: async (args) =>
      await searchDriveFiles(config, {
        query: args.query,
        pageSize: args.maxResults,
      }),
    getFile: async (fileId) => await getDriveFile(config, cacheRepository, fileId),
  };
}

export class BrowserGoogleWorkspaceProvider implements GoogleWorkspaceProvider {
  readonly capabilities: GoogleWorkspaceCapabilities;

  readonly gmail: GoogleWorkspaceProvider["gmail"];

  readonly calendar: GoogleWorkspaceProvider["calendar"];

  readonly drive?: DriveWorkspaceService;

  private readonly session: BrowserGoogleSessionManager;

  constructor(
    private readonly config: DeskPilotConfig,
    private readonly options: GoogleWorkspaceProviderOptions = {},
  ) {
    this.capabilities = resolveGoogleWorkspaceCapabilities(config);
    this.session = new BrowserGoogleSessionManager(config);

    this.gmail = {
      listThreads: async (args) =>
        await listBrowserGmailThreads(this.session, {
          query: args.query,
          maxResults: args.maxResults,
        }),
      getThread: async (threadId) => await getBrowserGmailThread(this.session, threadId),
      createDraft: async (payload) => await createBrowserGmailDraft(this.session, payload),
    };

    this.calendar = {
      listEvents: async (args) => await listBrowserCalendarEvents(this.session, args),
      findAvailability: async (args) => await findBrowserCalendarAvailability(this.session, args),
      createEvent: async (payload) => await createBrowserCalendarEvent(this.session, payload),
    };

    this.drive = this.capabilities.drive
      ? createDriveService(this.config, this.options.cacheRepository)
      : undefined;
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}
