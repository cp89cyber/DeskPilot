import { Command, InvalidArgumentError } from "commander";

import {
  DEFAULT_INBOX_MAX_RESULTS,
  DEFAULT_INBOX_QUERY,
  MAX_INBOX_MAX_RESULTS,
  triageInbox,
} from "../inbox/triage.js";
import { createRuntimeContext } from "../runtime.js";
import { printJson } from "./utils.js";

function parseMaxResults(value: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new InvalidArgumentError("max-results must be a positive integer.");
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("max-results must be a positive integer.");
  }

  return Math.min(parsed, MAX_INBOX_MAX_RESULTS);
}

export function registerInboxCommand(program: Command): void {
  program
    .command("inbox")
    .description("Triage inbox threads and stage draft replies when useful.")
    .option("--query <query>", "Gmail search query", DEFAULT_INBOX_QUERY)
    .option(
      "--max-results <count>",
      `Maximum Gmail threads to inspect, capped at ${MAX_INBOX_MAX_RESULTS}`,
      parseMaxResults,
      DEFAULT_INBOX_MAX_RESULTS,
    )
    .action(async (options: { query: string; maxResults: number }) => {
      const context = await createRuntimeContext();

      const execution = await triageInbox(
        {
          config: context.config,
          repositories: context.repositories,
          logger: context.logger,
        },
        {
          query: options.query,
          maxResults: options.maxResults,
        },
      );

      printJson({
        ...execution.result,
        persistedFollowUps: execution.persistedFollowUps,
        sessionId: execution.sessionId,
        resumed: execution.resumed,
      });
    });
}
