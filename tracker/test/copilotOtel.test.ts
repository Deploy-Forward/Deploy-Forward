/**
 * L5b RED — GitHub Copilot CLI OTel agent-traces back-port (landscape S4).
 *
 * WHY THIS EXISTS: the task premise is that Copilot ships a richer OTel `agent-traces.db`
 * store we do not read today (we read `session-store.db`'s assistant_usage_events).
 *
 * CORPUS STATUS (discovery 2026-07-23 on Marco's machine — the real corpus host):
 *   - There is NO `agent-traces.db` anywhere under ~/.copilot. The named OTel store is
 *     ABSENT on this machine.
 *   - The store we ALREADY read, ~/.copilot/session-store.db `assistant_usage_events`, is in
 *     fact the RICHEST verified per-turn source: it carries input_tokens, output_tokens,
 *     cache_read_tokens, cache_write_tokens AND reasoning_tokens per turn. The only other
 *     store found is per-session `session-state/<id>/events.jsonl`, whose `session.shutdown`
 *     event carries full per-model aggregates (modelMetrics.<model>.usage.{inputTokens,
 *     outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens}) — session-grain, not a
 *     trace db.
 *   - CONSEQUENCE: the OTel `agent-traces.db` SHAPE below is CORPUS-UNVERIFIED. It is modeled
 *     on the OpenTelemetry GenAI semantic conventions (`gen_ai.usage.input_tokens`,
 *     `gen_ai.usage.output_tokens`, `gen_ai.request.model`, plus cache/reasoning extensions),
 *     the only documented shape available. Fixtures are synthetic (fake ids/models/counts);
 *     only the attribute NAMES claim fidelity, and that carries a LOUD corpus-unverified flag
 *     to the PR. The BEHAVIORAL contract these tests lock (prefer OTel, skip the mirror,
 *     fall back to session-store) is the durable part.
 *
 * These tests import entry points that DO NOT EXIST YET (scanCopilotOtelTraces,
 * copilotOtelDbPath) so the whole file fails RED until L5b is implemented. Hermetic:
 * DF_COPILOT_HOME / the explicit home arg point at a temp fixture dir, never real ~/.copilot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scanCopilotCorpus,
  // NOT-YET-EXISTING — L5b implements these (import forces the suite RED):
  scanCopilotOtelTraces,
  copilotOtelDbPath,
} from "../src/copilot.ts";
import type { TrackerState } from "../src/config.ts";

const STATE = { repoHmacKey: "test-key", gapMs: 5 * 60_000 } as unknown as TrackerState;

function sqliteMod(): any {
  return (process as unknown as { getBuiltinModule: (id: string) => any }).getBuiltinModule("node:sqlite");
}

// ---------------------------------------------------------------------------
// session-store.db builder — the store we read today (mirror, in OTel's presence).
// Verbatim assistant_usage_events schema from src/copilot.ts's header.
// ---------------------------------------------------------------------------

function makeSessionStore(home: string): any {
  const db = new (sqliteMod().DatabaseSync)(join(home, "session-store.db"));
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_index INTEGER, agent_id TEXT,
      parent_tool_call_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
      total_nano_aiu INTEGER, request_multiplier REAL, duration_ms INTEGER,
      time_to_first_token_ms INTEGER, inter_token_latency_ms INTEGER, initiator TEXT,
      api_endpoint TEXT, reasoning_effort TEXT, finish_reason TEXT, content_filter_triggered INTEGER,
      token_details_json TEXT, created_at TEXT);
  `);
  return db;
}

function ssSession(db: any, id: string, cwd = "/home/m/proj"): void {
  db.prepare(`INSERT INTO sessions (id, cwd, created_at, updated_at) VALUES (?,?,?,?)`).run(
    id,
    cwd,
    "2026-07-15T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
  );
}

function ssEvent(
  db: any,
  sessionId: string,
  turnIndex: number,
  model: string,
  input: number,
  output: number,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO assistant_usage_events (session_id, turn_index, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at)
     VALUES (?,?,?,?,?,0,0,0,?)`,
  ).run(sessionId, turnIndex, model, input, output, createdAt);
}

// ---------------------------------------------------------------------------
// agent-traces.db builder — OTel GenAI-conventions store (CORPUS-UNVERIFIED shape).
// One row per model round-trip; usage packed as a JSON attributes blob keyed by the
// OTel GenAI semantic-convention attribute names.
// ---------------------------------------------------------------------------

function makeOtelTraces(home: string): any {
  const db = new (sqliteMod().DatabaseSync)(join(home, "agent-traces.db"));
  db.exec(`CREATE TABLE spans (
    span_id TEXT PRIMARY KEY,
    trace_id TEXT,
    session_id TEXT,
    name TEXT,
    start_time_unix_nano INTEGER,
    end_time_unix_nano INTEGER,
    attributes TEXT
  )`);
  return db;
}

interface OtelSpanOpts {
  spanId: string;
  sessionId: string;
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  startMs: number;
}

function otelSpan(db: any, o: OtelSpanOpts): void {
  const attributes = JSON.stringify({
    "gen_ai.request.model": o.model,
    "gen_ai.usage.input_tokens": o.input,
    "gen_ai.usage.output_tokens": o.output,
    "gen_ai.usage.cache_read_tokens": o.cacheRead ?? 0,
    "gen_ai.usage.cache_write_tokens": o.cacheWrite ?? 0,
    "gen_ai.usage.reasoning_tokens": o.reasoning ?? 0,
    "copilot.session.id": o.sessionId,
  });
  db.prepare(
    `INSERT INTO spans (span_id, trace_id, session_id, name, start_time_unix_nano, end_time_unix_nano, attributes)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(o.spanId, "trace-" + o.sessionId, o.sessionId, "chat", o.startMs * 1_000_000, o.startMs * 1_000_000, attributes);
}

// ---------------------------------------------------------------------------
// copilotOtelDbPath
// ---------------------------------------------------------------------------

test("copilotOtelDbPath: resolves agent-traces.db under the copilot home", () => {
  const home = mkdtempSync(join(tmpdir(), "df-cotel-path-"));
  try {
    const p = copilotOtelDbPath(home);
    assert.ok(p.startsWith(home));
    assert.ok(p.endsWith("agent-traces.db"), "the OTel store is agent-traces.db (task premise)");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scanCopilotOtelTraces — parse the OTel spans into token totals
// ---------------------------------------------------------------------------

test("scanCopilotOtelTraces: folds gen_ai.usage.* across spans into per-session token totals", () => {
  const home = mkdtempSync(join(tmpdir(), "df-cotel-fold-"));
  try {
    const db = makeOtelTraces(home);
    otelSpan(db, { spanId: "sp1", sessionId: "sess-a", model: "gpt-5-mini", input: 1000, output: 200, cacheRead: 300, cacheWrite: 50, reasoning: 64, startMs: Date.parse("2026-07-15T18:32:11.818Z") });
    otelSpan(db, { spanId: "sp2", sessionId: "sess-a", model: "gpt-5-mini", input: 500, output: 100, reasoning: 10, startMs: Date.parse("2026-07-15T18:33:00.000Z") });
    db.close();

    const scan = scanCopilotOtelTraces(STATE, home);
    assert.equal(scan.sessions.length, 1);
    const s = scan.sessions[0];
    assert.equal(s.tool, "copilot");
    assert.equal(s.toolSessionId, "sess-a");
    assert.deepEqual(s.tokens, { input: 1500, output: 300, cacheRead: 300, cacheCreation: 50 }, "gen_ai.usage.* folds across spans");
    assert.equal(s.thinkingTokens, 74, "reasoning_tokens -> thinkingTokens, never folded into output");
    assert.equal(s.entryPoint, "cli");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scanCopilotCorpus — OTel PREFERRED over session-store when both exist
// ---------------------------------------------------------------------------

test("scanCopilotCorpus: when agent-traces.db exists, the RICHER OTel counts are used (session-store is not folded on top)", () => {
  const home = mkdtempSync(join(tmpdir(), "df-cotel-prefer-"));
  try {
    // session-store.db carries a THINNER/older count for the same session id.
    const ss = makeSessionStore(home);
    ssSession(ss, "sess-a");
    ssEvent(ss, "sess-a", 0, "gpt-5-mini", 10, 5, "2026-07-15T18:32:11.818Z");
    ss.close();
    // agent-traces.db carries the richer count for the SAME session.
    const otel = makeOtelTraces(home);
    otelSpan(otel, { spanId: "sp1", sessionId: "sess-a", model: "gpt-5-mini", input: 1000, output: 200, cacheRead: 300, cacheWrite: 50, reasoning: 64, startMs: Date.parse("2026-07-15T18:32:11.818Z") });
    otel.close();

    const scan = scanCopilotCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1, "the session is counted once, never once per store");
    const s = scan.sessions[0];
    assert.equal(s.toolSessionId, "sess-a");
    assert.deepEqual(
      s.tokens,
      { input: 1000, output: 200, cacheRead: 300, cacheCreation: 50 },
      "OTel counts win; the session-store 10/5 is NOT summed on top (no cross-store double count)",
    );
    assert.equal(s.thinkingTokens, 64, "OTel reasoning count is used");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanCopilotCorpus: with OTel present, session-store is SKIPPED as a mirror (a session only in session-store is not emitted)", () => {
  const home = mkdtempSync(join(tmpdir(), "df-cotel-mirror-"));
  try {
    // session-store has a session the OTel store does NOT — the codeburn rule is SKIP the
    // mirror wholesale (never cross-store dedupe), so this session must NOT appear.
    const ss = makeSessionStore(home);
    ssSession(ss, "only-in-mirror");
    ssEvent(ss, "only-in-mirror", 0, "gpt-5-mini", 99, 99, "2026-07-15T10:00:00.000Z");
    ss.close();
    const otel = makeOtelTraces(home);
    otelSpan(otel, { spanId: "sp1", sessionId: "sess-otel", model: "gpt-5-mini", input: 5, output: 5, startMs: Date.parse("2026-07-15T11:00:00.000Z") });
    otel.close();

    const scan = scanCopilotCorpus(STATE, home);
    const ids = scan.sessions.map((s) => s.toolSessionId).sort();
    assert.deepEqual(ids, ["sess-otel"], "only OTel sessions surface; the session-store mirror is skipped entirely");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scanCopilotCorpus — FALLBACK to session-store.db exactly as today when OTel absent
// ---------------------------------------------------------------------------

test("scanCopilotCorpus: no agent-traces.db -> falls back to session-store.db exactly as today", () => {
  const home = mkdtempSync(join(tmpdir(), "df-cotel-fallback-"));
  try {
    const ss = makeSessionStore(home);
    ssSession(ss, "sess-legacy");
    ssEvent(ss, "sess-legacy", 0, "gpt-5-mini", 32649, 115, "2026-07-15T18:32:11.818Z");
    ss.close();
    // No agent-traces.db written.
    assert.ok(!existsSync(copilotOtelDbPath(home)), "precondition: OTel store absent");

    const scan = scanCopilotCorpus(STATE, home);
    assert.equal(scan.skipReason, null);
    assert.equal(scan.sessions.length, 1);
    const s = scan.sessions[0];
    assert.equal(s.toolSessionId, "sess-legacy");
    assert.deepEqual(s.tokens, { input: 32649, output: 115, cacheRead: 0, cacheCreation: 0 }, "session-store counts used verbatim when OTel is absent");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// OTel read-failure fallback (review BLOCKER fix on L5b): agent-traces.db existing
// but unreadable/corrupt must never zero a machine's Copilot capture when a fully
// working session-store.db sits beside it. The codeburn skip-a-mirror rule holds —
// fallback SELECTS one store, it never merges two.
// ---------------------------------------------------------------------------

test("scanCopilotCorpus: agent-traces.db exists but is CORRUPT -> session-store capture is used, not discarded", () => {
  const home = mkdtempSync(join(tmpdir(), "df-cotel-corrupt-"));
  try {
    const ss = makeSessionStore(home);
    ssSession(ss, "sess-working");
    ssEvent(ss, "sess-working", 0, "gpt-5-mini", 1000, 50, "2026-07-15T18:32:11.818Z");
    ss.close();
    // agent-traces.db exists but is not a SQLite database at all.
    writeFileSync(copilotOtelDbPath(home), "this is not a sqlite file");

    const scan = scanCopilotCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1, "the working session-store capture survives an OTel read failure");
    assert.equal(scan.sessions[0].toolSessionId, "sess-working");
    assert.equal(scan.skipReason, null, "a successful fallback is not a skip");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanCopilotCorpus: agent-traces.db has the WRONG SCHEMA -> session-store capture is used", () => {
  const home = mkdtempSync(join(tmpdir(), "df-cotel-schema-"));
  try {
    const ss = makeSessionStore(home);
    ssSession(ss, "sess-working");
    ssEvent(ss, "sess-working", 0, "gpt-5-mini", 2000, 80, "2026-07-15T18:32:11.818Z");
    ss.close();
    // A real SQLite db at the OTel path, but with no spans table.
    const bad = new (sqliteMod().DatabaseSync)(copilotOtelDbPath(home));
    bad.exec("CREATE TABLE not_spans (id INTEGER PRIMARY KEY);");
    bad.close();

    const scan = scanCopilotCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1, "schema mismatch on OTel falls back to the working mirror");
    assert.equal(scan.sessions[0].toolSessionId, "sess-working");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanCopilotCorpus: BOTH stores broken -> soft-skip with the OTel reason, never a throw", () => {
  const home = mkdtempSync(join(tmpdir(), "df-cotel-bothbad-"));
  try {
    writeFileSync(copilotOtelDbPath(home), "not sqlite");
    writeFileSync(join(home, "session-store.db"), "also not sqlite");

    const scan = scanCopilotCorpus(STATE, home);
    assert.equal(scan.sessions.length, 0);
    assert.ok(scan.skipReason, "a double failure reports a skip reason instead of silence");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
