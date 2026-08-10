/**
 * Hermes agent (Nous Research) capture tests. Every fixture DB is built with
 * `node:sqlite` itself against the SOURCE-VERIFIED schema documented in src/hermes.ts's
 * header (hermes_state.py's CREATE TABLE statements, fetched 2026-07-13) -- no real
 * ~/.hermes install exists on this machine (or in this repo) and none is read here.
 * Every corpus-level test sets DF_HERMES_HOME to a temp fixture dir (hermeticity).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  hermesHome,
  hermesDbPath,
  isOfficialHermesCli,
  scanHermesCorpus,
  summarizeHermesCorpus,
} from "../src/hermes.ts";
import type { TrackerState } from "../src/config.ts";

const STATE = { repoHmacKey: "test-key", gapMs: 5 * 60_000 } as unknown as TrackerState;

// ---------------------------------------------------------------------------
// Fixture DB builder -- the verbatim schema from hermes_state.py's CREATE TABLE
// statements (source-verified subset: every column src/hermes.ts reads, plus enough
// NOT NULL scaffolding to insert realistic rows).
// ---------------------------------------------------------------------------

function sqliteModule(): { DatabaseSync: new (p: string, o?: object) => any } {
  return (process as unknown as { getBuiltinModule: (id: string) => any }).getBuiltinModule("node:sqlite");
}

function makeFullSchemaDb(dir: string, fileName = "state.db"): { path: string; db: any } {
  const path = join(dir, fileName);
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      user_id TEXT,
      model TEXT,
      model_config TEXT,
      system_prompt TEXT,
      parent_session_id TEXT,
      started_at REAL NOT NULL,
      ended_at REAL,
      end_reason TEXT,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cwd TEXT,
      title TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL,
      content TEXT,
      timestamp REAL NOT NULL,
      token_count INTEGER
    );
  `);
  return { path, db };
}

interface SessionRow {
  id: string;
  source?: string;
  model?: string | null;
  startedAt: number; // unix seconds
  endedAt?: number | null; // unix seconds
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  reasoning?: number | null;
  cwd?: string | null;
  parentSessionId?: string | null;
}

function insertSession(db: any, r: SessionRow): void {
  db.prepare(
    `INSERT INTO sessions
      (id, source, model, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cwd, parent_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id,
    r.source ?? "cli",
    r.model ?? null,
    r.startedAt,
    r.endedAt ?? null,
    r.input === undefined ? 0 : r.input,
    r.output === undefined ? 0 : r.output,
    r.cacheRead === undefined ? 0 : r.cacheRead,
    r.cacheWrite === undefined ? 0 : r.cacheWrite,
    r.reasoning === undefined ? 0 : r.reasoning,
    r.cwd ?? null,
    r.parentSessionId ?? null,
  );
}

function insertMessage(db: any, sessionId: string, role: string, ts: number): void {
  db.prepare(`INSERT INTO messages (session_id, role, timestamp) VALUES (?, ?, ?)`).run(sessionId, role, ts);
}

// ---------------------------------------------------------------------------
// isOfficialHermesCli -- structural fingerprint
// ---------------------------------------------------------------------------

test("isOfficialHermesCli: no ~/.hermes at all -> refuse", () => {
  const home = mkdtempSync(join(tmpdir(), "df-hermes-none-"));
  try {
    assert.equal(isOfficialHermesCli(home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("isOfficialHermesCli: correct sessions shape -> accept; missing a required column -> refuse", () => {
  const home = mkdtempSync(join(tmpdir(), "df-hermes-fp-"));
  try {
    const { db } = makeFullSchemaDb(home);
    db.close();
    assert.equal(isOfficialHermesCli(home), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const wrongShape = mkdtempSync(join(tmpdir(), "df-hermes-wrongshape-"));
  try {
    const { DatabaseSync } = sqliteModule();
    const db = new DatabaseSync(join(wrongShape, "state.db"));
    // A "sessions" table missing reasoning_tokens/cache_write_tokens -- a plausible
    // renamed-schema or unrelated-tool collision, either way not our documented shape.
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL, input_tokens INTEGER, output_tokens INTEGER)`);
    db.close();
    assert.equal(isOfficialHermesCli(wrongShape), false);
  } finally {
    rmSync(wrongShape, { recursive: true, force: true });
  }

  const noTable = mkdtempSync(join(tmpdir(), "df-hermes-notable-"));
  try {
    const { DatabaseSync } = sqliteModule();
    const db = new DatabaseSync(join(noTable, "state.db"));
    db.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL)`);
    db.close();
    assert.equal(isOfficialHermesCli(noTable), false);
  } finally {
    rmSync(noTable, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scanHermesCorpus -- soft-skip / absent home
// ---------------------------------------------------------------------------

test("scanHermesCorpus: absent home -> file_missing skip, never throws, no sessions", () => {
  const home = mkdtempSync(join(tmpdir(), "df-hermes-absent-"));
  try {
    const missing = join(home, "does-not-exist");
    const scan = scanHermesCorpus(STATE, missing);
    assert.deepEqual(scan.sessions, []);
    assert.equal(scan.skipReason, "file_missing");
    assert.equal(scan.watermark, null);
    assert.equal(scan.unknownLines, 0);
    assert.equal(scan.totalLines, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanHermesCorpus: sessions table missing entirely -> schema_mismatch soft-fail, not a throw", () => {
  const home = mkdtempSync(join(tmpdir(), "df-hermes-schemamismatch-"));
  try {
    const { DatabaseSync } = sqliteModule();
    const db = new DatabaseSync(join(home, "state.db"));
    db.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL)`);
    db.close();
    const scan = scanHermesCorpus(STATE, home);
    assert.deepEqual(scan.sessions, []);
    assert.equal(scan.skipReason, "schema_mismatch");
    assert.equal(scan.watermark, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanHermesCorpus: a renamed/dropped column trips schema_mismatch even when the table exists", () => {
  const home = mkdtempSync(join(tmpdir(), "df-hermes-renamedcol-"));
  try {
    const { DatabaseSync } = sqliteModule();
    const db = new DatabaseSync(join(home, "state.db"));
    // sessions table present but reasoning_tokens renamed -- our SELECT names it explicitly.
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, started_at REAL NOT NULL,
        ended_at REAL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, thinking_tokens INTEGER, cwd TEXT
      );
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, timestamp REAL NOT NULL);
    `);
    db.close();
    const scan = scanHermesCorpus(STATE, home);
    assert.equal(scan.skipReason, "schema_mismatch");
    assert.deepEqual(scan.sessions, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scanHermesCorpus -- full happy-path fold
// ---------------------------------------------------------------------------

test("scanHermesCorpus: session-grain token fold, model/entryPoint/cwd mapping, message-driven activity+turns", () => {
  const home = mkdtempSync(join(tmpdir(), "df-hermes-corpus-"));
  try {
    const { db } = makeFullSchemaDb(home);
    const t0 = Math.floor(Date.UTC(2026, 6, 1, 10, 0, 0) / 1000);
    insertSession(db, {
      id: "sess-a",
      source: "CLI",
      model: "hermes-3-70b",
      startedAt: t0,
      endedAt: t0 + 60,
      input: 1000,
      output: 200,
      cacheRead: 50,
      cacheWrite: 10,
      reasoning: 30,
      cwd: "/home/m/proj",
    });
    insertMessage(db, "sess-a", "user", t0);
    insertMessage(db, "sess-a", "assistant", t0 + 10);
    insertMessage(db, "sess-a", "user", t0 + 20);
    insertMessage(db, "sess-a", "assistant", t0 + 30);
    db.close();

    const scan = scanHermesCorpus(STATE, home);
    assert.equal(scan.skipReason, null);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.totalLines, 1);
    assert.equal(scan.unknownLines, 0);

    const s = scan.sessions[0];
    assert.equal(s.tool, "hermes");
    assert.equal(s.toolSessionId, "sess-a");
    assert.equal(s.model, "hermes-3-70b");
    assert.deepEqual(s.tokens, { input: 1000, output: 200, cacheRead: 50, cacheCreation: 10 });
    assert.equal(s.thinkingTokens, 30);
    assert.equal(s.models.length, 1);
    assert.deepEqual(s.models[0], { id: "hermes-3-70b", input: 1000, output: 200, cacheRead: 50, cacheCreation: 10 });
    assert.equal(s.entryPoint, "cli", "source=CLI normalizes to cli");
    assert.equal(s.cwd, "/home/m/proj");
    assert.ok(s.repoHash, "repoHash derives from the cwd basename");
    assert.equal(s.days, undefined, "days[] is permanently absent for Hermes -- see file header");
    assert.equal(s.skills, undefined);
    assert.equal(s.agents, undefined);
    assert.equal(s.messageCount, 2, "assistant messages only");
    assert.equal(s.turns, 2, "user messages only");
    assert.equal(s.startedAt, t0 * 1000);
    assert.equal(s.endedAt, (t0 + 60) * 1000, "ended_at column wins over the derived activity endpoint");

    // Determinism: identical re-scan -> identical records.
    assert.deepEqual(scanHermesCorpus(STATE, home), scan);
    assert.deepEqual(summarizeHermesCorpus(STATE, home), scan.sessions);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanHermesCorpus: NULL input_tokens/output_tokens row is skipped and counted as drift", () => {
  const home = mkdtempSync(join(tmpdir(), "df-hermes-nulltokens-"));
  try {
    const { db } = makeFullSchemaDb(home);
    const t0 = Math.floor(Date.now() / 1000);
    // A real row, tokens NULL (e.g. a crashed/partial write) -- must not be estimated.
    db.prepare(
      `INSERT INTO sessions (id, source, model, started_at, input_tokens, output_tokens) VALUES (?, ?, ?, ?, NULL, NULL)`,
    ).run("sess-null", "cli", "m", t0);
    // A healthy row alongside it, to prove one bad row doesn't sink the whole scan.
    insertSession(db, { id: "sess-ok", startedAt: t0 + 100, input: 5, output: 5 });
    db.close();

    const scan = scanHermesCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.sessions[0].toolSessionId, "sess-ok");
    assert.equal(scan.unknownLines, 1);
    assert.equal(scan.totalLines, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanHermesCorpus: a session with zero message rows falls back to started_at/ended_at dating", () => {
  const home = mkdtempSync(join(tmpdir(), "df-hermes-nomsgs-"));
  try {
    const { db } = makeFullSchemaDb(home);
    const t0 = Math.floor(Date.UTC(2026, 6, 1, 0, 0, 0) / 1000);
    insertSession(db, { id: "sess-nomsg", startedAt: t0, endedAt: t0 + 30, input: 10, output: 5 });
    db.close();

    const scan = scanHermesCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    const s = scan.sessions[0];
    assert.equal(s.startedAt, t0 * 1000);
    assert.equal(s.endedAt, (t0 + 30) * 1000);
    assert.equal(s.messageCount, 0);
    assert.equal(s.turns, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanHermesCorpus: days[] stays absent even when a session's messages span a UTC midnight", () => {
  const home = mkdtempSync(join(tmpdir(), "df-hermes-midnight-"));
  try {
    const { db } = makeFullSchemaDb(home);
    const beforeMidnight = Math.floor(Date.UTC(2026, 6, 12, 23, 0, 0) / 1000);
    const afterMidnight = Math.floor(Date.UTC(2026, 6, 13, 0, 30, 0) / 1000);
    insertSession(db, { id: "sess-midnight", startedAt: beforeMidnight, endedAt: afterMidnight, input: 500, output: 100 });
    insertMessage(db, "sess-midnight", "user", beforeMidnight);
    insertMessage(db, "sess-midnight", "assistant", afterMidnight);
    db.close();

    const scan = scanHermesCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    const s = scan.sessions[0];
    // A genuinely multi-day session by real timestamps, per the fixture -- confirm the
    // gap gets recorded loudly rather than silently smeared into an invented slice.
    assert.notEqual(
      new Date(s.startedAt).toISOString().slice(0, 10),
      new Date(s.endedAt).toISOString().slice(0, 10),
      "sanity: this fixture really does cross a UTC midnight",
    );
    assert.equal(s.days, undefined, "tokens cannot be honestly split per day -- days[] stays absent, permanently, for Hermes v1");
    assert.deepEqual(s.tokens, { input: 500, output: 100, cacheRead: 0, cacheCreation: 0 }, "the full session total is still reported, just not day-sliced");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanHermesCorpus: watermark is the max started_at (ms) across scanned rows, including drift rows", () => {
  const home = mkdtempSync(join(tmpdir(), "df-hermes-watermark-"));
  try {
    const { db } = makeFullSchemaDb(home);
    const earlier = Math.floor(Date.UTC(2026, 6, 1, 0, 0, 0) / 1000);
    const later = Math.floor(Date.UTC(2026, 6, 5, 0, 0, 0) / 1000);
    insertSession(db, { id: "sess-early", startedAt: earlier, input: 1, output: 1 });
    // The LATER row has unusable tokens (drift) but a valid started_at -- watermark must
    // still advance past it so the caller doesn't re-scan it forever expecting a fix.
    db.prepare(`INSERT INTO sessions (id, source, started_at, input_tokens, output_tokens) VALUES (?, ?, ?, NULL, NULL)`).run(
      "sess-late-drift",
      "cli",
      later,
    );
    db.close();

    const scan = scanHermesCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.unknownLines, 1);
    assert.equal(scan.watermark, later * 1000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanHermesCorpus: hermetic via DF_HERMES_HOME -- never reads the real machine's ~/.hermes", () => {
  const home = mkdtempSync(join(tmpdir(), "df-hermes-env-"));
  const prev = process.env.DF_HERMES_HOME;
  try {
    const { db } = makeFullSchemaDb(home);
    insertSession(db, { id: "sess-env", startedAt: Math.floor(Date.now() / 1000), input: 1, output: 1 });
    db.close();
    process.env.DF_HERMES_HOME = home;
    assert.equal(hermesHome(), home);
    assert.equal(hermesDbPath(), join(home, "state.db"));
    const scan = scanHermesCorpus(STATE); // no explicit home -- must resolve via the env var
    assert.equal(scan.sessions.length, 1);
  } finally {
    if (prev === undefined) delete process.env.DF_HERMES_HOME;
    else process.env.DF_HERMES_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("hermesHome: mirrors the vendor's resolution -- HERMES_HOME honored, win32 default is LOCALAPPDATA\\hermes", () => {
  const prevDf = process.env.DF_HERMES_HOME;
  const prevVendor = process.env.HERMES_HOME;
  const prevLocal = process.env.LOCALAPPDATA;
  try {
    // DF_HERMES_HOME always wins (our hermetic-test/override contract).
    process.env.DF_HERMES_HOME = join(tmpdir(), "df-wins");
    process.env.HERMES_HOME = join(tmpdir(), "vendor-loses");
    assert.equal(hermesHome(), join(tmpdir(), "df-wins"));

    // Without DF_HERMES_HOME, the VENDOR env is honored (official Hermes writes there).
    delete process.env.DF_HERMES_HOME;
    assert.equal(hermesHome(), join(tmpdir(), "vendor-loses"));

    // Platform default (hermes_constants.py, read 2026-07-14): the old hardcoded
    // ~/.hermes was a confirmed Windows false negative -- official Hermes defaults to
    // %LOCALAPPDATA%\hermes on win32 and ~/.hermes on POSIX.
    delete process.env.HERMES_HOME;
    if (process.platform === "win32") {
      process.env.LOCALAPPDATA = join(tmpdir(), "local-app-data");
      assert.equal(hermesHome(), join(tmpdir(), "local-app-data", "hermes"));
      delete process.env.LOCALAPPDATA; // vendor fallback when LOCALAPPDATA is unset
      assert.equal(hermesHome(), join(homedir(), "AppData", "Local", "hermes"));
    } else {
      assert.equal(hermesHome(), join(homedir(), ".hermes"));
    }
  } finally {
    if (prevDf === undefined) delete process.env.DF_HERMES_HOME;
    else process.env.DF_HERMES_HOME = prevDf;
    if (prevVendor === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prevVendor;
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prevLocal;
  }
});

// ---------------------------------------------------------------------------
// Deprecated JSONL directory signal
// ---------------------------------------------------------------------------

test("scanHermesCorpus: legacy *.jsonl transcripts without state.db counted as a signal, never parsed", () => {
  const home = mkdtempSync(join(tmpdir(), "df-hermes-legacy-"));
  try {
    const sessionsDir = join(home, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "20250101_old.jsonl"), '{"role":"user","content":"hi"}\n');
    // The gateway routing index -- must NOT itself count as a transcript.
    writeFileSync(join(sessionsDir, "sessions.json"), "{}");

    const scan = scanHermesCorpus(STATE, home);
    assert.equal(scan.skipReason, "file_missing", "no state.db -- environmentally a plain missing-file skip");
    assert.equal(scan.legacyJsonlWithoutDb, true);
    assert.deepEqual(scan.sessions, [], "the legacy JSONL is never parsed for content");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanHermesCorpus: legacy *.jsonl alongside a REAL state.db does not set legacyJsonlWithoutDb", () => {
  const home = mkdtempSync(join(tmpdir(), "df-hermes-legacy-with-db-"));
  try {
    const { db } = makeFullSchemaDb(home);
    insertSession(db, { id: "sess-x", startedAt: Math.floor(Date.now() / 1000), input: 1, output: 1 });
    db.close();
    const sessionsDir = join(home, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "20250101_old.jsonl"), '{"role":"user","content":"hi"}\n');

    const scan = scanHermesCorpus(STATE, home);
    assert.equal(scan.skipReason, null);
    assert.equal(scan.legacyJsonlWithoutDb, false, "state.db exists -- not the drift-era case, even with stale JSONL sitting alongside it");
    assert.equal(scan.sessions.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanHermesCorpus: sessions.json alone (no .jsonl transcripts) never trips the legacy signal", () => {
  const home = mkdtempSync(join(tmpdir(), "df-hermes-routingindex-"));
  try {
    const sessionsDir = join(home, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "sessions.json"), "{}");

    const scan = scanHermesCorpus(STATE, home);
    assert.equal(scan.skipReason, "file_missing");
    assert.equal(scan.legacyJsonlWithoutDb, false, "the gateway routing index is not a transcript");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// parent_session_id: recorded nothing special -- independent records, no tree merge.
// ---------------------------------------------------------------------------

test("scanHermesCorpus: parent_session_id is never used for tree reconstruction -- parent and child are independent records", () => {
  const home = mkdtempSync(join(tmpdir(), "df-hermes-parentchild-"));
  try {
    const { db } = makeFullSchemaDb(home);
    const t0 = Math.floor(Date.UTC(2026, 6, 1, 0, 0, 0) / 1000);
    insertSession(db, { id: "sess-parent", startedAt: t0, input: 100, output: 50 });
    insertSession(db, { id: "sess-child", startedAt: t0 + 3600, input: 20, output: 10, parentSessionId: "sess-parent" });
    db.close();

    const scan = scanHermesCorpus(STATE, home);
    assert.equal(scan.sessions.length, 2, "two independent SessionSummary records -- no merge by parent_session_id");
    const parent = scan.sessions.find((s) => s.toolSessionId === "sess-parent")!;
    const child = scan.sessions.find((s) => s.toolSessionId === "sess-child")!;
    assert.deepEqual(parent.tokens, { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 });
    assert.deepEqual(child.tokens, { input: 20, output: 10, cacheRead: 0, cacheCreation: 0 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
