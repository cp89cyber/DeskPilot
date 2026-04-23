import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { ensureDeskPilotDirectories, templatePath } from "../config.js";
import {
  ensureCodexInstalled,
  ensureCodexLoggedIn,
  ensureGoogleBrowserAvailable,
  ensureWorkspaceServerBuilt,
  repairWorkspaceMcpRegistration,
  resolvedGoogleBrowserDetails,
  smokeTestWorkspaceMcpServer,
} from "../prereqs.js";
import { createBaseContext } from "../runtime.js";
import { assertStorageRuntimeCompatible } from "../storage/bootstrap.js";

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
      await assertStorageRuntimeCompatible();
      await smokeTestWorkspaceMcpServer(config);
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

      const mcpRepair = await repairWorkspaceMcpRegistration(config);
      if (mcpRepair.action !== "unchanged") {
        logger.info(
          mcpRepair.action === "registered"
            ? "Registered DeskPilot MCP server"
            : "Repaired DeskPilot MCP server",
        );
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
        mcpRepair.action === "unchanged"
          ? `MCP server '${config.mcpServerName}' already registered.`
          : `MCP server '${config.mcpServerName}' ${mcpRepair.action}.`,
      );
    });
}
