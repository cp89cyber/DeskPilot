import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { ensureDeskPilotDirectories, templatePath } from "../config.js";
import {
  ensureCodexInstalled,
  ensureCodexLoggedIn,
  ensureGoogleBrowserAvailable,
  ensureWorkspaceMcpRegistered,
  ensureWorkspaceServerBuilt,
  registerWorkspaceMcpServer,
  resolvedGoogleBrowserDetails,
} from "../prereqs.js";
import { createBaseContext } from "../runtime.js";

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Initialize DeskPilot home directories and register the local MCP server.")
    .action(async () => {
      const context = createBaseContext();
      const { config, logger } = context;

      ensureDeskPilotDirectories(config);
      await ensureCodexInstalled(config);
      await ensureCodexLoggedIn(config);
      await ensureWorkspaceServerBuilt(config);
      let browser:
        | {
            executablePath: string;
            profileDir: string;
          }
        | undefined;
      if (config.googleMode === "browser") {
        ensureGoogleBrowserAvailable(config);
        browser = resolvedGoogleBrowserDetails(config);
      }

      const runtimeAgentsSource = templatePath(config, path.join("templates", "runtime-AGENTS.md"));
      const runtimeAgentsTarget = path.join(config.runtimeDir, "AGENTS.md");
      fs.copyFileSync(runtimeAgentsSource, runtimeAgentsTarget);

      const alreadyRegistered = await ensureWorkspaceMcpRegistered(config);
      if (!alreadyRegistered) {
        await registerWorkspaceMcpServer(config);
        logger.info("Registered DeskPilot MCP server");
      }

      console.log("DeskPilot setup complete.");
      console.log(`Home: ${config.deskpilotHome}`);
      console.log(`Runtime instructions: ${runtimeAgentsTarget}`);
      console.log(`Google mode: ${config.googleMode}`);
      if (browser) {
        console.log(`Chrome: ${browser.executablePath}`);
        console.log(`Browser profile: ${browser.profileDir}`);
      }
      console.log(
        alreadyRegistered
          ? `MCP server '${config.mcpServerName}' already registered.`
          : `MCP server '${config.mcpServerName}' registered.`,
      );
    });
}
