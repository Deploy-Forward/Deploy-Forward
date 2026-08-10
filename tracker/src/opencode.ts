/**
 * opencode (github.com/anomalyco/opencode — the SAME repo id/history as `sst/opencode`;
 * the org renamed at some point before 2026-07-13, confirmed by `gh api repos/sst/opencode`
 * redirecting to `anomalyco/opencode` on that date) capture — Wave 3 of
 * docs/harness-adapters-implementation.md. PARSER ONLY: sync wiring (cursors, dedupe key,
 * digest gate) is a separate task and does not live here, per pi.ts's precedent.
 *
 * PROVENANCE / CONFIDENCE (read before trusting a field below). No `~/.local/share/opencode`
 * install exists on this dev machine — every shape here is SOURCE-DERIVED (the opencode repo
 * itself, fetched 2026-07-13 via `gh api`/raw GitHub content, NOT the marketing docs), pending
 * a real-corpus eval before this adapter ships (spec §2.5). Confidence is split explicitly:
 *
 * CONFIRMED (read the actual TypeScript source, not summarized docs):
 *   - Storage root: `packages/core/src/global.ts` — `Global.Path.data = path.join(xdgData, "opencode")`,
 *     where `xdgData` comes from the `xdg-basedir` npm package. That package's own source
 *     (fetched from unpkg.com/xdg-basedir/index.js) has NO Windows branch at all: on every
 *     platform, `xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")`.
 *     Neither opencode's `global.ts` nor `xdg-basedir` special-cases `process.platform`.
 *     CONCLUSION (verified, not assumed): the Windows path is `~/.local/share/opencode`
 *     (i.e. `C:\Users\<user>\.local\share\opencode` via `os.homedir()` + `path.join`) —
 *     the SAME relative path as Linux/macOS, NOT `%LOCALAPPDATA%\opencode`. The task brief's
 *     "likely %LOCALAPPDATA%" guess is corrected by this source read.
 *   - DB filename: `packages/core/src/database/database.ts`'s `path()` — `opencode.db` for
 *     the `latest`/`beta`/`prod` install channels (or when `OPENCODE_DISABLE_CHANNEL_DB` is
 *     set), else `opencode-<channel>.db` for any other channel, unless the `OPENCODE_DB` flag
 *     overrides it outright. We cannot recompute `InstallationChannel` ourselves (internal,
 *     no dependency to read it), so `opencodeDbPaths()` globs for both shapes instead of
 *     guessing a single name (see below).
 *   - `auth.json`: `packages/opencode/src/auth/index.ts` — `path.join(Global.Path.data, "auth.json")`.
 *     CORPUS CORRECTION (2026-07-14, opencode 1.17.20 on Windows): the file is created on the
 *     first `opencode auth login`, NOT on data-dir creation — a zero-auth install running zen
 *     free-tier models has opencode.db but no auth.json. It must therefore never gate capture.
 *   - Session/message schema: `packages/core/src/session/sql.ts` (drizzle table defs) —
 *     the `session` table carries SESSION-LEVEL CUMULATIVE columns `cost` (real), `tokens_input`,
 *     `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write` (all
 *     integer, default 0), plus `model` (JSON text: `{id, providerID, variant?}`), `directory`
 *     (the session's cwd, stored as an absolute path with forward slashes even on Windows —
 *     see `database/path.ts`'s `storagePath()`), `title`, `time_created`, `time_updated`.
 *     The migration that added the token columns (`database/migration/20260510033149_session_usage.ts`,
 *     dated 2026-05-10) backfills them from `sum(json_extract(message.data, '$.tokens.*'))`
 *     — CONFIRMING both that `tokens_output` and `tokens_reasoning` are summed from
 *     SEPARATE JSON paths (`$.tokens.output` vs `$.tokens.reasoning`), i.e. output is NOT
 *     documented as inclusive of reasoning, and that this migration predates the current
 *     published release (`opencode@1.17.20`, released 2026-07-13 per GitHub Releases) by two
 *     months — any actively-used install has almost certainly already applied it (opencode
 *     runs `DatabaseMigration.apply(db)` on every service boot).
 *   - CRITICAL FINDING (schema differs from the task brief's assumption): the `message` table
 *     has NO per-message token columns. It is `{id, session_id, time_created, time_updated,
 *     data}` where `data` is a JSON blob holding the ENTIRE message (role, content, per-message
 *     `tokens.*`, cost — everything). Per-message token/model/role granularity therefore lives
 *     ONLY inside that `data` column — which is exactly the "content/text/parts column" this
 *     module's contract (sqlite.ts) forbids touching, even via `json_extract()` for a single
 *     sub-field, because `data` is a full-message blob, not a metadata column that happens to
 *     be JSON-typed. CONSEQUENCE (deliberate, disclosed, not invented): this parser reads ONLY
 *     the `session` table's cumulative totals — see "What this means" below for every knock-on
 *     effect (no day-slicing, no per-model split, no turns).
 *   - Legacy pre-migration file-JSON format: `specs/storage/remove-opencode-db.md` (a spec doc
 *     IN the current repo) states the JSON-to-SQLite migration code has been DELETED from
 *     opencode's own startup path ("index.ts no longer performs the removed JSON-to-SQLite
 *     migration during startup"). There is no ground truth left in the current source tree to
 *     reverse-engineer the legacy `project/<id>.json` / `session/<id>/<id>.json` shape from (DeepWiki's
 *     summary of it is vague and unverifiable against real code). DECISION: legacy JSON is NOT
 *     parsed here. `countLegacyOpencodeArtifacts()` detects and COUNTS matching files (never
 *     parses them) so a install stuck on the pre-migration format reports a loud, honest
 *     signal instead of a silent zero. CORPUS QUESTION for the eventual eval (recorded, not
 *     resolved): is this format still findable on any real machine, and if so is a real sample
 *     worth reverse-engineering from (Wave 3 plan, docs/harness-adapters-implementation.md §3)?
 *
 * PRIVACY CALL beyond sqlite.ts's baseline (disclosed explicitly because it is easy to miss):
 * `session.title` is a plain TEXT column — syntactically nothing stops `SELECT`ing it — but
 * semantically it is very likely an LLM-generated summary of the user's actual request (the
 * same class of leak sqlite.ts's header warns about generically). It is NEVER selected here,
 * despite being "just a text column"; same treatment for `metadata` (arbitrary JSON) and
 * `revert`/`permission` (arbitrary JSON). Only the numeric/id/timestamp columns named in
 * REQUIRED_SESSION_COLUMNS are ever read.
 *
 * What this means for the emitted SessionSummary (every deviation from pi.ts's shape is a
 * consequence of the schema fact above, not a shortcut):
 *   - `days`: ALWAYS undefined. Day-attribution (Fix A) requires bucketing REAL per-atom
 *     tokens by the atom's own UTC day; opencode's schema gives us only ONE cumulative total
 *     per session, never per-message deltas, so any day split would have to smear the total
 *     across days by some invented proportion (active-time weighting, etc.) — which is exactly
 *     the "smearing" days[] exists to prohibit (types.ts: "real observed atoms, never a
 *     smear"). Rather than invent a proportion, this parser never emits days[] for opencode.
 *     activeMs/idleMs are still computed correctly across a multi-day span (see below) — only
 *     the PER-DAY token split is impossible from this source.
 *   - `models`: exactly ONE entry, credited with the session's ENTIRE token total under
 *     `session.model` (or `"unknown"` if the model JSON is null/unparseable — tokens are never
 *     dropped for a missing model, same fallback convention as pi/grok). If a builder actually
 *     switched models mid-session, opencode's OWN schema already can't tell us that (there is
 *     one `model` column per session row, holding whichever model the row currently reflects) —
 *     this is a limitation of the source data itself, not something this parser fails to
 *     extract.
 *   - `turns` / `longestLoopMs`: ALWAYS 0. Distinguishing a human `message.role === "user"` row
 *     from an assistant one requires reading `message.data`, which is off-limits (see above).
 *     Verbatim honesty over invention: an unknowable turn count reports 0, never a guess (e.g.
 *     never "messageCount / 2").
 *   - `messageCount`: a real `COUNT(*) FROM message GROUP BY session_id` — this touches only
 *     `session_id` (an id column), never `data`, so it is a genuine, safe metadata count.
 *   - `wallMs`/`activeMs`/`idleMs`: computed from every message row's `time_created` (a plain
 *     INTEGER column, not content) via the SAME `computeActivity`/`computeLoops` primitives
 *     every other adapter uses. This IS accurate across multi-day sessions (activity timing is
 *     a real per-row timestamp, unlike tokens which are only known in aggregate).
 *   - `agents`/`skills`: always undefined, matching pi.ts's stance. `session.parent_id` shows
 *     opencode's schema DOES have a subagent/child-session concept (a Task-dispatched subagent
 *     likely runs as its own `session` row with `parent_id` set) — this parser deliberately
 *     does NOT roll child sessions into their parent (no Claude-style merge). Each session row,
 *     parent or child, becomes its own independent SessionSummary. CORPUS QUESTION: whether a
 *     parent/child rollup (and an `agents` tally derived from child count) is worth building
 *     once a real corpus shows how often it actually happens.
 *   - `entryPoint`: hardcoded `"cli"` — no alternate entry point (IDE/desktop) is evidenced in
 *     the session schema; same disclosed-gap convention as pi.ts.
 *
 * SQLite-source specifics (vs. a JSONL source):
 *   - Multiple db files can legitimately coexist on one machine (a builder switching install
 *     channels). `opencodeDbPaths()` returns ALL matching files (`opencode.db` plus any
 *     `opencode-<channel>.db`); `scanOpencodeCorpus` opens/queries/closes each in turn (still
 *     "one short-lived connection per file per pass" — sqlite.ts's contract) and merges by
 *     session id using the SAME later-endedAt-then-larger-total tie-break pi.ts uses for its
 *     cross-file duplicate-id case.
 *   - Watermark: no byte cursor exists for a database. `watermark` on the scan result is the
 *     MAX `time_created`/`time_updated` observed across every session AND message row read this
 *     pass — a monotonically increasing integer the (separate) sync-wiring task can persist per
 *     db path and compare against a cheap `SELECT MAX(time_updated) FROM session` probe before
 *     paying for a full re-scan. This module does not persist or compare it — only returns it.
 *   - Soft-skip (sqlite.ts contract): `sqliteSupported() === false` -> empty scan with
 *     `unavailable: "node_sqlite_missing"`. A discovered db file whose CONSTRUCTOR throws
 *     (locked by a live opencode process; a directory sitting where a file is expected --
 *     verified empirically, matching sqlite.test.ts's own "not a database" case) ->
 *     `unavailable: "open_failed"` AND its path in `readFailures`. node:sqlite's DatabaseSync
 *     opens LAZILY, though: a file that exists but has garbage (non-SQLite) content opens
 *     without throwing and only fails on the first query -- that lands in the SAME
 *     `readFailures` bucket but under `"schema_mismatch"` (verified empirically; see the two
 *     separate test cases in test/opencode.test.ts). Either way the effect is identical: the
 *     path never contributes to `watermark`, and cursors must never advance past unread data
 *     (the pi read-failure rule). A db that opens AND queries but whose shape doesn't match
 *     (missing table/column — the "unexpected schema" case) soft-fails with
 *     `unavailable: "schema_mismatch"` ONLY when NO sessions came through at all this pass; a
 *     partial success (some db files fine, one mismatched) keeps the good sessions and records
 *     the bad path in `readFailures` without alarming over data that did arrive.
 *   - Drift counting (`unknownLines`/`totalLines`, named for parity with the JSONL adapters'
 *     shared vocabulary even though the unit here is SESSION ROWS, not lines): a session row
 *     whose token columns are NULL or non-numeric counts as drift and is skipped entirely,
 *     never partially credited — the exact "a renamed/typed-away column must be loud, never a
 *     quiet zero" rule pi.ts documents for its own missing-`usage` case. `message` table rows
 *     carry no token data, so anomalies there (a garbled `session_id`) are handled defensively
 *     (skipped, uncounted) rather than folded into this ratio — the ratio is scoped to where
 *     drift is actually observable.
 *
 * Fingerprint (`isOfficialOpencodeHome`): opencode's docs/source expose no unique proprietary
 * content mark. The gate is the db schema alone: at least one discovered db file opens
 * read-only AND its `session` table (via `PRAGMA table_info`, itself a metadata-only
 * statement) has EVERY column this parser depends on. The original gate ALSO required
 * `auth.json` on the source-reading claim "opencode always creates its data dir + this file";
 * the REAL CORPUS disproved that (2026-07-14, opencode 1.17.20, three sessions on zen
 * free-tier models: opencode.db present from the first run, auth.json absent because
 * `auth login` never ran) — a genuine install failed the fingerprint, which is exactly the
 * failure eval:opencode exists to catch. WEAKNESS (recorded, not hidden): a table literally
 * named `session` with these specific column names is a fairly distinctive shape, but not a
 * cryptographic proof — a byte-compatible reimplementation would pass, exactly the same
 * disclosed weakness class as pi.ts's structural mark.
 *
 * Model attribution, fingerprint gate, and the scan are exported separately and the scan does
 * NOT call the fingerprint internally — the gate is the CALLER's responsibility, mirroring
 * pi.ts/grok.ts (sync.ts calls `isOfficialXCli()` before `summarizeXCorpus()`).
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { openSqliteReadOnly, sqliteSupported } from "./sqlite.js";
import { computeActivity, computeLoops, sliceActivityByDay, utcDayKey, type ActivityDaySlice } from "./activity.js";
import { creditModel, foldModelBuckets, addTokens, ZERO } from "./jsonl.js";
import { repoHash, type TrackerState } from "./config.js";
import type { SessionDaySlice, SessionSummary, TokenCounts, ModelTokens } from "./types.js";

/** `~/.local/share/opencode`-shaped candidates, honoring `XDG_DATA_HOME` exactly the way
 * opencode's own `xdg-basedir`-based resolver does (see file header — verified from source,
 * no Windows branch exists anywhere in that chain). Order matters: XDG_DATA_HOME first (it is
 * what opencode itself would resolve to), the bare `.local/share` path as the universal
 * fallback on every platform including Windows. */
function opencodeHomeCandidates(): string[] {
  const home = homedir();
  const out: string[] = [];
  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome) out.push(join(xdgDataHome, "opencode"));
  out.push(join(home, ".local", "share", "opencode"));
  return out;
}

/** `DF_OPENCODE_HOME` overrides everything; otherwise the first existing documented candidate
 * wins; if none exist yet, the last (bare `.local/share`) candidate is returned deterministically
 * so callers always have a path to check against (mirrors piHome()'s always-return-a-path
 * contract — never null). */
export function opencodeHome(): string {
  if (process.env.DF_OPENCODE_HOME) return process.env.DF_OPENCODE_HOME;
  const candidates = opencodeHomeCandidates();
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // None exist yet -- return the FIRST (highest-priority) candidate, not the last: when
  // XDG_DATA_HOME is set, that is what opencode itself would resolve to regardless of
  // whether the directory has been created yet (opencode mkdir's it on first run).
  return candidates[0];
}

const PRIMARY_DB_NAME = "opencode.db";
const CHANNEL_DB_RE = /^opencode-[a-zA-Z0-9._-]+\.db$/;

/** Every opencode db file discovered directly under `home` — `opencode.db` first (the
 * latest/beta/prod channel name, the common case), then any `opencode-<channel>.db` file,
 * sorted for determinism. We cannot recompute opencode's internal `InstallationChannel`
 * ourselves (no dependency to read it), so this is deliberate best-effort discovery rather
 * than a single guessed filename — see file header. */
export function opencodeDbPaths(home: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return [];
  }
  const out: string[] = [];
  if (entries.includes(PRIMARY_DB_NAME)) out.push(join(home, PRIMARY_DB_NAME));
  const channelMatches = entries.filter((f) => f !== PRIMARY_DB_NAME && CHANNEL_DB_RE.test(f)).sort();
  for (const f of channelMatches) out.push(join(home, f));
  return out;
}

/** Session-table columns this parser depends on — also the fingerprint's schema check. */
const REQUIRED_SESSION_COLUMNS = [
  "id",
  "directory",
  "model",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
  "time_created",
  "time_updated",
];

/**
 * Is `home` an official opencode data dir? Structural fingerprint (see file header for the
 * disclosed weakness): at least one discovered db file must open read-only with a `session`
 * table carrying every column this parser reads (`PRAGMA table_info` — a metadata-only
 * statement, never touches row content). Deliberately NOT `auth.json`: zero-auth installs
 * (zen free-tier models) never create it — corpus finding 2026-07-14. The db is the one
 * artifact every real install has, and it is also the only thing this parser reads.
 * No mark -> we capture NOTHING from this tree (never guess which product wrote a file).
 */
export function isOfficialOpencodeHome(home: string = opencodeHome()): boolean {
  const dbPaths = opencodeDbPaths(home);
  if (dbPaths.length === 0) return false;
  const handle = openSqliteReadOnly(dbPaths[0]);
  if (!handle.available) return false;
  try {
    const cols = new Set(handle.query("PRAGMA table_info(session)").map((r) => String(r.name)));
    return REQUIRED_SESSION_COLUMNS.every((c) => cols.has(c));
  } catch {
    return false;
  } finally {
    handle.close();
  }
}

/**
 * Heuristic detector for the pre-migration file-JSON layout (deepwiki-summarized shape:
 * `project/<id>.json` and `session/<id>/<id>.json`, hierarchical). NEVER parsed — only counted, so a
 * legacy-only install (one that has not been RUN since the SQLite migration shipped) produces
 * a loud, honest signal instead of a silent "opencode: no data". See file header for why the
 * real per-file schema was not recoverable during this task (opencode's own migration code
 * that once read it has been deleted from the current source tree).
 */
export function countLegacyOpencodeArtifacts(home: string): number {
  let count = 0;
  for (const sub of ["project", "session"]) {
    const dir = join(home, sub);
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".json")) {
        count++;
        continue;
      }
      if (!e.isDirectory()) continue;
      try {
        const nested = readdirSync(join(dir, e.name));
        count += nested.filter((f) => f.endsWith(".json")).length;
      } catch {
        /* unreadable nested dir -- not counted, not fatal */
      }
    }
  }
  return count;
}

/** `session.model` is stored as JSON text (`{id, providerID, variant?}`) even when read
 * directly via node:sqlite (bypassing drizzle's `mode:"json"` decoding). Composed as
 * `providerID/id` (vendor/model shape) to match the convention the OpenRouter model-id
 * normalization layer already expects for other adapters; falls back to the bare `id` when
 * `providerID` is missing, and to null (never a fabricated string) when neither parses. */
function parseSessionModelId(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = obj as Record<string, unknown>;
  const id = typeof o?.id === "string" && o.id ? o.id : null;
  const providerID = typeof o?.providerID === "string" && o.providerID ? o.providerID : null;
  if (id && providerID) return `${providerID}/${id}`;
  return id;
}

/** `scanOpencodeCorpus`'s full result — sessions plus the drift-plumbing counters and the
 * SQLite-specific soft-skip/watermark signals (parallel export shape to pi.ts's PiCorpusScan,
 * extended for what a SQLite source needs that a JSONL source doesn't). */
export interface OpencodeCorpusScan {
  sessions: SessionSummary[];
  /** Session ROWS with NULL/non-numeric token columns (see file header — scoped to the
   * `session` table, the only place token drift is observable from this schema). */
  unknownLines: number;
  /** Every session row seen, the denominator for the ratio above. */
  totalLines: number;
  /** db file paths that exist but could not be opened (locked by a live opencode process,
   * corrupt) or whose query shape didn't match the expected schema. The caller must NOT
   * advance any cursor/watermark for these — the pi read-failure rule, applied to db files. */
  readFailures: string[];
  /** MAX time_created/time_updated observed across every session AND message row read this
   * pass, across every db file; 0 if nothing was read. The watermark the sync wiring (a
   * separate task) can persist per db path in place of a byte cursor. */
  watermark: number;
  /** Set only when this pass captured NOTHING because of an environmental block (old Node,
   * or every discovered db file failed to open/query) -- never set merely because there is no
   * opencode install at all (that is the ordinary empty-result case, same as pi's absent
   * home: no data is not a failure). */
  unavailable?: "node_sqlite_missing" | "open_failed" | "schema_mismatch";
  /** Count of pre-migration file-JSON artifacts detected (see countLegacyOpencodeArtifacts).
   * 0 when none found. Present alongside a normal scan so a legacy-only tree is never a
   * silent zero. */
  legacyFilesDetected: number;
}

// ===========================================================================
// opencode 1.1+ FILE-STORE back-port (landscape S4)
// ===========================================================================
//
// CORPUS STATUS (discovery 2026-07-23 on Marco's machine — the real corpus host): the
// file-based `storage/` layout is ABSENT here. The only opencode install found
// (~/.local/share/opencode) is STILL SQLite (opencode.db + -wal/-shm, no `storage/` tree).
// Therefore the SHAPE read below is CORPUS-UNVERIFIED. It is modeled on opencode's OWN
// documented on-disk Storage convention — namespaced JSON under `<data>/storage/session/…`
// with per-message `tokens.{input,output,reasoning,cache.{read,write}}`, the SAME
// `$.tokens.*` paths the SQLite migration this file's header cites reads from. Only the field
// NAMES/structure claim fidelity, and that claim carries a LOUD corpus-unverified flag to the
// PR. A real upgraded-opencode host is needed to confirm the exact paths/field names before
// this ships (W-gate). The BEHAVIOURAL contract (fold per-message tokens, exclude subtask
// children via info.parentID, file store wins over SQLite on a shared id) is the durable part.
//
// Why this back-port exists: on the 1.1+ file layout the SQLite `session` table stops being
// written, so the SQLite-only adapter goes dark for upgraded users. This reader captures the
// file store WHEN PRESENT and dedupes against SQLite (file store wins, never double-counted).
//
// No dedicated env override is added: DF_OPENCODE_HOME already points at the data-dir that
// holds BOTH `opencode.db` and the `storage/` tree, so it covers this reader too.

/** The opencode file-store root under `home` — the `storage/` tree holding namespaced session
 * JSON (`storage/session/info/<id>.json`, `storage/session/message/<id>/<mid>.json`). */
export function opencodeFileStoreDir(home: string): string {
  return join(home, "storage");
}

interface FileStoreEvent {
  ts: number;
  model: string;
  tokens: TokenCounts;
}

/** `scanOpencodeFileStore`'s result — the sessions folded from the file store plus the max
 * timestamp observed (a watermark the separate sync-wiring task can persist, parallel to the
 * SQLite scan's `watermark`). */
export interface OpencodeFileStoreScan {
  sessions: SessionSummary[];
  watermark: number;
}

function fsNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
}

/** `providerID/modelID` (vendor/model shape) matching parseSessionModelId's SQLite convention;
 * bare modelID when providerID is missing; null when neither is a usable string. */
function composeFileStoreModel(providerID: unknown, modelID: unknown): string | null {
  const p = typeof providerID === "string" && providerID ? providerID : null;
  const m = typeof modelID === "string" && modelID ? modelID : null;
  if (p && m) return `${p}/${m}`;
  return m;
}

/** Per-UTC-day slices from real per-message atoms (day-attribution Fix A). Unlike the SQLite
 * path (session-grain totals only, no per-message split — days always undefined), the file
 * store carries per-message tokens WITH per-message timestamps, so day slices are built for
 * real, never smeared. Local copy of sync.ts's `buildDaySlices` (same reason pi.ts/copilot.ts
 * keep their own: importing sync.ts here would be circular). Returns undefined for single-day
 * sessions so their digest is byte-identical to the un-sliced form. */
function buildOpencodeFileStoreDaySlices(
  activityDays: Map<string, ActivityDaySlice>,
  events: FileStoreEvent[],
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
    return { day, activeMs: a.activeMs, idleMs: a.idleMs, tokens, ...(dayModels.length ? { models: dayModels } : {}) };
  });
}

/**
 * Fold the opencode file-store `storage/` tree under `home` into SessionSummary records — one
 * per top-level session with at least one nonzero token field. A child/subtask session (its
 * `info.parentID` is set) is EXCLUDED entirely, never rolled into its parent (matching the
 * SQLite path's stance that a subagent session is its own thing; here the parent-marked child
 * is dropped rather than emitted, per the L5b contract). An absent `storage/` tree yields an
 * empty scan, never a throw. Does NOT check the fingerprint — that is the caller's job.
 */
export function scanOpencodeFileStore(state: TrackerState, home: string = opencodeHome()): OpencodeFileStoreScan {
  const storage = opencodeFileStoreDir(home);
  const infoDir = join(storage, "session", "info");
  const messageBase = join(storage, "session", "message");

  let infoFiles: string[];
  try {
    infoFiles = readdirSync(infoDir);
  } catch {
    return { sessions: [], watermark: 0 };
  }

  const sessions: SessionSummary[] = [];
  let watermark = 0;

  for (const infoFile of infoFiles) {
    if (!infoFile.endsWith(".json")) continue;
    let info: Record<string, unknown>;
    try {
      info = JSON.parse(readFileSync(join(infoDir, infoFile), "utf8")) as Record<string, unknown>;
    } catch {
      continue; // unreadable/garbled info -- skip defensively, never a crash
    }
    const id = typeof info.id === "string" && info.id ? info.id : null;
    if (!id) continue;
    // Subtask exclusion: a child session carries its parent's id in `parentID`. Dropped
    // wholesale -- its messages are never read, its tokens never rolled into the parent.
    if (info.parentID != null) continue;

    const infoTime = info.time as Record<string, unknown> | undefined;
    const infoUpdated = fsNum(infoTime?.updated);
    if (infoUpdated > watermark) watermark = infoUpdated;

    // Fold this session's messages.
    const msgDir = join(messageBase, id);
    let msgFiles: string[];
    try {
      msgFiles = readdirSync(msgDir);
    } catch {
      msgFiles = []; // no message dir yet -- a bare session with no turns
    }

    const tokens: TokenCounts = { ...ZERO };
    let thinkingTokens = 0;
    const byModel = new Map<string, TokenCounts>();
    const events: FileStoreEvent[] = [];
    const tsPool: number[] = [];
    let messageCount = 0;
    let model = "unknown"; // last valid model seen (message files are read in id order)

    for (const msgFile of msgFiles) {
      if (!msgFile.endsWith(".json")) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(readFileSync(join(msgDir, msgFile), "utf8")) as Record<string, unknown>;
      } catch {
        continue; // garbled message file -- skip, never a crash
      }
      // Role gate (review fix): the file store exposes message.role at the TOP level --
      // unlike the SQLite mirror, where role sits inside the forbidden `data` blob -- so
      // this path honors the messageCount contract ("assistant messages seen", types.ts).
      // A user row carries no usage: it must not count as a message, clobber the session
      // model, or seed a zero-token bucket. Its timestamp IS real human activity, so it
      // still feeds the activity pool + watermark. An ABSENT role folds as before
      // (defensive against schema variance -- never silently dropped).
      if (msg.role === "user") {
        const uTime = msg.time as Record<string, unknown> | undefined;
        const uCreated = uTime?.created;
        if (typeof uCreated === "number" && Number.isFinite(uCreated)) {
          tsPool.push(uCreated);
          if (uCreated > watermark) watermark = uCreated;
        }
        continue;
      }
      messageCount++;
      const tk = (msg.tokens as Record<string, unknown> | undefined) ?? {};
      const cache = (tk.cache as Record<string, unknown> | undefined) ?? {};
      const msgTokens: TokenCounts = {
        input: fsNum(tk.input),
        output: fsNum(tk.output),
        cacheRead: fsNum(cache.read),
        cacheCreation: fsNum(cache.write),
      };
      addTokens(tokens, msgTokens);
      thinkingTokens += fsNum(tk.reasoning);
      const m = composeFileStoreModel(msg.providerID, msg.modelID) ?? "unknown";
      model = m;
      creditModel(byModel, m, msgTokens);

      const time = msg.time as Record<string, unknown> | undefined;
      const created = time?.created;
      if (typeof created === "number" && Number.isFinite(created)) {
        tsPool.push(created);
        events.push({ ts: created, model: m, tokens: msgTokens });
        if (created > watermark) watermark = created;
      }
    }

    // A genuinely empty/unused session (all token fields zero) is nothing to report -- same
    // rule the SQLite path uses. Never emitted, never drift.
    if (tokens.input === 0 && tokens.output === 0 && tokens.cacheRead === 0 && tokens.cacheCreation === 0 && thinkingTokens === 0) {
      continue;
    }

    tsPool.sort((a, b) => a - b);
    const infoCreated = fsNum(infoTime?.created);
    const pool = tsPool.length > 0 ? tsPool : infoCreated > 0 ? [infoCreated] : [];
    const activity = computeActivity(pool, state.gapMs);
    const loops = computeLoops(pool, [], state.gapMs); // no human-turn signal -- honest 0, never guessed
    const startedAt = pool[0] ?? infoCreated ?? 0;

    const cwd = typeof info.directory === "string" && info.directory ? info.directory : null;
    const days = buildOpencodeFileStoreDaySlices(sliceActivityByDay(pool, state.gapMs), events);

    sessions.push({
      tool: "opencode",
      toolSessionId: id,
      model,
      tokens,
      models: foldModelBuckets(byModel),
      entryPoint: "cli", // no alternate entry point documented for opencode -- see file header
      thinkingTokens,
      days,
      skills: undefined,
      agents: undefined,
      wallMs: activity.wallMs,
      activeMs: activity.activeMs,
      idleMs: activity.idleMs,
      startedAt,
      endedAt: startedAt + activity.wallMs,
      repoHash: cwd ? repoHash(state.repoHmacKey, basename(cwd)) : null,
      messageCount,
      turns: loops.turns,
      longestLoopMs: loops.longestLoopMs,
      cwd: cwd ?? undefined,
    });
  }

  return { sessions, watermark };
}

/**
 * Summarize every opencode db file under `home` into SessionSummary records (one per session
 * row with at least one nonzero token/reasoning field) plus drift-plumbing counters, MERGED
 * with the file-store scan. Dedupe by session id: a session present in BOTH stores is emitted
 * ONCE and the FILE STORE wins (the newer, authoritative record on a 1.1+ install), so a
 * legacy SQLite row for the same id can never double-count or shadow it. Does NOT check
 * `isOfficialOpencodeHome` itself -- that gate is the CALLER's responsibility (mirrors
 * pi.ts's `scanPiCorpus`).
 */
export function scanOpencodeCorpus(state: TrackerState, home: string = opencodeHome()): OpencodeCorpusScan {
  const legacyFilesDetected = countLegacyOpencodeArtifacts(home);
  // The file store is pure JSON -- it does not need node:sqlite, so it is read even when the
  // SQLite path is unavailable below.
  const fileStore = scanOpencodeFileStore(state, home);

  /** Overlay the file-store sessions onto a SQLite-derived session map: file store wins on a
   * shared id (unconditional set), file-only sessions are added. Never a cross-store sum. */
  const overlayFileStore = (bySession: Map<string, SessionSummary>): SessionSummary[] => {
    for (const s of fileStore.sessions) bySession.set(s.toolSessionId, s);
    return [...bySession.values()];
  };

  if (!sqliteSupported()) {
    // SQLite unreadable, but the file store (JSON) may still have captured everything.
    return {
      sessions: fileStore.sessions,
      unknownLines: 0,
      totalLines: 0,
      readFailures: [],
      watermark: fileStore.watermark,
      unavailable: "node_sqlite_missing",
      legacyFilesDetected,
    };
  }

  const dbPaths = opencodeDbPaths(home);
  if (dbPaths.length === 0) {
    // No db found at all -- either opencode isn't installed, it is on the 1.1+ file layout
    // (fileStore carries that data), or (rarely) it is stuck on the legacy format
    // (legacyFilesDetected carries that signal). None is an environmental failure, so
    // `unavailable` stays unset -- the ordinary empty-result case.
    return {
      sessions: fileStore.sessions,
      unknownLines: 0,
      totalLines: 0,
      readFailures: [],
      watermark: fileStore.watermark,
      legacyFilesDetected,
    };
  }

  // Keyed by session id: the SAME session can appear in more than one channel db (a builder
  // who switched install channels), and two summaries under one digest key would race
  // nondeterministically. Deterministic winner: later endedAt, then larger token total -- the
  // more complete record (identical tie-break to pi.ts's cross-file duplicate-id case).
  const bySession = new Map<string, SessionSummary>();
  let unknownLines = 0;
  let totalLines = 0;
  let watermark = 0;
  const readFailures: string[] = [];
  let anyOpened = false;
  let anySchemaMismatch = false;

  for (const dbPath of dbPaths) {
    const handle = openSqliteReadOnly(dbPath);
    if (!handle.available) {
      if (handle.reason === "open_failed") readFailures.push(dbPath);
      // file_missing here means a glob/open race (deleted between readdirSync and open) --
      // never fatal to the rest of the scan, and not itself an "unavailable" environmental
      // block (sqliteSupported() is true and other db files may still be readable).
      continue;
    }
    anyOpened = true;
    try {
      const sessionRows = handle.query(
        "SELECT id, directory, model, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated FROM session",
      );
      // Explicit-columns-only, never `data`: message.data is the full serialized message
      // (role, content, per-message tokens) -- exactly the content column sqlite.ts forbids.
      // session_id + time_created are plain id/timestamp columns, safe metadata.
      const messageRows = handle.query("SELECT session_id, time_created FROM message ORDER BY session_id, time_created");

      const messageTimestampsBySession = new Map<string, number[]>();
      const messageCountBySession = new Map<string, number>();
      for (const row of messageRows) {
        const sid = row.session_id;
        if (typeof sid !== "string" || !sid) continue; // garbled linkage -- skip defensively, not counted (see file header scope note)
        messageCountBySession.set(sid, (messageCountBySession.get(sid) ?? 0) + 1);
        const ts = row.time_created;
        if (typeof ts === "number" && Number.isFinite(ts)) {
          if (ts > watermark) watermark = ts;
          const arr = messageTimestampsBySession.get(sid);
          if (arr) arr.push(ts);
          else messageTimestampsBySession.set(sid, [ts]);
        }
      }

      for (const row of sessionRows) {
        totalLines++;
        const id = row.id;
        if (typeof id !== "string" || !id) {
          unknownLines++;
          continue;
        }

        const input = row.tokens_input;
        const output = row.tokens_output;
        const reasoning = row.tokens_reasoning;
        const cacheRead = row.tokens_cache_read;
        const cacheWrite = row.tokens_cache_write;
        if (![input, output, reasoning, cacheRead, cacheWrite].every((n) => typeof n === "number" && Number.isFinite(n))) {
          // REAL COUNTERS ONLY -- a renamed/typed-away token column lands here as loudly as
          // pi's missing `usage` object. Never estimated, never partially credited.
          unknownLines++;
          continue;
        }

        const timeCreated = typeof row.time_created === "number" && Number.isFinite(row.time_created) ? row.time_created : null;
        const timeUpdated = typeof row.time_updated === "number" && Number.isFinite(row.time_updated) ? row.time_updated : null;
        if (timeCreated !== null && timeCreated > watermark) watermark = timeCreated;
        if (timeUpdated !== null && timeUpdated > watermark) watermark = timeUpdated;

        const tokens: TokenCounts = {
          input: Math.max(0, input as number),
          output: Math.max(0, output as number),
          cacheRead: Math.max(0, cacheRead as number),
          cacheCreation: Math.max(0, cacheWrite as number),
        };
        const thinkingTokens = Math.max(0, reasoning as number);

        // A genuinely empty/unused session (columns are valid numbers, just all zero) --
        // nothing token-accounted happened. Not drift; simply nothing to report, same rule
        // pi.ts uses for a file whose only entries carry no usable usage.
        if (tokens.input === 0 && tokens.output === 0 && tokens.cacheRead === 0 && tokens.cacheCreation === 0 && thinkingTokens === 0) {
          continue;
        }

        const modelId = parseSessionModelId(row.model) ?? "unknown";
        const models: ModelTokens[] = [{ id: modelId, ...tokens }];

        // Legacy-migrated rows may persist an EMPTY STRING directory (database/path.ts:
        // "Legacy sessions may persist an empty directory. Keep that existing value
        // readable..."). An empty string is falsy, so this already resolves to null/undefined
        // exactly like a header-less pi session with no cwd -- no special-casing needed.
        const cwd = typeof row.directory === "string" && row.directory ? row.directory : null;

        const messageTimestamps = (messageTimestampsBySession.get(id) ?? []).sort((a, b) => a - b);
        const tsPool = messageTimestamps.length > 0 ? messageTimestamps : timeCreated !== null ? [timeCreated] : [];
        const activity = computeActivity(tsPool, state.gapMs);
        // opencode's message table exposes no role column without touching the forbidden
        // `data` blob (file header) -- humanPromptTimestamps is structurally unavailable, so
        // turns/longestLoopMs are honestly 0 here, never guessed from messageCount.
        const loops = computeLoops(tsPool, [], state.gapMs);
        const startedAt = tsPool[0] ?? timeCreated ?? 0;

        const summary: SessionSummary = {
          tool: "opencode",
          toolSessionId: id,
          model: modelId,
          tokens,
          models,
          entryPoint: "cli", // no alternate entry point documented for opencode -- see file header
          thinkingTokens,
          days: undefined, // GAP (deliberate): session-level aggregates can't be split by day without smearing -- see file header
          skills: undefined, // no documented skill-invocation signal reachable without the content column
          agents: undefined, // parent_id hints at a subagent concept; no rollup implemented -- see file header
          wallMs: activity.wallMs,
          activeMs: activity.activeMs,
          idleMs: activity.idleMs,
          startedAt,
          endedAt: startedAt + activity.wallMs,
          repoHash: cwd ? repoHash(state.repoHmacKey, basename(cwd)) : null,
          messageCount: messageCountBySession.get(id) ?? 0,
          turns: loops.turns,
          longestLoopMs: loops.longestLoopMs,
          cwd: cwd ?? undefined,
        };

        const prior = bySession.get(id);
        const total = (s: SessionSummary) => s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheCreation;
        if (!prior || summary.endedAt > prior.endedAt || (summary.endedAt === prior.endedAt && total(summary) > total(prior))) {
          bySession.set(id, summary);
        }
      }
    } catch {
      // The db opened but the query shape doesn't match (missing table/column) -- the whole
      // file soft-fails with a counted signal, never a crash.
      anySchemaMismatch = true;
      readFailures.push(dbPath);
    } finally {
      handle.close();
    }
  }

  // `anySchemaMismatch && bySession.size === 0` decides "SQLite gave us nothing usable"; it is
  // captured BEFORE the file-store overlay so a file-store-only capture never masks a genuine
  // SQLite schema-mismatch signal (the file store is a separate source, not proof the db read).
  const sqliteYieldedNothing = bySession.size === 0;
  const sessions = overlayFileStore(bySession); // file store wins on any shared id
  const result: OpencodeCorpusScan = {
    sessions,
    unknownLines,
    totalLines,
    readFailures,
    watermark: Math.max(watermark, fileStore.watermark),
    legacyFilesDetected,
  };
  // `unavailable` means "this pass captured NOTHING because of an environmental block". With
  // the file store now a second, independent source, a SQLite block is only a total failure
  // when the file store ALSO yielded nothing -- otherwise the pass genuinely captured data.
  const capturedNothing = sessions.length === 0;
  if (!anyOpened && dbPaths.length > 0 && capturedNothing) result.unavailable = "open_failed";
  else if (anySchemaMismatch && sqliteYieldedNothing && capturedNothing) result.unavailable = "schema_mismatch";
  return result;
}

/** Thin wrapper matching pi.ts's `summarizePiCorpus(state, home)` signature, for call sites
 * that only need the sessions. */
export function summarizeOpencodeCorpus(state: TrackerState, home: string = opencodeHome()): SessionSummary[] {
  return scanOpencodeCorpus(state, home).sessions;
}
