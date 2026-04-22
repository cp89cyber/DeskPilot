import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { DeskPilotConfig, CodexWorkflow } from "../types/config.js";

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
      stagedActionId: z.string().optional(),
    }),
  ),
  followUps: z.array(
    z.object({
      title: z.string(),
      dueAt: z.string().optional(),
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
      end: z.string().optional(),
      prepNotes: z.string(),
      relatedFiles: z.array(z.string()).optional(),
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
      dueAt: z.string().optional(),
      status: z.string(),
      sourceRefs: z.array(z.string()),
    }),
  ),
  sourceRefs: z.array(z.string()),
});

export const schedulePlanSchema = z.object({
  needsClarification: z.boolean(),
  clarifyingQuestion: z.string().optional(),
  summary: z.string().optional(),
  proposedSlots: z
    .array(
      z.object({
        start: z.string(),
        end: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
  draftInvitation: z
    .object({
      subject: z.string(),
      body: z.string(),
    })
    .optional(),
  stagedActionId: z.string().optional(),
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
