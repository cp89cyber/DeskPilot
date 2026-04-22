import { Command } from "commander";

import { buildSchedulePrompt } from "../codex/prompts.js";
import { runWorkflow } from "../codex/runner.js";
import { createRuntimeContext } from "../runtime.js";
import type { SchedulePlanResult } from "../types/results.js";
import { assertWorkspaceReady, printJson } from "./utils.js";

export function registerScheduleCommand(program: Command): void {
  program
    .command("schedule")
    .description("Plan a meeting, propose slots, and optionally stage an event.")
    .argument("<request>", "Natural-language scheduling request")
    .action(async (request: string) => {
      const context = createRuntimeContext();
      await assertWorkspaceReady(context.config);

      const result = await runWorkflow(
        context.config,
        context.repositories,
        {
          workflow: "schedule",
          prompt: buildSchedulePrompt(context.config, request),
        },
        context.logger,
      );

      const structured = result.parsedOutput as SchedulePlanResult;
      if (structured.needsClarification) {
        console.log(structured.clarifyingQuestion ?? "More information is required.");
        return;
      }

      printJson({
        ...structured,
        sessionId: result.sessionId,
        resumed: result.resumed,
      });
    });
}
