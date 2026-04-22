import { Command } from "commander";

import { authenticateGoogle, ensureTokenFilePermissions } from "../google/oauth.js";
import { createRuntimeContext } from "../runtime.js";

export function registerAuthCommand(program: Command): void {
  const auth = program.command("auth").description("Authentication workflows.");

  auth
    .command("google")
    .description("Authenticate DeskPilot against Google Workspace APIs.")
    .action(async () => {
      const context = createRuntimeContext();
      await authenticateGoogle(context.config);
      ensureTokenFilePermissions(context.config);
      context.logger.info("Google OAuth completed");
      console.log(`Google tokens stored at ${context.config.googleTokenPath}`);
    });
}
