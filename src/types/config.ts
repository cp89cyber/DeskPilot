export type CodexWorkflow = "chat" | "inbox" | "brief" | "schedule" | "summarize";

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  redirectPort: number;
}

export interface DeskPilotConfigFile {
  model?: string;
  google?: Partial<GoogleCredentials>;
}

export interface DeskPilotConfig {
  repoRoot: string;
  deskpilotHome: string;
  runtimeDir: string;
  logsDir: string;
  dbPath: string;
  googleTokenPath: string;
  configFilePath: string;
  model: string;
  codexBinary: string;
  mcpServerName: string;
  googleCredentials?: GoogleCredentials;
}

export interface DeskPilotSession {
  workflow: CodexWorkflow;
  codexSessionId: string;
  lastUsedAt: string;
}
