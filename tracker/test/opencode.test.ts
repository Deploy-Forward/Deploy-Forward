/**
 * opencode capture tests (docs/harness-adapters-implementation.md, Wave 3).
 *
 * Every fixture db is built directly with node:sqlite (no drizzle, no vendored binary
 * fixture) matching the REAL schema confirmed from opencode's own source (src/opencode.ts's
 * header): a `session` table with cumulative `tokens_*` columns and a `message` table whose
 * only safe-to-read columns are `id`/`session_id`/`time_created`/`time_updated` (never
 * `data`). Every corpus-level test sets DF_OPENCODE_HOME to a temp fixture dir (hermeticity);
 * no test reads the real machine's opencode install.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  opencodeHome,
  opencodeDbPaths,
  isOfficialOpencodeHome,
  scanOpencodeCorpus,
  summarizeOpencodeCorpus,
  countLegacyOpencodeArtifacts,
} from "../src/opencode.ts";
import type { TrackerState } from "../src/config.ts";

const STATE = { repoHmacKey: "test-key", gapMs: 5 * 60_000 } as unknown as TrackerState;

function getSqliteMod(): any {
  return (process as unknown as { getBuiltinModule: (id: string) => any }).getBuiltinModule("node:sqlite");
}

// ---------------------------------------------------------------------------
// Fixture db builders -- match the REAL confirmed schema (session/sql.ts)
// ---------------------------------------------------------------------------

function createSchema(db: any): void {
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY,
    directory TEXT,
    title TEXT,
    model TEXT,
    cost REAL,
    tokens_input INTEGER,
    tokens_output INTEGER,
    tokens_reasoning INTEGER,
    tokens_cache_read INTEGER,
    tokens_cache_write INTEGER,
    time_created INTEGER,
    time_updated INTEGER
  )`);
  db.exec(`CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    time_created INTEGER,
    time_updated INTEGER,
    data TEXT
  )`);
}

interface SessionRow {
  id: string;
  directory?: string | null;
  title?: string;
  model?: { id: string; providerID: string; variant?: string } | null;
  cost?: number;
  input?: number | null;
  output?: number | null;
  reasoning?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  createdAt: number;
  updatedAt: number;
}

function insertSession(db: any, s: SessionRow): void {
  db.prepare(
    `INSERT INTO session (id, directory, title, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    s.id,
    s.directory ?? null,
    s.title ?? null,
    s.model ? JSON.stringify(s.model) : null,
    s.cost ?? 0,
    s.input === undefined ? 0 : s.input,
    s.output === undefined ? 0 : s.output,
    s.reasoning === undefined ? 0 : s.reasoning,
    s.cacheRead === undefined ? 0 : s.cacheRead,
    s.cacheWrite === undefined ? 0 : s.cacheWrite,
    s.createdAt,
    s.updatedAt,
  );
}

function insertMessage(db: any, id: string, sessionId: string, ts: number): void {
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`).run(
    id,
    sessionId,
    ts,
    ts,
    JSON.stringify({ role: "assistant" }), // never read by the parser; present only for realism
  );
}

function makeDb(dir: string, filename = "opencode.db"): { path: string; db: any } {
  const path = join(dir, filename);
  const db = new (getSqliteMod().DatabaseSync)(path);
  createSchema(db);
  return { path, db };
}

const T0 = Date.UTC(2026, 6, 12, 10, 0, 0); // 2026-07-12T10:00:00Z

// ---------------------------------------------------------------------------
// opencodeHome / opencodeDbPaths
// ---------------------------------------------------------------------------

test("opencodeHome: DF_OPENCODE_HOME overrides everything", () => {
  const prev = process.env.DF_OPENCODE_HOME;
  process.env.DF_OPENCODE_HOME = "/custom/opencode/home";
  try {
    assert.equal(opencodeHome(), "/custom/opencode/home");
  } finally {
    if (prev === undefined) delete process.env.DF_OPENCODE_HOME;
    else process.env.DF_OPENCODE_HOME = prev;
  }
});

test("opencodeHome: honors XDG_DATA_HOME, falls back to ~/.local/share/opencode", () => {
  // HERMETIC (fixed 2026-07-14): opencodeHome() prefers the first EXISTING candidate, so
  // asserting against a fake, nonexistent XDG path breaks the moment the real machine
  // grows a ~/.local/share/opencode dir (which is exactly what happened on the dev box).
  // The XDG leg therefore uses a REAL temp dir containing an opencode/ subdir -- an
  // existing XDG candidate wins over anything else on the machine, deterministically.
  const prevDf = process.env.DF_OPENCODE_HOME;
  const prevXdg = process.env.XDG_DATA_HOME;
  const xdgRoot = mkdtempSync(join(tmpdir(), "df-oc-xdghome-"));
  delete process.env.DF_OPENCODE_HOME;
  try {
    mkdirSync(join(xdgRoot, "opencode"), { recursive: true });
    process.env.XDG_DATA_HOME = xdgRoot;
    assert.equal(opencodeHome(), join(xdgRoot, "opencode"));
    delete process.env.XDG_DATA_HOME;
    assert.ok(opencodeHome().endsWith(join(".local", "share", "opencode")), "bare fallback matches on every platform, including Windows -- no LOCALAPPDATA branch");
  } finally {
    if (prevDf === undefined) delete process.env.DF_OPENCODE_HOME;
    else process.env.DF_OPENCODE_HOME = prevDf;
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    rmSync(xdgRoot, { recursive: true, force: true });
  }
});

test("opencodeDbPaths: finds opencode.db first, then channel-suffixed dbs, sorted; absent dir -> []", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-paths-"));
  try {
    assert.deepEqual(opencodeDbPaths(join(home, "nope")), []);
    writeFileSync(join(home, "opencode-dev.db"), "");
    writeFileSync(join(home, "opencode.db"), "");
    writeFileSync(join(home, "opencode-beta2.db"), "");
    writeFileSync(join(home, "not-a-db.txt"), "");
    const paths = opencodeDbPaths(home);
    assert.deepEqual(paths, [join(home, "opencode.db"), join(home, "opencode-beta2.db"), join(home, "opencode-dev.db")]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// isOfficialOpencodeHome -- structural fingerprint
// ---------------------------------------------------------------------------

test("isOfficialOpencodeHome: the db schema alone decides — auth.json is NOT required (zero-auth installs never create it; corpus finding 2026-07-14)", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-fp-"));
  try {
    assert.equal(isOfficialOpencodeHome(home), false, "nothing at all -> refuse");

    writeFileSync(join(home, "auth.json"), "{}");
    assert.equal(isOfficialOpencodeHome(home), false, "auth.json alone (no db) -> refuse; credentials are not sessions");
    rmSync(join(home, "auth.json"));

    const { db } = makeDb(home);
    insertSession(db, { id: "s1", createdAt: T0, updatedAt: T0 });
    db.close();
    assert.equal(isOfficialOpencodeHome(home), true, "matching schema with NO auth.json -> accept (the real zen-free-tier layout)");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("isOfficialOpencodeHome: a db missing a required column refuses", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-fp-badschema-"));
  try {
    const db = new (getSqliteMod().DatabaseSync)(join(home, "opencode.db"));
    // Missing tokens_reasoning/tokens_cache_read/tokens_cache_write -- an older or unrelated schema.
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, model TEXT, tokens_input INTEGER, tokens_output INTEGER, time_created INTEGER, time_updated INTEGER)`);
    db.close();
    assert.equal(isOfficialOpencodeHome(home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("isOfficialOpencodeHome: a corrupt db file refuses (open_failed) rather than throwing", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-fp-corrupt-"));
  try {
    writeFileSync(join(home, "opencode.db"), "not a sqlite file at all");
    assert.equal(isOfficialOpencodeHome(home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scanOpencodeCorpus -- token fold, thinking mapping, activity/turns
// ---------------------------------------------------------------------------

test("scanOpencodeCorpus: absent home -> no sessions, no unavailable marker (ordinary empty result)", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-empty-"));
  try {
    const scan = scanOpencodeCorpus(STATE, join(home, "does-not-exist"));
    assert.deepEqual(scan.sessions, []);
    assert.equal(scan.unavailable, undefined);
    assert.equal(scan.legacyFilesDetected, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeCorpus: token fold (cache_write -> cacheCreation) + reasoning -> thinkingTokens (never added to output)", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-fold-"));
  try {
    const { db } = makeDb(home);
    insertSession(db, {
      id: "s1",
      directory: "/home/m/proj",
      model: { id: "claude-sonnet", providerID: "anthropic" },
      input: 1000,
      output: 200,
      reasoning: 50,
      cacheRead: 30,
      cacheWrite: 10,
      createdAt: T0,
      updatedAt: T0 + 60_000,
    });
    insertMessage(db, "m1", "s1", T0);
    insertMessage(db, "m2", "s1", T0 + 60_000);
    db.close();

    const scan = scanOpencodeCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    const s = scan.sessions[0];
    assert.equal(s.tool, "opencode");
    assert.equal(s.toolSessionId, "s1");
    assert.deepEqual(s.tokens, { input: 1000, output: 200, cacheRead: 30, cacheCreation: 10 });
    assert.equal(s.thinkingTokens, 50, "tokens_reasoning maps to thinkingTokens");
    assert.equal(s.tokens.output, 200, "reasoning is never folded into output");
    assert.equal(s.model, "anthropic/claude-sonnet");
    assert.equal(s.models.length, 1);
    assert.deepEqual(s.models[0], { id: "anthropic/claude-sonnet", input: 1000, output: 200, cacheRead: 30, cacheCreation: 10 });
    assert.equal(s.messageCount, 2);
    assert.ok(s.repoHash, "repoHash derives from the directory basename");
    assert.equal(s.cwd, "/home/m/proj");
    assert.equal(s.days, undefined, "opencode never emits days[] -- see file header (aggregate-only schema)");
    assert.equal(s.turns, 0, "role is unreachable without touching message.data -- honestly 0, never guessed");
    assert.equal(s.longestLoopMs, 0);
    assert.equal(s.skills, undefined);
    assert.equal(s.agents, undefined);
    assert.equal(s.entryPoint, "cli");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeCorpus: multi-day activity span -- activeMs/idleMs cross the UTC midnight correctly but days[] stays undefined (never smeared)", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-multiday-"));
  try {
    const { db } = makeDb(home);
    const day1 = Date.UTC(2026, 6, 12, 23, 0, 0);
    const day2 = Date.UTC(2026, 6, 13, 0, 5, 0);
    insertSession(db, {
      id: "s-span",
      directory: "/home/m/proj",
      model: { id: "gpt-5", providerID: "openai" },
      input: 500,
      output: 100,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      createdAt: day1,
      updatedAt: day2,
    });
    insertMessage(db, "m1", "s-span", day1);
    insertMessage(db, "m2", "s-span", day2);
    db.close();

    const scan = scanOpencodeCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    const s = scan.sessions[0];
    assert.equal(s.days, undefined, "session-level aggregate tokens can't be split by day without smearing");
    assert.equal(s.startedAt, day1);
    assert.ok(s.endedAt > day2, "activity/wall time extends past the later message's own timestamp (tail credit)");
    assert.deepEqual(s.tokens, { input: 500, output: 100, cacheRead: 0, cacheCreation: 0 }, "the single aggregate total is still reported in full");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeCorpus: NULL/non-numeric token columns count as drift and are skipped, never estimated", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-nulltok-"));
  try {
    const { db } = makeDb(home);
    // A row with a NULL tokens_output (simulating a renamed/corrupted column) alongside a
    // healthy row -- the malformed row must not abort the scan.
    insertSession(db, { id: "bad", directory: "/x", input: 10, output: null as unknown as number, reasoning: 0, cacheRead: 0, cacheWrite: 0, createdAt: T0, updatedAt: T0 });
    insertSession(db, { id: "good", directory: "/y", input: 5, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, createdAt: T0, updatedAt: T0 });
    db.close();

    const scan = scanOpencodeCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1, "only the healthy row is reported");
    assert.equal(scan.sessions[0].toolSessionId, "good");
    assert.equal(scan.unknownLines, 1, "the NULL-token row counts as drift");
    assert.equal(scan.totalLines, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeCorpus: an all-zero session (real numbers, genuinely unused) is skipped without counting as drift", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-emptysess-"));
  try {
    const { db } = makeDb(home);
    insertSession(db, { id: "empty", directory: "/x", input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, createdAt: T0, updatedAt: T0 });
    db.close();
    const scan = scanOpencodeCorpus(STATE, home);
    assert.equal(scan.sessions.length, 0);
    assert.equal(scan.unknownLines, 0, "valid zeros are not drift");
    assert.equal(scan.totalLines, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeCorpus: missing/mismatched schema soft-fails with a counted signal, never a crash", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-badschema-"));
  try {
    const db = new (getSqliteMod().DatabaseSync)(join(home, "opencode.db"));
    db.exec(`CREATE TABLE unrelated (id TEXT)`); // no `session` table at all
    db.close();
    const scan = scanOpencodeCorpus(STATE, home);
    assert.deepEqual(scan.sessions, []);
    assert.equal(scan.unavailable, "schema_mismatch");
    assert.deepEqual(scan.readFailures, [join(home, "opencode.db")]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeCorpus: partial success -- one good db + one schema-mismatched db keeps the good sessions, no unavailable alarm", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-partial-"));
  try {
    const good = makeDb(home, "opencode.db");
    insertSession(good.db, { id: "ok", directory: "/x", input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, createdAt: T0, updatedAt: T0 });
    good.db.close();

    const bad = new (getSqliteMod().DatabaseSync)(join(home, "opencode-dev.db"));
    bad.exec(`CREATE TABLE unrelated (id TEXT)`);
    bad.close();

    const scan = scanOpencodeCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.sessions[0].toolSessionId, "ok");
    assert.equal(scan.unavailable, undefined, "real data came through -- no false alarm");
    assert.deepEqual(scan.readFailures, [join(home, "opencode-dev.db")]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeCorpus: a directory masquerading as the db file fails to open (open_failed), never a crash", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-corrupt-"));
  try {
    // A DIRECTORY named opencode.db: DatabaseSync's constructor throws on this (same
    // verified behavior sqlite.test.ts relies on for its own "not a database" case) --
    // unlike a garbage-content file, which node:sqlite opens lazily and only rejects at
    // first query (that path is covered by the schema-mismatch test instead).
    mkdirSync(join(home, "opencode.db"));
    const scan = scanOpencodeCorpus(STATE, home);
    assert.deepEqual(scan.sessions, []);
    assert.equal(scan.unavailable, "open_failed");
    assert.deepEqual(scan.readFailures, [join(home, "opencode.db")]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeCorpus: a garbage-content db file (not a directory) opens lazily but fails at query -- schema_mismatch, never a crash", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-garbage-"));
  try {
    writeFileSync(join(home, "opencode.db"), "garbage, not a real sqlite file");
    const scan = scanOpencodeCorpus(STATE, home);
    assert.deepEqual(scan.sessions, []);
    assert.equal(scan.unavailable, "schema_mismatch");
    assert.deepEqual(scan.readFailures, [join(home, "opencode.db")]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeCorpus: node:sqlite unavailable -> soft-skip marker, never a throw", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-nosqlite-"));
  const original = (process as unknown as { getBuiltinModule?: unknown }).getBuiltinModule;
  try {
    const { db } = makeDb(home);
    insertSession(db, { id: "s1", directory: "/x", input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, createdAt: T0, updatedAt: T0 });
    db.close();

    // Force sqliteSupported() to report false, exactly the way it probes for node:sqlite.
    (process as unknown as { getBuiltinModule?: unknown }).getBuiltinModule = undefined;
    const scan = scanOpencodeCorpus(STATE, home);
    assert.deepEqual(scan.sessions, []);
    assert.equal(scan.unavailable, "node_sqlite_missing");
  } finally {
    (process as unknown as { getBuiltinModule?: unknown }).getBuiltinModule = original;
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeCorpus: two db files (channel switch) with the same session id dedupe -- later endedAt wins", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-multidb-"));
  try {
    const a = makeDb(home, "opencode.db");
    insertSession(a.db, { id: "dupe", directory: "/x", input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, createdAt: T0, updatedAt: T0 });
    insertMessage(a.db, "m1", "dupe", T0);
    a.db.close();

    const b = makeDb(home, "opencode-dev.db");
    insertSession(b.db, { id: "dupe", directory: "/x", input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0, createdAt: T0, updatedAt: T0 + 3_600_000 });
    insertMessage(b.db, "m1", "dupe", T0);
    insertMessage(b.db, "m2", "dupe", T0 + 3_600_000);
    b.db.close();

    const scan = scanOpencodeCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1, "same session id across two channel dbs must never upload twice");
    assert.equal(scan.sessions[0].tokens.input, 100, "the later/more complete record wins");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeCorpus: watermark is the max time_created/time_updated across session AND message rows", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-watermark-"));
  try {
    const { db } = makeDb(home);
    insertSession(db, { id: "s1", directory: "/x", input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, createdAt: T0, updatedAt: T0 + 1000 });
    insertMessage(db, "m1", "s1", T0 + 5000); // latest timestamp overall
    db.close();
    const scan = scanOpencodeCorpus(STATE, home);
    assert.equal(scan.watermark, T0 + 5000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeCorpus: hermetic via DF_OPENCODE_HOME -- never reads the real machine's opencode install", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-hermetic-"));
  const prev = process.env.DF_OPENCODE_HOME;
  try {
    const { db } = makeDb(home);
    insertSession(db, { id: "s1", directory: "/x", input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, createdAt: T0, updatedAt: T0 });
    db.close();
    process.env.DF_OPENCODE_HOME = home;
    const scan = scanOpencodeCorpus(STATE); // no explicit home -- must resolve via the env var
    assert.equal(scan.sessions.length, 1);
    assert.deepEqual(summarizeOpencodeCorpus(STATE), scan.sessions);
  } finally {
    if (prev === undefined) delete process.env.DF_OPENCODE_HOME;
    else process.env.DF_OPENCODE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeCorpus: legacy pre-migration JSON files are counted but never parsed", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-legacy-"));
  try {
    mkdirSync(join(home, "project"), { recursive: true });
    writeFileSync(join(home, "project", "abc.json"), JSON.stringify({ id: "abc" }));
    mkdirSync(join(home, "session", "abc"), { recursive: true });
    writeFileSync(join(home, "session", "abc", "info.json"), JSON.stringify({ id: "s1" }));
    writeFileSync(join(home, "session", "abc", "message-1.json"), JSON.stringify({ role: "user" }));

    assert.equal(countLegacyOpencodeArtifacts(home), 3);
    const scan = scanOpencodeCorpus(STATE, home);
    assert.deepEqual(scan.sessions, [], "legacy format is never parsed");
    assert.equal(scan.legacyFilesDetected, 3, "the presence is a loud counted signal, not a silent zero");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Privacy regression pin: session.title (and message.data) must never leak into output
// ---------------------------------------------------------------------------

test("scanOpencodeCorpus: session.title (an LLM-generated summary of the user's request) never appears anywhere in the emitted summary", () => {
  const home = mkdtempSync(join(tmpdir(), "df-oc-privacy-"));
  const SECRET = "please-dont-leak-my-secret-prompt-XYZ123";
  try {
    const { db } = makeDb(home);
    insertSession(db, {
      id: "s1",
      directory: "/home/m/proj",
      title: SECRET,
      model: { id: "m", providerID: "p" },
      input: 10,
      output: 5,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      createdAt: T0,
      updatedAt: T0,
    });
    insertMessage(db, "m1", "s1", T0); // data column also carries no secret info the parser could leak
    db.close();

    const scan = scanOpencodeCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    assert.ok(!JSON.stringify(scan.sessions[0]).includes(SECRET), "title text must never surface in the parsed summary");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
