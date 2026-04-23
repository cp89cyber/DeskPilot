import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { DeskPilotConfig, CodexWorkflow } from "../types/config.js";

const nullableString = z.string().nullish().transform((value) => value ?? undefined);
const nullableStringArray = z.array(z.string()).nullish().transform((value) => value ?? undefined);

export const inboxTriageSchema = z.object({
  overview: z.string(),
  urgentThreads: z.array(
    z.object({
      threadId: z.string(),
      subject: z.string(),
      reason: z.string(),
    }),
  ),
  replyRecommendations: z.array(
    z.object({
      threadId: z.string(),
      recommendation: z.string(),
      stagedActionId: nullableString,
    }),
  ),
  followUps: z.array(
    z.object({
      title: z.string(),
      dueAt: nullableString,
      status: z.string(),
      sourceRefs: z.array(z.string()),
    }),
  ),
  stagedActionIds: z.array(z.string()),
  sourceRefs: z.array(z.string()),
});

export const dailyBriefSchema = z.object({
  date: z.string(),
  summary: z.string(),
  priorities: z.array(z.string()),
  meetings: z.array(
    z.object({
      title: z.string(),
      start: z.string(),
      end: nullableString,
      prepNotes: z.string(),
      relatedFiles: nullableStringArray,
      sourceRefs: z.array(z.string()),
    }),
  ),
  urgentThreads: z.array(
    z.object({
      threadId: z.string(),
      subject: z.string(),
      reason: z.string(),
    }),
  ),
  followUps: z.array(
    z.object({
      title: z.string(),
      dueAt: nullableString,
      status: z.string(),
      sourceRefs: z.array(z.string()),
    }),
  ),
  sourceRefs: z.array(z.string()),
});

export const schedulePlanSchema = z.object({
  needsClarification: z.boolean(),
  clarifyingQuestion: nullableString,
  summary: nullableString,
  proposedSlots: z
    .array(
      z.object({
        start: z.string(),
        end: z.string(),
        reason: z.string(),
      }),
    )
    .nullish()
    .transform((value) => value ?? undefined),
  draftInvitation: z
    .object({
      subject: z.string(),
      body: z.string(),
    })
    .nullish()
    .transform((value) => value ?? undefined),
  stagedActionId: nullableString,
  sourceRefs: z.array(z.string()),
});

export const documentSummarySchema = z.object({
  title: z.string(),
  summary: z.string(),
  keyPoints: z.array(z.string()),
  actionItems: z.array(z.string()),
  sourceRefs: z.array(z.string()),
});

export function schemaPathForWorkflow(
  config: DeskPilotConfig,
  workflow: Exclude<CodexWorkflow, "chat">,
): string {
  const fileNameByWorkflow: Record<Exclude<CodexWorkflow, "chat">, string> = {
    inbox: "inbox-triage.json",
    brief: "daily-brief.json",
    schedule: "schedule-plan.json",
    summarize: "document-summary.json",
  };

  return path.join(config.repoRoot, "schemas", fileNameByWorkflow[workflow]);
}

export function schemaTextForWorkflow(
  config: DeskPilotConfig,
  workflow: Exclude<CodexWorkflow, "chat">,
): string {
  return fs.readFileSync(schemaPathForWorkflow(config, workflow), "utf8");
}

export function validateWorkflowResult(
  workflow: Exclude<CodexWorkflow, "chat">,
  value: unknown,
): unknown {
  switch (workflow) {
    case "inbox":
      return inboxTriageSchema.parse(value);
    case "brief":
      return dailyBriefSchema.parse(value);
    case "schedule":
      return schedulePlanSchema.parse(value);
    case "summarize":
      return documentSummarySchema.parse(value);
  }
}
