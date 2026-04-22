import type { DeskPilotRepositories } from "../storage/repositories.js";
import type { CodexWorkflow, DeskPilotSession } from "../types/config.js";

export function getWorkflowSession(
  repositories: DeskPilotRepositories,
  workflow: CodexWorkflow,
): DeskPilotSession | undefined {
  return repositories.sessions.get(workflow);
}

export function saveWorkflowSession(
  repositories: DeskPilotRepositories,
  workflow: CodexWorkflow,
  codexSessionId: string,
): DeskPilotSession {
  return repositories.sessions.upsert(workflow, codexSessionId);
}
