# Deploy Forward — the open capture layer

The tracker, the usage core, and the capture contract behind
[Deploy Forward](https://deployforward.dev): one view of your AI-agent usage across
every model and every harness, and — when you opt in — the public
[Board](https://leaderboard.deployforward.dev).

**View it live: https://deployforward.dev**

```sh
npx --yes deploy-forward@latest usage
```

## What's in this repository

| Directory | What it is |
| --- | --- |
| [`tracker/`](./tracker/) | The `deploy-forward` npm CLI: nine harness adapters, hooks integration, the local usage/spend view, sync. Start at its [README](./tracker/README.md). |
| [`usage-core/`](./usage-core/) | The canonical pricing table, tier bands, context windows, and spend math — dated, provenance-commented, versioned. |
| [`contract/`](./contract/) | The capture standard: the [wire schema](./contract/wire.schema.json), [wire semantics](./contract/WIRE.md), [privacy guarantees](./contract/PRIVACY.md), and the [harness registry + adapter contract](./contract/REGISTRY.md). |

## The boundary

> If it runs on your machine and captures or labels usage, it is **open** — this
> repository, MIT. If it ranks, folds, attributes, alerts, or serves an org surface, it
> is the **closed service**. The seam is the capture contract: counts only, labeled
> verifiability, explicit consent.

The server assumes a hostile client, so publishing the client costs the service
nothing — and buys you auditability: you can read exactly what leaves your machine
(spoiler: token counts, timestamps, model names, durations, and a local repo hash;
never your prompts, code, or file names).

## Why this exists

Agentic engineering is a value signal. Tokens routed through a harness and turned into
shipped outcomes are evidence of productivity — most engineers just have no instrument
for it. This is that instrument, and the numbers it reports are checkable: run it,
audit it, fork it. A number you cannot check is a number you should not report.

## How it works

```
Your machine: agent session logs (Claude Code, Codex, Grok, pi, OpenClaw,
              opencode, Hermes, Copilot CLI, Gemini CLI) + hooks for live presence
        |
   deploy-forward CLI   parse logs locally -> active/idle -> POST cumulative session totals
        |  (device-token auth; metadata only, never content)
        v
============================== the open/closed seam ==============================
        v
   the service's /api/ingest   sanity bounds + idempotent upsert -> session store
        |
        v
   server-side folds   day attribution -> user totals, streaks, Build Score
        v
   the Board (public leaderboard) and the Ledger (org spend surfaces)
```

Everything above the seam is this repository; everything below it is the closed
service, which treats every submission as untrusted input (see
[`contract/WIRE.md`](./contract/WIRE.md)).

Eleven tool ids are accepted by the service (the wire schema's `tool` enum):
`claude_code`, `codex`, `grok`, `cursor`, `vscode`, `pi`, `openclaw`, `opencode`,
`hermes`, `copilot`, `gemini` — an unrecognized id is never trusted raw. Local
adapters live one per harness in `tracker/src/` (`codex.ts`, `grok.ts`, `pi.ts`,
`openclaw.ts`, `opencode.ts`, `hermes.ts`, `copilot.ts`, `gemini.ts`), with Claude
Code handled by `jsonl.ts`. Cursor has no local adapter: its lane imports the
vendor's own account export, because local Cursor token data is unreliable.
`vscode` is a time-only signal from a separate extension.

## Build Score, and why spending can't buy it

The Board's live ranking is a four-axis counterbalanced composite (the full
methodology is published on the Board itself):

| Axis | What it measures |
| --- | --- |
| outcomes | Shipped work, outcome-gated: merged PR >> opened PR > commit. |
| efficiency | Outcomes per unit input. Tokens and sessions appear ONLY here, in the denominator. |
| quality | PR merge ratio plus a small review signal. Spamming junk PRs lowers it. |
| consistency | Sustained building (streak and active days), saturating. |

Each axis saturates through a cohort-free curve, so a score is meaningful from your
first session. The anti-tokenmaxxing property is structural, not a policy: volume
only ever sits in a denominator, so spending more can only lower a score. The
scoring math itself is server-side and deliberately not in this repository — the
boundary rule above.

## Integrity

The server assumes a hostile client. Submissions pass sanity bounds (active time can
never exceed wall-clock, token rates and daily totals have plausibility ceilings,
sessions can't roll back), upserts are idempotent so no duplicate inflates a total,
implausible sessions are flagged and excluded from ranking without being mutated,
and one GitHub identity maps to one verified account through a transactional lock.
Trust is a ladder (`self_reported` → `device_verified` → `otel_verified` →
`github_verified`) that only server-side proof can climb — the wire cannot assert
it. Exact thresholds are intentionally unpublished; the dispositions and semantics
are in [`contract/WIRE.md`](./contract/WIRE.md).

## Develop

```sh
cd tracker
npm install
npm run typecheck
npm test            # node --test via tsx; hermetic (DF_* home overrides, temp dirs)
```

Point a local build at any server with `DF_API_BASE` (and `DF_APP_BASE` for printed
links); no account is needed for `node dist/bin/df.js usage` after `npm run build`.
The CI in this repo runs the same commands plus two guards: the transcript tripwire
(`scripts/check-no-transcripts.mjs` — no real usage data can ever enter this tree)
and usage-core sync parity.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) (DCO, tests, the adapter contract). Security
reports: [SECURITY.md](./SECURITY.md).

MIT licensed. "Deploy Forward" the name and the hosted service are not part of the
license grant.
