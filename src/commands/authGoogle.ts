import { Command } from "commander";

import { authenticateGoogle, ensureTokenFilePermissions } from "../google/oauth.js";
import {
  BrowserGoogleSessionManager,
  browserAuthTargets,
  ensureBrowserGoogleAuthenticated,
} from "../google/browser/session.js";
import { createRuntimeContext } from "../runtime.js";

export function registerAuthCommand(program: Command): void {
  const auth = program.command("auth").description("Authentication workflows.");

  auth
    .command("google")
    .description("Authenticate DeskPilot against Google via browser mode or OAuth.")
    .option("--provider <provider>", "Authentication provider (browser or oauth)", "browser")
    .action(async (options: { provider: string }) => {
      const context = createRuntimeContext();
      if (!["browser", "oauth"].includes(options.provider)) {
        throw new Error(
          `Unsupported Google auth provider: ${options.provider}. Use \`browser\` or \`oauth\`.`,
        );
      }

      if (options.provider === "oauth") {
        await authenticateGoogle(context.config);
        ensureTokenFilePermissions(context.config);
        context.logger.info("Google OAuth completed");
        console.log(`Google OAuth tokens stored at ${context.config.googleTokenPath}`);
        return;
      }

      const session = new BrowserGoogleSessionManager(context.config);
      const targets = browserAuthTargets();
      console.log("Opening dedicated Chrome profile for DeskPilot Google browser auth.");
      console.log(`Chrome: ${session.executablePath}`);
      console.log(`Profile: ${session.profileDir}`);
      console.log(`Gmail: ${targets.gmailUrl}`);
      console.log(`Calendar: ${targets.calendarUrl}`);
      console.log("Complete Google sign-in in the opened browser if prompted.");

      try {
        await ensureBrowserGoogleAuthenticated(session);
      } finally {
        await session.close();
      }

      context.logger.info("Google browser auth completed", {
        profileDir: session.profileDir,
      });
      console.log(`Browser profile ready at ${session.profileDir}`);
    });
}
