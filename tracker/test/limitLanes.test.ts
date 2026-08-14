// limitLanes: ONE lane composition shared by the CLI and the localhost dashboard,
// so the two surfaces can never disagree about what a limit lane says (Marco
// 2026-08-13: "cross laterally, uniformly for CLI and localhost").
//
// Seams: composeLimitLanes (data -> LimitLane[], the replace-the-estimate rule
// lives HERE and only here) and limitLaneTextLines (LimitLane[] -> terminal
// lines with real bars).
import { test } from "node:test";
import assert from "node:assert/strict";

import { composeLimitLanes, limitLaneTextLines, type LimitLaneSource } from "../src/limitLanes.ts";

function src(overrides: Partial<LimitLaneSource> = {}): LimitLaneSource {
  return {
    codexLimits: { primary: { usedPercent: 37, windowMinutes: 300, resetsInSeconds: 1800 } },
    claudeLanes: null,
    claudeLanesNote: null,
    claude5h: { blockStartMs: 1000, lastEntryMs: 2000, tokensUsed: 55_000, active: true, resetMs: 3000 },
    grokCredits: { percent: 41, periodType: "USAGE_PERIOD_TYPE_WEEKLY", periodStart: null, periodEnd: null, tier: null, ts: 0 },
    ...overrides,
  };
}

test("composeLimitLanes: vendor Claude lanes carry real percents and REPLACE the estimate", () => {
  const lanes = composeLimitLanes(
    src({
      claudeLanes: [
        { kind: "session", group: "session", percent: 100, severity: "warning", resetsAt: "2026-08-13T05:00:00.000Z", scopeLabel: null },
        { kind: "weekly_all", group: "weekly", percent: 41, severity: "ok", resetsAt: "2026-08-18T00:00:00.000Z", scopeLabel: null },
        { kind: "weekly_fable", group: "weekly", percent: 7, severity: "ok", resetsAt: "2026-08-18T00:00:00.000Z", scopeLabel: "Fable" },
      ],
    }),
  );
  const labels = lanes.map((l) => l.label);
  assert.ok(labels.includes("Claude session"));
  assert.ok(labels.includes("Claude weekly"));
  assert.ok(labels.includes("Claude · Fable"));
  assert.ok(!labels.some((l) => l.includes("5h window")), "the estimate lane must be replaced");
  const session = lanes.find((l) => l.label === "Claude session")!;
  assert.equal(session.percent, 100);
  assert.equal(session.estimate, false);
});

test("composeLimitLanes: no vendor lanes -> the 5h estimate stays, with the failure note beside it", () => {
  const lanes = composeLimitLanes(src({ claudeLanesNote: "vendor lanes: token expired — run: claude login" }));
  const est = lanes.find((l) => l.label === "Claude 5h window")!;
  assert.equal(est.percent, null, "no vendor denominator -> no bar, ever");
  assert.equal(est.estimate, true);
  assert.match(est.detail, /estimate/);
  assert.match(est.detail, /token expired/);
});

test("composeLimitLanes: codex + grok lanes clamp percents into [0,100]", () => {
  const lanes = composeLimitLanes(
    src({
      codexLimits: { primary: { usedPercent: 250, windowMinutes: 300, resetsInSeconds: null } },
      grokCredits: { percent: -3, periodType: null, periodStart: null, periodEnd: null, tier: null, ts: 0 },
    }),
  );
  assert.equal(lanes.find((l) => l.label.startsWith("Codex"))!.percent, 100);
  assert.equal(lanes.find((l) => l.label === "Grok credits")!.percent, 0);
});

test("composeLimitLanes: Codex lanes are labeled by what the window IS, not primary/secondary", () => {
  // Marco 2026-08-14 ("we also want to serve 5-hour"): Codex's snapshots currently
  // report ONLY the weekly window (primary 10080m, secondary null — corpus-verified),
  // so a 5h lane cannot honestly exist today. What we CAN do: name lanes by their
  // window, so the moment Codex re-reports a 5h window it appears as "Codex 5h"
  // with zero code changes — and "168h window" stops hiding behind "primary".
  const lanes = composeLimitLanes(
    src({
      codexLimits: {
        primary: { usedPercent: 1, windowMinutes: 10080, resetsInSeconds: 147251 },
        secondary: { usedPercent: 37, windowMinutes: 300, resetsInSeconds: 1800 },
      },
    }),
  );
  const labels = lanes.map((l) => l.label);
  assert.ok(labels.includes("Codex weekly"), `weekly window labeled as such, got: ${labels.join(", ")}`);
  assert.ok(labels.includes("Codex 5h"), `5h window labeled as such, got: ${labels.join(", ")}`);
  assert.ok(!labels.some((l) => l.includes("primary") || l.includes("secondary")), "vendor jargon never reaches the user");
});

test("limitLaneTextLines: percent lanes render a real bar + detail; estimate lanes render text only", () => {
  const lines = limitLaneTextLines(
    [
      { label: "Claude session", percent: 50, detail: "50% used · resets 17:40", estimate: false },
      { label: "Claude 5h window", percent: null, detail: "55.0K tokens · window open · estimate", estimate: true },
    ],
    { barWidth: 10 },
  );
  assert.equal(lines.length, 2);
  // Half full at width 10: five filled cells, five empty, then the detail verbatim.
  assert.match(lines[0], /Claude session/);
  assert.match(lines[0], /█{5}░{5}/);
  assert.match(lines[0], /50% used · resets 17:40/);
  // The estimate lane must NOT carry bar glyphs — a bar with no denominator lies.
  assert.ok(!/[█░]/.test(lines[1]), "estimate lanes never render bar glyphs");
  assert.match(lines[1], /estimate/);
});
