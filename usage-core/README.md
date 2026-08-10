# usage-core

The canonical source for the facts every Deploy Forward surface must agree on:

- `src/pricing.ts` — the model rate table (USD per MTok, by token kind), model-id
  normalization and resolution, spend math, and the dated model tier bands.
- `src/contextWindows.ts` — the model-id to input-context-window registry.

Open (MIT), self-contained, no I/O, and **explicitly no scoring math** — if it ranks,
it lives in the closed service; if it states a public fact about a model, it lives
here. Every consumer carries a byte-identical copy under its own `src/core/`, written
by `node usage-core/sync.mjs` and pinned by that consumer's `coreParity` test. In this
repository the consumer is the tracker CLI (`tracker/src/core/`); the closed service
carries further byte-checked copies and a data-parity guard on its web client, so one
edit here propagates everywhere or CI goes red.

## Changing a rate, band, or window

1. Edit the file under `usage-core/src/` — never a copy. Every value cites its vendor
   source and read-date in the comment beside it; a bare number does not land.
2. `node usage-core/sync.mjs` (targets are discovered — the script syncs whichever
   consumer packages exist in the tree).
3. Commit everything the sync touched; the parity tests fail CI on any drift or
   missed step. (In the private monorepo there is one extra step: mirroring the data
   change into the web client's own pricing module, which keeps separate resolver
   signatures for its live-feed overlay.)

## Why checked-in copies instead of a shared import

The consumer packages deliberately share no workspace machinery — different module
systems, different publish/deploy roots, different tarball allowlists. Copies keep
every existing build, test, publish, and deploy flow byte-for-byte untouched, and the
parity tests make drift impossible rather than unlikely. When this directory ships as
a published package, the copies become imports and the parity tests retire.
