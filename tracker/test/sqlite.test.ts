/**
 * Read-only SQLite util tests (waves 2/3). The fixture database is created with
 * node:sqlite itself — no vendored binary fixture, nothing opaque in the repo.
 * These tests run on Node >= 22.5 (this repo's dev floor); the soft-skip
 * node_sqlite_missing branch is exercised structurally (sqliteSupported() is the
 * only gate) rather than by simulating an older Node.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqliteReadOnly, sqliteSupported } from "../src/sqlite.ts";

function makeFixtureDb(dir: string): string {
  const path = join(dir, "state.db");
  const mod = (process as unknown as { getBuiltinModule: (id: string) => any }).getBuiltinModule("node:sqlite");
  const db = new mod.DatabaseSync(path);
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, input_tokens INTEGER, output_tokens INTEGER, started_at INTEGER)");
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)").run("s1", "m-a", 100, 50, 1780000000000);
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)").run("s2", "m-b", 10, 5, 1780000100000);
  db.close();
  return path;
}

test("sqliteSupported: true on this repo's dev Node (>= 22.5)", () => {
  assert.equal(sqliteSupported(), true);
});

test("openSqliteReadOnly: explicit-column query works; connection closes cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "df-sqlite-"));
  try {
    const handle = openSqliteReadOnly(makeFixtureDb(dir));
    assert.equal(handle.available, true);
    if (!handle.available) return;
    const rows = handle.query("SELECT id, model, input_tokens, output_tokens FROM sessions ORDER BY started_at");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "s1");
    assert.equal(rows[0].input_tokens, 100);
    handle.close();
    handle.close(); // double-close must not crash a sync pass
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openSqliteReadOnly: SELECT * is forbidden — the database holds prompts", () => {
  const dir = mkdtempSync(join(tmpdir(), "df-sqlite-"));
  try {
    const handle = openSqliteReadOnly(makeFixtureDb(dir));
    assert.equal(handle.available, true);
    if (!handle.available) return;
    assert.throws(() => handle.query("SELECT * FROM sessions"), /explicit metadata columns/);
    assert.throws(() => handle.query("select   *   from sessions"), /explicit metadata columns/);
    handle.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openSqliteReadOnly: read-only is real — writes through the handle fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "df-sqlite-"));
  try {
    const handle = openSqliteReadOnly(makeFixtureDb(dir));
    assert.equal(handle.available, true);
    if (!handle.available) return;
    assert.throws(() => handle.query("DELETE FROM sessions"), /readonly|read-only|read only/i);
    handle.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openSqliteReadOnly: missing file and non-database file soft-skip, never throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "df-sqlite-"));
  try {
    const missing = openSqliteReadOnly(join(dir, "nope.db"));
    assert.deepEqual(missing, { available: false, reason: "file_missing" });
    // A directory where a file is expected: open must fail into the soft-skip result.
    const notDb = openSqliteReadOnly(dir);
    assert.equal(notDb.available, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
