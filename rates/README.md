# Model rates — the daily time series

The model pricing Deploy Forward supports, observed every day against two
independent public sources and committed here by
[the price-drift workflow](../.github/workflows/price-drift.yml). Nothing in
this folder is hand-edited.

| File | What it is |
| --- | --- |
| [`observed.json`](./observed.json) | The always-current snapshot: every canonical model id with its canonical rate, the LiteLLM observation, the models.dev observation (native vendor only — reseller rows are excluded), fetch timestamps, and a per-row `agreement` label. |
| [`history/`](./history/) | One dated snapshot per day, append-only — the time series as plain files. |
| [`series.json`](./series.json) | Per-model canonical-rate CHANGE points (prices are step functions) — the compact price-over-time series the [rates page](https://deployforward.dev/rates/) charts. Recorded from first observation onward; never a retroactive backfill. |
| [Commit history](https://github.com/Deploy-Forward/Deploy-Forward/commits/main/rates) | The same series as a ledger: each day's commit subject carries the date and agreement counts, and each diff shows exactly which rates moved. |

## How to read `agreement`

- `all-agree` — both sources match the canonical table.
- `sources-disagree` — LiteLLM and models.dev disagree with each other; trust neither until the vendor page settles it.
- `drifts-from-canonical` — the sources agree with each other but not with our table; a drift issue is filed the same day.
- `unobserved` — neither source lists the id; the canonical rate stands on its hand-verified vendor citation alone.

## The provenance rule

The canonical table ([`usage-core/src/pricing.ts`](../usage-core/src/pricing.ts))
— the one that actually prices your usage — is hand-verified against each
vendor's own pricing page, and only humans edit it. This folder is the
automated observation layer around it: fresh daily, source-attributed,
and never silently promoted. Aggregators mislabel (a reseller's 1.1×-marked-up
claude-opus-5 row is deliberately excluded by the native-vendor lookup), so a
vendor page always outranks anything you read here.
