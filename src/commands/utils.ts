import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import type { DeskPilotConfig } from "../types/config.js";
import { assertWorkspaceMcpReady } from "../prereqs.js";

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function assertWorkspaceReady(config: DeskPilotConfig): Promise<void> {
  await assertWorkspaceMcpReady(config);
}

export async function confirm(promptText: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${promptText} `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
