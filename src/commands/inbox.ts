import { Command } from "commander";

import { buildInboxPrompt } from "../codex/prompts.js";
import { runWorkflow } from "../codex/runner.js";
import { createRuntimeContext } from "../runtime.js";
import type { InboxTriageResult } from "../types/results.js";
import { printJson, assertWorkspaceReady } from "./utils.js";

export function registerInboxCommand(program: Command): void {
  program
    .command("inbox")
    .description("Triage inbox threads and stage draft replies when useful.")
    .option("--query <query>", "Gmail search query", "in:inbox newer_than:7d")
    .action(async (options: { query: string }) => {
      const context = await createRuntimeContext();
      await assertWorkspaceReady(context.config);

      const result = await runWorkflow(
        context.config,
        context.repositories,
        {
          workflow: "inbox",
          prompt: buildInboxPrompt(context.config, options.query),
        },
        context.logger,
      );

      const structured = result.parsedOutput as InboxTriageResult;
      const persistedFollowUps = context.repositories.followups.upsertMany(structured.followUps);

      printJson({
        ...structured,
        persistedFollowUps: persistedFollowUps.length,
        sessionId: result.sessionId,
        resumed: result.resumed,
      });
    });
}
