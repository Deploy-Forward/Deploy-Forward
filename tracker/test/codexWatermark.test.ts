/**
 * RED tests (L5-codex, test-first): out-of-order cumulative-snapshot watermark guard.
 *
 * Codex rollouts report CUMULATIVE token_count totals; the parser diffs consecutive
 * snapshots to get per-turn deltas. Today codex.ts advances its baseline UNCONDITIONALLY
 * (last-row-wins), so an out-of-order/stale snapshot whose cumulative total momentarily
 * REGRESSES then recovers double-counts one increment. The guard under test (mirrors
 * tokscale codex.rs:182-188):
 *   - snapshotTotal >= prevWatermark            -> delta = snapshotTotal - prevWatermark,
 *                                                  watermark = snapshotTotal (normal progress)
 *   - prevWatermark*0.98 <= snapshotTotal < prevWatermark
 *                                               -> STALE out-of-order snapshot: delta = 0,
 *                                                  watermark HELD at prevWatermark (no reset)
 *   - snapshotTotal < prevWatermark*0.98        -> genuine reset / new-rollout boundary:
 *                                                  delta = 0, watermark = snapshotTotal
 * Plus: cached_input_tokens is INCLUSIVE-bounded by input_tokens, so a malformed snapshot
 * with cached > input must clamp cached = min(cached, input) on the parse path.
 *
 * codexDelta does not exist yet -- these tests MUST fail until the implementation lands.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexRollout, codexDelta } from "../src/codex.ts";

test("codexDelta: monotonic cumulative sequence yields simple diffs", () => {
  const totals = [0, 100, 250, 400];
  let watermark = 0;
  const deltas: number[] = [];
  for (const total of totals) {
    const r = codexDelta(watermark, total);
    if (r.delta > 0) deltas.push(r.delta);
    watermark = r.watermark;
  }
  assert.deepEqual(deltas, [100, 150, 150]);
  assert.equal(watermark, 400);
});

test("codexDelta: stale dip within 98% of the watermark is ignored and the watermark held", () => {
  // prev watermark 400; snapshot 398 (>= 400*0.98 = 392) is a stale out-of-order re-emit.
  const stale = codexDelta(400, 398);
  assert.equal(stale.delta, 0, "stale snapshot must contribute no delta");
  assert.equal(stale.watermark, 400, "watermark held -- never reset by a stale snapshot");
  // Recovery diffs against the HELD watermark, so the dip can never double-count.
  const next = codexDelta(stale.watermark, 420);
  assert.equal(next.delta, 20);
  assert.equal(next.watermark, 420);
});

test("codexDelta: dip exactly at the 98% boundary still counts as stale", () => {
  // 392 == 400 * 0.98 -- inclusive boundary: still stale, still held.
  const r = codexDelta(400, 392);
  assert.equal(r.delta, 0);
  assert.equal(r.watermark, 400);
});

test("codexDelta: a regression below 98% is a genuine reset -- adopt the new baseline", () => {
  // prev watermark 400; snapshot 10 (< 392) is a real reset / new-rollout boundary.
  const reset = codexDelta(400, 10);
  assert.equal(reset.delta, 0, "the reset snapshot itself contributes no delta");
  assert.equal(reset.watermark, 10, "watermark adopts the new baseline");
  // Progress after the reset diffs against the adopted baseline.
  const next = codexDelta(reset.watermark, 60);
  assert.equal(next.delta, 50);
  assert.equal(next.watermark, 60);
});

test("codexDelta: equal snapshot (duplicate re-emit) diffs to zero and holds the watermark", () => {
  const r = codexDelta(400, 400);
  assert.equal(r.delta, 0);
  assert.equal(r.watermark, 400);
});

test("codex: cached_input_tokens is clamped to input_tokens on the parse path", () => {
  // Malformed snapshot: cached (500) exceeds input (300). input_tokens is documented as
  // INCLUSIVE of cached, so cached must clamp to min(cached, input) = 300.
  const content = [
    JSON.stringify({ timestamp: "2026-06-17T11:21:51.000Z", type: "session_meta", payload: { id: "sess-clamp" } }),
    JSON.stringify({ timestamp: "2026-06-17T11:21:52.000Z", type: "turn_context", payload: { model: "gpt-5.5" } }),
    JSON.stringify({
      timestamp: "2026-06-17T11:22:10.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 500, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 400 } } },
    }),
  ].join("\n");
  const p = parseCodexRollout(content);
  assert.equal(p.tokens.cacheRead, 300, "cached clamped to input, not taken raw");
  assert.equal(p.tokens.input, 0, "fresh input = input - clamped cached = 0");
  assert.equal(p.tokens.output, 100);
});
