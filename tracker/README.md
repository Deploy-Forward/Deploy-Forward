# deploy-forward

One view of your AI-agent usage: every model, every harness, on your machine. And when
you want the work to count in public, the same tool puts you on the Board.

**Supported harnesses (9):** Claude Code, Codex, Grok CLI, pi, OpenClaw, opencode,
Hermes, GitHub Copilot CLI, Gemini CLI.

`deploy-forward` reads the transcripts your coding agents already write locally and
turns them into a usage ledger: tokens by model, sessions, active vs. idle time, spend
at list rates. Metadata only: never your prompts, your code, or your file names. The
local view needs no account:

```sh
npx --yes deploy-forward@latest usage
```

Product: **https://deployforward.dev** · Board: **https://leaderboard.deployforward.dev**

## Why track this

Agentic engineering is a value signal. Tokens routed through a harness and turned into
shipped outcomes are evidence of productivity, the same way merged PRs are; most
engineers just have no instrument for it. This tracker is that instrument: it shows you
what you actually use, across every model and harness, so your effectiveness is
something you can see and improve instead of guess at.

One rule keeps the signal honest: spending more can never raise a rank. Tokens, spend
and sessions appear only as status or in an efficiency denominator, never as points.

## Two products, one tracker

- **The Board** (free, public): the leaderboard at
  https://leaderboard.deployforward.dev. Opt in, verify with GitHub, and your usage and
  outcomes rank you among the humans driving agents. For an individual, the Board
  doubles as your own personal ledger.
- **The Ledger** (for organizations): the managed product for teams. Live
  tokens-to-deployment and spend visibility for engineering and finance leadership.
  Same capture, same privacy contract, behind org auth.

This package is the capture layer both stand on: MIT, metadata-only, either way.

## Get on the Board

No install required — one command does everything (GitHub sign-in, scan, submit,
profile URL):

```sh
npx --yes deploy-forward@latest
```

`@latest` matters: without it, a stale local npx cache can silently keep re-running an
old build for days (a real field bug, root-caused 2026-07-20) — `@latest` steers npx at
the currently-published version every time.

GitHub is the canonical identity: authentication is a browser device flow proven by
OAuth — you never type a username, so identities can't be spoofed. Signing in on the
web later with GitHub resolves to this same account (no duplicate).

## Commands

| Command | What it does |
| --- | --- |
| *(bare)* | GitHub sign-in, scan all harnesses, submit, print your profile URL. |
| `pair` | Pair a **second** machine to your account (typed code; also Teams org enrollment). |
| `start` | Live sync monitor (hooks already sync without it). |
| `sync` | Sync once and exit. |
| `status` | Show auth + how many transcripts are tracked. |
| `usage` | Local per-model usage + session windows (`--by-project`, `--by-day`, `--json`, `--cost`). |
| `logout` | Sign this device out (removes the device token). |
| `uninstall` | Remove the Claude Code presence hooks. |

## What it reads

Metadata only. The tracker reads **token counts, timestamps, model names, and a local
repo hash** from your agent transcripts — **never your code, prompts, or tool inputs**.
The repo hash is an HMAC computed locally with a key that never leaves your machine, so
distinct repositories can be counted without any repo name or URL being sent.

Where each harness is read from (every root honors a `DF_*` environment override):

| Harness | Local store |
| --- | --- |
| **Claude Code** | `~/.claude/projects/**/*.jsonl` |
| **Codex** | `~/.codex/sessions/**/rollout-*.jsonl` |
| **Grok CLI** | `~/.grok` — unified JSONL log + per-session summaries |
| **pi** | `~/.pi` — JSONL session trees |
| **OpenClaw** | OpenClaw state home — `agents/<agent>/sessions/*.jsonl` |
| **opencode** | opencode data dir (XDG-resolved) — SQLite session totals |
| **Hermes** | `%LOCALAPPDATA%\hermes` (Windows) / `~/.hermes` — `state.db` |
| **GitHub Copilot CLI** | `~/.copilot` — `session-store.db` usage events |
| **Gemini CLI** | `~/.gemini` — session chat files |

SQLite stores are opened read-only; token columns and timestamps only, never message
content. Full disclosure of the installed hooks and every byte that can leave your
machine: [HOOKS.md](./HOOKS.md).

## What we read about your login (and what we never read)

Claude Code's authentication order puts `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`
**above** your subscription login — so a stray API key silently converts subscription
work into metered API billing. `npx --yes deploy-forward@latest status` detects your
current billing source and warns you on a silent switch to the metered path.

We detect this by **presence and type only**: whether those env vars are set (a
non-empty string, never their value), whether `~/.claude/.credentials.json` **exists**
(a stat, never a read), and whether the `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY` flags
are set. We **never** read, parse, log, hash, upload, or store the contents of the
credentials file or the value of any key — the whole check is local and nothing about
it goes on the wire.

## Privacy & security

- Device tokens: only a SHA-256 hash is ever persisted server-side.
- GitHub verification is confirmed server-side; the badge can't be self-granted.
- Local state lives in `~/.config/df/state.json` (override with `$DF_HOME`).
- The installed hooks, the full wire payload, and the never-uploaded list are
  documented in [HOOKS.md](./HOOKS.md).

MIT licensed.
