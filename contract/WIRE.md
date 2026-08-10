# The capture wire contract

This document specifies what a Deploy Forward tracker sends to the server, and what the
server does with it. The normative, machine-readable schema is
[`wire.schema.json`](./wire.schema.json); the executable drift guard is
`tracker/test/wireConformance.test.ts`, which validates the reference tracker's actual
output against that schema and proves the schema rejects the documented violations. If
this prose ever disagrees with the schema or the test, the test wins.

The design premise: **the server assumes a hostile client.** Publishing this contract
does not weaken the service, because nothing on the wire is trusted. Counts are bounded
and plausibility-checked server-side, trust labels are server-derived and can never be
asserted by a client, and outcome verification happens against GitHub, not against
claims. What the contract buys is auditability: anyone can read exactly what leaves
their machine.

## Transport

```
POST {apiBase}/ingest
Authorization: Bearer <deviceToken>
Content-Type: application/json
```

- The device token is minted by the pairing/sign-in flow; only a SHA-256 hash of it is
  persisted server-side.
- The reference tracker chunks submissions at 100 sessions per request. The server
  rejects requests with more than 500 sessions outright.
- The payload bytes are the change detector: the tracker hashes each session's exact
  wire projection, and re-uploads only sessions whose projection changed. Optional
  fields are therefore **dropped when absent, never null-filled** — field presence is
  part of the contract.

## Envelope

| Field | Required | Meaning |
| --- | --- | --- |
| `trackerVersion` | yes | Submitting client version, for adapter-drift forensics. |
| `sessions[]` | yes | One entry per captured agent session (schema: `$defs/session`). |
| `unknownModels[]` | no | Consent-gated (default off): tallies of model ids the bundled pricing table cannot price. Never a rate, never a spend. First chunk only. |

## The session record

The full field list, types, and per-field semantics live in the schema; the
load-bearing semantics are:

- **`tool`** — the harness id. The server accepts eleven ids; the reference tracker
  currently emits nine (see [`REGISTRY.md`](./REGISTRY.md)).
- **`toolSessionId`** — the harness's own session id, `^[A-Za-z0-9._:-]{1,128}$`. An id
  outside this charset is a hard reject (it is a storage-path component).
- **`tokens` / `models[]`** — raw counters as the harness recorded them. Adapters never
  estimate, smear, or fabricate a count; a harness that records nothing contributes
  nothing.
- **`thinkingTokens`** — status only: never priced, never summed into output.
- **`repoHash`** — an HMAC of the repo identity under a device-local key that never
  leaves the machine. Distinct repos are countable; no name or URL crosses the wire.
- **`orgRepo`** — only ever present on a device that confirmed org enrollment. This is
  a client-side gate: a non-enrolled tracker never puts a repo name on the wire at all
  ("send it and let the server drop it" is explicitly rejected).
- **`days[]`** — present only when a session's activity touches more than one UTC day;
  real observed atoms clipped at midnights. Slices must sum exactly to the session
  totals or the server discards the whole array.
- **`messageCount: 0`** — a tombstone: the session vanished locally and previously
  submitted data should be treated as withdrawn.
- **`outcomes[]`** — candidate shipped outcomes (merged PR / opened PR / commit):
  identifiers and hashes only, never diffs or code. Self-attested on the wire;
  verification and any scoring weight are derived server-side.
- **`mue`** — the session's context-efficiency summary. Status only, never ranked.

## What the server does

Per session, one of four dispositions, returned in the response:

```
{ accepted, unchanged, flagged, rejected[], attributedOrgs }
```

- **Rejected** (dropped, reason returned): `ended_before_started`,
  `missing_tool_session_id`, `invalid_tool_session_id`.
- **Flagged** (stored, excluded from ranking): sessions failing server-side
  plausibility checks — impossible rates, futures, wall/active inconsistencies,
  implausible token totals, inconsistent day slices, and similar. The specific
  thresholds are deliberately not published; they are anti-abuse surface and can change
  without notice. A flagged session is visible to its owner as status, it just never
  ranks.
- **Unchanged**: byte-identical projection already stored — idempotent re-submission.
- **Accepted**: stored with server-derived fields stamped on top.

Server-derived, never accepted from the wire: the user id, org attribution, day keys,
the trust label, timestamps, and every flag. A client that invents fields cannot
elevate itself: storage is an explicit whitelist, not a spread of the request body.

## Multi-device arbitration

Two devices can observe the same harness session (a laptop and a desktop syncing the
same account). The server arbitrates: records identifying the same captured session
merge by richest-evidence-wins, and a device that saw strictly less than what is stored
never regresses the stored record.

## Trust, in one paragraph

The wire never carries a trust claim. The server stamps `device_verified` on
device-token submissions; GitHub identity verification is proven by OAuth device flow
server-side; outcome verifiability (`verified` vs `self_attested`) is derived by
checking GitHub, not by believing the client. The ladder only moves by server-side
proof.
