/**
 * Model-Use Efficiency (MUE) — the context-economy fold.
 * Spec: docs/model-use-efficiency.md.
 *
 * PURE and VENDOR-NEUTRAL. STATUS ONLY — its own component, never in rank (docs §2). No
 * transcript content, no per-message series leaves this module.
 *
 * The core rating is `alpha`, the context-scaling exponent: cumulative context cost K scales
 * with cumulative output O as K ∝ O^alpha, estimated by OLS on the log-log curve.
 *   alpha = 1  linear (ideal: context bounded / compacted)
 *   alpha = 2  quadratic (context balloons every turn — the pathology)
 * The dashboard surface is the C_ideal-vs-C_actual pair (see fields), plotted over time.
 *
 * TWO ENTRY POINTS:
 *   contextEfficiency(entries)  — the pure fold over an already-ORDERED series (Σ math).
 *   sessionMue(series)          — THE seam a harness calls: sorts a per-message series by ts,
 *                                 then folds. Any harness that records per-turn token usage
 *                                 (Claude, pi, openclaw, grok, and future Cursor/Copilot) opts
 *                                 in with ONE call; the wire (SessionSummary.mue → ingest →
 *                                 SessionRecord.mue) is already harness-neutral. Harnesses that
 *                                 only expose session TOTALS (opencode, hermes) or cumulative
 *                                 snapshots (codex) cannot fit a growth curve — MUE is honestly
 *                                 absent there, never faked.
 */
import type { TokenCounts, ModelUseEfficiency, SessionContext } from "./types";

export type { ModelUseEfficiency, SessionContext };

/** Below this many valid (output-bearing) main-thread messages a slope is noise → null. */
const MIN_POINTS = 8;
const COMPACTION_DROP_RATIO = 0.5;
const COMPACTION_MIN_CTX = 20_000;

interface UsageLike {
  tokens: TokenCounts;
  isSidechain?: boolean;
}

/**
 * One per-message atom of a session's usage series, as any harness scanner can produce it:
 * the message's token counts, a chronological sort key, and (where the harness has subagents)
 * a sidechain flag. `ts` is a Unix-ms number OR an ISO string OR null/absent — sessionMue
 * normalizes all three. Extra harness-specific fields (model id, etc.) are ignored.
 */
export interface MueSeriesEntry extends UsageLike {
  ts?: number | string | null;
}

/**
 * `null` when there is too little to say honestly (< MIN_POINTS output-bearing main-thread
 * messages) — never a fabricated exponent on a stub session.
 */
export function contextEfficiency(entries: ReadonlyArray<UsageLike>): ModelUseEfficiency | null {
  // Main thread only — a subagent runs its OWN context window; mixing it corrupts the slope.
  const main = entries.filter((e) => !e.isSidechain);

  // Log-log points for the OLS: (log cumulative-output, log cumulative-context).
  const logX: number[] = [];
  const logY: number[] = [];
  let cumOut = 0;
  let cumCtx = 0;
  let sumCtx = 0;
  let sumOut = 0;
  let floor = Infinity;
  let compactions = 0;
  let prevCtx: number | null = null;

  for (const e of main) {
    // Context fed IN at this message (= its cost); output is what it produced.
    const c = e.tokens.input + e.tokens.cacheRead + e.tokens.cacheCreation;
    cumOut += e.tokens.output;
    cumCtx += c;
    sumCtx += c;
    sumOut += e.tokens.output;
    if (c > 0 && c < floor) floor = c;
    if (prevCtx !== null && prevCtx >= COMPACTION_MIN_CTX && c < COMPACTION_DROP_RATIO * prevCtx) {
      compactions += 1;
    }
    prevCtx = c;
    // A log-log point exists once there is output and context to take logs of. cumOut is
    // monotone, so leading tool-only (zero-output) messages are simply skipped.
    if (cumOut > 0 && cumCtx > 0) {
      logX.push(Math.log(cumOut));
      logY.push(Math.log(cumCtx));
    }
  }

  const points = main.length;
  if (logX.length < MIN_POINTS || sumCtx <= 0 || sumOut <= 0) return null;

  // OLS slope of log(K) on log(O). The intercept (task scale) is discarded — that is what
  // makes alpha scale-free. NB: R^2 is meaningless here (monotone cumulative series) and is
  // deliberately not computed; the slope is the estimand.
  const n = logX.length;
  const xbar = logX.reduce((a, b) => a + b, 0) / n;
  const ybar = logY.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = logX[i] - xbar;
    num += dx * (logY[i] - ybar);
    den += dx * dx;
  }
  const alpha = den > 0 ? num / den : 1;

  const cIdeal = floor * points;
  const ratio = Math.min(1, cIdeal / sumCtx); // floor·n ≤ Σctx, so this is ≤ 1 by construction

  return {
    alpha,
    cActual: sumCtx,
    cIdeal,
    ratio,
    costPerOutput: sumCtx / sumOut,
    compactions,
    points,
  };
}

/** Numeric sort key for an entry's ts. Unix-ms passes through; ISO strings parse; anything
 *  unparseable/absent sorts LAST (Infinity), and Array.sort's stability keeps such entries in
 *  their insertion order — so a series with no timestamps is fitted in the order given. */
function tsKey(ts: number | string | null | undefined): number {
  if (typeof ts === "number") return Number.isFinite(ts) ? ts : Infinity;
  if (typeof ts === "string") {
    const v = Date.parse(ts);
    return Number.isFinite(v) ? v : Infinity;
  }
  return Infinity;
}

/**
 * THE vendor-neutral seam. Give it a session's per-message series and get back its
 * ModelUseEfficiency, or `undefined` when the session is too short to fit an exponent honestly
 * (so a scanner can assign it straight to the optional SessionSummary.mue field). Sorts by `ts`
 * first — a harness whose per-message array is not already chronological (Claude's global-dedup
 * output; pi/openclaw's atoms.usage) is still fitted in true order — then delegates to the pure
 * fold, which drops sidechains and enforces MIN_POINTS. One call is the entire harness contract.
 */
export function sessionMue(series: ReadonlyArray<MueSeriesEntry>): ModelUseEfficiency | undefined {
  const ordered = [...series].sort((a, b) => tsKey(a.ts) - tsKey(b.ts));
  return contextEfficiency(ordered) ?? undefined;
}

/**
 * One per-turn atom for the occupancy fold below — `MueSeriesEntry` plus the turn's own
 * model attribution (occupancy needs it; the alpha fit above never did).
 */
export interface OccupancySeriesEntry extends MueSeriesEntry {
  model: string;
}

/**
 * Lane T3 (context capacity) — THE occupancy formula, owned here so every harness scanner
 * reuses one implementation. Ruling (coordinator, lane T2 addendum): occupancy is the LAST
 * entry, by `ts`, with NONZERO `input + cacheRead + cacheCreation` (the same per-turn cost
 * contextEfficiency() folds above) — a chronologically-last all-zero snapshot (OpenClaw's
 * known tool-call capture shape) is skipped, and a session whose every entry is zero yields
 * `undefined` (honest absence), never a reported zero. `at` passes the winning entry's OWN
 * raw `ts` through: a string is emitted verbatim (never reparsed/reserialized — a source
 * that already carries a timestamp string, e.g. Codex's `entry.timestamp`, keeps its exact
 * literal), a numeric (Unix-ms) `ts` is rendered via `toISOString()`.
 */
export function lastNonzeroOccupancy(entries: ReadonlyArray<OccupancySeriesEntry>): SessionContext | undefined {
  const main = entries.filter((e) => !e.isSidechain); // a subagent runs its own context window
  const ordered = [...main].sort((a, b) => tsKey(a.ts) - tsKey(b.ts));
  for (let i = ordered.length - 1; i >= 0; i--) {
    const e = ordered[i];
    const occupancyTokens = e.tokens.input + e.tokens.cacheRead + e.tokens.cacheCreation;
    if (occupancyTokens <= 0) continue; // zero-usage tail entry -- keep looking, never report a lying zero
    return {
      occupancyTokens,
      model: e.model,
      at: typeof e.ts === "string" ? e.ts : typeof e.ts === "number" ? new Date(e.ts).toISOString() : undefined,
    };
  }
  return undefined;
}
