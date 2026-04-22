import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import { execa } from "execa";
import { google } from "googleapis";

import { writeJsonFileSecure } from "../config.js";
import type { DeskPilotConfig } from "../types/config.js";

interface StoredTokenShape {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string | null;
  token_type?: string | null;
  expiry_date?: number | null;
}

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.readonly",
];

function requireCredentials(config: DeskPilotConfig) {
  if (!config.googleCredentials) {
    throw new Error(
      `Google OAuth credentials are missing. Set DESKPILOT_GOOGLE_CLIENT_ID and DESKPILOT_GOOGLE_CLIENT_SECRET, or write them to ${config.configFilePath}.`,
    );
  }
  return config.googleCredentials;
}

function redirectUriForPort(port: number): string {
  return `http://127.0.0.1:${port}/oauth2/callback`;
}

function loadStoredTokens(config: DeskPilotConfig): StoredTokenShape | undefined {
  if (!fs.existsSync(config.googleTokenPath)) {
    return undefined;
  }

  return JSON.parse(fs.readFileSync(config.googleTokenPath, "utf8")) as StoredTokenShape;
}

function persistTokens(config: DeskPilotConfig, nextTokens: StoredTokenShape): void {
  const existing = loadStoredTokens(config) ?? {};
  writeJsonFileSecure(config.googleTokenPath, {
    ...existing,
    ...nextTokens,
    refresh_token: nextTokens.refresh_token ?? existing.refresh_token ?? null,
  });
}

function createOAuthClient(config: DeskPilotConfig) {
  const credentials = requireCredentials(config);
  return new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
    redirectUriForPort(credentials.redirectPort),
  );
}

function toGoogleCredentials(tokens: StoredTokenShape) {
  return {
    access_token: tokens.access_token ?? undefined,
    refresh_token: tokens.refresh_token ?? undefined,
    scope: tokens.scope ?? undefined,
    token_type: tokens.token_type ?? undefined,
    expiry_date: tokens.expiry_date ?? undefined,
  };
}

async function openBrowser(url: string): Promise<void> {
  let command: string;
  let args: string[];

  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  await execa(command, args, {
    reject: false,
    stdio: "ignore",
  });
}

async function waitForOAuthCode(port: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const server = http.createServer((request, response) => {
      try {
        const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
        const code = requestUrl.searchParams.get("code");
        const error = requestUrl.searchParams.get("error");

        if (error) {
          response.writeHead(400, { "Content-Type": "text/plain" });
          response.end(`Google OAuth failed: ${error}`);
          server.close();
          reject(new Error(`Google OAuth failed: ${error}`));
          return;
        }

        if (!code) {
          response.writeHead(400, { "Content-Type": "text/plain" });
          response.end("Missing OAuth code.");
          server.close();
          reject(new Error("Google OAuth callback did not include a code."));
          return;
        }

        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("DeskPilot Google authentication complete. You can return to the terminal.");
        server.close();
        resolve(code);
      } catch (error) {
        server.close();
        reject(error);
      }
    });

    server.listen(port, "127.0.0.1");
    server.setTimeout(120_000, () => {
      server.close();
      reject(new Error("Timed out waiting for the Google OAuth callback."));
    });
  });
}

export async function authenticateGoogle(config: DeskPilotConfig): Promise<void> {
  const credentials = requireCredentials(config);
  const client = createOAuthClient(config);
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    redirect_uri: redirectUriForPort(credentials.redirectPort),
  });

  console.log("Opening browser for Google authentication...");
  console.log(authUrl);
  await openBrowser(authUrl);

  const code = await waitForOAuthCode(credentials.redirectPort);
  const tokenResponse = await client.getToken(code);
  client.setCredentials(tokenResponse.tokens);
  persistTokens(config, tokenResponse.tokens);
}

export async function getAuthenticatedOAuthClient(config: DeskPilotConfig) {
  const client = createOAuthClient(config);
  const tokens = loadStoredTokens(config);

  if (!tokens) {
    throw new Error(
      `Google OAuth tokens not found. Run \`deskpilot auth google\` first. Expected ${config.googleTokenPath}.`,
    );
  }

  client.setCredentials(toGoogleCredentials(tokens));
  client.on("tokens", (nextTokens) => {
    persistTokens(config, nextTokens);
  });

  await client.getAccessToken();
  return client;
}

export function hasStoredGoogleTokens(config: DeskPilotConfig): boolean {
  return fs.existsSync(config.googleTokenPath);
}

export function ensureTokenFilePermissions(config: DeskPilotConfig): void {
  if (fs.existsSync(config.googleTokenPath)) {
    fs.mkdirSync(path.dirname(config.googleTokenPath), { recursive: true });
    fs.chmodSync(config.googleTokenPath, 0o600);
  }
}
