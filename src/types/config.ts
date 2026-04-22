export type CodexWorkflow = "chat" | "inbox" | "brief" | "schedule" | "summarize";

export type GoogleMode = "browser" | "oauth";

export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
  redirectPort: number;
}

export interface GoogleBrowserConfig {
  executablePath?: string;
  profileDir: string;
}

export interface DeskPilotConfigFile {
  model?: string;
  google?: {
    mode?: GoogleMode;
    browser?: Partial<GoogleBrowserConfig>;
    oauth?: Partial<GoogleOAuthCredentials>;
    clientId?: string;
    clientSecret?: string;
    redirectPort?: number;
  };
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
  googleMode: GoogleMode;
  googleBrowser: GoogleBrowserConfig;
  googleOAuthCredentials?: GoogleOAuthCredentials;
}

export interface DeskPilotSession {
  workflow: CodexWorkflow;
  codexSessionId: string;
  lastUsedAt: string;
}
