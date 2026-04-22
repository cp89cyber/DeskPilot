import fs from "node:fs";

import { Command } from "commander";

import { buildSummarizePrompt } from "../codex/prompts.js";
import { runWorkflow } from "../codex/runner.js";
import { readLocalDocument } from "../documents/local.js";
import { canUseDriveTools } from "../google/provider.js";
import { createRuntimeContext } from "../runtime.js";
import type { DocumentSummaryResult } from "../types/results.js";
import { assertWorkspaceReady, printJson } from "./utils.js";

export function registerSummarizeCommand(program: Command): void {
  program
    .command("summarize")
    .description("Summarize a local document or a Google Drive file query.")
    .argument("<target>", "Local file path or Drive search query")
    .action(async (target: string) => {
      const context = await createRuntimeContext();
      await assertWorkspaceReady(context.config);
      const isLocalFile = fs.existsSync(target);

      if (!isLocalFile && !canUseDriveTools(context.config)) {
        throw new Error(
          "Drive search requires OAuth mode in this version. Set `google.mode` to `oauth` or configure OAuth credentials and tokens for Drive access.",
        );
      }

      const prompt = isLocalFile
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
