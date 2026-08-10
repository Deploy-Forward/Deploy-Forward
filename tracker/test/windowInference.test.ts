/**
 * LANE T5 — window inference + the live-bar "% full" render.
 *
 * The field finding that forced this (2026-07-17, PR #37's smoke check, then
 * verified against the raw transcript): real Claude 1M-tier sessions carry BARE
 * model ids — the API usage block for a 689,699-token prompt says
 * "claude-opus-4-8", no [1m] suffix, isSidechain false, 99.8% of it cacheRead of
 * the session's own prefix. So id-based resolution alone would render that
 * session as 344% of a 200K window. The registry base stays 200,000 (the safe
 * default), occupancy stays raw truth, and the RENDER layer resolves the window
 * with labeled provenance:
 *
 *   stated (the vendor said it: Codex model_context_window)
 *     > registry (our table resolved the id)
 *       > inferred (observed occupancy exceeds the resolved window and a known
 *         elevated tier covers it — Claude's 1M beta)
 *
 * A window above 100% must never render; a window we guessed must never claim
 * to be stated. Occupancy beyond every window we can name -> null: no %, ever,
 * rather than a made-up denominator.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowForSession } from "../src/contextWindows.ts";
import { liveSessionChartLines, liveSessionsFrom, readShowcaseData } from "../src/superStart.ts";
import type { ShowcaseSession } from "../src/superStart.ts";
import { claudeLine } from "./fixtures.ts";
import { PARSER_EPOCH } from "../src/config.ts";

// ---- windowForSession: the provenance ladder ----------------------------------------------------

test("windowForSession: vendor-stated beats the registry, verbatim", () => {
  // Codex states 258,400 for gpt-5.5; the registry would resolve gpt-5 -> 272,000.
  // The vendor's number wins and is passed through untouched.
  const w = windowForSession({ occupancyTokens: 22_284, model: "gpt-5.5", windowTokens: 258_400 });
  assert.deepEqual(w, { tokens: 258_400, provenance: "stated" });
});

test("windowForSession: registry resolution for a session inside its base window", () => {
  const w = windowForSession({ occupancyTokens: 150_000, model: "claude-opus-4-8" });
  assert.deepEqual(w, { tokens: 200_000, provenance: "registry" });
  // Non-Claude too: pi on gpt-5.4-mini (registry 1,050,000).
  const w2 = windowForSession({ occupancyTokens: 7_648, model: "gpt-5.4-mini" });
  assert.deepEqual(w2, { tokens: 1_050_000, provenance: "registry" });
});

test("windowForSession: THE FIELD CASE — bare-id Claude beyond 200K infers the 1M tier", () => {
  // The verified real session: occupancy 689,699 on bare "claude-opus-4-8".
  const w = windowForSession({ occupancyTokens: 689_699, model: "claude-opus-4-8" });
  assert.deepEqual(w, { tokens: 1_000_000, provenance: "inferred" });
  // And the 907,474 fable-5 session from the same smoke check.
  const w2 = windowForSession({ occupancyTokens: 907_474, model: "claude-fable-5" });
  assert.deepEqual(w2, { tokens: 1_000_000, provenance: "inferred" });
});

test("windowForSession: a [1m]-suffixed id needs no inference — the registry already says 1M", () => {
  const w = windowForSession({ occupancyTokens: 600_000, model: "claude-opus-4-8[1m]" });
  assert.deepEqual(w, { tokens: 1_000_000, provenance: "registry" });
});

test("windowForSession: occupancy beyond every known tier -> null, never a guessed denominator", () => {
  // Claude past 1M: no tier we can name covers it.
  assert.equal(windowForSession({ occupancyTokens: 1_200_000, model: "claude-opus-4-8" }), null);
  // Non-Claude over its window: gpt-5 registry is 272,000 and we know no elevated tier.
  assert.equal(windowForSession({ occupancyTokens: 300_000, model: "gpt-5" }), null);
});

test("windowForSession: unknown model or zero occupancy stays honest", () => {
  assert.equal(windowForSession({ occupancyTokens: 5_000, model: "mystery-model-9" }), null);
  // Zero occupancy inside a known family: the registry window still resolves
  // (a fresh session is honestly at 0% of 200K, not unknown).
  assert.deepEqual(windowForSession({ occupancyTokens: 0, model: "claude-opus-4-8" }), { tokens: 200_000, provenance: "registry" });
});

// ---- liveSessionsFrom: the watch-loop mapping, extracted pure -----------------------------------

function sess(o: { key: string; model: string; tokens: number; context?: ShowcaseSession["context"] }): ShowcaseSession {
  return { key: o.key, tool: "Claude Code", model: o.model, tokens: o.tokens, context: o.context };
}

test("liveSessionsFrom: deltas vs baseline, sorted desc, zero-delta sessions dropped", () => {
  const baseline = new Map([
    ["claude_code_a", 1_000],
    ["claude_code_b", 500],
    ["claude_code_c", 700],
  ]);
  const live = liveSessionsFrom(
    [
      sess({ key: "claude_code_a", model: "claude-opus-4-8", tokens: 1_100 }), // +100
      sess({ key: "claude_code_b", model: "claude-fable-5", tokens: 900 }), // +400
      sess({ key: "claude_code_c", model: "claude-sonnet-5", tokens: 700 }), // +0 -> dropped
    ],
    baseline,
  );
  assert.deepEqual(
    live.map((s) => [s.label, s.tokens]),
    [
      ["claude-fable-5", 400],
      ["claude-opus-4-8", 100],
    ],
  );
});

test("liveSessionsFrom: a session with context carries pct + inferred from windowForSession", () => {
  const live = liveSessionsFrom(
    [
      sess({
        key: "claude_code_a",
        model: "claude-opus-4-8",
        tokens: 500,
        // The real verified numbers: 2 + 688,311 + 1,386 = 689,699 of an inferred 1M.
        context: { occupancyTokens: 689_699, model: "claude-opus-4-8" },
      }),
      sess({
        key: "codex_z",
        model: "gpt-5.5",
        tokens: 300,
        // Vendor-stated window: 22,284 / 258,400 = 8.624...%
        context: { occupancyTokens: 22_284, model: "gpt-5.5", windowTokens: 258_400 },
      }),
      sess({ key: "claude_code_n", model: "claude-sonnet-5", tokens: 200 }), // no context -> no ctx
    ],
    new Map(),
  );
  assert.equal(live.length, 3);
  const [a, z, n] = live;
  // 689,699 / 1,000,000 = 68.9699%
  assert.ok(a.ctx && Math.abs(a.ctx.pct - 68.9699) < 0.001, `inferred pct, got ${JSON.stringify(a.ctx)}`);
  assert.equal(a.ctx?.inferred, true, "the 1M window was inferred, and the bar must say so");
  // 22,284 / 258,400 = 8.6238...%
  assert.ok(z.ctx && Math.abs(z.ctx.pct - 8.6238) < 0.001, `stated pct, got ${JSON.stringify(z.ctx)}`);
  assert.equal(z.ctx?.inferred, false, "a vendor-stated window is not an inference");
  assert.equal(n.ctx, undefined, "no occupancy data -> no ctx, never a guess");
});

test("liveSessionsFrom: occupancy beyond every known tier -> no ctx on the bar (windowForSession null)", () => {
  const live = liveSessionsFrom(
    [sess({ key: "k", model: "gpt-5", tokens: 100, context: { occupancyTokens: 300_000, model: "gpt-5" } })],
    new Map(),
  );
  assert.equal(live[0].ctx, undefined, "no denominator we can stand behind -> no percentage");
});

// ---- liveSessionChartLines: the label row wears the % -------------------------------------------

test("liveSessionChartLines: label row carries the pct — tilde marks an inferred window", () => {
  const lines = liveSessionChartLines(
    [{ label: "claude-opus-4-8", tokens: 288_400, ctx: { pct: 68.9699, inferred: true } }],
    { height: 4, width: 40 },
  );
  const labelRow = lines[lines.length - 2];
  assert.ok(labelRow.includes("~69%"), `inferred pct rendered with a tilde, got: ${JSON.stringify(labelRow)}`);
  assert.ok(labelRow.includes("opus-4-8"), "the model label survives beside the pct");
});

test("liveSessionChartLines: a stated/registry window renders the pct bare, no tilde", () => {
  const lines = liveSessionChartLines(
    [{ label: "gpt-5.5", tokens: 121_900, ctx: { pct: 8.6238, inferred: false } }],
    { height: 4, width: 40 },
  );
  const labelRow = lines[lines.length - 2];
  assert.ok(labelRow.includes("9%") && !labelRow.includes("~"), `bare rounded pct, got: ${JSON.stringify(labelRow)}`);
});

test("liveSessionChartLines: no ctx -> the label row is exactly as before (no stray separator)", () => {
  const lines = liveSessionChartLines([{ label: "claude-opus-4-8", tokens: 288_400 }], { height: 4, width: 40 });
  const labelRow = lines[lines.length - 2];
  assert.ok(labelRow.includes("opus-4-8"), "label intact");
  assert.ok(!labelRow.includes("%"), "no percentage invented");
});

test("liveSessionChartLines: a column too narrow for the pct drops it, never truncates it into noise", () => {
  // Many sessions force colW to the 4-cell floor: "~69%" cannot fit beside any label.
  const many = Array.from({ length: 8 }, (_, i) => ({
    label: `claude-model-${i}`,
    tokens: 1_000 + i,
    ctx: { pct: 68.9699, inferred: true },
  }));
  const lines = liveSessionChartLines(many, { height: 3, width: 46 });
  const labelRow = lines[lines.length - 2];
  assert.ok(!labelRow.includes("%"), `pct dropped in narrow columns, got: ${JSON.stringify(labelRow)}`);
});

// ---- readShowcaseData: context threads from the scanners to the session grain -------------------

test("readShowcaseData: a session's context reaches ShowcaseSession (last turn, hand-computed)", () => {
  const home = mkdtempSync(join(tmpdir(), "df-wininf-home-"));
  const projects = mkdtempSync(join(tmpdir(), "df-wininf-projects-"));
  const proj = join(projects, "proj1");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "s-ctx.jsonl"),
    [
      claudeLine({ sessionId: "s-ctx", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
      // Last turn: 20 + 300 + 40 = 360 occupancy, and THIS turn's model attribution.
      claudeLine({ sessionId: "s-ctx", ts: "2026-06-01T10:01:00.000Z", msgId: "m2", reqId: "r2", model: "claude-opus-4-8", input: 20, output: 10, cacheRead: 300, cacheCreation: 40 }),
    ].join("\n"),
  );
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://mock.invalid/api",
      deviceToken: null,
      uid: null,
      handle: null,
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
    }),
  );
  const prev: Record<string, string | undefined> = {};
  const pins: Record<string, string> = {
    DF_HOME: home,
    DF_CLAUDE_PROJECTS: projects,
    DF_CODEX_SESSIONS: join(projects, "x1"),
    DF_GROK_HOME: join(projects, "x2"),
    DF_PI_HOME: join(projects, "x3"),
    DF_OPENCLAW_HOME: join(projects, "x4"),
    DF_OPENCODE_HOME: join(projects, "x5"),
    DF_HERMES_HOME: join(projects, "x6"),
    DF_COPILOT_HOME: join(projects, "x7"),
  };
  for (const [k, v] of Object.entries(pins)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const data = readShowcaseData(Date.parse("2026-06-05T00:00:00.000Z"));
    const s = data.sessions.find((x) => x.key === "claude_code_s-ctx");
    assert.ok(s, "the fixture session appears in the showcase grain");
    assert.ok(s.context, "context threads through from the scanner");
    assert.equal(s.context.occupancyTokens, 360, "last turn: 20 input + 300 cacheRead + 40 cacheCreation");
    assert.equal(s.context.model, "claude-opus-4-8");
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---- the contradiction Marco screenshotted: "live" harness + "no session has burned" ------------
//
// Image evidence (2026-07-17): Claude Code marked live by the probe, four agents
// visibly running, and the chart region said "no session has burned tokens since
// super-start began — waiting…". Two defects: (1) the empty state ignored what the
// probe KNOWS — a live harness with known thread occupancy is "measuring", not
// "nothing happening"; (2) the fold trigger required the write burst to SETTLE for
// SCAN_DEBOUNCE_MS, so continuously-writing agents starved the delta fold to the 15s
// fallback. The empty state must tell the truth, and sustained writing must bound
// the fold latency, not defer it.

import { composeScreen, scanDue } from "../src/superStart.ts";
import type { ShowcaseData } from "../src/superStart.ts";

function minimalData(sessions: ShowcaseSession[]): ShowcaseData {
  return {
    harnesses: [{ name: "Claude Code", sessions: 1 }],
    totalSessions: sessions.length,
    tokenTotal: 1_000_000,
    modelRows: [{ model: "claude-opus-4-8", input: 100, output: 50, cacheRead: 0, cacheCreation: 0, total: 150 }],
    sessions,
    spendTotalUsd: 1.23,
    spendIsPartial: false,
    activeHours: 10,
    days: [],
    spend30dUsd: null,
    codexLimits: null,
    claude5h: null,
  };
}

test("empty live chart + live harness: says MEASURING and shows the threads' context, never the contradiction", () => {
  const data = minimalData([
    sess({ key: "claude_code_a", model: "claude-opus-4-8", tokens: 500, context: { occupancyTokens: 810_594, model: "claude-opus-4-8", at: "2026-07-17T22:00:00.000Z" } }),
    sess({ key: "claude_code_b", model: "claude-fable-5", tokens: 400, context: { occupancyTokens: 907_474, model: "claude-fable-5", at: "2026-07-17T22:01:00.000Z" } }),
  ]);
  const lines = composeScreen(data, { rows: 40, cols: 120 }, 1, {
    scanAgoS: 1, nextInS: 9, pushing: false, beat: 1,
    activeHarnesses: ["Claude Code"],
    sessions: [], // no delta yet — the exact screenshotted state
    chartView: "live",
  }, 0);
  const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(!text.includes("no session has burned"), "the contradiction line is gone when a harness is live");
  assert.ok(/measuring/i.test(text), "the live-harness empty state says it is measuring");
  assert.ok(text.includes("~91%"), "the fullest live thread's context renders immediately (907,474 of inferred 1M)");
  assert.ok(text.includes("~81%"), "the second thread too");
});

test("empty live chart + NO live harness: the honest waiting line stays", () => {
  const data = minimalData([sess({ key: "claude_code_a", model: "claude-opus-4-8", tokens: 500 })]);
  const lines = composeScreen(data, { rows: 40, cols: 120 }, 1, {
    scanAgoS: 1, nextInS: 9, pushing: false, beat: 1,
    activeHarnesses: [],
    sessions: [],
    chartView: "live",
  }, 0);
  const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(/no session has burned tokens|no live agent/i.test(text), "idle keeps an honest waiting line");
  assert.ok(!/measuring/i.test(text), "idle never claims to be measuring");
});

test("scanDue: a settled burst folds after debounce + min gap (existing behavior)", () => {
  const t0 = 1_000_000;
  // burst wrote at t0, settled; now = t0 + 3500 (past 800ms debounce and 3000ms gap since lastScan t0-1000)
  assert.equal(scanDue(t0 + 3500, t0, t0 - 1000), true);
  // too soon after the last scan
  assert.equal(scanDue(t0 + 2000, t0, t0 + 1500), false);
});

test("scanDue: SUSTAINED writing must not starve the fold — bounded, not deferred to the 15s fallback", () => {
  const lastScan = 1_000_000;
  // Agents write continuously: corpusChangedAt is always ~now, so the settle
  // condition (now - changed >= 800) never holds. The fold must still fire once
  // 2x MIN_SCAN_GAP has passed since the last scan.
  const now = lastScan + 6_000;
  assert.equal(scanDue(now, now - 100, lastScan), true, "6s of sustained writing forces a fold");
  assert.equal(scanDue(lastScan + 4_000, lastScan + 3_900, lastScan), false, "under the sustained bound, still coalescing");
});

test("scanDue: nothing changed since the last scan -> never due (fallback clock is the loop's, not ours)", () => {
  assert.equal(scanDue(2_000_000, 1_000_000, 1_500_000), false);
});

// ---- the limits page + second-zero seeding (Marco 2026-07-17) -----------------------------------
//
// "What about usage remaining for the models? I'm not seeing that as a graph" — the
// Codex windows we already parse rendered as plain text at the bottom of `usage`.
// They become the third arrow page: health bars, each provenance-labeled. And the
// watch must "already pick up live sessions, and start with $0" — detected sessions
// stand on the chart at zero immediately instead of waiting for the first fold.

import { limitsPanelLines, nextChartView } from "../src/superStart.ts";

test("nextChartView: three pages, direction-aware, wraps both ways", () => {
  assert.equal(nextChartView("spend", "right"), "live");
  assert.equal(nextChartView("live", "right"), "limits");
  assert.equal(nextChartView("limits", "right"), "spend");
  assert.equal(nextChartView("spend", "left"), "limits");
  assert.equal(nextChartView("limits", "left"), "live");
});

test("limitsPanelLines: Codex windows render as bars with provenance; Claude stays honest text", () => {
  const data = minimalData([]);
  data.codexLimits = {
    primary: { usedPercent: 2, windowMinutes: 300, resetsInSeconds: 8671 * 60 },
    secondary: { usedPercent: 34, windowMinutes: 10080, resetsInSeconds: 3 * 24 * 3600 },
  };
  const lines = limitsPanelLines(data, [], { height: 10, width: 110 });
  const text = lines.join("\n");
  assert.ok(text.includes("CODEX 5H"), "primary window labeled");
  assert.ok(text.includes("CODEX WEEKLY"), "secondary window labeled");
  assert.ok(text.includes("2% used"), "primary used %");
  assert.ok(text.includes("34% used"), "secondary used %");
  assert.ok(text.includes("█") && text.includes("░"), "bars, not prose");
  assert.ok(text.includes("vendor-reported"), "provenance on the vendor rows");
  assert.ok(/CLAUDE 5H/.test(text) && /est/.test(text), "the Claude line stays a labeled estimate");
  assert.ok(!/CLAUDE[^\n]*█/.test(text), "no fabricated Claude bar — remaining capacity is unknown");
  assert.equal(lines.length, 10, "region height held exactly");
});

test("limitsPanelLines: live threads join as context bars, tilde carried", () => {
  const data = minimalData([]);
  const lines = limitsPanelLines(
    data,
    [
      { label: "claude-fable-5", tokens: 0, ctx: { pct: 90.7, inferred: true } },
      { label: "gpt-5.5", tokens: 100, ctx: { pct: 8.6, inferred: false } },
    ],
    { height: 10, width: 110 },
  );
  const text = lines.join("\n");
  assert.ok(text.includes("THREAD fable-5") && text.includes("~91% of context window"), "inferred thread bar");
  assert.ok(text.includes("THREAD gpt-5.5") && text.includes("9% of context window"), "stated/registry thread bar, no tilde");
});

test("liveSessionsFrom seeding: recent sessions of live harnesses stand at zero, fullest first", () => {
  const now = Date.parse("2026-07-17T22:00:00.000Z");
  const live = liveSessionsFrom(
    [
      sess({ key: "claude_code_a", model: "claude-opus-4-8", tokens: 500, context: { occupancyTokens: 689_699, model: "claude-opus-4-8", at: "2026-07-17T21:59:30.000Z" } }),
      sess({ key: "claude_code_b", model: "claude-fable-5", tokens: 400, context: { occupancyTokens: 907_474, model: "claude-fable-5", at: "2026-07-17T21:59:50.000Z" } }),
      // Stale: last turn 2 hours ago — NOT seeded even though its harness is live.
      sess({ key: "claude_code_old", model: "claude-sonnet-5", tokens: 300, context: { occupancyTokens: 100_000, model: "claude-sonnet-5", at: "2026-07-17T20:00:00.000Z" } }),
    ],
    new Map([
      ["claude_code_a", 500],
      ["claude_code_b", 400],
      ["claude_code_old", 300],
    ]), // zero deltas everywhere — the second-zero state
    { activeHarnesses: ["Claude Code"], nowMs: now },
  );
  assert.deepEqual(
    live.map((s) => [s.label, s.tokens]),
    [
      ["claude-fable-5", 0], // 90.7% — fullest first
      ["claude-opus-4-8", 0],
    ],
    "recent live-harness sessions seeded at zero, stale one excluded",
  );
  assert.ok(live[0].ctx && live[0].ctx.pct > 90, "seeded bars carry their context %");
});

test("liveSessionsFrom seeding: burned sessions keep rank order ahead of seeds; no double-listing", () => {
  const now = Date.parse("2026-07-17T22:00:00.000Z");
  const live = liveSessionsFrom(
    [
      sess({ key: "claude_code_a", model: "claude-opus-4-8", tokens: 700, context: { occupancyTokens: 689_699, model: "claude-opus-4-8", at: "2026-07-17T21:59:30.000Z" } }),
      sess({ key: "claude_code_b", model: "claude-fable-5", tokens: 400, context: { occupancyTokens: 907_474, model: "claude-fable-5", at: "2026-07-17T21:59:50.000Z" } }),
    ],
    new Map([
      ["claude_code_a", 500], // +200 burned
      ["claude_code_b", 400], // zero — seeded
    ]),
    { activeHarnesses: ["Claude Code"], nowMs: now },
  );
  assert.deepEqual(
    live.map((s) => [s.label, s.tokens]),
    [
      ["claude-opus-4-8", 200],
      ["claude-fable-5", 0],
    ],
    "burned first, then seeds; the burned session is not ALSO seeded",
  );
});

test("liveSessionChartLines: a zero-delta seeded bar shows label + % + value 0 but no bar glyph", () => {
  const lines = liveSessionChartLines(
    [{ label: "claude-fable-5", tokens: 0, ctx: { pct: 90.7, inferred: true } }],
    { height: 4, width: 40 },
  );
  assert.ok(lines.length > 0, "a seeded-only chart still renders");
  const text = lines.join("\n");
  assert.ok(text.includes("fable-5") && text.includes("~91%"), "label row carries model + ctx");
  assert.ok(!text.includes("█") && !text.includes("▁"), "no bar height fabricated for zero tokens");
  const valueRow = lines[lines.length - 1];
  assert.ok(valueRow.includes("0"), "the value row says 0, honestly");
});

// ---- Claude lanes on the limits page + the widened seed window (2026-07-18) ---------------------
//
// Workflow-verified findings: the "missing" fable session was structural, not a label
// bug — the 90s seed window missed sessions whose last COMPLETED message predated
// launch (Claude Code persists per message completion, so long turns look minutes
// idle), and the live bar label must follow the CURRENT model, not the historical
// top. Tier B lanes (fetched read-only, opt-in) replace the 5h estimate: a stated
// number beats a reconstruction.

test("limitsPanelLines: vendor-reported Claude lanes render as bars and REPLACE the 5h estimate", () => {
  const data = minimalData([]);
  const lines = limitsPanelLines(data, [], {
    height: 10,
    width: 110,
    nowMs: Date.parse("2026-07-18T04:30:00.000Z"),
    claudeLanes: [
      { kind: "session", percent: 41, resetsAt: "2026-07-18T08:30:00.000Z", scopeLabel: null },
      { kind: "weekly_all", percent: 59, resetsAt: "2026-07-20T12:00:00.000Z", scopeLabel: null },
      { kind: "weekly_scoped", percent: 32, resetsAt: "2026-07-20T12:00:00.000Z", scopeLabel: "Fable" },
    ],
  });
  const text = lines.join("\n");
  assert.ok(text.includes("CLAUDE SESSION") && text.includes("41% used"), "session lane");
  assert.ok(text.includes("CLAUDE WEEKLY") && text.includes("59% used"), "weekly lane");
  assert.ok(text.includes("CLAUDE · FABLE") && text.includes("32% used"), "per-model lane, scope label carried");
  // resets: 08:30 - 04:30 = 4h
  assert.ok(text.includes("resets in 4h"), `reset countdown from resetsAt, got: ${text.slice(0, 200)}`);
  assert.ok((text.match(/vendor-reported/g) ?? []).length >= 3, "every lane provenance-labeled");
  assert.ok(!text.includes("CLAUDE 5H"), "the estimate line yields to stated lanes — never both");
});

test("limitsPanelLines: fillP eases the bar fill without ever changing the % text", () => {
  const data = minimalData([]);
  const lanes = [{ kind: "session", percent: 80, resetsAt: null, scopeLabel: null }];
  const early = limitsPanelLines(data, [], { height: 4, width: 110, claudeLanes: lanes, fillP: 0.3 }).join("\n");
  const done = limitsPanelLines(data, [], { height: 4, width: 110, claudeLanes: lanes, fillP: 1 }).join("\n");
  const blocks = (t: string) => (t.match(/█/g) ?? []).length;
  assert.ok(blocks(early) < blocks(done), "mid-animation fill is shorter than settled fill");
  assert.ok(early.includes("80% used") && done.includes("80% used"), "the number is always the real number");
});

test("limitsPanelLines: a fetch failure renders the quiet note; the estimate stays", () => {
  const data = minimalData([]);
  const text = limitsPanelLines(data, [], { height: 6, width: 110, claudeNote: "claude: unavailable (http-error)" }).join("\n");
  assert.ok(text.includes("claude: unavailable (http-error)"), "failure is stated, not hidden");
  assert.ok(text.includes("CLAUDE 5H"), "no lanes -> the labeled estimate still serves");
});

test("liveSessionsFrom: the bar label follows the CURRENT model, not the historical top", () => {
  const live = liveSessionsFrom(
    [
      {
        key: "claude_code_x",
        tool: "Claude Code",
        model: "claude-opus-4-8", // historical top by tokens
        tokens: 900,
        context: { occupancyTokens: 100_000, model: "claude-fable-5" }, // running fable NOW
      },
    ],
    new Map([["claude_code_x", 100]]),
  );
  assert.equal(live[0].label, "claude-fable-5", "the label names what is burning on camera");
});

test("liveSessionsFrom seeding: a 5-minute-old session seeds by default (the 15m window)", () => {
  const now = Date.parse("2026-07-18T04:00:00.000Z");
  const live = liveSessionsFrom(
    [sess({ key: "claude_code_m", model: "claude-opus-4-8", tokens: 500, context: { occupancyTokens: 400_000, model: "claude-opus-4-8", at: "2026-07-18T03:55:00.000Z" } })],
    new Map([["claude_code_m", 500]]),
    { activeHarnesses: ["Claude Code"], nowMs: now },
  );
  assert.equal(live.length, 1, "message-completion cadence means minutes-old is still running");
  assert.equal(live[0].tokens, 0);
});

// ---- the deployment card (Marco 2026-07-18: Strava's shareable-workout analog) ------------------

import { composeDeploymentCard } from "../src/superStart.ts";

test("deployment card: all six Strava-style stats, formatted, on-camera figures only", () => {
  const lines = composeDeploymentCard({
    startedAtMs: Date.parse("2026-07-18T04:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-18T05:05:00.000Z"), // 65 min
    tokens: 12_400_000,
    spendUsd: 9.12,
    turns: 38,
    peakAgents: 4,
    harnesses: ["Claude Code", "Codex"],
    models: [
      { label: "claude-fable-5", tokens: 7_565_000 }, // 61%
      { label: "claude-opus-4-8", tokens: 3_844_000 }, // 31%
      { label: "gpt-5.5", tokens: 991_000 }, // 8%
    ],
    burns: [100, 900, 400, 1200, 300],
    peakCtx: [{ label: "claude-fable-5", pct: 54.2, inferred: true }],
  });
  const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(text.includes("DEPLOYMENT") && text.includes("1h 5m"), "title + duration");
  assert.ok(text.includes("12.4M tokens"), "tokens");
  assert.ok(text.includes("$9.12 est"), "est cost");
  assert.ok(text.includes("38 turns"), "turns");
  assert.ok(text.includes("4 agents peak"), "peak concurrency — the differentiator stat");
  assert.ok(text.includes("2 harnesses") && text.includes("3 models"), "harness + model counts");
  assert.ok(text.includes("fable-5 61%") && text.includes("opus-4-8 31%") && text.includes("gpt-5.5 8%"), "mix, desc, hand-computed shares");
  assert.ok(text.includes("~54% of context window"), "peak context with the inference tilde");
  assert.ok(text.includes("leaderboard.deployforward.dev"), "the brand line closes the card");
});

test("deployment card: an empty run earns no card, and singulars read correctly", () => {
  assert.deepEqual(
    composeDeploymentCard({ startedAtMs: 0, endedAtMs: 60_000, tokens: 0, spendUsd: null, turns: 0, peakAgents: 0, harnesses: [], models: [], burns: [], peakCtx: [] }),
    [],
    "zero tokens on camera -> no trophy",
  );
  const one = composeDeploymentCard({
    startedAtMs: 0, endedAtMs: 60_000, tokens: 500, spendUsd: null, turns: 1, peakAgents: 1,
    harnesses: ["Claude Code"], models: [{ label: "claude-opus-4-8", tokens: 500 }], burns: [500], peakCtx: [],
  }).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(one.includes("1 turn") && !one.includes("1 turns"), "singular turn");
  assert.ok(one.includes("1 agent peak") && one.includes("1 harness") && one.includes("1 model"), "singulars throughout");
  assert.ok(one.includes("est unpriced"), "unpriced stays labeled, never $0.00");
});
