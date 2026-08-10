# What the deploy-forward hooks are, exactly

If you found `deploy-forward` entries in your Claude Code `settings.json` and want to
know precisely what they do — this is the authoritative answer, and the whole package
is a few readable, dependency-free files you can verify it against.

## What is installed

Four hooks in `~/.claude/settings.json`, one per Claude Code lifecycle event, each
running the same command:

| Event | When it fires | Command |
|---|---|---|
| `SessionStart` | a session opens | `node .../df.js beat --event session_start` |
| `UserPromptSubmit` | you send a message | `node .../df.js beat --event prompt` |
| `Stop` | Claude finishes responding | `node .../df.js beat --event stop` |
| `SessionEnd` | a session closes | `node .../df.js beat --event session_end` |

## What `beat` does (source: `src/hooks.ts`, ~30 lines)

1. **If this device is not paired** (no device token in `~/.config/df/state.json`):
   nothing. It exits immediately.
2. **Sends one presence ping**: an HTTPS POST with `{ tool, event }` — the harness name
   (`claude_code` / `codex` / `grok`) and the event name above. Nothing else is in the
   body. This powers the "building now" ticker.
3. **Maybe spawns a background `sync`** (debounced — only when the last sync is stale).
   Sync reads your local transcripts and uploads **usage metadata only**: token counts,
   model names, timestamps, turn counts, skill/agent *names*, and a locally-HMAC'd repo
   pseudonym. It never reads or transmits your code, your prompts, or file contents —
   the parser extracts exactly the metadata fields and discards everything else.

Hooks never block or print into your Claude session (fire-and-forget, errors ignored).

## What we read about your login (and what we never read)

Claude Code's authentication order puts `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`
**above** your subscription login, so a stray API key silently bills subscription work to
the metered API instead. `npx --yes deploy-forward@latest status` detects your current billing source
and warns you on a silent switch to the metered path.

We detect this by **presence and type only**: whether those env vars are set (a non-empty
string, never their value), whether `~/.claude/.credentials.json` **exists** (a stat, never
a read), and the `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY` flags. We **never** read, parse,
log, hash, upload, or store the credentials file's contents or any key's value — the check
is entirely local and never touches the wire.

## What never leaves your machine

- Prompt or response text, code, file contents, file names.
- Repository names (personal devices upload only an irreversible local HMAC; a plain
  `owner/name` slug is attached **only** if you explicitly enrolled the device in an
  organization, and stops the moment you un-enroll).

## Removing it

```
npx --yes deploy-forward@latest uninstall   # removes the hooks
npx --yes deploy-forward@latest logout      # also revokes this device's token server-side
```

Hand-deleting the `deploy-forward` entries from `settings.json` works too — the
tracker treats that as consent withdrawn and never re-adds hooks without you running
`npx --yes deploy-forward@latest` again.

Full docs: https://leaderboard.deployforward.dev/how#hooks
