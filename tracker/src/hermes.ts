/**
 * Hermes agent (Nous Research, hermes-agent) capture — Wave 3 SQLite pair of
 * docs/harness-adapters-implementation.md (§3, "Fourth" candidate). PARSER ONLY: sync
 * wiring (cursors, dedupe key, digest gate) is a separate task and does not live here.
 *
 * PROVENANCE / CONFIDENCE (read before trusting a field below): no `~/.hermes` install
 * exists on this dev machine (per the implementation plan's corpus note) — every shape
 * here is SOURCE-DERIVED, PENDING A REAL-CORPUS EVAL (no wave number assigned yet; see
 * docs/harness-adapters-implementation.md §"Wave 3"). Unlike pi (docs-only), the
 * strongest source available here is the project's OWN SQLite schema code, both fetched
 * 2026-07-13:
 *   - https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_state.py
 *     — the literal `CREATE TABLE`/`CREATE INDEX` statements, and the Python call sites
 *     that WRITE `started_at`/`ended_at`/`messages.timestamp` (all `time.time()` —
 *     confirmed UNIX SECONDS, not milliseconds).
 *   - https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage and
 *     .../docs/user-guide/sessions — the published docs, cross-checked against the
 *     source above and found consistent (WAL mode, `parent_session_id` lineage, the
 *     legacy-JSONL deprecation notice, the `messages_fts`/`messages_fts_trigram` FTS5
 *     tables, `source` as platform-origin tag).
 * Anything NOT corroborated by the source-code fetch is called out inline as a GAP.
 * NEVER treat anything here as confirmed until a real corpus + eval/hermes-audit.mjs
 * runs against it (mirrors pi.ts's W1.0/W1.6 discipline).
 *
 * On-disk format (source-derived):
 *   - `~/.hermes/state.db` — ONE SQLite database (WAL mode: "concurrent readers and a
 *     single writer, which suits the gateway's multi-platform architecture"). Opened
 *     ONLY through sqlite.ts's `openSqliteReadOnly()` (repo-wide SQLite driver ruling) —
 *     a short-lived read-only connection per scan pass, closed promptly after. The WAL
 *     note from sqlite.ts's header applies verbatim: a read-only open needs the
 *     `-wal`/`-shm` sibling files readable; any open failure (locked writer, missing
 *     sibling, mid-checkpoint race) surfaces as `open_failed` — a soft-skip signal for
 *     THIS pass, never a recovery attempt, never escalated to a write.
 *   - `sessions` table (verbatim `CREATE TABLE` from hermes_state.py), the columns this
 *     parser actually reads: `id` (TEXT PRIMARY KEY, our `toolSessionId` — already
 *     globally unique by constraint, so unlike pi.ts there is NO cross-row "same id
 *     twice" dedupe to run here), `source` (platform origin — CLI/Telegram/Discord/etc,
 *     our `entryPoint` input), `model` (TEXT, ONE model per session — Hermes documents
 *     no model-change/model-window concept the way pi does), `started_at`/`ended_at`
 *     (REAL, confirmed UNIX SECONDS from the `time.time()` call sites — converted with
 *     `* 1000` below), `input_tokens`/`output_tokens`/`cache_read_tokens`/
 *     `cache_write_tokens`/`reasoning_tokens` (INTEGER DEFAULT 0 — SESSION-GRAIN totals,
 *     see the token-mapping note below), `parent_session_id` (TEXT, FK to
 *     `sessions.id` — see the parent-id note below), `cwd` (TEXT — the repoHash input,
 *     same convention as pi/grok/Claude: never uploaded raw).
 *   - `messages` table, columns read: `session_id`, `role` ('user'|'assistant'|'tool'
 *     per docs), `timestamp` (REAL, same unix-seconds convention as the session
 *     columns). `token_count` (INTEGER) exists per message but is NEVER read here — see
 *     the token-mapping GAP below. `content`/`tool_calls`/`tool_name`/`reasoning*` are
 *     message CONTENT and are never read, never even named in a SELECT (sqlite.ts's
 *     explicit-columns rule).
 *   - `messages_fts` / `messages_fts_trigram` (FTS5 virtual tables indexing message
 *     CONTENT) are NEVER read — exactly the FTS-index trap sqlite.ts's own header warns
 *     every SQLite adapter about.
 *   - Legacy `~/.hermes/sessions/*.jsonl` transcripts predate state.db and are, per the
 *     docs, "no longer written or read by Hermes." NEVER parsed here. `sessions.json`
 *     inside that same directory is a SEPARATE thing — the gateway's routing index
 *     (session key -> active session id, origin metadata, expiry flags) for its
 *     Telegram/Discord/etc bridges, not a transcript at all; it is likewise never read.
 *     The one signal extracted from this directory: if `*.jsonl` files exist AND
 *     `state.db` itself does NOT, that is a drift-era install stuck pre-migration —
 *     worth counting (`legacyJsonlWithoutDb`), never parsed for content.
 *
 * Token mapping (sessions row -> our TokenCounts): `input_tokens` -> input,
 * `output_tokens` -> output, `cache_read_tokens` -> cacheRead, `cache_write_tokens` ->
 * cacheCreation, `reasoning_tokens` -> thinkingTokens. REAL COUNTERS ONLY: a session row
 * whose `input_tokens` or `output_tokens` is NULL or non-numeric is NOT emitted as a
 * SessionSummary at all (counted as drift instead — see below) — never estimated, and
 * never backfilled from `messages.token_count`. `cache_read_tokens`/`cache_write_tokens`/
 * `reasoning_tokens` are each individually optional: missing/non-numeric defaults to 0
 * WITHOUT tripping the drift counter (mirrors pi.ts's cacheRead/cacheWrite treatment —
 * additive detail, not the two REQUIRED counters).
 *
 * GAP, load-bearing (why `messages.token_count` is never used): the schema defines
 * `token_count INTEGER` per message, but NEITHER the source code NOR the published docs
 * document what it represents for a `user` vs `assistant` vs `tool` row (fetched
 * 2026-07-13: "the implementation leaves this semantic undefined in the provided
 * content"). Guessing a split (e.g. "user rows are input, assistant rows are output")
 * would be INVENTING a convention no source states — exactly what "REAL COUNTERS ONLY,
 * never estimated" forbids elsewhere in this codebase. Tokens are therefore read ONLY at
 * SESSION grain, from the sessions table's own 5 counter columns.
 *
 * Per-message vs session-grain decision (the central judgment call for this adapter):
 * messages DO carry a reliable, documented, NOT-NULL `timestamp` column and a documented
 * `role` enum — real, non-invented signal — so per-message timestamps ARE used for the
 * activity/turns/loop reconstruction (computeActivity/computeLoops), giving Hermes the
 * SAME activeMs/idleMs/turns/longestLoopMs fidelity as every other adapter. A session
 * with zero message rows (edge case) falls back to a 1-2 point pool built from its own
 * started_at/ended_at, dated by the session row alone.
 *   BUT day-slicing (`days[]`) needs TOKENS bucketed per day, and there is no reliable
 *   way to split a session's 5 session-grain token counters across the days its
 *   messages touch (that would require exactly the per-message input/output split the
 *   previous paragraph refuses to invent). So `days[]` is UNCONDITIONALLY absent for
 *   every Hermes session in this parser, single-day or multi-day, PERMANENTLY for v1 —
 *   HONEST DEGRADATION, not a bug: a multi-day Hermes session still reports accurate
 *   activity/turns and accurate SESSION-TOTAL tokens, just no day-by-day token split,
 *   until a real corpus proves a defensible per-message split exists. Recorded loudly
 *   here and in eval/hermes-audit.mjs (which flags multi-day sessions as a finding to
 *   log, not a violation).
 *
 * parent_session_id: recorded NOTHING special, by task instruction — no tree
 * reconstruction in v1 (Hermes splits a session into a new row when context compression
 * triggers a split in the gateway; walking that chain to merge totals is a real future
 * feature, not built here). Because `sessions.id` is the table's PRIMARY KEY, every row
 * is independently unique BY CONSTRUCTION — unlike pi.ts (which defends against the same
 * session id appearing in two files), there is no dedupe-by-id pass to run: one row is
 * one SessionSummary, full stop. A parent and its compression-split child are simply two
 * separate, independent SessionSummary records; nothing here merges them.
 *
 * entryPoint: mapped from the session's own `source` column (CLI/Telegram/Discord/etc,
 * per docs) through the same normalization idiom jsonl.ts's `normalizeEntryPoint` uses
 * (lowercase, charset-gated, else "unknown") — Hermes is the first adapter where this
 * field is a genuinely DOCUMENTED, DB-native signal rather than a hardcoded default.
 *
 * skills / agents: always undefined. No skill-invocation or subagent-dispatch concept is
 * documented anywhere in the fetched sources (`tool_calls`/`tool_name` are ordinary
 * function/tool calling, not a Skill-tool or Task-subagent idiom) — the "omitted, never
 * faked" contract every other adapter uses.
 *
 * Fingerprint (`isOfficialHermesCli`): STRUCTURAL, not content-based (same caveat class
 * as pi.ts's mark — no proprietary content string comparable to Grok's `api.x.ai` pin is
 * documented for Hermes). The mark: `state.db` must exist, open read-only, and its
 * `sessions` table (via `PRAGMA table_info`) must carry every column this parser depends
 * on (REQUIRED_SESSION_COLUMNS below — deliberately includes `reasoning_tokens` and
 * `cache_write_tokens`, less likely to collide with some OTHER tool's generic "sessions"
 * table than `id`/`model` alone would be). WEAKNESS (recorded, not hidden): a
 * byte-compatible reimplementation of this schema — or literally any SQLite file placed
 * at the resolved home's `state.db` with a same-shaped `sessions` table — passes this
 * gate undetected. Fork-collision research RAN 2026-07-14 (findings in the maintenance
 * runbook §6): upstream has ~40k raw forks; plain forks are provably indistinguishable
 * at the DB layer (same code, same home, same schema — no DB-side mark can attribute a
 * row to a binary); the one maintained same-home derivative found (hermes-agent-camel)
 * fails this gate on a fresh DB (its older schema lacks `cwd`) but passes on any db the
 * official binary ever touched (upstream migrations are add-only). Upstream schema churn
 * is high but ADD-ONLY (`_reconcile_columns` never renames/drops), and this check is
 * containment, not exact-count — so official-but-new near-never refuses. The honest
 * claim this gate supports: "data conforming to Hermes's published schema at Hermes's
 * home path", never "written by the official binary".
 *
 * Soft-skip contract (mirrors sqlite.ts's SqliteOpenResult, extended with one adapter-
 * level reason): `scanHermesCorpus` NEVER throws for an environmental reason. It returns
 * `skipReason` set to one of sqlite.ts's own reasons (`node_sqlite_missing`,
 * `file_missing`, `open_failed` — propagated verbatim from `openSqliteReadOnly`, so the
 * sync wiring's "one honest line" can print the SAME vocabulary every SQLite adapter
 * uses) or this module's own `schema_mismatch` (the open succeeded but a `SELECT` naming
 * a documented column failed — e.g. a renamed/dropped column post-fingerprint; a
 * distinct failure mode from "no db at all"). Every skip path returns `sessions: []` and
 * a `null` watermark — the caller must not advance a cursor over unread data (the
 * pi/sqlite "read-failure" rule, applied here at the whole-database grain since there is
 * no per-file cursor to partially advance).
 *
 * Cursor model: `watermark` is the max `started_at` (ms, converted) across every session
 * row this pass could read a numeric `started_at` from AT ALL (independent of whether
 * that row's tokens were usable) — chosen over a rowid watermark because `started_at` is
 * the column the schema itself makes NOT NULL and is what every other adapter's
 * cursoring conceptually tracks (recency), whereas AUTOINCREMENT rowids exist only on
 * `messages`, not `sessions`. `null` when nothing was scanned or the pass was skipped.
 *
 * Drift counting (W1.5 vocabulary, field names kept as `unknownLines`/`totalLines` for
 * structural compatibility with providers.ts's `isDriftSuspected` — units here are
 * SESSION ROWS, not text lines; see the field doc comments below): every row scanned
 * counts toward `totalLines`; a row whose `id`/`started_at`/`input_tokens`/
 * `output_tokens` is NULL or non-numeric counts toward `unknownLines` AND is not
 * emitted. A whole-query failure (missing table/column) is a SEPARATE, stronger signal
 * (`skipReason: "schema_mismatch"`), not folded into these two counters — the task
 * instruction's "missing table/column -> soft fail counted" is satisfied by that reason
 * string.
 */
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { openSqliteReadOnly, type SqliteRow } from "./sqlite.js";
import { creditModel, foldModelBuckets } from "./jsonl.js";
import { computeActivity, computeLoops } from "./activity.js";
import { repoHash, type TrackerState } from "./config.js";
import type { EntryPoint, SessionSummary, TokenCounts } from "./types.js";

export function hermesHome(): string {
  // DF_HERMES_HOME stays first (our hermetic-test/override contract), then the VENDOR's
  // own resolution, mirrored from hermes_constants.py get_hermes_home (read verbatim
  // 2026-07-14): HERMES_HOME env honored; Windows default = %LOCALAPPDATA%\hermes
  // (fallback ~/AppData/Local/hermes); POSIX = ~/.hermes. The previous hardcoded
  // ~/.hermes was a CONFIRMED Windows false negative — official Hermes never writes
  // there on win32 (the opencode xdg-basedir lesson, repeated). Known remaining gap:
  // Hermes also supports a profile-override file (active_profile) we do not read — a
  // profiled user is under-captured, never mis-captured.
  if (process.env.DF_HERMES_HOME) return process.env.DF_HERMES_HOME;
  const vendorEnv = process.env.HERMES_HOME?.trim();
  if (vendorEnv) return vendorEnv;
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return localAppData ? join(localAppData, "hermes") : join(homedir(), "AppData", "Local", "hermes");
  }
  return join(homedir(), ".hermes");
}

export function hermesDbPath(home: string = hermesHome()): string {
  return join(home, "state.db");
}

/** The deprecated JSONL transcript directory (see file header — never parsed). */
export function hermesLegacySessionsDir(home: string = hermesHome()): string {
  return join(home, "sessions");
}

/** Columns this parser depends on — the fingerprint's structural mark (see file header). */
const REQUIRED_SESSION_COLUMNS = [
  "id",
  "source",
  "model",
  "started_at",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "parent_session_id",
  "cwd",
] as const;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Is `home` an official Hermes install? Structural fingerprint (see file header for the
 * recorded weakness): `state.db` must open read-only AND its `sessions` table must carry
 * every column this parser reads (via `PRAGMA table_info`, not a content string — none
 * is documented). No mark -> capture NOTHING (never guess which product wrote the file).
 */
export function isOfficialHermesCli(home: string = hermesHome()): boolean {
  const db = openSqliteReadOnly(hermesDbPath(home));
  if (!db.available) return false;
  try {
    const cols = db.query("PRAGMA table_info(sessions)");
    if (cols.length === 0) return false; // no such table -- PRAGMA on a missing table returns zero rows, not an error
    const names = new Set(cols.map((c) => String(c.name)));
    return REQUIRED_SESSION_COLUMNS.every((c) => names.has(c));
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** True when the deprecated `~/.hermes/sessions/*.jsonl` transcript tree exists. Used
 * ONLY to detect the "JSONL without a database" drift-era signal (file header) — the
 * files themselves are NEVER parsed. `sessions.json` (the gateway routing index) does
 * not count -- only actual `.jsonl` transcript files do. */
function hasLegacyJsonlTranscripts(home: string): boolean {
  const dir = hermesLegacySessionsDir(home);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some((f) => f.endsWith(".jsonl"));
}

/** Normalize the sessions.`source` column to an EntryPoint: same lowercase/charset-gate
 * idiom as jsonl.ts's normalizeEntryPoint, but with no vscode/desktop synonyms documented
 * for Hermes -- unrecognized-but-well-formed values pass through verbatim (e.g. a
 * platform name like "telegram"), matching the EntryPoint type's open string escape. */
function normalizeHermesEntryPoint(raw: unknown): EntryPoint {
  if (typeof raw !== "string") return "unknown";
  const id = raw.trim().toLowerCase();
  if (!id) return "unknown";
  if (id === "cli" || id === "terminal") return "cli";
  return /^[a-z0-9._:-]{1,64}$/.test(id) ? id : "unknown";
}

export type HermesSkipReason = "node_sqlite_missing" | "file_missing" | "open_failed" | "schema_mismatch";

/** `scanHermesCorpus`'s full result: sessions plus the soft-skip + drift-plumbing
 * signals (file header). Sync wiring (a separate task) persists `watermark` and prints
 * one honest line when `skipReason` is set. */
export interface HermesCorpusScan {
  sessions: SessionSummary[];
  /** Set when this pass could not read the database AT ALL -- see file header for each
   * reason's meaning. `sessions` is always `[]` and `watermark` always `null` when set. */
  skipReason: HermesSkipReason | null;
  /** Session ROWS (not lines -- kept named this way for structural compatibility with
   * providers.ts's isDriftSuspected) whose id/started_at/input_tokens/output_tokens were
   * NULL or non-numeric -- counted, never emitted, never estimated. */
  unknownLines: number;
  /** Every session row this pass could scan -- the drift-rate denominator. */
  totalLines: number;
  /** Legacy `~/.hermes/sessions/*.jsonl` transcripts exist while `state.db` itself does
   * not -- a drift-era (pre-migration) install, counted as a signal, never parsed. */
  legacyJsonlWithoutDb: boolean;
  /** Max `started_at` (ms) seen across every row this pass could read a numeric
   * started_at from, for the caller to persist as a watermark cursor. `null` when
   * nothing was scanned (empty corpus or a skipped pass). */
  watermark: number | null;
}

function emptyScan(skipReason: HermesSkipReason | null, legacyJsonlWithoutDb: boolean): HermesCorpusScan {
  return { sessions: [], skipReason, unknownLines: 0, totalLines: 0, legacyJsonlWithoutDb, watermark: null };
}

/**
 * Summarize the whole Hermes corpus (one row per session, `sessions.id` already unique
 * by primary key -- no cross-row dedupe needed, unlike pi.ts). Does NOT check
 * `isOfficialHermesCli` itself -- that gate is the CALLER's responsibility (mirrors
 * grok.ts/pi.ts's split). NEVER throws for an environmental reason (soft-skip contract,
 * file header) -- open/query failures degrade to `skipReason`, never an exception.
 */
export function scanHermesCorpus(state: TrackerState, home: string = hermesHome()): HermesCorpusScan {
  const dbPath = hermesDbPath(home);
  const dbFileExists = existsSync(dbPath);
  const db = openSqliteReadOnly(dbPath);
  if (!db.available) {
    // "JSONL without a database" is only a meaningful signal when there really is no
    // database file at all (a locked/corrupt db that merely failed to OPEN this pass is
    // a transient soft-skip, not a drift-era install).
    const legacyWithoutDb = !dbFileExists && hasLegacyJsonlTranscripts(home);
    return emptyScan(db.reason, legacyWithoutDb);
  }

  let sessionRows: SqliteRow[];
  let messageRows: SqliteRow[];
  try {
    sessionRows = db.query(
      "SELECT id, source, model, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cwd FROM sessions",
    );
    messageRows = db.query("SELECT session_id, role, timestamp FROM messages ORDER BY session_id, timestamp");
  } catch {
    db.close();
    return emptyScan("schema_mismatch", false);
  }
  db.close(); // one scan pass, then release the handle (sqlite.ts's discipline)

  // Group message timestamps/roles per session -- the activity/turns input (file header:
  // per-message timestamps are real, documented signal; per-message TOKENS are not).
  const bySessionMsgs = new Map<string, { all: number[]; human: number[]; assistantCount: number }>();
  for (const m of messageRows) {
    const sid = m.session_id;
    const ts = m.timestamp;
    if (typeof sid !== "string" || !sid || !isFiniteNumber(ts)) continue;
    let bucket = bySessionMsgs.get(sid);
    if (!bucket) {
      bucket = { all: [], human: [], assistantCount: 0 };
      bySessionMsgs.set(sid, bucket);
    }
    const tsMs = ts * 1000; // sessions/messages timestamps are UNIX SECONDS (time.time()), not ms
    bucket.all.push(tsMs);
    if (m.role === "user") bucket.human.push(tsMs);
    else if (m.role === "assistant") bucket.assistantCount++;
  }

  const sessions: SessionSummary[] = [];
  let unknownLines = 0;
  let watermark: number | null = null;

  for (const row of sessionRows) {
    const startedAtRaw = row.started_at;
    const inputRaw = row.input_tokens;
    const outputRaw = row.output_tokens;
    const idOk = typeof row.id === "string" && row.id.length > 0;

    if (isFiniteNumber(startedAtRaw)) {
      const startedMs = startedAtRaw * 1000;
      if (watermark === null || startedMs > watermark) watermark = startedMs;
    }

    // REAL COUNTERS ONLY: a session with no stable id, no start time, or non-numeric
    // core token counters is not emitted -- never estimated, never a synthetic id
    // (file header). Counted as drift instead.
    if (!idOk || !isFiniteNumber(startedAtRaw) || !isFiniteNumber(inputRaw) || !isFiniteNumber(outputRaw)) {
      unknownLines++;
      continue;
    }

    const tokens: TokenCounts = {
      input: Math.max(0, inputRaw),
      output: Math.max(0, outputRaw),
      cacheRead: Math.max(0, isFiniteNumber(row.cache_read_tokens) ? row.cache_read_tokens : 0),
      cacheCreation: Math.max(0, isFiniteNumber(row.cache_write_tokens) ? row.cache_write_tokens : 0),
    };
    const thinkingTokens = Math.max(0, isFiniteNumber(row.reasoning_tokens) ? row.reasoning_tokens : 0);

    const modelId = typeof row.model === "string" && row.model ? row.model : "unknown";
    const byModel = new Map<string, TokenCounts>();
    creditModel(byModel, modelId, tokens);
    const models = foldModelBuckets(byModel);

    const startedAt = startedAtRaw * 1000;
    const endedAtRaw = row.ended_at;
    const endedAtMs = isFiniteNumber(endedAtRaw) ? endedAtRaw * 1000 : null;

    const sessionId = row.id as string;
    const msgs = bySessionMsgs.get(sessionId);
    let tsPool: number[];
    if (msgs && msgs.all.length > 0) {
      tsPool = [...msgs.all].sort((a, b) => a - b);
    } else {
      // No message rows for this session (edge case) -- fall back to the session row's
      // own started_at/ended_at, dated by the DB alone (file header's degraded path).
      tsPool = endedAtMs !== null && endedAtMs !== startedAt ? [startedAt, endedAtMs] : [startedAt];
    }

    const activity = computeActivity(tsPool, state.gapMs);
    const loops = computeLoops(tsPool, msgs?.human ?? [], state.gapMs);
    const endedAt = endedAtMs ?? startedAt + activity.wallMs;

    const cwd = typeof row.cwd === "string" && row.cwd ? row.cwd : undefined;

    const summary: SessionSummary = {
      tool: "hermes",
      toolSessionId: sessionId,
      model: modelId,
      tokens,
      models,
      entryPoint: normalizeHermesEntryPoint(row.source),
      thinkingTokens,
      days: undefined, // GAP: tokens are session-grain only -- see file header, permanently absent in v1
      skills: undefined, // no documented skill-invocation concept in Hermes's schema
      agents: undefined, // no documented subagent-dispatch concept in Hermes's schema
      wallMs: activity.wallMs,
      activeMs: activity.activeMs,
      idleMs: activity.idleMs,
      startedAt,
      endedAt,
      repoHash: cwd ? repoHash(state.repoHmacKey, basename(cwd)) : null,
      messageCount: msgs?.assistantCount ?? 0,
      turns: loops.turns,
      longestLoopMs: loops.longestLoopMs,
      cwd,
    };
    sessions.push(summary);
  }

  return {
    sessions,
    skipReason: null,
    unknownLines,
    totalLines: sessionRows.length,
    legacyJsonlWithoutDb: false, // the database opened fine this pass -- not the drift-era case
    watermark,
  };
}

/** Thin wrapper matching pi.ts's `summarizePiCorpus(state, home)` shape, for call sites
 * that only need the sessions array. */
export function summarizeHermesCorpus(state: TrackerState, home: string = hermesHome()): SessionSummary[] {
  return scanHermesCorpus(state, home).sessions;
}
