import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadDeskPilotConfig } from "../../src/config.js";
import { canUseDriveTools } from "../../src/google/provider.js";

const tempDirs: string[] = [];
const originalEnv = {
  DESKPILOT_HOME: process.env.DESKPILOT_HOME,
  DESKPILOT_GOOGLE_MODE: process.env.DESKPILOT_GOOGLE_MODE,
  DESKPILOT_GOOGLE_BROWSER_PATH: process.env.DESKPILOT_GOOGLE_BROWSER_PATH,
  DESKPILOT_GOOGLE_BROWSER_PROFILE_DIR: process.env.DESKPILOT_GOOGLE_BROWSER_PROFILE_DIR,
  DESKPILOT_GOOGLE_CLIENT_ID: process.env.DESKPILOT_GOOGLE_CLIENT_ID,
  DESKPILOT_GOOGLE_CLIENT_SECRET: process.env.DESKPILOT_GOOGLE_CLIENT_SECRET,
  DESKPILOT_GOOGLE_REDIRECT_PORT: process.env.DESKPILOT_GOOGLE_REDIRECT_PORT,
};

function makeTempHome(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskpilot-config-test-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeConfig(homeDir: string, value: unknown): void {
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, "config.json"),
    JSON.stringify(value, null, 2),
    "utf8",
  );
}

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

afterEach(() => {
  restoreEnv("DESKPILOT_HOME");
  restoreEnv("DESKPILOT_GOOGLE_MODE");
  restoreEnv("DESKPILOT_GOOGLE_BROWSER_PATH");
  restoreEnv("DESKPILOT_GOOGLE_BROWSER_PROFILE_DIR");
  restoreEnv("DESKPILOT_GOOGLE_CLIENT_ID");
  restoreEnv("DESKPILOT_GOOGLE_CLIENT_SECRET");
  restoreEnv("DESKPILOT_GOOGLE_REDIRECT_PORT");

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe("loadDeskPilotConfig", () => {
  it("loads nested browser and oauth Google config", () => {
    const homeDir = makeTempHome();
    process.env.DESKPILOT_HOME = homeDir;
    writeConfig(homeDir, {
      model: "gpt-5.4-mini",
      google: {
        mode: "oauth",
        browser: {
          executablePath: "/custom/chrome",
          profileDir: "/tmp/deskpilot-browser",
        },
        oauth: {
          clientId: "nested-client-id",
          clientSecret: "nested-client-secret",
          redirectPort: 9999,
        },
      },
    });

    const config = loadDeskPilotConfig();

    expect(config.googleMode).toBe("oauth");
    expect(config.googleBrowser.executablePath).toBe("/custom/chrome");
    expect(config.googleBrowser.profileDir).toBe("/tmp/deskpilot-browser");
    expect(config.googleOAuthCredentials).toEqual({
      clientId: "nested-client-id",
      clientSecret: "nested-client-secret",
      redirectPort: 9999,
    });
  });

  it("preserves legacy flat oauth config keys", () => {
    const homeDir = makeTempHome();
    process.env.DESKPILOT_HOME = homeDir;
    writeConfig(homeDir, {
      google: {
        clientId: "legacy-client-id",
        clientSecret: "legacy-client-secret",
        redirectPort: 8766,
      },
    });

    const config = loadDeskPilotConfig();

    expect(config.googleMode).toBe("browser");
    expect(config.googleOAuthCredentials).toEqual({
      clientId: "legacy-client-id",
      clientSecret: "legacy-client-secret",
      redirectPort: 8766,
    });
  });

  it("only enables Drive tools in browser mode when OAuth tokens exist", () => {
    const homeDir = makeTempHome();
    process.env.DESKPILOT_HOME = homeDir;
    writeConfig(homeDir, {
      google: {
        mode: "browser",
        oauth: {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectPort: 8765,
        },
      },
    });

    const configWithoutTokens = loadDeskPilotConfig();
    expect(canUseDriveTools(configWithoutTokens)).toBe(false);

    fs.writeFileSync(
      path.join(homeDir, "google-oauth.json"),
      JSON.stringify({ refresh_token: "token" }),
      "utf8",
    );

    const configWithTokens = loadDeskPilotConfig();
    expect(canUseDriveTools(configWithTokens)).toBe(true);
  });
});
