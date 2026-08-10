/**
 * LANE — D24: limits grouped by window duration, not vendor (docs/context-capacity-plan.md
 * Phase 8 addendum, RULED 2026-07-20). Marco's ruling from the 0.22.2 field run:
 *
 *   Two labeled groups replace the flat vendor list: "SESSION" (5h-scale windows: Claude
 *   session lane, Codex 5h/primary when reported, the Claude whole-corpus ESTIMATE as the
 *   labeled no-consent fallback) and "WEEKLY" (Codex weekly, Grok weekly, Claude weekly
 *   lane, Claude model-scoped lanes). Within a group, rows keep their existing per-provider
 *   honesty rules (vendor-reported bars, estimate-as-text, staleness stamps, absence = no
 *   row). Mode routing (D21/D22) unchanged: the whole panel still suppresses provider rows
 *   for billingMode "api"; the budget gauge keeps its place after the groups. Group headers
 *   render only when the group has at least one row (no empty scaffolding).
 *
 * THIS IS NOT A NEW SEAM — src/superStart.ts's existing `limitsPanelLines` (already
 * exported, already covered by windowInference.test.ts/billingModes.test.ts/
 * grokLimits.test.ts) grows no new parameters here; D24 only changes how its ALREADY
 * gathered rows are laid out. So this suite pins a REGROUPING of existing output, not a
 * missing export — the controlled red here is assertion failure (today's flat list has no
 * "SESSION"/"WEEKLY" header lines at all), not a TypeError. Namespace-imported anyway
 * (`import * as SS`) for the same crash-isolation discipline every other lane in this repo
 * uses, so a future signature change here still fails as a clean per-test assertion red
 * rather than taking out sibling suites in the same run.
 *
 * DESIGN DECISIONS MADE BY THIS SUITE (the D24 ruling above left these open; flagged here
 * for the impl agent, same latitude billingModes.test.ts/grokLimits.test.ts used):
 *
 *   1. Bucket rule for Claude lanes: kind === "session" -> SESSION, everything else ->
 *      WEEKLY. This is exactly the distinction `laneName()` already computes (kind ===
 *      "session" ? "CLAUDE SESSION" : ...), so it is the natural, lowest-risk seam — not a
 *      new classification the impl agent has to invent.
 *   2. The Codex "CODEX ... limits not reported by this Codex version" placeholder (renders
 *      when codexLimits has neither primary nor secondary) is bucketed into SESSION. It
 *      substitutes positionally for "Codex primary when reported" (D24's own SESSION
 *      wording), which is the row it stands in for when absent.
 *   3. `claudeNote` (the quiet "claude: unavailable (...)" fetch-failure line) is bucketed
 *      into SESSION, adjacent to the other Claude-fetch-outcome content (today's flat order
 *      already places it immediately after the claude lanes loop, before Codex).
 *   4. Within-group order: D24 states "claude lanes, codex, grok" as the per-provider
 *      order kept inside each group. Today's FLAT code renders the Claude 5h ESTIMATE
 *      fallback AFTER the Codex rows (an implementation artifact of the original single
 *      pass, not a deliberate order). Since the estimate plays the "claude" role inside
 *      SESSION, this suite pins it to the FRONT of the SESSION group (ahead of Codex),
 *      matching D24's explicit "claude ... codex ... grok" ordering rather than the old
 *      accidental position.
 *   5. Header exact content: pinned as the bare word "SESSION" / "WEEKLY" via `.trim()`
 *      equality — this pins the LABEL, not indentation, padding, or ANSI color (the
 *      existing convention throughout limitsPanelLines: "plain glyphs ... paint is the
 *      caller's job").
 *   6. Thread/context rows (the THREAD bars at the bottom) are UNCHANGED by D24 — they are
 *      not "limits" and D24 only regroups the provider-lane rows above them.
 *
 * Run: npx tsx --test test/limitsGrouping.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCostUsd } from "../src/usageView.ts";
import type { ShowcaseData } from "../src/superStart.ts";
// Namespace import — see the top-of-file note on crash isolation.
import * as SS from "../src/superStart.ts";

// ============================================================================================
// fixtures / helpers
// ============================================================================================

/** Mirrors windowInference.test.ts's / billingModes.test.ts's minimalData() — a bare
 * ShowcaseData with room for overrides. grokCredits included (ShowcaseData's real shape;
 * some older test files predate that field and rely on tsx's no-type-check leniency). */
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

// Claude lane fixtures — same literal shapes as windowInference.test.ts's
// "vendor-reported Claude lanes" test (session / weekly_all / weekly_scoped).
const CLAUDE_SESSION_LANE = { kind: "session", percent: 41, resetsAt: "2026-07-20T08:30:00.000Z", scopeLabel: null };
const CLAUDE_WEEKLY_LANE = { kind: "weekly_all", percent: 59, resetsAt: "2026-07-24T12:00:00.000Z", scopeLabel: null };
const CLAUDE_SCOPED_LANE = { kind: "weekly_scoped", percent: 32, resetsAt: "2026-07-24T12:00:00.000Z", scopeLabel: "Fable" };

// Codex fixtures — windowMinutes < 7*24*60 (10080) is 5h-scale; >= is weekly-scale.
const CODEX_5H_ONLY = { primary: { usedPercent: 2, windowMinutes: 300, resetsInSeconds: 8671 * 60 }, secondary: null };
const CODEX_WEEKLY_PRIMARY_ONLY = { primary: { usedPercent: 12, windowMinutes: 10080, resetsInSeconds: 3 * 24 * 3600 }, secondary: null };
const CODEX_5H_AND_SECONDARY = {
  primary: { usedPercent: 2, windowMinutes: 300, resetsInSeconds: 8671 * 60 },
  secondary: { usedPercent: 34, windowMinutes: 10080, resetsInSeconds: 3 * 24 * 3600 },
};

// Same literal shape as grokLimits.test.ts's GROK_CREDITS_FRESH.
const GROK_CREDITS_FRESH = {
  percent: 41,
  periodType: "USAGE_PERIOD_TYPE_WEEKLY",
  periodStart: "2026-07-14T00:00:00.000Z",
  periodEnd: "2026-07-21T00:00:00.000Z",
  tier: "SuperGrok",
  observedAt: Date.parse("2026-07-19T09:55:00.000Z"),
};

/** Index of the exact "SESSION" / "WEEKLY" header line, or -1. Pins the bare word via
 * `.trim()` — content, not indentation/padding/color (see design decision #5 above). */
function headerIndex(lines: string[], label: "SESSION" | "WEEKLY"): number {
  return lines.findIndex((l) => l.trim() === label);
}

/** Every non-boundary row following a header, up to the next boundary: a blank line (the
 * THREAD separator or trailing pad), a BUDGET row, or the other header. Generic to exactly
 * where claudeNote/the Codex "not reported" placeholder land within the group (design
 * decisions #2/#3) — it only asserts group MEMBERSHIP, never a stricter sub-position beyond
 * what's explicitly pinned in the ordering tests below. */
function section(lines: string[], startIdx: number): string[] {
  if (startIdx < 0) return [];
  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "" || l.includes("BUDGET") || l.trim() === "SESSION" || l.trim() === "WEEKLY") break;
    out.push(l);
  }
  return out;
}

function sessionSection(lines: string[]): string[] {
  return section(lines, headerIndex(lines, "SESSION"));
}
function weeklySection(lines: string[]): string[] {
  return section(lines, headerIndex(lines, "WEEKLY"));
}

// ============================================================================================
// 1. Header presence — each group's header renders ONLY when it has content
// ============================================================================================

test("limitsPanelLines: SESSION-only content -- SESSION header renders, WEEKLY header absent", () => {
  const data = minimalData({ codexLimits: CODEX_5H_ONLY as ShowcaseData["codexLimits"] });
  const lines = SS.limitsPanelLines(data, [], { height: 14, width: 110, claudeLanes: [CLAUDE_SESSION_LANE] });
  assert.notEqual(headerIndex(lines, "SESSION"), -1, "SESSION header must render");
  assert.equal(headerIndex(lines, "WEEKLY"), -1, "WEEKLY header must be absent -- nothing weekly-scale was supplied");
});

test("limitsPanelLines: WEEKLY-only content -- WEEKLY header renders, SESSION header absent", () => {
  // No session-scale claude lane (so no CLAUDE SESSION row), claudeLanes non-empty (so the
  // 5h ESTIMATE fallback does not trigger), and codex's ONLY window is >=7d (so neither the
  // 5h row nor the "not reported" placeholder appears) -- SESSION is genuinely empty.
  const data = minimalData({ codexLimits: CODEX_WEEKLY_PRIMARY_ONLY as ShowcaseData["codexLimits"] });
  const lines = SS.limitsPanelLines(data, [], { height: 14, width: 110, claudeLanes: [CLAUDE_WEEKLY_LANE] });
  assert.equal(headerIndex(lines, "SESSION"), -1, "SESSION header must be absent -- no session-scale content anywhere");
  assert.notEqual(headerIndex(lines, "WEEKLY"), -1, "WEEKLY header must render");
  assert.ok(weeklySection(lines).some((l) => l.includes("CLAUDE WEEKLY")));
  assert.ok(weeklySection(lines).some((l) => l.includes("CODEX WEEKLY")));
});

test("limitsPanelLines: both SESSION and WEEKLY content present -- both headers render, SESSION first", () => {
  const data = minimalData({ codexLimits: CODEX_5H_AND_SECONDARY as ShowcaseData["codexLimits"] });
  const lines = SS.limitsPanelLines(data, [], {
    height: 16,
    width: 110,
    claudeLanes: [CLAUDE_SESSION_LANE, CLAUDE_WEEKLY_LANE],
    grokCredits: GROK_CREDITS_FRESH,
    nowMs: GROK_CREDITS_FRESH.observedAt,
  });
  const sIdx = headerIndex(lines, "SESSION");
  const wIdx = headerIndex(lines, "WEEKLY");
  assert.notEqual(sIdx, -1);
  assert.notEqual(wIdx, -1);
  assert.ok(sIdx < wIdx, "SESSION must appear before WEEKLY");
});

test("limitsPanelLines: billingMode 'api' with nothing supplied -- neither header renders, no scaffolding at all (the honest-empty behavior)", () => {
  const data = minimalData({});
  const lines = SS.limitsPanelLines(data, [], { height: 8, width: 110, billingMode: "api" });
  assert.equal(headerIndex(lines, "SESSION"), -1);
  assert.equal(headerIndex(lines, "WEEKLY"), -1);
  assert.ok(!lines.join("\n").includes("BUDGET"), "no budget supplied -> no gauge either");
  assert.ok(
    lines.every((l) => l === ""),
    "an entirely unconfigured api-mode user with no live sessions gets a fully blank, padded frame -- no stray scaffolding",
  );
});

// ============================================================================================
// 2. SESSION group composition
// ============================================================================================

test("limitsPanelLines: SESSION group carries the Claude session lane (kind 'session')", () => {
  const data = minimalData({});
  const lines = SS.limitsPanelLines(data, [], { height: 10, width: 110, claudeLanes: [CLAUDE_SESSION_LANE] });
  const sec = sessionSection(lines);
  assert.ok(sec.some((l) => l.includes("CLAUDE SESSION") && l.includes("41% used")), `expected the session lane inside SESSION, got: ${sec.join(" | ")}`);
});

test("limitsPanelLines: SESSION group carries Codex primary when windowMinutes < 7 days (labeled CODEX 5H)", () => {
  const data = minimalData({ codexLimits: CODEX_5H_ONLY as ShowcaseData["codexLimits"] });
  const lines = SS.limitsPanelLines(data, [], { height: 10, width: 110 });
  const sec = sessionSection(lines);
  assert.ok(sec.some((l) => l.includes("CODEX 5H") && l.includes("2% used")), `expected CODEX 5H inside SESSION, got: ${sec.join(" | ")}`);
});

test("limitsPanelLines: SESSION group carries the Claude whole-corpus ESTIMATE fallback when claudeLanes is empty, unchanged wording", () => {
  const data = minimalData({});
  const lines = SS.limitsPanelLines(data, [], { height: 10, width: 110 }); // no claudeLanes at all
  const sec = sessionSection(lines);
  assert.ok(
    sec.some((l) => l.includes("CLAUDE 5H") && /est/.test(l)),
    `expected the labeled estimate fallback inside SESSION, got: ${sec.join(" | ")}`,
  );
});

test("limitsPanelLines: SESSION group carries the Codex 'not reported' placeholder when codexLimits has neither primary nor secondary", () => {
  const data = minimalData({ codexLimits: null });
  const lines = SS.limitsPanelLines(data, [], { height: 10, width: 110, claudeLanes: [CLAUDE_SESSION_LANE] });
  const sec = sessionSection(lines);
  assert.ok(
    sec.some((l) => l.includes("CODEX") && l.includes("limits not reported")),
    `expected the not-reported placeholder inside SESSION, got: ${sec.join(" | ")}`,
  );
});

// ============================================================================================
// 3. WEEKLY group composition
// ============================================================================================

test("limitsPanelLines: WEEKLY group carries Codex secondary (always weekly)", () => {
  const data = minimalData({ codexLimits: CODEX_5H_AND_SECONDARY as ShowcaseData["codexLimits"] });
  const lines = SS.limitsPanelLines(data, [], { height: 12, width: 110 });
  const sec = weeklySection(lines);
  assert.ok(sec.some((l) => l.includes("CODEX WEEKLY") && l.includes("34% used")), `expected Codex secondary inside WEEKLY, got: ${sec.join(" | ")}`);
});

test("limitsPanelLines: WEEKLY group carries Codex primary when windowMinutes >= 7 days", () => {
  const data = minimalData({ codexLimits: CODEX_WEEKLY_PRIMARY_ONLY as ShowcaseData["codexLimits"] });
  const lines = SS.limitsPanelLines(data, [], { height: 12, width: 110, claudeLanes: [CLAUDE_WEEKLY_LANE] });
  const sec = weeklySection(lines);
  assert.ok(sec.some((l) => l.includes("CODEX WEEKLY") && l.includes("12% used")), `expected Codex primary (>=7d) inside WEEKLY, got: ${sec.join(" | ")}`);
});

test("limitsPanelLines: WEEKLY group carries GROK WEEKLY", () => {
  const data = minimalData({});
  const lines = SS.limitsPanelLines(data, [], {
    height: 12,
    width: 110,
    claudeLanes: [CLAUDE_SESSION_LANE],
    grokCredits: GROK_CREDITS_FRESH,
    nowMs: GROK_CREDITS_FRESH.observedAt,
  });
  const sec = weeklySection(lines);
  assert.ok(sec.some((l) => l.includes("GROK WEEKLY") && l.includes("41% used")), `expected GROK WEEKLY inside WEEKLY, got: ${sec.join(" | ")}`);
});

test("limitsPanelLines: WEEKLY group carries the Claude weekly lane AND model-scoped lanes (kind seven_day / scoped)", () => {
  const data = minimalData({});
  const lines = SS.limitsPanelLines(data, [], {
    height: 12,
    width: 110,
    nowMs: Date.parse("2026-07-20T04:30:00.000Z"),
    claudeLanes: [CLAUDE_SESSION_LANE, CLAUDE_WEEKLY_LANE, CLAUDE_SCOPED_LANE],
  });
  const sec = weeklySection(lines);
  assert.ok(sec.some((l) => l.includes("CLAUDE WEEKLY") && l.includes("59% used")), `expected the unscoped weekly lane inside WEEKLY, got: ${sec.join(" | ")}`);
  assert.ok(sec.some((l) => l.includes("CLAUDE · FABLE") && l.includes("32% used")), `expected the scoped lane inside WEEKLY, got: ${sec.join(" | ")}`);
  // The session-kind lane must NOT leak into WEEKLY.
  assert.ok(!sec.some((l) => l.includes("CLAUDE SESSION")), "the session lane belongs to SESSION, not WEEKLY");
});

// ============================================================================================
// 4. Ordering — SESSION before WEEKLY; within a group, "claude lanes, codex, grok" (D24)
// ============================================================================================

test("limitsPanelLines: within SESSION, the claude session lane precedes the Codex 5h row", () => {
  const data = minimalData({ codexLimits: CODEX_5H_ONLY as ShowcaseData["codexLimits"] });
  const lines = SS.limitsPanelLines(data, [], { height: 12, width: 110, claudeLanes: [CLAUDE_SESSION_LANE] });
  const sec = sessionSection(lines);
  const claudeIdx = sec.findIndex((l) => l.includes("CLAUDE SESSION"));
  const codexIdx = sec.findIndex((l) => l.includes("CODEX 5H"));
  assert.ok(claudeIdx !== -1 && codexIdx !== -1);
  assert.ok(claudeIdx < codexIdx, `claude must precede codex within SESSION, got order: ${sec.join(" | ")}`);
});

test("limitsPanelLines: within SESSION, the ESTIMATE fallback (claude's slot) precedes the Codex 'not reported' placeholder (design decision #4)", () => {
  const data = minimalData({ codexLimits: null });
  const lines = SS.limitsPanelLines(data, [], { height: 12, width: 110 }); // no claudeLanes -> estimate fires
  const sec = sessionSection(lines);
  const estimateIdx = sec.findIndex((l) => l.includes("CLAUDE 5H"));
  const codexIdx = sec.findIndex((l) => l.includes("CODEX") && l.includes("not reported"));
  assert.ok(estimateIdx !== -1 && codexIdx !== -1);
  assert.ok(estimateIdx < codexIdx, `the claude estimate must lead the SESSION group, got order: ${sec.join(" | ")}`);
});

test("limitsPanelLines: within WEEKLY, claude lanes precede codex which precedes grok", () => {
  const data = minimalData({ codexLimits: CODEX_5H_AND_SECONDARY as ShowcaseData["codexLimits"] });
  const lines = SS.limitsPanelLines(data, [], {
    height: 14,
    width: 110,
    claudeLanes: [CLAUDE_SESSION_LANE, CLAUDE_WEEKLY_LANE],
    grokCredits: GROK_CREDITS_FRESH,
    nowMs: GROK_CREDITS_FRESH.observedAt,
  });
  const sec = weeklySection(lines);
  const claudeIdx = sec.findIndex((l) => l.includes("CLAUDE WEEKLY"));
  const codexIdx = sec.findIndex((l) => l.includes("CODEX WEEKLY"));
  const grokIdx = sec.findIndex((l) => l.includes("GROK WEEKLY"));
  assert.ok(claudeIdx !== -1 && codexIdx !== -1 && grokIdx !== -1);
  assert.ok(claudeIdx < codexIdx && codexIdx < grokIdx, `expected claude < codex < grok, got order: ${sec.join(" | ")}`);
});

test("limitsPanelLines: within WEEKLY, multiple claude lanes keep their supplied relative order (weekly_all before weekly_scoped)", () => {
  const data = minimalData({});
  const lines = SS.limitsPanelLines(data, [], {
    height: 12,
    width: 110,
    nowMs: Date.parse("2026-07-20T04:30:00.000Z"),
    claudeLanes: [CLAUDE_WEEKLY_LANE, CLAUDE_SCOPED_LANE],
  });
  const sec = weeklySection(lines);
  const allIdx = sec.findIndex((l) => l.includes("CLAUDE WEEKLY"));
  const scopedIdx = sec.findIndex((l) => l.includes("CLAUDE · FABLE"));
  assert.ok(allIdx !== -1 && scopedIdx !== -1);
  assert.ok(allIdx < scopedIdx, `array order must be preserved, got: ${sec.join(" | ")}`);
});

// ============================================================================================
// 5. Regression — existing per-row honesty behaviors unchanged inside the new groups
//    (each reuses the exact fixture shape from the suite named in its comment)
// ============================================================================================

test("REGRESSION (windowInference.test.ts): vendor-reported suffix still present on Codex + Claude lane rows inside their groups", () => {
  const data = minimalData({});
  data.codexLimits = {
    primary: { usedPercent: 2, windowMinutes: 300, resetsInSeconds: 8671 * 60 },
    secondary: { usedPercent: 34, windowMinutes: 10080, resetsInSeconds: 3 * 24 * 3600 },
  };
  const lines = SS.limitsPanelLines(data, [], { height: 10, width: 110, claudeLanes: [CLAUDE_SESSION_LANE] });
  const sSec = sessionSection(lines);
  const wSec = weeklySection(lines);
  assert.ok(sSec.some((l) => l.includes("CLAUDE SESSION") && l.includes("vendor-reported")));
  assert.ok(sSec.some((l) => l.includes("CODEX 5H") && l.includes("vendor-reported")));
  assert.ok(wSec.some((l) => l.includes("CODEX WEEKLY") && l.includes("vendor-reported")));
});

test("REGRESSION (windowInference.test.ts 'Codex windows render as bars'): the Claude ESTIMATE renders as honest text, never a fabricated bar, inside SESSION", () => {
  const data = minimalData({});
  data.codexLimits = { primary: { usedPercent: 2, windowMinutes: 300, resetsInSeconds: 8671 * 60 }, secondary: { usedPercent: 34, windowMinutes: 10080, resetsInSeconds: 3 * 24 * 3600 } };
  const lines = SS.limitsPanelLines(data, [], { height: 10, width: 110 });
  const sSec = sessionSection(lines);
  const estimateRow = sSec.find((l) => l.includes("CLAUDE 5H"));
  assert.ok(estimateRow, "the estimate row must be inside SESSION");
  assert.ok(!estimateRow!.includes("█"), "no fabricated Claude bar -- remaining capacity is unknown");
  assert.ok(sSec.some((l) => l.includes("CODEX 5H") && l.includes("█")), "Codex, in contrast, DOES render a real bar");
});

test("REGRESSION (grokLimits.test.ts staleness pin): GROK lane inside WEEKLY still appends 'as of HH:MM' when observedAt is stale (>30min)", () => {
  const data = minimalData({});
  const observedAt = Date.parse("2026-07-19T09:00:00.000Z");
  const staleNow = observedAt + 31 * 60_000;
  const lines = SS.limitsPanelLines(data, [], { height: 12, width: 110, grokCredits: { ...GROK_CREDITS_FRESH, observedAt }, nowMs: staleNow });
  const sec = weeklySection(lines);
  const row = sec.find((l) => l.includes("GROK"));
  assert.ok(row, "GROK row must be inside WEEKLY");
  assert.match(row!, /as of \d{2}:\d{2}/, `expected the staleness marker, got: ${row}`);
});

test("REGRESSION (grokLimits.test.ts absence pin): grokCredits null/undefined -> no GROK row anywhere, and no stray WEEKLY header caused by it alone", () => {
  const data = minimalData({});
  const lines = SS.limitsPanelLines(data, [], { height: 12, width: 110, claudeLanes: [CLAUDE_SESSION_LANE] });
  assert.ok(!lines.join("\n").includes("GROK"), "no grokCredits supplied -- honest absence, nothing invented");
  // SESSION-only content (the session lane + the always-on Codex not-reported placeholder,
  // since codexLimits defaults to null) -- WEEKLY must stay absent.
  assert.equal(headerIndex(lines, "WEEKLY"), -1);
});

// ============================================================================================
// 6. Mode routing (D21/D22) unchanged: billingMode "api" suppresses BOTH groups (headers
//    included); the budget gauge keeps its place AFTER the groups for api/mix with a budget.
// ============================================================================================

const CLAUDE_LANES_FOR_MODE_TESTS = [{ kind: "session", percent: 41, resetsAt: null, scopeLabel: null }];
const CODEX_LIMITS_FOR_MODE_TESTS = { primary: { usedPercent: 2, windowMinutes: 300, resetsInSeconds: 8671 * 60 }, secondary: null };

test("limitsPanelLines: billingMode undefined/subscription/mix -- groups + headers render exactly as the ungrouped regression baseline", () => {
  for (const billingMode of [undefined, "subscription", "mix"] as const) {
    const data = minimalData({ codexLimits: CODEX_LIMITS_FOR_MODE_TESTS as ShowcaseData["codexLimits"] });
    const lines = SS.limitsPanelLines(data, [], { height: 12, width: 110, billingMode, claudeLanes: CLAUDE_LANES_FOR_MODE_TESTS });
    assert.notEqual(headerIndex(lines, "SESSION"), -1, `billingMode=${billingMode}`);
  }
});

test("limitsPanelLines: billingMode 'subscription' -- headers render but the budget gauge NEVER renders, even when `budget` is supplied", () => {
  const data = minimalData({ codexLimits: CODEX_LIMITS_FOR_MODE_TESTS as ShowcaseData["codexLimits"] });
  const lines = SS.limitsPanelLines(data, [], {
    height: 12,
    width: 110,
    billingMode: "subscription",
    claudeLanes: CLAUDE_LANES_FOR_MODE_TESTS,
    budget: { spentUsd: 90, budgetUsd: 100 },
  });
  assert.notEqual(headerIndex(lines, "SESSION"), -1);
  assert.ok(!lines.join("\n").includes("BUDGET"), "D22 scopes the gauge to api/mix only");
});

test("limitsPanelLines: billingMode 'mix' with a budget -- the gauge renders AFTER both groups", () => {
  const data = minimalData({ codexLimits: CODEX_5H_AND_SECONDARY as ShowcaseData["codexLimits"] });
  const lines = SS.limitsPanelLines(data, [], {
    height: 16,
    width: 110,
    billingMode: "mix",
    claudeLanes: [CLAUDE_SESSION_LANE, CLAUDE_WEEKLY_LANE],
    budget: { spentUsd: 40, budgetUsd: 100 },
  });
  const wIdx = headerIndex(lines, "WEEKLY");
  const budgetIdx = lines.findIndex((l) => l.includes("BUDGET"));
  assert.notEqual(wIdx, -1);
  assert.notEqual(budgetIdx, -1);
  assert.ok(budgetIdx > wIdx, `budget gauge must render after the WEEKLY group, got budgetIdx=${budgetIdx} wIdx=${wIdx}`);
  assert.ok(lines[budgetIdx].includes(`${formatCostUsd(40)} of ${formatCostUsd(100)}`));
});

test("limitsPanelLines: billingMode 'api' -- suppresses BOTH group headers even with real claudeLanes/codexLimits data, but the budget gauge still renders when supplied", () => {
  const data = minimalData({ codexLimits: CODEX_5H_AND_SECONDARY as ShowcaseData["codexLimits"] });
  const lines = SS.limitsPanelLines(data, [], {
    height: 12,
    width: 110,
    billingMode: "api",
    claudeLanes: [CLAUDE_SESSION_LANE, CLAUDE_WEEKLY_LANE],
    grokCredits: GROK_CREDITS_FRESH,
    budget: { spentUsd: 40, budgetUsd: 100 },
    nowMs: GROK_CREDITS_FRESH.observedAt,
  });
  assert.equal(headerIndex(lines, "SESSION"), -1, "api mode suppresses SESSION entirely, headers included");
  assert.equal(headerIndex(lines, "WEEKLY"), -1, "api mode suppresses WEEKLY entirely, headers included");
  assert.ok(lines.join("\n").includes("BUDGET"), "api mode still gets the budget gauge -- it IS the remaining-usage visual");
});

// ============================================================================================
// 7. Region height + thread rows are unaffected by the new header rows
// ============================================================================================

test("limitsPanelLines: region height is held exactly regardless of how many group headers/rows are emitted (regression: never an over/under-filled frame)", () => {
  const data = minimalData({ codexLimits: CODEX_5H_AND_SECONDARY as ShowcaseData["codexLimits"] });
  for (const height of [3, 8, 20]) {
    const lines = SS.limitsPanelLines(data, [], {
      height,
      width: 110,
      claudeLanes: [CLAUDE_SESSION_LANE, CLAUDE_WEEKLY_LANE, CLAUDE_SCOPED_LANE],
      grokCredits: GROK_CREDITS_FRESH,
      budget: { spentUsd: 10, budgetUsd: 100 },
      billingMode: "mix",
      nowMs: GROK_CREDITS_FRESH.observedAt,
    });
    assert.equal(lines.length, height, `height=${height}`);
  }
});

test("limitsPanelLines: THREAD/context rows still render after the groups, unaffected by the new headers", () => {
  const data = minimalData({});
  const liveSessions = [{ label: "claude-fable-5", tokens: 0, ctx: { pct: 90.7, inferred: true } }];
  const lines = SS.limitsPanelLines(data, liveSessions, { height: 12, width: 110, claudeLanes: [CLAUDE_SESSION_LANE] });
  const text = lines.join("\n");
  assert.ok(text.includes("THREAD") && text.includes("fable-5") && text.includes("~91%"), `thread row must still render, got: ${text}`);
  const sIdx = headerIndex(lines, "SESSION");
  const threadIdx = lines.findIndex((l) => l.includes("THREAD"));
  assert.ok(threadIdx > sIdx, "the thread row must come after the SESSION group");
});
