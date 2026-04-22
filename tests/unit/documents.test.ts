import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readLocalDocument } from "../../src/documents/local.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe("readLocalDocument", () => {
  it("reads plain text files", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskpilot-doc-"));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, "notes.txt");
    fs.writeFileSync(filePath, "Prepare agenda\nConfirm attendees\n");

    const result = await readLocalDocument(filePath);

    expect(result.sourceLabel).toBe(path.resolve(filePath));
    expect(result.extractedText).toContain("Prepare agenda");
    expect(result.extractedText).toContain("Confirm attendees");
  });
});
