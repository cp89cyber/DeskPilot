import fs from "node:fs";

import { Command } from "commander";

import { buildSummarizePrompt } from "../codex/prompts.js";
import { runWorkflow } from "../codex/runner.js";
import { readLocalDocument } from "../documents/local.js";
import { createRuntimeContext } from "../runtime.js";
import type { DocumentSummaryResult } from "../types/results.js";
import { assertWorkspaceReady, printJson } from "./utils.js";

export function registerSummarizeCommand(program: Command): void {
  program
    .command("summarize")
    .description("Summarize a local document or a Google Drive file query.")
    .argument("<target>", "Local file path or Drive search query")
    .action(async (target: string) => {
      const context = createRuntimeContext();
      await assertWorkspaceReady(context.config);

      const prompt = fs.existsSync(target)
        ? buildSummarizePrompt(context.config, {
            kind: "local-document",
            ...(await readLocalDocument(target)),
          })
        : buildSummarizePrompt(context.config, {
            kind: "drive-query",
            query: target,
          });

      const result = await runWorkflow(
        context.config,
        context.repositories,
        {
          workflow: "summarize",
          prompt,
        },
        context.logger,
      );

      const structured = result.parsedOutput as DocumentSummaryResult;
      printJson({
        ...structured,
        sessionId: result.sessionId,
        resumed: result.resumed,
      });
    });
}
