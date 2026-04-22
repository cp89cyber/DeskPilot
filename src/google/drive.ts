import pdfParse from "pdf-parse";
import { google } from "googleapis";

import type { CacheRepository } from "../storage/repositories.js";
import type { DeskPilotConfig } from "../types/config.js";
import { getAuthenticatedOAuthClient } from "./oauth.js";

const MAX_CONTENT_CHARS = 60_000;

export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export interface DriveFileContent extends DriveFileSummary {
  revision?: string;
  contentText: string;
  truncated: boolean;
}

async function driveClient(config: DeskPilotConfig) {
  const auth = await getAuthenticatedOAuthClient(config);
  return google.drive({ version: "v3", auth });
}

function truncateContent(text: string): { contentText: string; truncated: boolean } {
  if (text.length <= MAX_CONTENT_CHARS) {
    return { contentText: text, truncated: false };
  }

  return {
    contentText: `${text.slice(0, MAX_CONTENT_CHARS)}\n\n[truncated]`,
    truncated: true,
  };
}

async function parsePdfBuffer(buffer: Buffer): Promise<string> {
  const result = await pdfParse(buffer);
  return result.text.trim();
}

async function bufferToText(buffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === "application/pdf") {
    return await parsePdfBuffer(buffer);
  }
  return buffer.toString("utf8").trim();
}

async function downloadFileBytes(
  config: DeskPilotConfig,
  fileId: string,
  mimeType: string,
): Promise<Buffer> {
  const client = await driveClient(config);

  if (mimeType === "application/vnd.google-apps.document") {
    const response = await client.files.export(
      { fileId, mimeType: "text/plain" },
      { responseType: "arraybuffer" },
    );
    return Buffer.from(response.data as ArrayBuffer);
  }

  if (mimeType === "application/vnd.google-apps.spreadsheet") {
    const response = await client.files.export(
      { fileId, mimeType: "text/csv" },
      { responseType: "arraybuffer" },
    );
    return Buffer.from(response.data as ArrayBuffer);
  }

  if (mimeType === "application/vnd.google-apps.presentation") {
    const response = await client.files.export(
      { fileId, mimeType: "application/pdf" },
      { responseType: "arraybuffer" },
    );
    return Buffer.from(response.data as ArrayBuffer);
  }

  const response = await client.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(response.data as ArrayBuffer);
}

export async function searchDriveFiles(
  config: DeskPilotConfig,
  options: { query: string; pageSize?: number },
): Promise<DriveFileSummary[]> {
  const client = await driveClient(config);
  const response = await client.files.list({
    q: options.query,
    pageSize: options.pageSize ?? 5,
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
    includeItemsFromAllDrives: false,
    supportsAllDrives: false,
  });

  return (response.data.files ?? []).map((file) => ({
    id: file.id ?? "",
    name: file.name ?? "(unnamed)",
    mimeType: file.mimeType ?? "application/octet-stream",
    modifiedTime: file.modifiedTime ?? undefined,
    webViewLink: file.webViewLink ?? undefined,
  }));
}

export async function getDriveFile(
  config: DeskPilotConfig,
  cacheRepository: CacheRepository,
  fileId: string,
): Promise<DriveFileContent> {
  const client = await driveClient(config);
  const metadataResponse = await client.files.get({
    fileId,
    fields: "id,name,mimeType,modifiedTime,webViewLink,version,md5Checksum",
    supportsAllDrives: false,
  });

  const metadata = metadataResponse.data;
  const cacheKey = `drive:${fileId}`;
  const revision = metadata.version?.toString() ?? metadata.md5Checksum ?? undefined;
  const cached = cacheRepository.get(cacheKey);

  if (cached && cached.revision === revision) {
    return cached.content as DriveFileContent;
  }

  const mimeType = metadata.mimeType ?? "application/octet-stream";
  const buffer = await downloadFileBytes(config, fileId, mimeType);
  const rawText = await bufferToText(
    buffer,
    mimeType === "application/vnd.google-apps.presentation" ? "application/pdf" : mimeType,
  );
  const { contentText, truncated } = truncateContent(rawText);

  const result: DriveFileContent = {
    id: metadata.id ?? fileId,
    name: metadata.name ?? "(unnamed)",
    mimeType,
    modifiedTime: metadata.modifiedTime ?? undefined,
    webViewLink: metadata.webViewLink ?? undefined,
    revision,
    contentText,
    truncated,
  };

  cacheRepository.upsert({
    cacheKey,
    revision,
    mimeType,
    content: result,
    updatedAt: new Date().toISOString(),
  });

  return result;
}
