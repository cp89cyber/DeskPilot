import fs from "node:fs";
import path from "node:path";

import pdfParse from "pdf-parse";

const MAX_CONTENT_CHARS = 60_000;

export interface LocalDocumentContent {
  sourceLabel: string;
  extractedText: string;
}

function truncate(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_CONTENT_CHARS)}\n\n[truncated]`;
}

function assertTextLike(buffer: Buffer): void {
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048));
  if (sample.includes(0)) {
    throw new Error("Unsupported binary file. DeskPilot v1 supports local text and PDF files.");
  }
}

export async function readLocalDocument(filePath: string): Promise<LocalDocumentContent> {
  const absolutePath = path.resolve(filePath);
  const buffer = fs.readFileSync(absolutePath);
  const extension = path.extname(absolutePath).toLowerCase();

  let extractedText: string;
  if (extension === ".pdf") {
    const parsed = await pdfParse(buffer);
    extractedText = parsed.text.trim();
  } else {
    assertTextLike(buffer);
    extractedText = buffer.toString("utf8").trim();
  }

  return {
    sourceLabel: absolutePath,
    extractedText: truncate(extractedText),
  };
}
