import type { Page } from "playwright-core";

import type { CalendarEventPayload } from "../../types/actions.js";
import type {
  AvailabilitySlot,
  CalendarEventSummary,
} from "../calendar.js";
import type { BrowserGoogleSessionManager } from "./session.js";

const CALENDAR_ROOT_URL = "https://calendar.google.com/calendar/u/0/r";

interface RawCalendarEvent {
  id: string;
  href?: string;
  title: string;
  label: string;
  text: string;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function datePath(date: Date): string {
  return `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

function buildCalendarRangeUrl(timeMin?: string, timeMax?: string): string {
  const start = new Date(timeMin ?? new Date().toISOString());
  const end = new Date(
    timeMax ?? new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  );
  const rangeMs = end.getTime() - start.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (rangeMs <= oneDayMs) {
    return `${CALENDAR_ROOT_URL}/day/${datePath(start)}`;
  }

  if (rangeMs <= 8 * oneDayMs) {
    return `${CALENDAR_ROOT_URL}/week/${datePath(start)}`;
  }

  return `${CALENDAR_ROOT_URL}/agenda/${datePath(start)}`;
}

function toGoogleCalendarDateTime(isoValue: string): string {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid datetime: ${isoValue}`);
  }

  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "T",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    "Z",
  ].join("");
}

function buildEventEditUrl(payload: CalendarEventPayload): string {
  const params = new URLSearchParams({
    text: payload.summary,
    dates: `${toGoogleCalendarDateTime(payload.start)}/${toGoogleCalendarDateTime(payload.end)}`,
  });

  if (payload.description) {
    params.set("details", payload.description);
  }
  if (payload.location) {
    params.set("location", payload.location);
  }
  if (payload.attendees?.length) {
    params.set("add", payload.attendees.join(","));
  }

  return `${CALENDAR_ROOT_URL}/eventedit?${params.toString()}`;
}

async function ensureCalendarPage(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => undefined);

  let host = "";
  try {
    host = new URL(page.url()).host;
  } catch {
    host = "";
  }

  if (host !== "calendar.google.com") {
    throw new Error(
      "DeskPilot could not access Google Calendar in the browser profile. Run `deskpilot auth google --provider browser` first.",
    );
  }
}

function guessTitle(raw: RawCalendarEvent): string {
  if (raw.title) {
    return raw.title;
  }

  const pieces = [raw.label, raw.text]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  return pieces[0] ?? "(untitled event)";
}

function parseEventDate(dateText: string, referenceYear: number): Date | undefined {
  const parsed = new Date(`${dateText}, ${referenceYear}`);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  const direct = new Date(dateText);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  return undefined;
}

function parseTimePart(timeText: string): { hours: number; minutes: number } | undefined {
  const match = timeText.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!match) {
    return undefined;
  }

  let hours = Number.parseInt(match[1] ?? "0", 10);
  const minutes = Number.parseInt(match[2] ?? "0", 10);
  const meridiem = (match[3] ?? "").toLowerCase();

  if (meridiem === "pm" && hours !== 12) {
    hours += 12;
  }
  if (meridiem === "am" && hours === 12) {
    hours = 0;
  }

  return { hours, minutes };
}

function parseLabelRange(
  label: string,
  referenceStart: Date,
): { start?: string; end?: string } {
  const normalized = normalizeText(label);
  const rangeMatch = normalized.match(
    /([A-Za-z]+,\s+[A-Za-z]+\s+\d{1,2})(?:,\s+\d{4})?.*?(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*(?:-|–|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i,
  );

  if (rangeMatch) {
    const date = parseEventDate(rangeMatch[1] ?? "", referenceStart.getUTCFullYear());
    const startTime = parseTimePart(rangeMatch[2] ?? "");
    const endTime = parseTimePart(rangeMatch[3] ?? "");

    if (date && startTime && endTime) {
      const start = new Date(date);
      start.setHours(startTime.hours, startTime.minutes, 0, 0);
      const end = new Date(date);
      end.setHours(endTime.hours, endTime.minutes, 0, 0);

      return {
        start: start.toISOString(),
        end: end.toISOString(),
      };
    }
  }

  return {};
}

function parseCalendarCandidate(
  raw: RawCalendarEvent,
  referenceStart: Date,
): CalendarEventSummary | undefined {
  const parsedRange = parseLabelRange(raw.label || raw.text, referenceStart);
  const id = raw.href || raw.id || `calendar-event:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const title = guessTitle(raw);

  if (!parsedRange.start || !parsedRange.end) {
    return {
      id,
      title,
      start: "",
      end: "",
      attendees: [],
    };
  }

  return {
    id,
    title,
    start: parsedRange.start,
    end: parsedRange.end,
    attendees: [],
  };
}

async function extractVisibleEvents(page: Page): Promise<RawCalendarEvent[]> {
  await page.waitForSelector("body", { timeout: 15_000 });

  return await page.evaluate(() => {
    const normalize = (value: string | null | undefined) =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>("[data-eventid], a[href*='/eventedit/'], a[href*='/event?eid=']"),
    );

    const seen = new Set<string>();
    const items: RawCalendarEvent[] = [];

    for (const node of nodes) {
      const key =
        node.getAttribute("data-eventid") ??
        (node as HTMLAnchorElement).href ??
        normalize(node.getAttribute("aria-label")) ??
        normalize(node.textContent);

      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);

      const titleNode =
        node.querySelector<HTMLElement>('[role="heading"], [title]') ??
        node;

      items.push({
        id: node.getAttribute("data-eventid") ?? "",
        href: node instanceof HTMLAnchorElement ? node.href : undefined,
        title: normalize(titleNode.getAttribute("title")) || normalize(titleNode.textContent),
        label: normalize(node.getAttribute("aria-label")),
        text: normalize(node.textContent),
      });
    }

    return items;
  });
}

function toDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid datetime: ${value}`);
  }
  return date;
}

export async function listBrowserCalendarEvents(
  session: BrowserGoogleSessionManager,
  options?: { timeMin?: string; timeMax?: string; maxResults?: number },
): Promise<CalendarEventSummary[]> {
  return await session.withPage(async (page) => {
    const viewUrl = buildCalendarRangeUrl(options?.timeMin, options?.timeMax);
    await ensureCalendarPage(page, viewUrl);

    const referenceStart = new Date(options?.timeMin ?? new Date().toISOString());
    const rawEvents = await extractVisibleEvents(page);
    const parsed = rawEvents
      .map((raw) => parseCalendarCandidate(raw, referenceStart))
      .filter((event): event is CalendarEventSummary => Boolean(event));

    return parsed.slice(0, options?.maxResults ?? 20);
  });
}

export async function findBrowserCalendarAvailability(
  session: BrowserGoogleSessionManager,
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
  const events = await listBrowserCalendarEvents(session, {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    maxResults: 100,
  });

  const busyWindows = events
    .filter((event) => event.start && event.end)
    .map((event) => ({
      start: toDate(event.start),
      end: toDate(event.end),
    }))
    .sort((left, right) => left.start.getTime() - right.start.getTime());

  const slots: AvailabilitySlot[] = [];
  const requiredMs = options.durationMinutes * 60 * 1000;
  let cursor = start;

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

export async function createBrowserCalendarEvent(
  session: BrowserGoogleSessionManager,
  payload: CalendarEventPayload,
): Promise<{ id: string; htmlLink: string }> {
  return await session.withPage(async (page) => {
    const eventEditUrl = buildEventEditUrl(payload);
    await ensureCalendarPage(page, eventEditUrl);

    const saveButton = page.getByRole("button", { name: /^save$/i }).first();
    if (!(await saveButton.count())) {
      throw new Error(
        "DeskPilot could not find the Calendar Save button in browser mode.",
      );
    }

    await saveButton.click();
    await page.waitForLoadState("networkidle").catch(() => undefined);

    const externalRef = page.url() || `browser-calendar-event:${Date.now()}`;
    return {
      id: externalRef,
      htmlLink: externalRef,
    };
  });
}
