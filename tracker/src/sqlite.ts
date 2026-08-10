/**
 * Read-only SQLite access for adapters whose tools keep their sessions in SQLite
 * (opencode, Hermes — waves 2/3, docs/harness-adapters-implementation.md §3).
 *
 * Driver ruling (Marco 2026-07-13): `node:sqlite` ONLY — Node core, zero new
 * dependencies, no native build chain on user machines, no supply-chain surface in a
 * product whose pitch is "audit us: a few readable files, no dependencies". A userland
 * driver is rejected permanently; parsing the SQLite file format ourselves is rejected
 * permanently. `node:sqlite` ships in Node >= 22.5 and is still marked experimental —
 * both facts are handled by the SOFT-SKIP contract below, never by an engines floor
 * (a Claude-only builder on Node 20 must not be blocked by an adapter they never use).
 *
 * Soft-skip contract: openSqliteReadOnly() NEVER throws for environmental reasons.
 * Missing node:sqlite (old Node), a missing file, or a lock all return
 * { available: false, reason } — the caller degrades to "capture nothing this pass,
 * say so once" (the same fail-closed posture as the fingerprint gates), and a locked
 * database counts as a read-failure so cursors/watermarks never advance past unread
 * data (the pi read-failure rule).
 *
 * Privacy rails (stricter than the JSONL parsers, because these databases contain
 * FULL message content and prompts):
 *   - read-only open, always — this module never takes a write handle on another
 *     product's live database (corrupting a user's session history is the one
 *     unforgivable failure);
 *   - NO snapshot/backup copies — duplicating a database that holds prompts to a
 *     temp file is a privacy regression, not a safety win. A busy/locked database
 *     is skipped and retried next sync instead;
 *   - callers must SELECT explicit metadata columns only (tokens, models,
 *     timestamps, ids) — never `SELECT *`, never a content column. query() enforces
 *     the cheap syntactic half of that rule.
 */
import { existsSync } from "node:fs";

export interface SqliteRow {
  [column: string]: unknown;
}

export type SqliteOpenResult =
  | { available: true; query: (sql: string, params?: (string | number)[]) => SqliteRow[]; close: () => void }
  | { available: false; reason: "node_sqlite_missing" | "file_missing" | "open_failed" };

/** True when this Node can read SQLite at all (node:sqlite present, >= 22.5). */
export function sqliteSupported(): boolean {
  try {
    // process.getBuiltinModule (Node >= 22.3) avoids an async import in sync call
    // sites and never triggers the module's experimental warning just to probe.
    return typeof (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule === "function"
      ? (process as unknown as { getBuiltinModule: (id: string) => unknown }).getBuiltinModule("node:sqlite") !== undefined
      : false;
  } catch {
    return false;
  }
}

/**
 * Open a database read-only. Environmental failure -> soft-skip result, never a throw.
 * The returned connection is meant to live for ONE scan pass — open, query the
 * metadata, close — so the lock window on the tool's live database stays minimal.
 */
export function openSqliteReadOnly(path: string): SqliteOpenResult {
  if (!sqliteSupported()) return { available: false, reason: "node_sqlite_missing" };
  if (!existsSync(path)) return { available: false, reason: "file_missing" };
  let db: { prepare: (sql: string) => { all: (...params: (string | number)[]) => SqliteRow[] }; close: () => void };
  try {
    const mod = (process as unknown as { getBuiltinModule: (id: string) => { DatabaseSync: new (p: string, o: object) => typeof db } }).getBuiltinModule("node:sqlite");
    db = new mod.DatabaseSync(path, { readOnly: true });
  } catch {
    // Locked (another writer holds it), corrupt, or not actually SQLite: skip this
    // pass; the caller retries next sync. Never escalate to a write/recovery path.
    return { available: false, reason: "open_failed" };
  }
  return {
    available: true,
    query: (sql, params = []) => {
      // The syntactic half of the explicit-columns rule: a `SELECT *` cannot even be
      // written against a database that holds prompts. (The semantic half — naming
      // only metadata columns — is each adapter's responsibility and its review bar.)
      if (/select\s+\*/i.test(sql)) throw new Error("sqlite.ts: SELECT * is forbidden — name explicit metadata columns");
      return db.prepare(sql).all(...params);
    },
    close: () => {
      try {
        db.close();
      } catch {
        /* already closed — closing twice must not crash a sync pass */
      }
    },
  };
}
