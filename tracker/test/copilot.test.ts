/**
 * GitHub Copilot CLI capture tests. Every fixture DB is built with `node:sqlite` itself
 * against the REAL schema confirmed on a live `~/.copilot/session-store.db` (see
 * src/copilot.ts's header — this schema was read off an actual install, not
 * source/docs-derived). Every corpus-level test sets DF_COPILOT_HOME to a temp fixture
 * dir (hermeticity) — never reads this machine's real ~/.copilot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  copilotHome,
  copilotDbPath,
  isOfficialCopilotCli,
  scanCopilotCorpus,
  summarizeCopilotCorpus,
} from "../src/copilot.ts";
import type { TrackerState } from "../src/config.ts";

const STATE = { repoHmacKey: "test-key", gapMs: 5 * 60_000 } as unknown as TrackerState;

// ---------------------------------------------------------------------------
// Fixture DB builder -- the verbatim schema confirmed against a real install
// (PRAGMA table_info, read 2026-07-15; see src/copilot.ts's header).
// ---------------------------------------------------------------------------

function sqliteModule(): { DatabaseSync: new (p: string, o?: object) => any } {
  return (process as unknown as { getBuiltinModule: (id: string) => any }).getBuiltinModule("node:sqlite");
}

function makeFullSchemaDb(dir: string, fileName = "session-store.db"): { path: string; db: any } {
  const path = join(dir, fileName);
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      repository TEXT,
      host_type TEXT,
      branch TEXT,
      summary TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      turn_index INTEGER,
      agent_id TEXT,
      parent_tool_call_id TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      total_nano_aiu INTEGER,
      request_multiplier REAL,
      duration_ms INTEGER,
      time_to_first_token_ms INTEGER,
      inter_token_latency_ms INTEGER,
      initiator TEXT,
      api_endpoint TEXT,
      reasoning_effort TEXT,
      finish_reason TEXT,
      content_filter_triggered INTEGER,
      token_details_json TEXT,
      created_at TEXT
    );
  `);
  return { path, db };
}

interface SessionRow {
  id: string;
  cwd?: string | null;
  summary?: string | null;
}

function insertSession(db: any, r: SessionRow): void {
  db.prepare(`INSERT INTO sessions (id, cwd, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    r.id,
    r.cwd ?? null,
    r.summary ?? null,
    "2026-07-15T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
  );
}

interface EventRow {
  sessionId: string;
  turnIndex: number;
  model?: string | null;
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  reasoning?: number | null;
  createdAt: string | null;
}

function insertEvent(db: any, r: EventRow): void {
  db.prepare(
    `INSERT INTO assistant_usage_events
      (session_id, turn_index, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.sessionId,
    r.turnIndex,
    r.model === undefined ? "gpt-5-mini" : r.model,
    r.input === undefined ? null : r.input,
    r.output === undefined ? null : r.output,
    r.cacheRead === undefined ? 0 : r.cacheRead,
    r.cacheWrite === undefined ? 0 : r.cacheWrite,
    r.reasoning === undefined ? 0 : r.reasoning,
    r.createdAt,
  );
}

// ---------------------------------------------------------------------------
// isOfficialCopilotCli -- structural fingerprint
// ---------------------------------------------------------------------------

test("isOfficialCopilotCli: no ~/.copilot at all -> refuse", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-none-"));
  try {
    assert.equal(isOfficialCopilotCli(home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("isOfficialCopilotCli: correct assistant_usage_events shape -> accept; missing a required column -> refuse", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-fp-"));
  try {
    const { db } = makeFullSchemaDb(home);
    db.close();
    assert.equal(isOfficialCopilotCli(home), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const wrongShape = mkdtempSync(join(tmpdir(), "df-copilot-wrongshape-"));
  try {
    const { DatabaseSync } = sqliteModule();
    const db = new DatabaseSync(join(wrongShape, "session-store.db"));
    // assistant_usage_events missing reasoning_tokens/cache_write_tokens -- a plausible
    // renamed-schema or unrelated-tool collision, either way not our documented shape.
    db.exec(`CREATE TABLE assistant_usage_events (session_id TEXT, turn_index INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, created_at TEXT)`);
    db.close();
    assert.equal(isOfficialCopilotCli(wrongShape), false);
  } finally {
    rmSync(wrongShape, { recursive: true, force: true });
  }

  const noTable = mkdtempSync(join(tmpdir(), "df-copilot-notable-"));
  try {
    const { DatabaseSync } = sqliteModule();
    const db = new DatabaseSync(join(noTable, "session-store.db"));
    db.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL)`);
    db.close();
    assert.equal(isOfficialCopilotCli(noTable), false);
  } finally {
    rmSync(noTable, { recursive: true, force: true });
  }
});

test("isOfficialCopilotCli: a corrupt db file refuses (open_failed) rather than throwing", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-corrupt-"));
  try {
    writeFileSync(join(home, "session-store.db"), "not a sqlite file at all");
    assert.equal(isOfficialCopilotCli(home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scanCopilotCorpus -- soft-skip / absent home / malformed db
// ---------------------------------------------------------------------------

test("scanCopilotCorpus: absent home -> file_missing skip, never throws, no sessions", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-absent-"));
  try {
    const missing = join(home, "does-not-exist");
    const scan = scanCopilotCorpus(STATE, missing);
    assert.deepEqual(scan.sessions, []);
    assert.equal(scan.skipReason, "file_missing");
    assert.equal(scan.watermark, null);
    assert.equal(scan.unknownLines, 0);
    assert.equal(scan.totalLines, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanCopilotCorpus: a directory masquerading as the db file fails to open (open_failed), never a crash", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-dirasdb-"));
  try {
    mkdirSync(join(home, "session-store.db"));
    const scan = scanCopilotCorpus(STATE, home);
    assert.deepEqual(scan.sessions, []);
    assert.equal(scan.skipReason, "open_failed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanCopilotCorpus: assistant_usage_events table missing entirely -> schema_mismatch soft-fail, not a throw", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-schemamismatch-"));
  try {
    const { DatabaseSync } = sqliteModule();
    const db = new DatabaseSync(join(home, "session-store.db"));
    db.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL)`);
    db.close();
    const scan = scanCopilotCorpus(STATE, home);
    assert.deepEqual(scan.sessions, []);
    assert.equal(scan.skipReason, "schema_mismatch");
    assert.equal(scan.watermark, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanCopilotCorpus: a renamed/dropped column trips schema_mismatch even when the table exists", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-renamedcol-"));
  try {
    const { DatabaseSync } = sqliteModule();
    const db = new DatabaseSync(join(home, "session-store.db"));
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT);
      CREATE TABLE assistant_usage_events (session_id TEXT, turn_index INTEGER, model TEXT, in_tok INTEGER, output_tokens INTEGER, created_at TEXT);
    `);
    db.close();
    const scan = scanCopilotCorpus(STATE, home);
    assert.equal(scan.skipReason, "schema_mismatch");
    assert.deepEqual(scan.sessions, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scanCopilotCorpus -- token fold, reasoning/cache mapping, zero-event sessions
// ---------------------------------------------------------------------------

test("scanCopilotCorpus: multi-turn multi-model token fold, reasoning -> thinkingTokens, cache token capture", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-fold-"));
  try {
    const { db } = makeFullSchemaDb(home);
    insertSession(db, { id: "sess-a", cwd: "C:\\Users\\m\\proj" });
    insertEvent(db, {
      sessionId: "sess-a",
      turnIndex: 0,
      model: "gpt-5-mini",
      input: 32649,
      output: 115,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 64,
      createdAt: "2026-07-15T18:32:11.818Z",
    });
    insertEvent(db, {
      sessionId: "sess-a",
      turnIndex: 1,
      model: "claude-opus-4-8",
      input: 1000,
      output: 200,
      cacheRead: 300,
      cacheWrite: 50,
      reasoning: 10,
      createdAt: "2026-07-15T18:33:00.000Z",
    });
    db.close();

    const scan = scanCopilotCorpus(STATE, home);
    assert.equal(scan.skipReason, null);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.totalLines, 2);
    assert.equal(scan.unknownLines, 0);

    const s = scan.sessions[0];
    assert.equal(s.tool, "copilot");
    assert.equal(s.toolSessionId, "sess-a");
    assert.equal(s.model, "claude-opus-4-8", "primary model = last event's model (turn_index order)");
    assert.deepEqual(s.tokens, { input: 33649, output: 315, cacheRead: 300, cacheCreation: 50 }, "tokens fold across both turns");
    assert.equal(s.thinkingTokens, 74, "reasoning_tokens summed, mapped to thinkingTokens, never added to output");
    assert.equal(s.models.length, 2, "per-model buckets, one per distinct model");
    const byModel = new Map(s.models.map((m) => [m.id, m]));
    assert.deepEqual(byModel.get("gpt-5-mini"), { id: "gpt-5-mini", input: 32649, output: 115, cacheRead: 0, cacheCreation: 0 });
    assert.deepEqual(byModel.get("claude-opus-4-8"), { id: "claude-opus-4-8", input: 1000, output: 200, cacheRead: 300, cacheCreation: 50 });
    assert.equal(s.entryPoint, "cli");
    assert.equal(s.cwd, "C:\\Users\\m\\proj");
    assert.ok(s.repoHash, "repoHash derives from the cwd basename");
    assert.equal(s.skills, undefined);
    assert.equal(s.agents, undefined);
    assert.equal(s.messageCount, 2, "one row per assistant_usage_events event");
    assert.equal(s.turns, 0, "no human-turn signal in this schema -- see header");
    assert.equal(s.longestLoopMs, 0);
    assert.equal(s.days, undefined, "both events land on the same UTC day");

    // Determinism: identical re-scan -> identical records.
    assert.deepEqual(scanCopilotCorpus(STATE, home), scan);
    assert.deepEqual(summarizeCopilotCorpus(STATE, home), scan.sessions);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanCopilotCorpus: a session with NO usage events at all produces no SessionSummary (real corpus rule)", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-noevents-"));
  try {
    const { db } = makeFullSchemaDb(home);
    // Two folder-trust first-run sessions, exactly like the real machine's corpus --
    // rows exist in `sessions` but nothing in `assistant_usage_events`.
    insertSession(db, { id: "sess-trust-1", cwd: "C:\\" });
    insertSession(db, { id: "sess-trust-2", cwd: "C:\\" });
    db.close();

    const scan = scanCopilotCorpus(STATE, home);
    assert.equal(scan.skipReason, null);
    assert.deepEqual(scan.sessions, [], "no events -> no SessionSummary for either session");
    assert.equal(scan.totalLines, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanCopilotCorpus: a session whose every event is dropped as drift also produces no SessionSummary", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-alldrift-"));
  try {
    const { db } = makeFullSchemaDb(home);
    insertSession(db, { id: "sess-baddata" });
    // NULL input/output tokens -- must not be estimated, must not synthesize a session.
    insertEvent(db, { sessionId: "sess-baddata", turnIndex: 0, input: null, output: null, createdAt: "2026-07-15T10:00:00.000Z" });
    db.close();

    const scan = scanCopilotCorpus(STATE, home);
    assert.deepEqual(scan.sessions, []);
    assert.equal(scan.unknownLines, 1);
    assert.equal(scan.totalLines, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanCopilotCorpus: NULL session_id / unparseable created_at rows are dropped and counted as drift, without sinking a healthy sibling", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-mixeddrift-"));
  try {
    const { db } = makeFullSchemaDb(home);
    insertSession(db, { id: "sess-ok" });
    insertEvent(db, { sessionId: "sess-ok", turnIndex: 0, input: 5, output: 5, createdAt: "2026-07-15T10:00:00.000Z" });
    // Bad session_id (NULL).
    db.prepare(
      `INSERT INTO assistant_usage_events (session_id, turn_index, model, input_tokens, output_tokens, created_at) VALUES (NULL, 0, 'm', 1, 1, ?)`,
    ).run("2026-07-15T10:01:00.000Z");
    // Bad created_at (unparseable).
    insertEvent(db, { sessionId: "sess-ok", turnIndex: 1, input: 5, output: 5, createdAt: "not-a-date" });
    db.close();

    const scan = scanCopilotCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.sessions[0].toolSessionId, "sess-ok");
    assert.deepEqual(scan.sessions[0].tokens, { input: 5, output: 5, cacheRead: 0, cacheCreation: 0 }, "only the one valid event counted");
    assert.equal(scan.unknownLines, 2);
    assert.equal(scan.totalLines, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanCopilotCorpus: missing model falls back to 'unknown' WITHOUT tripping drift (tokens never dropped for a missing model)", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-nomodel-"));
  try {
    const { db } = makeFullSchemaDb(home);
    insertSession(db, { id: "sess-nomodel" });
    insertEvent(db, { sessionId: "sess-nomodel", turnIndex: 0, model: null, input: 10, output: 5, createdAt: "2026-07-15T10:00:00.000Z" });
    db.close();

    const scan = scanCopilotCorpus(STATE, home);
    assert.equal(scan.unknownLines, 0, "a missing model is not drift");
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.sessions[0].model, "unknown");
    assert.deepEqual(scan.sessions[0].tokens, { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// days[] conservation across a midnight-spanning session
// ---------------------------------------------------------------------------

test("scanCopilotCorpus: days[] conserves exactly across a UTC-midnight-spanning session, with per-day model attribution", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-midnight-"));
  try {
    const { db } = makeFullSchemaDb(home);
    insertSession(db, { id: "sess-midnight", cwd: "/home/m/proj" });
    // Day 1: model-a.
    insertEvent(db, { sessionId: "sess-midnight", turnIndex: 0, model: "model-a", input: 1000, output: 200, cacheRead: 300, cacheWrite: 50, reasoning: 5, createdAt: "2026-07-12T23:00:00.000Z" });
    insertEvent(db, { sessionId: "sess-midnight", turnIndex: 1, model: "model-a", input: 200, output: 40, createdAt: "2026-07-12T23:30:00.000Z" });
    // Day 2: model-b.
    insertEvent(db, { sessionId: "sess-midnight", turnIndex: 2, model: "model-b", input: 500, output: 100, createdAt: "2026-07-13T00:05:00.000Z" });
    db.close();

    const scan = scanCopilotCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    const s = scan.sessions[0];

    assert.ok(s.days && s.days.length === 2, "session spans a UTC midnight");
    const days = s.days!;
    assert.deepEqual(days.map((d) => d.day), ["2026-07-12", "2026-07-13"]);

    let sumActive = 0, sumIdle = 0;
    const sumTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const d of days) {
      sumActive += d.activeMs;
      sumIdle += d.idleMs;
      sumTokens.input += d.tokens.input;
      sumTokens.output += d.tokens.output;
      sumTokens.cacheRead += d.tokens.cacheRead;
      sumTokens.cacheCreation += d.tokens.cacheCreation;
    }
    assert.deepEqual(sumTokens, s.tokens, "day-slice tokens conserve EXACTLY to the session total (identity, not tolerance)");
    assert.equal(sumActive, s.activeMs, "day-slice activeMs conserves exactly");
    assert.equal(sumIdle, s.idleMs, "day-slice idleMs conserves exactly");

    assert.equal(days[0].models?.length, 1);
    assert.equal(days[0].models?.[0]?.id, "model-a");
    assert.deepEqual(days[0].tokens, { input: 1200, output: 240, cacheRead: 300, cacheCreation: 50 });
    assert.equal(days[1].models?.length, 1);
    assert.equal(days[1].models?.[0]?.id, "model-b");
    assert.deepEqual(days[1].tokens, { input: 500, output: 100, cacheRead: 0, cacheCreation: 0 });

    // The full session total still folds across both days, unaffected by slicing.
    assert.deepEqual(s.tokens, { input: 1700, output: 340, cacheRead: 300, cacheCreation: 50 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanCopilotCorpus: a single-day session never emits days[] (byte-identity with the pre-slice digest)", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-singleday-"));
  try {
    const { db } = makeFullSchemaDb(home);
    insertSession(db, { id: "sess-single" });
    insertEvent(db, { sessionId: "sess-single", turnIndex: 0, input: 10, output: 5, createdAt: "2026-07-15T10:00:00.000Z" });
    insertEvent(db, { sessionId: "sess-single", turnIndex: 1, input: 10, output: 5, createdAt: "2026-07-15T10:05:00.000Z" });
    db.close();

    const scan = scanCopilotCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.sessions[0].days, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// watermark
// ---------------------------------------------------------------------------

test("scanCopilotCorpus: watermark is the max event created_at (ms) across scanned rows, including drift rows", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-watermark-"));
  try {
    const { db } = makeFullSchemaDb(home);
    insertSession(db, { id: "sess-early" });
    insertEvent(db, { sessionId: "sess-early", turnIndex: 0, input: 1, output: 1, createdAt: "2026-07-01T00:00:00.000Z" });
    // A LATER row has unusable tokens (drift) but a valid created_at -- watermark must
    // still advance past it so the caller doesn't re-scan it forever expecting a fix.
    insertEvent(db, { sessionId: "sess-early", turnIndex: 1, input: null, output: null, createdAt: "2026-07-05T00:00:00.000Z" });
    db.close();

    const scan = scanCopilotCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.unknownLines, 1);
    assert.equal(scan.watermark, Date.parse("2026-07-05T00:00:00.000Z"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Hermeticity
// ---------------------------------------------------------------------------

test("scanCopilotCorpus: hermetic via DF_COPILOT_HOME -- never reads the real machine's ~/.copilot", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-env-"));
  const prev = process.env.DF_COPILOT_HOME;
  try {
    const { db } = makeFullSchemaDb(home);
    insertSession(db, { id: "sess-env" });
    insertEvent(db, { sessionId: "sess-env", turnIndex: 0, input: 1, output: 1, createdAt: "2026-07-15T00:00:00.000Z" });
    db.close();
    process.env.DF_COPILOT_HOME = home;
    assert.equal(copilotHome(), home);
    assert.equal(copilotDbPath(), join(home, "session-store.db"));
    const scan = scanCopilotCorpus(STATE); // no explicit home -- must resolve via the env var
    assert.equal(scan.sessions.length, 1);
  } finally {
    if (prev === undefined) delete process.env.DF_COPILOT_HOME;
    else process.env.DF_COPILOT_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("copilotHome: DF_COPILOT_HOME overrides; default is ~/.copilot", () => {
  const prevDf = process.env.DF_COPILOT_HOME;
  try {
    process.env.DF_COPILOT_HOME = join(tmpdir(), "df-wins");
    assert.equal(copilotHome(), join(tmpdir(), "df-wins"));
    delete process.env.DF_COPILOT_HOME;
    assert.equal(copilotHome(), join(homedir(), ".copilot"));
  } finally {
    if (prevDf === undefined) delete process.env.DF_COPILOT_HOME;
    else process.env.DF_COPILOT_HOME = prevDf;
  }
});

// ---------------------------------------------------------------------------
// Privacy rail: `summary` is never selected (mirrors opencode's `title` discipline)
// ---------------------------------------------------------------------------

test("scanCopilotCorpus: a session with a `summary` column present still scans fine -- content column is never touched", () => {
  const home = mkdtempSync(join(tmpdir(), "df-copilot-summary-"));
  try {
    const { db } = makeFullSchemaDb(home);
    insertSession(db, { id: "sess-summary", summary: "user asked me to refactor the auth module and fix a bug in login.ts" });
    insertEvent(db, { sessionId: "sess-summary", turnIndex: 0, input: 10, output: 5, createdAt: "2026-07-15T00:00:00.000Z" });
    db.close();

    const scan = scanCopilotCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    // No field on SessionSummary carries the summary text -- the type itself has no slot
    // for it, so a leak would show up as an unexpected extra property.
    const keys = Object.keys(scan.sessions[0]);
    assert.ok(!keys.some((k) => k.toLowerCase().includes("summary")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
