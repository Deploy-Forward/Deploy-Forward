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

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) (DCO, tests, the adapter contract). Security
reports: [SECURITY.md](./SECURITY.md).

MIT licensed. "Deploy Forward" the name and the hosted service are not part of the
license grant.
