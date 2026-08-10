/**
 * Unit tests for the Codex rollout parser. Verifies the cumulative-snapshot semantics and the
 * token mapping (input excludes cache-read; output already includes reasoning). Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexRollout } from "../src/codex.ts";

function line(o: unknown): string {
  return JSON.stringify(o);
}

const ROLLOUT = [
  line({ timestamp: "2026-06-17T11:21:51.000Z", type: "session_meta", payload: { id: "sess-xyz", cwd: "/repo" } }),
  line({ timestamp: "2026-06-17T11:21:52.000Z", type: "turn_context", payload: { model: "gpt-5.5" } }),
  line({ timestamp: "2026-06-17T11:22:00.000Z", type: "event_msg", payload: { type: "user_message" } }),
  // first cumulative snapshot
  line({
    timestamp: "2026-06-17T11:22:10.000Z",
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 1200 } } },
  }),
  line({ timestamp: "2026-06-17T11:25:00.000Z", type: "event_msg", payload: { type: "user_message" } }),
  // second (later) cumulative snapshot — THIS is the session total
  line({
    timestamp: "2026-06-17T11:25:30.000Z",
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 3000, output_tokens: 900, reasoning_output_tokens: 300, total_tokens: 5900 } } },
  }),
].join("\n");

test("codex: takes the LAST cumulative snapshot, not a sum", () => {
  const p = parseCodexRollout(ROLLOUT);
  assert.equal(p.toolSessionId, "sess-xyz");
  assert.equal(p.model, "gpt-5.5");
  // input_tokens(5000) is inclusive of cached(3000) -> fresh input = 2000
  assert.equal(p.tokens.input, 2000);
  // output_tokens already includes reasoning -> 900 (not 900+300)
  assert.equal(p.tokens.output, 900);
  assert.equal(p.tokens.cacheRead, 3000);
  assert.equal(p.tokens.cacheCreation, 0);
  assert.equal(p.thinkingTokens, 300, "reasoning tokens retained separately as status metadata");
  assert.equal(p.entryPoint, "cli");
});

test("codex: counts user_message turns and orders timestamps", () => {
  const p = parseCodexRollout(ROLLOUT);
  assert.equal(p.humanPromptTimestamps.length, 2, "two user_message turns");
  assert.ok(p.messageCount > 0, "token_count events keep the session from being dropped");
  assert.deepEqual([...p.timestamps].sort((a, b) => a - b), p.timestamps, "timestamps ascending");
});

test("codex: malformed lines are skipped, never fatal", () => {
  const p = parseCodexRollout("not json\n{bad\n" + ROLLOUT + "\n\n");
  assert.equal(p.skipped, 2, "two garbage lines counted as skipped");
  assert.equal(p.tokens.input, 2000, "valid lines still parse around the garbage");
  // W1.5 drift denominator: every non-blank line counts, blanks never do.
  assert.equal(p.totalLines, parseCodexRollout(ROLLOUT).totalLines + 2);
});

test("codex: per-turn deltas split buckets by model; duplicate re-emits never double-count", () => {
  // Mirrors the REAL rollout shape (verified 2026-07-01): each turn starts with a turn_context,
  // then RE-EMITS the previous token_count snapshot verbatim, then writes the new cumulative
  // snapshot. Deltas of total_token_usage must dodge the duplicates and land on the model
  // from the most recent turn_context.
  const tc = (ts: string, model: string) => line({ timestamp: ts, type: "turn_context", payload: { model } });
  const count = (ts: string, input: number, cached: number, output: number) =>
    line({
      timestamp: ts,
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } } },
    });
  const content = [
    line({ timestamp: "2026-06-17T11:21:51.000Z", type: "session_meta", payload: { id: "sess-mix" } }),
    // turn 1 (model A): 1000 input incl 400 cached, 200 output
    tc("2026-06-17T11:21:52.000Z", "gpt-5.5"),
    count("2026-06-17T11:22:10.000Z", 1000, 400, 200),
    // turn 2 (model A): duplicate re-emit, then +4000 input incl +2600 cached, +700 output
    tc("2026-06-17T11:23:00.000Z", "gpt-5.5"),
    count("2026-06-17T11:23:01.000Z", 1000, 400, 200), // re-emit of the previous snapshot
    count("2026-06-17T11:23:30.000Z", 5000, 3000, 900),
    // turn 3 (model B): duplicate re-emit, then +1000 input incl +800 cached, +100 output
    tc("2026-06-17T11:24:00.000Z", "gpt-5.5-codex"),
    count("2026-06-17T11:24:01.000Z", 5000, 3000, 900), // re-emit again
    count("2026-06-17T11:24:30.000Z", 6000, 3800, 1000),
  ].join("\n");

  const p = parseCodexRollout(content);
  // Session totals stay the last-cumulative-snapshot math (unchanged).
  assert.deepEqual(p.tokens, { input: 2200, output: 1000, cacheRead: 3800, cacheCreation: 0 });
  const byId = new Map(p.models.map((m) => [m.id, m]));
  assert.equal(p.models.length, 2);
  // model A: turns 1+2 -> fresh input (1000-400)+(4000-2600)=2000, cacheRead 3000, output 900
  assert.deepEqual(byId.get("gpt-5.5"), { id: "gpt-5.5", input: 2000, output: 900, cacheRead: 3000, cacheCreation: 0 });
  // model B: turn 3 -> fresh input 1000-800=200, cacheRead 800, output 100
  assert.deepEqual(byId.get("gpt-5.5-codex"), { id: "gpt-5.5-codex", input: 200, output: 100, cacheRead: 800, cacheCreation: 0 });
  // The buckets decompose the totals exactly.
  const sum = p.models.reduce(
    (acc, m) => ({ input: acc.input + m.input, output: acc.output + m.output, cacheRead: acc.cacheRead + m.cacheRead }),
    { input: 0, output: 0, cacheRead: 0 },
  );
  assert.deepEqual(sum, { input: p.tokens.input, output: p.tokens.output, cacheRead: p.tokens.cacheRead });
});

test("codex: single-model rollout buckets everything under that model", () => {
  const p = parseCodexRollout(ROLLOUT);
  assert.deepEqual(p.models, [{ id: "gpt-5.5", input: 2000, output: 900, cacheRead: 3000, cacheCreation: 0 }]);
});

test("codex: an empty / usage-less rollout yields zero (summarizeFile will drop it)", () => {
  const p = parseCodexRollout(line({ timestamp: "2026-06-17T11:21:51.000Z", type: "session_meta", payload: { id: "s" } }));
  assert.equal(p.messageCount, 0);
  assert.equal(p.tokens.input, 0);
});

test("codex: session_meta cwd is captured verbatim for local project attribution (usage --by-project)", () => {
  const p = parseCodexRollout(ROLLOUT);
  assert.equal(p.cwd, "/repo");
});

test("codex: cwd is undefined when session_meta carries none -- never fabricated", () => {
  const p = parseCodexRollout(line({ timestamp: "2026-06-17T11:21:51.000Z", type: "session_meta", payload: { id: "s" } }));
  assert.equal(p.cwd, undefined);
});

test("codex: usageEvents exposes each per-turn delta with its own timestamp, summing to the session totals", () => {
  const p = parseCodexRollout(ROLLOUT);
  assert.ok(p.usageEvents && p.usageEvents.length > 0);
  const sum = p.usageEvents!.reduce(
    (acc, e) => ({ input: acc.input + e.tokens.input, output: acc.output + e.tokens.output, cacheRead: acc.cacheRead + e.tokens.cacheRead }),
    { input: 0, output: 0, cacheRead: 0 },
  );
  assert.deepEqual(sum, { input: p.tokens.input, output: p.tokens.output, cacheRead: p.tokens.cacheRead });
  assert.ok(
    p.usageEvents!.every((e, i) => i === 0 || e.ts >= p.usageEvents![i - 1].ts),
    "events stay in file order (ascending timestamps)",
  );
});

test("codex: a duplicate re-emitted cumulative snapshot never adds a zero-delta usageEvent", () => {
  const content = [
    line({ timestamp: "2026-06-17T11:21:51.000Z", type: "session_meta", payload: { id: "sess-dup" } }),
    line({ timestamp: "2026-06-17T11:21:52.000Z", type: "turn_context", payload: { model: "gpt-5.5" } }),
    line({
      timestamp: "2026-06-17T11:22:10.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 } } },
    }),
    // exact re-emit of the same cumulative snapshot -- must NOT add a second event
    line({
      timestamp: "2026-06-17T11:22:20.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 } } },
    }),
  ].join("\n");
  const p = parseCodexRollout(content);
  assert.equal(p.usageEvents!.length, 1);
});
