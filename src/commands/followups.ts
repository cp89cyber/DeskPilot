import { Command } from "commander";

import { createRuntimeContext } from "../runtime.js";
import { printJson } from "./utils.js";

export function registerFollowupsCommand(program: Command): void {
  const followups = program.command("followups").description("Manage locally persisted follow-up items.");

  followups
    .command("list")
    .description("List follow-up items.")
    .option("--status <status>", "Optional status filter")
    .action(async (options: { status?: string }) => {
      const context = await createRuntimeContext();
      printJson(context.repositories.followups.list(options.status));
    });

  followups
    .command("complete")
    .description("Mark a follow-up item as completed.")
    .argument("<id>", "Follow-up ID")
    .action(async (id: string) => {
      const context = await createRuntimeContext();
      const item = context.repositories.followups.complete(id);
      if (!item) {
        throw new Error(`Unknown follow-up ID: ${id}`);
      }
      printJson(item);
    });
}
