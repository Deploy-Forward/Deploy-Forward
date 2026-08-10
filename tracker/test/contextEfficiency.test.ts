/**
 * Model-Use Efficiency fold (docs/model-use-efficiency.md). Hermetic: no network/admin/disk.
 *
 * The load-bearing cases pin the two regime endpoints with EXACT exponents: flat context
 * (constant per turn) is the linear ideal → alpha = 1, mue = 1; a context that grows by a
 * constant each turn is the quadratic pathology → alpha = 2. Plus: too-short refuses a
 * number, and sidechains never pollute the main-thread exponent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contextEfficiency, sessionMue } from "../src/contextEfficiency";
import type { TokenCounts } from "../src/types";

function e(ctx: number, out: number, isSidechain = false): { tokens: TokenCounts; isSidechain: boolean } {
  return { tokens: { input: ctx, output: out, cacheRead: 0, cacheCreation: 0 }, isSidechain };
}

test("flat context (disciplined) -> alpha = 1, mue = 1 (on the ideal line)", () => {
  // Constant per-turn context ⟹ cumulative context linear in turns ⟹ K ∝ O ⟹ alpha = 1.
  const r = contextEfficiency(Array.from({ length: 10 }, () => e(30_000, 1_000)))!;
  assert.ok(r, "enough points");
  assert.ok(Math.abs(r.alpha - 1) < 1e-9, `expected alpha 1, got ${r.alpha}`);
  assert.equal(r.ratio, 1); // c_floor·n == Σctx
  assert.equal(r.cActual, 300_000);
  assert.equal(r.cIdeal, 300_000);
  assert.equal(r.costPerOutput, 30);
  assert.equal(r.compactions, 0);
  assert.equal(r.points, 10);
});

test("constant-growth context (bloat) -> alpha = 2 (quadratic pathology)", () => {
  // C_t = (2t-1)·1000 ⟹ cumulative context = 1000·t², output cumulative = 1000·t ⟹ K ∝ O² ⟹ alpha = 2.
  const series = Array.from({ length: 10 }, (_, i) => e((2 * (i + 1) - 1) * 1_000, 1_000));
  const r = contextEfficiency(series)!;
  assert.ok(Math.abs(r.alpha - 2) < 1e-9, `expected alpha 2, got ${r.alpha}`);
  assert.equal(r.cActual, 100_000); // 1000·10²
  assert.equal(r.cIdeal, 10_000); // floor 1000 · 10
  assert.equal(r.ratio, 0.1); // 2x-ideal territory and then some
  assert.equal(r.costPerOutput, 10);
});

test("too few points -> null (never a confident exponent on a stub)", () => {
  assert.equal(contextEfficiency(Array.from({ length: 5 }, () => e(30_000, 1_000))), null);
});

test("no output -> null (no work produced, no ratio)", () => {
  assert.equal(contextEfficiency(Array.from({ length: 10 }, () => e(30_000, 0))), null);
});

test("compactions counted: a >50% drop from a substantial context", () => {
  const series = [
    e(50_000, 1_000), e(60_000, 1_000), e(25_000, 1_000), // drop 1 (60k->25k)
    e(30_000, 1_000), e(40_000, 1_000), e(15_000, 1_000), // drop 2 (40k->15k)
    e(18_000, 1_000), e(19_000, 1_000),                   // low wobble: not a compaction
  ];
  const r = contextEfficiency(series)!;
  assert.equal(r.points, 8);
  assert.equal(r.compactions, 2);
});

test("sidechains excluded: subagent context never pollutes the main-thread exponent", () => {
  const main = Array.from({ length: 10 }, () => e(30_000, 1_000));
  const withSidechains = [
    ...main.slice(0, 5),
    e(500_000, 50_000, true), // a subagent with a huge separate window
    e(9_000, 200, true),
    ...main.slice(5),
  ];
  assert.deepEqual(contextEfficiency(withSidechains), contextEfficiency(main));
});

// ---- sessionMue: the vendor-neutral seam every harness calls (sort-by-ts + null-guard) --------

/** A MueSeriesEntry: per-message tokens + a chronological key, the shape any harness produces. */
function m(ctx: number, out: number, ts: number | string | null, isSidechain = false) {
  return { tokens: { input: ctx, output: out, cacheRead: 0, cacheCreation: 0 }, ts, isSidechain };
}

test("sessionMue: sorts an out-of-order series by ts before fitting (order-independent alpha)", () => {
  // The flat alpha=1 series, but SHUFFLED. A harness whose per-message array is not pre-sorted
  // (Claude's global-dedup output, pi/openclaw's atoms.usage) must still recover alpha = 1.
  const ordered = Array.from({ length: 10 }, (_, i) => m(30_000, 1_000, i));
  const shuffled = [ordered[7], ordered[2], ordered[9], ordered[0], ordered[4], ordered[1], ordered[8], ordered[3], ordered[6], ordered[5]];
  const r = sessionMue(shuffled)!;
  assert.ok(Math.abs(r.alpha - 1) < 1e-9, `alpha ~1 after sort, got ${r.alpha}`);
  assert.equal(r.points, 10);
});

test("sessionMue: accepts ISO-string ts and Unix-ms ts alike (heterogeneous harness clocks)", () => {
  const iso = Array.from({ length: 10 }, (_, i) => m(30_000, 1_000, `2026-06-01T10:${String(i).padStart(2, "0")}:00.000Z`));
  assert.ok(Math.abs(sessionMue(iso)!.alpha - 1) < 1e-9);
});

test("sessionMue: null/absent ts keeps insertion order (stable), never throws", () => {
  const r = sessionMue(Array.from({ length: 10 }, () => m(30_000, 1_000, null)))!;
  assert.equal(r.points, 10);
  assert.ok(Math.abs(r.alpha - 1) < 1e-9);
});

test("sessionMue: returns undefined (not null) below MIN_POINTS — a scanner sets the optional field directly", () => {
  assert.equal(sessionMue(Array.from({ length: 5 }, (_, i) => m(30_000, 1_000, i))), undefined);
});

test("sessionMue: still excludes sidechains after the sort (delegates to the pure fold's filter)", () => {
  const main = Array.from({ length: 10 }, (_, i) => m(30_000, 1_000, i));
  const withSide = [...main, m(900_000, 90_000, 5.5, true)]; // interleaves at ts 5.5, must be dropped
  assert.deepEqual(sessionMue(withSide), sessionMue(main));
});
