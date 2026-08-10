# Harness registry

The adapters the reference tracker ships, their capture formats, and their verification
status. The registry in code is `tracker/src/providers.ts` (`PROVIDERS`) — that table
is the authority; this page explains it. A parser without a registry row is a contract
violation, enforced by `tracker/test/providers.test.ts`.

## Supported harnesses (9 parsed)

| Id | Harness | Format | Fingerprint gate | Eval status |
| --- | --- | --- | --- | --- |
| `claude_code` | Claude Code | JSONL, one file per session + subagent trees | none needed (owns its dir) | **corpus-verified** |
| `codex` | Codex | JSONL rollouts, cumulative token snapshots | none needed (owns its dir) | **corpus-verified** |
| `grok` | Grok CLI | unified JSONL log + per-session summaries (two-source join) | yes (shares `~/.grok` with a fork) | **corpus-verified** |
| `openclaw` | OpenClaw | JSONL session transcripts | yes | **corpus-verified** |
| `copilot` | GitHub Copilot CLI | SQLite usage events (per-turn grain) | yes | **corpus-verified** |
| `pi` | pi | JSONL session trees | yes | committed, not yet corpus-run |
| `opencode` | opencode | SQLite session totals | yes | committed, not yet corpus-run |
| `hermes` | Hermes | SQLite `state.db` | yes | committed, not yet corpus-run |
| `gemini` | Gemini CLI | whole-file JSON sessions | yes | committed, not yet corpus-run |

"Corpus-verified" means the committed eval script under `tracker/eval/` has been run
against a real local corpus and reconciled by hand. "Committed, not yet corpus-run"
means the parser is derived from documentation or a single real store and its eval is
the publish bar still owed — the adapter runs, but its numbers carry that caveat
honestly rather than a false badge.

Two more ids are server-accepted but not parsed by this tracker: `cursor`
(specified, adapter not shipped) and `vscode` (time-only signal). The server's accepted
set is the schema's `tool` enum.

## The adapter contract

Every adapter, present or future, meets the same bar:

1. **A parser module** that emits the canonical session shape (see
   [`WIRE.md`](./WIRE.md)) — counters and timestamps the harness actually recorded.
2. **Real counters only.** No estimation, no smearing, no fabrication. Missing data is
   absent data.
3. **A fingerprint gate** wherever a directory could be occupied by a format-colliding
   non-official tool; ungated only where the harness owns its directory outright.
4. **A hermetic home override** (`DF_*` env var) so tests and users can point the
   scanner anywhere.
5. **Drift counting.** The parser counts lines/rows it claims to understand but could
   not parse; the shared threshold (more than 5% unknown AND more than 20 lines) turns
   silent format drift into a loud health warning.
6. **A committed eval script** — a reconciliation of the parser against a real corpus,
   run before the adapter's numbers are treated as publishable.
7. **The privacy line holds unchanged** ([`PRIVACY.md`](./PRIVACY.md)): metadata only,
   read-only stores, nothing new on the wire without a consent gate.

## Adding a harness

Add the parser in `tracker/src/`, add its `PROVIDERS` row, meet the seven points above,
and extend the conformance test's tool list. The registry-completeness test fails until
the row exists; the wire schema's `tool` enum is a server-side change and lands first
(server before tracker, so an unknown tool id is never silently mislabeled).
