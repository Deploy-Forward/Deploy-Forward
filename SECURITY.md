# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub security advisories](https://github.com/Deploy-Forward/usage-capture/security/advisories/new)
rather than a public issue. Reports are read by the maintainer; you should hear back
within a few days.

In scope here: anything in this repository — the CLI, the adapters, the hooks, the
wire client, the published contract. Vulnerabilities in the hosted service
(deployforward.dev, the Board, the Ledger) are also welcome through the same channel;
the service code is closed but the operator is the same.

## The threat model, honestly

- **The server assumes a hostile client.** Everything on the wire is untrusted:
  bounded, plausibility-checked, and re-verified server-side. Trust labels are
  server-derived and cannot be asserted by a client. Forged usage cannot buy rank
  (spend and tokens never rank), and outcome verification happens against GitHub.
- **This package executes on user machines** (`npx deploy-forward`). Supply-chain
  integrity therefore matters most: releases are published from CI with provenance,
  the tarball allowlist is pinned by test (`files: ["dist", "HOOKS.md"]`), and the
  runtime has zero production dependencies.
- **Privacy is enforced, not promised.** The wire projection is an explicit whitelist
  pinned by tests; see [`contract/PRIVACY.md`](./contract/PRIVACY.md) and
  [`tracker/HOOKS.md`](./tracker/HOOKS.md). A report that the tracker reads or
  transmits more than those documents claim is a high-severity bug.
