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
- Google OAuth client credentials for Gmail, Calendar, and Drive access

This repo was built and verified with:

- Node `v24.13.1`
- npm `11.10.1`
- `codex-cli 0.101.0`

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

## Google OAuth Configuration

DeskPilot reads Google OAuth client configuration from either environment variables
or `~/.deskpilot/config.json`.

### Environment variables

```bash
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
    "clientId": "your-google-client-id",
    "clientSecret": "your-google-client-secret",
    "redirectPort": 8765
  }
}
```

## First-Time Setup

Initialize DeskPilot and register the local MCP server with Codex:

```bash
node dist/cli.js setup
```

This will:

- verify `codex` is installed
- verify Codex is logged in
- create `~/.deskpilot/{runtime,logs}`
- initialize `~/.deskpilot/state.db`
- copy runtime instructions to `~/.deskpilot/runtime/AGENTS.md`
- register the `deskpilot-workspace` MCP server with Codex

Then authenticate against Google:

```bash
node dist/cli.js auth google
```

Tokens are stored at:

```text
~/.deskpilot/google-oauth.json
```

with `0600` permissions.

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
