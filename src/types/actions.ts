export type PendingActionKind = "gmail_draft" | "calendar_event";
export type PendingActionStatus = "staged" | "applied";

export interface PendingAction {
  id: string;
  kind: PendingActionKind;
  status: PendingActionStatus;
  previewMarkdown: string;
  payloadJson: string;
  sourceRefs: string[];
  createdAt: string;
  appliedAt?: string;
}

export interface GmailDraftPayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  threadId?: string;
}

export interface CalendarEventPayload {
  summary: string;
  description?: string;
  start: string;
  end: string;
  attendees?: string[];
  location?: string;
}
