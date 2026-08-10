import { test } from "node:test";
import assert from "node:assert/strict";
import { computeActivity, computeLoops, DEFAULT_GAP_MS, MIN_EVENT_ACTIVE_MS } from "../src/activity.ts";

const MIN = 60 * 1000;
/** A generous bar on humanly-plausible sustained throughput; the server-side plausibility gates are stricter and unpublished. */
const PLAUSIBLE_TOKENS_PER_SEC = 2000;

test("empty timestamps => all zero", () => {
  assert.deepEqual(computeActivity([]), { wallMs: 0, activeMs: 0, idleMs: 0 });
});

test("dense events within the gap threshold are all active, no idle", () => {
  const t0 = Date.parse("2026-06-28T10:00:00Z");
  const ts = [t0, t0 + 1 * MIN, t0 + 2 * MIN, t0 + 3 * MIN];
  const a = computeActivity(ts, DEFAULT_GAP_MS);
  assert.equal(a.idleMs, 0);
  // 3 one-minute gaps + a 30s tail
  assert.equal(a.activeMs, 3 * MIN + 30 * 1000);
});

test("a long gap beyond threshold becomes idle", () => {
  const t0 = Date.parse("2026-06-28T10:00:00Z");
  // 1 min active, then a 30 min gap (5 min credited active, 25 min idle), then nothing.
  const ts = [t0, t0 + 1 * MIN, t0 + 31 * MIN];
  const a = computeActivity(ts, DEFAULT_GAP_MS);
  assert.equal(a.idleMs, 25 * MIN);
  // active = 1 min (first gap) + 5 min (capped second gap) + 30s tail
  assert.equal(a.activeMs, 1 * MIN + 5 * MIN + 30 * 1000);
});

test("active + idle never exceeds wall clock", () => {
  const t0 = Date.parse("2026-06-28T10:00:00Z");
  const ts = [t0, t0 + 2 * MIN, t0 + 90 * MIN, t0 + 92 * MIN];
  const a = computeActivity(ts);
  assert.ok(a.activeMs + a.idleMs <= a.wallMs + 1);
});

test("single event credits a short tail, no idle", () => {
  const a = computeActivity([Date.parse("2026-06-28T10:00:00Z")]);
  assert.equal(a.idleMs, 0);
  assert.equal(a.activeMs, 30 * 1000);
});

// ---- RC-I: density floor for sparse / collapsed streams ---------------------

test("wallMs == activeMs + idleMs (dense stream unchanged by the floor)", () => {
  const t0 = Date.parse("2026-06-28T10:00:00Z");
  // gaps 1min, 1min, 30min — all well above the 1s floor, so the floor is inert and the
  // numbers match the pre-floor model exactly (regression guard for normal Claude streams).
  const ts = [t0, t0 + MIN, t0 + 2 * MIN, t0 + 32 * MIN];
  const a = computeActivity(ts, DEFAULT_GAP_MS);
  assert.equal(a.activeMs, 2 * MIN + 5 * MIN + 30 * 1000); // 2 dense gaps + capped 30-min gap + tail
  assert.equal(a.idleMs, 25 * MIN);
  assert.equal(a.wallMs, a.activeMs + a.idleMs);
});

test("collapsed sparse stream: per-event floor recovers active time so an honest rate is not superhuman", () => {
  // Real-shaped Codex rollout: a whole session flushed inside a ~200ms window (verified on the
  // corpus — 3/56 sessions collapse this way, every line timestamped). ~5200 events, ~8.1M fresh
  // tokens: a genuine ~few-hundred tok/s session. The pre-floor gap model credits only a 30s tail,
  // exploding the rate past the ceiling; the floor credits >=1s/event and recovers a defensible
  // lower-bound active time (matches the real file: ~5245s active -> ~1544 tok/s).
  const t0 = Date.parse("2026-06-17T04:45:03Z");
  const n = 5216;
  const freshTokens = 8_100_000;
  const ts: number[] = [];
  for (let i = 0; i < n; i++) ts.push(t0 + Math.floor((i * 200) / n)); // all within 200ms

  const before = computeActivity(ts, DEFAULT_GAP_MS, 0); // floor disabled == old behaviour
  const after = computeActivity(ts, DEFAULT_GAP_MS); // default 1s floor

  // Old model: ~30s of active time -> a wildly superhuman rate (the false positive).
  assert.ok(freshTokens / (before.activeMs / 1000) > PLAUSIBLE_TOKENS_PER_SEC * 50);
  // Floor lifts each of the (n-1) collapsed steps to >= MIN_EVENT_ACTIVE_MS.
  assert.ok(after.activeMs >= (n - 1) * MIN_EVENT_ACTIVE_MS);
  // Corrected rate now clears the server's superhuman ceiling.
  assert.ok(
    freshTokens / (after.activeMs / 1000) < PLAUSIBLE_TOKENS_PER_SEC,
    `corrected rate ${(freshTokens / (after.activeMs / 1000)).toFixed(0)} tok/s must be < ${PLAUSIBLE_TOKENS_PER_SEC}`,
  );
  assert.equal(after.wallMs, after.activeMs + after.idleMs);
});

test("floor still lets the rate ceiling catch genuine fabrication (few events, huge tokens)", () => {
  // A fabricated session: 100M fresh tokens over just 3 events. The floor credits at most a few
  // seconds, so the rate stays superhuman and the server's ceiling still excludes it.
  const t0 = Date.parse("2026-06-28T10:00:00Z");
  const a = computeActivity([t0, t0 + 10, t0 + 20], DEFAULT_GAP_MS);
  assert.ok(100_000_000 / (a.activeMs / 1000) > PLAUSIBLE_TOKENS_PER_SEC);
});

// ---- computeLoops -----------------------------------------------------------

test("loops: no human prompts => zero turns and zero loop", () => {
  const t0 = Date.parse("2026-06-28T10:00:00Z");
  assert.deepEqual(computeLoops([t0, t0 + MIN], []), { turns: 0, longestLoopMs: 0 });
});

test("loops: turns counts human prompts", () => {
  const t0 = Date.parse("2026-06-28T10:00:00Z");
  const human = [t0, t0 + 10 * MIN, t0 + 20 * MIN];
  const all = [...human, t0 + MIN, t0 + 11 * MIN];
  assert.equal(computeLoops(all, human).turns, 3);
});

test("loops: walking away does NOT count as an autonomous loop (idle excluded)", () => {
  const t0 = Date.parse("2026-06-28T10:00:00Z");
  // human prompt, 3 dense agent events (~90s active), then a 15h gap, then next human prompt.
  const human = [t0, t0 + 15 * 60 * MIN];
  const all = [t0, t0 + 30 * 1000, t0 + 60 * 1000, t0 + 90 * 1000, t0 + 15 * 60 * MIN];
  const loops = computeLoops(all, human, DEFAULT_GAP_MS);
  // The longest loop is the ~90s active burst, NOT the 15h the human was away.
  assert.equal(loops.longestLoopMs, 90 * 1000);
});

test("loops: a genuinely long continuous agent run is credited (active, capped per gap)", () => {
  const t0 = Date.parse("2026-06-28T10:00:00Z");
  // human prompt, then agent events every 1 min for 10 min (all within the gap threshold).
  const agent = Array.from({ length: 10 }, (_, i) => t0 + (i + 1) * MIN);
  const all = [t0, ...agent];
  const loops = computeLoops(all, [t0], DEFAULT_GAP_MS);
  assert.equal(loops.longestLoopMs, 10 * MIN); // 10 one-minute active gaps
});

test("loops: longest of multiple autonomous spans wins", () => {
  const t0 = Date.parse("2026-06-28T10:00:00Z");
  // span A after prompt#1: ~2 min; span B after prompt#2: ~4 min.
  const all = [
    t0, t0 + MIN, t0 + 2 * MIN, // prompt then 2 min
    t0 + 30 * MIN, // prompt #2 (after an idle gap, not counted)
    t0 + 31 * MIN, t0 + 32 * MIN, t0 + 33 * MIN, t0 + 34 * MIN, // 4 min active
  ];
  const human = [t0, t0 + 30 * MIN];
  assert.equal(computeLoops(all, human, DEFAULT_GAP_MS).longestLoopMs, 4 * MIN);
});
