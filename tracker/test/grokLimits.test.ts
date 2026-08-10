/**
 * LANE — Grok weekly credits ("Grok limits"), test-first (Marco's 2026-07-19 research
 * findings on the official Grok CLI's disk-side billing poll — no committed doc file
 * yet; the shape below is captured verbatim from that research, same status as a
 * pre-doc spec the way D20-D22 landed in billingModes.test.ts before context-capacity-
 * plan.md caught up).
 *
 * SPEC (corpus-CORRECTED 2026-07-19 against the real ~/.grok/logs/unified.jsonl —
 * 199 real billing lines; two details of the original research spec were falsified
 * and are fixed here):
 *   The official Grok CLI logs its own billing polls into the SAME file grok.ts's
 *   token-capture already reads, ~/.grok/logs/unified.jsonl (see grokUnifiedLogPath /
 *   grokHome, both already exported), as lines with msg == "billing: fetched credits
 *   config". ctx.config carries:
 *     - creditUsagePercent: float 0-100, SOMETIMES ABSENT
 *     - currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end (ISO) }
 *     - onDemandUsed / onDemandCap / prepaidBalance: { val: number } (zero-observed)
 *   CORPUS CORRECTION #1 — tier location: in EVERY real line, subscriptionTier sits at
 *   ctx.subscriptionTier (a SIBLING of ctx.config), NOT inside ctx.config as the
 *   original research spec claimed. The parser must read ctx.subscriptionTier
 *   primarily, with ctx.config.subscriptionTier accepted as a defensive FALLBACK only
 *   (this is an undocumented shape; the field may move again).
 *   CORPUS CORRECTION #2 — tier nullability: tier is string | null and NEVER a
 *   validity gate. A line carrying a percent but no tier anywhere still counts (tier:
 *   null); only the period triple + a parseable ts gate a line's well-formedness.
 *   A REAL sample line (lifted verbatim from the corpus research) is pinned below as
 *   REAL_SAMPLE_LINE — the original caveat ("fixtures constructed, not verified")
 *   is now closed for the happy path; hand-built fixtures remain for the edge cases
 *   the corpus does not exhibit.
 *
 * THE SEAMS THIS SUITE PINS (none exist yet — intentional, controlled red):
 *
 *   1. src/grok.ts grows THREE new exports (chosen seam: same file as the existing
 *      token-capture, because both read the identical unified.jsonl and share
 *      grokHome()/grokUnifiedLogPath() — a sibling grokLimits.ts would just re-import
 *      those two path helpers for no separation benefit). Namespace-imported below
 *      (`import * as GR from "../src/grok.ts"`) for the same reason billingModes.test.ts
 *      namespace-imports superStart.ts: grok.ts ALREADY EXISTS today, so a missing
 *      named export resolves to `undefined` at the property read — a clean per-test
 *      TypeError/assertion red, never a module-load crash that would take out
 *      test/grok.test.ts's real (green, 601-baseline) suite in the same run.
 *
 *        export interface GrokCredits {
 *          percent: number | null;       // creditUsagePercent, or null if the line omitted it
 *          periodType: string | null;    // currentPeriod.type, verbatim
 *          periodStart: string | null;   // currentPeriod.start, verbatim ISO
 *          periodEnd: string | null;     // currentPeriod.end, verbatim ISO -- the reset instant
 *          tier: string | null;          // ctx.subscriptionTier (fallback: ctx.config.subscriptionTier);
 *                                        // null when absent everywhere -- NEVER a validity gate
 *          observedAt: number;           // the line's own `ts`, parsed to epoch ms
 *        }
 *
 *        parseLatestGrokCredits(content: string): GrokCredits | null
 *          PURE. Takes raw file content (a string), never a path -- by construction it
 *          cannot make a network call and cannot open any file, auth.json included
 *          (see the invariant tests below). Splits on lines, pre-filters on the msg
 *          marker, JSON.parse per line inside try/catch (one bad line never aborts the
 *          scan -- same discipline as scanGrokInferences). A line counts as
 *          "well-formed" only when periodType + periodStart + periodEnd are ALL present
 *          as strings and `ts` parses to a finite epoch -- creditUsagePercent AND tier
 *          are BOTH allowed to degrade to null (a line missing only those still yields
 *          a returned, non-null GrokCredits; corpus corrections #1/#2 above). tier is
 *          read from ctx.subscriptionTier first, ctx.config.subscriptionTier as the
 *          defensive fallback. The LAST well-formed line in
 *          file order wins (same "cumulative log, last wins" reading as
 *          parseLatestCodexRateLimits in usageView.ts). No well-formed line anywhere
 *          (including an empty/no-billing-lines file) -> null, never a guess.
 *
 *        readLatestGrokCredits(home: string = grokHome()): GrokCredits | null
 *          Thin disk wrapper: reads grokUnifiedLogPath(home) (the ONE path it ever
 *          touches -- never auth.json, never any other file under home), missing/
 *          unreadable file -> null (fail soft, same as readLatestCodexRateLimits),
 *          otherwise delegates to parseLatestGrokCredits.
 *
 *   2. src/superStart.ts's limitsPanelLines grows ONE new opt (same file/function
 *      billingModes.test.ts already extended for D20-D22 -- namespace-imported as `SS`
 *      below, same crash-isolation reasoning as #1):
 *
 *        grokCredits?: GrokCredits | null
 *
 *      Rendering contract this suite pins (design chosen here, since the task spec left
 *      exact styling open -- "pin presence of a distinguishable state, not exact
 *      styling", same latitude billingModes.test.ts used for budgetGaugeLines):
 *        - grokCredits null/undefined -> NO "GROK" row renders at all (honest absence,
 *          nothing invented -- mirrors the CODEX "not reported" line's philosophy but
 *          for Grok there isn't even a placeholder line, because unlike Codex's
 *          always-present rollout, an unopted-in or never-polled Grok CLI has emitted
 *          NOTHING for us to even label "not reported").
 *        - percent present -> one row containing the literal lane name "GROK WEEKLY"
 *          (fixed name, same convention as "CODEX WEEKLY"/"CLAUDE WEEKLY" -- NOT derived
 *          from periodType, a deliberate simplification flagged for the impl agent),
 *          a healthBar-style bar (via the same `bar()` closure the Claude/Codex rows
 *          use), the exact substring "<round(percent)>% used", a reset clause derived
 *          from periodEnd via the SAME resetIn() helper the other lanes use ("resets in
 *          ..."), the substring "vendor-reported", and the tier string verbatim. When
 *          tier is null the row simply OMITS the tier label (never a literal "null" --
 *          the naive-interpolation failure); everything else renders unchanged.
 *        - percent null -> the row STILL renders (degrade, never drop) but carries NO
 *          bar glyph (zero "█") and NO "% used" substring -- period/reset + tier only.
 *        - staleness: when `(opts.nowMs ?? Date.now()) - grokCredits.observedAt > 30 *
 *          60_000` (strictly over 30 minutes), the row appends a substring matching
 *          `/as of \d{2}:\d{2}/` (localHHMM(observedAt), the same clock-time format
 *          THREAD rows already use); fresh data carries no such marker. This is a
 *          RENDER-time judgment only -- parseLatestGrokCredits itself never touches
 *          staleness, it only ever reports observedAt verbatim (pinned in #1).
 *        - mode routing (D21/D22, same override the CLAUDE/CODEX lanes already obey,
 *          per billingModes.test.ts #4): the GROK row lives inside the SAME
 *          `billingMode !== "api"` guard as every other provider lane. billingMode
 *          undefined/"subscription"/"mix" -> GROK renders when grokCredits is supplied;
 *          billingMode "api" -> suppressed outright, even with real grokCredits data
 *          (nothing is provisioned for an API-only user -- the hard override).
 *
 * Run: npx tsx --test test/grokLimits.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShowcaseData } from "../src/superStart.ts";
// Namespace imports for the not-yet-existing seams: grok.ts and superStart.ts both
// ALREADY EXIST today, so a missing named export resolves to `undefined` at the
// property read (a clean per-test TypeError/assertion red) rather than a module-load
// SyntaxError that would kill every other suite sharing this test run -- same
// discipline as test/billingModes.test.ts and test/onboardingV2.test.ts.
import * as GR from "../src/grok.ts";
import * as SS from "../src/superStart.ts";

// ============================================================================================
// fixtures / helpers
// ============================================================================================

/** One "billing: fetched credits config" line, shaped per the corpus-verified SPEC
 * above: subscriptionTier at ctx level (sibling of ctx.config), NEVER inside config
 * (the falsified original shape). `percent` omitted (not just undefined) simulates the
 * vendor's "SOMETIMES ABSENT" field; `tier: null` omits the tier EVERYWHERE (corpus
 * correction #2's no-tier-anywhere case); `tierInConfigOnly` builds the falsified
 * legacy shape for the defensive-fallback pin. */
function billingLine(opts: {
  ts: string;
  percent?: number;
  periodType?: string;
  periodStart?: string;
  periodEnd?: string;
  tier?: string | null;
  tierInConfigOnly?: boolean;
}): string {
  const config: Record<string, unknown> = {
    currentPeriod: {
      type: opts.periodType ?? "USAGE_PERIOD_TYPE_WEEKLY",
      start: opts.periodStart ?? "2026-07-14T00:00:00.000Z",
      end: opts.periodEnd ?? "2026-07-21T00:00:00.000Z",
    },
    onDemandUsed: { val: 0 },
    onDemandCap: { val: 0 },
    prepaidBalance: { val: 0 },
  };
  if (opts.percent !== undefined) config.creditUsagePercent = opts.percent;
  const ctx: Record<string, unknown> = { config };
  const tier = opts.tier === undefined ? "SuperGrok" : opts.tier;
  if (tier !== null) {
    if (opts.tierInConfigOnly) config.subscriptionTier = tier;
    else ctx.subscriptionTier = tier; // the REAL location, every one of the 199 corpus lines
  }
  return JSON.stringify({ ts: opts.ts, src: "shell", pid: 1, lvl: "info", msg: "billing: fetched credits config", ctx });
}

/** Lifted VERBATIM from the 2026-07-19 corpus research sample (one of the 199 real
 * billing lines) -- note subscriptionTier at ctx level, sibling of ctx.config. */
const REAL_SAMPLE_LINE =
  '{"ts":"2026-07-13T23:44:28.439Z","src":"shell","pid":45352,"lvl":"info","msg":"billing: fetched credits config","ctx":{"config":{"creditUsagePercent":59.0,"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-07-10T06:55:23.932662+00:00","end":"2026-07-17T06:55:23.932662+00:00"},"onDemandCap":{"val":0},"onDemandUsed":{"val":0},"prepaidBalance":{"val":0},"isUnifiedBillingUser":true,"billingPeriodStart":"2026-07-10T06:55:23.932662+00:00","billingPeriodEnd":"2026-07-17T06:55:23.932662+00:00","historyLen":0},"onDemandEnabled":null,"subscriptionTier":"SuperGrok"}}';

/** A real Grok token-accounting line (grok.test.ts's own shape) -- the interleaved
 * "noise" a billing-line scan must ignore, mirroring extractGrokInferences' fixtures. */
function tokenLine(ts: string, sid = "sid-x"): string {
  return JSON.stringify({
    ts, src: "shell", pid: 1, lvl: "info", sid,
    msg: "shell.turn.inference_done",
    ctx: { loop_index: 1, prompt_tokens: 100, cached_prompt_tokens: 0, completion_tokens: 10, reasoning_tokens: 0 },
  });
}

const GROK_CREDITS_FRESH = {
  percent: 41,
  periodType: "USAGE_PERIOD_TYPE_WEEKLY",
  periodStart: "2026-07-14T00:00:00.000Z",
  periodEnd: "2026-07-21T00:00:00.000Z",
  tier: "SuperGrok",
  observedAt: Date.parse("2026-07-19T09:55:00.000Z"),
};

function minimalData(overrides: Partial<ShowcaseData> = {}): ShowcaseData {
  return {
    harnesses: [{ name: "Claude Code", sessions: 1 }],
    totalSessions: 1,
    tokenTotal: 1_000_000,
    modelRows: [{ model: "claude-opus-4-8", input: 100, output: 50, cacheRead: 0, cacheCreation: 0, total: 150 }],
    sessions: [],
    spendTotalUsd: 1.23,
    spendIsPartial: false,
    activeHours: 10,
    days: [],
    spend30dUsd: null,
    codexLimits: null,
    claude5h: null,
    grokCredits: null,
    ...overrides,
  } as ShowcaseData;
}

const CLAUDE_LANES = [{ kind: "session", percent: 41, resetsAt: null, scopeLabel: null }];
const CODEX_LIMITS = { primary: { usedPercent: 2, windowMinutes: 300, resetsInSeconds: 8671 * 60 }, secondary: null };

/** The single row (if any) carrying the GROK lane -- operating on the raw line array,
 * never a joined string, so a substring match can never bleed across rows. */
function grokRow(lines: string[]): string | undefined {
  return lines.find((l) => l.includes("GROK"));
}

function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "df-grok-limits-home-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ============================================================================================
// 1. parseLatestGrokCredits -- pure parser
// ============================================================================================

test("parseLatestGrokCredits: the most-recent well-formed billing line wins; interleaved token-accounting lines are ignored", () => {
  const content = [
    billingLine({ ts: "2026-07-19T09:00:00.000Z", percent: 10 }),
    tokenLine("2026-07-19T09:05:00.000Z"),
    tokenLine("2026-07-19T09:07:00.000Z"),
    billingLine({ ts: "2026-07-19T09:10:00.000Z", percent: 41.5 }),
    tokenLine("2026-07-19T09:15:00.000Z"),
  ].join("\n");
  const out = GR.parseLatestGrokCredits(content);
  assert.ok(out, "a well-formed billing line must parse");
  assert.equal(out!.percent, 41.5, "the LATEST billing line wins, not the first");
  assert.equal(out!.observedAt, Date.parse("2026-07-19T09:10:00.000Z"));
});

test("parseLatestGrokCredits: creditUsagePercent absent -> percent:null, period + tier still known (degrade, never drop)", () => {
  const content = billingLine({ ts: "2026-07-19T09:00:00.000Z", tier: "SuperGrok" }); // percent omitted entirely
  const out = GR.parseLatestGrokCredits(content);
  assert.ok(out, "a line missing only creditUsagePercent must still parse and be returned");
  assert.equal(out!.percent, null);
  assert.equal(out!.periodType, "USAGE_PERIOD_TYPE_WEEKLY");
  assert.equal(out!.periodEnd, "2026-07-21T00:00:00.000Z");
  assert.equal(out!.tier, "SuperGrok");
});

test("parseLatestGrokCredits: a non-finite/non-numeric creditUsagePercent also degrades to null, never a coerced garbage number", () => {
  const line = JSON.stringify({
    ts: "2026-07-19T09:00:00.000Z",
    msg: "billing: fetched credits config",
    ctx: { config: { creditUsagePercent: "not-a-number", currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "s", end: "e" } }, subscriptionTier: "SuperGrok" },
  });
  const out = GR.parseLatestGrokCredits(line);
  assert.ok(out);
  assert.equal(out!.percent, null);
});

test("parseLatestGrokCredits: the VERBATIM corpus sample line parses -- percent 59, weekly period, tier SuperGrok read from ctx level", () => {
  const out = GR.parseLatestGrokCredits(REAL_SAMPLE_LINE);
  assert.ok(out, "the real captured line must parse -- this is the ground-truth fixture");
  assert.equal(out!.percent, 59);
  assert.equal(out!.periodType, "USAGE_PERIOD_TYPE_WEEKLY");
  assert.equal(out!.periodStart, "2026-07-10T06:55:23.932662+00:00");
  assert.equal(out!.periodEnd, "2026-07-17T06:55:23.932662+00:00", "periodEnd carried verbatim -- the reset instant");
  assert.equal(out!.tier, "SuperGrok", "tier read from ctx.subscriptionTier -- the corpus-verified location");
  assert.equal(out!.observedAt, Date.parse("2026-07-13T23:44:28.439Z"));
});

test("parseLatestGrokCredits: tier reads ctx.subscriptionTier primarily, ctx.config.subscriptionTier as the defensive fallback", () => {
  // Primary (the real shape): ctx-level tier.
  const primary = GR.parseLatestGrokCredits(billingLine({ ts: "2026-07-19T09:00:00.000Z", percent: 10, tier: "SuperGrok" }));
  assert.ok(primary);
  assert.equal(primary!.tier, "SuperGrok");
  // Fallback (the falsified original shape, kept as defense -- this undocumented field
  // may move again): config-level tier only.
  const fallback = GR.parseLatestGrokCredits(billingLine({ ts: "2026-07-19T09:00:00.000Z", percent: 10, tier: "SuperGrokFallback", tierInConfigOnly: true }));
  assert.ok(fallback, "a config-level-only tier line must still parse");
  assert.equal(fallback!.tier, "SuperGrokFallback");
  // Both present -> ctx level wins (primary beats fallback). Hand-built: tier in BOTH spots.
  const both = JSON.stringify({
    ts: "2026-07-19T09:00:00.000Z",
    msg: "billing: fetched credits config",
    ctx: { subscriptionTier: "CtxTier", config: { subscriptionTier: "ConfigTier", creditUsagePercent: 10, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "s", end: "e" } } },
  });
  assert.equal(GR.parseLatestGrokCredits(both)!.tier, "CtxTier", "ctx.subscriptionTier is primary when both are present");
});

test("parseLatestGrokCredits: no tier ANYWHERE -> the line still counts with tier:null -- tier is NEVER a validity gate", () => {
  const out = GR.parseLatestGrokCredits(billingLine({ ts: "2026-07-19T09:00:00.000Z", percent: 33, tier: null }));
  assert.ok(out, "a percent-carrying line with no tier anywhere must still be returned, never dropped");
  assert.equal(out!.tier, null);
  assert.equal(out!.percent, 33, "the percent survives -- only the tier degrades");
  assert.equal(out!.periodType, "USAGE_PERIOD_TYPE_WEEKLY");
});

test("parseLatestGrokCredits: malformed JSON and missing/malformed ctx.config lines are skipped fail-soft, never throw", () => {
  const content = [
    "not json at all {{{",
    JSON.stringify({ ts: "2026-07-19T09:00:00.000Z", msg: "billing: fetched credits config" }), // no ctx at all
    JSON.stringify({ ts: "2026-07-19T09:01:00.000Z", msg: "billing: fetched credits config", ctx: {} }), // no config
    JSON.stringify({ ts: "2026-07-19T09:02:00.000Z", msg: "billing: fetched credits config", ctx: { config: "not-an-object" } }),
    JSON.stringify({ ts: "2026-07-19T09:03:00.000Z", msg: "billing: fetched credits config", ctx: { config: { subscriptionTier: "SuperGrok" } } }), // no currentPeriod
    '{"broken": "billing: fetched credits config"', // corrupt candidate line
    // marker matched inside an unrelated field -- not one of our records
    JSON.stringify({ msg: "other.event", "billing: fetched credits config": true }),
  ].join("\n");
  assert.doesNotThrow(() => GR.parseLatestGrokCredits(content));
  assert.equal(GR.parseLatestGrokCredits(content), null, "no well-formed line survives this fixture -> null");
});

test("parseLatestGrokCredits: observedAt is carried VERBATIM from the line's own ts -- staleness is the renderer's problem, never the parser's", () => {
  const ts = "2020-01-01T00:00:00.000Z"; // deliberately ancient: the parser must not judge freshness
  const out = GR.parseLatestGrokCredits(billingLine({ ts, percent: 5 }));
  assert.ok(out);
  assert.equal(out!.observedAt, Date.parse(ts), "reported honestly, however old -- no clamping, no dropping");
});

test("parseLatestGrokCredits: an unparseable ts on an otherwise-real billing line degrades the WHOLE line (never a guessed observedAt)", () => {
  const line = JSON.stringify({
    ts: "not-a-date",
    msg: "billing: fetched credits config",
    ctx: { config: { creditUsagePercent: 50, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "s", end: "e" }, subscriptionTier: "SuperGrok" } },
  });
  assert.equal(GR.parseLatestGrokCredits(line), null);
});

test("parseLatestGrokCredits: no file content / no billing lines at all -> null", () => {
  assert.equal(GR.parseLatestGrokCredits(""), null);
  assert.equal(GR.parseLatestGrokCredits([tokenLine("2026-07-19T09:00:00.000Z"), tokenLine("2026-07-19T09:05:00.000Z")].join("\n")), null);
});

// ============================================================================================
// 2. readLatestGrokCredits -- disk wrapper
// ============================================================================================

test("readLatestGrokCredits: reads the SAME unified.jsonl path grok.ts's token capture uses, parses the latest billing line", () => {
  withTempHome((home) => {
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(GR.grokUnifiedLogPath(home), [
      billingLine({ ts: "2026-07-19T09:00:00.000Z", percent: 20 }),
      tokenLine("2026-07-19T09:30:00.000Z"),
      billingLine({ ts: "2026-07-19T10:00:00.000Z", percent: 55 }),
    ].join("\n"));
    const out = GR.readLatestGrokCredits(home);
    assert.ok(out);
    assert.equal(out!.percent, 55);
  });
});

test("readLatestGrokCredits: no unified.jsonl on disk -> null, never throws", () => {
  withTempHome((home) => {
    assert.doesNotThrow(() => GR.readLatestGrokCredits(home));
    assert.equal(GR.readLatestGrokCredits(home), null);
  });
});

test("readLatestGrokCredits: a log with zero billing lines (token traffic only) -> null", () => {
  withTempHome((home) => {
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(GR.grokUnifiedLogPath(home), tokenLine("2026-07-19T09:00:00.000Z"));
    assert.equal(GR.readLatestGrokCredits(home), null);
  });
});

// ============================================================================================
// 3. Invariants (spec point 8): pure, no network, never touches auth.json
// ============================================================================================

test("invariant: parseLatestGrokCredits is a PURE function of its content argument -- it makes no network call", () => {
  const originalFetch = globalThis.fetch;
  // @ts-expect-error -- deliberately poisoning fetch to prove the parser never calls it
  globalThis.fetch = () => {
    throw new Error("parseLatestGrokCredits must never touch the network");
  };
  try {
    const out = GR.parseLatestGrokCredits(billingLine({ ts: "2026-07-19T09:00:00.000Z", percent: 30 }));
    assert.ok(out, "parsing must still succeed with fetch poisoned -- proves no network dependency");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invariant: readLatestGrokCredits never reads auth.json -- by construction it only ever opens grokUnifiedLogPath(home)", () => {
  withTempHome((home) => {
    mkdirSync(join(home, "logs"), { recursive: true });
    // A real-looking auth.json sitting right next to the log: if readLatestGrokCredits
    // ever opened ANY other file under home, this is where it would show up. The
    // function's own signature (input: a home dir string, output: GrokCredits | null,
    // no token/credential type anywhere in the shape) pins the invariant by
    // construction; this test proves the auth.json's mere PRESENCE changes nothing
    // about the result -- the log content alone decides it.
    writeFileSync(join(home, "auth.json"), JSON.stringify({ accessToken: "should-never-be-read", refreshToken: "or-this" }));
    writeFileSync(GR.grokUnifiedLogPath(home), billingLine({ ts: "2026-07-19T09:00:00.000Z", percent: 12 }));
    const out = GR.readLatestGrokCredits(home);
    assert.ok(out);
    assert.equal(out!.percent, 12, "reads only the unified log -- auth.json's presence/content is irrelevant");
  });
});

// ============================================================================================
// 4. limitsPanelLines -- the GROK WEEKLY lane
// ============================================================================================

test("limitsPanelLines: a GROK WEEKLY lane renders bar + \"N% used\" + reset (from periodEnd) + vendor-reported + tier, alongside CODEX/CLAUDE rows", () => {
  const data = minimalData({ codexLimits: CODEX_LIMITS as ShowcaseData["codexLimits"] });
  const lines = SS.limitsPanelLines(data, [], {
    height: 14,
    width: 110,
    claudeLanes: CLAUDE_LANES,
    grokCredits: GROK_CREDITS_FRESH,
    nowMs: Date.parse("2026-07-19T10:00:00.000Z"),
  });
  const text = lines.join("\n");
  assert.ok(text.includes("CLAUDE SESSION"), "claude lanes still render");
  assert.ok(text.includes("CODEX 5H"), "codex lines still render");
  const row = grokRow(lines);
  assert.ok(row, "a GROK WEEKLY row must render");
  assert.ok(row!.includes("GROK WEEKLY"));
  assert.ok(row!.includes("41% used"));
  assert.ok(row!.includes("resets in"), `expected a reset clause derived from periodEnd, got: ${row}`);
  assert.ok(row!.includes("vendor-reported"));
  assert.ok(row!.includes("SuperGrok"));
  const filled = (row!.match(/█/g) ?? []).length;
  assert.ok(filled > 0, "a real bar must render when percent is known");
});

test("limitsPanelLines: GROK lane with percent:null renders WITHOUT a bar or percent, stating period + tier only (degrade, never drop)", () => {
  const data = minimalData({});
  const credits = { ...GROK_CREDITS_FRESH, percent: null };
  const lines = SS.limitsPanelLines(data, [], { height: 12, width: 110, grokCredits: credits, nowMs: credits.observedAt + 1000 });
  const row = grokRow(lines);
  assert.ok(row, "a GROK row must still render with a null percent");
  assert.ok(row!.includes("GROK WEEKLY"));
  assert.ok(!row!.includes("% used"), "no percent text when percent is null");
  assert.equal((row!.match(/█/g) ?? []).length, 0, "no filled bar cells when percent is null");
  assert.ok(row!.includes("SuperGrok"), "tier still renders");
});

test("limitsPanelLines: GROK row with tier:null omits the tier label -- never a literal 'null', everything else unchanged", () => {
  const data = minimalData({});
  const nowMs = GROK_CREDITS_FRESH.observedAt + 1000;
  const noTier = SS.limitsPanelLines(data, [], { height: 12, width: 110, grokCredits: { ...GROK_CREDITS_FRESH, tier: null }, nowMs });
  const row = grokRow(noTier);
  assert.ok(row, "a GROK row must still render with a null tier -- tier is never a render gate either");
  assert.ok(row!.includes("GROK WEEKLY"));
  assert.ok(row!.includes("41% used"), "the percent renders unchanged");
  assert.ok(row!.includes("vendor-reported"));
  assert.ok(!row!.includes("SuperGrok"), "no tier label when tier is null");
  assert.ok(!row!.includes("null"), "the naive-interpolation failure -- a null tier must never print the literal 'null'");
  // Everything else unchanged: the only difference vs the tiered render is the tier text.
  const tiered = grokRow(SS.limitsPanelLines(data, [], { height: 12, width: 110, grokCredits: GROK_CREDITS_FRESH, nowMs }))!;
  assert.equal(row, tiered.replace(" · SuperGrok", ""), "removing exactly the tier segment from the tiered row yields the untiered row");
});

test("limitsPanelLines: GROK lane appends \"as of HH:MM\" when observedAt is stale (>30min before now)", () => {
  const data = minimalData({});
  const observedAt = Date.parse("2026-07-19T09:00:00.000Z");
  const staleNow = observedAt + 31 * 60_000; // 31 minutes later -- past the 30min threshold
  const lines = SS.limitsPanelLines(data, [], { height: 12, width: 110, grokCredits: { ...GROK_CREDITS_FRESH, observedAt }, nowMs: staleNow });
  const row = grokRow(lines);
  assert.ok(row);
  assert.match(row!, /as of \d{2}:\d{2}/, `stale data (31min old) must append an "as of HH:MM" marker, got: ${row}`);
});

test("limitsPanelLines: GROK lane omits the staleness marker when observedAt is fresh (<=30min before now)", () => {
  const data = minimalData({});
  const observedAt = Date.parse("2026-07-19T09:00:00.000Z");
  const freshNow = observedAt + 5 * 60_000; // 5 minutes later -- well inside the window
  const lines = SS.limitsPanelLines(data, [], { height: 12, width: 110, grokCredits: { ...GROK_CREDITS_FRESH, observedAt }, nowMs: freshNow });
  const row = grokRow(lines);
  assert.ok(row);
  assert.doesNotMatch(row!, /as of \d{2}:\d{2}/, "fresh data must carry no staleness marker");
});

test("limitsPanelLines: grokCredits null/undefined -> NO GROK row at all (honest absence, nothing invented)", () => {
  const data = minimalData({});
  assert.equal(grokRow(SS.limitsPanelLines(data, [], { height: 12, width: 110 })), undefined, "grokCredits omitted entirely");
  assert.equal(grokRow(SS.limitsPanelLines(data, [], { height: 12, width: 110, grokCredits: null })), undefined, "grokCredits explicitly null");
});

// ============================================================================================
// 5. Mode routing (D21/D22 pins, per billingModes.test.ts's #4) -- the same override the
//    CLAUDE/CODEX lanes already obey
// ============================================================================================

test("limitsPanelLines: the GROK lane shows for billingMode subscription/mix/undefined", () => {
  const data = minimalData({});
  for (const billingMode of [undefined, "subscription", "mix"] as const) {
    const lines = SS.limitsPanelLines(data, [], {
      height: 12,
      width: 110,
      billingMode,
      grokCredits: GROK_CREDITS_FRESH,
      nowMs: GROK_CREDITS_FRESH.observedAt,
    });
    assert.ok(grokRow(lines), `GROK lane must render under billingMode=${billingMode}`);
  }
});

test("limitsPanelLines: billingMode 'api' suppresses the GROK lane outright -- the same hard override CLAUDE/CODEX lanes obey, even with real grokCredits data", () => {
  const data = minimalData({});
  const lines = SS.limitsPanelLines(data, [], {
    height: 12,
    width: 110,
    billingMode: "api",
    grokCredits: GROK_CREDITS_FRESH,
    nowMs: GROK_CREDITS_FRESH.observedAt,
  });
  assert.equal(grokRow(lines), undefined, "api mode suppresses every provider lane, GROK included -- nothing provisioned for an API-only user");
});
