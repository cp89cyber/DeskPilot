import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

interface CodexCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  events: CodexEvent[];
  timedOut: boolean;
}

const DEFAULT_CODEX_TIMEOUT_MS = 10 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 30_000;

function configuredCodexTimeoutMs(): number {
  const raw = process.env.DESKPILOT_CODEX_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_CODEX_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CODEX_TIMEOUT_MS;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function parseJsonLine(line: string): CodexEvent | undefined {
  try {
    return JSON.parse(line) as CodexEvent;
  } catch {
    return undefined;
  }
}

function parseJsonLines(stdout: string): CodexEvent[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const event = parseJsonLine(line);
      return event ? [event] : [];
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

function eventMessage(event: CodexEvent): string | undefined {
  if (typeof event.message === "string") {
    return event.message;
  }

  const error =
    typeof event.error === "object" && event.error !== null
      ? (event.error as { message?: unknown })
      : undefined;
  if (typeof error?.message === "string") {
    return error.message;
  }

  return undefined;
}

function collectErrorMessages(events: CodexEvent[]): string[] {
  const messages = events
    .filter((event) => event.type === "error" || event.type === "turn.failed")
    .map(eventMessage)
    .filter((message): message is string => Boolean(message?.trim()))
    .map((message) => message.trim());

  return [...new Set(messages)];
}

function formatCodexFailure(
  workflow: CodexWorkflow,
  result: CodexCommandResult,
): string {
  if (result.timedOut) {
    return `Codex timed out for workflow ${workflow} after ${formatElapsed(configuredCodexTimeoutMs())}.`;
  }

  const details = [
    ...collectErrorMessages(result.events),
    result.stderr.trim(),
  ].filter(Boolean);

  return [
    `Codex failed for workflow ${workflow} with exit code ${result.exitCode ?? "unknown"}.`,
    ...details,
  ].join("\n\n");
}

function writeProgress(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function runCodexCommand(
  config: DeskPilotConfig,
  workflow: CodexWorkflow,
  args: string[],
  logger?: Logger,
): Promise<CodexCommandResult> {
  logger?.info("Running codex command", { args });
  writeProgress(`Starting Codex workflow: ${workflow}`);

  const subprocess = spawn(config.codexBinary, args, {
    cwd: config.runtimeDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timeoutMs = configuredCodexTimeoutMs();
  const startedAt = Date.now();
  const events: CodexEvent[] = [];
  let stdout = "";
  let stderr = "";
  let lineBuffer = "";
  let threadPrinted = false;
  let timedOut = false;
  let interruptedSignal: NodeJS.Signals | undefined;
  let forceKillTimeout: NodeJS.Timeout | undefined;

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const event = parseJsonLine(trimmed);
    if (!event) {
      return;
    }

    events.push(event);
    if (event.type === "thread.started" && typeof event.thread_id === "string" && !threadPrinted) {
      writeProgress(`Codex thread: ${event.thread_id}`);
      threadPrinted = true;
    }

    if (event.type === "error" || event.type === "turn.failed") {
      const message = eventMessage(event);
      if (message) {
        writeProgress(`Codex ${event.type}: ${message}`);
      }
    }
  };

  const flushStdoutChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    stdout += text;
    lineBuffer += text;

    let newlineIndex = lineBuffer.search(/\r?\n/);
    while (newlineIndex >= 0) {
      const line = lineBuffer.slice(0, newlineIndex);
      const newlineLength = lineBuffer[newlineIndex] === "\r" && lineBuffer[newlineIndex + 1] === "\n" ? 2 : 1;
      lineBuffer = lineBuffer.slice(newlineIndex + newlineLength);
      handleLine(line);
      newlineIndex = lineBuffer.search(/\r?\n/);
    }
  };

  const progressInterval = setInterval(() => {
    writeProgress(`Waiting on Codex... ${formatElapsed(Date.now() - startedAt)}`);
  }, PROGRESS_INTERVAL_MS);

  const timeout = setTimeout(() => {
    timedOut = true;
    writeProgress(`Codex workflow timed out after ${formatElapsed(timeoutMs)}; terminating child process.`);
    subprocess.kill("SIGTERM");
    forceKillTimeout = setTimeout(() => {
      if (subprocess.exitCode === null) {
        subprocess.kill("SIGKILL");
      }
    }, 5_000);
  }, timeoutMs);

  const handleSignal = (signal: NodeJS.Signals): void => {
    interruptedSignal = signal;
    writeProgress(`Received ${signal}; terminating Codex workflow.`);
    subprocess.kill(signal);
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  const result = await new Promise<CodexCommandResult>((resolve, reject) => {
    subprocess.stdout?.on("data", flushStdoutChunk);
    subprocess.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    subprocess.once("error", reject);
    subprocess.once("exit", (exitCode) => {
      if (lineBuffer.trim()) {
        handleLine(lineBuffer);
      }

      resolve({
        stdout,
        stderr,
        exitCode,
        events,
        timedOut,
      });
    });
  }).finally(() => {
    clearInterval(progressInterval);
    clearTimeout(timeout);
    if (forceKillTimeout) {
      clearTimeout(forceKillTimeout);
    }
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  });

  if (interruptedSignal) {
    throw new Error(`Codex workflow ${workflow} was interrupted by ${interruptedSignal}.`);
  }

  if (result.exitCode !== 0 || result.timedOut) {
    logger?.error("Codex command failed", {
      args,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
      timedOut: result.timedOut,
    });
  }

  return result;
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

  const result = await runCodexCommand(config, options.workflow, args, logger);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(formatCodexFailure(options.workflow, result));
  }

  const events = result.events.length > 0 ? result.events : parseJsonLines(result.stdout);
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
