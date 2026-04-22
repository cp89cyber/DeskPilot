import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

import type { Logger } from "../logger.js";
import type { DeskPilotRepositories } from "../storage/repositories.js";
import type { CodexWorkflow, DeskPilotConfig } from "../types/config.js";
import { schemaPathForWorkflow, schemaTextForWorkflow, validateWorkflowResult } from "./schemas.js";
import { getWorkflowSession, saveWorkflowSession } from "./sessions.js";
import { buildResumeSchemaPrompt } from "./prompts.js";

export interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexRunResult {
  workflow: CodexWorkflow;
  sessionId: string;
  finalMessage: string;
  parsedOutput?: unknown;
  events: CodexEvent[];
  resumed: boolean;
}

export interface RunWorkflowOptions {
  workflow: CodexWorkflow;
  prompt: string;
  extraArgs?: string[];
}

function parseJsonLines(stdout: string): CodexEvent[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CodexEvent];
      } catch {
        return [];
      }
    });
}

function extractSessionId(events: CodexEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      return event.thread_id;
    }
  }
  return undefined;
}

function extractFinalMessage(events: CodexEvent[]): string {
  let lastMessage = "";
  for (const event of events) {
    const item =
      typeof event.item === "object" && event.item !== null
        ? (event.item as { type?: unknown; text?: unknown })
        : undefined;
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      lastMessage = item.text;
    }
  }
  return lastMessage;
}

function tempOutputPath(workflow: CodexWorkflow): string {
  return path.join(
    os.tmpdir(),
    `deskpilot-${workflow}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  );
}

async function runCodexCommand(
  config: DeskPilotConfig,
  args: string[],
  logger?: Logger,
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  logger?.info("Running codex command", { args });
  const result = await execa(config.codexBinary, args, {
    cwd: config.runtimeDir,
    reject: false,
    env: process.env,
  });

  if (result.exitCode !== 0) {
    logger?.error("Codex command failed", {
      args,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

function parseStructuredOutput(workflow: Exclude<CodexWorkflow, "chat">, rawText: string): unknown {
  const parsed = JSON.parse(rawText) as unknown;
  return validateWorkflowResult(workflow, parsed);
}

export async function runWorkflow(
  config: DeskPilotConfig,
  repositories: DeskPilotRepositories,
  options: RunWorkflowOptions,
  logger?: Logger,
): Promise<CodexRunResult> {
  const priorSession = getWorkflowSession(repositories, options.workflow);
  const outputFilePath = tempOutputPath(options.workflow);
  const extraArgs = options.extraArgs ?? [];
  const structuredWorkflow = options.workflow === "chat" ? undefined : options.workflow;
  const isStructuredWorkflow = structuredWorkflow !== undefined;
  const resumed = Boolean(priorSession);

  let args: string[];
  if (!priorSession) {
    args = [
      "exec",
      "-m",
      config.model,
      "-s",
      "read-only",
      "-C",
      config.runtimeDir,
      "--skip-git-repo-check",
      "--json",
      "-o",
      outputFilePath,
      ...extraArgs,
    ];

    if (isStructuredWorkflow) {
      args.push("--output-schema", schemaPathForWorkflow(config, structuredWorkflow));
    }

    args.push(options.prompt);
  } else {
    const prompt = isStructuredWorkflow
          ? buildResumeSchemaPrompt(
          structuredWorkflow,
          options.prompt,
          schemaTextForWorkflow(config, structuredWorkflow),
        )
      : options.prompt;

    args = [
      "exec",
      "resume",
      priorSession.codexSessionId,
      "--json",
      ...extraArgs,
      prompt,
    ];
  }

  const result = await runCodexCommand(config, args, logger);
  if (result.exitCode !== 0) {
    throw new Error(
      `Codex failed for workflow ${options.workflow}: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }

  const events = parseJsonLines(result.stdout);
  const sessionId = extractSessionId(events) ?? priorSession?.codexSessionId;
  if (!sessionId) {
    throw new Error(`Could not determine Codex session ID for workflow ${options.workflow}.`);
  }

  saveWorkflowSession(repositories, options.workflow, sessionId);

  let finalMessage = "";
  let parsedOutput: unknown;

  if (!resumed && fs.existsSync(outputFilePath)) {
    finalMessage = fs.readFileSync(outputFilePath, "utf8").trim();
    if (isStructuredWorkflow && finalMessage) {
      parsedOutput = parseStructuredOutput(structuredWorkflow, finalMessage);
    }
  }

  if (!finalMessage) {
    finalMessage = extractFinalMessage(events).trim();
  }

  if (isStructuredWorkflow && parsedOutput === undefined && finalMessage) {
    parsedOutput = parseStructuredOutput(structuredWorkflow, finalMessage);
  }

  return {
    workflow: options.workflow,
    sessionId,
    finalMessage,
    parsedOutput,
    events,
    resumed,
  };
}
