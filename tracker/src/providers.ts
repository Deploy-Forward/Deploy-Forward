/**
 * Provider registry + drift-health rule — W1.5 of docs/harness-adapters-implementation.md
 * (spec: docs/harness-adapters-spec.md §5.1–5.2).
 *
 * REGISTRY (spec §5.1, documentation-as-code): ONE table naming every provider the
 * tracker parses — id, display name, home resolver, fingerprint gate, format tag,
 * eval script, min known-good tool version. Adding a harness = adding a row here AND
 * meeting the adapter contract (spec §2). No unregistered parsing: if a parser exists
 * in src/ it has a row, and status/health reporting iterates THIS table, never a
 * hand-maintained list in bin/df.ts.
 *
 * Deliberately NOT a scan loop: sync.ts's per-provider blocks keep provider-specific
 * idioms (Claude's corpus-wide dedup fold, Codex's per-file cursors, Grok's single-log
 * cursor, pi's per-file-check/whole-corpus-fold split) that resist a uniform iteration.
 * The registry is the authoritative documentation + the health-reporting surface; the
 * capture blocks stay hand-shaped where the formats demand it.
 *
 * DRIFT RULE (spec §5.2): strict parsers count unknown/unparsed lines per scan
 * (unknownLines / totalLines); isDriftSuspected() is the ONE threshold both surfaces
 * (status + monitor) share, so they can never disagree about what "suspected" means.
 *
 * Counting coverage per provider (recorded gaps, not hidden):
 *   - pi: STRONG — parse failures AND unrecognized top-level `type` values both count
 *     (pi documents its full entry-type universe, so an unknown type IS drift).
 *   - grok: TARGETED — among candidate inference lines (the `shell.turn.inference_done`
 *     records we claim to understand), parse failures / renamed token fields / bad
 *     timestamps count. Known caveat in grok.ts: pre-token-logging builds (< ~0.2.8x)
 *     emit inference lines without token fields and land in this counter too.
 *   - claude_code / codex: WEAK (recorded gap) — only lines that fail JSON.parse count.
 *     Both formats are internal/undocumented with an open-ended entry-type universe, so
 *     an unrecognized type is normal, not drift — counting it would warn constantly on
 *     healthy corpora. A field RENAME inside valid JSON (the Grok Task->Agent lesson)
 *     is therefore INVISIBLE to these two counters; their rename guard remains the eval
 *     scripts below plus the server-side plausibility gates, until a documented schema
 *     exists to validate against.
 *   - openclaw: STRONG for its scoped signal — a JSON.parse failure AND an unrecognized
 *     `transcript_events.type` both count (the documented entry-type universe, same
 *     idiom as pi); an assistant `usage` object present but missing input/output (the
 *     totalTokens-only case) counts too. NOT counted: an `entry_json` enrichment miss
 *     (a `session_entries` row that fails to parse for `spawnedCwd`) — that degrades
 *     cwd attribution, not token drift, so it stays out of this ratio.
 *   - opencode / hermes: session-ROW grain, not lines (units named `unknownLines`/
 *     `totalLines` only for structural parity with the JSONL adapters' vocabulary). A
 *     session row whose token columns are NULL/non-numeric counts; a WHOLE db file that
 *     fails to open or query is a separate, stronger signal (`readFailures`/
 *     `unavailable` for opencode, `skipReason` for hermes) — never folded into this
 *     ratio, so a single locked database can't be mistaken for a format drift.
 *   - copilot: EVENT-row grain (assistant_usage_events, one row per model/tool
 *     round-trip) — finer than opencode/hermes's session grain because Copilot's schema
 *     actually exposes per-atom tokens+timestamps. A row with a missing session_id,
 *     unparseable created_at, or non-numeric input/output tokens counts and is dropped
 *     entirely; a whole-db open/query failure is the separate, stronger `skipReason`
 *     signal (never folded into this ratio), same split as hermes.
 *
 * LOCAL-ONLY (spec §7.3 default): drift counters live in TrackerState on this machine
 * and are read by `status` and the monitor. Nothing here goes on the wire.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeProjectRoots } from "./sync.js";
import { grokHome, isOfficialGrokCli } from "./grok.js";
import { piHome, isOfficialPiCli } from "./pi.js";
import { openclawHome, isOfficialOpenClawCli } from "./openclaw.js";
import { opencodeHome, isOfficialOpencodeHome } from "./opencode.js";
import { hermesHome, isOfficialHermesCli } from "./hermes.js";
import { copilotHome, isOfficialCopilotCli } from "./copilot.js";
import { geminiHome, isOfficialGeminiCli } from "./gemini.js";
import type { ToolName } from "./types.js";

/** One scan's drift counters for one provider (the spec §5.2 contract). */
export interface ScanHealth {
  provider: ToolName;
  /** Lines the parser claims to understand but could not (see per-provider coverage above). */
  unknownLines: number;
  /** Every line the counter's denominator covers (provider-specific — see above). */
  totalLines: number;
}

export interface ProviderManifest {
  /** Wire tool id — MUST stay a member of ToolName / the server's VALID_TOOLS. */
  id: ToolName;
  /** Human name for status/monitor lines. */
  display: string;
  /** Local artifact root(s), env overrides honored — where a scan actually reads. */
  home: () => string | string[];
  /**
   * Official-tool fingerprint gate, or null where none exists: Claude Code and Codex
   * own their config dirs outright (no known format-colliding fork), so their scans
   * are ungated by design, not by omission.
   */
  fingerprint: (() => boolean) | null;
  /** On-disk format tag (documentation, not dispatch). */
  format: string;
  /**
   * Committed live-corpus eval script (the pre-publish bar for this adapter), or null
   * where none exists YET — a null here is a release gate owed, never "not needed".
   */
  evalScript: string | null;
  /**
   * Oldest tool version whose transcripts the parser is known-good against, or null
   * when the transcript carries no derivable version / no floor is established.
   */
  minKnownGoodVersion: string | null;
}

export const PROVIDERS: readonly ProviderManifest[] = [
  {
    id: "claude_code",
    display: "Claude Code",
    home: () => claudeProjectRoots(),
    fingerprint: null,
    format: "jsonl (one file per session + nested subagent trees)",
    evalScript: "eval/reconcile-ccusage.mjs",
    minKnownGoodVersion: null,
  },
  {
    id: "codex",
    display: "Codex",
    home: () => process.env.DF_CODEX_SESSIONS ?? join(homedir(), ".codex", "sessions"),
    fingerprint: null,
    format: "jsonl rollouts (one file per session, cumulative token snapshots)",
    evalScript: "eval/codex-ground-truth.mjs",
    minKnownGoodVersion: null,
  },
  {
    id: "grok",
    display: "Grok",
    home: () => grokHome(), // grokHome() already resolves DF_GROK_HOME — no second env read
    fingerprint: isOfficialGrokCli,
    format: "unified jsonl log + per-session summary/events dirs (two-source join)",
    // Committed 2026-07-14 (the 2026-07-10 audit had run ad hoc, uncommitted — a gap
    // owed to spec §5.3). Grok's counter is blind to a marker rename (denominator =
    // candidate lines); the script's marker-vanish check is the ONLY guard for it.
    evalScript: "eval/grok-audit.mjs",
    // Token logging shipped in a ~0.2.8x build (grok.ts header); earlier transcripts
    // carry inference lines with no token fields — "no data", never estimated.
    minKnownGoodVersion: "0.2.8",
  },
  {
    id: "pi",
    display: "pi",
    home: () => piHome(), // piHome() already resolves DF_PI_HOME — no second env read
    fingerprint: isOfficialPiCli,
    format: "jsonl session trees under --cwd-- dirs (one file per session)",
    // Script committed (W1.6); its RUN against the W1.0 real corpus is the wave's
    // publish gate. Committed-but-unrun means: docs-derived, unpublishable.
    evalScript: "eval/pi-audit.mjs",
    minKnownGoodVersion: null,
  },
  {
    id: "openclaw",
    display: "OpenClaw",
    home: () => openclawHome(), // openclawHome() already resolves DF_OPENCLAW_HOME — no second env read
    fingerprint: isOfficialOpenClawCli,
    // Re-based onto JSONL 2026-07-14: the SQLite/database-first premise was disproved
    // against a real 2026.7.1 corpus (no transcript_events table exists on a real
    // install) -- see src/openclaw.ts's header for the verified finding.
    format: "jsonl session transcripts (agents/<agentId>/sessions/<uuid>.jsonl; .trajectory.jsonl sidecars excluded)",
    // Script committed (W2); RUN against a real corpus 2026-07-14 (W2.4) -- 3 real
    // sessions, numbers reconciled by hand. See src/openclaw.ts's header.
    evalScript: "eval/openclaw-audit.mjs",
    // Verified against exactly ONE real version (2026.7.1, 2026-07-14) -- a single
    // data point asserts no floor; left null rather than overclaiming a range.
    minKnownGoodVersion: null,
  },
  {
    id: "opencode",
    display: "opencode",
    home: () => opencodeHome(), // opencodeHome() already resolves DF_OPENCODE_HOME — no second env read
    fingerprint: isOfficialOpencodeHome,
    format: "sqlite (session table cumulative totals only; message table id/session_id/timestamps, never data)",
    // Script committed (W3); its RUN against a real corpus is the Marco-gated
    // publish bar. Committed-but-unrun means: docs-derived, unpublishable.
    evalScript: "eval/opencode-audit.mjs",
    minKnownGoodVersion: null,
  },
  {
    id: "hermes",
    display: "Hermes",
    home: () => hermesHome(), // hermesHome() already resolves DF_HERMES_HOME — no second env read
    fingerprint: isOfficialHermesCli,
    format: "sqlite (state.db: sessions session-grain totals + messages per-message timestamps, never content)",
    // Script committed (W3); its RUN against a real corpus is the Marco-gated
    // publish bar. Committed-but-unrun means: docs-derived, unpublishable.
    evalScript: "eval/hermes-audit.mjs",
    minKnownGoodVersion: null,
  },
  {
    id: "copilot",
    display: "GitHub Copilot CLI",
    home: () => copilotHome(), // copilotHome() already resolves DF_COPILOT_HOME — no second env read
    fingerprint: isOfficialCopilotCli,
    format: "sqlite (session-store.db: assistant_usage_events real per-turn tokens+timestamps; sessions cwd only, never summary)",
    // Script committed (this task) AND run against the real ~/.copilot corpus on this
    // machine (2026-07-15): 3 sessions, 1 real usage event, reconciled by hand against
    // the raw row — see copilot.ts's header. Publishable, not just docs-derived.
    evalScript: "eval/copilot-audit.mjs",
    // Verified against exactly ONE real Copilot CLI build (whatever wrote this machine's
    // session-store.db, 2026-07-15) -- a single data point asserts no floor.
    minKnownGoodVersion: null,
  },
  {
    id: "gemini",
    display: "Gemini CLI",
    home: () => geminiHome(), // geminiHome() already resolves DF_GEMINI_HOME — no second env read
    fingerprint: isOfficialGeminiCli,
    // Whole-file JSON per session (NOT jsonl): tmp/<projectDir>/chats/session-*.json;
    // `cached` is a subset of the prompt count and `thoughts` is status-only — see
    // src/gemini.ts's header for the two locked vendor semantics.
    format: "json session files (tmp/<projectDir>/chats/session-*.json, one object per session)",
    // Script committed; its RUN against a real corpus is the publish bar (the adapter
    // was derived from ONE real ~/.gemini store, 2026-07-23 — pre-publish posture).
    evalScript: "eval/gemini-audit.mjs",
    // Shape verified against one real store on one day — a single data point asserts
    // no version floor; left null rather than overclaiming.
    minKnownGoodVersion: null,
  },
];

/**
 * The spec's threshold rule, verbatim: drift is suspected when MORE than 5% of the
 * scanned lines were unknown AND more than 20 lines were (both strict — the AND keeps
 * a tiny corpus's one corrupt line, or a huge corpus's fixed legacy tail, from paging
 * anyone). Pure so status, the monitor, and tests share one definition.
 */
export function isDriftSuspected(health: Pick<ScanHealth, "unknownLines" | "totalLines">): boolean {
  if (health.totalLines <= 0) return false;
  return health.unknownLines > 20 && health.unknownLines / health.totalLines > 0.05;
}

/**
 * How long a stored scanHealth entry stays actionable. A provider that STOPS
 * re-scanning (tool uninstalled, fingerprint gate now refusing) keeps its last
 * counters forever — without an age cut, a drift alarm from last month would nag
 * on every status call for a tool that is no longer even parsed. Surfaces filter
 * `now - at` against this; the stored entry itself is left in place (history, and
 * a re-scan overwrites it).
 */
export const DRIFT_HEALTH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
