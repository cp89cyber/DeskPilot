# DeskPilot

DeskPilot is a local office-work agent built on top of the OpenAI Codex CLI.
It uses Codex as the execution engine, keeps one resumable session per workflow,
and exposes Gmail, Google Calendar, Google Drive, and local follow-up data to Codex
through a local MCP server.

Version 1 is intentionally:

- CLI-first
- Single-user
- Google Workspace first
- Interactive only
- Draft-first for external writes

Codex never gets direct write tools for Gmail or Calendar. It can only stage actions.
Real external writes happen only when you run `deskpilot actions apply <id>`.

## Features

- `deskpilot inbox` triages recent inbox threads and can stage Gmail drafts
- `deskpilot brief today` builds a daily brief from calendar, inbox, Drive, and follow-ups
- `deskpilot schedule "<request>"` proposes slots and can stage a calendar event
- `deskpilot summarize <path|drive-query>` summarizes local documents or Drive content
- `deskpilot ask "<prompt>"` gives you an ad-hoc DeskPilot/Codex session for office work
- `deskpilot followups ...` manages the local follow-up store
- `deskpilot actions ...` inspects or applies staged external actions

## Requirements

- Node.js 20 or later
- `codex` on your `PATH`
- A Codex login already active on the machine
- Google Chrome available locally for browser-backed Gmail and Calendar access
- Google OAuth client credentials only if you want OAuth mode or Drive access

This repo was built and verified with:

- Node `v24.13.1`
- npm `11.10.1`
- `codex-cli 0.101.0`

Using the same Node binary for `npm install`, `npm run build`, and `node dist/cli.js ...`
is important because `better-sqlite3` is a native addon.

## Install

```bash
npm install
npm run build
```

After building, the CLI entrypoint is:

```bash
node dist/cli.js --help
```

You can also symlink or install it however you normally manage local Node CLIs.

## Google Configuration

DeskPilot defaults to browser mode for Gmail and Calendar. It launches a dedicated
Chrome profile under `~/.deskpilot/browser/google-chrome`, and you sign into Google
there with `deskpilot auth google`.

Drive is still OAuth-backed in this version. If you want Drive tools, or if you prefer
the original API-backed Google integration, configure OAuth credentials and switch
`google.mode` to `oauth`.

### Environment variables

```bash
export DESKPILOT_GOOGLE_MODE="browser"
export DESKPILOT_GOOGLE_BROWSER_PATH="/usr/bin/google-chrome-stable"
export DESKPILOT_GOOGLE_BROWSER_PROFILE_DIR="$HOME/.deskpilot/browser/google-chrome"
export DESKPILOT_GOOGLE_CLIENT_ID="your-google-client-id"
export DESKPILOT_GOOGLE_CLIENT_SECRET="your-google-client-secret"
export DESKPILOT_GOOGLE_REDIRECT_PORT="8765"
```

### Config file

`~/.deskpilot/config.json`

```json
{
  "model": "gpt-5.4",
  "google": {
    "mode": "browser",
    "browser": {
      "executablePath": "/usr/bin/google-chrome-stable",
      "profileDir": "/home/you/.deskpilot/browser/google-chrome"
    },
    "oauth": {
      "clientId": "your-google-client-id",
      "clientSecret": "your-google-client-secret",
      "redirectPort": 8765
    }
  }
}
```

Legacy flat OAuth keys under `google.clientId`, `google.clientSecret`, and
`google.redirectPort` are still supported for backward compatibility.

## First-Time Setup

Initialize DeskPilot and register the local MCP server with Codex:

```bash
node dist/cli.js setup
```

This will:

- verify `codex` is installed
- verify Codex is logged in
- verify Chrome is available for browser mode
- create `~/.deskpilot/{runtime,logs}`
- copy runtime instructions to `~/.deskpilot/runtime/AGENTS.md`
- register the `deskpilot-workspace` MCP server with Codex

`~/.deskpilot/state.db` is created later, the first time you run a command that needs
local persisted state such as `followups`, `actions`, or a workflow command that
stores session history.

Then authenticate against Google:

```bash
node dist/cli.js auth google
```

This opens the dedicated DeskPilot Chrome profile and waits for Gmail and Calendar
to become available in that browser session.

If you want the legacy OAuth flow instead:

```bash
node dist/cli.js auth google --provider oauth
```

OAuth tokens are stored at:

```text
~/.deskpilot/google-oauth.json
```

with `0600` permissions when OAuth is used.

## Troubleshooting

If DeskPilot fails with a `better-sqlite3` / `NODE_MODULE_VERSION` mismatch, check the
active runtime first:

```bash
which node
node -v
```

Install, build, and run DeskPilot with that same `node` binary. Then rebuild the
native addon:

```bash
npm rebuild better-sqlite3
```

If the rebuild still fails, reinstall dependencies under the same active Node version:

```bash
rm -rf node_modules
npm install
```

## Commands

### Core workflows

```bash
node dist/cli.js ask "Draft a concise reply asking for two scheduling options"
node dist/cli.js inbox --query "in:inbox newer_than:7d"
node dist/cli.js brief today
node dist/cli.js schedule "Find 30 minutes with finance next week to review the budget"
node dist/cli.js summarize ./notes/meeting.txt
node dist/cli.js summarize "name contains 'Q2 Plan' and trashed = false"
```

In browser mode without OAuth tokens, Drive query summarization is unavailable and
DeskPilot will tell you to switch to OAuth mode or configure OAuth tokens for Drive.

### Actions

```bash
node dist/cli.js actions list
node dist/cli.js actions show <id>
node dist/cli.js actions apply <id>
```

### Follow-ups

```bash
node dist/cli.js followups list
node dist/cli.js followups complete <id>
```

## Storage And Runtime Layout

DeskPilot stores its local state under `~/.deskpilot`:

```text
~/.deskpilot/
  config.json
  browser/
    google-chrome/
  google-oauth.json
  state.db
  runtime/
    AGENTS.md
  logs/
    deskpilot.log
```

Key behavior:

- SQLite state lives in `~/.deskpilot/state.db`
- Logs stay local in `~/.deskpilot/logs/deskpilot.log`
- Browser-mode Google auth lives in the dedicated Chrome profile under `~/.deskpilot/browser/google-chrome`
- The Codex runtime workspace is `~/.deskpilot/runtime`
- One resumable Codex session is maintained per workflow:
  - `chat`
  - `inbox`
  - `brief`
  - `schedule`
  - `summarize`

## Safety Model

- Gmail writes are draft-only in Codex workflows
- Calendar writes are stage-only in Codex workflows
- Gmail thread IDs, Calendar event IDs, and applied action external IDs are opaque provider-native references
- `deskpilot actions apply <id>` is the only path that actually creates external artifacts
- `deskpilot actions apply <id>` always asks for explicit confirmation
- Follow-up extraction is local-only and safe to persist automatically

## Development

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

The current test suite includes:

- unit tests for SQLite-backed repositories
- unit tests for local document loading
- an integration test that exercises the real MCP tool surface through the SDK client
- a gated E2E placeholder that only runs when `DESKPILOT_E2E=1`
