# Deploy Forward — the open capture layer

[![npm version](https://img.shields.io/npm/v/deploy-forward.svg)](https://www.npmjs.com/package/deploy-forward)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/Deploy-Forward/Deploy-Forward/actions/workflows/ci.yml/badge.svg)](https://github.com/Deploy-Forward/Deploy-Forward/actions/workflows/ci.yml)

The tracker, the usage core, and the capture contract behind
[Deploy Forward](https://deployforward.dev): one view of your AI-agent usage across
every model and every harness, and — when you opt in — the public
[Board](https://leaderboard.deployforward.dev).

## What this tool does to your machine — read this first

This CLI reads your local agent session stores (Claude Code, Codex, Grok CLI, pi,
OpenClaw, opencode, Hermes, Copilot CLI, Gemini CLI) and parses them for **counters
and timestamps**. Agent transcripts often sit next to sensitive material, so be
explicit about the risk model before running anything:

- **Local-only commands (`usage`, `serve`) never touch the network.** No account, no
  token, nothing leaves the machine. This is the default way to try it.
- **If you opt in to sync**, the wire carries metadata only: token counts,
  timestamps, model names, durations, and a local repo hash. Never prompts, code,
  file names, working directories, or credentials. That list is not policy prose —
  it is an explicit field whitelist (`toIngest()`) pinned by tests, specified
  field-by-field in [`contract/WIRE.md`](./contract/WIRE.md) and
  [`contract/PRIVACY.md`](./contract/PRIVACY.md).
- **The residual risk is honest**: this is a young project. The client is auditable
  (zero production dependencies, provenance-attested releases you can
  [verify yourself](./SECURITY.md#verify-a-release)); the hosted service is closed
  and you trust its operator. No independent security review has been completed yet
  — see [the review status](#security--privacy-review) below. If your transcripts
  are highly sensitive, read the parsers before you run them, or stay local-only.

## Try it — local first

No account, no network, loopback only. Pinned to an exact version on purpose: an
exact version is what you can audit, and what the provenance attestation signs.

```sh
npx --yes deploy-forward@0.26.3 usage    # per-model table, vendor limit lanes, api-equivalent spend
npx --yes deploy-forward@0.26.3 serve    # the same view as a local web page at 127.0.0.1:4780
```

`npx --yes deploy-forward@latest` is the convenience path — fine once you trust the
release cadence, but a floating tag means tomorrow's code runs with today's consent.
Pin when it matters.

Both surfaces render the same fold and the same limit lanes from one shared seam, so
they can never disagree.

**Want the [Board](https://leaderboard.deployforward.dev)?** That is the optional
step: run `npx --yes deploy-forward@0.26.3` bare and it will show you the capture
contract, then **ask** whether to put this device's usage on the board — GitHub
device-flow sign-in, hooks, and metadata sync happen only after that yes. Declining
keeps everything local; `logout` and `uninstall` fully withdraw consent later.

![The deploy-forward live dashboard: eight harnesses scanned, 15.7B tokens read, $9.2K api-equivalent spend, vendor limit lanes, and the model mix](./.github/assets/super-start.png)

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
nothing — and buys you auditability: you can read exactly what leaves your machine.

## Why this exists

Agentic engineering is a value signal. Tokens routed through a harness and turned into
shipped outcomes are evidence of productivity — most engineers just have no instrument
for it. This is that instrument, and the numbers it reports are checkable: run it,
audit it, fork it. A number you cannot check is a number you should not report.

## How it works

```mermaid
flowchart TB
    subgraph open["YOUR MACHINE — this repository, MIT"]
        direction TB
        logs["Agent session logs<br/>Claude Code · Codex · Grok · pi · OpenClaw<br/>opencode · Hermes · Copilot CLI · Gemini CLI"]
        hooks["Hooks — live presence"]
        cli["deploy-forward CLI<br/>parse locally → active/idle → cumulative session totals"]
        logs --> cli
        hooks --> cli
    end

    cli == "POST /api/ingest — device-token auth<br/>metadata only, never content" ==> ingest

    subgraph closed["THE CLOSED SERVICE — hostile-client assumption"]
        direction TB
        ingest["Ingest — sanity bounds · idempotent upsert"]
        store[("Session store")]
        folds["Server-side folds<br/>day attribution → totals · streaks · Build Score"]
        board["The Board<br/>public leaderboard"]
        ledger["The Ledger<br/>org spend surfaces"]
        ingest --> store --> folds
        folds --> board
        folds --> ledger
    end

    classDef openBox fill:transparent,stroke:#2f9e44,stroke-width:2px
    classDef closedBox fill:transparent,stroke:#868e96,stroke-width:2px,stroke-dasharray:6 4
    class open openBox
    class closed closedBox
```

The bold arrow is the seam, and it is the entire interface: one authenticated POST
carrying counts and timestamps. Everything inside the green box is this repository;
everything in the dashed box is the closed service, which treats every submission as
untrusted input (see [`contract/WIRE.md`](./contract/WIRE.md)).

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
| deployments | Shipped work, outcome-gated: merged PR >> opened PR > commit. |
| efficiency | Deployments per unit input. Tokens and sessions appear ONLY here, in the denominator. |
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

## Security & privacy review

**Status: no independent review yet.** The privacy guarantees above are enforced by
this repository's own tests; what they have not had is outside adversarial scrutiny.
We are seeking a short, focused external review — the scope is published at
[`docs/security-review-scope.md`](./docs/security-review-scope.md) so any reviewer
can start immediately. When a review completes, its date, reviewer, scope, and full
report will be recorded here permanently, findings included. Until then, treat the
claims as what they are: test-pinned, but self-audited.

How to verify what CAN be verified today — the release provenance chain — is in
[SECURITY.md](./SECURITY.md#verify-a-release) and takes about 30 seconds.

## Develop

```sh
cd tracker
npm install
npm run typecheck
npm test            # node --test via tsx; hermetic (DF_* home overrides, temp dirs)
npm run dev         # run the CLI straight from source (tsx bin/df.ts), no build step
npx tsx --test test/usageView.test.ts   # one suite while iterating
```

Point a local build at any server with `DF_API_BASE` (and `DF_APP_BASE` for printed
links); no account is needed for `npm run dev usage` or, after `npm run build`,
`node dist/bin/df.js usage`.

To change a model rate, tier band, or context window: edit `usage-core/src/`, run
`node usage-core/sync.mjs`, and commit what it touched — never edit a `src/core/`
copy (the coreParity test and CI's sync-parity guard both fail on drift; the full
procedure is in [`usage-core/README.md`](./usage-core/README.md)).
The CI in this repo runs the same commands plus three guards: the transcript tripwire
(`scripts/check-no-transcripts.mjs` — no real usage data can ever enter this tree),
usage-core sync parity, and the README pinned-version check
(`scripts/check-readme-version.mjs` — the exact-version install commands above can
never go stale).

## Registries

npmjs is the front door. The same package is mirror-published to GitHub Packages as
`@deploy-forward/deploy-forward` (owner-scoped, as that registry requires). GitHub
Packages needs a token with `read:packages` even for public installs — if you want
it anyway:

```sh
echo "@deploy-forward:registry=https://npm.pkg.github.com" >> ~/.npmrc
npm install @deploy-forward/deploy-forward
```

## Live rates

[`rates/`](./rates/) is the daily model-pricing time series: an always-current
[`observed.json`](./rates/observed.json), one dated snapshot per day under
[`rates/history/`](./rates/history/), and a
[commit ledger](https://github.com/Deploy-Forward/Deploy-Forward/commits/main/rates)
whose diffs show exactly which rates moved and when. Rebuilt and committed
daily by the price-drift workflow from two independent public sources
(LiteLLM, models.dev), agreement-labeled per row. The canonical table stays
hand-verified against vendor pages; this folder is the automated observation
layer — source-attributed by construction, never silently promoted.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) (DCO, tests, the adapter contract). Security
reports: [SECURITY.md](./SECURITY.md).

MIT licensed. "Deploy Forward" the name and the hosted service are not part of the
license grant.
