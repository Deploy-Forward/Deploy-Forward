# Privacy guarantees

What the tracker reads, what can leave your machine, and what can never leave it. These
are engineering guarantees, pinned by tests in the open source, not policy prose. The
per-hook disclosure (what each installed hook does, byte by byte) is
[`tracker/HOOKS.md`](../tracker/HOOKS.md).

## The one-line version

**Metadata only.** Token counts, timestamps, model names, durations, and a local repo
hash. Never your prompts, never your code, never your file names, never your working
directories, never your credentials.

## Never on the wire

Enforced by the wire projection itself (`toIngest()` is an explicit field whitelist)
and pinned by tests:

| Item | Guarantee |
| --- | --- |
| Prompt / response text | Never read into the wire shape at all. |
| Code, diffs, file contents, file names | Same — adapters parse counters and timestamps, not content. |
| Working directories (`cwd`) | Local-only field; used for your own `usage --by-project` labels. Pinned to never survive the wire projection. |
| Context-window occupancy | Local-only (your `usage` view); pinned like `cwd`. |
| Repo names / URLs | Replaced by an HMAC under a device-local key that never leaves the machine. Exception: an org-**enrolled** device sends the normalized `owner/name` slug — and only after confirmed enrollment, gated client-side. |
| Credentials | The billing-source check is presence-and-type only: env vars checked for existence (never their value), the credentials file gets a `stat`, never a read. Nothing about it goes on the wire. |
| User-typed model rates (`df pricing set`) and any spend derived from them | Local-only, pinned by test (`byoInvariant`): no ingest payload ever carries a user rate or a user-rate-derived spend. |
| Skill/agent arguments or bodies | Only normalized names and counts ship; never arguments or content. |

## Consent gates

Everything that widens the wire is opt-in and off by default:

- **Unknown-model share**: tallies of unpriced model ids (id, tool, count — never a
  rate) ship only when explicitly enabled.
- **Claude limits view**: reading Claude's own usage-limit lanes requires explicit
  opt-in; the OAuth token is read-only, goes only to `api.anthropic.com`, and is never
  logged or embedded in errors.
- **Org enrollment**: the `orgRepo` slug appears only after a confirmed enrollment
  action on that device.
- **Withdrawal**: `logout` removes the device token; `uninstall` removes the hooks;
  hand-deleting the hook entries counts as consent withdrawn. A session that disappears
  locally tombstones (`messageCount: 0`) so the server treats prior data as withdrawn.

## How stores are read

- JSONL transcripts are parsed for counters and timestamps; unrecognized content is
  counted (drift health), never uploaded.
- SQLite stores (opencode, Hermes, Copilot CLI) are opened **read-only**; queries touch
  token columns, ids, and timestamps — never message bodies.
- Real counters only: an adapter that cannot find a numeric count skips the entry and
  counts it as drift. Nothing is ever estimated into the wire.

## Server side

- Device tokens: only a SHA-256 hash is persisted.
- Trust labels are server-derived; the wire cannot assert them (see
  [`WIRE.md`](./WIRE.md)).
- The server stores an explicit whitelist of fields — unexpected fields in a request
  body are dropped, not stored.
