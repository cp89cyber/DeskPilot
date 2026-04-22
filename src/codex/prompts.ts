import fs from "node:fs";
import path from "node:path";

import type { DeskPilotConfig, CodexWorkflow } from "../types/config.js";

function readPrompt(config: DeskPilotConfig, fileName: string): string {
  return fs.readFileSync(path.join(config.repoRoot, "prompts", fileName), "utf8").trim();
}

function joinSections(...sections: string[]): string {
  return sections.filter(Boolean).join("\n\n");
}

export function buildChatPrompt(config: DeskPilotConfig, userPrompt: string): string {
  return joinSections(readPrompt(config, "system.md"), userPrompt.trim());
}

export function buildInboxPrompt(config: DeskPilotConfig, query: string): string {
  return joinSections(
    readPrompt(config, "system.md"),
    readPrompt(config, "inbox.md"),
    `Inbox search query: ${query}`,
  );
}

export function buildBriefPrompt(config: DeskPilotConfig, todayIsoDate: string): string {
  return joinSections(
    readPrompt(config, "system.md"),
    readPrompt(config, "brief-today.md"),
    `Date to brief: ${todayIsoDate}`,
  );
}

export function buildSchedulePrompt(config: DeskPilotConfig, request: string): string {
  return joinSections(
    readPrompt(config, "system.md"),
    readPrompt(config, "schedule.md"),
    `Scheduling request: ${request.trim()}`,
  );
}

export function buildSummarizePrompt(
  config: DeskPilotConfig,
  options:
    | {
        kind: "drive-query";
        query: string;
      }
    | {
        kind: "local-document";
        sourceLabel: string;
        extractedText: string;
      },
): string {
  const base = joinSections(readPrompt(config, "system.md"), readPrompt(config, "summarize.md"));
  if (options.kind === "drive-query") {
    return joinSections(
      base,
      `Find the document using Drive tools, inspect the most relevant match, and summarize it.`,
      `Drive search query: ${options.query}`,
    );
  }

  return joinSections(
    base,
    `Summarize the local document content below.`,
    `Source: ${options.sourceLabel}`,
    `Document content:\n\n${options.extractedText}`,
  );
}

export function buildResumeSchemaPrompt(
  workflow: Exclude<CodexWorkflow, "chat">,
  basePrompt: string,
  schemaText: string,
): string {
  return joinSections(
    basePrompt,
    `Return only JSON that conforms to the following JSON Schema. Do not wrap it in markdown fences.`,
    schemaText,
    `This requirement is strict for the ${workflow} workflow.`,
  );
}
