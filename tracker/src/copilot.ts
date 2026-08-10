/**
 * GitHub Copilot CLI capture — 8th harness adapter (claude_code, codex, grok, pi,
 * openclaw, opencode, hermes preceded it). PARSER + local day-slicing live here; sync
 * wiring (cursors, watermark persistence, digest gate) lives in sync.ts, mirroring
 * hermes.ts's split.
 *
 * PROVENANCE (read before trusting a field below): CONFIRMED against a REAL
 * `~/.copilot/session-store.db` on this machine (Marco, 2026-07-15) — not source-derived,
 * not docs-derived, an actual read, then re-verified during this task with a fresh
 * read-only query pass:
 *   - `sqlite_master` lists ~17 tables (schema_version, sessions, turns, sqlite_sequence,
 *     checkpoints, session_files, session_refs, forge_trajectory_events,
 *     assistant_usage_events, forge_skill_proposals, search_index and its FTS5 shadow
 *     tables, dynamic_context_items). ONLY `sessions` and `assistant_usage_events` are
 *     ever touched by this module — `turns` (the actual message/prompt content table,
 *     per its name) is NEVER read, NEVER even named in a query.
 *   - `sessions` columns (verbatim `PRAGMA table_info`): id, cwd, repository, host_type,
 *     branch, summary, created_at, updated_at. Only `id` and `cwd` are ever selected —
 *     `summary` is (like opencode.ts's disclosed `title` call) very likely an
 *     LLM-generated description of the session's actual work and is NEVER read;
 *     `repository`/`host_type`/`branch` are not needed for anything this parser derives
 *     (repo attribution runs off `cwd`, the same convention every other adapter uses).
 *   - `assistant_usage_events` columns (verbatim `PRAGMA table_info`): id, session_id,
 *     turn_index, agent_id, parent_tool_call_id, model, input_tokens, output_tokens,
 *     cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu,
 *     request_multiplier, duration_ms, time_to_first_token_ms, inter_token_latency_ms,
 *     initiator, api_endpoint, reasoning_effort, finish_reason, content_filter_triggered,
 *     token_details_json, created_at. Only the token/model/timestamp/id columns this
 *     parser needs are ever selected in the production scan — `token_details_json`
 *     (GitHub's AIU billing breakdown) and `total_nano_aiu`/`request_multiplier` (its
 *     derivatives) are NEVER selected here; they were inspected once, read-only, during
 *     THIS task's verification pass only (see the GAP note below), never by scanCopilotCorpus.
 *   - A REAL row on this machine (2026-07-15): session_id=ad45aaa8-3db3-47cd-8a7b-
 *     8cc84f5caa42, turn_index=0, model="gpt-5-mini", input_tokens=32649,
 *     output_tokens=115, cache_read_tokens=0, cache_write_tokens=0, reasoning_tokens=64,
 *     created_at="2026-07-15T18:32:11.818Z". The other TWO sessions on the same machine
 *     (first-run folder-trust confirmations) have ZERO assistant_usage_events rows —
 *     confirms the "no events -> no SessionSummary" rule against real data, not just a
 *     synthesized fixture (see eval/copilot-audit.mjs, run against this exact database).
 *
 * Token mapping (assistant_usage_events row -> TokenCounts): input_tokens -> input,
 * output_tokens -> output, cache_read_tokens -> cacheRead, cache_write_tokens ->
 * cacheCreation, reasoning_tokens -> thinkingTokens (mirrors Claude/Grok: reasoning is
 * SEPARATE from output, never folded into it). total_nano_aiu / request_multiplier /
 * token_details_json are GitHub's AIU BILLING extras and are NEVER folded into tokens.
 *
 * GAP (disclosed, not resolved): whether `input_tokens` is inclusive of
 * `cache_read_tokens` cannot be settled from the one real row available (its
 * cache_read_tokens happens to be 0). That row's own `token_details_json` — inspected
 * manually during this task's verification, NEVER read by the production parser — lists
 * THREE parallel `tokenType` billing buckets: {"input":32649}, {"cache_read":0},
 * {"output":115}; `reasoning_tokens` (64) appears in NONE of them. That is real evidence
 * `input_tokens` is a bucket PARALLEL to cache_read_tokens (the same "fresh vs cached"
 * split Codex's `input_tokens`/`cached_input_tokens` already uses in this codebase), not
 * an inclusive superset — but with only one non-degenerate sample (cache_read=0 in that
 * row), this is evidence, not a settled fact. Treated as additive per TokenCounts'
 * existing contract (every other adapter already treats input/cacheRead as separate,
 * summed buckets); never re-derived or subtracted here.
 *
 * Per-event day-slicing (better fidelity than hermes/opencode): unlike Hermes
 * (session-grain-only counters) and opencode (session-grain cumulative totals, no
 * per-message tokens at all), Copilot's `assistant_usage_events` gives REAL per-event
 * tokens WITH a real per-event timestamp — one row per model/tool round-trip, already
 * the finest grain GitHub records. This is the same atom shape pi/Claude use for
 * day-slicing, so `days[]` is built for real (Fix A), never smeared, exactly like those
 * adapters — see `buildCopilotDaySlices` below, a LOCAL reimplementation of sync.ts's
 * `buildDaySlices` (mirrors pi.ts's own local copy, to avoid importing sync.ts, which
 * itself imports this module — a circular import).
 *
 * turns / longestLoopMs: ALWAYS 0. `assistant_usage_events` carries no role/human-message
 * concept at all — every row is an ASSISTANT-emitted usage record. `turn_index` is a
 * monotonic per-session sequence (per the task brief: "one session has MANY
 * assistant_usage_events, one per turn_index"), not a documented human-prompt boundary
 * marker, and `parent_tool_call_id` (non-null on a nested sub-call) is STRUCTURALLY
 * suggestive of a root-vs-nested distinction but is not documented as one — using it to
 * infer "this row started a human turn" would be inventing a convention no source states,
 * exactly what "REAL COUNTERS ONLY, never estimated" forbids elsewhere in this codebase
 * (opencode.ts's identical stance: "an unknowable turn count reports 0, never a guess").
 * `messageCount` IS a real count, unlike turns: one `assistant_usage_events` row is one
 * assistant message/turn, so counting rows is not a guess.
 *
 * skills / agents: always undefined. No skill-invocation or Task-style subagent-dispatch
 * concept is documented in the confirmed schema (`agent_id`/`parent_tool_call_id`
 * describe WHICH agent/call emitted a usage row, not a Skill-tool or subagent DISPATCH
 * the way Claude's transcript records one) — the "omitted, never faked" contract every
 * other adapter uses.
 *
 * entryPoint: hardcoded "cli" — Copilot CLI is a terminal-only product; the confirmed
 * schema documents no alternate entry point (IDE/desktop) the way Claude's does.
 *
 * Fingerprint (`isOfficialCopilotCli`): STRUCTURAL, the same disclosed-weakness class as
 * every other SQLite adapter here — `session-store.db` must open read-only AND its
 * `assistant_usage_events` table (`PRAGMA table_info`, never a content string) must carry
 * every column this parser depends on. WEAKNESS (recorded, not hidden): a
 * byte-compatible reimplementation of this schema at the same home path passes this gate
 * undetected — the honest claim this gate supports is "data conforming to Copilot CLI's
 * schema at Copilot CLI's home path", never "written by the official binary" (the same
 * caveat hermes.ts/opencode.ts carry).
 *
 * Soft-skip contract: mirrors hermes.ts exactly — `scanCopilotCorpus` NEVER throws for an
 * environmental reason; `skipReason` is one of sqlite.ts's own reasons
 * (`node_sqlite_missing`/`file_missing`/`open_failed`, propagated verbatim) or this
 * module's own `schema_mismatch` (open succeeded but a SELECT naming a documented column
 * failed). Every skip path returns `sessions: []` and a `null` watermark.
 *
 * Cursor model: `watermark` is the max event `created_at` (ms) seen across every event
 * row this pass could parse A VALID timestamp from, INDEPENDENT of whether that row's
 * session/tokens were usable (mirrors hermes.ts's identical rule) — the finest-grain
 * recency signal available from this schema.
 *
 * Drift counting: EVENT-row grain (not session-row grain like hermes/opencode) —
 * `assistant_usage_events` is the only place this schema exposes per-atom signal, so
 * `unknownLines`/`totalLines` are scoped to it. An event row with a missing/non-string
 * `session_id`, an unparseable `created_at`, or a non-numeric `input_tokens`/
 * `output_tokens` is dropped ENTIRELY (never partially credited, never folded into any
 * session, never counted toward watermark beyond its own timestamp contribution) and
 * counted as drift. `model` missing/non-string falls back to `"unknown"` WITHOUT tripping
 * drift (never drop tokens for a missing model — same fallback convention as every other
 * adapter). `cache_read_tokens`/`cache_write_tokens`/`reasoning_tokens` are each
 * individually optional: missing/non-numeric defaults to 0 without tripping drift
 * (mirrors hermes.ts's cacheRead/cacheWrite treatment). A session whose every event
 * dropped this way produces NO SessionSummary at all — same rule as a session with
 * literally zero event rows (a genuine, expected case: the two folder-trust
 * confirmation sessions on the real corpus above never call a model at all).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { openSqliteReadOnly, type SqliteRow } from "./sqlite.js";
import { creditModel, foldModelBuckets, addTokens, ZERO } from "./jsonl.js";
import { lastNonzeroOccupancy } from "./contextEfficiency.js";
import { computeActivity, computeLoops, sliceActivityByDay, utcDayKey, type ActivityDaySlice } from "./activity.js";
import { repoHash, type TrackerState } from "./config.js";
import type { SessionDaySlice, SessionSummary, TokenCounts } from "./types.js";

/** `DF_COPILOT_HOME` overrides everything; otherwise `~/.copilot` (the confirmed real
 * path on this machine — no vendor env override or platform branch is documented for
 * Copilot CLI, unlike hermes.ts/opencode.ts). */
export function copilotHome(): string {
  if (process.env.DF_COPILOT_HOME) return process.env.DF_COPILOT_HOME;
  return join(homedir(), ".copilot");
}

export function copilotDbPath(home: string = copilotHome()): string {
  return join(home, "session-store.db");
}

/** The OTel agent-traces store (L5b back-port, landscape S4). See `scanCopilotOtelTraces`'s
 * header for the CORPUS-UNVERIFIED status of this path/shape. */
export function copilotOtelDbPath(home: string = copilotHome()): string {
  return join(home, "agent-traces.db");
}

/** Columns this parser depends on — the fingerprint's structural mark (see file header). */
const REQUIRED_EVENT_COLUMNS = [
  "session_id",
  "turn_index",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "created_at",
] as const;

/**
 * Is `home` an official Copilot CLI install? Structural fingerprint (see file header for
 * the recorded weakness): `session-store.db` must open read-only AND its
 * `assistant_usage_events` table (via `PRAGMA table_info`, not a content string) must
 * carry every column this parser reads. No mark -> capture NOTHING.
 */
export function isOfficialCopilotCli(home: string = copilotHome()): boolean {
  const db = openSqliteReadOnly(copilotDbPath(home));
  if (!db.available) return false;
  try {
    const cols = db.query("PRAGMA table_info(assistant_usage_events)");
    if (cols.length === 0) return false; // no such table -- PRAGMA on a missing table returns zero rows, not an error
    const names = new Set(cols.map((c) => String(c.name)));
    return REQUIRED_EVENT_COLUMNS.every((c) => names.has(c));
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export type CopilotSkipReason = "node_sqlite_missing" | "file_missing" | "open_failed" | "schema_mismatch";

/** `scanCopilotCorpus`'s full result: sessions plus the soft-skip + drift-plumbing
 * signals (file header). Sync wiring persists `watermark` and prints one honest line
 * when `skipReason` is set. */
export interface CopilotCorpusScan {
  sessions: SessionSummary[];
  /** Set when this pass could not read the database AT ALL -- see file header for each
   * reason's meaning. `sessions` is always `[]` and `watermark` always `null` when set. */
  skipReason: CopilotSkipReason | null;
  /** assistant_usage_events ROWS (not lines) dropped entirely for a missing session_id /
   * unparseable created_at / non-numeric input_tokens or output_tokens. */
  unknownLines: number;
  /** Every assistant_usage_events row this pass could scan -- the drift-rate denominator. */
  totalLines: number;
  /** Max event `created_at` (ms) seen across every row this pass could read a valid
   * timestamp from, for the caller to persist as a watermark cursor. `null` when nothing
   * was scanned (empty corpus or a skipped pass). */
  watermark: number | null;
}

function emptyScan(skipReason: CopilotSkipReason | null): CopilotCorpusScan {
  return { sessions: [], skipReason, unknownLines: 0, totalLines: 0, watermark: null };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

interface ValidEvent {
  ts: number;
  model: string;
  tokens: TokenCounts;
  thinkingTokens: number;
}

/**
 * Assemble wire day-slices (day-attribution Fix A) from the SAME crediting walk
 * sync.ts's `buildDaySlices` uses for Claude: activity quanta clipped at midnights
 * (`sliceActivityByDay`), and real per-event usage bucketed by ITS OWN timestamp's UTC
 * day. Every event reaching this function already has a real parsed timestamp (rows
 * without one are dropped in scanCopilotCorpus before grouping), so there is no ""
 * orphan bucket to merge -- unlike Claude's day-slice assembly. Returns undefined for
 * single-day sessions (byte-identity with the pre-slice digest, same rule as every
 * other provider).
 */
function buildCopilotDaySlices(
  activityDays: Map<string, ActivityDaySlice>,
  events: ValidEvent[],
): SessionDaySlice[] | undefined {
  const tokensByDay = new Map<string, Map<string, TokenCounts>>();
  for (const e of events) {
    const day = utcDayKey(e.ts);
    let dayModels = tokensByDay.get(day);
    if (!dayModels) {
      dayModels = new Map();
      tokensByDay.set(day, dayModels);
    }
    creditModel(dayModels, e.model, e.tokens);
  }

  const dayKeys = new Set<string>([...activityDays.keys(), ...tokensByDay.keys()]);
  if (dayKeys.size < 2) return undefined;

  return [...dayKeys].sort().map((day) => {
    const a = activityDays.get(day) ?? { activeMs: 0, idleMs: 0 };
    const dayModels = tokensByDay.get(day) ? foldModelBuckets(tokensByDay.get(day)!) : [];
    const tokens: TokenCounts = { ...ZERO };
    for (const m of dayModels) addTokens(tokens, m);
    return {
      day,
      activeMs: a.activeMs,
      idleMs: a.idleMs,
      tokens,
      ...(dayModels.length ? { models: dayModels } : {}),
    };
  });
}

/**
 * Fold a `session id -> ValidEvent[]` map into SessionSummary records — the shared tail of
 * BOTH the session-store scan and the OTel scan (identical downstream shape: activity, model
 * buckets, context occupancy, day slices), so the two sources can never drift in how they
 * derive a session. `cwdBySession` supplies a cwd where the source has one (session-store's
 * `sessions` table); OTel passes an empty map (spans carry no cwd).
 */
function foldCopilotSessions(
  state: TrackerState,
  bySession: Map<string, ValidEvent[]>,
  cwdBySession: Map<string, string>,
): SessionSummary[] {
  const sessions: SessionSummary[] = [];
  for (const [sessionId, events] of bySession) {
    const tsPool = events.map((e) => e.ts).sort((a, b) => a - b);
    const activity = computeActivity(tsPool, state.gapMs);
    // No human-turn signal exists in this schema (file header) -- turns/longestLoopMs
    // report honestly as 0, never guessed from turn_index or parent_tool_call_id.
    const loops = computeLoops(tsPool, [], state.gapMs);

    const byModel = new Map<string, TokenCounts>();
    const tokens: TokenCounts = { ...ZERO };
    let thinkingTokens = 0;
    let model = "unknown"; // "last valid model seen" -- events arrive in turn_index order
    for (const e of events) {
      creditModel(byModel, e.model, e.tokens);
      addTokens(tokens, e.tokens);
      thinkingTokens += e.thinkingTokens;
      model = e.model;
    }
    const models = foldModelBuckets(byModel);

    const startedAt = tsPool[0] ?? 0;
    const endedAt = startedAt + activity.wallMs;
    const days = buildCopilotDaySlices(sliceActivityByDay(tsPool, state.gapMs), events);
    const cwd = cwdBySession.get(sessionId);

    sessions.push({
      tool: "copilot",
      toolSessionId: sessionId,
      model,
      tokens,
      models,
      entryPoint: "cli", // Copilot CLI is terminal-only -- no alternate entry point documented
      thinkingTokens,
      // Context occupancy (lane T3): LOCAL-ONLY. `events` is already turn_index-ordered (the
      // SQL query's own ORDER BY) and turn_index tracks wall-clock order 1:1 in this schema, so
      // the shared helper's ts-sort reproduces "last (highest turn_index)" exactly.
      context: lastNonzeroOccupancy(events),
      days,
      skills: undefined, // no documented skill-invocation concept in Copilot's schema
      agents: undefined, // no documented subagent-dispatch concept in Copilot's schema
      wallMs: activity.wallMs,
      activeMs: activity.activeMs,
      idleMs: activity.idleMs,
      startedAt,
      endedAt,
      repoHash: cwd ? repoHash(state.repoHmacKey, basename(cwd)) : null,
      messageCount: events.length, // one usage row IS one assistant message/turn
      turns: loops.turns,
      longestLoopMs: loops.longestLoopMs,
      cwd,
    });
  }
  return sessions;
}

/** Columns/attributes the OTel scan reads. See `scanCopilotOtelTraces`'s header. */
const OTEL_USAGE_ATTRS = {
  model: "gen_ai.request.model",
  input: "gen_ai.usage.input_tokens",
  output: "gen_ai.usage.output_tokens",
  cacheRead: "gen_ai.usage.cache_read_tokens",
  cacheWrite: "gen_ai.usage.cache_write_tokens",
  reasoning: "gen_ai.usage.reasoning_tokens",
  sessionId: "copilot.session.id",
} as const;

/**
 * L5b OTel back-port (landscape S4). Fold `agent-traces.db`'s `spans` into SessionSummary
 * records, one per session, summing `gen_ai.usage.*` across every span of the session.
 *
 * CORPUS STATUS (discovery 2026-07-23 on Marco's machine — the real corpus host): there is NO
 * `agent-traces.db` anywhere under ~/.copilot. The named OTel store is ABSENT here, so the
 * SHAPE below is CORPUS-UNVERIFIED. It is modeled on the OpenTelemetry GenAI semantic
 * conventions (`gen_ai.request.model`, `gen_ai.usage.input_tokens`/`output_tokens`, plus the
 * cache/reasoning extensions), the only documented shape available — a `spans` table with a
 * JSON `attributes` blob per span. On the current corpus the RICHEST verified per-turn source
 * is in fact the session-store we already read (`assistant_usage_events` carries the same five
 * per-turn counts), so this reader has no confirmed target yet; a real Copilot OTel install is
 * needed to confirm the exact table/attribute names before it ships (W-gate). The BEHAVIOURAL
 * contract (prefer OTel when present, fold gen_ai.usage.*, one session counted once) is durable.
 *
 * Token mapping mirrors the session-store path exactly: input->input, output->output,
 * cache_read->cacheRead, cache_write->cacheCreation, reasoning->thinkingTokens (NEVER folded
 * into output). Soft-skip identical to scanCopilotCorpus.
 */
export function scanCopilotOtelTraces(state: TrackerState, home: string = copilotHome()): CopilotCorpusScan {
  const db = openSqliteReadOnly(copilotOtelDbPath(home));
  if (!db.available) return emptyScan(db.reason);

  let spanRows: SqliteRow[];
  try {
    // start_time_unix_nano exceeds JS safe-integer range (nanos since epoch ~1.8e18), and
    // node:sqlite throws when reading such an integer as a JS number -- so divide to ms IN SQL
    // (integer division; the result fits a JS number safely). Still explicit metadata columns,
    // no content column, no SELECT *.
    spanRows = db.query(
      "SELECT session_id, start_time_unix_nano / 1000000 AS start_ms, attributes FROM spans ORDER BY session_id, start_time_unix_nano",
    );
  } catch {
    db.close();
    return emptyScan("schema_mismatch");
  }
  db.close();

  const bySession = new Map<string, ValidEvent[]>();
  let unknownLines = 0;
  let watermark: number | null = null;

  for (const row of spanRows) {
    const tsMs = row.start_ms;
    if (isFiniteNumber(tsMs) && (watermark === null || tsMs > watermark)) watermark = tsMs;

    let attrs: Record<string, unknown>;
    try {
      attrs = typeof row.attributes === "string" ? (JSON.parse(row.attributes) as Record<string, unknown>) : {};
    } catch {
      attrs = {};
    }

    // Session id: prefer the dedicated column, fall back to the OTel attribute.
    let sessionId = typeof row.session_id === "string" && row.session_id ? row.session_id : null;
    if (!sessionId) {
      const attrSid = attrs[OTEL_USAGE_ATTRS.sessionId];
      sessionId = typeof attrSid === "string" && attrSid ? attrSid : null;
    }

    const inputRaw = attrs[OTEL_USAGE_ATTRS.input];
    const outputRaw = attrs[OTEL_USAGE_ATTRS.output];
    // REAL COUNTERS ONLY: a span with no session linkage, no parseable timestamp, or
    // non-numeric core token counters is dropped entirely and counted as drift.
    if (!sessionId || !isFiniteNumber(tsMs) || !isFiniteNumber(inputRaw) || !isFiniteNumber(outputRaw)) {
      unknownLines++;
      continue;
    }

    const tokens: TokenCounts = {
      input: Math.max(0, inputRaw),
      output: Math.max(0, outputRaw),
      cacheRead: Math.max(0, isFiniteNumber(attrs[OTEL_USAGE_ATTRS.cacheRead]) ? (attrs[OTEL_USAGE_ATTRS.cacheRead] as number) : 0),
      cacheCreation: Math.max(0, isFiniteNumber(attrs[OTEL_USAGE_ATTRS.cacheWrite]) ? (attrs[OTEL_USAGE_ATTRS.cacheWrite] as number) : 0),
    };
    const reasoningRaw = attrs[OTEL_USAGE_ATTRS.reasoning];
    const thinkingTokens = Math.max(0, isFiniteNumber(reasoningRaw) ? reasoningRaw : 0);
    const modelRaw = attrs[OTEL_USAGE_ATTRS.model];
    const model = typeof modelRaw === "string" && modelRaw ? modelRaw : "unknown";

    const event: ValidEvent = { ts: tsMs, model, tokens, thinkingTokens };
    const bucket = bySession.get(sessionId);
    if (bucket) bucket.push(event);
    else bySession.set(sessionId, [event]);
  }

  return {
    sessions: foldCopilotSessions(state, bySession, new Map()),
    skipReason: null,
    unknownLines,
    totalLines: spanRows.length,
    watermark,
  };
}

/**
 * Summarize the whole Copilot corpus (one row per session with at least one surviving
 * assistant_usage_events row -- a session with zero events, or every event dropped as
 * drift, produces NO SessionSummary, per file header). Does NOT check
 * `isOfficialCopilotCli` itself -- that gate is the CALLER's responsibility (mirrors
 * grok.ts/pi.ts/hermes.ts's split). NEVER throws for an environmental reason (soft-skip
 * contract, file header).
 *
 * L5b store-preference (landscape S4): when the richer OTel `agent-traces.db` is present AND
 * READABLE, it is used and the `session-store.db` mirror is SKIPPED WHOLESALE (never
 * cross-store deduped -- the codeburn rule: skip a mirror, do not merge it). An OTel store
 * that exists but FAILS to read (corrupt file, locked, wrong schema) falls back to
 * `session-store.db` -- a read failure on the preferred store must never zero a machine's
 * working capture (review blocker fix). The fallback still SELECTS one store; it never
 * merges two. When OTel is absent, `session-store.db` is read exactly as before. If BOTH
 * fail, the OTel skip reason is reported (the preferred store's failure is the primary
 * signal); soft-skip contract throughout.
 */
export function scanCopilotCorpus(state: TrackerState, home: string = copilotHome()): CopilotCorpusScan {
  if (existsSync(copilotOtelDbPath(home))) {
    const otel = scanCopilotOtelTraces(state, home);
    if (otel.skipReason === null) return otel;
    const fallback = scanCopilotSessionStore(state, home);
    return fallback.skipReason === null ? fallback : otel;
  }
  return scanCopilotSessionStore(state, home);
}

/** The `session-store.db` scan pass, verbatim (extracted so the OTel read-failure
 * fallback above can select it as a whole store — never merged with the OTel scan). */
function scanCopilotSessionStore(state: TrackerState, home: string): CopilotCorpusScan {
  const dbPath = copilotDbPath(home);
  const db = openSqliteReadOnly(dbPath);
  if (!db.available) return emptyScan(db.reason);

  let sessionRows: SqliteRow[];
  let eventRows: SqliteRow[];
  try {
    sessionRows = db.query("SELECT id, cwd FROM sessions");
    eventRows = db.query(
      "SELECT session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at FROM assistant_usage_events ORDER BY session_id, turn_index",
    );
  } catch {
    db.close();
    return emptyScan("schema_mismatch");
  }
  db.close(); // one scan pass, then release the handle (sqlite.ts's discipline)

  const cwdBySession = new Map<string, string>();
  for (const row of sessionRows) {
    if (typeof row.id === "string" && row.id && typeof row.cwd === "string" && row.cwd) {
      cwdBySession.set(row.id, row.cwd);
    }
  }

  const bySession = new Map<string, ValidEvent[]>();
  let unknownLines = 0;
  let watermark: number | null = null;

  for (const row of eventRows) {
    const sessionId = row.session_id;
    const inputRaw = row.input_tokens;
    const outputRaw = row.output_tokens;
    const createdAtRaw = row.created_at;
    const tsMs = typeof createdAtRaw === "string" ? Date.parse(createdAtRaw) : NaN;

    // Watermark advances off ANY row with a parseable timestamp, even one this pass
    // otherwise drops as drift -- so a stuck/malformed row can't stall the cursor
    // forever (the exact hermes.ts rule, applied at event grain here).
    if (Number.isFinite(tsMs) && (watermark === null || tsMs > watermark)) watermark = tsMs;

    // REAL COUNTERS ONLY: an event with no session linkage, no parseable timestamp, or
    // non-numeric core token counters is dropped entirely -- never estimated, never
    // partially credited (file header). Counted as drift instead.
    if (
      typeof sessionId !== "string" ||
      !sessionId ||
      !Number.isFinite(tsMs) ||
      !isFiniteNumber(inputRaw) ||
      !isFiniteNumber(outputRaw)
    ) {
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
    const model = typeof row.model === "string" && row.model ? row.model : "unknown";

    const event: ValidEvent = { ts: tsMs, model, tokens, thinkingTokens };
    const bucket = bySession.get(sessionId);
    if (bucket) bucket.push(event);
    else bySession.set(sessionId, [event]);
  }

  return {
    sessions: foldCopilotSessions(state, bySession, cwdBySession),
    skipReason: null,
    unknownLines,
    totalLines: eventRows.length,
    watermark,
  };
}

/** Thin wrapper matching hermes.ts's `summarizeHermesCorpus(state, home)` shape, for
 * call sites that only need the sessions array. */
export function summarizeCopilotCorpus(state: TrackerState, home: string = copilotHome()): SessionSummary[] {
  return scanCopilotCorpus(state, home).sessions;
}
