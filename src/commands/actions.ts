import { Command } from "commander";

import { applyPendingAction } from "../actions/apply.js";
import { createRuntimeContext } from "../runtime.js";
import { confirm, printJson } from "./utils.js";

export function registerActionsCommand(program: Command): void {
  const actions = program.command("actions").description("Inspect or apply staged external actions.");

  actions
    .command("list")
    .description("List staged and applied actions.")
    .action(() => {
      const context = createRuntimeContext();
      const items = context.repositories.pendingActions.list().map((action) => ({
        ...action,
        payload: JSON.parse(action.payloadJson) as unknown,
      }));
      printJson(items);
    });

  actions
    .command("show")
    .description("Show a staged action by ID.")
    .argument("<id>", "Action ID")
    .action((id: string) => {
      const context = createRuntimeContext();
      const action = context.repositories.pendingActions.get(id);
      if (!action) {
        throw new Error(`Unknown action ID: ${id}`);
      }

      printJson({
        ...action,
        payload: JSON.parse(action.payloadJson) as unknown,
      });
    });

  actions
    .command("apply")
    .description("Apply a staged action after explicit confirmation.")
    .argument("<id>", "Action ID")
    .action(async (id: string) => {
      const context = createRuntimeContext();
      const action = context.repositories.pendingActions.get(id);
      if (!action) {
        throw new Error(`Unknown action ID: ${id}`);
      }

      console.log(action.previewMarkdown);
      const accepted = await confirm("Apply this action? [y/N]");
      if (!accepted) {
        console.log("Cancelled.");
        return;
      }

      const applied = await applyPendingAction(
        context.config,
        context.repositories.pendingActions,
        action,
        context.logger,
      );

      printJson(applied);
    });
}
