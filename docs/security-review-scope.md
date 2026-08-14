# External security & privacy review — scope

This document exists so a qualified reviewer can start immediately, with the exact
questions we want adversarial answers to. It is published before any review has
happened; the current status is stated honestly in
[SECURITY.md](../SECURITY.md#independent-review).

## Why this review matters

The `deploy-forward` CLI parses local AI-agent session stores — files that routinely
sit next to secrets, proprietary code, and sensitive paths. The privacy claims
(metadata-only wire, explicit field whitelist, never prompts/code/filenames) are
currently enforced by this repository's own tests. Necessary, but self-audited. The
purpose of this review is independent adversarial verification of those claims, with
the report published in full regardless of findings.

## In scope — the four questions

### 1. What do the parsers actually read?

The nine harness adapters (`tracker/src/jsonl.ts`, `codex.ts`, `grok.ts`, `pi.ts`,
`openclaw.ts`, `opencode.ts`, `hermes.ts`, `copilot.ts`, `gemini.ts`) walk home
directories and parse JSONL and SQLite stores. Verify:

- Adapters extract counters, ids, and timestamps only — no message bodies, no file
  paths beyond the store's own location, no prompt or response text retained in any
  reachable state.
- SQLite stores are opened read-only and queries never touch content columns.
- Malformed or adversarial store content (crafted JSONL lines, hostile SQLite
  schemas) cannot cause content to be read into wire-reachable structures, and
  cannot escape the parser (path traversal via ids, injection via model names).

### 2. Is `toIngest()` a complete whitelist under adversarial inputs?

`tracker/src/sync.ts`'s `toIngest()` is the single wire projection — the claim is
that nothing reaches the network except its explicit field list. Verify:

- No code path around it: every network write flows through the projection.
- No smuggling through it: free-text-ish fields (model ids, skill names, error
  notes) cannot carry transcript content placed there by a hostile local store.
- The tests pinning it (`tracker/test/` — `sync`, `byoInvariant`, wire-conformance
  suites) actually cover the adversarial cases, not just the happy path.

### 3. Credential, cwd, and prompt leakage paths

- The billing-source detection is presence-and-type only (env var existence, file
  `stat`) — confirm no code path reads credential values, and none can leak into
  errors, logs, or the wire.
- `cwd` and context-occupancy are local-only fields — confirm the pin holds on
  every path (including `usage --by-project`, `serve`'s `/data.json`, and hooks).
- The opt-in Claude limits fetch reads a vendor OAuth token: confirm it goes only
  to the vendor's own API, is never logged, and never appears in error messages.

### 4. HMAC and device-token handling

- Repo identity: HMAC under a device-local key. Confirm the key never leaves the
  machine, the HMAC is not reversible to repo names in practice, and the
  org-enrollment exception (plain `owner/name` slug) fires only after confirmed
  enrollment on that device.
- Device tokens: minted via GitHub device flow; server persists a SHA-256 hash
  only. Confirm client-side storage, transmission, and the `logout`/`setup-token`
  paths do not widen exposure.

## Out of scope

- The closed service's internals (ranking, folding, org surfaces). Its ingest
  boundary behavior as observable from this client IS in scope. Vulnerabilities
  found in the hosted service anyway are welcome through
  [the same private channel](../SECURITY.md#reporting-a-vulnerability).
- Denial-of-service against the hosted service.
- The marketing site.

## Materials

- Wire contract: [`contract/WIRE.md`](../contract/WIRE.md),
  [`contract/wire.schema.json`](../contract/wire.schema.json)
- Privacy guarantees: [`contract/PRIVACY.md`](../contract/PRIVACY.md)
- Per-hook byte-level disclosure: [`tracker/HOOKS.md`](../tracker/HOOKS.md)
- Test suite: `cd tracker && npm install && npm test` (hermetic — `DF_*` home
  overrides, temp dirs; no real stores touched)
- Release provenance chain: [SECURITY.md](../SECURITY.md#verify-a-release)

## Deliverable

A written report: findings with severity, reproduction steps where applicable, and
an explicit statement per scope question (verified / verified-with-findings / not
verifiable). We publish the report in full — including minor findings — and record
the review's date, reviewer, and scope permanently in the README.

To discuss scope or timing: open a GitHub issue, or use the private advisory
channel for anything sensitive.
