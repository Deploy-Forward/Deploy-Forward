/**
 * Day-attribution Fix A, tracker side: the slicer must mirror computeActivity's crediting
 * EXACTLY — conservation is asserted as an identity, never a tolerance — and slices must
 * land on the days the atoms actually touched (clock ruling 2026-07-13).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeActivity, sliceActivityByDay, utcDayKey, DEFAULT_GAP_MS } from "../src/activity.js";
import { buildDaySlices } from "../src/sync.js";
import type { TokenCounts } from "../src/types.js";

const D1 = "2026-07-12";
const MIDNIGHT = Date.parse("2026-07-13T00:00:00Z");

function sumSlices(m: Map<string, { activeMs: number; idleMs: number }>) {
  let activeMs = 0;
  let idleMs = 0;
  for (const s of m.values()) {
    activeMs += s.activeMs;
    idleMs += s.idleMs;
  }
  return { activeMs, idleMs };
}

test("slices sum EXACTLY to computeActivity — identity, not tolerance", () => {
  // A gnarly stream: dense bursts, a walk-away idle gap, and a midnight crossing.
  const ts = [
    MIDNIGHT - 2 * 3_600_000, // 22:00 D1
    MIDNIGHT - 2 * 3_600_000 + 30_000,
    MIDNIGHT - 90 * 60_000, // 22:30
    MIDNIGHT - 10 * 60_000, // 23:50 (after an 100-min idle gap)
    MIDNIGHT - 60_000, // 23:59
    MIDNIGHT + 5 * 60_000, // 00:05 D2 (6-min gap: 5min credited, 1min idle)
    MIDNIGHT + 20 * 60_000, // 00:20
  ];
  const activity = computeActivity(ts, DEFAULT_GAP_MS);
  const slices = sliceActivityByDay(ts, DEFAULT_GAP_MS);
  const sum = sumSlices(slices);
  assert.equal(sum.activeMs, activity.activeMs, "active conserves exactly");
  assert.equal(sum.idleMs, activity.idleMs, "idle conserves exactly");
  assert.deepEqual([...slices.keys()].sort(), [D1, "2026-07-13"], "both touched days, only touched days");
});

test("an ACTIVE quantum straddling midnight splits at the boundary", () => {
  // A 4-minute gap centered on midnight (under the 5-min credit ceiling): 2 min of
  // active belongs to each day; the 30s tail lands entirely on D2.
  const ts = [MIDNIGHT - 2 * 60_000, MIDNIGHT + 2 * 60_000];
  const slices = sliceActivityByDay(ts, DEFAULT_GAP_MS);
  assert.equal(slices.get(D1)!.activeMs, 2 * 60_000);
  assert.equal(slices.get("2026-07-13")!.activeMs, 2 * 60_000 + 30_000);
});

test("an IDLE remainder crossing midnight lands where the idleness actually was", () => {
  // A 10-minute gap centered on midnight EXCEEDS the 5-min ceiling: the first 5 min are
  // credited active — all before midnight, all D1 — and the 5-min idle remainder sits
  // entirely after midnight, on D2. Nothing active is invented on D2 beyond the tail.
  const ts = [MIDNIGHT - 5 * 60_000, MIDNIGHT + 5 * 60_000];
  const slices = sliceActivityByDay(ts, DEFAULT_GAP_MS);
  assert.equal(slices.get(D1)!.activeMs, 5 * 60_000);
  assert.equal(slices.get(D1)!.idleMs, 0);
  assert.equal(slices.get("2026-07-13")!.activeMs, 30_000, "tail only");
  assert.equal(slices.get("2026-07-13")!.idleMs, 5 * 60_000);
});

test("a single-day stream produces slices for one day only", () => {
  const base = Date.parse("2026-07-12T10:00:00Z");
  const slices = sliceActivityByDay([base, base + 60_000, base + 120_000], DEFAULT_GAP_MS);
  assert.deepEqual([...slices.keys()], [D1]);
});

const tok = (input: number): TokenCounts => ({ input, output: 0, cacheRead: 0, cacheCreation: 0 });

test("buildDaySlices: multi-day assembly carries per-day tokens and conserves them", () => {
  const activityDays = new Map([
    [D1, { activeMs: 4 * 3_600_000, idleMs: 0 }],
    ["2026-07-13", { activeMs: 2 * 3_600_000, idleMs: 60_000 }],
  ]);
  const tokensByDay = new Map([
    [D1, new Map([["opus", tok(600_000)]])],
    ["2026-07-13", new Map([["opus", tok(200_000)]])],
  ]);
  const days = buildDaySlices(activityDays, tokensByDay)!;
  assert.equal(days.length, 2);
  assert.equal(days[0].day, D1, "sorted ascending");
  assert.equal(days[0].tokens.input, 600_000);
  assert.equal(days[0].models?.[0]?.id, "opus");
  assert.equal(days[1].idleMs, 60_000);
  assert.equal(days[0].tokens.input + days[1].tokens.input, 800_000, "token conservation");
});

test("buildDaySlices: single-day returns undefined — byte-identity with legacy digests", () => {
  const activityDays = new Map([[D1, { activeMs: 3_600_000, idleMs: 0 }]]);
  const tokensByDay = new Map([[D1, new Map([["opus", tok(100)]])]]);
  assert.equal(buildDaySlices(activityDays, tokensByDay), undefined);
});

test("buildDaySlices: entries with unparseable timestamps anchor to the LAST touched day", () => {
  const activityDays = new Map([
    [D1, { activeMs: 1000, idleMs: 0 }],
    ["2026-07-13", { activeMs: 1000, idleMs: 0 }],
  ]);
  const tokensByDay = new Map([
    ["", new Map([["opus", tok(50)]])], // the orphan bucket
    [D1, new Map([["opus", tok(10)]])],
  ]);
  const days = buildDaySlices(activityDays, tokensByDay)!;
  assert.equal(days[1].day, "2026-07-13");
  assert.equal(days[1].tokens.input, 50, "orphans land on the anchor, not an invented date");
  assert.equal(days[0].tokens.input, 10);
});

test("utcDayKey buckets on the UTC clock", () => {
  assert.equal(utcDayKey(MIDNIGHT - 1), D1);
  assert.equal(utcDayKey(MIDNIGHT), "2026-07-13");
});
