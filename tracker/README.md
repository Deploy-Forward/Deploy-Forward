# deploy-forward

One view of your AI-agent usage: every model, every harness, on your machine. And when
you want the work to count in public, the same tool puts you on the Board.

```sh
npx --yes deploy-forward@latest usage
```

Product: **https://deployforward.dev** · Board: **https://leaderboard.deployforward.dev**

![The deploy-forward live dashboard: eight harnesses scanned, 15.7B tokens read, $9.2K api-equivalent spend, vendor limit lanes, and the model mix](https://raw.githubusercontent.com/Deploy-Forward/Deploy-Forward/main/.github/assets/super-start.png)

## Supported sources

`deploy-forward` reads the session logs your coding agents already write locally —
metadata only: token counts, timestamps, model names, durations. Never your prompts,
code, or file names.

| Source | Local store (every root honors a `DF_*` override) | Parser verification |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | corpus-verified |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | corpus-verified |
| Grok CLI | `~/.grok` — unified JSONL log + per-session summaries | corpus-verified |
| OpenClaw | OpenClaw state home — `agents/<agent>/sessions/*.jsonl` | corpus-verified |
| GitHub Copilot CLI | `~/.copilot` — `session-store.db` usage events | corpus-verified |
| pi | `~/.pi` — JSONL session trees | eval committed |
| opencode | opencode data dir (XDG-resolved) — SQLite session totals | eval committed |
| Hermes | `%LOCALAPPDATA%\hermes` (Windows) / `~/.hermes` — `state.db` | eval committed |
| Gemini CLI | `~/.gemini` — JSON session files | eval committed |

One command reads every detected source into one report. SQLite stores are opened
read-only; "corpus-verified" means the committed eval script under `eval/` has been
reconciled by hand against real data (see [the harness registry](https://github.com/Deploy-Forward/Deploy-Forward/blob/main/contract/REGISTRY.md)).

## Installation

No install needed — run it straight from the registry (`@latest` matters: a stale npx
cache can silently re-run an old build for days):

```sh
# npm
npx --yes deploy-forward@latest

# alternative package runners
bunx deploy-forward
pnpm dlx deploy-forward
```

## Usage

```sh
# Local usage views (no account needed)
# Same data, your choice of surface: `usage` in the terminal, `serve` in the browser.
npx --yes deploy-forward@latest usage               # per-model totals + session windows
npx --yes deploy-forward@latest usage --by-day      # per-day totals, last 30 days
npx --yes deploy-forward@latest usage --by-project  # per-project token attribution
npx --yes deploy-forward@latest usage --json        # any view as a JSON array
npx --yes deploy-forward@latest usage --cost        # EST COST column at public list prices
npx --yes deploy-forward@latest serve               # the same view as a local web page (127.0.0.1)

# Price a model the bundled table doesn't know (local only, never uploaded)
npx --yes deploy-forward@latest pricing set <model> --input <usd> --output <usd>
npx --yes deploy-forward@latest pricing list
npx --yes deploy-forward@latest pricing unset <model>

# The Board (opt-in, GitHub-verified)
npx --yes deploy-forward@latest            # first run: create/link account; then dashboard + live monitor
npx --yes deploy-forward@latest board      # open your board in the browser
npx --yes deploy-forward@latest pair       # pair a second machine (also Teams org enrollment)

# Live + health
npx --yes deploy-forward@latest start        # live sync monitor (hooks already sync without it)
npx --yes deploy-forward@latest super-start  # full-screen animated showcase (--light, --static, --redact)
npx --yes deploy-forward@latest sync         # sync once and exit
npx --yes deploy-forward@latest status       # auth, hooks, adapter drift health, billing source
npx --yes deploy-forward@latest settings     # board, billing, limits, privacy toggles

# Leave cleanly
npx --yes deploy-forward@latest logout       # remove this device's token
npx --yes deploy-forward@latest uninstall    # remove the Claude Code presence hooks
```

## Features

- **Unified nine-source report** — Claude Code, Codex, Grok, pi, OpenClaw, opencode,
  Hermes, Copilot CLI, and Gemini CLI in one view; per-model, per-day, per-project,
  and per-session-window breakdowns.
- **api-equivalent cost** — `usage --cost` prices raw token counts at public list
  rates: what this work would cost if the labs charged per use. Subscription plans
  are a caveat on the label, never a silent discount.
- **Cache-aware token accounting** — cache creation and cache reads tracked
  separately from fresh input; thinking/reasoning tokens tracked as status, never
  summed into output and never priced.
- **Bring-your-own rates** — `pricing set` prices models the bundled table doesn't
  know; your rates and any spend derived from them stay on your machine (pinned by
  test).
- **Limit lanes** — vendor-reported usage limits where the harness exposes them
  (Claude session/weekly lanes, opt-in; Codex rate-limit windows), so you can see
  when to switch harness or model before the wall.
- **Billing-source warning** — `status` detects a stray `ANTHROPIC_API_KEY` silently
  converting subscription work into metered API billing (presence-and-type check
  only; values are never read).
- **Adapter drift health** — parsers count what they claim to understand but could
  not parse; a format change in any harness turns into a loud warning, never a
  silent zero.
- **JSON everything** — every usage view exports structured JSON for your own
  tooling.
- **Local web dashboard** — `deploy-forward serve` renders the same usage, spend,
  and limit data as a brand-clean page on `127.0.0.1` (loopback only, zero
  external asset loads, re-read from disk on every refresh).
- **The Board, opt-in** — GitHub device-flow identity (no typed usernames, so no
  spoofing), server-verified outcomes, and a rank that spending can never buy:
  tokens and sessions only ever appear in an efficiency denominator.
- **Privacy as an engineering guarantee** — the wire projection is an explicit field
  whitelist pinned by tests; the full per-hook disclosure is [HOOKS.md](./HOOKS.md)
  and the capture contract is [published](https://github.com/Deploy-Forward/Deploy-Forward/tree/main/contract).

## Roadmap

- **Beyond the terminal** — the locally-hosted browser view shipped as
  `deploy-forward serve`. Next: your notch and a system-tray service — the same
  usage, spend, and limit data on always-glanceable surfaces, same privacy
  posture. Coming soon.
- **Remaining-usage bars for every limit lane** — Claude's 5-hour and weekly lanes
  currently render as text (window opened / resets at); they should carry the same
  percent-used bar the Codex and Grok weekly lanes already have.

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

- Metadata only: never prompts, code, file names, or working directories. The repo
  hash is an HMAC under a device-local key that never leaves your machine.
- Device tokens: only a SHA-256 hash is ever persisted server-side.
- GitHub verification is confirmed server-side; the badge can't be self-granted.
- Local state lives in `~/.config/df/state.json` (override with `$DF_HOME`).
- The installed hooks, the full wire payload, and the never-uploaded list:
  [HOOKS.md](./HOOKS.md) and [contract/PRIVACY.md](https://github.com/Deploy-Forward/Deploy-Forward/blob/main/contract/PRIVACY.md).

MIT licensed.
