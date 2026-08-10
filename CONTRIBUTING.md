# Contributing

## Ground rules

- **DCO, not CLA.** Sign your commits off (`git commit -s`); the
  [Developer Certificate of Origin](https://developercertificate.org/) is the whole
  agreement.
- **The privacy line is non-negotiable.** Metadata only, read-only stores, nothing new
  on the wire without a consent gate. A change that widens what leaves a user's machine
  needs the consent gate designed before the code (see
  [`contract/PRIVACY.md`](./contract/PRIVACY.md)).
- **Real counters only.** Adapters never estimate, smear, or fabricate a count. Missing
  data is absent data.
- **No real transcripts in the tree, ever.** Test fixtures are synthesized in code. CI
  fails the moment a `.jsonl`/`.db`/`.sqlite` file is committed anywhere.

## Running the tests

```sh
cd tracker
npm install
npm run typecheck
npm test          # node --test via tsx; the suite is fast and hermetic
```

Tests never read your real harness directories: every adapter honors a `DF_*` home
override and the suites pin their own temp homes.

## Adding a harness adapter

The bar is the seven-point contract in
[`contract/REGISTRY.md`](./contract/REGISTRY.md): a parser emitting the canonical
session shape, real counters only, a fingerprint gate where collisions are possible, a
hermetic home override, drift counting, a committed eval script, and the privacy line
unchanged. The registry-completeness test (`tracker/test/providers.test.ts`) and the
wire conformance test (`tracker/test/wireConformance.test.ts`) fail until the new
adapter is properly registered.

## Two invariants enforced by tests

| Test | What it holds |
| --- | --- |
| `tracker/test/openBoundary.test.ts` | Shipped code (and `eval/`) imports nothing from outside `tracker/`; npm `files` and tsconfig `exclude` are pinned. |
| `tracker/test/coreParity.test.ts` | `tracker/src/core/` is a byte-identical copy of `usage-core/src/` — edit the canonical source, run `node usage-core/sync.mjs`, never edit a copy. |

## A note on comments

The code began life in a private monorepo and its comments cite internal ticket ids
(D8, W1.5, L14, ...) and internal planning documents. The ids are harmless shorthand
for decisions; where a comment states a rule, the rule is the part that binds. Feel
free to ask what an id meant in an issue — or to send a PR replacing a stale citation
with the rule it stood for.

## Pricing and window data

`usage-core/` changes need provenance: a rate or window edit cites its vendor source
and date in the comment beside it, follows the change procedure in
[`usage-core/README.md`](./usage-core/README.md), and never lands as a bare number.
