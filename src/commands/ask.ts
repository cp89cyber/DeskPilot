import { Command } from "commander";

import { buildChatPrompt } from "../codex/prompts.js";
import { runWorkflow } from "../codex/runner.js";
import { createRuntimeContext } from "../runtime.js";
import { assertWorkspaceReady } from "./utils.js";

export function registerAskCommand(program: Command): void {
  program
    .command("ask")
    .description("Run an ad-hoc office-work prompt through the DeskPilot Codex session.")
    .argument("<prompt>", "The prompt to send to DeskPilot.")
    .action(async (prompt: string) => {
      const context = createRuntimeContext();
      await assertWorkspaceReady(context.config);

      const result = await runWorkflow(
        context.config,
        context.repositories,
        {
          workflow: "chat",
          prompt: buildChatPrompt(context.config, prompt),
        },
        context.logger,
      );

      console.log(result.finalMessage);
    });
}
