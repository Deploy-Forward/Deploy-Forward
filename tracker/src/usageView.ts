/**
 * Local usage view — a bird's-eye per-model summary + remaining-window estimates
 * (`deploy-forward usage`, inspired by github.com/steipete/CodexBar).
 *
 * READ-ONLY, LOCAL DISPLAY ONLY. This folds the SAME transcript metadata sync.ts already
 * parses (tokens, models, timestamps — never code, prompts, or file contents) and prints
 * it to the terminal. Nothing here uploads anything new. It must never mutate persisted
 * tracker state (cursors, threadDigests): every call into sync.ts's summarizers is handed
 * a throwaway deep copy of the loaded state, never the live object `syncOnce` advances.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { findSources, findCodexTranscripts, summarizeClaudeCorpus, summarizeFile } from "./sync.js";
import { extractClaudeAtoms, dedupeClaudeUsageEntries, type ClaudeUsageEntry } from "./jsonl.js";
import { parseCodexRollout } from "./codex.js";
import { loadState, type TrackerState } from "./config.js";
import { listUserRates } from "./userRates.js";
import type { SessionSummary, TokenCounts, ModelTokens, UserRate } from "./types.js";
import * as ui from "./ui.js";
import { PRICING, priceForModel, type ModelPricing } from "./core/pricing.js";

function totalOf(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheCreation;
}

// ---- Per-model corpus fold -------------------------------------------------------------------

export interface UsageRow extends TokenCounts {
  model: string;
  total: number;
}

/**
 * Fold every session's per-model buckets (Claude + Codex alike) into one table, sorted by
 * total desc, plus a derived TOTAL row. The total is SUMMED from the rows, never an
 * independently stored number — same discipline sync.ts uses for its per-thread totals.
 */
export function foldModelRows(summaries: Pick<SessionSummary, "models">[]): { rows: UsageRow[]; total: UsageRow } {
  const byModel = new Map<string, TokenCounts>();
  for (const s of summaries) {
    for (const m of s.models) {
      const prev = byModel.get(m.id) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      prev.input += m.input;
      prev.output += m.output;
      prev.cacheRead += m.cacheRead;
      prev.cacheCreation += m.cacheCreation;
      byModel.set(m.id, prev);
    }
  }
  const rows: UsageRow[] = [...byModel.entries()]
    .map(([model, t]) => ({ model, ...t, total: totalOf(t) }))
    .sort((a, b) => b.total - a.total);
  const totalTokens: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const r of rows) {
    totalTokens.input += r.input;
    totalTokens.output += r.output;
    totalTokens.cacheRead += r.cacheRead;
    totalTokens.cacheCreation += r.cacheCreation;
  }
  return { rows, total: { model: "TOTAL", ...totalTokens, total: totalOf(totalTokens) } };
}

/**
 * Read the WHOLE local corpus (Claude + Codex) and fold it per model. Read-only: the
 * sync.ts summarizers are each handed a fresh deep-copied throwaway state, so this view
 * can never advance a cursor or a thread digest — that would desync the next real
 * `sync`/hooks pass, which is the one thing this command must never do.
 */
export function readLocalModelRows(): { rows: UsageRow[]; total: UsageRow } {
  const state: TrackerState = loadState();
  const sources = findSources();
  const summaries: Pick<SessionSummary, "models">[] = [];

  const claude = sources.filter((s) => s.tool === "claude_code");
  if (claude.length > 0) {
    summaries.push(
      ...summarizeClaudeCorpus(
        claude.map((s) => ({ path: s.path, subagents: s.subagents })),
        structuredClone(state),
      ),
    );
  }
  for (const s of sources) {
    if (s.tool !== "codex") continue;
    const summary = summarizeFile(s.path, structuredClone(state), "codex", []);
    if (summary) summaries.push(summary);
  }
  return foldModelRows(summaries);
}

// ---- Per-project fold (usage --by-project) -------------------------------------------------
//
// PRIVACY NOTE: a "project" label here is a local directory name (Claude) or a local working
// directory path (Codex) -- either can be a client name. This is LOCAL DISPLAY ONLY: nothing
// in this file uploads anything, and this view must never touch a sync/upload path.

export interface ProjectRow extends TokenCounts {
  project: string;
  total: number;
  /** Per-model breakdown within this project -- drives topModel and (with --cost) the
   * estimated cost; VERBATIM model ids, same convention as SessionSummary.models. */
  models: ModelTokens[];
  /** The model with the largest total within this project. */
  topModel: string;
  /** Sum of estimateCostUsd() over `models`, counting only priced models; null when NONE
   * of this project's models has a known public list price (see PRICES below). */
  estCostUsd: number | null;
}

/**
 * Fold per-project groups of session summaries into ProjectRow[], sorted by total desc.
 * Reuses foldModelRows for EACH group's per-model breakdown (same arithmetic the per-model
 * view uses, just scoped to one project's summaries) -- one fold implementation, not two.
 */
export function foldProjectRows(groups: { project: string; summaries: Pick<SessionSummary, "models">[] }[]): ProjectRow[] {
  const rows: ProjectRow[] = groups
    .map(({ project, summaries }) => {
      const { rows: modelRows, total } = foldModelRows(summaries);
      const models: ModelTokens[] = modelRows.map((r) => ({ id: r.model, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheCreation: r.cacheCreation }));
      return {
        project,
        input: total.input,
        output: total.output,
        cacheRead: total.cacheRead,
        cacheCreation: total.cacheCreation,
        total: total.total,
        models,
        topModel: modelRows.length > 0 ? modelRows[0].model : "(none)", // modelRows already sorted by total desc
        estCostUsd: estimateGroupCostUsd(models),
      };
    })
    // A project whose transcripts carry zero measurable usage (empty/crashed session files,
    // or every thread there deduped away into a sibling elsewhere) has nothing to attribute --
    // dropping it isn't hiding data, there is no token to show.
    .filter((r) => r.total > 0);
  return rows.sort((a, b) => b.total - a.total);
}

/**
 * Read the whole local corpus grouped by project, per tool:
 *  - Claude Code: label = the parent directory name of the transcript path, VERBATIM. That
 *    directory is Claude Code's own sanitized-cwd name (~/.claude/projects/<sanitized-cwd>/) --
 *    it is NOT de-mangled back into a real path (that transform is lossy and would risk
 *    fabricating a path that never existed).
 *  - Codex: label = the `cwd` recorded in the rollout's own session_meta line (plumbed through
 *    parseCodexRollout -> summarizeFile), or "(unknown)" when a rollout carries none.
 *
 * Read-only, same discipline as readLocalModelRows(): every summarizer call gets a fresh
 * structuredClone(state) throwaway, so this view can never advance a cursor or thread digest.
 */
export function readLocalProjectRows(): ProjectRow[] {
  const state: TrackerState = loadState();
  const sources = findSources();
  const byProject = new Map<string, Pick<SessionSummary, "models">[]>();
  const push = (project: string, summaries: Pick<SessionSummary, "models">[]): void => {
    const arr = byProject.get(project);
    if (arr) arr.push(...summaries);
    else byProject.set(project, [...summaries]);
  };

  // Claude: group ROOT sources by project label first, then fold each project's sources
  // through summarizeClaudeCorpus exactly like readLocalModelRows does -- cross-file
  // (resume/fork) dedup still applies, just scoped to the sources sharing a label.
  const claudeByProject = new Map<string, { path: string; subagents: string[] }[]>();
  for (const s of sources) {
    if (s.tool !== "claude_code") continue;
    const project = basename(dirname(s.path));
    const arr = claudeByProject.get(project);
    if (arr) arr.push({ path: s.path, subagents: s.subagents });
    else claudeByProject.set(project, [{ path: s.path, subagents: s.subagents }]);
  }
  for (const [project, group] of claudeByProject) {
    push(project, summarizeClaudeCorpus(group, structuredClone(state)));
  }

  // Codex: per-file, same as readLocalModelRows.
  for (const s of sources) {
    if (s.tool !== "codex") continue;
    const summary = summarizeFile(s.path, structuredClone(state), "codex", []);
    if (summary) push(summary.cwd ?? "(unknown)", [summary]);
  }

  const groups = [...byProject.entries()].map(([project, summaries]) => ({ project, summaries }));
  return foldProjectRows(groups);
}

// ---- Per-day fold (usage --by-day) ----------------------------------------------------------

export interface DayRow extends TokenCounts {
  /** Local calendar date, YYYY-MM-DD. */
  day: string;
  total: number;
  models: ModelTokens[];
  topModel: string;
  estCostUsd: number | null;
}

/** How many trailing local calendar days `usage --by-day` covers (today counts as day 1). */
export const USAGE_DAY_WINDOW = 30;

/** Local (machine timezone) calendar-date key for a timestamp -- deliberately LOCAL, not
 * UTC: a day boundary should match what the builder saw on their own clock. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Fold timestamped usage entries (Claude + Codex alike -- same shape) into per-LOCAL-day
 * rows covering the trailing `windowDays` calendar days (today counts as day 1), most recent
 * first. Reuses foldModelRows per day for the model breakdown/topModel/cost, same pattern as
 * foldProjectRows. Entries outside the window are dropped, never fabricated into a day.
 */
export function foldUsageDayRows(
  entries: { ts: number; model: string; tokens: TokenCounts }[],
  now: number = Date.now(),
  windowDays: number = USAGE_DAY_WINDOW,
): DayRow[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (windowDays - 1));
  const cutoffMs = start.getTime();

  const byDay = new Map<string, { model: string; tokens: TokenCounts }[]>();
  for (const e of entries) {
    if (e.ts < cutoffMs) continue;
    const key = localDayKey(e.ts);
    const arr = byDay.get(key);
    if (arr) arr.push(e);
    else byDay.set(key, [e]);
  }

  const rows: DayRow[] = [...byDay.entries()].map(([day, dayEntries]) => {
    const { rows: modelRows, total } = foldModelRows(dayEntries.map((e) => ({ models: [{ id: e.model, ...e.tokens }] })));
    const models: ModelTokens[] = modelRows.map((r) => ({ id: r.model, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheCreation: r.cacheCreation }));
    return {
      day,
      input: total.input,
      output: total.output,
      cacheRead: total.cacheRead,
      cacheCreation: total.cacheCreation,
      total: total.total,
      models,
      topModel: modelRows.length > 0 ? modelRows[0].model : "(none)",
      estCostUsd: estimateGroupCostUsd(models),
    };
  });
  rows.sort((a, b) => b.day.localeCompare(a.day)); // YYYY-MM-DD sorts lexically = chronologically
  return rows;
}

/** Every Codex per-turn usage delta across the corpus, with its own event timestamp (see
 * codex.ts's `usageEvents`). Same "cheap, already-computed delta" data the per-model view
 * folds into `models` -- just kept ungrouped here so the day-fold can bucket by date. */
function collectAllCodexUsageEvents(): { ts: number; model: string; tokens: TokenCounts }[] {
  const events: { ts: number; model: string; tokens: TokenCounts }[] = [];
  for (const path of findCodexTranscripts()) {
    let parsed;
    try {
      parsed = parseCodexRollout(readFileSync(path, "utf8"));
    } catch {
      continue; // vanished/locked file -- never fatal
    }
    if (parsed.usageEvents) events.push(...parsed.usageEvents);
  }
  return events;
}

/**
 * Read the last USAGE_DAY_WINDOW local calendar days across BOTH tools:
 *  - Claude: every deduped usage entry (extractClaudeAtoms + dedupeClaudeUsageEntries, the
 *    SAME flat corpus-wide dedup collectRecentClaudeEntries runs) -- just with no mtime
 *    lookback filter, since --by-day wants the whole trailing window, not "recent activity".
 *  - Codex: per-turn token deltas with their own line timestamp (see collectAllCodexUsageEvents
 *    above) -- a real reconstruction already used for per-model attribution, not a guess.
 */
export function readLocalDayRows(now: number = Date.now()): DayRow[] {
  const claudeEntries = collectAllClaudeUsageEntries(now)
    .map((e) => {
      const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
      return Number.isFinite(ts) ? { ts, model: e.model ?? "unknown", tokens: e.tokens } : null;
    })
    .filter((x): x is { ts: number; model: string; tokens: TokenCounts } => x !== null);
  return foldUsageDayRows([...claudeEntries, ...collectAllCodexUsageEvents()], now);
}

// ---- Cost estimation (usage --cost) -------------------------------------------------------
//
// TRUTH-DISCIPLINE INVARIANT: a model NOT in the canonical table renders "unpriced" --
// this file must NEVER guess a price. Only models with a well-known PUBLIC list price
// are priced.
//
// The rate table and its resolution live in ./core/pricing.ts -- the synced copy of
// usage-core/src/pricing.ts, THE canonical source shared with the server (P1,
// docs/product-audit-2026-07.md §5; test/coreParity.test.ts pins the bytes, replacing
// the old pricingSync drift guard and with it the $15,949-vs-$10,740 bug class).
//
// KNOWN, UNCLOSED DIVERGENCE: the board additionally overrides these rates per id from
// the daily LiteLLM feed (meta/pricing) the web app loads at runtime. The CLI
// has no feed access -- there is no pricing endpoint on the API, and this view must work
// offline and account-less. So a fed-overridden id can still differ between the two
// surfaces; only a server-side pricing endpoint would close that (Marco-gated).

export { normalizeModelId, priceForModel } from "./core/pricing.js";

/** Back-compat aliases: tracker's historical names for the canonical shapes. */
export type ModelPrice = ModelPricing;
export const PRICES: Record<string, ModelPrice> = PRICING.models;

/** The spend-basis marker rendered wherever a cost came from a user-typed rate rather than
 * the bundled public-price table — so a builder can always tell the two apart. */
export const USER_RATE_LABEL = "(user rate)";

/** How a model id got priced: the bundled canonical table, or a local user rate. */
export interface ResolvedPricing {
  price: ModelPrice;
  basis: "canonical" | "user";
}

/**
 * Resolve a model id to a price and its BASIS (L17). Canonical ALWAYS wins: a known id is
 * priced from PRICES with basis "canonical" even when a user rate is also stored for it (so
 * a user rate on a canonically-priced id is stored but INERT). Only an id the bundled table
 * cannot price falls through to a user rate (basis "user"), where cacheRead defaults to 0
 * and the user's cache-WRITE rate maps to the model's cache-CREATE cost. An unknown id with
 * no user rate stays unpriced (null) — never a guessed number.
 */
export function resolveModelPricing(
  modelId: string,
  userRates: Record<string, UserRate>,
): ResolvedPricing | null {
  const canonical = priceForModel(modelId);
  if (canonical) return { price: canonical, basis: "canonical" };
  const user = userRates?.[modelId];
  if (user) {
    return {
      price: {
        input: user.input,
        output: user.output,
        cacheRead: user.cacheRead ?? 0,
        cacheCreation: user.cacheWrite ?? 0,
      },
      basis: "user",
    };
  }
  return null;
}

/**
 * Cost + basis for one model's tokens (L17): canonical prices first, then any local user
 * rate. null when the id is unpriced even after user rates — never a guessed number. The
 * basis lets the render mark a user-rated cost with USER_RATE_LABEL.
 */
export function resolvedCostForModel(
  t: TokenCounts,
  modelId: string,
  userRates: Record<string, UserRate>,
): { cost: number; basis: "canonical" | "user" } | null {
  const resolved = resolveModelPricing(modelId, userRates);
  if (!resolved) return null;
  const p = resolved.price;
  const cost =
    (t.input / 1e6) * p.input +
    (t.output / 1e6) * p.output +
    (t.cacheRead / 1e6) * p.cacheRead +
    (t.cacheCreation / 1e6) * p.cacheCreation;
  return { cost, basis: resolved.basis };
}

/** Estimated USD cost of one model's token bucket, or null when the model is unpriced --
 * NEVER a guessed number. */
export function estimateCostUsd(t: TokenCounts, modelId: string): number | null {
  const price = priceForModel(modelId);
  if (!price) return null;
  return (t.input / 1e6) * price.input + (t.output / 1e6) * price.output + (t.cacheRead / 1e6) * price.cacheRead + (t.cacheCreation / 1e6) * price.cacheCreation;
}

/** Sum of estimateCostUsd() across a per-model breakdown, counting only priced models. Null
 * when NONE of them are priced (never renders $0.00 for "we don't know" -- that would read
 * as free, not unknown). Unpriced models are silently excluded from the sum (see COST_FOOTER). */
export function estimateGroupCostUsd(models: Pick<ModelTokens, "id" | "input" | "output" | "cacheRead" | "cacheCreation">[]): number | null {
  let sum = 0;
  let anyPriced = false;
  for (const m of models) {
    const c = estimateCostUsd(m, m.id);
    if (c !== null) {
      sum += c;
      anyPriced = true;
    }
  }
  return anyPriced ? sum : null;
}

/** True when the breakdown contains REAL usage (tokens > 0) on a model we cannot price --
 * the group's summed cost is then a floor, not the full number, and must be marked so. */
export function hasUnpricedUsage(models: Pick<ModelTokens, "id" | "input" | "output" | "cacheRead" | "cacheCreation">[]): boolean {
  return models.some(
    (m) => priceForModel(m.id) === null && m.input + m.output + m.cacheRead + m.cacheCreation > 0,
  );
}

export const COST_FOOTER =
  "Cost is an estimate from public list prices as of 2026-01; unpriced models excluded. " +
  "A trailing + marks a total that also contains unpriced usage (the real spend is higher). " +
  "Local display only — spend never ranks.";

// ---- JSON row shapes (usage --json) ---------------------------------------------------------
//
// Pure mapping from the internal row types to the columns actually shown in the table, so
// `--json` output always matches what a human would see with the same flags. estCostUsd is
// included ONLY when --cost was requested, same as the table's EST COST column.

export function usageRowsToJson(rows: UsageRow[], opts: { cost?: boolean } = {}): Record<string, unknown>[] {
  return rows.map((r) => {
    const row: Record<string, unknown> = { model: r.model, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheCreation: r.cacheCreation, total: r.total };
    if (opts.cost) row.estCostUsd = estimateCostUsd(r, r.model);
    return row;
  });
}

export function projectRowsToJson(rows: ProjectRow[], opts: { cost?: boolean } = {}): Record<string, unknown>[] {
  return rows.map((r) => {
    const row: Record<string, unknown> = {
      project: r.project,
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead,
      cacheCreation: r.cacheCreation,
      total: r.total,
      topModel: r.topModel,
    };
    if (opts.cost) {
      row.estCostUsd = r.estCostUsd;
      row.estCostIsPartial = hasUnpricedUsage(r.models);
    }
    return row;
  });
}

export function dayRowsToJson(rows: DayRow[], opts: { cost?: boolean } = {}): Record<string, unknown>[] {
  return rows.map((r) => {
    const row: Record<string, unknown> = {
      day: r.day,
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead,
      cacheCreation: r.cacheCreation,
      total: r.total,
      topModel: r.topModel,
    };
    if (opts.cost) {
      row.estCostUsd = r.estCostUsd;
      row.estCostIsPartial = hasUnpricedUsage(r.models);
    }
    return row;
  });
}

// ---- Codex rate-limit windows -----------------------------------------------------------------

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowMinutes: number;
  /** Seconds until this window resets, derived from `resets_at` (absolute unix epoch
   * seconds) minus `now`. null when the source snapshot carried no usable reset field. */
  resetsInSeconds: number | null;
}

export interface CodexRateLimits {
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
}

function parseRateLimitWindow(raw: unknown, now: number): CodexRateLimitWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const usedPercent = typeof r.used_percent === "number" ? r.used_percent : null;
  const windowMinutes = typeof r.window_minutes === "number" ? r.window_minutes : null;
  if (usedPercent === null || windowMinutes === null) return null;
  let resetsInSeconds: number | null = null;
  if (typeof r.resets_at === "number") {
    // resets_at is an ABSOLUTE unix epoch in SECONDS — verified against this machine's real
    // ~/.codex/sessions rollouts (2026-07-06). Earlier drafts of this spec guessed a relative
    // `resets_in_seconds` field; the real Codex build does not emit that name.
    resetsInSeconds = Math.max(0, r.resets_at * 1000 - now) / 1000;
  } else if (typeof r.resets_in_seconds === "number") {
    // Defensive fallback in case a different Codex version reports a relative countdown.
    resetsInSeconds = Math.max(0, r.resets_in_seconds);
  }
  return { usedPercent, windowMinutes, resetsInSeconds };
}

/**
 * Parse the LATEST rate_limits snapshot out of one Codex rollout file's raw content.
 *
 * Real shape (verified against ~/.codex/sessions on this machine, 2026-07-06):
 *   {"timestamp":"...","type":"event_msg","payload":{"type":"token_count",
 *     "info":{"total_token_usage":{...},"last_token_usage":{...},"model_context_window":258400},
 *     "rate_limits":{"limit_id":"codex","limit_name":null,
 *       "primary":{"used_percent":32.0,"window_minutes":300,"resets_at":1783291932},
 *       "secondary":{"used_percent":16.0,"window_minutes":10080,"resets_at":1783716480},
 *       "credits":null,"individual_limit":null,"plan_type":"team","rate_limit_reached_type":null}}}
 * `rate_limits` sits ALONGSIDE `payload.info`, not nested inside it — as the spec assumed.
 * `window_minutes: 10080` (7 days) is the weekly/secondary window on this account.
 *
 * Malformed/garbage lines are skipped, never fatal. A file with no rate_limits at all
 * (older Codex versions, or a rollout with no token_count events yet) returns null.
 */
export function parseLatestCodexRateLimits(content: string, now: number = Date.now()): CodexRateLimits | null {
  let latest: Record<string, unknown> | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // one bad line must never abort the scan
    }
    const payload = entry?.payload;
    if (payload?.type === "token_count" && payload?.rate_limits && typeof payload.rate_limits === "object") {
      latest = payload.rate_limits;
    }
  }
  if (!latest) return null;
  const primary = parseRateLimitWindow(latest.primary, now) ?? undefined;
  const secondary = parseRateLimitWindow(latest.secondary, now) ?? undefined;
  if (!primary && !secondary) return null;
  return { primary, secondary };
}

/** Newest Codex rollout by mtime (filenames also embed an ISO timestamp, so a lexicographic
 * fallback still tracks recency if stat() races/fails on every candidate). */
function newestCodexRollout(paths: string[]): string | null {
  if (paths.length === 0) return null;
  let best: string | null = null;
  let bestMs = -1;
  for (const p of paths) {
    let ms: number;
    try {
      ms = statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (ms > bestMs) {
      bestMs = ms;
      best = p;
    }
  }
  return best ?? [...paths].sort().at(-1) ?? null;
}

/** Read + parse the latest rate_limits snapshot from the newest Codex rollout on disk. */
export function readLatestCodexRateLimits(): CodexRateLimits | null {
  const path = newestCodexRollout(findCodexTranscripts());
  if (!path) return null;
  try {
    return parseLatestCodexRateLimits(readFileSync(path, "utf8"));
  } catch {
    return null; // vanished/locked file — never fatal
  }
}

// ---- Claude Code 5h billing-window estimate (ccusage-style blocks) ---------------------------

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
/**
 * How far back we scan for the current block's start. A block can only be found "current"
 * if it started within this lookback; a builder continuously active (no >=5h gap) for
 * LONGER than this would have their block start under-estimated. This is a documented v1
 * limitation of the estimate, not an exact billing reconstruction.
 */
const BLOCK_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface Claude5hBlock {
  blockStartMs: number;
  /** The max entry timestamp seen in the whole corpus scan (not just the current block) --
   * the honest "last activity" time, distinct from blockStartMs (the window's START). */
  lastEntryMs: number;
  tokensUsed: number;
  /** true while `now` still falls inside [blockStart, blockStart + windowMs). */
  active: boolean;
  resetMs: number;
}

/**
 * Expiry-anchored block boundary, matching Anthropic's actual 5h provisioning: a window
 * opens at its first message and EXPIRES windowMs later; the next message at/after that
 * expiry opens a NEW window. Walk entries in ascending timestamp order, tracking the current
 * anchor; an entry at ts >= anchor + windowMs re-anchors the block AT THAT ENTRY, and this is
 * applied iteratively (each re-anchor can itself expire and be superseded by a later entry) --
 * not just a gap check against the immediately-previous entry. The CURRENT block is whatever
 * the anchor lands on after the full walk.
 *
 * This replaces an earlier "gap >= 5h between consecutive entries starts a new block" rule
 * (a ccusage-style heuristic). That rule is wrong for a continuously-active builder: under
 * activity every few minutes, no two consecutive entries are ever >= 5h apart, so blockStart
 * never advances and stays pinned at the very first message of the day. `now - blockStart`
 * then eventually exceeds windowMs and `active` flips to false even though the user is mid-
 * session -- field-reported 2026-07-19 on published 0.22.1 ("window closed, last activity
 * 21:35" while actively in a Claude session). Anchoring on expiry-from-the-block's-own-start,
 * not proximity-to-the-previous-message, fixes it.
 */
export function computeCurrent5hBlock(
  entries: { ts: number; total: number }[],
  now: number,
  windowMs: number = FIVE_HOURS_MS,
): Claude5hBlock | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  let blockStart = sorted[0].ts;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].ts >= blockStart + windowMs) blockStart = sorted[i].ts;
  }
  const tokensUsed = sorted.filter((e) => e.ts >= blockStart).reduce((sum, e) => sum + e.total, 0);
  const lastEntryMs = sorted[sorted.length - 1].ts;
  return {
    blockStartMs: blockStart,
    lastEntryMs,
    tokensUsed,
    active: now - blockStart < windowMs,
    resetMs: blockStart + windowMs,
  };
}

/**
 * Raw (undeduped) Claude usage entries from every local Claude source (root + subagents),
 * optionally filtered to files touched within `lookbackMs` (null = no filter, the whole
 * corpus). ONE gather step shared by collectRecentClaudeEntries (5h-block estimate, lookback
 * filtered) and collectAllClaudeUsageEntries (usage --by-day, unfiltered) -- both then run
 * the SAME flat dedup over the result.
 */
function gatherRawClaudeUsageEntries(now: number, lookbackMs: number | null): ClaudeUsageEntry[] {
  const sources = findSources().filter((s) => s.tool === "claude_code");
  const raw: ClaudeUsageEntry[] = [];
  for (const src of sources) {
    if (lookbackMs !== null) {
      let mtime: number;
      try {
        mtime = statSync(src.path).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtime > lookbackMs) continue; // stale file, can't hold "current" block activity
    }
    try {
      raw.push(...extractClaudeAtoms(readFileSync(src.path, "utf8")).usageEntries);
    } catch {
      continue;
    }
    for (const sp of src.subagents) {
      try {
        raw.push(...extractClaudeAtoms(readFileSync(sp, "utf8")).usageEntries);
      } catch {
        continue;
      }
    }
  }
  return raw;
}

/**
 * Recent Claude usage entries (mtime within BLOCK_LOOKBACK_MS), deduped EXACTLY like
 * sync.ts's corpus fold — dedupeClaudeUsageEntries is the same class the corpus pass uses,
 * reused rather than re-implemented, so a forked/resumed session active in the window can't
 * double-count its replayed messages.
 *
 * v1 scope note: this is a WHOLE-CORPUS total, not per-model — SessionSummary (the corpus
 * fold's output) doesn't carry per-message timestamps per model cheaply, only per-thread
 * startedAt/endedAt. The render label says so explicitly (never a made-up percentage).
 */
export function collectRecentClaudeEntries(
  now: number = Date.now(),
  lookbackMs: number = BLOCK_LOOKBACK_MS,
): { ts: number; total: number }[] {
  return dedupeClaudeUsageEntries(gatherRawClaudeUsageEntries(now, lookbackMs))
    .map((e) => {
      const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
      return Number.isFinite(ts) ? { ts, total: totalOf(e.tokens) } : null;
    })
    .filter((x): x is { ts: number; total: number } => x !== null);
}

/**
 * Every deduped Claude usage entry on this machine, whole-corpus, no lookback filter --
 * the same flat cross-file dedup collectRecentClaudeEntries runs, just unbounded in time.
 * Feeds usage --by-day (readLocalDayRows), which needs each entry's model + timestamp, not
 * just its total.
 */
export function collectAllClaudeUsageEntries(now: number = Date.now()): ClaudeUsageEntry[] {
  return dedupeClaudeUsageEntries(gatherRawClaudeUsageEntries(now, null));
}

// ---- Formatting ---------------------------------------------------------------------------

/** Human-compact number: 12.3M / 1.2B / 4.5K. Render layer only — never changes a stored total. */
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatCodexLimitsLine(rl: CodexRateLimits | null): string {
  if (!rl || (!rl.primary && !rl.secondary)) return "Codex limits: not reported by this Codex version";
  const parts: string[] = [];
  if (rl.primary) {
    const resets =
      rl.primary.resetsInSeconds !== null ? ` (resets in ${Math.max(0, Math.round(rl.primary.resetsInSeconds / 60))}m)` : "";
    parts.push(`primary ${Math.round(rl.primary.usedPercent)}% used${resets}`);
  }
  if (rl.secondary) {
    parts.push(`weekly ${Math.round(rl.secondary.usedPercent)}% used`);
  }
  return `Codex limits: ${parts.join(" | ")}`;
}

/** Never a made-up percentage: remaining CAPACITY is plan-dependent and unknown, so this
 * always shows used-in-window + reset time, labeled clearly as a whole-corpus estimate. */
export function formatClaude5hLine(block: Claude5hBlock | null): string {
  if (!block) return "Claude session (5h window, est., whole-corpus): no recent activity";
  if (!block.active) {
    return `Claude session (5h window, est., whole-corpus): window closed, last activity ${hhmm(block.lastEntryMs)}`;
  }
  return `Claude session (5h window, est., whole-corpus): ${formatCompact(block.tokensUsed)} tokens used, window opened ${hhmm(block.blockStartMs)}, resets ~${hhmm(block.resetMs)}`;
}

// ---- Command ------------------------------------------------------------------------------

function padRight(s: string, w: number): string {
  return s.length >= w ? s + " " : s + " ".repeat(w - s.length);
}

/** Human-readable EST COST cell: "unpriced" (never a guess) for models with no known public
 * price; small amounts get more decimal places so a real-but-tiny cost doesn't read as $0.00.
 * `partial` appends "+" -- the group also holds unpriced usage, so this number is a floor. */
export function formatCostUsd(v: number | null, partial = false): string {
  if (v === null) return "unpriced";
  const base = v === 0 ? "$0.00" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
  return partial ? `${base}+` : base;
}

export interface UsageOptions {
  /** Which view to render; default (undefined) is the per-model view. */
  by?: "project" | "day";
  /** Print rows as a JSON array instead of a table -- no banner, no ANSI, no footers. */
  json?: boolean;
  /** Add an EST COST column (table) / estCostUsd field (json) from public list prices. */
  cost?: boolean;
}

function printModelTable(opts: UsageOptions): void {
  console.log(`  ${ui.c.bold("Local usage")} ${ui.c.dim("- per-model totals from this machine's transcripts (metadata only)")}`);
  console.log("");

  const { rows, total } = readLocalModelRows();
  // L17: user-typed rates price models the bundled table doesn't know (LOCAL display only —
  // this map never leaves the machine). Loaded once so every EST COST cell resolves the same.
  const userRates = listUserRates();
  // A model still unpriced AFTER user rates, with real usage, is what the share hint offers up.
  const stillUnpriced = (id: string, t: TokenCounts): boolean =>
    resolveModelPricing(id, userRates) === null && t.input + t.output + t.cacheRead + t.cacheCreation > 0;
  if (rows.length === 0) {
    console.log(`  ${ui.c.dim("No local transcripts found yet.")}`);
  } else {
    const cols = ["MODEL", "INPUT", "OUTPUT", "CACHE READ", "CACHE CREATE", "TOTAL", ...(opts.cost ? ["EST COST"] : [])];
    const widths = [34, 10, 10, 12, 13, 10, ...(opts.cost ? [12] : [])];
    console.log("  " + ui.c.dim(cols.map((c, i) => padRight(c, widths[i])).join("")));
    // EST COST cell for one row: canonical first, then a user rate (marked so it can't be
    // mistaken for a published price), else "unpriced". `partial` appends the floor "+".
    const costCell = (r: UsageRow, partial: boolean): string => {
      const resolved = resolvedCostForModel(r, r.model, userRates);
      if (!resolved) return formatCostUsd(null, partial);
      const base = formatCostUsd(resolved.cost, partial);
      return resolved.basis === "user" ? `${base} ${USER_RATE_LABEL}` : base;
    };
    const renderRow = (r: UsageRow, bold: boolean, cell?: string): string => {
      const cells: string[] = [r.model, formatCompact(r.input), formatCompact(r.output), formatCompact(r.cacheRead), formatCompact(r.cacheCreation), formatCompact(r.total)];
      if (opts.cost) cells.push(cell ?? costCell(r, false));
      const text = cells.map((c, i) => padRight(c, widths[i])).join("");
      return "  " + (bold ? ui.c.bold(text) : text);
    };
    for (const r of rows) console.log(renderRow(r, false));
    // TOTAL row's cost sums every priced row (canonical OR user-rated) — never guesses an
    // unpriced one; "unpriced" only when NOT ONE row resolved, and a "+" marks the sum as a
    // floor when rows still unpriced (even after user rates) with real usage sit alongside.
    let totalCell: string | undefined;
    if (opts.cost) {
      let sum = 0;
      let anyPriced = false;
      for (const r of rows) {
        const resolved = resolvedCostForModel(r, r.model, userRates);
        if (resolved) {
          sum += resolved.cost;
          anyPriced = true;
        }
      }
      const partial = rows.some((r) => stillUnpriced(r.model, r));
      totalCell = formatCostUsd(anyPriced ? sum : null, partial);
    }
    console.log(renderRow(total, true, totalCell));
  }
  console.log("");
  if (opts.cost) console.log(`  ${ui.c.dim(COST_FOOTER)}`);
  // Consented-share nudge (opt-in, no prompt loop): when unpriced models remain AND sharing
  // is off, point at the two ways to resolve them — price one locally, or share the ids.
  const state = loadState();
  if (opts.cost && !state.shareUnknownModels && rows.some((r) => stillUnpriced(r.model, r))) {
    console.log(`  ${ui.c.dim("unknown model(s) not priced - price one locally: df pricing set <model> --input <usd> --output <usd>")}`);
    console.log(`  ${ui.c.dim("or share the ids to help us price them: df config share-unknown-models on")}`);
  }

  console.log(`  ${formatCodexLimitsLine(readLatestCodexRateLimits())}`);
  const now = Date.now();
  console.log(`  ${formatClaude5hLine(computeCurrent5hBlock(collectRecentClaudeEntries(now), now))}`);
  console.log("");
}

function printProjectTable(opts: UsageOptions): void {
  console.log(`  ${ui.c.bold("Usage by project")} ${ui.c.dim("- per-project token attribution (metadata only)")}`);
  console.log(`  ${ui.c.dim("Project labels are local directory / working-directory names, verbatim - they can be client names.")}`);
  console.log(`  ${ui.c.dim("Local display only. Nothing here uploads.")}`);
  console.log("");

  const rows = readLocalProjectRows();
  if (rows.length === 0) {
    console.log(`  ${ui.c.dim("No local transcripts found yet.")}`);
  } else {
    const cols = ["PROJECT", "INPUT", "OUTPUT", "CACHE READ", "CACHE CREATE", "TOTAL", "TOP MODEL", ...(opts.cost ? ["EST COST"] : [])];
    const widths = [34, 10, 10, 12, 13, 10, 24, ...(opts.cost ? [12] : [])];
    console.log("  " + ui.c.dim(cols.map((c, i) => padRight(c, widths[i])).join("")));
    for (const r of rows) {
      const cells: string[] = [r.project, formatCompact(r.input), formatCompact(r.output), formatCompact(r.cacheRead), formatCompact(r.cacheCreation), formatCompact(r.total), r.topModel];
      if (opts.cost) cells.push(formatCostUsd(r.estCostUsd, hasUnpricedUsage(r.models)));
      console.log("  " + cells.map((c, i) => padRight(c, widths[i])).join(""));
    }
  }
  console.log("");
  if (opts.cost) console.log(`  ${ui.c.dim(COST_FOOTER)}`);
  console.log("");
}

function printDayTable(opts: UsageOptions): void {
  console.log(`  ${ui.c.bold("Usage by day")} ${ui.c.dim(`- per-day totals, last ${USAGE_DAY_WINDOW} days, most recent first (metadata only)`)}`);
  console.log("");

  const rows = readLocalDayRows();
  if (rows.length === 0) {
    console.log(`  ${ui.c.dim(`No local usage found in the last ${USAGE_DAY_WINDOW} days.`)}`);
  } else {
    const cols = ["DAY", "INPUT", "OUTPUT", "CACHE READ", "CACHE CREATE", "TOTAL", "TOP MODEL", ...(opts.cost ? ["EST COST"] : [])];
    const widths = [12, 10, 10, 12, 13, 10, 24, ...(opts.cost ? [12] : [])];
    console.log("  " + ui.c.dim(cols.map((c, i) => padRight(c, widths[i])).join("")));
    for (const r of rows) {
      const cells: string[] = [r.day, formatCompact(r.input), formatCompact(r.output), formatCompact(r.cacheRead), formatCompact(r.cacheCreation), formatCompact(r.total), r.topModel];
      if (opts.cost) cells.push(formatCostUsd(r.estCostUsd, hasUnpricedUsage(r.models)));
      console.log("  " + cells.map((c, i) => padRight(c, widths[i])).join(""));
    }
  }
  console.log("");
  console.log(`  ${ui.c.dim("Codex days are reconstructed from per-turn token deltas (same math as its per-model breakdown), not a native per-message log.")}`);
  if (opts.cost) console.log(`  ${ui.c.dim(COST_FOOTER)}`);
  console.log("");
}

/**
 * `deploy-forward usage` - the local usage view. --json bypasses ALL presentation (no banner,
 * no ANSI, no footers) and prints the same rows a table view would show as a JSON array, so a
 * script gets exactly what a human sees with the same flags -- never a different shape.
 */
export function printUsage(opts: UsageOptions = {}): void {
  if (opts.json) {
    const jsonRows =
      opts.by === "project"
        ? projectRowsToJson(readLocalProjectRows(), opts)
        : opts.by === "day"
          ? dayRowsToJson(readLocalDayRows(), opts)
          : usageRowsToJson(readLocalModelRows().rows, opts);
    console.log(JSON.stringify(jsonRows, null, 2));
    return;
  }

  ui.banner();
  if (opts.by === "project") printProjectTable(opts);
  else if (opts.by === "day") printDayTable(opts);
  else printModelTable(opts);
}
