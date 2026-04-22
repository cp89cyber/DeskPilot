import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { ensureDeskPilotDirectories, templatePath } from "../config.js";
import {
  ensureCodexInstalled,
  ensureCodexLoggedIn,
  ensureWorkspaceMcpRegistered,
  ensureWorkspaceServerBuilt,
  registerWorkspaceMcpServer,
} from "../prereqs.js";
import { createRuntimeContext } from "../runtime.js";

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Initialize DeskPilot home directories and register the local MCP server.")
    .action(async () => {
      const context = createRuntimeContext();
      const { config, logger } = context;

      ensureDeskPilotDirectories(config);
      await ensureCodexInstalled(config);
      await ensureCodexLoggedIn(config);
      await ensureWorkspaceServerBuilt(config);

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
      console.log(
        alreadyRegistered
          ? `MCP server '${config.mcpServerName}' already registered.`
          : `MCP server '${config.mcpServerName}' registered.`,
      );
    });
}
