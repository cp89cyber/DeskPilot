import { Command } from "commander";

import { authenticateBrowserProfile } from "../google/browser/auth.js";
import { authenticateGoogle, ensureTokenFilePermissions } from "../google/oauth.js";
import { createBaseContext } from "../runtime.js";

type GoogleAuthProvider = "browser" | "oauth";

function isGoogleAuthProvider(value: string): value is GoogleAuthProvider {
  return value === "browser" || value === "oauth";
}

function modeWarning(provider: GoogleAuthProvider, configMode: GoogleAuthProvider): string {
  const providerLabel = provider === "oauth" ? "OAuth" : "browser mode";
  return [
    `Authenticated with ${providerLabel}, but \`google.mode\` is still \`${configMode}\`.`,
    `DeskPilot commands will keep using ${configMode} mode until you change config.`,
  ].join(" ");
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command("auth").description("Authentication workflows.");

  auth
    .command("google")
    .description("Authenticate DeskPilot against Google via browser mode or OAuth.")
    .option("--provider <provider>", "Authentication provider (browser or oauth)")
    .action(async (options: { provider?: string }) => {
      const context = createBaseContext();
      const provider = options.provider ?? context.config.googleMode;

      if (!isGoogleAuthProvider(provider)) {
        throw new Error(
          `Unsupported Google auth provider: ${provider}. Use \`browser\` or \`oauth\`.`,
        );
      }

      if (provider === "oauth") {
        await authenticateGoogle(context.config);
        ensureTokenFilePermissions(context.config);
        context.logger.info("Google OAuth completed");
        console.log(`Google OAuth tokens stored at ${context.config.googleTokenPath}`);
      } else {
        await authenticateBrowserProfile(context.config);
        context.logger.info("Google browser auth completed", {
          profileDir: context.config.googleBrowser.profileDir,
        });
        console.log(`Browser profile ready at ${context.config.googleBrowser.profileDir}`);
      }

      if (options.provider && provider !== context.config.googleMode) {
        console.warn(modeWarning(provider, context.config.googleMode));
      }
    });
}
