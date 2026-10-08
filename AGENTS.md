# Agents: read the operating rules first

Before any merge, tag, publish, deploy, export or visibility change in this repository, read
`%DF_AGENT_OPS%\README.md` (`$DF_AGENT_OPS/README.md` on macOS and Linux). It names the production
branch for this repo, the gates, the identity rules and the release runbook.

If `DF_AGENT_OPS` is unset or the path does not exist, stop and ask the repository owner before
releasing anything. Do not infer the rules from this file or from memory.

Branch work, tests and reviews need no gate. Releases do.
