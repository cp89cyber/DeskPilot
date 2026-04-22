import { google, type gmail_v1 } from "googleapis";

import { getAuthenticatedOAuthClient } from "./oauth.js";
import type { DeskPilotConfig } from "../types/config.js";
import type { GmailDraftPayload } from "../types/actions.js";

export interface GmailThreadSummary {
  threadId: string;
  subject: string;
  from: string;
  snippet: string;
  receivedAt: string;
}

export interface GmailMessageDetail {
  id: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  date: string;
  bodyText: string;
  snippet: string;
}

export interface GmailThreadDetail {
  threadId: string;
  snippet: string;
  historyId?: string;
  messages: GmailMessageDetail[];
}

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  const match = headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase());
  return match?.value ?? "";
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) {
    return "";
  }

  if (part.parts && part.parts.length > 0) {
    const plain = part.parts
      .map((child) => extractBody(child))
      .find((text) => text.length > 0);
    if (plain) {
      return plain;
    }
  }

  const data = part.body?.data;
  if (!data) {
    return "";
  }

  const decoded = decodeBase64Url(data);
  if (part.mimeType === "text/html") {
    return stripHtml(decoded);
  }
  return decoded.trim();
}

async function gmailClient(config: DeskPilotConfig) {
  const auth = await getAuthenticatedOAuthClient(config);
  return google.gmail({ version: "v1", auth });
}

export async function listGmailThreads(
  config: DeskPilotConfig,
  options?: { query?: string; maxResults?: number },
): Promise<GmailThreadSummary[]> {
  const client = await gmailClient(config);
  const result = await client.users.threads.list({
    userId: "me",
    q: options?.query,
    maxResults: options?.maxResults ?? 10,
  });

  const threadIds = (result.data.threads ?? [])
    .map((thread) => thread.id)
    .filter((threadId): threadId is string => Boolean(threadId));

  const threads = await Promise.all(threadIds.map(async (threadId) => await getGmailThread(config, threadId)));
  return threads.map((thread) => {
    const latest = thread.messages[thread.messages.length - 1];
    return {
      threadId: thread.threadId,
      subject: latest?.subject ?? "(no subject)",
      from: latest?.from ?? "",
      snippet: thread.snippet,
      receivedAt: latest?.date ?? "",
    };
  });
}

export async function getGmailThread(
  config: DeskPilotConfig,
  threadId: string,
): Promise<GmailThreadDetail> {
  const client = await gmailClient(config);
  const result = await client.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });

  const messages = (result.data.messages ?? []).map((message) => {
    const headers = message.payload?.headers ?? [];
    return {
      id: message.id ?? "",
      from: headerValue(headers, "From"),
      to: headerValue(headers, "To"),
      cc: headerValue(headers, "Cc") || undefined,
      subject: headerValue(headers, "Subject"),
      date: headerValue(headers, "Date"),
      bodyText: extractBody(message.payload),
      snippet: message.snippet ?? "",
    };
  });

  return {
    threadId,
    snippet: result.data.snippet ?? "",
    historyId: result.data.historyId ?? undefined,
    messages,
  };
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function mimeMessage(payload: GmailDraftPayload): string {
  const lines = [
    `To: ${payload.to.join(", ")}`,
    payload.cc && payload.cc.length > 0 ? `Cc: ${payload.cc.join(", ")}` : undefined,
    payload.bcc && payload.bcc.length > 0 ? `Bcc: ${payload.bcc.join(", ")}` : undefined,
    `Subject: ${payload.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    "",
    payload.bodyText,
  ].filter((line): line is string => Boolean(line));

  return lines.join("\r\n");
}

export async function createGmailDraft(config: DeskPilotConfig, payload: GmailDraftPayload) {
  const client = await gmailClient(config);
  const result = await client.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        threadId: payload.threadId,
        raw: encodeBase64Url(mimeMessage(payload)),
      },
    },
  });

  return {
    id: result.data.id ?? "",
    threadId: result.data.message?.threadId ?? payload.threadId ?? "",
  };
}
