import type {
  CalendarEventPayload,
  GmailDraftPayload,
  PendingAction,
} from "../types/actions.js";
import type { PendingActionsRepository } from "../storage/repositories.js";

function lines(items: string[] | undefined): string {
  return items && items.length > 0 ? items.join(", ") : "(none)";
}

export function stageGmailDraft(
  repository: PendingActionsRepository,
  payload: GmailDraftPayload,
  sourceRefs: string[],
): PendingAction {
  const previewMarkdown = [
    `# Gmail Draft`,
    ``,
    `**To:** ${lines(payload.to)}`,
    `**CC:** ${lines(payload.cc)}`,
    `**BCC:** ${lines(payload.bcc)}`,
    `**Subject:** ${payload.subject}`,
    ``,
    payload.bodyText,
  ].join("\n");

  return repository.create({
    kind: "gmail_draft",
    previewMarkdown,
    payload,
    sourceRefs,
  });
}

export function stageCalendarEvent(
  repository: PendingActionsRepository,
  payload: CalendarEventPayload,
  sourceRefs: string[],
): PendingAction {
  const previewMarkdown = [
    `# Calendar Event`,
    ``,
    `**Summary:** ${payload.summary}`,
    `**Start:** ${payload.start}`,
    `**End:** ${payload.end}`,
    `**Location:** ${payload.location ?? "(none)"}`,
    `**Attendees:** ${lines(payload.attendees)}`,
    ``,
    payload.description ?? "",
  ]
    .filter(Boolean)
    .join("\n");

  return repository.create({
    kind: "calendar_event",
    previewMarkdown,
    payload,
    sourceRefs,
  });
}
