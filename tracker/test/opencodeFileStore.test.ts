/**
 * L5b RED — opencode 1.1+ FILE-STORE back-port (landscape S4).
 *
 * WHY THIS EXISTS: opencode's SQLite adapter (src/opencode.ts) goes dark for users on the
 * newer file-based storage layout. This suite pins the not-yet-built file-store reader.
 *
 * CORPUS STATUS (discovery 2026-07-23 on Marco's machine — the real corpus host):
 *   - REAL opencode install found at ~/.local/share/opencode, but it is STILL SQLITE
 *     (opencode.db present; schema `session` + `message` + `part` + `session_message` …).
 *     There is NO `storage/` tree on this machine — the 1.1+ file layout is ABSENT here.
 *   - Therefore the file-store SHAPE below is CORPUS-UNVERIFIED. It is modeled on opencode's
 *     own documented on-disk Storage convention (namespaced JSON under `<data>/storage/…`,
 *     with per-message `tokens.{input,output,reasoning,cache.{read,write}}` — the SAME JSON
 *     paths src/opencode.ts's header cites from opencode's `$.tokens.*` migration SQL). The
 *     fixtures are synthetic (fake ids/models/counts); only the field NAMES/structure claim
 *     fidelity, and even that carries a LOUD corpus-unverified flag to the PR.
 *
 * These tests import reader entry points that DO NOT EXIST YET (scanOpencodeFileStore,
 * opencodeFileStoreDir) so the whole file fails RED until L5b is implemented. Every test is
 * hermetic: DF_OPENCODE_HOME / the explicit home arg point at a temp fixture dir, never the
 * real machine install (hermeticity law).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scanOpencodeCorpus,
  // NOT-YET-EXISTING — L5b implements these (import forces the suite RED):
  scanOpencodeFileStore,
  opencodeFileStoreDir,
} from "../src/opencode.ts";
import type { TrackerState } from "../src/config.ts";

const STATE = { repoHmacKey: "test-key", gapMs: 5 * 60_000 } as unknown as TrackerState;

const T0 = Date.UTC(2026, 6, 14, 9, 0, 0); // 2026-07-14T09:00:00Z

// ---------------------------------------------------------------------------
// Synthetic file-store builders — opencode's documented namespaced-JSON layout:
//   <home>/storage/session/info/<sessionId>.json
//   <home>/storage/session/message/<sessionId>/<messageId>.json
// (CORPUS-UNVERIFIED — see file header.)
// ---------------------------------------------------------------------------

interface InfoOpts {
  id: string;
  parentID?: string | null; // subtask marker — a child session carries its parent's id here
  directory?: string | null;
  title?: string;
  created?: number;
  updated?: number;
}

function writeSessionInfo(home: string, o: InfoOpts): void {
  const dir = join(home, "storage", "session", "info");
  mkdirSync(dir, { recursive: true });
  const info: Record<string, unknown> = {
    id: o.id,
    directory: o.directory ?? "/home/m/proj",
    title: o.title ?? "a title the parser must never read",
    version: "1.1.0",
    time: { created: o.created ?? T0, updated: o.updated ?? T0 },
  };
  if (o.parentID != null) info.parentID = o.parentID;
  writeFileSync(join(dir, `${o.id}.json`), JSON.stringify(info));
}

interface MsgOpts {
  id: string;
  sessionID: string;
  role?: "assistant" | "user";
  modelID?: string;
  providerID?: string;
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  created?: number;
}

function writeMessage(home: string, m: MsgOpts): void {
  const dir = join(home, "storage", "session", "message", m.sessionID);
  mkdirSync(dir, { recursive: true });
  const msg = {
    id: m.id,
    sessionID: m.sessionID,
    role: m.role ?? "assistant",
    modelID: m.modelID ?? "claude-sonnet",
    providerID: m.providerID ?? "anthropic",
    cost: 0,
    tokens: {
      input: m.input ?? 0,
      output: m.output ?? 0,
      reasoning: m.reasoning ?? 0,
      cache: { read: m.cacheRead ?? 0, write: m.cacheWrite ?? 0 },
    },
    time: { created: m.created ?? T0, completed: m.created ?? T0 },
  };
  writeFileSync(join(dir, `${m.id}.json`), JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// SQLite fixture builder (for the both-stores dedupe test) — verbatim from the
// confirmed SQLite schema, mirroring test/opencode.test.ts.
// ---------------------------------------------------------------------------

function sqliteMod(): any {
  return (process as unknown as { getBuiltinModule: (id: string) => any }).getBuiltinModule("node:sqlite");
}

function makeSqliteDb(home: string): any {
  const db = new (sqliteMod().DatabaseSync)(join(home, "opencode.db"));
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, directory TEXT, title TEXT, model TEXT, cost REAL,
    tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
    tokens_cache_read INTEGER, tokens_cache_write INTEGER,
    time_created INTEGER, time_updated INTEGER)`);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)`);
  return db;
}

function insertSqliteSession(
  db: any,
  id: string,
  input: number,
  output: number,
  createdAt: number,
  updatedAt: number,
): void {
  db.prepare(
    `INSERT INTO session (id, directory, title, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, "/home/m/proj", null, JSON.stringify({ id: "claude-sonnet", providerID: "anthropic" }), 0, input, output, 0, 0, 0, createdAt, updatedAt);
}

// ---------------------------------------------------------------------------
// opencodeFileStoreDir
// ---------------------------------------------------------------------------

test("opencodeFileStoreDir: resolves the storage tree under the home", () => {
  const home = mkdtempSync(join(tmpdir(), "df-ocfs-dir-"));
  try {
    const dir = opencodeFileStoreDir(home);
    assert.ok(dir.startsWith(home), "the storage dir sits under the opencode home");
    assert.ok(dir.includes("storage"), "the file store lives under a storage/ tree");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scanOpencodeFileStore — parse a session's messages into token totals + timestamps
// ---------------------------------------------------------------------------

test("scanOpencodeFileStore: a session with N messages folds to the summed token totals + real timestamps", () => {
  const home = mkdtempSync(join(tmpdir(), "df-ocfs-fold-"));
  try {
    writeSessionInfo(home, { id: "s1", directory: "/home/m/proj", created: T0, updated: T0 + 120_000 });
    writeMessage(home, { id: "m1", sessionID: "s1", input: 1000, output: 200, reasoning: 50, cacheRead: 30, cacheWrite: 10, created: T0 });
    writeMessage(home, { id: "m2", sessionID: "s1", input: 500, output: 100, reasoning: 20, cacheRead: 0, cacheWrite: 0, created: T0 + 120_000 });

    const scan = scanOpencodeFileStore(STATE, home);
    assert.equal(scan.sessions.length, 1);
    const s = scan.sessions[0];
    assert.equal(s.tool, "opencode");
    assert.equal(s.toolSessionId, "s1");
    // input/output/cache.read->cacheRead/cache.write->cacheCreation, summed across messages
    assert.deepEqual(s.tokens, { input: 1500, output: 300, cacheRead: 30, cacheCreation: 10 });
    assert.equal(s.thinkingTokens, 70, "tokens.reasoning summed -> thinkingTokens, never folded into output");
    assert.equal(s.tokens.output, 300, "reasoning never added to output");
    assert.equal(s.model, "anthropic/claude-sonnet", "providerID/modelID, matching the SQLite parser's convention");
    assert.equal(s.messageCount, 2, "one message file = one message");
    assert.equal(s.startedAt, T0, "earliest message time.created");
    assert.equal(s.entryPoint, "cli");
    assert.ok(s.repoHash, "repoHash derives from the info.directory basename");
    assert.equal(s.cwd, "/home/m/proj");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeFileStore: absent storage tree -> empty scan, never a throw", () => {
  const home = mkdtempSync(join(tmpdir(), "df-ocfs-absent-"));
  try {
    const scan = scanOpencodeFileStore(STATE, join(home, "does-not-exist"));
    assert.deepEqual(scan.sessions, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Subtask exclusion — a child session (parentID set) is never emitted
// ---------------------------------------------------------------------------

test("scanOpencodeFileStore: a child session (info.parentID present) is excluded; the parent is kept", () => {
  const home = mkdtempSync(join(tmpdir(), "df-ocfs-subtask-"));
  try {
    // Parent session — no parentID.
    writeSessionInfo(home, { id: "parent", directory: "/home/m/proj", created: T0 });
    writeMessage(home, { id: "pm1", sessionID: "parent", input: 100, output: 20, created: T0 });
    // Child/subtask session — parentID points back at the parent. Must be excluded.
    writeSessionInfo(home, { id: "child", parentID: "parent", directory: "/home/m/proj", created: T0 + 1000 });
    writeMessage(home, { id: "cm1", sessionID: "child", input: 9999, output: 9999, created: T0 + 1000 });

    const scan = scanOpencodeFileStore(STATE, home);
    assert.equal(scan.sessions.length, 1, "only the parent session is emitted");
    assert.equal(scan.sessions[0].toolSessionId, "parent");
    assert.deepEqual(scan.sessions[0].tokens, { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 }, "the child's tokens are never rolled in");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Both stores present -> dedupe by session id, FILE STORE WINS, never double-count
// ---------------------------------------------------------------------------

test("scanOpencodeCorpus: a session present in BOTH the SQLite db and the file store is counted once, file store wins", () => {
  const home = mkdtempSync(join(tmpdir(), "df-ocfs-both-"));
  try {
    // SQLite record for "dupe" — the stale/legacy totals.
    const db = makeSqliteDb(home);
    insertSqliteSession(db, "dupe", 10, 5, T0, T0);
    db.close();
    // File-store record for the SAME id "dupe" — the newer, authoritative totals.
    writeSessionInfo(home, { id: "dupe", directory: "/home/m/proj", created: T0, updated: T0 + 60_000 });
    writeMessage(home, { id: "m1", sessionID: "dupe", input: 100, output: 50, created: T0 });
    // A session only in the file store — still captured.
    writeSessionInfo(home, { id: "file-only", directory: "/home/m/proj", created: T0 });
    writeMessage(home, { id: "fm1", sessionID: "file-only", input: 7, output: 3, created: T0 });

    const scan = scanOpencodeCorpus(STATE, home);
    const byId = new Map(scan.sessions.map((s) => [s.toolSessionId, s]));
    assert.equal(byId.size, scan.sessions.length, "no duplicate session ids in the emitted set");
    assert.ok(byId.has("dupe"), "the shared session is present exactly once");
    assert.equal(byId.get("dupe")!.tokens.input, 100, "file-store totals win over the SQLite record for the same id");
    assert.ok(byId.has("file-only"), "a file-store-only session is still captured");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeCorpus: a SQLite-only session is unaffected when a file store also exists (no double count, no drop)", () => {
  const home = mkdtempSync(join(tmpdir(), "df-ocfs-sqlonly-"));
  try {
    const db = makeSqliteDb(home);
    insertSqliteSession(db, "sql-only", 42, 8, T0, T0);
    db.close();
    // A DIFFERENT session lives only in the file store.
    writeSessionInfo(home, { id: "file-only", directory: "/home/m/proj", created: T0 });
    writeMessage(home, { id: "fm1", sessionID: "file-only", input: 5, output: 5, created: T0 });

    const scan = scanOpencodeCorpus(STATE, home);
    const byId = new Map(scan.sessions.map((s) => [s.toolSessionId, s]));
    assert.ok(byId.has("sql-only"), "SQLite-only session survives");
    assert.equal(byId.get("sql-only")!.tokens.input, 42, "its SQLite totals are used verbatim (stable id, no re-upload churn)");
    assert.ok(byId.has("file-only"), "file-store-only session also present");
    assert.equal(byId.size, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Role filtering (review fix on L5b) — the file store DOES expose message.role at the
// top level (unlike the SQLite mirror, where role lives inside the forbidden data blob),
// so this path can and must honor the messageCount contract in types.ts: "Count of
// assistant messages seen". Before the fix, every parseable file counted, a trailing
// user row clobbered the session model to "unknown", and a zero-token "unknown" bucket
// was seeded — while user timestamps legitimately belong in the activity pool.
// ---------------------------------------------------------------------------

test("scanOpencodeFileStore: user rows never count as messages, never clobber the model, never seed a bucket", () => {
  const home = mkdtempSync(join(tmpdir(), "df-ocfs-role-"));
  try {
    writeSessionInfo(home, { id: "s1", directory: "/home/m/proj", created: T0, updated: T0 + 240_000 });
    writeMessage(home, { id: "m1", sessionID: "s1", role: "user", input: 0, output: 0, created: T0 });
    writeMessage(home, { id: "m2", sessionID: "s1", role: "assistant", input: 1000, output: 200, created: T0 + 60_000 });
    // The TRAILING user row is the model-clobber case: last file in id order.
    writeMessage(home, { id: "m3", sessionID: "s1", role: "user", input: 0, output: 0, created: T0 + 240_000 });

    const scan = scanOpencodeFileStore(STATE, home);
    assert.equal(scan.sessions.length, 1);
    const s = scan.sessions[0];
    assert.equal(s.messageCount, 1, "messageCount = assistant messages seen (types.ts contract)");
    assert.equal(s.model, "anthropic/claude-sonnet", "a trailing user row must not clobber the session model");
    const modelIds = (s.models ?? []).map((m) => m.id);
    assert.ok(!modelIds.includes("unknown"), "no zero-token 'unknown' bucket seeded by user rows");
    assert.deepEqual(s.tokens, { input: 1000, output: 200, cacheRead: 0, cacheCreation: 0 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeFileStore: user timestamps still count toward activity and the watermark", () => {
  const home = mkdtempSync(join(tmpdir(), "df-ocfs-role-act-"));
  try {
    writeSessionInfo(home, { id: "s1", directory: "/home/m/proj", created: T0, updated: T0 });
    writeMessage(home, { id: "m1", sessionID: "s1", role: "assistant", input: 100, output: 10, created: T0 });
    // A user prompt 2 minutes later is REAL human activity in the session — the span
    // must extend to it even though it carries no tokens and no model.
    writeMessage(home, { id: "m2", sessionID: "s1", role: "user", input: 0, output: 0, created: T0 + 120_000 });

    const scan = scanOpencodeFileStore(STATE, home);
    const s = scan.sessions[0];
    assert.ok(s.wallMs >= 120_000, `activity span extends to the user prompt (wallMs=${s.wallMs})`);
    assert.ok(scan.watermark >= T0 + 120_000, "watermark advances on user rows too");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpencodeFileStore: a message with NO role field folds exactly as before (defensive back-compat)", () => {
  const home = mkdtempSync(join(tmpdir(), "df-ocfs-role-abs-"));
  try {
    writeSessionInfo(home, { id: "s1", directory: "/home/m/proj", created: T0, updated: T0 });
    const dir = join(home, "storage", "session", "message", "s1");
    mkdirSync(dir, { recursive: true });
    // Hand-built message with role ABSENT (schema variance): must fold like an assistant row.
    writeFileSync(
      join(dir, "m1.json"),
      JSON.stringify({
        id: "m1", sessionID: "s1", modelID: "claude-sonnet", providerID: "anthropic", cost: 0,
        tokens: { input: 700, output: 70, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: T0, completed: T0 },
      }),
    );
    const scan = scanOpencodeFileStore(STATE, home);
    const s = scan.sessions[0];
    assert.equal(s.messageCount, 1, "absent role keeps the pre-fix fold (never silently dropped)");
    assert.equal(s.tokens.input, 700);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
