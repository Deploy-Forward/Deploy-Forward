/**
 * OpenClaw capture — Wave 2 of docs/harness-adapters-implementation.md (task W2.2).
 * PARSER ONLY: sync wiring (cursors, dedupe key, digest gate) is a separate task and
 * does not live here.
 *
 * ============================================================================
 * SUPERSEDED 2026-07-14 — the database-first premise below was FALSE. Read this first.
 * ============================================================================
 * The prior revision of this file (W2.2, docs-and-source-derived — no real
 * `~/.openclaw` install existed on the build machine) asserted SQLite
 * (`agents/<agentId>/agent/openclaw-agent.sqlite`, table `transcript_events`) as the
 * primary and ONLY parsed transcript source, citing openclaw/openclaw@main's own
 * `docs/refactor/database-first.md` as decisive. That premise was DISPROVED against a
 * REAL install, OpenClaw 2026.7.1, on 2026-07-14 — verified by opening the file
 * read-only and listing `sqlite_master`:
 *
 *   `~/.openclaw/agents/main/agent/openclaw-agent.sqlite` contains ONLY: schema_meta,
 *   cache_entries, auth_profile_store, auth_profile_state, memory_embedding_cache,
 *   memory_index_chunks, memory_index_meta, memory_index_sources, memory_index_state.
 *   NO `sessions`, NO `session_entries`, NO `transcript_events` table exists.
 *   `~/.openclaw/state/openclaw.sqlite` holds gateway/device/skill/plugin/channel
 *   state (70+ tables: device_pairing_*, cron_jobs, skill_usage, worktrees, ...) — no
 *   transcript table there either.
 *
 * `npm run eval:openclaw` against this corpus, under the old code, reported
 * `sessions: 0` with a READ FAILURE on the one discovered "agent database" — zero
 * capture against a real, actively-used install. This was not a schema-version drift
 * the drift counter could have caught (the old fingerprint never matched a real
 * install's `schema_meta` shape at all, so the drift-counting scan never even ran) —
 * it was a wrong premise, caught only by the real-corpus gate this eval exists for.
 *
 * THE VERIFIED SOURCE: session transcripts are per-session JSONL files —
 *   `<home>/agents/<agentId>/sessions/<uuid>.jsonl`
 * — confirmed on-disk (`~/.openclaw/agents/main/sessions/*.jsonl`, 3 real sessions,
 * 2026-07-14; ground truth pinned in test/openclaw.test.ts). Two sidecars sit next to
 * each transcript and are DELIBERATELY NOT parsed: `<uuid>.trajectory.jsonl` (a
 * separate, richer trace stream — a different document, not this one) and
 * `<uuid>.trajectory-path.json` (a small pointer/metadata blob). A legacy
 * `sessions.json` index also lives in the sessions dir (maps a conversation key to
 * its current sessionId + a skills snapshot) — not a transcript, never read, and
 * structurally excluded anyway (it does not end in `.jsonl`).
 *
 * Verbatim sample (real corpus, session `91c1c277-9827-4353-8fcc-e4ecd55d8e57`):
 *   {"type":"session","version":3,"id":"91c1c277-...","timestamp":"2026-07-14T16:21:22.068Z","cwd":"C:\\Users\\m\\.openclaw\\workspace"}
 *   {"type":"message","id":"...","parentId":null,"timestamp":"...","message":{"role":"user","timestamp":1784046067137,"content":"...","__openclaw":{...},"idempotencyKey":"..."}}
 *   {"type":"message","id":"...","parentId":"...","timestamp":"...","message":{"role":"assistant","content":[{"type":"text","text":"test"}],"api":"openai-chatgpt-responses","provider":"openai","model":"gpt-5.6-sol","usage":{"input":18402,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":18407,"cost":{...}},"stopReason":"stop","timestamp":1784046089083,"__openclaw":{...}}}
 *
 * This is (gratifyingly) the SAME entry-tree shape the old header already documented
 * for `transcript_events.event_json` (`{type, id, parentId, timestamp, message:
 * {role, provider?, model?, usage?, content?}}`) — that description was itself lifted
 * from the vendor's legacy JSONL reader (`src/gateway/session-utils.fs.ts`), which
 * turns out to still be exactly right: the JSONL transcript never stopped being the
 * real data: only the SQLite-primacy claim was wrong. Consequence, verified not
 * assumed: `normalizeOpenClawUsage()` and `parseOpenClawSessionEvents()` (the
 * entry-JSON-shape logic) needed ZERO logic changes for this fix — their output on
 * this exact real corpus matches hand-computed ground truth (test/openclaw.test.ts).
 * Only the TRANSPORT changed: `OpenClawEventRow[]` is now built from FILE LINES
 * (`seq` = 0-based line index, `eventJson` = the raw line, `createdAt` = the file's
 * `mtimeMs`, used only when an entry's own `timestamp` is missing/unparseable — the
 * exact role the SQL `created_at` column played) instead of DB rows.
 *
 * Real messages also carry `role: "toolResult"` (tool-call results) alongside
 * `"user"`/`"assistant"` — already a documented, handled role (`parseOpenClawSessionEvents`
 * treats any non-"user"/"assistant" role as "known plumbing, no tokens"; toolResult
 * was always covered by that catch-all, never a special case needed).
 *
 * Every real message also carries `message.__openclaw.mirrorIdentity` /
 * `mirrorOrigin` (observed value: `"codex-app-server"` on all 3 sessions) — an
 * OPEN OBSERVATION, not a decision: this looks like a message-level relay/mirror
 * origin marker, and might be a future `entryPoint` candidate, but its semantics are
 * UNDOCUMENTED and unconfirmed against a channel-diverse corpus (this one is
 * uniformly one origin), so it is deliberately NOT read for anything here — reading
 * it would be inventing a mapping no source confirms. Do not confuse it with the
 * UNRELATED, already-handled `provider==="openclaw" && model==="delivery-mirror"`
 * synthetic-entry exclusion below, which is a distinct, narrower, verified check.
 *
 * ============================================================================
 * KNOWN CAPTURE LIMIT — one token-bearing entry per tool-calling turn (recorded, not fixed)
 * ============================================================================
 * Real corpus finding (session `6756fe9b-38d0-4358-aff6-dae38205be7a`, 2026-07-14): a
 * turn that calls tools logs ONE assistant entry per tool call PLUS a final assistant
 * entry with the reply. Every INTERMEDIATE tool-calling assistant entry carries
 * `usage: {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,...}` — a REAL,
 * PRESENT, all-zero usage object, not a missing one — and only the LAST assistant
 * entry of the turn carries token counts. That session's 5 assistant messages: 4
 * all-zero, 1 real (input 868, output 5, cacheRead 18176) — the session total IS that
 * one real record, unmoved by the 4 zeros. `normalizeOpenClawUsage` correctly treats a
 * present `{input:0, output:0}` as REAL zeros (numeric, not undefined), so this is
 * correctly NOT counted as drift, and the parser reports EXACTLY what the vendor
 * recorded.
 *
 * WHAT THIS DOES AND DOES NOT PROVE (claim kept at the strength the evidence supports).
 * It is UNDETERMINED from this corpus whether those zeros represent inference the
 * vendor failed to count (a true undercount) or merely a single usage attachment for a
 * turn whose cost is fully carried by the last entry (no loss at all). The timestamps
 * forbid the naive reading: the user entry sits at 16:21:55.2 and ALL NINE subsequent
 * entries (5 assistant + 4 toolResult) land inside a 114ms burst at 16:22:15.6-.76,
 * after a ~20s gap. Five separate inference round-trips cannot occur in 114ms, so these
 * are MIRRORED WRITES replayed after the fact (every message carries
 * `__openclaw.mirrorOrigin: "codex-app-server"`), and their timestamps are write-times,
 * not call-times. Settling this needs a vendor-reconcilable corpus (a provider-side
 * usage view for the same turn); until then it stays an open question, not a fact.
 *
 * What IS certain, and is the operative rule: per this repo's standing discipline (real
 * counters only; a missing counter is never a guessed number), no attempt is made to
 * redistribute the final entry's tokens back across the intermediate tool-call entries
 * — that would fabricate a split the vendor never recorded. A tool-call-heavy corpus
 * therefore shows FEWER, LUMPIER token-bearing timestamps than tool calls, and per-call
 * cost attribution is not recoverable from this format. Disclosed BOUND on the data.
 *
 * Related, and NOT to be confused with the above: `openclaw sessions --json`'s
 * per-session `inputTokens`/`outputTokens` are a LAST-TURN SNAPSHOT, not a session sum
 * (verified 2026-07-14: session `913a6e66` ran two turns of input 18410 then 841, and
 * the vendor row reports `inputTokens: 841`). This parser's per-entry sum (19251) is the
 * honest session total. A delta against the vendor's own session view is therefore
 * EXPECTED and correct — do not "fix" it.
 *
 * ============================================================================
 * Token mapping, fingerprint, multi-agent identity — carried forward from W2.2
 * ============================================================================
 * `normalizeOpenClawUsage()` mirrors (cites, does not invent) `src/agents/usage.ts`'s
 * `normalizeUsage()` alias table, because OpenClaw is genuinely multi-provider (it
 * routes turns to many different model SDKs) so the raw `usage` object's field names
 * differ per provider by design: `input`/`output`/`cacheRead`/`cacheWrite`
 * (Anthropic-native — the shape the real corpus's `openai`-provider messages
 * ALSO happen to use verbatim, confirmed against the sample above), `inputTokens`/
 * `outputTokens`/`promptTokens`/`completionTokens` and snake_case variants
 * (OpenAI-SDK-native + others), `cache_read_input_tokens`/`cache_creation_input_tokens`/
 * `cached_tokens`/`*_details.cached_tokens` (cache aliases), `reasoningTokens`/
 * `reasoning_tokens`/`*_details.reasoning_tokens` (reasoning — NOT observed in the
 * real corpus at all: all 3 real sessions carry no reasoning alias, so
 * `thinkingTokens` is 0 for every real session captured so far; that is an absence of
 * signal, not a bug), `prompt_n`/`predicted_n`/`timings.*` (llama.cpp-style).
 * `total`/`totalTokens`/`total_tokens` is read but NEVER treated as a substitute for a
 * missing input/output split, and never cross-checked against the summed fields — no
 * source guarantees it equals input+output+cache*. The real corpus's `usage.cost`
 * sub-object (`{input,output,cacheRead,cacheWrite,total}`, always zero in this
 * corpus) is likewise never read: a point-in-time cost estimate, not a token count.
 *
 * `message.provider === "openclaw" && message.model === "delivery-mirror"` is a
 * documented SYNTHETIC bookkeeping entry — never a real inference call. Excluded from
 * `messageCount` and never credited. (Not observed in the real 3-session corpus, which
 * has no such entries — this check remains defensive plumbing, unverified-but-cheap.)
 *
 * entryPoint: DOWNGRADED to permanently `"unknown"` by this migration. The old design
 * read `sessions.channel` (a SQL column: `whatsapp`/`telegram`/`slack`/CLI-origin
 * values) for this field — that column no longer exists anywhere we read. The real
 * JSONL transcript (header line + message entries) carries NO documented
 * channel/entry-point-equivalent field (see the `mirrorOrigin` observation above,
 * deliberately not used for this). OpenClaw remains fundamentally a multi-channel
 * product, but this parser currently has no honest signal to report beyond
 * `"unknown"` — never guessed, never defaulted to `"cli"`.
 *
 * cwd/repoHash: now sourced from the session HEADER's own `cwd` field (`{"type":
 * "session", id, cwd, ...}`), not from `session_entries.entry_json.spawnedCwd` (that
 * table doesn't exist here either). Real-corpus finding worth flagging: all 3
 * observed sessions carry the SAME `cwd` — the OpenClaw agent's own fixed workspace
 * directory (`~/.openclaw/workspace`), not a per-repo directory the way the old
 * `spawnedCwd` design was documented to behave for "spawned" coding-harness sessions.
 * `repoHash` therefore currently collapses to one bucket per agent install in this
 * corpus shape, rather than distinguishing repos/projects — an accurate reflection of
 * what the real header carries today, not a bug to chase without more corpus
 * evidence. Absent/null header cwd -> `cwd: undefined` / `repoHash: null`, same as
 * every other adapter's "no cwd carried" case — never guessed.
 *
 * Fingerprint (`isOfficialOpenClawCli`): no proprietary CONTENT string is documented
 * for this JSONL header shape (matching pi.ts's own admission for its nearly-identical
 * header — same tree, same header keys). The chosen mark is STRUCTURAL: at least one
 * `agents/<agentId>/sessions/` directory must contain at least one non-trajectory
 * `*.jsonl` file whose FIRST LINE parses as `{"type":"session", id: <non-empty
 * string>}`. WEAKNESS (recorded, not hidden): this cannot, and does not claim to,
 * distinguish "written by the official openclaw binary" from "written by any product
 * that happens to emit this exact header shape at this exact path" — the honest claim
 * is "vendor-format data at the vendor(-or-override) home," never "produced by the
 * official binary." No fork research has been run against this JSONL shape
 * specifically (the fork research the prior revision cited targeted the now-abandoned
 * SQLite `schema_meta`/`role` columns, which this fingerprint no longer reads at all
 * and which is therefore MOOT, not resolved) — an OPEN GAP.
 *
 * Multi-agent wrinkle (per docs/harness-adapters-implementation.md §2, UNCHANGED by
 * this migration): sessions live under PER-AGENT directories
 * (`agents/<agentId>/sessions/`) — one BUILDER can run many `agentId`s. `agentId` is
 * NEVER part of session identity; a session id colliding across two agent directories
 * (a synced/copied `.openclaw` tree, or two agent profiles pointed at overlapping
 * state) dedupes deterministically to ONE summary — later `endedAt`, then larger
 * token total wins (the identical pi.ts rule, `scanPiCorpus`'s `bySession` map).
 *
 * ============================================================================
 * OPEN GAPS (recorded, not hidden) — narrower than before, several genuinely closed
 * ============================================================================
 * CLOSED by the real-corpus pass: whether `*_at` columns are epoch-ms (moot — no SQL
 * columns are read at all anymore); whether `transcript_events`/`session_entries`
 * deserialize as assumed (moot, same reason); the SQLite `schema_meta`/`role`
 * fingerprint's fork-collision risk (moot — that check is gone).
 * STILL OPEN: whether a larger real corpus ever shows a `message.role` beyond
 * `user`/`assistant`/`toolResult`, or a top-level entry `type` beyond `session`/
 * `message` (only 3 sessions / ~20 message-type lines examined so far — a small
 * sample; `KNOWN_ENTRY_TYPES`'s non-message members — `custom_message`, `custom`,
 * `compaction`, `branch_summary` — are carried forward from the docs/source research
 * but UNOBSERVED in this real corpus); whether OpenClaw ever replays entries across
 * SIBLING session files the way Claude's resume/fork does (not observed here; this
 * parser has no cross-file dedup mechanism, the same disclosed gap pi.ts carries for
 * its nearly-identical format); whether `<uuid>.trajectory.jsonl` carries a
 * genuinely richer signal a future wave might want (deliberately unparsed here);
 * whether `sessions.json` (the legacy conversation-key -> sessionId pointer index,
 * also seen on disk) is ever needed for anything this transcript doesn't already
 * carry (deliberately unread — index/pointer metadata, not a transcript); whether
 * `cwd` ever varies per-session on a real install with multiple workspaces (this
 * corpus has exactly one workspace, so repoHash diversity is untested). Given only
 * ONE version point (2026.7.1) has been verified, `providers.ts` deliberately leaves
 * `minKnownGoodVersion: null` for this adapter — no floor is asserted from a single
 * data point.
 */
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { creditModel, foldModelBuckets, addTokens, ZERO } from "./jsonl.js";
import { sessionMue, lastNonzeroOccupancy } from "./contextEfficiency.js";
import { computeActivity, computeLoops, sliceActivityByDay, utcDayKey, type ActivityDaySlice } from "./activity.js";
import { repoHash, type TrackerState } from "./config.js";
import type { SessionSummary, SessionDaySlice, TokenCounts } from "./types.js";

export function openclawHome(): string {
  // DF_OPENCLAW_HOME stays first (our hermetic-test/override contract), then the
  // VENDOR's documented relocation env (docs.openclaw.ai migration guide, read
  // 2026-07-14): OPENCLAW_STATE_DIR moves the whole state home for official installs —
  // ignoring it was a confirmed false negative (official usage silently uncaptured).
  // KNOWN REMAINING GAP (recorded, not built): official profiles use SIBLING dirs
  // (~/.openclaw-<profile>/) — a multi-home discovery change, deferred until a real
  // profiled corpus exists; a profiled user is under-captured, never mis-captured.
  // UNCHANGED by the 2026-07-14 JSONL migration (this resolver never touched SQLite).
  if (process.env.DF_OPENCLAW_HOME) return process.env.DF_OPENCLAW_HOME;
  const vendorEnv = process.env.OPENCLAW_STATE_DIR?.trim();
  if (vendorEnv) return vendorEnv;
  return join(homedir(), ".openclaw");
}

export function openclawAgentsRoot(home: string = openclawHome()): string {
  return join(home, "agents");
}

/** One session transcript file discovered on disk. */
export interface OpenClawSessionFile {
  agentId: string;
  path: string;
}

/**
 * All `agents/<agentId>/sessions/*.jsonl` transcript files under the OpenClaw home —
 * one file per session, one directory per agentId — EXCLUDING the `.trajectory.jsonl`
 * sidecar (a separate, richer trace stream; a different document, never parsed here)
 * and anything else that isn't a `.jsonl` file (the `.trajectory-path.json` sidecar,
 * the legacy `sessions.json` pointer index, and any subdirectory such as the real
 * corpus's `sessions/skills-prompts/`). Deliberately no `isFile()` check on the inner
 * listing (plain string names, matching pi.ts's `piSessionFiles` idiom exactly) so a
 * directory sitting where a file should be is still discovered here and surfaces as a
 * read failure in the scan below, never silently skipped. One unreadable directory
 * never aborts the walk. Sorted by path for deterministic output (readFailures order,
 * test fixtures).
 */
export function openclawSessionFiles(home: string = openclawHome()): OpenClawSessionFile[] {
  const root = openclawAgentsRoot(home);
  const out: OpenClawSessionFile[] = [];
  let agentDirs: Dirent[];
  try {
    agentDirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of agentDirs) {
    if (!d.isDirectory()) continue;
    const sessionsDir = join(root, d.name, "sessions");
    let files: string[];
    try {
      files = readdirSync(sessionsDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl") || f.endsWith(".trajectory.jsonl")) continue;
      out.push({ agentId: d.name, path: join(sessionsDir, f) });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

interface OpenClawSessionHeader {
  id: string;
  cwd: string | null;
}

/** Parse (and validate the shape of) a session file's first line -- the `type:
 * "session"` header carrying the session id and cwd. Returns null for anything that
 * doesn't match -- never guessed, never partial (mirrors pi.ts's `parseHeaderLine`).
 * Shared by the fingerprint below and by `parseOpenClawSessionFile`'s identity
 * extraction, so both read the SAME minimal shape. */
function parseSessionHeaderLine(line: string): OpenClawSessionHeader | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const o = obj as Record<string, unknown>;
  if (o?.type !== "session") return null;
  if (typeof o.id !== "string" || !o.id) return null;
  return { id: o.id, cwd: typeof o.cwd === "string" ? o.cwd : null };
}

/**
 * Is `home` an official OpenClaw install? Structural fingerprint (see file header for
 * the weakness this carries): at least one discovered session file's FIRST LINE must
 * parse as the documented session header shape. Reuses `openclawSessionFiles` rather
 * than a separate strict walk (unlike pi.ts's split between a strict
 * `isOfficialPiCli` and a loose `piSessionFiles`): OpenClaw's `agentId` directory name
 * carries no analogous format constraint to pi's `--cwd--` encoding, so there is no
 * extra "strictness" a separate walk could add here. No mark (or nothing under
 * `agents/`) -> we capture NOTHING from this tree (never guess which product wrote a
 * file). No `node:sqlite` dependency of any kind -- this is a pure filesystem check.
 */
export function isOfficialOpenClawCli(home: string = openclawHome()): boolean {
  for (const f of openclawSessionFiles(home)) {
    let firstLine: string;
    try {
      firstLine = readFileSync(f.path, "utf8").split("\n", 1)[0]?.trim() ?? "";
    } catch {
      continue;
    }
    if (parseSessionHeaderLine(firstLine)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Token normalization — mirrors src/agents/usage.ts's normalizeUsage() alias table
// verbatim (see file header for why: OpenClaw is genuinely multi-provider, so the raw
// field names differ by design across the underlying SDKs it routes to). UNCHANGED by
// the 2026-07-14 JSONL migration -- this logic operates on entry JSON, identical
// whether it arrived via a DB column or a file line, and matches the real corpus.
// ---------------------------------------------------------------------------

interface RawOpenClawUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  promptTokens?: unknown;
  completionTokens?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cached_tokens?: unknown;
  input_tokens_details?: { cached_tokens?: unknown };
  prompt_tokens_details?: { cached_tokens?: unknown };
  reasoningTokens?: unknown;
  reasoning_tokens?: unknown;
  completion_tokens_details?: { reasoning_tokens?: unknown };
  output_tokens_details?: { reasoning_tokens?: unknown };
  total?: unknown;
  totalTokens?: unknown;
  total_tokens?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  prompt_n?: unknown;
  predicted_n?: unknown;
  timings?: { prompt_n?: unknown; predicted_n?: unknown };
}

/** Normalized OpenClaw usage. `undefined` on a field means the raw object carried NO
 * alias for it at all (never guessed); `0` means an alias was present and non-positive. */
export interface NormalizedOpenClawUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoningTokens?: number;
  total?: number;
}

/** Same clamp/truncate rule as usage.ts's `normalizeTokenCount`: absent/non-numeric ->
 * undefined (field never carried), non-positive -> 0 (field carried, valid, zero). */
function normalizeTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value <= 0) return 0;
  return Math.trunc(value);
}

/**
 * Normalize one raw provider `usage` object into OpenClaw's canonical buckets. Mirrors
 * `normalizeUsage()` in `src/agents/usage.ts` (openclaw/openclaw@main) field-for-field;
 * `contextUsage`/`cost` are deliberately not carried through (see file header — context
 * usage is a point-in-time budget estimate, never an additive token count, and the
 * real corpus's `usage.cost` sub-object is always zero here anyway).
 */
export function normalizeOpenClawUsage(raw: unknown): NormalizedOpenClawUsage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as RawOpenClawUsage;

  const cacheRead = normalizeTokenCount(
    r.cacheRead ??
      r.cache_read ??
      r.cache_read_input_tokens ??
      r.cached_tokens ??
      r.input_tokens_details?.cached_tokens ??
      r.prompt_tokens_details?.cached_tokens,
  );

  const rawInputValue =
    r.input ?? r.inputTokens ?? r.input_tokens ?? r.promptTokens ?? r.prompt_tokens ?? r.prompt_n ?? r.timings?.prompt_n;

  // OpenAI-style prompt/input totals INCLUDE the cached portion; Anthropic-style input
  // already excludes it. Detect via presence of any cached-tokens alias (the same
  // signal usage.ts uses), and subtract only in that case — matching Grok's identical
  // prompt/cached convention in grok.ts.
  const usesOpenAIStylePromptTotals =
    r.cached_tokens !== undefined ||
    r.input_tokens_details?.cached_tokens !== undefined ||
    r.prompt_tokens_details?.cached_tokens !== undefined;
  const rawInput = normalizeTokenCount(rawInputValue);
  const input =
    rawInput !== undefined && usesOpenAIStylePromptTotals && cacheRead !== undefined
      ? Math.max(0, rawInput - cacheRead)
      : rawInput;

  const output = normalizeTokenCount(
    r.output ?? r.outputTokens ?? r.output_tokens ?? r.completionTokens ?? r.completion_tokens ?? r.predicted_n ?? r.timings?.predicted_n,
  );
  const cacheWrite = normalizeTokenCount(r.cacheWrite ?? r.cache_write ?? r.cache_creation_input_tokens);
  const reasoningTokens = normalizeTokenCount(
    r.reasoningTokens ?? r.reasoning_tokens ?? r.completion_tokens_details?.reasoning_tokens ?? r.output_tokens_details?.reasoning_tokens,
  );
  const total = normalizeTokenCount(r.total ?? r.totalTokens ?? r.total_tokens);

  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    reasoningTokens === undefined &&
    total === undefined
  ) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, reasoningTokens, total };
}

// ---------------------------------------------------------------------------
// Transcript-event parsing — one row at a time (a file LINE now, a DB row before the
// 2026-07-14 migration; the row shape and this function's logic are UNCHANGED --
// see file header for why entry-JSON semantics never needed to change).
// ---------------------------------------------------------------------------

/** Known top-level `type` values confirmed across the fetched docs/source for
 * OpenClaw's transcript entries. Anything else is drift/damage and is counted.
 * `"session"`/`"message"` are the only two types actually OBSERVED in the real
 * 2026-07-14 corpus (a small, 3-session sample); the rest are carried forward from
 * the original docs/source research, unconfirmed against real data (see file header
 * OPEN GAPS). */
const KNOWN_ENTRY_TYPES = new Set(["session", "message", "custom_message", "custom", "compaction", "branch_summary"]);

/** One raw transcript-event row: `seq`/`eventJson`/`createdAt` are now populated from
 * a FILE LINE (0-based line index, the raw line text, and the file's `mtimeMs`
 * fallback) rather than a `transcript_events` SQL row -- see `parseOpenClawSessionFile`
 * below. The shape is unchanged so `parseOpenClawSessionEvents` needed no edits. */
export interface OpenClawEventRow {
  seq: number;
  eventJson: string;
  createdAt: number;
}

/** One real, token-accounted, model-resolved assistant message. */
interface ResolvedUsage {
  ts: number;
  model: string;
  tokens: TokenCounts;
  reasoningTokens: number;
}

/** Everything extracted from one session's ordered transcript-event rows. */
export interface OpenClawSessionAtoms {
  /** Real, token-accounted, model-resolved assistant usage, sorted by ts ascending. */
  usage: ResolvedUsage[];
  /** Every dated entry (any known type) — the activity stream. */
  timestamps: number[];
  /** `message.role === "user"` entries — turns. */
  humanPromptTimestamps: number[];
  /** Every non-delivery-mirror assistant message OBSERVED, whether or not it carried
   * usable token data (mirrors pi.ts's `messageCount` semantics exactly). */
  messageCount: number;
  /** Rows that failed to JSON.parse, carried an unrecognized top-level `type`, OR were
   * an assistant message whose usage did not resolve to a real input+output pair (the
   * W2 bounds ruling: a totalTokens-only record is drift, never a fabricated split). */
  unknownLines: number;
  /** Every row seen — the drift-rate denominator. */
  totalLines: number;
}

/**
 * Resolve one transcript entry's own timestamp: `timestamp` field, ISO string or Unix
 * ms number (the exact dual-format tolerance `readTranscriptRecordTimestampMs` in
 * OpenClaw's own `src/gateway/session-transcript-readers.ts` uses) — falling back to
 * the row's `createdAt` (the file's `mtimeMs`, post-migration; always present) when
 * the JSON timestamp is absent or unparseable.
 */
function resolveEventTimestamp(parsed: Record<string, unknown>, createdAt: number): number {
  const raw = parsed.timestamp;
  const ts = typeof raw === "string" ? Date.parse(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(ts) ? ts : createdAt;
}

/**
 * Parse one session's ordered event rows (already in file order via the caller's
 * `seq`). Defensive: a corrupt row or unrecognized entry type is counted and skipped,
 * never fatal to the rest of the session. UNCHANGED by the 2026-07-14 migration --
 * this function does not know or care whether its rows came from a database or a
 * file; verified against the real corpus's exact numbers (test/openclaw.test.ts).
 */
export function parseOpenClawSessionEvents(rows: OpenClawEventRow[]): OpenClawSessionAtoms {
  const out: OpenClawSessionAtoms = {
    usage: [],
    timestamps: [],
    humanPromptTimestamps: [],
    messageCount: 0,
    unknownLines: 0,
    totalLines: 0,
  };
  const rawUsage: { ts: number; model: string; tokens: TokenCounts; reasoningTokens: number }[] = [];

  for (const row of rows) {
    out.totalLines++;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.eventJson) as Record<string, unknown>;
    } catch {
      out.unknownLines++; // a corrupt row is drift/damage — same bucket as an unrecognized type
      continue;
    }
    const type = parsed.type;
    if (typeof type !== "string" || !KNOWN_ENTRY_TYPES.has(type)) {
      out.unknownLines++;
      continue;
    }

    const ts = resolveEventTimestamp(parsed, row.createdAt);
    out.timestamps.push(ts);

    if (type !== "message") continue; // custom_message/custom/compaction/branch_summary/session: known, no tokens

    const message = parsed.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") continue; // shape drift inside a "message" entry -- not fatal, just nothing to credit
    const role = message.role;
    if (role === "user") {
      out.humanPromptTimestamps.push(ts);
      continue;
    }
    if (role !== "assistant") continue; // toolResult or unrecognized role: known plumbing, no tokens

    const modelProvider =
      typeof message.provider === "string" ? message.provider.trim() : typeof parsed.provider === "string" ? (parsed.provider as string).trim() : "";
    const model =
      typeof message.model === "string" ? message.model.trim() : typeof parsed.model === "string" ? (parsed.model as string).trim() : "";

    // Documented synthetic bookkeeping entry (OpenClaw's own reader excludes it by the
    // same name check) -- never a real inference call, never counted as a message.
    if (modelProvider === "openclaw" && model === "delivery-mirror") continue;

    out.messageCount++;

    const usageRaw =
      message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
        ? message.usage
        : parsed.usage && typeof parsed.usage === "object" && !Array.isArray(parsed.usage)
          ? parsed.usage
          : undefined;
    const usage = normalizeOpenClawUsage(usageRaw);

    if (!usage || typeof usage.input !== "number" || typeof usage.output !== "number") {
      // REAL counters only -- the W2 bounds ruling: a usage object with only a
      // `total`/`totalTokens` alias (or no usage at all) is skipped and counted as
      // drift, never split by invention. Vendor calls these counters "best-effort/
      // provider-dependent"; bounds/drift carry the weight here, not a guessed split.
      out.unknownLines++;
      continue;
    }

    rawUsage.push({
      ts,
      model: model || modelProvider || "unknown",
      tokens: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead ?? 0,
        cacheCreation: usage.cacheWrite ?? 0,
      },
      reasoningTokens: usage.reasoningTokens ?? 0,
    });
  }

  rawUsage.sort((a, b) => a.ts - b.ts);
  for (const r of rawUsage) out.usage.push(r);
  out.timestamps.sort((a, b) => a - b);
  out.humanPromptTimestamps.sort((a, b) => a - b);
  return out;
}

/** `parseOpenClawSessionEvents`'s atoms, plus the session identity/metadata that used
 * to come from the SQL `sessions`/`session_entries` tables and now comes from the
 * file's own `type:"session"` header line. */
export interface OpenClawFileAtoms extends OpenClawSessionAtoms {
  /** The header line's `id`, or null when the header is absent/unparseable (the
   * caller falls back to the filename stem — never invented here). */
  sessionId: string | null;
  /** The header line's `cwd`, or null when absent/unparseable/not carried — never
   * invented (see file header: the real corpus's cwd is the agent's fixed workspace,
   * not necessarily a per-repo directory). */
  cwd: string | null;
}

/**
 * Parse one session FILE's raw content: split into lines (blank lines skipped, never
 * counted), build the `OpenClawEventRow[]` the UNCHANGED `parseOpenClawSessionEvents`
 * expects (`seq` = 0-based line index, `eventJson` = the trimmed line, `createdAt` =
 * `mtimeFallbackMs` — the file's mtime, this format's per-file analog of the old SQL
 * `created_at` column), and separately extract the session id/cwd from line one's
 * header (independent of `parseOpenClawSessionEvents`, which treats a `"session"`
 * entry as a known, tokenless, timestamp-only row and does not own identity —
 * exactly as it did before this migration, when identity came from a SEPARATE SQL
 * table).
 */
export function parseOpenClawSessionFile(content: string, mtimeFallbackMs: number): OpenClawFileAtoms {
  const rows: OpenClawEventRow[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push({ seq: rows.length, eventJson: trimmed, createdAt: mtimeFallbackMs });
  }

  const header = rows.length > 0 ? parseSessionHeaderLine(rows[0].eventJson) : null;
  const atoms = parseOpenClawSessionEvents(rows);
  return { ...atoms, sessionId: header?.id ?? null, cwd: header?.cwd ?? null };
}

// ---------------------------------------------------------------------------
// Day slicing — identical crediting walk to pi.ts's buildPiDaySlices. UNCHANGED by
// the 2026-07-14 migration.
// ---------------------------------------------------------------------------

function buildOpenClawDaySlices(
  activityDays: Map<string, ActivityDaySlice>,
  usage: ResolvedUsage[],
): SessionDaySlice[] | undefined {
  const tokensByDay = new Map<string, Map<string, TokenCounts>>();
  for (const u of usage) {
    const day = utcDayKey(u.ts);
    let dayModels = tokensByDay.get(day);
    if (!dayModels) {
      dayModels = new Map();
      tokensByDay.set(day, dayModels);
    }
    creditModel(dayModels, u.model, u.tokens);
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

// ---------------------------------------------------------------------------
// Whole-corpus scan across every session file — mirrors pi.ts's `scanPiCorpus`
// structure exactly (per-file parse, whole-corpus dedupe fold, no separate
// per-file-exported scan function).
// ---------------------------------------------------------------------------

/** `scanOpenClawCorpus`'s full result — sessions plus the W2 drift-plumbing counters,
 * summed across every session file in the corpus. */
export interface OpenClawCorpusScan {
  sessions: SessionSummary[];
  unknownLines: number;
  totalLines: number;
  /** Session file paths that could not be opened/read this pass (locked, corrupt, or
   * a directory sitting where the file should be). The caller must not treat this as
   * "zero sessions" -- it means "unread," not "empty," and must never advance that
   * file's cursor (the pi read-failure rule). */
  readFailures: string[];
}

/**
 * Summarize the whole OpenClaw corpus (every discovered session file) into
 * SessionSummary records plus drift-plumbing counters. Does NOT check
 * `isOfficialOpenClawCli` itself -- that gate is the CALLER's responsibility (mirrors
 * pi.ts's `scanPiCorpus` / grok.ts's `summarizeGrokCorpus`, both gated externally by
 * sync.ts). Cumulative + deterministic: a re-scan of unchanged files yields
 * byte-identical records.
 *
 * Multi-agent dedupe (see file header): a session id appearing under more than one
 * agentId's directory keeps the record with the later `endedAt`, then the larger
 * token total -- the identical rule `scanPiCorpus` applies across duplicate session
 * files.
 */
export function scanOpenClawCorpus(state: TrackerState, home: string = openclawHome()): OpenClawCorpusScan {
  const bySession = new Map<string, SessionSummary>();
  let unknownLines = 0;
  let totalLines = 0;
  const readFailures: string[] = [];

  for (const file of openclawSessionFiles(home)) {
    let content: string;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file.path).mtimeMs;
      content = readFileSync(file.path, "utf8");
    } catch {
      readFailures.push(file.path); // one unreadable file never aborts the scan — but its cursor must not advance
      continue;
    }
    const atoms = parseOpenClawSessionFile(content, mtimeMs);
    unknownLines += atoms.unknownLines;
    totalLines += atoms.totalLines;
    if (atoms.usage.length === 0) continue; // no real-token-accounted entries -- nothing to report

    const byModel = new Map<string, TokenCounts>();
    let thinkingTokens = 0;
    for (const u of atoms.usage) {
      creditModel(byModel, u.model, u.tokens);
      thinkingTokens += u.reasoningTokens;
    }
    const models = foldModelBuckets(byModel);
    const tokens: TokenCounts = { ...ZERO };
    for (const m of models) addTokens(tokens, m);

    // Timestamp pool: entry-level timestamps when present; fall back to the usage
    // atoms' own ts so a token-bearing session never misdates to startedAt=0 (the
    // same rule pi.ts documents for its tsPool).
    const tsPool = atoms.timestamps.length > 0 ? atoms.timestamps : atoms.usage.map((u) => u.ts).sort((a, b) => a - b);
    const activity = computeActivity(tsPool, state.gapMs);
    const loops = computeLoops(tsPool, atoms.humanPromptTimestamps, state.gapMs);
    const startedAt = tsPool[0] ?? 0;
    const activityDays = sliceActivityByDay(tsPool, state.gapMs);
    const days = buildOpenClawDaySlices(activityDays, atoms.usage);

    const summary: SessionSummary = {
      tool: "openclaw",
      toolSessionId: atoms.sessionId ?? basename(file.path).replace(/\.jsonl$/, ""),
      model: atoms.usage[atoms.usage.length - 1]?.model ?? models[0]?.id ?? "unknown",
      tokens,
      models,
      // No documented entry-point/channel field survives in the JSONL transcript (see
      // file header) -- honestly "unknown" for every session, never guessed/defaulted.
      entryPoint: "unknown",
      thinkingTokens,
      // MUE (docs/model-use-efficiency.md): OpenClaw records per-message token usage, so the
      // exponent is computable — the SAME vendor-neutral seam Claude/pi use. Absent when short.
      mue: sessionMue(atoms.usage),
      // Context occupancy (lane T3): LOCAL-ONLY. Ruling (coordinator addendum): the last
      // NONZERO-usage message wins -- a chronologically-last all-zero tool-call snapshot (a
      // known OpenClaw capture shape) is skipped, never reported as a lying zero occupancy.
      context: lastNonzeroOccupancy(atoms.usage),
      days,
      skills: undefined, // no documented skill-invocation signal in OpenClaw's transcript format
      agents: undefined, // no documented subagent-dispatch signal distinct from spawnedBy/agent_harness_id
      wallMs: activity.wallMs,
      activeMs: activity.activeMs,
      idleMs: activity.idleMs,
      startedAt,
      endedAt: startedAt + activity.wallMs,
      // Repo identity: HMAC of the session header's cwd basename -- same local-only
      // pseudonym scheme every other adapter uses. null when no cwd was ever recorded.
      repoHash: atoms.cwd ? repoHash(state.repoHmacKey, basename(atoms.cwd)) : null,
      messageCount: atoms.messageCount,
      turns: loops.turns,
      longestLoopMs: loops.longestLoopMs,
      cwd: atoms.cwd ?? undefined,
    };

    const prior = bySession.get(summary.toolSessionId);
    const total = (s: SessionSummary) => s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheCreation;
    if (!prior || summary.endedAt > prior.endedAt || (summary.endedAt === prior.endedAt && total(summary) > total(prior))) {
      bySession.set(summary.toolSessionId, summary);
    }
  }

  return { sessions: [...bySession.values()], unknownLines, totalLines, readFailures };
}

/** Thin wrapper matching pi.ts's `summarizePiCorpus(state, home)` / grok.ts's
 * `summarizeGrokCorpus(state, home)` signature, for call sites that only need the
 * sessions. Sync itself should call `scanOpenClawCorpus` directly so the drift
 * counters ride the same single scan instead of being discarded. */
export function summarizeOpenClawCorpus(state: TrackerState, home: string = openclawHome()): SessionSummary[] {
  return scanOpenClawCorpus(state, home).sessions;
}
