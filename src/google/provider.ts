import type { CacheRepository } from "../storage/repositories.js";
import type { DeskPilotConfig, GoogleMode } from "../types/config.js";
import type { CalendarEventPayload, GmailDraftPayload } from "../types/actions.js";
import type {
  AvailabilitySlot,
  CalendarEventSummary,
} from "./calendar.js";
import type {
  DriveFileContent,
  DriveFileSummary,
} from "./drive.js";
import type {
  GmailThreadDetail,
  GmailThreadSummary,
} from "./gmail.js";
import { hasStoredGoogleTokens } from "./oauth.js";
import { BrowserGoogleWorkspaceProvider } from "./providers/browserProvider.js";
import { OAuthGoogleWorkspaceProvider } from "./providers/oauthProvider.js";

export interface GoogleWorkspaceCapabilities {
  mode: GoogleMode;
  gmail: boolean;
  calendar: boolean;
  drive: boolean;
}

export interface GmailWorkspaceService {
  listThreads(args: { query?: string; maxResults?: number }): Promise<GmailThreadSummary[]>;
  getThread(threadId: string): Promise<GmailThreadDetail>;
  createDraft(payload: GmailDraftPayload): Promise<{ id: string; threadId: string }>;
}

export interface CalendarWorkspaceService {
  listEvents(args: {
    timeMin?: string;
    timeMax?: string;
    maxResults?: number;
  }): Promise<CalendarEventSummary[]>;
  findAvailability(args: {
    durationMinutes: number;
    timeMin?: string;
    timeMax?: string;
    limit?: number;
  }): Promise<AvailabilitySlot[]>;
  createEvent(payload: CalendarEventPayload): Promise<{ id: string; htmlLink: string }>;
}

export interface DriveWorkspaceService {
  search(args: { query: string; maxResults?: number }): Promise<DriveFileSummary[]>;
  getFile(fileId: string): Promise<DriveFileContent>;
}

export interface GoogleWorkspaceProvider {
  capabilities: GoogleWorkspaceCapabilities;
  gmail?: GmailWorkspaceService;
  calendar?: CalendarWorkspaceService;
  drive?: DriveWorkspaceService;
  close?(): Promise<void>;
}

export interface GoogleWorkspaceProviderOptions {
  cacheRepository?: CacheRepository;
}

export function resolveGoogleWorkspaceCapabilities(
  config: DeskPilotConfig,
): GoogleWorkspaceCapabilities {
  if (config.googleMode === "oauth") {
    return {
      mode: "oauth",
      gmail: true,
      calendar: true,
      drive: true,
    };
  }

  return {
    mode: "browser",
    gmail: true,
    calendar: true,
    drive: Boolean(config.googleOAuthCredentials) && hasStoredGoogleTokens(config),
  };
}

export function canUseDriveTools(config: DeskPilotConfig): boolean {
  return resolveGoogleWorkspaceCapabilities(config).drive;
}

export function createGoogleWorkspaceProvider(
  config: DeskPilotConfig,
  options: GoogleWorkspaceProviderOptions = {},
): GoogleWorkspaceProvider {
  return config.googleMode === "oauth"
    ? new OAuthGoogleWorkspaceProvider(config, options)
    : new BrowserGoogleWorkspaceProvider(config, options);
}
