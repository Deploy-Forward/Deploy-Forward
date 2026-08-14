/**
 * `deploy-forward super-start` — the full-screen read-only showcase
 * (docs/super-start-showcase-spec.md).
 *
 * A demo-worthy alternate-screen TUI (the Copilot/Grok CLI takeover feel) that animates
 * over this machine's REAL local agent history and holds on a hero frame until `q`.
 * Strictly READ-ONLY — the `start` family's look with none of its writes: no upload, no
 * cursor/digest advance, no hook install, no state write. Every corpus read is handed a
 * `structuredClone(loadState())` throwaway, exactly the usageView.ts discipline; the
 * no-mutation contract is asserted byte-for-byte in test/superStart.test.ts.
 *
 * Truth discipline: every figure on screen is a real, locally-computed number labeled
 * with its exact scope. Motion interpolates 0 -> real and LANDS on the exact figure —
 * render layer only, never a stored total. Spend is public-list-priced models only
 * (usageView.PRICES — Claude families); when NOTHING is priced the chart flips to token
 * volume rather than plot a misleading all-$0 spend. Zero-usage days are real
 * zero-height columns, never gaps and never invented values.
 */
import { findSources, TRACKER_VERSION } from "./sync.js";
import { foldModelRows, readAllHarnessSummaries, readLocalDayRows, formatCompact, formatCostUsd, estimateGroupCostUsd, hasUnpricedUsage, readLatestCodexRateLimits, collectRecentClaudeEntries, computeCurrent5hBlock, formatClaude5hLine, type UsageRow, type CodexRateLimits, type Claude5hBlock } from "./usageView.js";
import { isOfficialGrokCli, grokUnifiedLogPath, readLatestGrokCredits, type GrokCredits } from "./grok.js";
import { isOfficialPiCli, piSessionFiles } from "./pi.js";
import { isOfficialOpenClawCli, openclawSessionFiles } from "./openclaw.js";
import { isOfficialOpencodeHome, opencodeHome, opencodeDbPaths } from "./opencode.js";
import { isOfficialHermesCli, hermesHome, hermesDbPath } from "./hermes.js";
import { isOfficialCopilotCli, copilotHome, copilotDbPath } from "./copilot.js";
import { loadState, saveState, markOnboarded, APP_BASE, type TrackerState } from "./config.js";
import type { SessionSummary, SessionContext } from "./types.js";
import { windowForSession } from "./contextWindows.js";
import { fetchClaudeLimits, resolveLimitsConsent, claudeCredentialsPath, limitsCliFlag } from "./limitsFetch.js";
export { resolveLimitsConsent, claudeCredentialsPath, limitsCliFlag };
import { staleVersionBanner } from "./update.js";
// homedir/join left with claudeCredentialsPath when it moved to limitsFetch.ts.
// basename is deliberately NOT imported here: the one place this file needed it
// (repoLabel) must be separator-agnostic across platforms — see repoBasename below.
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as ui from "./ui.js";

// ---- pure math/format helpers ------------------------------------------------------------------

/** Grouped integer for the odometer: 10412388204 -> "10,412,388,204". Deterministic —
 * no locale dependency (an ICU-less Node must render the same frame). */
export function formatComma(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Ease-out cubic: front-loaded motion that settles gently. Exact at both ends, so an
 * eased odometer LANDS on the real figure at t=1 (truth rule 3). */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Sub-window progress: where global progress p sits inside [a, b], clamped to 0..1. */
function phase(p: number, a: number, b: number): number {
  if (b <= a) return p >= b ? 1 : 0;
  return Math.min(1, Math.max(0, (p - a) / (b - a)));
}

/** Round chart ceiling at or above the max (1/2/5 ladder). 0 stays 0 — an all-zero
 * series has no ceiling to invent. */
export function niceCeil(v: number): number {
  if (v <= 0) return 0;
  const base = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) {
    if (m * base >= v - 1e-9) return m * base;
  }
  return 10 * base; // unreachable, defensive
}

/** Round dollar tick: $0 / $600 / $1.2k / $2k. Tick labels only render nice-ladder
 * values, so no sub-dollar precision is needed. */
export function moneyTick(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `$${Math.round(v)}`;
}

/** Hero-scale spend figure: whole grouped dollars once cents stop mattering
 * ("$14,238"), usageView's cell precision below that ("$3.20", "$0.0063" — never a
 * $0.00 for a real cost). `partial` appends the same "+" floor mark the usage table
 * uses (real usage on unpriced models means the true spend is higher). */
export function moneyExact(v: number, partial = false): string {
  const base = v >= 100 ? `$${formatComma(Math.round(v))}` : formatCostUsd(v);
  return partial ? `${base}+` : base;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- barChartLines: the tick-ladder chart (plain glyphs ONLY — paint is the caller's job) -------

const EIGHTHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇"]; // partial top cell, bottom-aligned

export interface BarChartOptions {
  /** body rows (excludes the baseline row and the optional x-label row). */
  height: number;
  /** max total plain width available (axis + columns). */
  width: number;
  /** tick-label formatter (moneyTick for spend, formatCompact for tokens). */
  tick: (v: number) => string;
  /** fixed ceiling override — the animator passes the FINAL series' nice max so the
   * ladder never rescales mid-motion. Defaults to niceCeil(max(values)). */
  max?: number;
  /** optional x-axis labels; when present an extra final row is emitted. */
  labels?: { left: string; right: string };
}

/**
 * Vertical bar chart with a $-or-token tick ladder. Returns height body rows + 1
 * baseline row (+ 1 x-label row when labels are given). Plain text by construction —
 * no ANSI — so the same builder serves the full-screen frame, settledPlainText, and
 * the unit tests. Bars fill their FULL intended track with stable caps (whole blocks
 * plus one bottom-aligned eighth-block top cell); a zero value paints nothing.
 */
export function barChartLines(values: number[], opts: BarChartOptions): string[] {
  const max = opts.max ?? niceCeil(Math.max(0, ...values));
  const topLabel = opts.tick(max);
  const midLabel = opts.height >= 5 && max > 0 ? opts.tick(max / 2) : "";
  const zeroLabel = opts.tick(0);
  const axisW = Math.max(topLabel.length, midLabel.length, zeroLabel.length);
  const midRow = Math.floor(opts.height / 2);

  // Column geometry: prefer 2-cell bars with a 1-cell gap; narrow terminals fall back.
  const n = values.length;
  const avail = Math.max(0, opts.width - axisW - 1);
  const [colW, gap] = avail >= n * 3 ? [2, 1] : avail >= n * 2 ? [1, 1] : [1, 0];
  const perCol = colW + gap;
  const shown = Math.min(n, perCol > 0 ? Math.floor((avail + gap) / perCol) : 0);
  const vals = values.slice(n - shown); // most recent days win when width is scarce

  // Eighth-block resolution: e of height*8 total eighths per column.
  const eighths = vals.map((v) => {
    if (v <= 0 || max <= 0) return 0;
    const e = Math.round((v / max) * opts.height * 8);
    return Math.min(opts.height * 8, Math.max(1, e)); // a real nonzero shows at least a sliver
  });

  const lines: string[] = [];
  for (let r = 0; r < opts.height; r++) {
    const b = opts.height - 1 - r; // row index from the bottom
    let row = "";
    for (const e of eighths) {
      const full = e >> 3;
      const rem = e & 7;
      const cell = b < full ? "█" : b === full && rem > 0 ? EIGHTHS[rem - 1] : " ";
      row += cell.repeat(colW) + " ".repeat(gap);
    }
    const label = r === 0 ? topLabel : r === midRow && midLabel ? midLabel : "";
    lines.push(label.padStart(axisW) + "┤" + row.trimEnd());
  }
  const railW = shown > 0 ? shown * perCol - gap : Math.max(4, Math.floor(avail / 2));
  lines.push(zeroLabel.padStart(axisW) + "┼" + "─".repeat(railW));
  if (opts.labels) {
    const inner = Math.max(0, railW - opts.labels.left.length - opts.labels.right.length);
    lines.push(" ".repeat(axisW + 1) + opts.labels.left + " ".repeat(inner) + opts.labels.right);
  }
  return lines;
}

// ---- the showcase dataset (all real, all read-only) ---------------------------------------------

export interface ShowcaseHarness {
  name: string;
  sessions: number;
}

/** One session's post-dedup totals — the grain the live chart grows from. Carries NO
 * path, cwd, or project label: those can be client names (usageView.ts's own privacy
 * note) and this screen gets recorded. */
export interface ShowcaseSession {
  /** `${tool}_${toolSessionId}` — the same key syncOnce's digest ledger uses. */
  key: string;
  /** Harness display name. */
  tool: string;
  /** The session's top model id, verbatim. */
  model: string;
  tokens: number;
  /** Last-turn context occupancy from the scanner (SessionSummary.context) — local-only,
   * never uploaded. Absent for harnesses that can't honestly report it. */
  context?: SessionContext;
  /** Cumulative human→agent turns (SessionSummary.turns) — the deployment card's
   * on-camera turn count is a diff of these against the watch-start baseline. */
  turns?: number;
  /** basename(SessionSummary.cwd) — the repo/folder this thread launched in, NEVER a
   * full path or an intermediate segment (a client folder name can sit above it).
   * Absent when the source carried no cwd at all; never guessed. Marco's D10 ruling
   * (2026-07-18): a thread must show what it IS, not just which model runs it. */
  repoLabel?: string;
  /** SessionSummary.startedAt, verbatim (the thread's launch time) — undefined only
   * when the underlying summary never had one. */
  startedAt?: number;
}

/**
 * Last path segment of a cwd, treating BOTH "/" and "\" as separators on every
 * platform — deliberately NOT node:path's basename.
 *
 * The privacy guard on repoLabel (a client folder name sitting one level above the
 * repo must never reach the screen) is only as good as the segment split, and
 * node:path.basename is PLATFORM-SPECIFIC: the posix build does not treat "\" as a
 * separator at all. Every other basename() call in the tracker is safe because it
 * operates on a path the tracker itself built with join(). This one is different —
 * `cwd` is read out of a TRANSCRIPT, so it was written by whatever machine ran the
 * agent, which is not necessarily the machine reading it (a synced ~/.claude, a
 * container mounting a Windows host directory, a restored backup, WSL). On a POSIX
 * runtime a Windows cwd would then fail to split and the ENTIRE path would render as
 * the label, which is exactly the leak this field exists to prevent.
 *
 * Found by the first CI run: the guard's own test uses a Windows fixture path and had
 * only ever run on Windows, so it passed locally and failed on ubuntu-latest.
 *
 * Returns undefined for an absent/blank cwd (never guessed) and for a bare drive or
 * filesystem root ("C:\", "/"), which names no repo.
 */
export function repoBasename(cwd: string | undefined): string | undefined {
  if (typeof cwd !== "string") return undefined;
  const trimmed = cwd.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return undefined; // "" or "/" or "\\" — no segment to name
  const seg = trimmed.split(/[\\/]/).pop();
  if (!seg || /^[A-Za-z]:$/.test(seg)) return undefined; // bare drive root, e.g. "C:"
  return seg;
}

export interface ShowcaseDay {
  day: string; // YYYY-MM-DD
  spendUsd: number;
  tokens: number;
}

export interface ShowcaseData {
  /** Harnesses with real sessions on this machine, sorted desc. Claude/Codex counts are
   * corpus-SCANNED (what this run actually read); the other six come from the tracker's
   * local ledger (sessions it has catalogued) — shown only when nonzero, never a zero row. */
  harnesses: ShowcaseHarness[];
  totalSessions: number;
  /** Claude + Codex corpus total (the local readers' scope — labeled on screen). */
  tokenTotal: number;
  /** Per-model totals, desc — drives the model mix. */
  modelRows: UsageRow[];
  /** Corpus-wide estimated spend over PRICED models only (usageView.PRICES), or null
   * when nothing in the corpus is priced — never $0.00 for "we don't know". */
  spendTotalUsd: number | null;
  /** Sum of every session's credited active time (the same reconstruction sync
   * uploads), in hours. */
  activeHours: number;
  /** Most-used skill / dispatched agent across the corpus, by count — undefined when
   * none was observed (the ticker then says nothing rather than inventing a trend). */
  topSkill?: string;
  topAgent?: string;
  /** Every session carrying real usage, post-dedup — the baseline the live watch
   * diffs against to grow per-session bars. */
  sessions: ShowcaseSession[];
  /** True when real usage sits on unpriced models too — spendTotalUsd is then a
   * floor, marked with the same trailing "+" the usage table uses. */
  spendIsPartial: boolean;
  /** Trailing 30 local calendar days, ascending, zero-filled — real zeros, no gaps. */
  days: ShowcaseDay[];
  /** Sum of priced daily spend, or null when NOTHING in the window is priced (never
   * render $0.00 for "we don't know" — usageView's own rule). */
  spend30dUsd: number | null;
  /** Tier A limits, disk-only (Marco 2026-07-17: "usage remaining ... as a graph").
   * Codex reports its own windows in the rollout; null when not reported. */
  codexLimits: CodexRateLimits | null;
  /** Claude 5h window reconstruction — an ESTIMATE from timestamps, labeled so. */
  claude5h: Claude5hBlock | null;
  /** Grok weekly credits, Tier A disk-only (same "billing: fetched credits config" log
   * grok.ts's token-capture already reads) — read at the SAME cadence as codexLimits
   * above. Null when the official Grok CLI was never seen polling its own billing. */
  grokCredits: GrokCredits | null;
}

// The adapter-scan list moved to usageView.ts (readAllHarnessSummaries) so `usage`
// and this showcase fold the SAME corpus — one composition, every surface.

/**
 * One read-only pass over EVERY harness's local corpus — Claude/Codex through the
 * native summarizers (readLocalModelRows()'s own body), the other six through their
 * adapters' scan functions behind the same fingerprint gates syncOnce uses. So the
 * token total, model mix, and session counts all carry the same scope: THIS MACHINE,
 * every harness found on it. Never advances a cursor or digest: every scan gets a
 * fresh structuredClone throwaway.
 */
export function readShowcaseData(now: number = Date.now()): ShowcaseData {
  const state = loadState();

  // ONE corpus for every surface: the same all-harness composition `usage` folds
  // (usageView.readAllHarnessSummaries), so the showcase, the CLI table, and the
  // localhost dashboard can never disagree about what this machine ran.
  const harnessSummaries = readAllHarnessSummaries(structuredClone(state));

  // Session = a summary carrying real usage; a fully-deduped fork tombstone (models: [])
  // is a bookkeeping record, not a session anyone ran.
  const liveOnes = (list: SessionSummary[]): number => list.filter((s) => s.models.length > 0).length;

  const allSummaries = harnessSummaries.flatMap((h) => h.summaries);
  const { rows: modelRows, total } = foldModelRows(allSummaries);

  const harnesses: ShowcaseHarness[] = harnessSummaries
    .map((h) => ({ name: h.name, sessions: liveOnes(h.summaries) }))
    .filter((h) => h.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions);

  // Trailing 30 local days, zero-filled ascending. readLocalDayRows already computes the
  // per-day spend/tokens (same fold usage --by-day prints); missing days are REAL zeros.
  const dayRows = new Map(readLocalDayRows(now).map((r) => [r.day, r]));
  const days: ShowcaseDay[] = [];
  let anyPriced = false;
  let spendSum = 0;
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const row = dayRows.get(key);
    const spendUsd = row?.estCostUsd ?? 0;
    if (row?.estCostUsd != null) {
      anyPriced = true;
      spendSum += row.estCostUsd;
    }
    days.push({ day: key, spendUsd, tokens: row?.total ?? 0 });
  }

  // Ticker stats (the board strip's fields, LOCAL scope): credited active time plus
  // the most-used skill and dispatched agent by count. Absent stays absent.
  const activeHours = allSummaries.reduce((s, x) => s + x.activeMs, 0) / 3_600_000;
  const topOf = (pick: (s: SessionSummary) => { id: string; count: number }[] | undefined): string | undefined => {
    const counts = new Map<string, number>();
    for (const s of allSummaries) for (const e of pick(s) ?? []) counts.set(e.id, (counts.get(e.id) ?? 0) + e.count);
    let best: string | undefined;
    let bestN = 0;
    for (const [id, n] of counts) {
      if (n > bestN) {
        best = id;
        bestN = n;
      }
    }
    return best;
  };

  // Per-session grain (post-dedup — a fork's replayed tokens already moved to the
  // first-occurrence thread, so these diffs can't double-count).
  const harnessOf = new Map<string, string>([
    ["claude_code", "Claude Code"],
    ["codex", "Codex"],
    ["grok", "Grok"],
    ["pi", "pi"],
    ["openclaw", "OpenClaw"],
    ["opencode", "opencode"],
    ["hermes", "Hermes"],
    ["copilot", "Copilot"],
  ]);
  const sessions: ShowcaseSession[] = allSummaries
    .map((s) => {
      const fold = foldModelRows([s]);
      return {
        key: `${s.tool}_${s.toolSessionId}`,
        tool: harnessOf.get(s.tool) ?? s.tool,
        model: fold.rows[0]?.model ?? "unknown",
        tokens: fold.total.total,
        context: s.context,
        turns: s.turns,
        repoLabel: repoBasename(s.cwd),
        startedAt: s.startedAt,
      };
    })
    .filter((s) => s.tokens > 0);

  const asModels = modelRows.map((r) => ({ id: r.model, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheCreation: r.cacheCreation }));
  return {
    harnesses,
    totalSessions: harnesses.reduce((s, h) => s + h.sessions, 0),
    tokenTotal: total.total,
    modelRows,
    sessions,
    spendTotalUsd: estimateGroupCostUsd(asModels),
    spendIsPartial: hasUnpricedUsage(asModels),
    activeHours,
    topSkill: topOf((s) => s.skills),
    topAgent: topOf((s) => s.agents),
    days,
    spend30dUsd: anyPriced ? spendSum : null,
    codexLimits: readLatestCodexRateLimits(),
    claude5h: computeCurrent5hBlock(collectRecentClaudeEntries(now), now),
    grokCredits: readLatestGrokCredits(),
  };
}

// ---- the limits page (Tier A: disk-only, provenance-labeled) ------------------------------------

/** One horizontal health bar: used-so-far filled, remainder dim. Plain glyphs. Any real
 * nonzero usage shows at least a sliver (same convention as the day-chart's eighths bar
 * above) rather than rounding a small-but-real percentage away to nothing. */
function healthBar(usedPct: number, width: number): string {
  const w = Math.max(4, width);
  const rounded = Math.min(w, Math.max(0, Math.round((usedPct / 100) * w)));
  const filled = usedPct > 0 ? Math.max(1, rounded) : rounded;
  return "█".repeat(filled) + "░".repeat(w - filled);
}

/** Minutes → a short human span ("3h 12m", "6d"). */
function shortSpan(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.round(m / (24 * 60))}d`;
}

/** Epoch ms -> local "HH:MM" (24h, zero-padded) — a thread's launch clock time. */
function localHHMM(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * D22's pure budget-vs-spend gauge (docs/context-capacity-plan.md Phase 8): month-to-date
 * spend against an optional explicit monthly $ budget, rendered as one health-bar-style
 * line. Plain glyphs only, no ANSI — same style as healthBar/limitsPanelLines, paint is
 * the caller's job. Nothing invented: an unset/zero/negative budget renders nothing.
 * Honest at every state — the bar caps FULL once spend reaches/exceeds budget (never
 * overflows past `width`), the spent figure is NEVER clamped down to the budget, and
 * going over budget is its own distinct state (a ">$Y" marker, no "left" claim) rather
 * than a fabricated 100%+ "remaining" figure.
 */
export function budgetGaugeLines(spentUsd: number, budgetUsd: number | undefined, width: number): string[] {
  if (budgetUsd === undefined || budgetUsd <= 0) return [];
  const ratio = spentUsd / budgetUsd;
  const filled = Math.round(Math.min(1, ratio) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const over = spentUsd > budgetUsd;
  const spentTxt = formatCostUsd(spentUsd);
  const budgetTxt = over ? `>${formatCostUsd(budgetUsd)}` : formatCostUsd(budgetUsd);
  let line = `  ${"BUDGET".padEnd(15)} ${bar} ${spentTxt} of ${budgetTxt}`;
  if (!over && ratio >= 0.8) {
    line += ` · ${formatCostUsd(budgetUsd - spentUsd)} left`;
  }
  return [line];
}

/**
 * The ←/→ "limits" page: what's LEFT, as bars (Marco 2026-07-17 — the plain-text
 * Codex/Claude lines at the bottom of `usage` deserved a graph). Tier A only:
 * everything here is read from disk, each row labeled with its provenance —
 * vendor-reported (Codex windows), estimate (Claude 5h), context (live threads).
 * Rows padded/truncated to exactly `height` lines; never an empty frame.
 *
 * D20-D22 mode-routed composition (docs/context-capacity-plan.md Phase 8): billingMode
 * undefined or "subscription" renders provider lanes exactly as before (regression-safe);
 * "mix" keeps the lanes and additionally renders the budget gauge when `budget` is
 * supplied; "api" is a hard override that suppresses EVERY provider-lane row (nothing is
 * provisioned for an API-only user) and renders only the budget gauge. The budget gauge
 * itself is scoped to api/mix (D22) and only ever renders when `budget` is actually
 * supplied — nothing invented. Thread/context rows are mode-independent in every case.
 */
export function limitsPanelLines(
  data: ShowcaseData,
  liveSessions: LiveSession[],
  opts: {
    height: number;
    width: number;
    /** Vendor-reported Claude lanes (Tier B, opt-in) — when present they REPLACE the
     * 5h estimate line: a stated number always beats a reconstruction. */
    claudeLanes?: { kind: string; percent: number; resetsAt: string | null; scopeLabel: string | null }[];
    /** One quiet reason line when the opt-in fetch failed ("claude: unavailable…"). */
    claudeNote?: string;
    /** Bar fill progress 0..1 (page-entry ease). Bars GROW to their true value —
     * the % text is always the real number; only the fill animates. */
    fillP?: number;
    nowMs?: number;
    /** Suppresses every THREAD row's repoLabel, collapsing it back to the model-only
     * name (today's pre-D10 form). Launch time is not identifying, so it still renders. */
    redact?: boolean;
    /** D20's three-way plan-type routing key. Undefined = today's behavior, byte-identical. */
    billingMode?: "api" | "subscription" | "mix";
    /** D22's month-to-date spend vs the persisted monthly budget. Rendered via
     * budgetGaugeLines, scoped to billingMode api/mix — see the function doc above. */
    budget?: { spentUsd: number; budgetUsd: number };
    /** Grok weekly credits (Tier A, disk-only) — the SAME billingMode !== "api" guard
     * every other provider lane obeys. Null/undefined -> no GROK row at all (honest
     * absence: an unopted-in or never-polled Grok CLI emitted nothing to label). */
    grokCredits?: GrokCredits | null;
  },
): string[] {
  const rows: string[] = [];
  const fillP = opts.fillP ?? 1;
  const nowMs = opts.nowMs ?? Date.now();
  const barW = Math.max(8, Math.min(24, opts.width - 44));
  const bar = (pct: number): string => healthBar(pct * easeOutCubic(Math.max(0, Math.min(1, fillP))), barW);
  const resetIn = (iso: string | null): string => {
    if (!iso) return "";
    const at = Date.parse(iso);
    return Number.isFinite(at) && at > nowMs ? ` · resets in ${shortSpan((at - nowMs) / 60_000)}` : "";
  };
  const laneName = (l: { kind: string; scopeLabel: string | null }): string =>
    l.kind === "session" ? "CLAUDE SESSION" : l.scopeLabel ? `CLAUDE · ${l.scopeLabel.toUpperCase()}` : "CLAUDE WEEKLY";
  // D22 hard override: an API-only user has nothing provisioned, so "api" suppresses
  // every provider-lane row outright — vendor lanes, the Codex windows/placeholder, and
  // the Claude 5h estimate all stay off, even when the caller passed real data for them.
  if (opts.billingMode !== "api") {
    // D24 (docs/context-capacity-plan.md): two labeled groups replace the flat vendor
    // list — "SESSION" (5h-scale windows) and "WEEKLY". Each row keeps its existing
    // per-provider honesty rules; this pass only sorts the already-computed rows into
    // the two buckets. Headers render only when their bucket has at least one row.
    const sessionRows: string[] = [];
    const weeklyRows: string[] = [];
    for (const l of opts.claudeLanes ?? []) {
      const line = `  ${laneName(l).padEnd(15)} ${bar(l.percent)} ${Math.round(l.percent)}% used${resetIn(l.resetsAt)} · vendor-reported`;
      (l.kind === "session" ? sessionRows : weeklyRows).push(line);
    }
    if (opts.claudeNote) sessionRows.push(`  ${opts.claudeNote}`);
    // Claude remaining is plan-dependent and unknown — the line stays honest text
    // (usageView's own rule: never a made-up percentage), not a fabricated bar.
    // The 5h ESTIMATE renders only when no vendor-reported Claude lanes exist —
    // a stated number always beats a reconstruction (never both, never neither).
    // It plays "claude"'s role inside SESSION, so it leads the group (ahead of Codex).
    if ((opts.claudeLanes ?? []).length === 0) {
      sessionRows.push(`  ${formatClaude5hLine(data.claude5h).replace("Claude session", "CLAUDE 5H    ·")}`);
    }
    const rl = data.codexLimits;
    if (rl?.primary) {
      const isWeekly = rl.primary.windowMinutes !== null && rl.primary.windowMinutes >= 7 * 24 * 60;
      const name = isWeekly ? "CODEX WEEKLY" : "CODEX 5H";
      const resets = rl.primary.resetsInSeconds !== null ? ` · resets in ${shortSpan(rl.primary.resetsInSeconds / 60)}` : "";
      const line = `  ${name.padEnd(15)} ${bar(rl.primary.usedPercent)} ${Math.round(rl.primary.usedPercent)}% used${resets} · vendor-reported`;
      (isWeekly ? weeklyRows : sessionRows).push(line);
    }
    if (rl?.secondary) {
      const resets = rl.secondary.resetsInSeconds !== null ? ` · resets in ${shortSpan(rl.secondary.resetsInSeconds / 60)}` : "";
      weeklyRows.push(`  ${"CODEX WEEKLY".padEnd(15)} ${bar(rl.secondary.usedPercent)} ${Math.round(rl.secondary.usedPercent)}% used${resets} · vendor-reported`);
    }
    if (!rl?.primary && !rl?.secondary) sessionRows.push("  CODEX         limits not reported by this Codex version");
    // Grok weekly credits (Tier A, disk-only) — honest absence when never polled: no
    // placeholder row at all, unlike Codex's always-present "not reported" line above.
    // Always weekly-scale.
    const gc = opts.grokCredits;
    if (gc) {
      const reset = resetIn(gc.periodEnd);
      const tier = gc.tier ? ` · ${gc.tier}` : "";
      // Strictly over 30 minutes old — a render-time judgment only, the parser itself
      // never touches staleness (grok.ts's parseLatestGrokCredits doc).
      const stale = nowMs - gc.observedAt > 30 * 60_000 ? ` · as of ${localHHMM(gc.observedAt)}` : "";
      const row =
        gc.percent !== null
          ? `  ${"GROK WEEKLY".padEnd(15)} ${bar(gc.percent)} ${Math.round(gc.percent)}% used${reset} · vendor-reported${tier}${stale}`
          : `  ${"GROK WEEKLY".padEnd(15)}${reset}${tier}${stale}`;
      weeklyRows.push(row);
    }
    if (sessionRows.length > 0) {
      rows.push("  SESSION");
      rows.push(...sessionRows);
    }
    if (weeklyRows.length > 0) {
      rows.push("  WEEKLY");
      rows.push(...weeklyRows);
    }
  }
  // D22: the budget gauge, scoped to api/mix, and only when a budget is actually supplied
  // (subscription overrides any supplied `budget` — nothing scoped to that mode).
  if ((opts.billingMode === "api" || opts.billingMode === "mix") && opts.budget) {
    for (const l of budgetGaugeLines(opts.budget.spentUsd, opts.budget.budgetUsd, barW)) rows.push(l);
  }
  const withCtx = liveSessions.filter((s) => s.ctx);
  if (withCtx.length > 0) {
    rows.push("");
    for (const s of withCtx.slice(0, Math.max(0, opts.height - rows.length - 1))) {
      const mark = s.ctx!.inferred ? "~" : "";
      // The thread is named by repoLabel when known (Marco's D10 ruling: show what the
      // thread IS, not just which model runs it) — model-only under redact or when no
      // cwd was ever observed.
      const name = s.repoLabel && !opts.redact ? s.repoLabel : shortModel(s.label, 12);
      const started = s.startedAt ? ` · started ${localHHMM(s.startedAt)}` : "";
      rows.push(`  ${("THREAD " + name).padEnd(15)}${started} ${bar(s.ctx!.pct)} ${mark}${Math.round(Math.min(999, s.ctx!.pct))}% of context window`);
    }
  }
  while (rows.length < opts.height) rows.push("");
  return rows.slice(0, opts.height);
}

/** ←/→ page order. One cycle, direction-aware, wraps both ways. */
const CHART_PAGES = ["spend", "live", "limits"] as const;
export function nextChartView(current: "live" | "spend" | "limits", dir: "left" | "right"): "live" | "spend" | "limits" {
  const i = CHART_PAGES.indexOf(current);
  const n = CHART_PAGES.length;
  return CHART_PAGES[(i + (dir === "right" ? 1 : -1) + n) % n];
}

// ---- the deployment card (Marco 2026-07-18: "Strava turns every workout into a
// shareable map") — printed into REAL scrollback when the watch ends, so the recap
// is screenshot-ready by construction. Strava's distance/time/pace maps to
// turns/tokens/est cost/agents/harnesses/models. Every figure is an on-camera
// measurement (deltas against the watch-start baseline); an empty run earns no card.

export interface DeploymentStats {
  startedAtMs: number;
  endedAtMs: number;
  /** Tokens burned on camera (the ticker's own cumulative). */
  tokens: number;
  spendUsd: number | null;
  /** Human→agent turns completed on camera (Σ per-session turn deltas). */
  turns: number;
  /** Most agents (sessions) live at once — the stat no single-agent tool can print. */
  peakAgents: number;
  harnesses: string[];
  /** Per-model on-camera burn, desc. */
  models: { label: string; tokens: number }[];
  /** Token delta per fold — the burn sparkline. */
  burns: number[];
  /** Fullest context observed per model label. */
  peakCtx: { label: string; pct: number; inferred: boolean }[];
  /** Per-thread on-camera active time, desc — the card renders up to 2, in the order
   * given (the caller owns ranking, this stat is just the raw grain). Absent under
   * redact or when no thread carried a repoLabel. */
  threads?: { repoLabel: string; ms: number }[];
}

/** ms -> the card's own short duration form ("12m", "1h 5m") — shared by the header
 * duration and each threads-line entry. */
function fmtDur(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function composeDeploymentCard(d: DeploymentStats, opts?: { redact?: boolean }): string[] {
  if (d.tokens <= 0) return []; // no trophy for an empty run
  const dur = fmtDur(d.endedAtMs - d.startedAtMs);
  const day = new Date(d.endedAtMs).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const glyphs = [...EIGHTHS, "█"];
  const burns = d.burns.slice(-24);
  const burnMax = Math.max(1, ...burns);
  const spark = burns.map((b) => (b <= 0 ? "▁" : glyphs[Math.min(7, Math.floor((b / burnMax) * 8))])).join("");
  const mixTotal = d.models.reduce((sum, m) => sum + m.tokens, 0) || 1;
  const mix = d.models.slice(0, 3).map((m) => `${shortModel(m.label)} ${Math.round((m.tokens / mixTotal) * 100)}%`).join(" · ") + (d.models.length > 3 ? ` · +${d.models.length - 3} more` : "");
  const top = [...d.peakCtx].sort((a, b) => b.pct - a.pct)[0];
  const peak = top ? `${shortModel(top.label)} ${top.inferred ? "~" : ""}${Math.round(Math.min(999, top.pct))}% of context window` : "";
  // Up to 2 threads, in the order given (no re-sort here — the caller ranks); never
  // rendered under redact, the same repoLabel privacy gate as the live chart/limits page.
  const threadsLine =
    !opts?.redact && d.threads && d.threads.length > 0
      ? d.threads.slice(0, 2).map((t) => `${t.repoLabel} (${fmtDur(t.ms)})`).join(" · ")
      : "";
  const n = (v: number, one: string, many: string): string => `${v} ${v === 1 ? one : many}`;
  const L: string[] = [""];
  L.push(`  ${ui.c.brand("■")}   ${ui.c.brand("■")}   ${ui.c.bold("DEPLOYMENT")} ${ui.c.dim("·")} ${dur} ${ui.c.dim("·")} ${day}`);
  L.push(`   ${ui.c.brand("███")}    ${ui.c.bold(formatCompact(d.tokens))} tokens ${ui.c.dim("·")} ${d.spendUsd !== null ? `${ui.c.ok(formatCostUsd(d.spendUsd))} est` : ui.c.dim("est unpriced")} ${ui.c.dim("·")} ${n(d.turns, "turn", "turns")}`);
  L.push(`  ${ui.c.brand("■")}   ${ui.c.brand("■")}   ${n(d.peakAgents, "agent", "agents")} peak ${ui.c.dim("·")} ${n(d.harnesses.length, "harness", "harnesses")} ${ui.c.dim("·")} ${n(d.models.length, "model", "models")}`);
  L.push("");
  if (burns.length > 1) L.push(`  ${ui.c.dim("burn")}  ${ui.c.brand(spark)}`);
  if (d.models.length > 0) L.push(`  ${ui.c.dim("mix")}   ${mix}`);
  if (peak) L.push(`  ${ui.c.dim("peak")}  ${peak}`);
  if (threadsLine) L.push(`  ${ui.c.dim("threads")} ${threadsLine}`);
  L.push("");
  L.push(`  ${ui.c.dim("rank the humans, not the models · leaderboard.deployforward.dev")}`);
  return L;
}

// ---- the live session chart (x = a live session, y = tokens since super-start began) -----------

/** Display form of a model id: drop only the `claude-` vendor prefix (the ticker's own
 * rule) and keep everything else VERBATIM — "gpt-5.5" stays "gpt-5.5", never "gpt5.5".
 * A truncation is marked with "…" rather than silently shortened. */
export function shortModel(id: string, max = 14): string {
  const s = id.replace(/^claude-/, "");
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export interface LiveSession {
  /** Model display label — never a path or project name (recorded screen). */
  label: string;
  /** Tokens this session has burned SINCE the watch began (a diff of two real folds). */
  tokens: number;
  /** How full this thread's context window is. `inferred` marks a window we stepped up
   * from observed occupancy (bare-id 1M Claude sessions) — rendered "~69%", never bare. */
  ctx?: { pct: number; inferred: boolean };
  /** ShowcaseSession.repoLabel, passed through verbatim — basename only, never a path. */
  repoLabel?: string;
  /** ShowcaseSession.startedAt, passed through verbatim. */
  startedAt?: number;
}

/**
 * The watch loop's session mapping, extracted pure: baseline-diff each session's
 * tokens (a bar only grows from usage that happened on camera), attach the context
 * percentage where a window we can NAME covers the occupancy (windowForSession's
 * provenance ladder: stated > registry > inferred; null → no %, never a guessed
 * denominator), drop zero-delta sessions, order by burn.
 */
export function liveSessionsFrom(
  sessions: ShowcaseSession[],
  baseline: Map<string, number>,
  seed?: { activeHarnesses: string[]; nowMs: number; activeWindowMs?: number },
): LiveSession[] {
  const toLive = (s: ShowcaseSession): LiveSession => {
    const w = s.context ? windowForSession(s.context) : null;
    // Label = the model running NOW (last-turn attribution), not the session's
    // historical top model: a session that ran opus for a week and switched to
    // fable an hour ago is burning fable tokens on camera, and the bar must say
    // so. Falls back to the fold's top model when no per-turn attribution exists.
    const out: LiveSession = {
      label: s.context?.model ?? s.model,
      tokens: s.tokens - (baseline.get(s.key) ?? 0),
      repoLabel: s.repoLabel,
      startedAt: s.startedAt,
    };
    if (w && s.context) out.ctx = { pct: (s.context.occupancyTokens / w.tokens) * 100, inferred: w.provenance === "inferred" };
    return out;
  };
  const burned = sessions
    .map(toLive)
    .filter((s) => s.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  if (!seed) return burned;
  // Seeding (Marco 2026-07-17: "it should already pick up live sessions, and start
  // with $0"): sessions of a probe-live harness whose LAST TURN is recent stand on
  // the chart at zero delta immediately, fullest context first — the watch shows
  // what's running before a single new token lands. Recency comes from the
  // session's own last-turn timestamp; the probe's window is the boundary.
  // 15 minutes, not the probe's 90s (workflow finding, 2026-07-18): Claude Code
  // persists usage only when an assistant MESSAGE completes, so a session deep in
  // a long turn can have a minutes-old last entry while visibly running. Marco's
  // three live sessions spanned 03:52-03:58 — a 90s seed window stood up only one.
  const windowMs = seed.activeWindowMs ?? SEED_WINDOW_MS;
  const burnedKeys = new Set(sessions.filter((s) => s.tokens - (baseline.get(s.key) ?? 0) > 0).map((s) => s.key));
  const seeded = sessions
    .filter((s) => !burnedKeys.has(s.key) && s.context?.at && seed.activeHarnesses.includes(s.tool))
    .filter((s) => {
      const at = Date.parse(s.context!.at!);
      return Number.isFinite(at) && seed.nowMs - at <= windowMs;
    })
    .map(toLive)
    .filter((s) => s.ctx)
    .sort((a, b) => (b.ctx?.pct ?? 0) - (a.ctx?.pct ?? 0));
  return [...burned, ...seeded];
}

/**
 * Fat labeled bars, one per live session: the "watch my agents work" chart. Same
 * eighth-block resolution and stable caps as barChartLines, but sized for a handful
 * of wide columns with a label under each. Plain glyphs only — paint is the composer's
 * job. No sessions, or all-zero deltas, returns [] (never an empty chart frame).
 */
export function liveSessionChartLines(sessions: LiveSession[], opts: { height: number; width: number; redact?: boolean }): string[] {
  // Zero-delta sessions WITH context stand on the chart from second zero (Marco
  // 2026-07-17: "it should already pick up live sessions, and start with $0") —
  // label + % on the rail, no bar height until real tokens burn on camera.
  const live = sessions.filter((s) => s.tokens > 0 || s.ctx);
  if (live.length === 0 || opts.height < 1) return [];
  const max = niceCeil(Math.max(1, ...live.map((s) => s.tokens)));
  const topLabel = formatCompact(max);
  const axisW = Math.max(topLabel.length, 1);
  const avail = Math.max(0, opts.width - axisW - 1);
  const gap = 2;
  // Bars SPREAD to fill the region — a handful of sessions should read as a poster,
  // not as a stub chart hugging the axis. Capped so a single live session doesn't
  // become one absurd slab, floored so a crowd still renders.
  const n = live.length;
  const fill = Math.floor((avail - (n - 1) * gap) / n);
  const colW = Math.max(4, Math.min(28, fill));
  const shown = Math.max(1, Math.min(n, Math.floor((avail + gap) / (colW + gap))));
  const vals = live.slice(0, shown);

  // A zero-delta seeded session renders 0 eighths (no glyph — a bar of height for
  // zero tokens would lie); anything real keeps the 1-eighth floor so it shows.
  const eighths = vals.map((s) => (s.tokens <= 0 ? 0 : Math.min(opts.height * 8, Math.max(1, Math.round((s.tokens / max) * opts.height * 8)))));
  const lines: string[] = [];
  for (let r = 0; r < opts.height; r++) {
    const b = opts.height - 1 - r;
    let row = "";
    for (const e of eighths) {
      const full = e >> 3;
      const rem = e & 7;
      const cell = b < full ? "█" : b === full && rem > 0 ? EIGHTHS[rem - 1] : " ";
      row += cell.repeat(colW) + " ".repeat(gap);
    }
    lines.push((r === 0 ? topLabel : "").padStart(axisW) + "┤" + row.trimEnd());
  }
  const railW = shown * (colW + gap) - gap;
  lines.push("0".padStart(axisW) + "┼" + "─".repeat(railW));
  // Label row: the model under its own bar, centered in the column — with the thread's
  // context % beside it when known. "~" marks an INFERRED window (a bare-id 1M session);
  // a stated/registry window renders bare. A column too narrow for the pct plus at least
  // a few model characters drops the pct whole rather than truncating it into noise.
  let labels = "";
  for (const s of vals) {
    let t = shortModel(s.label, colW);
    if (s.ctx) {
      const pct = (s.ctx.inferred ? "~" : "") + Math.round(Math.min(999, s.ctx.pct)) + "%";
      if (colW >= pct.length + 4) t = shortModel(s.label, colW - pct.length - 1) + " " + pct;
    }
    // repoLabel is prepended ONLY when the whole "repoLabel · " glue still fits beside
    // the existing model[+pct] text — a too-narrow column drops repoLabel WHOLE rather
    // than truncating it into noise. redact suppresses it everywhere (model-only, the
    // pre-D10 form).
    if (s.repoLabel && !opts.redact) {
      const withRepo = `${s.repoLabel} · ${t}`;
      if (withRepo.length <= colW) t = withRepo;
    }
    const pad = colW - t.length;
    labels += " ".repeat(Math.floor(pad / 2)) + t + " ".repeat(Math.ceil(pad / 2)) + " ".repeat(gap);
  }
  lines.push(" ".repeat(axisW + 1) + labels.trimEnd());
  // Value row: what each bar is actually worth, so the chart never needs the eye to guess.
  let vals2 = "";
  for (const s of vals) {
    const t = formatCompact(s.tokens);
    const t2 = t.length > colW ? t.slice(0, colW) : t;
    const pad = colW - t2.length;
    vals2 += " ".repeat(Math.floor(pad / 2)) + t2 + " ".repeat(Math.ceil(pad / 2)) + " ".repeat(gap);
  }
  lines.push(" ".repeat(axisW + 1) + vals2.trimEnd());
  return lines;
}

// ---- the activity probe (stat-only — cheap enough for a 1s beat) --------------------------------
//
// The live watch's trigger (Marco 2026-07-17: "as agents are running on the machine,
// can we make this live syncing"). A full fold is far too heavy to poll at speed, so
// this probe NEVER parses a byte: it stats the transcript files the harnesses write
// and reports a change fingerprint. Corpus grows -> fingerprint moves -> the loop
// fires ONE worker fold, so the real deduped figures land ~2s after an agent writes
// instead of up to REFRESH_MS. An idle machine triggers no folds at all.

/** How long a discovered path list is reused before re-walking. Stats run every beat;
 * the directory walk (the only non-trivial cost here) does not. A brand-new session's
 * file is picked up within this window; an already-open session's growth within one beat. */
const DISCOVER_TTL_MS = 5000;
/** A file written within this window counts its harness as live right now. */
const ACTIVE_WINDOW_MS = 90_000;
/** Seed window for standing zero-delta sessions on the chart: a session whose last
 * COMPLETED message is this recent counts as running (message-completion is the
 * harness's persist grain — mid-turn nothing lands on disk). */
const SEED_WINDOW_MS = 15 * 60_000;

export interface ProbeCache {
  paths: { path: string; harness: string }[];
  discoveredAt: number;
}

export interface ActivityProbe {
  /** Changes iff some watched file's size or mtime moved — the fold trigger. */
  fingerprint: string;
  /** Newest mtime across the corpus (epoch ms), 0 when nothing was readable. */
  lastWriteMs: number;
  /** Harness display names with a file written inside ACTIVE_WINDOW_MS. */
  activeHarnesses: string[];
}

export function newProbeCache(): ProbeCache {
  return { paths: [], discoveredAt: 0 };
}

/** Every harness's own discovery surface, behind its own fingerprint gate — the same
 * functions syncOnce uses to find files, minus every read. SQLite harnesses also get
 * their `-wal` sibling: in WAL mode the commit lands there first, so the .db's own
 * mtime can lag a live write. */
function discoverProbePaths(): { path: string; harness: string }[] {
  const out: { path: string; harness: string }[] = [];
  const add = (path: string, harness: string): void => {
    out.push({ path, harness });
  };
  const safely = (f: () => void): void => {
    try {
      f();
    } catch {
      /* a vanished home is "not installed", never fatal */
    }
  };
  safely(() => {
    for (const s of findSources()) add(s.path, s.tool === "codex" ? "Codex" : "Claude Code");
  });
  safely(() => {
    if (isOfficialGrokCli()) add(grokUnifiedLogPath(), "Grok");
  });
  safely(() => {
    if (isOfficialPiCli()) for (const f of piSessionFiles()) add(f.path, "pi");
  });
  safely(() => {
    if (isOfficialOpenClawCli()) for (const f of openclawSessionFiles()) add(f.path, "OpenClaw");
  });
  safely(() => {
    if (isOfficialOpencodeHome()) {
      for (const p of opencodeDbPaths(opencodeHome())) {
        add(p, "opencode");
        add(p + "-wal", "opencode");
      }
    }
  });
  safely(() => {
    if (isOfficialHermesCli()) {
      const p = hermesDbPath(hermesHome());
      add(p, "Hermes");
      add(p + "-wal", "Hermes");
    }
  });
  safely(() => {
    if (isOfficialCopilotCli()) {
      const p = copilotDbPath(copilotHome());
      add(p, "Copilot");
      add(p + "-wal", "Copilot");
    }
  });
  return out;
}

/**
 * One stat-only pass. `cache` is mutated in place (the path list is re-walked only
 * every DISCOVER_TTL_MS). Missing files are skipped silently — a `-wal` sibling only
 * exists while a db is open, and its absence is information, not an error.
 */
export function probeActivity(cache: ProbeCache, now: number = Date.now()): ActivityProbe {
  if (now - cache.discoveredAt >= DISCOVER_TTL_MS) {
    cache.paths = discoverProbePaths();
    cache.discoveredAt = now;
  }
  let fp = "";
  let lastWriteMs = 0;
  const active = new Set<string>();
  for (const { path, harness } of cache.paths) {
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    fp += `${path}:${st.size}:${Math.round(st.mtimeMs)}\n`;
    if (st.mtimeMs > lastWriteMs) lastWriteMs = st.mtimeMs;
    if (now - st.mtimeMs <= ACTIVE_WINDOW_MS) active.add(harness);
  }
  return {
    fingerprint: createHash("sha1").update(fp).digest("hex"),
    lastWriteMs,
    activeHarnesses: [...active],
  };
}

// ---- frame composition (pure — no terminal, no time, no I/O) ------------------------------------

export interface ScreenSize {
  rows: number;
  cols: number;
}

interface Seg {
  t: string;
  c?: (s: string) => string;
}

/** Fit segments into exactly `w` visible cells: truncate on PLAIN text, pad with
 * spaces, paint after the width math (ANSI never counts against the width). */
function fit(segs: Seg[], w: number): string {
  let plain = 0;
  let out = "";
  for (const s of segs) {
    if (plain >= w) break;
    const room = w - plain;
    const t = s.t.length > room ? s.t.slice(0, room) : s.t;
    plain += t.length;
    out += s.c ? s.c(t) : t;
  }
  return out + " ".repeat(w - plain);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-16" -> "Jun 16". */
function dayLabel(day: string): string {
  const [, m, d] = day.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}`;
}

const TITLE = "DEPLOY FORWARD";
const TAGLINE = "rank the humans, not the models";
const QUIT_HINT = "←→ chart · q to quit";

/**
 * The board strip's running ticker, LOCAL scope (Marco 2026-07-16, mirroring
 * leaderboard.deployforward.dev's top marquee): active hours, tokens, spend,
 * trending model/skill/agent — every value from this machine's own fold. Fields
 * with nothing observed are OMITTED, never invented. Plain text; the marquee
 * window paints numbers after slicing.
 */
export function tickerText(data: ShowcaseData): string {
  const parts: string[] = [];
  if (data.activeHours >= 1) parts.push(`${formatComma(Math.round(data.activeHours))} ACTIVE HOURS`);
  parts.push(`${formatCompact(data.tokenTotal)} TOKENS TRACKED`);
  if (data.spendTotalUsd !== null && data.spendTotalUsd >= 1) {
    parts.push(`$${formatCompact(Math.round(data.spendTotalUsd))}${data.spendIsPartial ? "+" : ""} SPENT (ESTIMATE)`);
  }
  const trendModel = data.modelRows[0]?.model;
  if (trendModel) parts.push(`TRENDING MODEL: ${trendModel.replace(/^claude-/, "").toUpperCase()}`);
  if (data.topSkill) parts.push(`TRENDING SKILL: ${data.topSkill.toUpperCase()}`);
  if (data.topAgent) parts.push(`TRENDING AGENT: ${data.topAgent.toUpperCase()}`);
  parts.push("RANKED BY BUILD SCORE, NOT SPEND");
  parts.push("LEADERBOARD.DEPLOYFORWARD.DEV");
  return parts.map((p) => `· ${p} `).join(" ");
}

/** One marquee window: slice the doubled plain ticker at `shift`, THEN paint the
 * visible number/dollar tokens (paint after slicing — escape codes never enter the
 * width math, the fitBorder discipline). */
export function tickerWindow(text: string, width: number, shift: number): string {
  if (width <= 0 || text.length === 0) return "";
  const doubled = text + " " + text;
  const start = ((shift % text.length) + text.length) % text.length;
  const plain = doubled.slice(start, start + width).padEnd(width);
  // ONE pass, dollars-or-numbers alternation — a second pass over painted output
  // would match the digits inside the first pass's own escape codes.
  return plain.replace(/\$[\d,.]+[KMB]?\+?|(?<![\w$,.-])[\d][\d,.]*[KMB]?/g, (m) =>
    m.startsWith("$") ? ui.c.ok(m) : ui.c.brand(m),
  );
}

function topBorder(cols: number): string {
  // Compact identity for terminals below the lockup gate: "■" is the brand tile
  // reduced to its center square (the reticle mark at 1x1) plus the wordmark.
  // (Lockup-mode screens replace this rail with the running ticker instead.)
  const mark = ui.c.brand("■");
  const fill = cols - 3 - 2 - TITLE.length - 1 - 1 - TAGLINE.length - 3;
  if (fill >= 1) {
    return `┌─ ${mark} ${ui.c.bold(TITLE)} ` + "─".repeat(fill) + ` ${ui.c.dim(TAGLINE)} ─┐`;
  }
  const f = Math.max(1, cols - 3 - 2 - TITLE.length - 2);
  return `┌─ ${mark} ${ui.c.bold(TITLE)} ` + "─".repeat(f) + "┐";
}

/** The full brand lockup — banner()'s mark and lockup verbatim (Marco 2026-07-16:
 * "if we are making this actual/true, incorporate this"): the #1d4ed8 tile with the
 * 5-square reticle beside name+version, tagline, domain. 3 rows + text column. */
function lockupLines(): Seg[][] {
  const rows: [string, Seg[]][] = [
    [" ■   ■ ", [{ t: "Deploy Forward", c: ui.c.bold }, { t: ` v${TRACKER_VERSION}`, c: ui.c.dim }]],
    ["  ███  ", [{ t: TAGLINE, c: ui.c.dim }]],
    // Clickable (OSC 8): the one URL on screen someone might actually want to open.
    // The marquee's copy is deliberately NOT linked — it scrolls, and a link sliced
    // mid-window would be a broken target.
    [" ■   ■ ", [{ t: "leaderboard.deployforward.dev", c: (s) => ui.link(APP_BASE, ui.c.brand(s)) }]],
  ];
  return rows.map(([tile, text]): Seg[] => [{ t: "  " }, { t: tile, c: ui.c.tile }, { t: "  " }, ...text]);
}

function bottomBorder(cols: number, scope: string, tail: string = QUIT_HINT): string {
  const fill = cols - 3 - scope.length - 1 - 1 - tail.length - 3;
  if (fill >= 1) {
    return `└─ ${ui.c.dim(scope)} ` + "─".repeat(fill) + ` ${tail} ─┘`;
  }
  const f = Math.max(1, cols - 3 - tail.length - 3);
  return "└" + "─".repeat(f) + `─ ${tail} ─┘`;
}

/** The live-watch footer rail: scan cadence beside the quit hint. Honest states only —
 * "scanning" while the re-read runs, "synced" ONLY when this watch actually pushes
 * (paired device), a note when the last push failed, real ago/next seconds always. */
function liveTail(live: LiveInfo | undefined): string {
  if (!live) return QUIT_HINT;
  if (live.scanning) return `● ${live.pushing ? "syncing" : "scanning"} local sessions… ${live.scanAgoS}s · ${QUIT_HINT}`;
  const verb = live.pushing ? "synced" : "scanned";
  const note = live.note ? ` · ${live.note}` : "";
  return `● live · ${verb} ${live.scanAgoS}s ago · next in ${live.nextInS}s${note} · ${QUIT_HINT}`;
}

const SPEND_SCOPE = "est · public list prices, priced models only";
const TOKEN_SCOPE = "no public list price for these models — token volume shown";
/** Every harness found on this machine feeds the fold (readShowcaseData scans all 8
 * behind syncOnce's own fingerprint gates). "This machine" is the honest boundary:
 * the leaderboard's figure additionally sums your OTHER paired devices and the
 * uploaded history whose local transcripts have since been cleaned up. */
const TOKENS_SCOPE_NOTE = "this machine · all harnesses";

// ---- block-digit odometer (the hero stat) --------------------------------------------------------
//
// A 3x5 block font for the COMPACT token figure ("10.2B") — the recording's money shot.
// Only the glyphs formatCompact can emit: digits, '.', and the K/M/B suffixes. Each glyph
// row is exactly `w` cells so the band is rectangular by construction.

const BIG_FONT: Record<string, { w: number; rows: string[] }> = {
  "0": { w: 3, rows: ["███", "█ █", "█ █", "█ █", "███"] },
  "1": { w: 3, rows: [" █ ", "██ ", " █ ", " █ ", "███"] },
  "2": { w: 3, rows: ["███", "  █", "███", "█  ", "███"] },
  "3": { w: 3, rows: ["███", "  █", "███", "  █", "███"] },
  "4": { w: 3, rows: ["█ █", "█ █", "███", "  █", "  █"] },
  "5": { w: 3, rows: ["███", "█  ", "███", "  █", "███"] },
  "6": { w: 3, rows: ["███", "█  ", "███", "█ █", "███"] },
  "7": { w: 3, rows: ["███", "  █", "  █", "  █", "  █"] },
  "8": { w: 3, rows: ["███", "█ █", "███", "█ █", "███"] },
  "9": { w: 3, rows: ["███", "█ █", "███", "  █", "███"] },
  ".": { w: 1, rows: [" ", " ", " ", " ", "█"] },
  // The center ticks protruding top and bottom are the dollar signature at this
  // resolution — and they keep it visually distinct from "5".
  $: { w: 3, rows: [" █ ", "███", "█  ", "███", " █ "] },
  K: { w: 3, rows: ["█ █", "██ ", "█  ", "██ ", "█ █"] },
  M: { w: 5, rows: ["█   █", "██ ██", "█ █ █", "█   █", "█   █"] },
  // 4 cells wide with a real bowl gap — at 3 wide the double-bump collapses and B
  // reads as 8 (caught on the first live run's screenshot).
  B: { w: 4, rows: ["███ ", "█  █", "███ ", "█  █", "███ "] },
};

/** Render a compact figure ("10.2B") as 5 equal-width block-glyph rows. Unknown
 * characters render as a 1-cell gap — never a crash over a formatter change. */
export function bigDigitLines(s: string): string[] {
  const rows = ["", "", "", "", ""];
  for (const ch of s) {
    const g = BIG_FONT[ch] ?? { w: 1, rows: [" ", " ", " ", " ", " "] };
    for (let r = 0; r < 5; r++) rows[r] += g.rows[r] + " ";
  }
  return rows.map((r) => r.slice(0, -1)); // drop the trailing inter-glyph gap
}

// ---- model mix (the frontend's mix legend, terminal-native) --------------------------------------

/** Density ramp for stacked mix segments: rank 1 = solid, then progressively lighter;
 * everything past the ramp folds into one '·' tail segment. One accent color, four
 * densities — the terminal twin of the site's mix legend. */
const MIX_GLYPHS = ["█", "▓", "▒", "░"];

export interface MixSegment {
  model: string;
  cells: number;
  glyph: string;
  /** Whole-percent share of the token total (display value; cells carry the geometry). */
  sharePct: number;
}

/**
 * Stacked-bar segments for the FULL model mix: every model's token share of the total,
 * cumulative-rounded so the cells sum to EXACTLY `width` (no ragged end, no lost cell).
 * Models beyond the density ramp fold into one labeled "+N more" tail segment. Empty
 * or zero-total input returns no segments — never an invented bar.
 */
export function mixBarSegments(rows: Pick<UsageRow, "model" | "total">[], width: number): MixSegment[] {
  const totalAll = rows.reduce((s, r) => s + r.total, 0);
  if (totalAll <= 0 || width <= 0) return [];
  const head = rows.slice(0, MIX_GLYPHS.length);
  const tailTotal = rows.slice(MIX_GLYPHS.length).reduce((s, r) => s + r.total, 0);
  const parts = [
    ...head.map((r, i) => ({ model: r.model, total: r.total, glyph: MIX_GLYPHS[i] })),
    ...(tailTotal > 0 ? [{ model: `+${rows.length - MIX_GLYPHS.length} more`, total: tailTotal, glyph: "·" }] : []),
  ];
  const segs: MixSegment[] = [];
  let cum = 0;
  let prevCells = 0;
  for (const part of parts) {
    cum += part.total;
    const cells = Math.round((cum / totalAll) * width) - prevCells;
    prevCells += cells;
    if (cells <= 0) continue; // a sliver rounded to nothing still shows in the label row's shares
    segs.push({ model: part.model, cells, glyph: part.glyph, sharePct: Math.round((part.total / totalAll) * 100) });
  }
  return segs;
}

/** Live-watch status rendered into the frame: the footer rail carries the scan
 * cadence; a fresh positive delta gets a chip beside the hero figure. Purely display
 * state — the caller owns the clock and the rescans. */
export interface LiveInfo {
  scanAgoS: number;
  nextInS: number;
  scanning?: boolean;
  /** True when this watch ALSO submits to the board (paired device, Marco 2026-07-16):
   * the footer then says "synced", and only then — an unpaired watch never claims a
   * push it didn't make. */
  pushing?: boolean;
  /** One short honest status when the last sync failed transiently (kept until a
   * sync succeeds); fatal auth states exit the watch instead. */
  note?: string;
  delta?: { tokens: number; spendUsd: number | null };
  /** Harnesses written to inside ACTIVE_WINDOW_MS — their dots pulse. From the
   * stat-only probe, so this stays truthful between folds. */
  activeHarnesses?: string[];
  /** Per-session token deltas since the watch began — the live chart's bars. */
  sessions?: LiveSession[];
  /** Which chart the region shows. Omitted = auto (live once a session has burned
   * tokens, history otherwise); set explicitly once the user drives it with ← / →.
   * "limits" is the third page: what's left, as bars (Tier A, disk-only). */
  chartView?: "live" | "spend" | "limits";
  /** Index into SUPER_START_ACTIONS — the command ⏎ would launch. */
  menuIndex?: number;
  /** Vendor-reported Claude lanes (Tier B: --limits opt-in, read-only fetch). */
  claudeLanes?: { kind: string; percent: number; resetsAt: string | null; scopeLabel: string | null }[];
  /** Quiet failure note for the limits page ("claude: unavailable — token expired…"). */
  claudeNote?: string;
  /** Page-entry fill progress 0..1 — the limits bars ease to their true value. */
  pageP?: number;
  /** Paint counter; drives the pulse phase (render-only, never a figure). */
  beat?: number;
  /** --redact (SuperStartOptions.redact) — suppresses every repoLabel on screen. */
  redact?: boolean;
  /** D20's persisted three-way plan-type — read once at watch start (same discipline as
   * limitsOptIn), routes limitsPanelLines' mode composition. */
  billingMode?: "api" | "subscription" | "mix";
  /** D22's month-to-date spend vs the persisted monthly budget — spentUsd tracks the
   * SAME live corpus figure the ticker's "SPENT (ESTIMATE)" stat uses (data.spendTotalUsd),
   * so the gauge and the ticker never disagree. Present only when a budget is persisted. */
  budget?: { spentUsd: number; budgetUsd: number };
  /** The field bug (root-caused 2026-07-20): a stale npx cache silently kept rendering an
   * old build for days. update.ts's staleVersionBanner(), composed once at watch start —
   * "" when unknown/current, a loud one-liner naming both versions when this build trails
   * the registry. Never silent again. */
  updateBanner?: string;
}

/**
 * The whole full-screen frame at eased progress p (0..1): EXACTLY size.rows lines,
 * every line exactly size.cols visible cells (walls included) — the frame engulfs the
 * terminal edge to edge, whatever its size. Pure: all layout math, no I/O, no clock.
 */
export function composeScreen(data: ShowcaseData, size: ScreenSize, p: number, live?: LiveInfo, tickerShift = 0): string[] {
  const { rows, cols } = size;
  const innerW = cols - 2;
  const wall = (segs: Seg[]): string => ui.c.dim("│") + fit(segs, innerW) + ui.c.dim("│");
  const blankLine = wall([]);
  const spendMode = data.spend30dUsd !== null;

  // -- Ingest panel: harnesses ignite in display order, counts race with a stagger.
  const h = data.harnesses.length;
  const nameW = Math.max(0, ...data.harnesses.map((x) => x.name.length));
  const harnessLines: Seg[][] = [];
  let animSessionSum = 0;
  data.harnesses.forEach((hx, i) => {
    const w0 = 0.05 + 0.3 * (i / Math.max(1, h));
    const rowP = easeOutCubic(phase(p, w0, w0 + 0.2));
    const ignited = phase(p, w0, w0 + 0.2) > 0;
    const count = Math.round(hx.sessions * rowP);
    animSessionSum += count;
    // A harness written to in the last 90s wears the pulse instead of a settled dot —
    // the probe's own signal, so it stays true between folds.
    const isLive = live?.activeHarnesses?.includes(hx.name) === true;
    const mark = isLive ? PULSE[(live?.beat ?? 0) % PULSE.length] : ignited ? "●" : "·";
    harnessLines.push([
      { t: "    " + hx.name.padEnd(nameW + 3) },
      { t: mark + " ", c: isLive || ignited ? ui.c.brand : ui.c.dim },
      { t: formatComma(count).padStart(7) },
      { t: hx.sessions === 1 ? " session" : " sessions", c: ui.c.dim },
      ...(isLive ? [{ t: "  live", c: ui.c.ok }] : []),
    ]);
  });

  // -- Hero band: tokens + est spend race to the exact corpus figures side by side.
  //    Tall terminals get the block-digit form (labels above, exact figures beneath);
  //    short ones keep single lines (the chart's minimum height wins the space fight).
  //    A sub-dollar spend skips the big band — "0.0063" in block digits is noise.
  const heroEase = easeOutCubic(phase(p, 0.15, 0.65));
  const odometer = Math.round(data.tokenTotal * heroEase);
  const animSpend = data.spendTotalUsd !== null ? data.spendTotalUsd * heroEase : null;
  const showBigSpend = data.spendTotalUsd !== null && data.spendTotalUsd >= 1;
  // The hero is TWO aligned columns (Marco 2026-07-16, "organize these components
  // better"): everything about tokens sits in column A, everything about spend in
  // column B — exact figure, then its own delta — with one dim scope line under both.
  const spendExact =
    animSpend !== null ? moneyExact(animSpend, p >= 1 && data.spendIsPartial) : null; // the "+" floor mark only once settled — a racing floor reads as done
  const wA = bigDigitLines(formatCompact(data.tokenTotal))[0].length;
  const colBx = 2 + wA + 6; // column B's x — the block bands' own geometry
  const padTo = (segs: Seg[], x: number): Seg[] => {
    const len = segs.reduce((s, e) => s + e.t.length, 0);
    return len < x ? [...segs, { t: " ".repeat(x - len) }] : segs;
  };
  const exactRow: Seg[] = [
    ...padTo([{ t: "  " }, { t: `${formatComma(odometer)}`, c: ui.c.bold }, { t: " tokens", c: ui.c.dim }], colBx),
    ...(spendExact !== null ? [{ t: spendExact, c: ui.c.ok }, { t: " est spend", c: ui.c.dim }] : []),
  ];
  const dTok = live?.delta && live.delta.tokens > 0 ? live.delta.tokens : null;
  const dSpendUsd = live?.delta?.spendUsd != null && live.delta.spendUsd > 0 ? live.delta.spendUsd : null;
  const deltaRow: Seg[] = dTok
    ? [
        ...padTo([{ t: "  ▲ ", c: ui.c.ok }, { t: `+${formatCompact(dTok)} tok`, c: ui.c.ok }], colBx),
        ...(dSpendUsd !== null ? [{ t: "▲ ", c: ui.c.ok }, { t: `+${formatCostUsd(dSpendUsd)}`, c: ui.c.ok }] : []),
      ]
    : [{ t: "  watching for new usage…", c: ui.c.dim }];
  const scopeRow: Seg[] = [
    { t: "  " },
    { t: TOKENS_SCOPE_NOTE + (spendExact !== null ? " · spend est: public list prices, priced models only" : ""), c: ui.c.dim },
  ];
  const wB = showBigSpend ? bigDigitLines("$" + formatCompact(Math.round(data.spendTotalUsd!)))[0].length : 0;
  const bigMode = rows >= 32 && innerW >= wA + 6 + wB + 4;
  let odometerLines: Seg[][];
  if (bigMode) {
    // Band A pads to its FINAL width so band B's x never wiggles while the count races.
    const bandA = bigDigitLines(formatCompact(odometer)).map((r) => r.padEnd(wA));
    const bandB = showBigSpend ? bigDigitLines("$" + formatCompact(Math.round(animSpend!))) : null;
    const labelRow: Seg[] = [
      ...padTo([{ t: "  TOKENS READ", c: ui.c.dim }], colBx),
      ...(bandB ? [{ t: "EST SPEND", c: ui.c.dim }] : []),
    ];
    odometerLines = [
      labelRow,
      // The site's own stat language, translated: token figures blue, money green.
      ...bandA.map((r, i): Seg[] => [
        { t: "  " },
        { t: r, c: ui.c.brand },
        ...(bandB ? [{ t: "      " }, { t: bandB[i], c: ui.c.ok }] : []),
      ]),
      exactRow,
      deltaRow,
      scopeRow,
    ];
  } else {
    odometerLines = [exactRow, deltaRow, scopeRow];
  }

  // -- Chart: bars grow toward FINAL values against a FIXED ladder (never rescales).
  const finalVals = data.days.map((d) => (spendMode ? d.spendUsd : d.tokens));
  const ladderMax = niceCeil(Math.max(0, ...finalVals));
  const n = finalVals.length;
  const animVals = finalVals.map((v, k) => {
    const s = 0.35 + 0.45 * (k / Math.max(1, n));
    return v * easeOutCubic(phase(p, s, s + 0.1));
  });
  const tick = spendMode ? moneyTick : (v: number) => formatCompact(Math.round(v));
  // Three pages share one region (Marco 2026-07-17: spend / live threads / limits).
  // Auto until the user drives it: live once a session has burned tokens (or stands
  // seeded at zero), history otherwise. ← / → cycles; the choice then sticks.
  const liveSessions = (live?.sessions ?? []).filter((s) => s.tokens > 0 || s.ctx);
  const page: "live" | "spend" | "limits" = live?.chartView ?? (liveSessions.length > 0 ? "live" : "spend");
  const liveMode = page === "live";
  const historyHeader = spendMode ? "ESTIMATED SPEND · LAST 30 DAYS" : "TOKEN VOLUME · LAST 30 DAYS";
  const chartHeader =
    page === "limits"
      ? "LIMITS · WHAT'S LEFT"
      : liveMode
        ? `LIVE SESSIONS · TOKENS SINCE SUPER-START${live?.pushing ? " · SYNCING TO BOARD" : ""}`
        : historyHeader;

  // -- Model mix: the frontend's mix legend, terminal-native — one stacked bar over
  //    the FULL mix, cumulative-rounded to an exact width, plus a share row. Each
  //    segment carries ITS OWN color AND density glyph, and the legend entry wears
  //    the same pair, so the bar and its legend can never disagree (Marco 2026-07-16:
  //    "the graph doesn't match the color code of the models"). Money-green stays
  //    reserved; the ramp is a cool blue-to-quiet slide.
  const legendP = easeOutCubic(phase(p, 0.78, 0.95));
  const mixW = Math.max(16, innerW - 15);
  const mixSegsList = mixBarSegments(data.modelRows, mixW);
  const MIX_PAINTS = [ui.c.brand, ui.c.accent, ui.c.bold, undefined, ui.c.dim]; // rank order; tail dim
  const paintOf = (i: number) => MIX_PAINTS[Math.min(i, MIX_PAINTS.length - 1)];
  const visibleCells = Math.round(mixW * legendP); // grows in, lands full-track
  const mixBarLine: Seg[] = [{ t: "  MODEL MIX  ", c: ui.c.bold }];
  let consumed = 0;
  mixSegsList.forEach((s, i) => {
    const take = Math.max(0, Math.min(s.cells, visibleCells - consumed));
    consumed += take;
    if (take > 0) mixBarLine.push({ t: s.glyph.repeat(take), c: paintOf(i) });
  });
  const mixShareLine: Seg[] = [{ t: "  " }];
  mixSegsList.forEach((s, i) => {
    if (i > 0) mixShareLine.push({ t: "  ·  ", c: ui.c.dim });
    mixShareLine.push({ t: `${s.glyph} ${s.model} ${s.sharePct}%`, c: paintOf(i) });
  });

  // -- Vertical budget: fixed lines first, the chart absorbs the rest (capped), leftover
  //    rows pad as blanks so the frame is EXACTLY `rows` lines tall.
  // The full lockup earns its rows only when the chart keeps its height; below the
  // gate the compact border mark carries the identity instead (never both at once).
  const showLockup = rows >= 38;
  const pre: Seg[][] = [
    // The stale-version nag sits first, before even the lockup — loud on purpose
    // (the field bug: a stale cache rendered an old build silently for days).
    ...(live?.updateBanner ? [[{ t: "  " + live.updateBanner, c: ui.c.warn }]] : []),
    ...(showLockup ? [[], ...lockupLines()] : []),
    [],
    [{ t: "  INGEST", c: ui.c.bold }, { t: "   local agent history · read-only", c: ui.c.dim }],
    ...harnessLines,
    [{ t: "    " }, { t: "─".repeat(Math.min(34, Math.max(8, innerW - 8))), c: ui.c.dim }],
    [
      { t: `    ${h} harnesses`, c: ui.c.bold },
      { t: " · ", c: ui.c.dim },
      { t: `${formatComma(animSessionSum)} sessions scanned` },
    ],
    [],
    ...odometerLines,
    [],
    [{ t: "  " + chartHeader, c: ui.c.bold }],
  ];
  // The launcher: one line, the selected command spelled EXACTLY as it will run, so
  // what you see is what lands in your shell. Only rendered for a live watch (a
  // settled/entrance frame has no keyboard yet).
  const menuLine: Seg[] | null =
    live?.menuIndex !== undefined
      ? (() => {
          const i = ((live.menuIndex % SUPER_START_ACTIONS.length) + SUPER_START_ACTIONS.length) % SUPER_START_ACTIONS.length;
          const a = SUPER_START_ACTIONS[i];
          const left: Seg[] = [
            { t: "  RUN ", c: ui.c.bold },
            { t: "▸ ", c: ui.c.brand },
            { t: `deploy-forward ${a.label}`, c: ui.c.bold },
            { t: `   ${a.hint}`, c: ui.c.dim },
          ];
          const right = `↑↓ pick · ⏎ run · ${i + 1}/${SUPER_START_ACTIONS.length}`;
          const used = left.reduce((s, e) => s + e.t.length, 0);
          return [...left, { t: " ".repeat(Math.max(1, innerW - 2 - used - right.length)) }, { t: right, c: ui.c.dim }, { t: "  " }];
        })()
      : null;
  const post: Seg[][] = [[], mixBarLine, mixShareLine, ...(menuLine ? [[], menuLine] : [])];

  // chart body height: rows - borders(2) - pre - post - baseline(1) - xlabels(1).
  // Under pressure, blank spacer rows in `pre` yield first (found dynamically — the
  // odometer's height varies, so positions can't be hardcoded), latest-first.
  let chartH = rows - 2 - pre.length - post.length - 2;
  while (chartH < 3) {
    const blankIdx = pre.map((s, i) => (s.length === 0 ? i : -1)).filter((i) => i >= 0).pop();
    if (blankIdx === undefined) break;
    pre.splice(blankIdx, 1);
    chartH++;
  }
  let extra = 0;
  const CHART_CAP = 14;
  if (chartH > CHART_CAP) {
    extra = chartH - CHART_CAP;
    chartH = CHART_CAP;
  }
  chartH = Math.max(1, chartH);

  // Chart painted in brand blue (Marco 2026-07-16: "the chart can be all blue") —
  // bars and rail brand, the tick ladder dim. Split at the axis glyph so the paint
  // never touches the width math (barChartLines stays plain by construction).
  // Pinned to live with nothing burned yet: hold the region's height and tell the
  // TRUTH the probe already knows (Marco's screenshot, 2026-07-17: Claude marked
  // "live" beside "no session has burned tokens" read as a contradiction). A live
  // harness with known thread occupancy is MEASURING — show those threads' context
  // immediately; only a genuinely idle machine gets the waiting line. A fabricated
  // bar would lie; so does claiming nothing is happening while agents are writing.
  const liveEmpty = (): string[] => {
    const body = Array.from({ length: Math.max(1, chartH) }, () => "");
    const active = live?.activeHarnesses ?? [];
    if (active.length === 0) {
      body[Math.floor(body.length / 2)] = "  no session has burned tokens since super-start began — waiting…";
      return [...body, "", ""];
    }
    const threads = data.sessions
      .filter((s) => s.context && active.includes(s.tool))
      .map((s) => ({ ctx: s.context!, w: windowForSession(s.context!) }))
      .filter((x): x is { ctx: SessionContext; w: NonNullable<ReturnType<typeof windowForSession>> } => x.w !== null)
      .sort((a, b) => b.ctx.occupancyTokens / b.w.tokens - a.ctx.occupancyTokens / a.w.tokens)
      .slice(0, Math.max(0, body.length - 2));
    const start = Math.max(0, Math.floor((body.length - (threads.length + 1)) / 2));
    body[start] = `  ${active.join(" + ")} active — measuring, first delta lands with the next scan…`;
    threads.forEach((x, i) => {
      if (start + 1 + i >= body.length) return;
      const pct = (x.w.provenance === "inferred" ? "~" : "") + Math.round(Math.min(999, (x.ctx.occupancyTokens / x.w.tokens) * 100)) + "%";
      body[start + 1 + i] = `    ${shortModel(x.ctx.model)} ${pct} of window`;
    });
    return [...body, "", ""];
  };
  const chartBody = page === "limits"
    ? limitsPanelLines(data, liveSessions, { height: chartH + 2, width: innerW - 4, claudeLanes: live?.claudeLanes, claudeNote: live?.claudeNote, fillP: live?.pageP, redact: live?.redact, billingMode: live?.billingMode, budget: live?.budget, grokCredits: data.grokCredits })
    : liveMode
    ? liveSessions.length > 0
      ? liveSessionChartLines(liveSessions, { height: Math.max(1, chartH - 1), width: innerW - 4, redact: live?.redact })
      : liveEmpty()
    : barChartLines(animVals, {
        height: chartH,
        width: innerW - 4,
        tick,
        max: ladderMax,
        labels: { left: dayLabel(data.days[0]?.day ?? "----01-01"), right: dayLabel(data.days.at(-1)?.day ?? "----01-01") },
      });
  const chart = chartBody.map((l): Seg[] => {
    const axisEnd = l.search(/[┤┼]/);
    if (axisEnd < 0) return [{ t: "  " + l, c: ui.c.dim }]; // the x-label row
    return [
      { t: "  " + l.slice(0, axisEnd + 1), c: ui.c.dim },
      { t: l.slice(axisEnd + 1), c: ui.c.brand },
    ];
  });

  // Distribute leftover height: half above the content (settles the composition toward
  // center on tall screens), the rest above the bottom border.
  const padTop = Math.floor(extra / 2);
  const padBottom = extra - padTop;

  // Lockup mode's top rail carries the board strip's running ticker (the border's
  // whole width IS the marquee window); compact mode keeps the title border.
  const topRail = showLockup ? "┌" + tickerWindow(tickerText(data), innerW, tickerShift) + "┐" : topBorder(cols);
  const lines: string[] = [
    fitBorder(topRail, cols),
    ...Array.from({ length: padTop }, () => blankLine),
    ...pre.map(wall),
    ...chart.map(wall),
    ...post.map(wall),
    ...Array.from({ length: padBottom }, () => blankLine),
    fitBorder(bottomBorder(cols, spendMode ? SPEND_SCOPE : TOKEN_SCOPE, liveTail(live)), cols),
  ];

  // Exactness guard: the loop math above is designed to hit `rows`; enforce it anyway.
  while (lines.length < rows) lines.splice(lines.length - 1, 0, blankLine);
  if (lines.length > rows) lines.splice(1, lines.length - rows);
  return lines;
}

/** Borders carry ANSI; verify/repair their PLAIN width to exactly cols. */
function fitBorder(line: string, cols: number): string {
  const plain = line.replace(/\[[0-9;]*m/g, "");
  if (plain.length === cols) return line;
  if (plain.length > cols) {
    // Defensive truncate (plain reconstruction — a border is decoration, never data).
    return plain.slice(0, Math.max(0, cols - 1)) + (cols > 0 ? plain.at(-1) ?? "" : "");
  }
  // Too short: extend the rail before the final corner glyph.
  const corner = line.slice(-1);
  return line.slice(0, -1) + "─".repeat(cols - plain.length) + corner;
}

// ---- the linear settled renderer (non-TTY / --static / too-small) -------------------------------

/** Plain-text settled frames — NO ANSI by construction (never calls a paint), so a
 * piped/redirected run can never see an escape code. */
export function settledPlainText(data: ShowcaseData): string[] {
  const spendMode = data.spend30dUsd !== null;
  const nameW = Math.max(0, ...data.harnesses.map((x) => x.name.length));
  const finalVals = data.days.map((d) => (spendMode ? d.spendUsd : d.tokens));
  const lines: string[] = [
    `Deploy Forward v${TRACKER_VERSION} — local usage showcase (read-only)`,
    "rank the humans, not the models · leaderboard.deployforward.dev",
    tickerText(data),
    "",
    ...data.harnesses.map((h) => `  ${h.name.padEnd(nameW + 3)}${formatComma(h.sessions).padStart(7)} ${h.sessions === 1 ? "session" : "sessions"}`),
    `  ${data.harnesses.length} harnesses · ${formatComma(data.totalSessions)} sessions scanned`,
    "",
    `  ${formatComma(data.tokenTotal)} tokens read (${TOKENS_SCOPE_NOTE})`,
    ...(data.spendTotalUsd !== null ? [`  ${moneyExact(data.spendTotalUsd, data.spendIsPartial)} est spend (priced models only)`] : []),
    "",
    `  ${spendMode ? "ESTIMATED SPEND" : "TOKEN VOLUME"} · LAST 30 DAYS`,
    ...barChartLines(finalVals, {
      height: 6,
      width: 64,
      tick: spendMode ? moneyTick : (v: number) => formatCompact(Math.round(v)),
      labels: { left: dayLabel(data.days[0]?.day ?? "----01-01"), right: dayLabel(data.days.at(-1)?.day ?? "----01-01") },
    }).map((l) => "  " + l),
    "",
    ...mixBarSegments(data.modelRows, 48).map((s) => `  ${s.glyph} ${s.model}  ${s.sharePct}%`),
    `  ${spendMode ? SPEND_SCOPE : TOKEN_SCOPE}`,
  ];
  return lines;
}

// ---- the full-screen shell (guaranteed terminal restoration) ------------------------------------

export interface ShowcaseIO {
  write(s: string): void;
  isTTY: boolean;
  rows(): number;
  cols(): number;
  input?: {
    isTTY?: boolean;
    setRawMode?(b: boolean): void;
    on(e: "data", f: (d: Buffer) => void): void;
    off(e: "data", f: (d: Buffer) => void): void;
    resume?(): void;
    pause?(): void;
  };
  onResize?(f: () => void): () => void;
}

function realIO(): ShowcaseIO {
  return {
    write: (s) => void process.stdout.write(s),
    isTTY: process.stdout.isTTY === true,
    rows: () => process.stdout.rows ?? 24,
    cols: () => process.stdout.columns ?? 80,
    input: process.stdin as unknown as ShowcaseIO["input"],
    onResize: (f) => {
      process.stdout.on("resize", f);
      return () => void process.stdout.removeListener("resize", f);
    },
  };
}

/** Enter: alternate screen + hidden cursor + auto-wrap OFF (writing the bottom-right
 * cell must never scroll the frame). Leave restores all three — idempotent. */
const ENTER_FULLSCREEN = "[?1049h[?25l[?7l";
const LEAVE_FULLSCREEN = "[?7h[?25h[?1049l";

export interface FullScreenCtx {
  waitForQuit(): Promise<void>;
  quitRequested(): boolean;
  /** Normalized key events (see normalizeKey). Quit keys are consumed by the
   * lifecycle and never delivered here. */
  onKey(f: (key: string) => void): void;
  /** End the takeover from inside — same path as a quit key, so the terminal is
   * restored by the same `finally`. */
  requestQuit(): void;
}

/**
 * Normalize one stdin chunk. Arrow keys arrive as CSI (`ESC [ A`) or SS3 (`ESC O A`)
 * sequences that START with ESC — they MUST be matched before a bare ESC is read as
 * quit, or every arrow press would kill the watch. Returns null for chunks we ignore.
 */
export function normalizeKey(s: string): "left" | "right" | "up" | "down" | "enter" | "quit" | null {
  if (s === "\x1b[D" || s === "\x1bOD") return "left";
  if (s === "\x1b[C" || s === "\x1bOC") return "right";
  if (s === "\x1b[A" || s === "\x1bOA") return "up";
  if (s === "\x1b[B" || s === "\x1bOB") return "down";
  if (s === "\r" || s === "\n") return "enter";
  if (s === "q" || s === "Q" || s === "\x1b" || s === "\x03") return "quit";
  return null;
}

// ---- the launcher (↑↓ pick · ⏎ run) --------------------------------------------------------------

/**
 * What ⏎ can hand back to the shell (Marco 2026-07-17). super-start does NOT run these
 * itself: it returns the chosen argv, the takeover restores the terminal, and bin/df.ts
 * dispatches into the SAME code paths the real subcommands use — so a launched command
 * is the real command, printing into the user's own scrollback, never a re-implementation.
 * Read-only views only: nothing here mutates, and nothing needs an account.
 */
export interface SuperStartAction {
  argv: string[];
  label: string;
  hint: string;
  /** D16 carve-out: an action whose ESSENCE is external (opening the board URL in a
   * browser). The shell performs the external part and stays resident with a one-line
   * confirmation - it never renders a captured-output pane and never exits. */
  external?: boolean;
}

// ---- the never-exit shell (D16-D19, docs/context-capacity-plan.md Phase 7) ----------------------

/** The shell's abstracted key vocabulary - DELIBERATELY decoupled from normalizeKey()'s
 * raw-terminal vocabulary (whose bare-Esc-quits mapping stays locked). The view-aware
 * raw-to-ShellKey routing lives in runSuperStart's routeKey, so Esc/Backspace can mean
 * "back" inside the output/settings panes without touching the global watch contract. */
export type ShellKey = "left" | "right" | "up" | "down" | "enter" | "esc" | "backspace" | "q";

export interface ShellState {
  view: "watch" | "output" | "settings";
  menuIndex: number;
  chartView: "live" | "spend" | "limits";
  outputLines: string[];
  outputScroll: number;
  outputHeight: number;
  settingsIndex: number;
  quit: boolean;
  pendingAction: SuperStartAction | null;
}

export function initialShellState(): ShellState {
  return {
    view: "watch",
    menuIndex: 0,
    chartView: "live",
    outputLines: [],
    outputScroll: 0,
    outputHeight: 0,
    settingsIndex: 0,
    quit: false,
    pendingAction: null,
  };
}

/**
 * D16's pure view-routing reducer. Launcher commands NEVER exit the app: Enter marks the
 * selected action REQUESTED (the async runner is external to this reducer; its result
 * lands via shellReceiveOutput), the settings entry is an in-app view switch, and only
 * `q` (from any view) sets quit. Esc/Backspace navigate BACK from a pane; on the watch
 * they are a no-op here (the raw router keeps bare-Esc-quits at the watch level).
 */
export function shellStep(state: ShellState, key: ShellKey): ShellState {
  if (key === "q") return { ...state, quit: true };
  if (state.view === "watch") {
    if (key === "up" || key === "down") {
      const n = SUPER_START_ACTIONS.length;
      return { ...state, menuIndex: (state.menuIndex + (key === "down" ? 1 : -1) + n) % n };
    }
    if (key === "left" || key === "right") {
      return { ...state, chartView: nextChartView(state.chartView, key) };
    }
    if (key === "enter") {
      const action = SUPER_START_ACTIONS[state.menuIndex];
      if (!action) return state;
      // The settings entry is an in-app view switch, not a launched command.
      if (action.argv[0] === "settings") return { ...state, view: "settings" };
      return { ...state, pendingAction: action };
    }
    return state;
  }
  if (state.view === "output") {
    if (key === "esc" || key === "backspace") {
      // The watch's own data (menuIndex/chartView) was never touched while in the
      // pane, so returning restores it for free; the pane's buffer is dropped.
      return { ...state, view: "watch", outputLines: [], outputScroll: 0, outputHeight: 0 };
    }
    if (key === "up" || key === "down") {
      const max = Math.max(0, state.outputLines.length - state.outputHeight);
      const next = Math.min(max, Math.max(0, state.outputScroll + (key === "down" ? 1 : -1)));
      return { ...state, outputScroll: next };
    }
    return state;
  }
  // settings: row navigation + toggling live in settingsStep (they need TrackerState);
  // only the back/quit routing belongs here.
  if (key === "esc" || key === "backspace") return { ...state, view: "watch" };
  return state;
}

/** The async delivery of a launched action's result - separate from shellStep because
 * the runner is async and this is the pure "the result landed" transition. A captured
 * pane gets the lines + its visible height; an external action (D16's carve-out) gets
 * exactly one confirmation line. Either way the request is resolved and the shell stays
 * resident. */
export function shellReceiveOutput(
  state: ShellState,
  result: { lines: string[]; visibleHeight: number } | { confirmLine: string },
): ShellState {
  const pane =
    "confirmLine" in result
      ? { outputLines: [result.confirmLine], outputHeight: 1 }
      : { outputLines: result.lines, outputHeight: result.visibleHeight };
  return { ...state, view: "output", pendingAction: null, outputScroll: 0, ...pane };
}

// ---- in-app settings (D17) -----------------------------------------------------------------------

export interface SettingsRow {
  name: string;
  value: string;
  toggleable: boolean;
}

/** The v1 groups, in the documented order (six baseline + a D20/D22 Budget row inserted
 * right after Billing for the "api"/"mix" plan types). Values are REAL state reads -
 * pairing, persisted limits consent, the redact flag - never placeholders.
 *
 * Billing (D20: "editable in settings") now reads the three-way billingMode when set —
 * a distinct `mode: <api|subscription|mix>` value per plan type — and falls back to the
 * legacy D9 boolean-gate text otherwise, preserving shell.test.ts's byte-for-byte
 * regression pin for a device that only ever went through the old flow: the OLD
 * `limitsProviders`-answered signal still drives "subscription question answered" /
 * "not asked yet - answered during onboarding" when no billingMode is set. A newer
 * billingMode answer always wins over a stale legacy signal. */
/** D14 C7: the settings Org row's value string -- "none", "{label} ({role}{, team})"
 * when enrolled, or "request pending - {label} (expires {n}d)[ (+{n} more - df
 * status)]" for the most-recently-created pending request (the request with the LATEST
 * expiresAt -- every request's TTL is a fixed 7 days from creation, so ordering by
 * expiresAt descending is equivalent to ordering by createdAt descending; C9's mirror
 * shape carries no separate createdAt field). Exported standalone (not inlined into
 * settingsRows) so it is directly unit-testable without threading a full TrackerState
 * through every case. `now` is injectable for tests; production omits it. */
export function orgSettingsValue(org: TrackerState["org"], now: number = Date.now()): string {
  if (org?.enrolled) {
    const role = org.attribution?.organizations.find((o) => o.orgId === org.orgId)?.role;
    const team = org.teamId;
    const detail = role ? `${role}${team ? `, ${team}` : ""}` : undefined;
    return `${org.orgLabel ?? org.orgId ?? "enrolled"}${detail ? ` (${detail})` : ""}`;
  }
  const pending = org?.pendingRequests ?? [];
  if (pending.length > 0) {
    // Most recently created = latest expiresAt (fixed 7-day TTL from creation).
    const top = [...pending].sort((a, b) => b.expiresAt - a.expiresAt)[0];
    const days = Math.max(0, Math.ceil((top.expiresAt - now) / 86_400_000));
    const more = pending.length > 1 ? ` (+${pending.length - 1} more - df status)` : "";
    return `request pending - ${top.orgLabel} (expires ${days}d)${more}`;
  }
  return "none";
}

export function settingsRows(state: TrackerState, now: number = Date.now()): SettingsRow[] {
  const paired = state.deviceToken !== null && state.handle !== null;
  const claudeOn = state.limitsProviders?.claude === true;
  const billingAnswered = state.limitsProviders !== undefined;
  const redactOn = state.redact === true;
  const billingValue = state.billingMode
    ? `mode: ${state.billingMode}`
    : billingAnswered
      ? "subscription question answered"
      : "not asked yet - answered during onboarding";
  const rows: SettingsRow[] = [
    { name: "Board", value: paired ? `on the board as @${state.handle}` : "not paired - the bare run offers onboarding", toggleable: false },
    { name: "Providers", value: "auto-detect, all supported harnesses", toggleable: false },
    { name: "Billing", value: billingValue, toggleable: true },
  ];
  // D22: the Budget row is presentation-only in this phase (not toggleable — editing
  // the number is a future seam) and only shown for the modes that scope a budget at all.
  if (state.billingMode === "api" || state.billingMode === "mix") {
    rows.push({
      name: "Budget",
      value: state.monthlyBudgetUsd !== undefined ? `$${state.monthlyBudgetUsd} /mo` : "not set",
      toggleable: false,
    });
  }
  rows.push(
    { name: "Limits", value: claudeOn ? "claude usage lanes: on" : "claude usage lanes: off", toggleable: true },
    { name: "Privacy", value: redactOn ? "redact thread labels: on" : "redact thread labels: off", toggleable: true },
    // D14 C7: an Org row beside Device -- read-only display (the alt-screen launcher
    // spawns commands with no stdin, so entering an invite code/slug interactively
    // in-app isn't feasible; the actual join/request/leave actions are the standalone
    // `df org join`/`df org request`/`df org leave` subcommands, C8).
    { name: "Org", value: orgSettingsValue(state.org, now), toggleable: false },
    { name: "Device", value: paired ? `token stored for @${state.handle} on this machine` : "no device token on this machine", toggleable: false },
  );
  return rows;
}

/** Pure, immutable toggle of the boolean/enum a row represents. Billing (D20) cycles the
 * three-way billingMode api -> subscription -> mix -> api, wrapping forward (unset lands
 * on "api" on the first toggle); every other field, including monthlyBudgetUsd, is left
 * untouched -- settings edits are additive, and mode routing (limitsPanelLines) is the
 * only place that ever ignores a budget for a given mode. Limits flips the persisted
 * claude lanes consent (absence reads as false, D18's honest default); Privacy flips
 * the redact flag. Every other row carries no boolean - a no-op. */
export function toggleSettingsRow(state: TrackerState, rowName: string): TrackerState {
  if (rowName === "Billing") {
    const cycle = ["api", "subscription", "mix"] as const;
    const idx = state.billingMode ? cycle.indexOf(state.billingMode) : -1;
    return { ...state, billingMode: cycle[(idx + 1) % cycle.length] };
  }
  if (rowName === "Limits") {
    const next = !(state.limitsProviders?.claude ?? false);
    return { ...state, limitsProviders: { ...state.limitsProviders, claude: next } };
  }
  if (rowName === "Privacy") {
    return { ...state, redact: !(state.redact ?? false) };
  }
  return state;
}

/** Settings-view-LOCAL stepping: row navigation (never persists) and Enter-to-toggle
 * (persists EXACTLY once via the injected callback, so the caller controls where state
 * lands - production passes saveState). View routing in/out of "settings" stays
 * shellStep's job. */
export function settingsStep(
  state: ShellState,
  key: ShellKey,
  ctx: { trackerState: TrackerState; persist: (next: TrackerState) => void },
): { state: ShellState; trackerState: TrackerState } {
  const rows = settingsRows(ctx.trackerState);
  if (key === "up" || key === "down") {
    const n = rows.length;
    return {
      state: { ...state, settingsIndex: (state.settingsIndex + (key === "down" ? 1 : -1) + n) % n },
      trackerState: ctx.trackerState,
    };
  }
  if (key === "enter") {
    const row = rows[state.settingsIndex];
    if (!row || !row.toggleable) return { state, trackerState: ctx.trackerState };
    const next = toggleSettingsRow(ctx.trackerState, row.name);
    ctx.persist(next);
    return { state, trackerState: next };
  }
  return { state, trackerState: ctx.trackerState };
}

// ---- persisted limits consent (D18) + the honest non-TTY note (D19) ------------------------------

// resolveLimitsConsent moved to limitsFetch.ts (one home for every surface);
// re-exported below so existing importers keep working unchanged.

/** D19: a bare/`start` run without a TTY keeps the legacy monitor but must SAY so -
 * one line naming why and how to get the full experience. bin/df.ts prints this
 * verbatim on its legacy non-TTY paths. */
export const NON_TTY_NOTE =
  "No interactive terminal detected, so this is the plain monitor - run npx --yes deploy-forward@latest in a real terminal for the full experience.";

// ---- the in-app pane renderers + the action runner (D16 integration) -----------------------------

/** Full-frame pane: every line padded to the exact frame width so a repaint fully
 * overwrites the previous frame without a clear (same discipline as composeScreen). */
function padFrame(lines: string[], size: { rows: number; cols: number }): string[] {
  const w = Math.max(20, size.cols);
  const out = lines.slice(0, size.rows).map((l) => (l.length > w ? l.slice(0, w) : l.padEnd(w, " ")));
  while (out.length < size.rows) out.push(" ".repeat(w));
  return out;
}

/** The D16 output pane: a launched command's captured output, scrollable, with the
 * return affordance stated. Plain text body (the child runs NO_COLOR). */
export function composeOutputPane(shell: ShellState, size: { rows: number; cols: number }, title: string): string[] {
  const h = Math.max(1, Math.min(shell.outputHeight || size.rows - 6, size.rows - 6));
  const end = Math.min(shell.outputLines.length, shell.outputScroll + h);
  const body = shell.outputLines.slice(shell.outputScroll, end);
  const scrollable = shell.outputLines.length > h;
  const pos = scrollable ? ` (${shell.outputScroll + 1}-${end}/${shell.outputLines.length})` : "";
  const plain = [
    "",
    `  ${title}${pos}`,
    "  " + "-".repeat(Math.max(8, Math.min(60, size.cols - 4))),
    ...body.map((l) => `  ${l}`),
    "",
    `  esc/backspace back to the watch${scrollable ? " | up/down scroll" : ""} | q quit`,
  ];
  const padded = padFrame(plain, size);
  // Paint applied to the already-padded lines, so the width math never sees an escape code.
  return padded.map((l, i) => (i === 1 ? ui.c.bold(l) : i === 2 ? ui.c.dim(l) : l));
}

/** The D17 settings pane: grouped rows of name + current value, arrow-driven selection,
 * Enter to toggle. Aligned columns, no emojis, the existing visual language. */
export function composeSettingsPane(shell: ShellState, trackerState: TrackerState, size: { rows: number; cols: number }): string[] {
  const rows = settingsRows(trackerState);
  const sel = ((shell.settingsIndex % rows.length) + rows.length) % rows.length;
  const nameW = Math.max(...rows.map((r) => r.name.length)) + 2;
  const plain: string[] = ["", "  SETTINGS", "  " + "-".repeat(Math.max(8, Math.min(60, size.cols - 4))), ""];
  const selLines: number[] = [];
  rows.forEach((r, i) => {
    if (i === sel) selLines.push(plain.length);
    const marker = i === sel ? "> " : "  ";
    const toggle = i === sel && r.toggleable ? "  (enter to toggle)" : "";
    plain.push(`  ${marker}${r.name.padEnd(nameW)}${r.value}${toggle}`);
  });
  plain.push("");
  plain.push("  up/down pick | enter toggle | esc back to the watch | q quit");
  const padded = padFrame(plain, size);
  return padded.map((l, i) => (i === 1 ? ui.c.bold(l) : i === 2 ? ui.c.dim(l) : selLines.includes(i) ? ui.c.bold(l) : l));
}

/** Opens a URL with the platform opener, detached - the shell stays resident (D16's
 * external carve-out). A failed spawn is silent here: the confirmation line carries
 * the URL, so it is always visible to copy by hand. */
export function openInBrowser(url: string): void {
  try {
    const [cmd, args]: [string, string[]] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the confirm line still names the URL */
  }
}

const ACTION_TIMEOUT_MS = 30_000;
const ACTION_MAX_LINES = 2_000;

/** D16: run the selected command as the REAL CLI in a child process and capture its
 * output for the in-app pane - the same bin, the same code paths, never a
 * re-implementation. The child gets NO_COLOR (the pane is plain text) and inherits
 * execArgv so a tsx dev run resolves the .ts entry exactly like the scan worker. */
async function captureActionOutput(
  action: SuperStartAction,
  size: { rows: number; cols: number },
): Promise<{ lines: string[]; visibleHeight: number } | { confirmLine: string }> {
  if (action.external) {
    const url = `${APP_BASE}/leaderboard`;
    openInBrowser(url);
    return { confirmLine: `Opened ${url} in your browser` };
  }
  const visibleHeight = Math.max(3, size.rows - 6);
  const jsEntry = new URL("../bin/df.js", import.meta.url);
  const entry = existsSync(fileURLToPath(jsEntry)) ? jsEntry : new URL("../bin/df.ts", import.meta.url);
  const lines = await new Promise<string[]>((resolve) => {
    let buf = "";
    let done = false;
    const finish = (extra?: string): void => {
      if (done) return;
      done = true;
      const all = (buf + (extra ? `\n${extra}` : ""))
        .replace(/\r\n/g, "\n")
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
        .replace(/\x1b\]8;;[^\x07]*\x07/g, "");
      const split = all.split("\n");
      while (split.length > 0 && split[split.length - 1].trim() === "") split.pop();
      resolve(split.slice(0, ACTION_MAX_LINES));
    };
    try {
      const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(entry), ...action.argv], {
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d: Buffer) => (buf += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (buf += d.toString("utf8")));
      child.once("close", () => finish());
      child.once("error", (e: Error) => finish(`(${action.label} failed to start: ${e.message})`));
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        finish(`(${action.label} timed out after ${ACTION_TIMEOUT_MS / 1000}s)`);
      }, ACTION_TIMEOUT_MS).unref();
    } catch (e) {
      finish(`(${action.label} failed: ${(e as Error).message})`);
    }
  });
  return { lines, visibleHeight };
}

export const SUPER_START_ACTIONS: readonly SuperStartAction[] = [
  { argv: ["usage"], label: "usage", hint: "per-model totals from this machine" },
  { argv: ["usage", "--by-day"], label: "usage --by-day", hint: "per-day totals, last 30 days" },
  { argv: ["usage", "--by-project"], label: "usage --by-project", hint: "per-project attribution (local labels)" },
  { argv: ["usage", "--cost"], label: "usage --cost", hint: "per-model totals + estimated spend" },
  // D16/D17 (Marco 2026-07-18): the launcher grows the board opener (external) and the
  // in-app settings view. Both stay inside the never-exit shell.
  { argv: ["board"], label: "board", hint: "open your board in the browser", external: true },
  { argv: ["settings"], label: "settings", hint: "board, billing, limits, privacy - edit in-app" },
  { argv: ["status"], label: "status", hint: "auth, hooks, last sync — the health check" },
];

/**
 * The takeover lifecycle with GUARANTEED restore: normal return, a thrown error, and
 * process exit all emit the leave sequence (a botched exit strands the user in the alt
 * buffer with no cursor — a wrecked terminal). Quit keys: q, Esc, Ctrl-C (raw mode
 * turns Ctrl-C into a \x03 keypress, so it is handled here, not as SIGINT).
 */
export async function withFullScreen(
  io: ShowcaseIO,
  run: (ctx: FullScreenCtx) => Promise<void>,
  // The D16 shell passes a view-aware router here (bare Esc = back inside a pane,
  // quit only on the watch). Default: the locked normalizeKey vocabulary, unchanged.
  normalize: (s: string) => string | null = normalizeKey,
  // sim-report.md Finding 2: keys the CALLER already buffered before this function was
  // even invoked (runSuperStart wires an early listener at its own true entry point,
  // long before preloadData/onboarding resolve and this function is finally reached).
  // Seeded into pendingKeys below so they replay, in order, ahead of anything buffered
  // by this function's own onData -- same discipline, same replay-on-first-subscriber
  // contract, just handed a head start.
  earlySeed?: { keys: string[]; quit: boolean },
): Promise<void> {
  let quit = false;
  let resolveQuit: () => void = () => {};
  const quitP = new Promise<void>((r) => (resolveQuit = r));
  const keyHandlers: ((k: string) => void)[] = [];
  // sim-report.md Finding 2: keys pressed before the watch's own onKey() subscriber is
  // wired (production only subscribes well after Act I's ~5s entrance animation) matched
  // against this empty array and were silently discarded. Buffer them here and replay,
  // IN ORDER, the moment the first subscriber wires up (below). Quit keys are unaffected
  // -- they are handled inline, above, and already worked.
  const pendingKeys: string[] = earlySeed ? [...earlySeed.keys] : [];
  const onData = (d: Buffer): void => {
    const k = normalize(d.toString("utf8"));
    if (k === null) return;
    if (k === "quit") {
      quit = true;
      resolveQuit();
      return;
    }
    if (keyHandlers.length === 0) {
      pendingKeys.push(k);
      return;
    }
    for (const f of keyHandlers) f(k);
  };
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      io.input?.setRawMode?.(false);
    } catch {
      /* stdin may already be gone at process exit */
    }
    io.write(LEAVE_FULLSCREEN);
  };

  io.write(ENTER_FULLSCREEN);
  io.input?.setRawMode?.(true);
  io.input?.resume?.();
  io.input?.on("data", onData);
  // A quit key that arrived in the caller's early buffer (before this function was even
  // invoked) is honored the same as one arriving through onData -- never silently
  // dropped just because it landed in the gap before withFullScreen existed.
  if (earlySeed?.quit) {
    quit = true;
    resolveQuit();
  }
  process.once("exit", restore);
  try {
    await run({
      waitForQuit: () => quitP,
      quitRequested: () => quit,
      onKey: (f) => {
        const wasEmpty = keyHandlers.length === 0;
        keyHandlers.push(f);
        // First subscriber ever to wire up: replay whatever arrived early, in order,
        // then clear the buffer. A later onKey() call (already-subscribed state) never
        // replays -- only the FIRST wire-up drains the early buffer.
        if (wasEmpty && pendingKeys.length > 0) {
          const buffered = pendingKeys.splice(0, pendingKeys.length);
          for (const k of buffered) for (const h of keyHandlers) h(k);
        }
      },
      requestQuit: () => {
        quit = true;
        resolveQuit();
      },
    });
  } finally {
    process.removeListener("exit", restore);
    io.input?.off("data", onData);
    io.input?.pause?.();
    restore();
  }
}

// ---- the command ---------------------------------------------------------------------------------

const EMPTY_STATE =
  "No local agent history found yet — build something with Claude Code or Codex, then run this again.";
const TOO_SMALL = "Terminal too small for the full-screen view (need 80x24) — showing the summary instead.";

/** Animate-in duration (ms) and repaint interval. After settle the frame goes LIVE:
 * a read-only rescan of the local corpus every REFRESH_MS, deltas ticking the hero
 * figures up — the `start` listener's feel with none of its writes. Unbounded until
 * the user quits. */
const ANIMATE_MS = 5000;
const FRAME_MS = 50;
/** Fallback fold cadence when the probe sees nothing move (SQLite harnesses whose WAL
 * writes are less predictable still get caught here). */
const REFRESH_MS = 15_000;
/** Quiet period after the LAST observed write before folding — a burst of appends
 * becomes one fold, not ten. */
const SCAN_DEBOUNCE_MS = 800;
/** Hard floor between folds: a chatty agent can never spin the scan continuously. */
const MIN_SCAN_GAP_MS = 3000;

/**
 * Should the loop fold now? Two ways to be due, both requiring an unfolded write:
 *  - the burst SETTLED (quiet for SCAN_DEBOUNCE_MS, past the MIN_SCAN_GAP floor) —
 *    a run of appends becomes one fold;
 *  - the writing is SUSTAINED: agents streaming continuously reset the settle clock
 *    every beat, which starved every delta fold to the 15s fallback (Marco's
 *    screenshot, 2026-07-17: four live agents, empty live chart). Past
 *    2x MIN_SCAN_GAP since the last fold, sustained writing IS the trigger —
 *    bounded latency, still burst-coalesced.
 * The REFRESH_MS fallback clock stays the caller's (it fires with no writes at all).
 */
export function scanDue(now: number, corpusChangedAt: number, lastScanAt: number): boolean {
  if (corpusChangedAt <= lastScanAt) return false;
  const settled = now - corpusChangedAt >= SCAN_DEBOUNCE_MS && now - lastScanAt >= MIN_SCAN_GAP_MS;
  const sustained = now - lastScanAt >= MIN_SCAN_GAP_MS * 2;
  return settled || sustained;
}
/** Frames for a delta tick (50ms apart): the hero races old -> new over ~1.2s. */
const TICK_FRAMES = 24;
/** Marquee cadence: one cell per step — smooth on a recording without strobing. Also
 * the live watch's repaint interval (the ticker must keep rolling between scans).
 * 60ms (Marco 2026-07-16: "make this scroll through faster"). */
const TICKER_STEP_MS = 60;

export interface SuperStartOptions {
  static?: boolean;
  /** Injectable clock for tests (the 30-day window's anchor). */
  now?: number;
  /** Tier B opt-in for THIS RUN (--limits): fetch the vendor-reported Claude lanes
   * with the CLI's own stored token, read-only. Off by default, always. */
  limits?: boolean;
  /**
   * The "do you want to be on the board?" question (Marco 2026-07-17 ruling). Called at
   * most ONCE, only when the loaded device is unpaired AND the run is interactive (never
   * on --static, non-TTY, or an already-paired device). true = accept, false = decline —
   * decline is never re-asked within this run. Omitted in production defaults to the real
   * prompt; tests fake it.
   */
  askOnboarding?: () => Promise<boolean>;
  /**
   * Called ONLY after askOnboarding resolves true. Production wires this to the SAME
   * pairing flow `start` uses (bin/df.ts's connectDeviceCeremony(), shared with
   * firstRun()) — never a reimplementation here. true = pairing succeeded (watch runs
   * pushing); false = it failed or was aborted (watch stays read-only).
   */
  pairOnboarding?: () => Promise<boolean>;
  /**
   * D14 C1 (docs/d14-two-way-join-spec.md): the org-join question, called ONLY after a
   * SUCCESSFUL opts.pairOnboarding() — org membership needs a device token, so an
   * unpaired or failed-pair run never asks it. Fires at most once per device (ask-once,
   * guarded by TrackerState.orgAskedAt at the call site — production's
   * askSuperStartOrgJoin — same discipline as onboardedAt/askOnboarding), and runs
   * BEFORE opts.askBillingMode below (fix: D10's ordering). Omitted in production
   * defaults to nothing asked (never blocks a device with no production wiring); tests
   * fake it.
   */
  askOrgJoin?: () => Promise<void>;
  /**
   * D20's plan-type question, extracted out of askOnboarding's own production
   * implementation (bin/df.ts's askSuperStartOnboarding used to call it internally) so
   * runSuperStart can sequence it explicitly AFTER the org-join question above instead
   * of the org question having to reach INTO an opaque askOnboarding call. Called
   * unconditionally once per onboarding pass regardless of the board accept/decline
   * answer (billing mode is a local concept, independent of pairing) — same timing
   * production always had. Omitted -> nothing asked (every existing test that omits it
   * is unaffected).
   */
  askBillingMode?: () => Promise<void>;
  /**
   * Injectable `fetch` for the Tier B vendor-reported lanes call (test seam only --
   * production omits it and falls back to the real global `fetch`, unaffected). Threaded
   * into fetchClaudeLimits's own `fetchImpl` option in place of the hardcoded global.
   */
  limitsFetchImpl?: typeof fetch;
  /** Collapse thread identity back to bare model labels (recording-safe). */
  redact?: boolean;
  /** Open directly on a view (D17: `deploy-forward settings` / `--settings` lands on
   * the in-app settings page). Default: the watch. */
  initialView?: "watch" | "settings";
  /**
   * The passive "is this build stale?" check (update.ts's checkForNewerVersion) —
   * injectable the same way limitsFetchImpl is, so the many interactive tests that drive
   * the real full-screen pipeline never make a real registry fetch. Production wires the
   * real check (bin/df.ts's runShowcase()); omitted means no check is run at all — never
   * a network call and never a nag, which is exactly what every existing test wants.
   */
  checkUpdate?: () => Promise<string | null>;
}

/**
 * D9's billing question (docs/context-capacity-plan.md Phase 6, RULED 2026-07-18): "Are
 * you on any monthly-based subscription plans?" A PURE onboarding step -- it reads no
 * state and remembers nothing across calls, so decline is never sticky-forever (a later
 * call with a different answer simply returns that different answer). The caller (bin/
 * df.ts) is responsible for persisting the result into TrackerState.limitsProviders.
 *
 * ask.subscription() is asked exactly once. false -> returns {} immediately and NEVER
 * asks a per-provider question (token/API users skip limits entirely; token tracking
 * stays the product's focus for everyone). true -> asks ask.provider() ONLY for the
 * providers that need consent -- today just "claude" (Codex is disk-read/always-on and
 * must never be asked; Grok/Cursor are future research). The result carries exactly what
 * was answered, verbatim, including an explicit `false` (a decline is a real persisted
 * no, not an omitted key).
 */
export async function billingOnboarding(ask: {
  subscription: () => Promise<boolean>;
  provider: (name: string) => Promise<boolean>;
}): Promise<{ claude?: boolean }> {
  const subscribed = await ask.subscription();
  if (!subscribed) return {};
  const claude = await ask.provider("claude");
  return { claude };
}

/**
 * D20's three-way plan-type onboarding question (docs/context-capacity-plan.md Phase 8,
 * RULED 2026-07-19) — the successor to billingOnboarding above (D9's boolean gate stays
 * exported and untouched; test/onboardingV2.test.ts still pins it end-to-end). PURE, same
 * discipline as billingOnboarding: reads no state, remembers nothing across calls.
 *
 * ask.mode() is asked exactly once. "api" -> no per-provider question (nothing is
 * provisioned for an API-only user) but DOES ask ask.budget() (D22: budget applies to api
 * too). "subscription" -> asks ask.provider() only for the providers that need consent
 * (today just "claude") and NEVER asks the budget question (D22 scopes budget to api/mix
 * only). "mix" -> asks both. A budget decline (ask.budget() -> null) omits the `budget`
 * key entirely rather than persisting a null/0 placeholder, and never degrades the mode
 * or providers answers already collected.
 */
export async function billingModeOnboarding(ask: {
  mode: () => Promise<"api" | "subscription" | "mix">;
  provider: (name: string) => Promise<boolean>;
  budget: () => Promise<number | null>;
}): Promise<{ mode: "api" | "subscription" | "mix"; providers?: { claude?: boolean }; budget?: number }> {
  const mode = await ask.mode();
  if (mode === "subscription") {
    const claude = await ask.provider("claude");
    return { mode, providers: { claude } };
  }
  const providers = mode === "mix" ? { claude: await ask.provider("claude") } : undefined;
  const budget = await ask.budget();
  return { mode, ...(providers ? { providers } : {}), ...(budget !== null ? { budget } : {}) };
}

/**
 * D14 C2 (docs/d14-two-way-join-spec.md): the org-join onboarding question, PURE like
 * billingModeOnboarding above -- reads no state, remembers nothing across calls. Called
 * ONLY after a successful pairing (org membership is account-level; an unpaired device
 * has no device token to redeem an invite or submit a join request with).
 *
 * ask.choice() picks exactly one of three options ("code" | "request" | "skip", skip
 * being the default -- Enter alone). "code" additionally asks ask.code() (the pasted
 * invite code); "request" additionally asks ask.slug() (a bare org slug or a full org
 * URL -- extractOrgSlug in orgContext.ts resolves either shape). "skip" asks nothing
 * further. This function only composes the QUESTION -- it never touches the network or
 * disk; the caller (bin/df.ts's askSuperStartOrgJoin, the single persister shared by
 * BOTH live onboarding paths per C1) is responsible for the ask-once write (orgAskedAt)
 * and for actually calling orgContext.ts's redeemInviteCode/requestToJoinOrg.
 */
export async function orgJoinOnboarding(ask: {
  choice: () => Promise<"code" | "request" | "skip">;
  code: () => Promise<string>;
  slug: () => Promise<string>;
}): Promise<{ action: "code"; code: string } | { action: "request"; slug: string } | { action: "skip" }> {
  const choice = await ask.choice();
  if (choice === "code") return { action: "code", code: await ask.code() };
  if (choice === "request") return { action: "request", slug: await ask.slug() };
  return { action: "skip" };
}

/** OSC 0 — mirror the run's phase into the terminal tab title (the Grok-tab idea,
 * Marco 2026-07-17). Interactive TTY paths only: a title write is still an escape
 * sequence, and piped output must never see one. */
/** The Claude Code CLI's own credential file — read-only, never written. */
// claudeCredentialsPath moved to limitsFetch.ts alongside the fetch it feeds.

function setTitle(io: ShowcaseIO, title: string): void {
  io.write(`\x1b]0;${title}\x07`);
}

/** The pre-loader's pulse (braille orbit — the house spinner's own glyphs). Exported
 * so the tab-title suite (D23) pins its frame-cycling against these REAL glyphs
 * instead of a second, driftable copy. */
export const PULSE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * D23 (docs/context-capacity-plan.md, RULED 2026-07-19) — "the tab is a surface".
 * The three phases the tab title composes for, PURE (no clock/IO read here — the
 * caller supplies frame indices and deltas already sampled).
 */
export type TabTitleState =
  | { phase: "loading"; frame: number; phaseLabel: string }
  | { phase: "live"; delta?: { tokens: number; spendUsd: number | null } | null }
  | { phase: "settled" };

/** Compose the tab title for the current phase — mirrors the hero's own delta chip
 * and the marquee's number painting (formatCompact/formatCostUsd), no new formatting
 * invented. Never writes anything; `createTitleWriter` owns the OSC 0 write + guards. */
export function composeTabTitle(state: TabTitleState): string {
  if (state.phase === "loading") {
    const glyph = PULSE[state.frame % PULSE.length];
    return `${glyph} deploy-forward · ${state.phaseLabel}`;
  }
  if (state.phase === "settled") return "deploy-forward";
  const delta = state.delta;
  if (!delta || !(delta.tokens > 0)) return "deploy-forward"; // no burn yet — never a stale "+0"
  const spendClause = delta.spendUsd !== null && delta.spendUsd !== undefined && delta.spendUsd > 0 ? ` · ${formatCostUsd(delta.spendUsd)}` : "";
  return `deploy-forward · +${formatCompact(delta.tokens)}${spendClause}`;
}

/**
 * A STATEFUL wrapper around setTitle's OSC 0 write: throttled to at most one write
 * per 500ms of the INJECTED clock (never Date.now directly — tests must control it),
 * and deduped so an identical title never re-fires the escape sequence even long
 * after the throttle window has passed (a settled tab must not flicker). A title
 * offered inside the throttle window is DROPPED, not queued — the next eligible
 * write still measures from the last WRITE, never from a dropped attempt. Non-TTY
 * `io` never writes, full stop (the existing setTitle rule, carried into the wrapper).
 */
export function createTitleWriter(io: ShowcaseIO, now: () => number): (title: string) => void {
  let lastWriteAt = -Infinity;
  let lastWritten: string | null = null;
  return (title: string): void => {
    if (!io.isTTY) return;
    if (title === lastWritten) return;
    const t = now();
    if (t - lastWriteAt < 500) return; // inside the window — dropped, not queued
    lastWriteAt = t;
    lastWritten = title;
    setTitle(io, title);
  };
}

/** OSC 9;4 — Windows Terminal tab/taskbar progress. `pct !== null` composes the
 * determinate state (clamped 0-100, rounded); `null` composes the settle/clear
 * state. Other terminals silently ignore the unknown OSC (already the project's
 * stance on OSC 8/0). PURE — `writeProgress` owns the write + the TTY guard. */
export function composeProgressOsc(pct: number | null): string {
  if (pct === null) return "\x1b]9;4;0;\x07";
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  return `\x1b]9;4;1;${clamped}\x07`;
}

/** Writes composeProgressOsc(pct) to `io`, gated the same way as the title writer:
 * nothing reaches a non-TTY io, ever. */
export function writeProgress(io: ShowcaseIO, pct: number | null): void {
  if (!io.isTTY) return;
  io.write(composeProgressOsc(pct));
}

/**
 * The first corpus read, WITHOUT the dead air (Marco 2026-07-17: `npx … super-start`
 * sat on a bare cursor for the 1–3s synchronous scan before anything painted). The
 * read runs in the same worker the live watch uses; the main thread paints a branded
 * loading line immediately — the ■ tile-mark, a pulse, and the phase label — and the
 * tab title mirrors the phase. Worker failure falls back to the synchronous read
 * (correct, just blocking — never a dead run).
 */
async function preloadData(io: ShowcaseIO, now?: number, writeTitle: (title: string) => void = createTitleWriter(io, Date.now)): Promise<ShowcaseData> {
  const phaseLabel = "reading local agent history";
  writeTitle(composeTabTitle({ phase: "loading", frame: 0, phaseLabel }));
  const line = (i: number): string =>
    `\r\x1b[2K  ${ui.c.brand("■")} ${ui.c.dim(PULSE[i % PULSE.length])} reading local agent history…`;
  io.write(line(0));
  const data = await new Promise<ShowcaseData | null>((resolve) => {
    try {
      const jsEntry = new URL("./superStartScan.js", import.meta.url);
      const entry = existsSync(fileURLToPath(jsEntry)) ? jsEntry : new URL("./superStartScan.ts", import.meta.url);
      const worker = new Worker(entry, { workerData: { push: false } });
      let i = 0;
      const timer = setInterval(() => {
        i++;
        io.write(line(i));
        writeTitle(composeTabTitle({ phase: "loading", frame: i, phaseLabel }));
      }, 80);
      const finish = (d: ShowcaseData | null): void => {
        clearInterval(timer);
        resolve(d);
      };
      worker.once("message", (msg: { ok: boolean; data?: ShowcaseData }) => finish(msg.ok && msg.data ? msg.data : null));
      worker.once("error", () => finish(null));
      worker.unref();
    } catch {
      resolve(null);
    }
  });
  io.write("\r\x1b[2K"); // hand the line back clean before the takeover
  return data ?? readShowcaseData(now);
}

/**
 * `deploy-forward super-start`. Branches per the spec's degradation matrix: full-screen
 * animated takeover on a real interactive terminal of workable size; plain settled
 * frames for --static, non-TTY, or a too-small window; an honest empty state when
 * there is nothing to show. Read-only in every branch.
 */
export async function runSuperStart(opts: SuperStartOptions = {}, io: ShowcaseIO = realIO()): Promise<SuperStartAction | null> {
  const interactive = io.isTTY && io.input?.isTTY === true && !opts.static;
  // D16: the never-exit shell. Launcher commands run IN-APP (the v1 exit-and-launch
  // handback is retired). `shell` lives out here so routeKey can read the current view.
  // Declared at the TRUE top of the function (moved up from just above withFullScreen)
  // so routeKey is ready to serve as the early-key normalizer below, before preloadData,
  // onboarding, or anything else has run.
  let shell = initialShellState();
  if (opts.initialView === "settings") shell = { ...shell, view: "settings" };
  // View-aware raw-key router: the global bare-Esc-quits contract holds on the WATCH;
  // inside the output/settings panes Esc/Backspace mean "back" (D16). q and Ctrl-C
  // quit from anywhere. normalizeKey itself stays untouched (its mapping is locked).
  const routeKey = (s: string): string | null => {
    if (s === "\x1b[D" || s === "\x1bOD") return "left";
    if (s === "\x1b[C" || s === "\x1bOC") return "right";
    if (s === "\x1b[A" || s === "\x1bOA") return "up";
    if (s === "\x1b[B" || s === "\x1bOB") return "down";
    if (s === "\r" || s === "\n") return "enter";
    if (s === "q" || s === "Q" || s === "\x03") return "quit";
    if (s === "\x1b") return shell.view === "watch" ? "quit" : "esc";
    if (s === "\x7f" || s === "\x08") return "backspace";
    return null;
  };
  // sim-report.md Finding 2: an eager human can start pressing keys the INSTANT the
  // takeover appears -- before the preload spinner resolves, before onboarding, long
  // before the watch's own onKey() subscriber wires up (well after Act I's ~5s entrance
  // animation, inside withFullScreen below). withFullScreen only wires ITS OWN io.input
  // listener once it is actually called, which on an interactive run is many awaits
  // (a real Worker-backed preload, possibly a real onboarding prompt) after this
  // function starts -- so a listener wired only there misses everything typed before
  // it. Wire the SAME early-buffer contract here, at runSuperStart's true entry point,
  // so nothing typed between "the takeover appears" and "the watch is ready to listen"
  // is lost; withFullScreen replays this seed, IN ORDER, the moment its own first
  // onKey() subscriber wires up (same discipline as its own mid-takeover buffering).
  const earlySeed: { keys: string[]; quit: boolean } = { keys: [], quit: false };
  const earlyOnData = (d: Buffer): void => {
    const k = routeKey(d.toString("utf8"));
    if (k === null) return;
    if (k === "quit") {
      earlySeed.quit = true;
      return;
    }
    earlySeed.keys.push(k);
  };
  if (interactive) io.input?.on("data", earlyOnData);
  const detachEarly = (): void => {
    if (interactive) io.input?.off("data", earlyOnData);
  };
  // D23: one throttled/deduped tab-title writer for the whole run (preload's animated
  // pulse, the live watch's ticker mirror) — a single OSC 0 write stream, never two
  // independent throttle clocks racing each other. Non-TTY io is a no-op inside it.
  const writeTabTitle = createTitleWriter(io, Date.now);
  // Interactive runs preload through the worker (instant feedback, no dead cursor);
  // scripted runs keep the plain synchronous read — no spinner, no escape codes.
  const data = interactive ? await preloadData(io, opts.now, writeTabTitle) : readShowcaseData(opts.now);
  if (data.totalSessions === 0 && data.tokenTotal === 0) {
    detachEarly();
    io.write(`  ${EMPTY_STATE}\n`);
    return null;
  }

  if (!interactive) {
    for (const l of settledPlainText(data)) io.write(l + "\n");
    return null;
  }
  if (io.rows() < 24 || io.cols() < 80) {
    detachEarly();
    io.write(`  ${TOO_SMALL}\n`);
    for (const l of settledPlainText(data)) io.write(l + "\n");
    return null;
  }

  // Paired device + interactive full-screen = the watch ALSO submits to the board
  // (Marco 2026-07-16: "allow it to actually push"). The push is syncOnce VERBATIM —
  // per-thread digest gating, global Claude dedup, cursor advancement — the same
  // path `start` and the hooks use, so nothing can double-count. Unpaired devices
  // (and every non-interactive branch above) stay read-only: the demo needs no
  // account, and a scripted run must never write.
  let pushing = loadState().deviceToken !== null;
  // Tier B watch defaulting (D9 ruling, docs/context-capacity-plan.md Phase 6): an
  // explicit --limits (true OR false) always wins as the per-run override -- `??` only
  // falls through on undefined, so an explicit false is never masked by a persisted
  // true. Omitted opts.limits falls back to the persisted per-provider opt-in; both
  // absent -> false, today's default unchanged. D25a: this decision is re-evaluated
  // fresh every refresh cycle (see currentLimitsOptIn below, inside the live loop)
  // instead of being snapshotted once here -- a mid-run settings toggle must take
  // effect without a restart, so no watch-start const is captured for it anymore.
  // D20/D22: the persisted plan type + monthly budget, read once at watch start (same
  // discipline as the limits consent above) -- routes limitsPanelLines' mode composition
  // for the whole run; a mid-run Settings edit takes effect on the next watch, not live.
  let billingMode = loadState().billingMode;
  let monthlyBudgetUsd = loadState().monthlyBudgetUsd;
  // D22: month-to-date spend is the SAME corpus figure the ticker's own "SPENT
  // (ESTIMATE)" stat reads (data.spendTotalUsd) -- never a second, disagreeing number.
  // Absent when unpriced (never fabricate a $0 gauge for "we don't know").
  const budgetFor = (spendUsd: number | null): { spentUsd: number; budgetUsd: number } | undefined =>
    monthlyBudgetUsd !== undefined ? { spentUsd: spendUsd ?? 0, budgetUsd: monthlyBudgetUsd } : undefined;
  // Unpaired + interactive + hooks provided: offer onboarding BEFORE the full-screen
  // takeover — the question must not fight the alternate screen buffer (Marco
  // 2026-07-17 ruling). Decline stays read-only and is never re-asked this run; accept
  // runs the (reused) pairing flow, and only a SUCCESSFUL pair flips pushing true.
  // sim-report.md Finding 3: `pushing` alone can never distinguish "never asked" from
  // "asked and declined" (a decline never mints a deviceToken), so a declined device
  // was re-asked forever. `onboardedAt` is the enrollment-truth gate: presence alone
  // means "already asked" (not epoch-gated), so a returning unpaired device that was
  // already asked goes straight to the watch instead of being re-asked.
  if (!pushing && !loadState().onboardedAt && opts.askOnboarding) {
    const wantsBoard = await opts.askOnboarding();
    // Set ONCE regardless of the answer -- "asked" and "accepted" are different facts,
    // and only "asked" gates re-asking (declining must still record that this device
    // was asked, or a later run re-asks forever). markOnboarded patches exactly this
    // one field into the stored state -- a decline writes onboardedAt and nothing else
    // (the amended T7 pin, superStartOnboarding.test.ts).
    markOnboarded(opts.now ?? Date.now());
    if (wantsBoard) {
      pushing = opts.pairOnboarding ? await opts.pairOnboarding() : false;
      // D14 C1: the org-join question fires ONLY after a successful pair -- an
      // unpaired (or failed-pair) device has no account for a membership to attach
      // to. Runs BEFORE the billing question below (fix: D10's ordering).
      if (pushing && opts.askOrgJoin) {
        await opts.askOrgJoin();
      }
    }
    // Extracted from askOnboarding's own production implementation (D14): billing mode
    // is a local concept, independent of pairing, and is still asked exactly once per
    // onboarding pass regardless of the board accept/decline answer -- same timing
    // production always had, just sequenced explicitly here instead of nested inside
    // an opaque askOnboarding call.
    if (opts.askBillingMode) await opts.askBillingMode();
    // sim-report.md Finding 1: billingMode/monthlyBudgetUsd are WRITTEN from inside
    // the billing question (production's askSuperStartBillingMode) -- re-read them
    // fresh here so the SAME watch session renders them, instead of the stale
    // pre-onboarding snapshot that only the next run would ever see.
    billingMode = loadState().billingMode;
    monthlyBudgetUsd = loadState().monthlyBudgetUsd;
  }
  // The field bug (root-caused 2026-07-20): a stale npx cache silently ran an old build
  // for days. checkUpdate is opt.-injected (see SuperStartOptions) — omitted (every
  // existing test) means "" and zero network, exactly like limitsFetchImpl's discipline.
  const updateBanner = opts.checkUpdate ? staleVersionBanner({ running: TRACKER_VERSION, latest: await opts.checkUpdate() }) : "";
  let fatal: string | null = null;
  let deploymentCard: string[] = []; // the Strava-style recap — composed at quit, printed after restore
  const watchStartedAt = Date.now();
  // retired: the v1 exit-and-launch handback (was: set by ⏎; run by the caller AFTER restore
  // D23: the entrance still carries no delta — a settled wordmark until the live loop
  // below starts feeding real ticker numbers into the same throttled writer.
  writeTabTitle(composeTabTitle({ phase: "live" }));
  detachEarly(); // withFullScreen wires its own listener next, seeded with earlySeed below
  await withFullScreen(io, async (ctx) => {
    let current = data;
    let live: LiveInfo | undefined;
    let lastP = 0;
    // The marquee's clock: one cell every TICKER_STEP_MS, continuous across both acts.
    const tickerStarted = Date.now();
    const shift = (): number => Math.floor((Date.now() - tickerStarted) / TICKER_STEP_MS);
    const paintWatch = (): void => {
      const lines = composeScreen(current, { rows: io.rows(), cols: io.cols() }, lastP, live, shift());
      io.write("[H" + lines.map((l, i) => `[${i + 1};1H` + l).join(""));
    };
    // D16 view mux: the watch keeps its painter untouched; the output/settings panes
    // render full-frame padded lines. Crossing views clears once so no stale cells
    // survive the layout change; same-view repaints overwrite in place.
    let paintedView: "watch" | "output" | "settings" = shell.view;
    let paneTitle = "output";
    const paint = (): void => {
      const size = { rows: io.rows(), cols: io.cols() };
      if (shell.view !== paintedView) {
        io.write("\x1b[2J");
        paintedView = shell.view;
      }
      if (shell.view === "output") {
        io.write("\x1b[H" + composeOutputPane(shell, size, paneTitle).map((l, i) => `\x1b[${i + 1};1H` + l).join(""));
        return;
      }
      if (shell.view === "settings") {
        io.write("\x1b[H" + composeSettingsPane(shell, loadState(), size).map((l, i) => `\x1b[${i + 1};1H` + l).join(""));
        return;
      }
      paintWatch();
    };
    const unsub = io.onResize?.(() => {
      io.write("[2J"); // a shrink leaves stale cells beyond the new frame
      paint();
    });
    try {
      // Act I: the entrance — everything races in and lands EXACTLY on the real figures.
      const started = Date.now();
      while (!ctx.quitRequested() && Date.now() - started < ANIMATE_MS) {
        lastP = Math.min(1, (Date.now() - started) / ANIMATE_MS);
        paint();
        await sleep(FRAME_MS);
      }
      lastP = 1;
      paint();

      // Act II: the live watch. The scan (syncOnce push + corpus re-read) runs in a
      // WORKER THREAD so this loop never blocks — the marquee keeps rolling and the
      // footer seconds keep counting straight through a 1–3s scan (the on-screen
      // pause Marco caught on the first live recording). One scan in flight at a
      // time; its result lands on a later beat of this same loop.
      // First scan fires immediately after settle (lastScanAt = 0): a paired device
      // submits its backlog right away, exactly like `start`'s first monitor pass.
      let lastScanAt = pushing ? 0 : Date.now();
      // The ticker accumulates SINCE THE WATCH BEGAN — a clip shows the number climbing,
      // and every increment is the difference between two real corpus readings.
      let cumTok = 0;
      let cumSpend = 0;
      let note: string | undefined;
      // Per-session baseline: every live bar is (session's tokens now) minus (its
      // tokens when the watch began) — a diff of two real folds, so a bar can only
      // grow from usage that actually happened on camera.
      const baseline = new Map(data.sessions.map((s) => [s.key, s.tokens]));
      const baselineTurns = new Map(data.sessions.map((s) => [s.key, s.turns ?? 0]));
      // Deployment recap accumulator — every figure an on-camera measurement.
      const dep = {
        burns: [] as number[],
        peakAgents: 0,
        harnesses: new Set<string>(),
        peakCtx: new Map<string, { pct: number; inferred: boolean }>(),
        // Per-repoLabel active ms for the deployment card's threads line. Nothing here
        // pins an exact "active" measurement (session start/end straddling the watch,
        // idle gaps mid-session, …), so this uses the simplest honest proxy: time
        // since the watch began, recorded only while the thread has actually burned
        // tokens on camera. A thread that stops burning keeps its last-recorded value.
        threadMs: new Map<string, number>(),
      };
      const probeCache = newProbeCache();
      // Second zero (Marco 2026-07-17): sessions the probe already sees stand on the
      // chart at 0 immediately — with their context % — instead of an empty region
      // waiting on the first fold. Every bar still only GROWS from on-camera usage.
      let liveSessions: LiveSession[] = liveSessionsFrom(data.sessions, baseline, {
        activeHarnesses: probeActivity(probeCache, Date.now()).activeHarnesses,
        nowMs: Date.now(),
      });
      let fingerprint = "";
      let corpusChangedAt = 0;
      let beat = 0;
      // Tier B (--limits, Marco's opt-in ruling): one read-only fetch of the
      // vendor-reported Claude lanes at watch start, refreshed every 5 minutes.
      // Failures render as a quiet note on the limits page; nothing ever blocks
      // the beat (the promise lands between frames like a scan result).
      let claudeLanes: LiveInfo["claudeLanes"];
      let claudeNote: string | undefined;
      let lanesFetchedAt = 0;
      const LANES_REFRESH_MS = 5 * 60_000;
      // D25a: re-read persisted consent fresh every cycle instead of closing over the
      // watch-start `limitsOptIn` const — an explicit --limits flag (true OR false)
      // still wins for the whole run (resolveLimitsConsent's own `??` never falls
      // through on an explicit false), so a mid-run settings toggle can only ever
      // move the persisted half of that decision table, exactly like at watch start.
      const currentLimitsOptIn = (): boolean => resolveLimitsConsent(opts.limits, loadState().limitsProviders?.claude);
      const maybeFetchLanes = (): void => {
        if (!currentLimitsOptIn()) {
          // Consent revoked (or never given yet) — clear whatever's showing so the
          // very next frame reflects it, and forget the last fetch time so a later
          // re-consent fetches immediately instead of waiting out LANES_REFRESH_MS.
          claudeLanes = undefined;
          claudeNote = undefined;
          // `live` is only recomposed on the beat; a keypress paint between beats
          // (Escape straight back to the watch after the toggle) reads the LAST
          // composed snapshot — strip the lanes from it too, or that one stale
          // frame still renders them after revocation.
          if (live) live = { ...live, claudeLanes: undefined, claudeNote: undefined };
          lanesFetchedAt = 0;
          return;
        }
        if (Date.now() - lanesFetchedAt < LANES_REFRESH_MS) return;
        lanesFetchedAt = Date.now();
        void fetchClaudeLimits({ optedIn: true, credPath: claudeCredentialsPath(), fetchImpl: opts.limitsFetchImpl ?? fetch, nowMs: Date.now() }).then((r) => {
          // A slow response racing a consent flip-off must not resurrect the lanes:
          // consent is re-checked at landing time, same source of truth as the gate.
          if (!currentLimitsOptIn()) return;
          if (r.ok) {
            claudeLanes = r.lanes;
            claudeNote = undefined;
          } else {
            claudeNote =
              r.reason === "token-expired"
                ? "claude: unavailable — token expired, run `claude` to log in"
                : `claude: unavailable (${r.reason})`;
          }
        });
      };
      maybeFetchLanes();
      // Page-entry clock: limits bars ease-fill over ~600ms after an arrow press.
      let pageSwitchedAt = Date.now();
      // Chart view: auto until the user touches an arrow, then pinned to their choice
      // (an auto-flip mid-demo, right after someone chose a view, would read as a bug).
      // The pinned value lives in shell.chartView; chartAuto is the untouched marker.
      let chartAuto = true;
      const resolveView = (): "live" | "spend" | "limits" =>
        chartAuto ? (liveSessions.length > 0 ? "live" : "spend") : shell.chartView;
      // D16 integration: keys route through the pure shell reducer. Settings rows get
      // settingsStep (persisting via saveState); a requested action runs IN-APP via the
      // child-process capture, its output delivered by shellReceiveOutput. Only q and
      // Ctrl-C (handled at the withFullScreen layer) leave the app.
      let actionInFlight = false;
      const runAction = (action: SuperStartAction): void => {
        if (actionInFlight) return;
        actionInFlight = true;
        paneTitle = `deploy-forward ${action.label}`;
        void captureActionOutput(action, { rows: io.rows(), cols: io.cols() }).then((result) => {
          actionInFlight = false;
          shell = shellReceiveOutput(shell, result);
          paint();
        });
      };
      ctx.onKey((k) => {
        const key = k as ShellKey; // routeKey emits only ShellKey tokens ("quit" never reaches handlers)
        if (shell.view === "settings" && (key === "up" || key === "down" || key === "enter")) {
          const r = settingsStep(shell, key, { trackerState: loadState(), persist: saveState });
          shell = r.state;
          // D25a: react to a Limits consent toggle on THIS keypress, not the next 60ms
          // beat -- an "enter" that just persisted a consent flip must clear (or start
          // fetching) before the very next paint, never one stale frame behind it.
          maybeFetchLanes();
          paint();
          return;
        }
        if (shell.view === "watch" && (key === "left" || key === "right")) {
          // Preserve auto-until-touched: pin to the RESOLVED view before stepping, so
          // nextChartView cycles from what is actually on screen.
          if (chartAuto) {
            shell = { ...shell, chartView: resolveView() };
            chartAuto = false;
          }
          pageSwitchedAt = Date.now();
        }
        const had = shell.pendingAction;
        shell = shellStep(shell, key);
        if (shell.pendingAction && shell.pendingAction !== had) runAction(shell.pendingAction);
        paint(); // respond to the keypress now, not on the next beat
      });
      // Held in ONE object: the worker callbacks assign these, and TS's control-flow
      // analysis can't see closure assignments on bare lets (it would narrow the
      // result to `never` at the read site); property reads re-widen after awaits.
      const scan: { result: { ok: boolean; data?: ShowcaseData; error?: string } | null; inFlight: boolean; startedAt: number } = {
        result: null,
        inFlight: false,
        startedAt: 0,
      };
      const startScan = (): void => {
        scan.inFlight = true;
        scan.startedAt = Date.now();
        try {
          // dist ships .js; dev (tsx) has only the .ts sibling — the inherited
          // execArgv (--import tsx) lets the worker load it.
          const jsEntry = new URL("./superStartScan.js", import.meta.url);
          const entry = existsSync(fileURLToPath(jsEntry)) ? jsEntry : new URL("./superStartScan.ts", import.meta.url);
          const worker = new Worker(entry, { workerData: { push: pushing } });
          worker.once("message", (msg: { ok: boolean; data?: ShowcaseData; error?: string }) => {
            scan.result = msg;
          });
          worker.once("error", (e: Error) => {
            scan.result = { ok: false, error: e.message };
          });
          worker.unref(); // a quit mid-scan must not hold the process open
        } catch (e) {
          scan.result = { ok: false, error: (e as Error).message };
        }
      };
      // The ticker starts at an honest $0 with the detected sessions already standing
      // (Marco 2026-07-17: "start with $0, or $x of current sessions detected").
      // menuIndex/chartView are included here (same as every per-beat `live` below) so
      // this FIRST Act II paint -- which runs unconditionally, before the while loop
      // even checks quitRequested() -- already reflects any menu navigation replayed
      // from the sim-report.md Finding 2 early-key buffer above. Without them, a menu
      // move that landed only via the early-buffer replay (ctx.onKey, just above) stayed
      // invisible until the loop's first tick -- a tick a quit racing in early could skip
      // entirely, silently dropping the very state the replay just set.
      live = {
        scanAgoS: 0,
        nextInS: Math.round(REFRESH_MS / 1000),
        pushing,
        delta: { tokens: 0, spendUsd: 0 },
        sessions: liveSessions,
        chartView: resolveView(),
        menuIndex: shell.menuIndex,
        redact: opts.redact,
        billingMode,
        budget: budgetFor(current.spendTotalUsd),
        updateBanner,
      };
      writeTabTitle(composeTabTitle({ phase: "live", delta: live.delta }));
      paint();
      while (!ctx.quitRequested()) {
        // TICKER_STEP_MS beat: the marquee rolls continuously, scans or not.
        await Promise.race([sleep(TICKER_STEP_MS), ctx.waitForQuit()]);
        if (ctx.quitRequested()) break;
        const now = Date.now();
        beat++;

        // Stat-only probe: no parsing, so it can run on this thread every beat.
        const probe = probeActivity(probeCache, now);
        if (probe.fingerprint !== fingerprint) {
          fingerprint = probe.fingerprint;
          corpusChangedAt = now; // an agent just wrote — fold once the burst settles
        }

        if (scan.result) {
          const result = scan.result;
          scan.result = null;
          scan.inFlight = false;
          lastScanAt = Date.now();
          if (!result.ok) {
            const msg = result.error ?? "scan failed";
            if (msg === "token_revoked" || msg === "not_paired" || msg === "account_deleted") {
              fatal = msg;
              break; // user action required — leave the takeover cleanly and say so below
            }
            note = "sync failed — retrying"; // transient: keep watching, nothing is lost
          } else if (result.data) {
            note = undefined;
            const fresh = result.data;
            const dTok = fresh.tokenTotal - current.tokenTotal;
            const dSpend =
              fresh.spendTotalUsd !== null && current.spendTotalUsd !== null ? fresh.spendTotalUsd - current.spendTotalUsd : null;
            if (dTok > 0) {
              cumTok += dTok;
              if (dSpend !== null && dSpend > 0) cumSpend += dSpend;
              dep.burns.push(Math.max(0, dTok));
              // Tick old -> new: every intermediate frame interpolates between two
              // REAL readings, and the loop lands on the fresh figures exactly.
              const fromTok = current.tokenTotal;
              const fromSpend = current.spendTotalUsd;
              live = { scanAgoS: 0, nextInS: Math.round(REFRESH_MS / 1000), pushing, note, delta: { tokens: cumTok, spendUsd: cumSpend > 0 ? cumSpend : null }, billingMode, budget: budgetFor(fromSpend), updateBanner };
              for (let f = 1; f <= TICK_FRAMES && !ctx.quitRequested(); f++) {
                const e = easeOutCubic(f / TICK_FRAMES);
                current = {
                  ...fresh,
                  tokenTotal: Math.round(fromTok + dTok * e),
                  spendTotalUsd: fresh.spendTotalUsd !== null && fromSpend !== null && dSpend !== null ? fromSpend + dSpend * e : fresh.spendTotalUsd,
                };
                paint();
                await sleep(FRAME_MS);
              }
            }
            // Per-session deltas: what each session burned SINCE the watch began.
            liveSessions = liveSessionsFrom(fresh.sessions, baseline, {
              activeHarnesses: probe.activeHarnesses,
              nowMs: Date.now(),
            });
            dep.peakAgents = Math.max(dep.peakAgents, liveSessions.length);
            for (const h of probe.activeHarnesses) dep.harnesses.add(h);
            for (const ls of liveSessions) {
              if (ls.ctx) {
                const prev = dep.peakCtx.get(ls.label);
                if (!prev || ls.ctx.pct > prev.pct) dep.peakCtx.set(ls.label, ls.ctx);
              }
              if (ls.repoLabel && ls.tokens > 0) dep.threadMs.set(ls.repoLabel, Date.now() - watchStartedAt);
            }
            current = fresh; // exact landing, always
          }
        } else if (!scan.inFlight) {
          // Fold when the corpus moved (scanDue: settled burst, or SUSTAINED writing
          // past the bound) — or when the fallback clock expires (harnesses the
          // probe can't see move).
          if (scanDue(now, corpusChangedAt, lastScanAt) || now - lastScanAt >= REFRESH_MS) startScan();
        }
        maybeFetchLanes();

        live = scan.inFlight
          ? { scanAgoS: Math.round((Date.now() - scan.startedAt) / 1000), nextInS: 0, scanning: true, pushing, note, delta: live?.delta, activeHarnesses: probe.activeHarnesses, sessions: liveSessions, chartView: resolveView(), menuIndex: shell.menuIndex, beat, claudeLanes, claudeNote, pageP: Math.min(1, (Date.now() - pageSwitchedAt) / 600), redact: opts.redact, billingMode, budget: budgetFor(current.spendTotalUsd), updateBanner }
          : {
              scanAgoS: Math.round((Date.now() - lastScanAt) / 1000),
              nextInS: Math.max(0, Math.round((REFRESH_MS - (Date.now() - lastScanAt)) / 1000)),
              pushing,
              note,
              delta: live?.delta,
              activeHarnesses: probe.activeHarnesses,
              sessions: liveSessions,
              chartView: resolveView(),
              menuIndex: shell.menuIndex,
              beat,
              claudeLanes,
              claudeNote,
              pageP: Math.min(1, (Date.now() - pageSwitchedAt) / 600),
              redact: opts.redact,
              billingMode,
              budget: budgetFor(current.spendTotalUsd),
              updateBanner,
            };
        // D23: the tab mirrors the running ticker EVERY beat — a backgrounded terminal
        // still shows the count climbing (the Grok-tab pattern). writeTabTitle owns its
        // own 500ms throttle + dedup, so this is cheap even at the marquee's ~60ms beat.
        writeTabTitle(composeTabTitle({ phase: "live", delta: live.delta }));
        paint();
      }
      // The deployment card composes HERE (final fold state in scope); it prints
      // after the takeover restores the terminal, into real scrollback.
      const byModel = new Map<string, number>();
      for (const ls of liveSessions) if (ls.tokens > 0) byModel.set(ls.label, (byModel.get(ls.label) ?? 0) + ls.tokens);
      const onCameraTurns = current.sessions.reduce((sum, cs) => sum + Math.max(0, (cs.turns ?? 0) - (baselineTurns.get(cs.key) ?? 0)), 0);
      deploymentCard = composeDeploymentCard(
        {
          startedAtMs: watchStartedAt,
          endedAtMs: Date.now(),
          tokens: cumTok,
          spendUsd: cumSpend > 0 ? cumSpend : null,
          turns: onCameraTurns,
          peakAgents: dep.peakAgents,
          harnesses: [...dep.harnesses],
          models: [...byModel.entries()].map(([label, tokens]) => ({ label, tokens })).sort((a, b) => b.tokens - a.tokens),
          burns: dep.burns,
          peakCtx: [...dep.peakCtx.entries()].map(([label, v]) => ({ label, ...v })),
          threads: [...dep.threadMs.entries()].map(([repoLabel, ms]) => ({ repoLabel, ms })).sort((a, b) => b.ms - a.ms),
        },
        { redact: opts.redact },
      );
    } finally {
      unsub?.();
    }
  }, routeKey, earlySeed);

  // D23: exit ALWAYS ends the OSC trail with the 9;4 progress clear, then a plain
  // title reset — in that order, unconditionally, regardless of what phase (loading /
  // live / settled) the watch was in when quit landed. This bypasses writeTabTitle's
  // throttle/dedup on purpose: a live ticker title (or a stale determinate progress
  // state) must never be the last thing left in a closed tab, even on a near-instant
  // quit that lands inside the 500ms window of the last throttled write.
  io.write(composeProgressOsc(null));
  setTitle(io, "deploy-forward"); // never leave a stale "live" title on a closed watch

  // The recap prints into restored scrollback — screenshot-ready, never inside the
  // alternate screen (which vanishes on quit). A fatal auth exit gets no trophy.
  if (fatal === null) for (const l of deploymentCard) io.write(`${l}\n`);

  // Fatal auth states surface AFTER the terminal is restored — the same user-action
  // messages the monitor prints, never swallowed by the takeover.
  if (fatal === "token_revoked" || fatal === "not_paired") {
    io.write(`  This device is no longer authorized (${fatal === "token_revoked" ? "its token was revoked" : "not signed in"}).\n`);
    io.write("  Run `npx --yes deploy-forward@latest` to re-authenticate, then start again.\n");
    process.exitCode = 1;
  } else if (fatal === "account_deleted") {
    io.write("  This account has a pending deletion — sync is paused. Run `npx --yes deploy-forward@latest restore` to cancel it.\n");
    process.exitCode = 1;
  }
  // The terminal is restored by now, so the caller's command prints into real scrollback.
  // D16: nothing is handed back ? every launcher command already ran in-app. The
  // return type is kept for API stability; it is always null now.
  return null;
}
