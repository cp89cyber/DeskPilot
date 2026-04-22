import { Command } from "commander";

import { buildBriefPrompt } from "../codex/prompts.js";
import { runWorkflow } from "../codex/runner.js";
import { createRuntimeContext } from "../runtime.js";
import type { DailyBriefResult } from "../types/results.js";
import { assertWorkspaceReady, printJson } from "./utils.js";

export function registerBriefCommand(program: Command): void {
  const brief = program.command("brief").description("Daily and contextual briefing workflows.");

  brief
    .command("today")
    .description("Create a daily brief using today's meetings, inbox context, and follow-ups.")
    .action(async () => {
      const context = createRuntimeContext();
      await assertWorkspaceReady(context.config);
      const today = new Date().toISOString().slice(0, 10);

      const result = await runWorkflow(
        context.config,
        context.repositories,
        {
          workflow: "brief",
          prompt: buildBriefPrompt(context.config, today),
        },
        context.logger,
      );

      const structured = result.parsedOutput as DailyBriefResult;
      const persistedFollowUps = context.repositories.followups.upsertMany(structured.followUps);

      printJson({
        ...structured,
        persistedFollowUps: persistedFollowUps.length,
        sessionId: result.sessionId,
        resumed: result.resumed,
      });
    });
}
