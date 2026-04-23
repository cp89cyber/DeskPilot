import { stageGmailDraft } from "../actions/staging.js";
import { buildInboxAnalysisPrompt } from "../codex/prompts.js";
import {
  runWorkflow as defaultRunWorkflow,
  type CodexRunResult,
  type RunWorkflowOutputSchema,
} from "../codex/runner.js";
import {
  schemaPathForInboxAnalysis,
  schemaTextForInboxAnalysis,
  validateInboxAnalysisResult,
  type InboxAnalysisResult,
} from "../codex/schemas.js";
import type { GmailThreadDetail, GmailThreadSummary } from "../google/gmail.js";
import {
  createGoogleWorkspaceProvider,
  type GmailWorkspaceService,
  type GoogleWorkspaceProvider,
} from "../google/provider.js";
import type { Logger } from "../logger.js";
import type { DeskPilotRepositories } from "../storage/repositories.js";
import type { DeskPilotConfig } from "../types/config.js";
import type { InboxTriageResult } from "../types/results.js";

export const DEFAULT_INBOX_QUERY = "in:inbox newer_than:7d";
export const DEFAULT_INBOX_MAX_RESULTS = 10;
export const MAX_INBOX_MAX_RESULTS = 25;
export const INBOX_MESSAGE_BODY_LIMIT = 4000;

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const DISABLE_WORKSPACE_MCP_ARGS = ["-c", "mcp_servers.deskpilot-workspace.enabled=false"];

export interface InboxTriageExecutionResult {
  result: InboxTriageResult;
  persistedFollowUps: number;
  sessionId: string;
  resumed: boolean;
}

export interface InboxTriageDependencies {
  config: DeskPilotConfig;
  repositories: DeskPilotRepositories;
  logger?: Logger;
  provider?: GoogleWorkspaceProvider;
  runWorkflow?: typeof defaultRunWorkflow;
}

interface NormalizedInboxMessage {
  id: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  snippet: string;
  bodyText: string;
  truncated: boolean;
}

interface NormalizedInboxThread {
  threadId: string;
  subject: string;
  from: string;
  snippet: string;
  receivedAt: string;
  participants: string[];
  messages: NormalizedInboxMessage[];
}

interface InboxAnalysisPromptPayload {
  query: string;
  maxResults: number;
  messageBodyLimit: number;
  threads: NormalizedInboxThread[];
}

interface ThreadValidationContext {
  knownThreadIds: Set<string>;
  participantsByThreadId: Map<string, Set<string>>;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function truncateText(value: string, maxLength: number): { text: string; truncated: boolean } {
  if (value.length <= maxLength) {
    return {
      text: value,
      truncated: false,
    };
  }

  return {
    text: value.slice(0, maxLength),
    truncated: true,
  };
}

function extractEmailAddresses(value: string): string[] {
  return Array.from(value.matchAll(EMAIL_PATTERN), (match) => match[0].toLowerCase());
}

function normalizeRawParticipant(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function participantKeys(value: string): string[] {
  const emails = extractEmailAddresses(value);
  if (emails.length > 0) {
    return uniqueSorted(emails);
  }

  return uniqueSorted(
    value
      .split(/[,;]/)
      .map(normalizeRawParticipant)
      .filter(Boolean),
  );
}

function participantsFromHeaders(headers: string[]): string[] {
  return uniqueSorted(headers.flatMap((header) => participantKeys(header)));
}

function normalizeThread(
  summary: GmailThreadSummary | undefined,
  detail: GmailThreadDetail,
): NormalizedInboxThread {
  const messages = detail.messages.map((message) => {
    const body = truncateText(message.bodyText, INBOX_MESSAGE_BODY_LIMIT);
    return {
      id: message.id,
      from: message.from,
      to: message.to,
      cc: message.cc ?? "",
      subject: message.subject,
      date: message.date,
      snippet: message.snippet,
      bodyText: body.text,
      truncated: body.truncated,
    };
  });

  const latest = messages[messages.length - 1];

  return {
    threadId: detail.threadId,
    subject: summary?.subject || latest?.subject || "(no subject)",
    from: summary?.from ?? latest?.from ?? "",
    snippet: summary?.snippet ?? detail.snippet,
    receivedAt: summary?.receivedAt ?? latest?.date ?? "",
    participants: participantsFromHeaders(
      detail.messages.flatMap((message) => [message.from, message.to, message.cc ?? ""]),
    ),
    messages,
  };
}

function normalizeMaxResults(value: number | undefined): number {
  const maxResults = value ?? DEFAULT_INBOX_MAX_RESULTS;
  if (!Number.isInteger(maxResults) || maxResults < 1) {
    throw new Error("Inbox maxResults must be a positive integer.");
  }

  return Math.min(maxResults, MAX_INBOX_MAX_RESULTS);
}

async function fetchInboxThreads(
  gmail: GmailWorkspaceService,
  query: string,
  maxResults: number,
): Promise<NormalizedInboxThread[]> {
  const summaries = (await gmail.listThreads({ query, maxResults })).slice(0, maxResults);
  const summaryByThreadId = new Map(summaries.map((summary) => [summary.threadId, summary]));
  const details = await Promise.all(
    summaries.map(async (summary) => await gmail.getThread(summary.threadId)),
  );

  return details.map((detail) => normalizeThread(summaryByThreadId.get(detail.threadId), detail));
}

function emptyInboxResult(query: string): InboxTriageResult {
  return {
    overview: `No inbox threads matched query "${query}".`,
    urgentThreads: [],
    replyRecommendations: [],
    followUps: [],
    stagedActionIds: [],
    sourceRefs: [],
  };
}

function inboxAnalysisOutputSchema(config: DeskPilotConfig): RunWorkflowOutputSchema {
  return {
    path: schemaPathForInboxAnalysis(config),
    text: schemaTextForInboxAnalysis(config),
    validate: validateInboxAnalysisResult,
  };
}

function threadRef(threadId: string): string {
  return `thread:${threadId}`;
}

function assertKnownThread(
  context: ThreadValidationContext,
  threadId: string,
  location: string,
): void {
  if (!context.knownThreadIds.has(threadId)) {
    throw new Error(`Inbox analysis referenced unknown thread "${threadId}" in ${location}.`);
  }
}

function assertKnownSourceRefs(
  context: ThreadValidationContext,
  sourceRefs: string[],
  location: string,
): void {
  for (const sourceRef of sourceRefs) {
    if (!sourceRef.startsWith("thread:")) {
      throw new Error(`Inbox analysis used invalid sourceRef "${sourceRef}" in ${location}.`);
    }

    const threadId = sourceRef.slice("thread:".length);
    assertKnownThread(context, threadId, `${location}.sourceRefs`);
  }
}

function assertRecipientKnown(
  participants: Set<string>,
  recipient: string,
  location: string,
): void {
  const keys = participantKeys(recipient);
  if (keys.length === 0 || !keys.every((key) => participants.has(key))) {
    throw new Error(`Inbox analysis proposed unknown draft recipient "${recipient}" in ${location}.`);
  }
}

function validationContext(threads: NormalizedInboxThread[]): ThreadValidationContext {
  return {
    knownThreadIds: new Set(threads.map((thread) => thread.threadId)),
    participantsByThreadId: new Map(
      threads.map((thread) => [thread.threadId, new Set(thread.participants)]),
    ),
  };
}

export function validateInboxAnalysis(
  analysis: InboxAnalysisResult,
  threads: NormalizedInboxThread[],
): void {
  const context = validationContext(threads);

  analysis.urgentThreads.forEach((thread, index) => {
    assertKnownThread(context, thread.threadId, `urgentThreads[${index}]`);
  });

  analysis.replyRecommendations.forEach((recommendation, index) => {
    assertKnownThread(context, recommendation.threadId, `replyRecommendations[${index}]`);

    if (!recommendation.draft) {
      return;
    }

    const draftLocation = `replyRecommendations[${index}].draft`;
    if (recommendation.draft.threadId !== recommendation.threadId) {
      throw new Error(
        `Inbox analysis draft thread "${recommendation.draft.threadId}" does not match recommendation thread "${recommendation.threadId}" in ${draftLocation}.`,
      );
    }

    if (recommendation.draft.to.length === 0) {
      throw new Error(`Inbox analysis draft in ${draftLocation} must include at least one recipient.`);
    }

    const participants = context.participantsByThreadId.get(recommendation.threadId);
    if (!participants) {
      throw new Error(`Inbox analysis could not find participants for thread "${recommendation.threadId}".`);
    }

    for (const [recipientIndex, recipient] of [
      ...recommendation.draft.to,
      ...recommendation.draft.cc,
      ...recommendation.draft.bcc,
    ].entries()) {
      assertRecipientKnown(participants, recipient, `${draftLocation}.recipients[${recipientIndex}]`);
    }
  });

  analysis.followUps.forEach((followUp, index) => {
    assertKnownSourceRefs(context, followUp.sourceRefs, `followUps[${index}]`);
  });

  assertKnownSourceRefs(context, analysis.sourceRefs, "sourceRefs");
}

function analysisSourceRefs(analysis: InboxAnalysisResult): string[] {
  return uniqueSorted([
    ...analysis.sourceRefs,
    ...analysis.urgentThreads.map((thread) => threadRef(thread.threadId)),
    ...analysis.replyRecommendations.map((recommendation) => threadRef(recommendation.threadId)),
    ...analysis.followUps.flatMap((followUp) => followUp.sourceRefs),
  ]);
}

function convertAnalysisToPublicResult(
  repositories: DeskPilotRepositories,
  analysis: InboxAnalysisResult,
): InboxTriageResult {
  const stagedActionIds: string[] = [];
  const replyRecommendations = analysis.replyRecommendations.map((recommendation) => {
    const draft = recommendation.draft;
    if (!draft) {
      return {
        threadId: recommendation.threadId,
        recommendation: recommendation.recommendation,
      };
    }

    const sourceRefs = [threadRef(recommendation.threadId)];
    const action = stageGmailDraft(
      repositories.pendingActions,
      {
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        bodyText: draft.bodyText,
        threadId: draft.threadId,
      },
      sourceRefs,
    );
    stagedActionIds.push(action.id);

    return {
      threadId: recommendation.threadId,
      recommendation: recommendation.recommendation,
      stagedActionId: action.id,
    };
  });

  return {
    overview: analysis.overview,
    urgentThreads: analysis.urgentThreads,
    replyRecommendations,
    followUps: analysis.followUps,
    stagedActionIds,
    sourceRefs: analysisSourceRefs(analysis),
  };
}

async function analyzeInboxThreads(
  dependencies: InboxTriageDependencies,
  payload: InboxAnalysisPromptPayload,
): Promise<CodexRunResult> {
  const runWorkflow = dependencies.runWorkflow ?? defaultRunWorkflow;
  return await runWorkflow(
    dependencies.config,
    dependencies.repositories,
    {
      workflow: "inbox",
      prompt: buildInboxAnalysisPrompt(dependencies.config, payload),
      resume: false,
      extraArgs: DISABLE_WORKSPACE_MCP_ARGS,
      outputSchema: inboxAnalysisOutputSchema(dependencies.config),
    },
    dependencies.logger,
  );
}

export async function triageInbox(
  dependencies: InboxTriageDependencies,
  options: {
    query?: string;
    maxResults?: number;
  },
): Promise<InboxTriageExecutionResult> {
  const query = options.query?.trim() || DEFAULT_INBOX_QUERY;
  const maxResults = normalizeMaxResults(options.maxResults);
  const provider =
    dependencies.provider ??
    createGoogleWorkspaceProvider(dependencies.config, {
      cacheRepository: dependencies.repositories.cache,
    });
  const shouldCloseProvider = dependencies.provider === undefined;

  try {
    if (!provider.gmail) {
      throw new Error("Gmail is unavailable for the configured Google workspace provider.");
    }

    const threads = await fetchInboxThreads(provider.gmail, query, maxResults);
    if (threads.length === 0) {
      return {
        result: emptyInboxResult(query),
        persistedFollowUps: 0,
        sessionId: "",
        resumed: false,
      };
    }

    const payload: InboxAnalysisPromptPayload = {
      query,
      maxResults,
      messageBodyLimit: INBOX_MESSAGE_BODY_LIMIT,
      threads,
    };
    const workflowResult = await analyzeInboxThreads(dependencies, payload);
    const analysis = workflowResult.parsedOutput
      ? validateInboxAnalysisResult(workflowResult.parsedOutput)
      : undefined;
    if (!analysis) {
      throw new Error("Codex inbox analysis did not return structured output.");
    }

    validateInboxAnalysis(analysis, threads);
    const result = convertAnalysisToPublicResult(dependencies.repositories, analysis);
    const persistedFollowUps = dependencies.repositories.followups.upsertMany(result.followUps);

    return {
      result,
      persistedFollowUps: persistedFollowUps.length,
      sessionId: workflowResult.sessionId,
      resumed: workflowResult.resumed,
    };
  } finally {
    if (shouldCloseProvider) {
      await provider.close?.().catch(() => undefined);
    }
  }
}
