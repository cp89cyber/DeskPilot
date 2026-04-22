#!/usr/bin/env node

import { Command } from "commander";

import { registerActionsCommand } from "./commands/actions.js";
import { registerAskCommand } from "./commands/ask.js";
import { registerAuthCommand } from "./commands/authGoogle.js";
import { registerBriefCommand } from "./commands/briefToday.js";
import { registerFollowupsCommand } from "./commands/followups.js";
import { registerInboxCommand } from "./commands/inbox.js";
import { registerScheduleCommand } from "./commands/schedule.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerSummarizeCommand } from "./commands/summarize.js";

const program = new Command();

program
  .name("deskpilot")
  .description("DeskPilot: a Codex-CLI-based office agent")
  .version("0.1.0");

registerSetupCommand(program);
registerAuthCommand(program);
registerAskCommand(program);
registerInboxCommand(program);
registerBriefCommand(program);
registerScheduleCommand(program);
registerSummarizeCommand(program);
registerActionsCommand(program);
registerFollowupsCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
