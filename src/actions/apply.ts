import type { Logger } from "../logger.js";
import { createCalendarEvent } from "../google/calendar.js";
import { createGmailDraft } from "../google/gmail.js";
import type { DeskPilotConfig } from "../types/config.js";
import type { PendingAction } from "../types/actions.js";
import type { PendingActionsRepository } from "../storage/repositories.js";
import type { CalendarEventPayload, GmailDraftPayload } from "../types/actions.js";

export interface AppliedActionResult {
  action: PendingAction;
  externalId: string;
}

export async function applyPendingAction(
  config: DeskPilotConfig,
  repository: PendingActionsRepository,
  action: PendingAction,
  logger?: Logger,
): Promise<AppliedActionResult> {
  if (action.status !== "staged") {
    throw new Error(`Action ${action.id} is already applied.`);
  }

  let externalId: string;
  if (action.kind === "gmail_draft") {
    const payload = JSON.parse(action.payloadJson) as GmailDraftPayload;
    const result = await createGmailDraft(config, payload);
    externalId = result.id;
  } else if (action.kind === "calendar_event") {
    const payload = JSON.parse(action.payloadJson) as CalendarEventPayload;
    const result = await createCalendarEvent(config, payload);
    externalId = result.id ?? payload.summary;
  } else {
    throw new Error(`Unsupported action kind: ${action.kind}`);
  }

  logger?.info("Applied pending action", {
    actionId: action.id,
    kind: action.kind,
    externalId,
  });

  const updated = repository.markApplied(action.id);
  if (!updated) {
    throw new Error(`Failed to mark action ${action.id} as applied.`);
  }

  return {
    action: updated,
    externalId,
  };
}
