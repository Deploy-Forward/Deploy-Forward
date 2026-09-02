# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub security advisories](https://github.com/Deploy-Forward/Deploy-Forward/security/advisories/new)
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

## Release provenance

From `0.26.0` forward, every npm release is published by the public workflow
[`.github/workflows/publish-npm.yml`](./.github/workflows/publish-npm.yml) via
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OpenID Connect
— no long-lived npm token exists), and carries a
[SLSA v1 provenance attestation](https://slsa.dev/spec/v1.0/provenance) recording
the exact source commit and workflow run that built it. The workflow itself is in
this repository: what you read is what publishes.

## Verify a release

Thirty seconds, no trust in this document required:

```sh
# 1. The registry's signature + provenance check (npm >= 9.5):
mkdir df-verify && cd df-verify && npm init -y > /dev/null
npm install deploy-forward@0.26.3 --ignore-scripts
npm audit signatures
#    Expect: "1 package has a verified registry signature"
#            "1 package has a verified attestation"

# 2. The attestation itself — which commit, which workflow run:
npm view deploy-forward@0.26.3 dist.attestations
#    Then inspect it rendered: the "Provenance" section on
#    https://www.npmjs.com/package/deploy-forward links the exact
#    GitHub Actions run and source commit.

# 3. What is actually in the tarball (the files allowlist is pinned by test):
npm pack deploy-forward@0.26.3 --dry-run
#    Expect: dist/, HOOKS.md, package.json, README, LICENSE — nothing else.
```

Prefer an exact version over `@latest` for anything sensitive: the attestation signs
a specific artifact, and a pinned install is the one you audited.

## Independent review

No external security or privacy review has been completed yet — stated here so the
absence is explicit rather than implied away. The review we are seeking is scoped in
[`docs/security-review-scope.md`](./docs/security-review-scope.md); qualified
reviewers are welcome to start from that document unprompted. Completed reviews will
be recorded permanently in the README, findings included.
