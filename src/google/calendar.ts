import { google } from "googleapis";

import { getAuthenticatedOAuthClient } from "./oauth.js";
import type { DeskPilotConfig } from "../types/config.js";
import type { CalendarEventPayload } from "../types/actions.js";

export interface CalendarEventSummary {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  attendees: string[];
}

export interface AvailabilitySlot {
  start: string;
  end: string;
}

function isoOrDate(value?: string | null): string {
  return value ?? "";
}

async function calendarClient(config: DeskPilotConfig) {
  const auth = await getAuthenticatedOAuthClient(config);
  return google.calendar({ version: "v3", auth });
}

export async function listCalendarEvents(
  config: DeskPilotConfig,
  options?: { timeMin?: string; timeMax?: string; maxResults?: number },
): Promise<CalendarEventSummary[]> {
  const client = await calendarClient(config);
  const result = await client.events.list({
    calendarId: "primary",
    timeMin: options?.timeMin ?? new Date().toISOString(),
    timeMax: options?.timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: options?.maxResults ?? 20,
  });

  return (result.data.items ?? []).map((event) => ({
    id: event.id ?? "",
    title: event.summary ?? "(untitled event)",
    start: isoOrDate(event.start?.dateTime ?? event.start?.date),
    end: isoOrDate(event.end?.dateTime ?? event.end?.date),
    location: event.location ?? undefined,
    attendees: (event.attendees ?? [])
      .map((attendee) => attendee.email)
      .filter((email): email is string => Boolean(email)),
  }));
}

function toDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid datetime: ${value}`);
  }
  return date;
}

export async function findCalendarAvailability(
  config: DeskPilotConfig,
  options: {
    durationMinutes: number;
    timeMin?: string;
    timeMax?: string;
    limit?: number;
  },
): Promise<AvailabilitySlot[]> {
  const start = toDate(options.timeMin ?? new Date().toISOString());
  const end = toDate(
    options.timeMax ??
      new Date(start.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString(),
  );
  const events = await listCalendarEvents(config, {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    maxResults: 100,
  });

  const busyWindows = events
    .map((event) => ({
      start: toDate(event.start),
      end: toDate(event.end),
    }))
    .sort((left, right) => left.start.getTime() - right.start.getTime());

  const slots: AvailabilitySlot[] = [];
  let cursor = start;
  const requiredMs = options.durationMinutes * 60 * 1000;

  for (const busy of busyWindows) {
    if (busy.start.getTime() - cursor.getTime() >= requiredMs) {
      slots.push({
        start: cursor.toISOString(),
        end: new Date(cursor.getTime() + requiredMs).toISOString(),
      });
      if (slots.length >= (options.limit ?? 3)) {
        return slots;
      }
    }

    if (busy.end.getTime() > cursor.getTime()) {
      cursor = busy.end;
    }
  }

  if (end.getTime() - cursor.getTime() >= requiredMs) {
    slots.push({
      start: cursor.toISOString(),
      end: new Date(cursor.getTime() + requiredMs).toISOString(),
    });
  }

  return slots.slice(0, options.limit ?? 3);
}

export async function createCalendarEvent(config: DeskPilotConfig, payload: CalendarEventPayload) {
  const client = await calendarClient(config);
  const result = await client.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: payload.summary,
      description: payload.description,
      location: payload.location,
      start: { dateTime: payload.start },
      end: { dateTime: payload.end },
      attendees: payload.attendees?.map((email) => ({ email })),
    },
  });

  return {
    id: result.data.id ?? "",
    htmlLink: result.data.htmlLink ?? "",
  };
}
