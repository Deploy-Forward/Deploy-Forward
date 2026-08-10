/**
 * Grok CLI capture tests (G1, docs/grok-capture-plan.md) — hermetic fixtures built in
 * a temp dir shaped like the real ~/.grok (formats verified on-disk 2026-07-10).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractGrokInferences,
  scanGrokInferences,
  scanGrokCorpus,
  modelForInference,
  isOfficialGrokCli,
  summarizeGrokCorpus,
  grokSessionDirs,
} from "../src/grok.ts";
import type { TrackerState } from "../src/config.ts";

const STATE = { repoHmacKey: "test-key", gapMs: 5 * 60_000 } as unknown as TrackerState;

function infLine(ts: string, sid: string, prompt: number, cached: number, completion: number, reasoning: number): string {
  return JSON.stringify({
    ts, src: "shell", pid: 1, lvl: "info", sid,
    msg: "shell.turn.inference_done",
    ctx: { loop_index: 1, model_elapsed_ms: 100, prompt_tokens: prompt, cached_prompt_tokens: cached, completion_tokens: completion, reasoning_tokens: reasoning, tokens_per_sec: 1 },
  });
}

// ---------------------------------------------------------------------------
// extractGrokInferences
// ---------------------------------------------------------------------------

test("extractGrokInferences parses real counters and skips everything else", () => {
  const content = [
    infLine("2026-07-01T10:00:00.000Z", "sid-a", 11892, 7546, 195, 0),
    JSON.stringify({ ts: "2026-07-01T10:00:01Z", sid: "sid-a", msg: "model changed", ctx: { model: "grok-4.5" } }),
    // Pre-token-logging build: inference_done WITHOUT token fields -> skipped, never estimated
    JSON.stringify({ ts: "2026-06-07T10:00:00Z", sid: "sid-old", msg: "shell.turn.inference_done", ctx: { loop_index: 1 } }),
    "not json at all {{{",
    JSON.stringify({ ts: "not-a-date", sid: "sid-a", msg: "shell.turn.inference_done", ctx: { prompt_tokens: 1, completion_tokens: 1 } }),
  ].join("\n");
  const out = extractGrokInferences(content);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { ts: Date.parse("2026-07-01T10:00:00.000Z"), sid: "sid-a", prompt: 11892, cached: 7546, completion: 195, reasoning: 0 });
});

test("scanGrokInferences: drift counters cover candidate inference lines only (W1.5)", () => {
  const content = [
    infLine("2026-07-01T10:00:00.000Z", "sid-a", 100, 40, 20, 0), // real — counts toward total only
    // RENAMED token fields (the drift shape this counter exists for): parses, is an
    // inference record, but carries no prompt_tokens/completion_tokens -> unknown.
    JSON.stringify({ ts: "2026-07-01T10:01:00Z", sid: "sid-a", msg: "shell.turn.inference_done", ctx: { input_tokens: 5, output_tokens: 2 } }),
    // Pre-token-logging build line: indistinguishable from a rename -> unknown (documented caveat).
    JSON.stringify({ ts: "2026-06-07T10:00:00Z", sid: "sid-old", msg: "shell.turn.inference_done", ctx: { loop_index: 1 } }),
    // Inference record missing its session key -> unknown (shape drift).
    JSON.stringify({ ts: "2026-07-01T10:02:00Z", msg: "shell.turn.inference_done", ctx: { prompt_tokens: 1, completion_tokens: 1 } }),
    // Unparseable timestamp on an otherwise-real record -> unknown.
    JSON.stringify({ ts: "not-a-date", sid: "sid-a", msg: "shell.turn.inference_done", ctx: { prompt_tokens: 1, completion_tokens: 1 } }),
    // Corrupt CANDIDATE line (marker present, JSON broken) -> counted in both.
    '{"broken": "shell.turn.inference_done"',
    // Marker matched inside a KEY of some other event: parses, msg differs — NOT one of
    // our records, so neither counter moves.
    '{"msg":"other.event","shell.turn.inference_done":true}',
    // Non-candidate lines (the deliberate skip set): never in the denominator.
    JSON.stringify({ ts: "2026-07-01T10:00:01Z", sid: "sid-a", msg: "model changed", ctx: { model: "grok-4.5" } }),
    "not json at all {{{",
  ].join("\n");
  const scan = scanGrokInferences(content);
  assert.equal(scan.inferences.length, 1, "only the real line extracts");
  assert.equal(scan.totalLines, 6, "denominator = candidate inference lines only");
  assert.equal(scan.unknownLines, 5, "renamed fields, pre-logging, missing sid, bad ts, corrupt candidate");
  assert.deepEqual(extractGrokInferences(content), scan.inferences, "the thin wrapper extracts identically");
});

// ---------------------------------------------------------------------------
// modelForInference — deterministic turn-window attribution
// ---------------------------------------------------------------------------

test("modelForInference: latest turn_started at-or-before the inference owns it", () => {
  const turns = [
    { ts: 1000, modelId: "grok-4.3" },
    { ts: 5000, modelId: "grok-4.5" },
  ];
  assert.equal(modelForInference(turns, 3000, null), "grok-4.3");
  assert.equal(modelForInference(turns, 6000, null), "grok-4.5");
  assert.equal(modelForInference(turns, 4500, null), "grok-4.5"); // 2s skew tolerance
  assert.equal(modelForInference([], 6000, "grok-build"), "grok-build"); // summary fallback
  assert.equal(modelForInference([], 6000, null), "unknown"); // verbatim honesty, never guessed
});

// ---------------------------------------------------------------------------
// Fixture corpus: fingerprint + full summarize join
// ---------------------------------------------------------------------------

function buildFixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "df-grok-"));
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ base_url: "https://cli-chat-proxy.grok.com/v1" }));

  // Session A: two inferences across a model switch; session dir present.
  const encCwd = encodeURIComponent("C:\\Users\\m\\ola\\deploy-forward");
  const dirA = join(home, "sessions", encCwd, "sid-aaa");
  mkdirSync(dirA, { recursive: true });
  writeFileSync(join(dirA, "summary.json"), JSON.stringify({
    info: { id: "sid-aaa", cwd: "C:\\Users\\m\\ola\\deploy-forward" },
    created_at: "2026-07-01T09:59:00.000Z",
    current_model_id: "grok-4.5",
    num_chat_messages: 6,
  }));
  writeFileSync(join(dirA, "events.jsonl"), [
    JSON.stringify({ ts: "2026-07-01T10:00:00.000Z", type: "turn_started", session_id: "sid-aaa", turn_number: 0, model_id: "grok-4.3" }),
    JSON.stringify({ ts: "2026-07-01T10:01:00.000Z", type: "turn_ended", outcome: "completed" }),
    JSON.stringify({ ts: "2026-07-01T10:05:00.000Z", type: "turn_started", session_id: "sid-aaa", turn_number: 1, model_id: "grok-4.5" }),
    JSON.stringify({ ts: "2026-07-01T10:06:00.000Z", type: "turn_ended", outcome: "completed" }),
  ].join("\n"));

  // Session B: inference with NO session dir (metadata gone) -> model unknown, cwd absent.
  writeFileSync(join(home, "logs", "unified.jsonl"), [
    infLine("2026-07-01T10:00:30.000Z", "sid-aaa", 1000, 400, 50, 10),
    infLine("2026-07-01T10:05:30.000Z", "sid-aaa", 2000, 1500, 100, 20),
    infLine("2026-07-02T08:00:00.000Z", "sid-bbb", 500, 0, 25, 0),
    // pre-logging straggler: skipped
    JSON.stringify({ ts: "2026-06-07T08:00:00.000Z", sid: "sid-old", msg: "shell.turn.inference_done", ctx: {} }),
  ].join("\n"));
  return home;
}

test("isOfficialGrokCli: fingerprint gates capture", () => {
  const home = buildFixtureHome();
  try {
    assert.equal(isOfficialGrokCli(home), true);
    // No fingerprint marks -> refuse (community fork shares ~/.grok)
    const bare = mkdtempSync(join(tmpdir(), "df-grok-bare-"));
    try {
      mkdirSync(join(bare, "logs"), { recursive: true });
      writeFileSync(join(bare, "logs", "unified.jsonl"), "");
      assert.equal(isOfficialGrokCli(bare), false);
      // Marks but no token log -> nothing to capture either
      const noLog = mkdtempSync(join(tmpdir(), "df-grok-nolog-"));
      writeFileSync(join(noLog, "models_cache.json"), "cli-chat-proxy.grok.com");
      assert.equal(isOfficialGrokCli(noLog), false);
      rmSync(noLog, { recursive: true, force: true });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("summarizeGrokCorpus: joins tokens, model windows, cwd; skips pre-logging lines", () => {
  const home = buildFixtureHome();
  try {
    assert.equal(grokSessionDirs(home).size, 1);
    const out = summarizeGrokCorpus(STATE, home);
    assert.equal(out.length, 2);

    const a = out.find((s) => s.toolSessionId === "sid-aaa")!;
    assert.equal(a.tool, "grok");
    // Token mapping: input = prompt - cached; cacheRead = cached; output = completion.
    assert.deepEqual(a.tokens, { input: (1000 - 400) + (2000 - 1500), output: 150, cacheRead: 1900, cacheCreation: 0 });
    assert.equal(a.thinkingTokens, 30);
    // Model attribution: first inference in the grok-4.3 turn, second in the grok-4.5 turn.
    const byId = Object.fromEntries(a.models.map((m) => [m.id, m]));
    assert.equal(byId["grok-4.3"].output, 50);
    assert.equal(byId["grok-4.5"].output, 100);
    assert.equal(a.model, "grok-4.5"); // summary current_model_id
    assert.equal(a.messageCount, 6);
    assert.equal(a.cwd, "C:\\Users\\m\\ola\\deploy-forward");
    assert.ok(a.repoHash, "repoHash derives from cwd basename");
    assert.ok(a.turns >= 1);
    assert.ok(a.startedAt > 0 && a.endedAt >= a.startedAt);

    const b = out.find((s) => s.toolSessionId === "sid-bbb")!;
    assert.equal(b.models[0].id, "unknown"); // no session dir -> no model claim
    assert.equal(b.cwd, undefined);
    assert.equal(b.repoHash, null);
    assert.equal(b.messageCount, 1); // falls back to inference count

    // Determinism: identical re-parse -> identical records (digest gate relies on this).
    assert.deepEqual(summarizeGrokCorpus(STATE, home), out);

    // W1.5: the scanning API returns the same sessions plus the drift counters — the
    // fixture's one pre-logging straggler is the only unknown among 4 candidates.
    const scan = scanGrokCorpus(STATE, home);
    assert.deepEqual(scan.sessions, out);
    assert.equal(scan.totalLines, 4);
    assert.equal(scan.unknownLines, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanGrokCorpus: a missing/unreadable log yields empty sessions and zero counters", () => {
  const home = mkdtempSync(join(tmpdir(), "df-grok-noscan-"));
  try {
    assert.deepEqual(scanGrokCorpus(STATE, home), { sessions: [], unknownLines: 0, totalLines: 0 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// detectBeatTool (G3) — same hook command, two harnesses
// ---------------------------------------------------------------------------

import { detectBeatTool } from "../src/hooks.ts";

test("detectBeatTool: GROK_* env wins even when CLAUDE_PROJECT_DIR is also set", () => {
  assert.equal(detectBeatTool({}), "claude_code");
  assert.equal(detectBeatTool({ CLAUDE_PROJECT_DIR: "/x" }), "claude_code");
  // Grok sets CLAUDE_PROJECT_DIR as a compat alias on every hook — GROK_* must win.
  assert.equal(detectBeatTool({ GROK_HOOK_EVENT: "stop", CLAUDE_PROJECT_DIR: "/x" }), "grok");
  assert.equal(detectBeatTool({ GROK_SESSION_ID: "sid" }), "grok");
});
