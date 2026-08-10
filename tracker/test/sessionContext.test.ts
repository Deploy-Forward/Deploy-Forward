/**
 * Lane T2 (context capacity) — FAILING tests pinning `SessionSummary.context`, a field
 * that does NOT exist yet anywhere in src/. This file is deliberately RED: every
 * assertion below either reads `context` off a summary that has no such property (so it
 * is `undefined` at runtime, never matching the expected shape) or exercises a Codex
 * payload field (`info.last_token_usage`, `info.model_context_window`) the parser does
 * not read today. A separate implementation lane turns this green; nothing in src/ is
 * touched here.
 *
 * THE CONTRACT (not yet implemented):
 *   SessionSummary.context?: { occupancyTokens: number; model: string; windowTokens?: number; at?: string }
 *   - occupancyTokens = the LAST assistant turn's `input + cacheRead + cacheCreation`
 *     (contextEfficiency.ts's own per-turn cost formula, src/contextEfficiency.ts:70) —
 *     post-compaction reality: the LATEST turn wins, never the max over the session.
 *     RULED (coordinator, lane T2 addendum): "last" means the last entry with NONZERO
 *     occupancy — a literal-last all-zero tool-call snapshot (OpenClaw's known capture
 *     shape) is skipped, and if EVERY entry is zero-usage, `context` is undefined
 *     (honest absence), never a reported zero.
 *   - model = the model id attributed to that SAME last turn (not a copy of the
 *     session-level `model` field, which can legitimately differ — see the Grok/pi
 *     sections below, where the fixtures deliberately make them differ to catch a naive
 *     "just reuse session.model" implementation).
 *   - windowTokens = ONLY when the harness states its context-window size in the raw
 *     payload (Codex's `model_context_window`); absent for every other harness.
 *     Resolving a window size from a model-name registry is a RENDER-time concern, not
 *     this parser's job — never invented here.
 *   - at = that same last turn's own timestamp, as an ISO-8601 string (the field is
 *     typed `at?: string`, not a Unix-ms number). Every fixture below uses
 *     millisecond-precision `...Z` timestamps, so a `new Date(ms).toISOString()`
 *     round-trip reproduces the fixture's literal string exactly — there is no
 *     precision-loss ambiguity to resolve either way.
 *
 * Per-harness split (docs/harness-adapters-implementation.md's own split, restated):
 *   - Claude Code, Codex, Grok, pi, OpenClaw, Copilot: all expose PER-TURN usage, so
 *     `context` should be present.
 *   - opencode, Hermes: expose ONLY session-cumulative totals (no per-message token
 *     breakdown reachable without touching a forbidden content column — see each
 *     source file's own header, quoted in the section comments below). `context` must
 *     stay honestly ABSENT there, forever — never a smeared/estimated occupancy.
 *
 * NO EMOJIS (house style). Every numeric expectation is hand-computed in a comment next
 * to the fixture that produces it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { claudeLine } from "./fixtures.ts";
import { summarizeClaudeCorpus, summarizeFile } from "../src/sync.ts";
import { summarizeGrokCorpus } from "../src/grok.ts";
import { scanPiCorpus } from "../src/pi.ts";
import { scanOpenClawCorpus } from "../src/openclaw.ts";
import { scanCopilotCorpus } from "../src/copilot.ts";
import { scanOpencodeCorpus } from "../src/opencode.ts";
import { scanHermesCorpus } from "../src/hermes.ts";
import { PARSER_EPOCH, type TrackerState } from "../src/config.ts";

/** Lightweight state for the scan-style corpus functions (grok/pi/openclaw/copilot/
 * opencode/hermes/codex's summarizeFile) — mirrors every existing per-harness test file. */
const STATE = { repoHmacKey: "test-key", gapMs: 5 * 60_000 } as unknown as TrackerState;

/** Full TrackerState for summarizeClaudeCorpus, matching mueCapture.test.ts's testState(). */
function claudeState(): TrackerState {
  return {
    apiBase: "http://x",
    deviceToken: "t",
    uid: null,
    handle: null,
    repoHmacKey: "k".repeat(64),
    cursors: {},
    threadDigests: {},
    parserEpoch: PARSER_EPOCH,
    gapMs: 5 * 60 * 1000,
  } as unknown as TrackerState;
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// =============================================================================
// Claude Code — per-turn usage, main-thread series (src/contextEfficiency.ts).
// =============================================================================

test("Claude Code: context.occupancyTokens is the LAST assistant turn's input+cacheRead+cacheCreation, not the max; context.model is that turn's model", () => {
  // Three main-thread assistant turns, deliberately NOT monotone in size:
  //   turn1 (m1, claude-opus-4-8):   input=1000 cacheRead=200 cacheCreation=50  -> occ = 1000+200+50  = 1250
  //   turn2 (m2, claude-opus-4-8):   input=2000 cacheRead=300 cacheCreation=0   -> occ = 2000+300+0   = 2300  (the MAX — must NOT win)
  //   turn3 (m3, claude-sonnet-4-6): input=500  cacheRead=1500 cacheCreation=100 -> occ = 500+1500+100 = 2100  (the LAST — must win)
  const lines = [
    claudeLine({ sessionId: "s-ctx", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 1000, output: 500, cacheRead: 200, cacheCreation: 50 }),
    claudeLine({ sessionId: "s-ctx", ts: "2026-06-01T10:05:00.000Z", msgId: "m2", reqId: "r2", model: "claude-opus-4-8", input: 2000, output: 800, cacheRead: 300, cacheCreation: 0 }),
    claudeLine({ sessionId: "s-ctx", ts: "2026-06-01T10:10:00.000Z", msgId: "m3", reqId: "r3", model: "claude-sonnet-4-6", input: 500, output: 200, cacheRead: 1500, cacheCreation: 100 }),
  ];
  const proj = join(tmp("df-ctx-claude-"), "proj");
  mkdirSync(proj, { recursive: true });
  const path = join(proj, "s-ctx.jsonl");
  writeFileSync(path, lines.join("\n"));

  const [s] = summarizeClaudeCorpus([{ path, subagents: [] }], claudeState());
  const context = (s as unknown as { context?: { occupancyTokens: number; model: string; windowTokens?: number; at?: string } }).context;
  assert.ok(context, "SessionSummary.context is present for a Claude Code session with per-turn usage (RED: field does not exist yet)");
  assert.equal(context!.occupancyTokens, 2100, "last turn's own cost (500+1500+100), not turn2's larger 2300");
  assert.equal(context!.model, "claude-sonnet-4-6", "the LAST turn's own model");
  assert.equal(context!.at, "2026-06-01T10:10:00.000Z", "the LAST turn's own timestamp");
  assert.equal(context!.windowTokens, undefined, "Claude Code transcripts never state a context-window size");
});

// =============================================================================
// Codex — cumulative snapshots. Today src/codex.ts reads ONLY total_token_usage; this
// pins parsing of the SIBLING `info.last_token_usage` and `info.model_context_window`
// fields (verified real shape, src/usageView.ts:504-513 / src/codex.ts:9-19), currently
// not read at all.
// =============================================================================

test("Codex: context.occupancyTokens = the final snapshot's last_token_usage.input_tokens (full prompt, INCLUSIVE of cache -- not netted like tokens.input); windowTokens = model_context_window; model = the turn's model", () => {
  // Two token_count events. The FIRST is an old-style snapshot with only total_token_usage
  // (no last_token_usage / model_context_window at all) -- proves the final event's own
  // last_token_usage is what counts, not some running/first value.
  //   event1 total_token_usage: {input:100, cached:40, output:20, reasoning:5}  (no last_token_usage/window)
  //   event2 (FINAL) total_token_usage: {input:600, cached:200, output:150, reasoning:30}
  //          last_token_usage:          {input:500, cached:180, output:100, reasoning:20}
  //          model_context_window: 258400
  // input_tokens is documented INCLUSIVE of cached_input_tokens (src/codex.ts:14-18), so
  // occupancy = the raw last_token_usage.input_tokens = 500 (the full prompt as fed to the
  // model), UNLIKE tokens.input on the session total, which nets cache out (600-200=400).
  const lines = [
    JSON.stringify({ timestamp: "2026-06-17T11:21:51.000Z", type: "session_meta", payload: { id: "c-ctx" } }),
    JSON.stringify({ timestamp: "2026-06-17T11:21:52.000Z", type: "turn_context", payload: { model: "gpt-5.5" } }),
    JSON.stringify({
      timestamp: "2026-06-17T11:22:10.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } },
    }),
    JSON.stringify({ timestamp: "2026-06-17T11:23:00.000Z", type: "turn_context", payload: { model: "gpt-5.6" } }),
    JSON.stringify({
      timestamp: "2026-06-17T11:23:30.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 600, cached_input_tokens: 200, output_tokens: 150, reasoning_output_tokens: 30, total_tokens: 750 },
          last_token_usage: { input_tokens: 500, cached_input_tokens: 180, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 600 },
          model_context_window: 258400,
        },
      },
    }),
  ].join("\n");

  const dir = tmp("df-ctx-codex-");
  const path = join(dir, "rollout-c-ctx.jsonl");
  writeFileSync(path, lines);

  const s = summarizeFile(path, STATE, "codex");
  assert.ok(s, "the rollout has real usage and parses to a session");
  const context = (s as unknown as { context?: { occupancyTokens: number; model: string; windowTokens?: number; at?: string } }).context;
  assert.ok(context, "SessionSummary.context is present once last_token_usage/model_context_window are parsed (RED: not parsed today)");
  assert.equal(context!.occupancyTokens, 500, "last_token_usage.input_tokens, full prompt INCLUSIVE of cache");
  assert.equal(context!.windowTokens, 258400, "model_context_window passed through verbatim, no registry resolution");
  assert.equal(context!.model, "gpt-5.6", "the turn_context in force at the final snapshot");
  assert.equal(context!.at, "2026-06-17T11:23:30.000Z", "the final token_count event's own timestamp");
});

test("Codex: a rollout with NO last_token_usage/model_context_window anywhere yields context undefined -- fail-soft, never a guess", () => {
  const lines = [
    JSON.stringify({ timestamp: "2026-06-17T11:21:51.000Z", type: "session_meta", payload: { id: "c-noctx" } }),
    JSON.stringify({ timestamp: "2026-06-17T11:21:52.000Z", type: "turn_context", payload: { model: "gpt-5.5" } }),
    JSON.stringify({
      timestamp: "2026-06-17T11:22:10.000Z",
      type: "event_msg",
      // Old-style payload: total_token_usage only, exactly like every other codex.test.ts
      // fixture predating this contract -- no `last_token_usage`, no `model_context_window`.
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } },
    }),
  ].join("\n");

  const dir = tmp("df-ctx-codex-noinfo-");
  const path = join(dir, "rollout-c-noctx.jsonl");
  writeFileSync(path, lines);

  const s = summarizeFile(path, STATE, "codex");
  assert.ok(s, "the rollout still has real total_token_usage and parses to a session");
  const context = (s as unknown as { context?: unknown }).context;
  assert.equal(context, undefined, "no last_token_usage/model_context_window in the payload -- context must be absent, never fabricated from total_token_usage");
});

// =============================================================================
// Grok — inference_done lines, model attributed per turn window (modelForInference).
// =============================================================================

function grokInfLine(ts: string, sid: string, prompt: number, cached: number, completion: number, reasoning: number): string {
  return JSON.stringify({
    ts, src: "shell", pid: 1, lvl: "info", sid,
    msg: "shell.turn.inference_done",
    ctx: { loop_index: 1, model_elapsed_ms: 100, prompt_tokens: prompt, cached_prompt_tokens: cached, completion_tokens: completion, reasoning_tokens: reasoning, tokens_per_sec: 1 },
  });
}

function buildGrokFixtureHome(): string {
  const home = tmp("df-ctx-grok-");
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ base_url: "https://cli-chat-proxy.grok.com/v1" }));

  const cwd = "/repo/proj";
  const encCwd = encodeURIComponent(cwd);
  const dir = join(home, "sessions", encCwd, "sid-ctx");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), JSON.stringify({
    info: { id: "sid-ctx", cwd },
    created_at: "2026-07-01T09:59:00.000Z",
    // Deliberately DIFFERENT from the last turn's own attributed model (grok-4.5, below) --
    // proves context.model comes from the LAST TURN's own window, not a copy of this field.
    current_model_id: "grok-4.6",
    num_chat_messages: 4,
  }));
  writeFileSync(join(dir, "events.jsonl"), [
    JSON.stringify({ ts: "2026-07-01T10:00:00.000Z", type: "turn_started", session_id: "sid-ctx", turn_number: 0, model_id: "grok-4.3" }),
    JSON.stringify({ ts: "2026-07-01T10:01:00.000Z", type: "turn_ended", outcome: "completed" }),
    JSON.stringify({ ts: "2026-07-01T10:05:00.000Z", type: "turn_started", session_id: "sid-ctx", turn_number: 1, model_id: "grok-4.5" }),
    JSON.stringify({ ts: "2026-07-01T10:06:00.000Z", type: "turn_ended", outcome: "completed" }),
  ].join("\n"));

  writeFileSync(join(home, "logs", "unified.jsonl"), [
    // turn 0 (grok-4.3): prompt=5000 cached=1000 -> input=4000 cacheRead=1000 cacheCreation=0
    //   (grok never distinguishes cache creation) -> occupancy = 4000+1000+0 = 5000 (the MAX).
    grokInfLine("2026-07-01T10:00:30.000Z", "sid-ctx", 5000, 1000, 50, 10),
    // turn 1 (grok-4.5), LAST inference: prompt=3000 cached=1000 -> input=2000 cacheRead=1000
    //   -> occupancy = 2000+1000+0 = 3000 -- equals prompt_tokens directly, and is SMALLER
    //   than turn 0's 5000, proving "last wins, not max".
    grokInfLine("2026-07-01T10:05:30.000Z", "sid-ctx", 3000, 1000, 80, 5),
  ].join("\n"));
  return home;
}

test("Grok: context.occupancyTokens = last inference's prompt_tokens (input+cacheRead, cacheCreation always 0), not the max; context.model = the last turn's OWN attributed model", () => {
  const home = buildGrokFixtureHome();
  try {
    const out = summarizeGrokCorpus(STATE, home);
    const s = out.find((x) => x.toolSessionId === "sid-ctx")!;
    assert.ok(s, "fixture session parses");
    const context = (s as unknown as { context?: { occupancyTokens: number; model: string; windowTokens?: number; at?: string } }).context;
    assert.ok(context, "SessionSummary.context is present for a Grok session with per-inference usage (RED: field does not exist yet)");
    assert.equal(context!.occupancyTokens, 3000, "last inference's own cost (2000+1000+0), not turn 0's larger 5000");
    assert.equal(context!.model, "grok-4.5", "the last inference's OWN turn-window model, not summary.json's current_model_id (grok-4.6)");
    assert.equal(context!.at, "2026-07-01T10:05:30.000Z", "the last inference's own timestamp");
    assert.equal(context!.windowTokens, undefined, "Grok transcripts never state a context-window size");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// =============================================================================
// pi.dev — per-message usage, model attributed per model_change window.
// =============================================================================

function piHeaderLine(o: { id: string; ts: string; cwd: string }): string {
  return JSON.stringify({ type: "session", version: 3, id: o.id, timestamp: o.ts, cwd: o.cwd });
}
function piModelChangeLine(o: { id: string; ts: string; modelId: string }): string {
  return JSON.stringify({ type: "model_change", id: o.id, parentId: null, timestamp: o.ts, provider: "anthropic", modelId: o.modelId });
}
function piUserLine(o: { id: string; ts: string }): string {
  return JSON.stringify({ type: "message", id: o.id, parentId: null, timestamp: o.ts, message: { role: "user", content: [{ type: "text", text: "hi" }] } });
}
function piAssistantLine(o: { id: string; ts: string; model: string; input: number; output: number; cacheRead?: number; cacheWrite?: number }): string {
  return JSON.stringify({
    type: "message",
    id: o.id,
    parentId: null,
    timestamp: o.ts,
    message: {
      role: "assistant",
      provider: "anthropic",
      model: o.model,
      usage: {
        input: o.input,
        output: o.output,
        cacheRead: o.cacheRead ?? 0,
        cacheWrite: o.cacheWrite ?? 0,
        totalTokens: o.input + o.output,
      },
    },
  });
}
function writePiSessionFile(sessionsRoot: string, dirName: string, fileName: string, lines: string[]): void {
  const dir = join(sessionsRoot, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), lines.join("\n"));
}

test("pi: context.occupancyTokens = last assistant message's own input+cacheRead+cacheCreation, not the max; context.model = the last model_change window", () => {
  // turn1 (model-a): input=500  cacheRead=50   cacheWrite=10 -> occ = 500+50+10   = 560
  // turn2 (model-a): input=5000 cacheRead=1000 cacheWrite=0  -> occ = 5000+1000+0 = 6000  (the MAX)
  // turn3 (model-b, LAST, after a model_change): input=200 cacheRead=900 cacheWrite=20 -> occ = 200+900+20 = 1120
  const home = tmp("df-ctx-pi-");
  try {
    const sessionsRoot = join(home, "agent", "sessions");
    writePiSessionFile(sessionsRoot, "--home-m-proj--", "20260701_ctx.jsonl", [
      piHeaderLine({ id: "sess-ctx", ts: "2026-07-01T10:00:00.000Z", cwd: "/home/m/proj" }),
      piModelChangeLine({ id: "mc1", ts: "2026-07-01T10:00:01.000Z", modelId: "model-a" }),
      piUserLine({ id: "u1", ts: "2026-07-01T10:00:02.000Z" }),
      piAssistantLine({ id: "a1", ts: "2026-07-01T10:00:10.000Z", model: "model-a", input: 500, output: 100, cacheRead: 50, cacheWrite: 10 }),
      piAssistantLine({ id: "a2", ts: "2026-07-01T10:00:20.000Z", model: "model-a", input: 5000, output: 150, cacheRead: 1000, cacheWrite: 0 }),
      piModelChangeLine({ id: "mc2", ts: "2026-07-01T10:00:25.000Z", modelId: "model-b" }),
      piAssistantLine({ id: "a3", ts: "2026-07-01T10:00:30.000Z", model: "model-b", input: 200, output: 80, cacheRead: 900, cacheWrite: 20 }),
    ]);
    const [s] = scanPiCorpus(STATE, home).sessions;
    assert.ok(s, "fixture session parses");
    const context = (s as unknown as { context?: { occupancyTokens: number; model: string; windowTokens?: number; at?: string } }).context;
    assert.ok(context, "SessionSummary.context is present for a pi session with per-message usage (RED: field does not exist yet)");
    assert.equal(context!.occupancyTokens, 1120, "last turn's own cost (200+900+20), not turn2's larger 6000");
    assert.equal(context!.model, "model-b", "the model_change window in force at the last turn");
    assert.equal(context!.at, "2026-07-01T10:00:30.000Z", "the last turn's own timestamp");
    assert.equal(context!.windowTokens, undefined, "pi transcripts never state a context-window size");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// =============================================================================
// OpenClaw — per-message usage, model carried directly on each assistant message.
// =============================================================================

function ocSessionEvent(o: { id: string; ts: string; cwd?: string | null }): string {
  return JSON.stringify({ type: "session", version: 3, id: o.id, parentId: null, timestamp: o.ts, cwd: o.cwd ?? null });
}
function ocUserEvent(o: { id: string; ts: string }): string {
  return JSON.stringify({ type: "message", id: o.id, parentId: null, timestamp: o.ts, message: { role: "user", content: [{ type: "text", text: "hi" }] } });
}
function ocAssistantEvent(o: { id: string; ts: string; provider: string; model: string; input: number; output: number; cacheRead?: number; cacheWrite?: number }): string {
  return JSON.stringify({
    type: "message",
    id: o.id,
    parentId: null,
    timestamp: o.ts,
    message: {
      role: "assistant",
      provider: o.provider,
      model: o.model,
      usage: {
        input: o.input,
        output: o.output,
        cacheRead: o.cacheRead ?? 0,
        cacheWrite: o.cacheWrite ?? 0,
        totalTokens: o.input + o.output,
      },
    },
  });
}
function writeOpenClawSessionFile(home: string, agentId: string, sessionId: string, lines: string[]): void {
  const dir = join(home, "agents", agentId, "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n"));
}

test("OpenClaw: context.occupancyTokens = last assistant message's own input+cacheRead+cacheCreation, not the max; context.model = that message's own model", () => {
  // turn1 (anthropic/model-a): input=1000 cacheRead=100 cacheWrite=20 -> occ = 1000+100+20 = 1120
  // turn2 (anthropic/model-a): input=8000 cacheRead=500 cacheWrite=0  -> occ = 8000+500+0  = 8500  (the MAX)
  // turn3 (openai/model-b, LAST): input=300 cacheRead=1800 cacheWrite=0 -> occ = 300+1800+0 = 2100
  const home = tmp("df-ctx-openclaw-");
  try {
    writeOpenClawSessionFile(home, "coder", "sess-ctx", [
      ocSessionEvent({ id: "sess-ctx", ts: "2026-07-01T10:00:00.000Z", cwd: "/home/m/proj" }),
      ocUserEvent({ id: "u1", ts: "2026-07-01T10:00:01.000Z" }),
      ocAssistantEvent({ id: "a1", ts: "2026-07-01T10:00:10.000Z", provider: "anthropic", model: "model-a", input: 1000, output: 200, cacheRead: 100, cacheWrite: 20 }),
      ocAssistantEvent({ id: "a2", ts: "2026-07-01T10:00:20.000Z", provider: "anthropic", model: "model-a", input: 8000, output: 400, cacheRead: 500, cacheWrite: 0 }),
      ocAssistantEvent({ id: "a3", ts: "2026-07-01T10:00:30.000Z", provider: "openai", model: "model-b", input: 300, output: 50, cacheRead: 1800, cacheWrite: 0 }),
    ]);
    const [s] = scanOpenClawCorpus(STATE, home).sessions;
    assert.ok(s, "fixture session parses");
    const context = (s as unknown as { context?: { occupancyTokens: number; model: string; windowTokens?: number; at?: string } }).context;
    assert.ok(context, "SessionSummary.context is present for an OpenClaw session with per-message usage (RED: field does not exist yet)");
    assert.equal(context!.occupancyTokens, 2100, "last message's own cost (300+1800+0), not turn2's larger 8500");
    assert.equal(context!.model, "model-b", "the last assistant message's own model field");
    assert.equal(context!.at, "2026-07-01T10:00:30.000Z", "the last message's own timestamp");
    assert.equal(context!.windowTokens, undefined, "OpenClaw transcripts never state a context-window size");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("OpenClaw: a chronologically-LAST all-zero tool-call snapshot is skipped -- occupancy comes from the last NONZERO entry (coordinator ruling on ambiguity #3)", () => {
  // RULING: "last assistant turn" = the last entry with NONZERO occupancy
  // (input + cacheRead + cacheCreation > 0). The real 2026-07-14 OpenClaw corpus
  // (openclaw.test.ts's real-corpus shape pin, session 6756fe9b-...) records assistant
  // tool-call turns with ALL-ZERO usage; when such a snapshot is the chronologically
  // last message, reporting occupancy 0 would claim an empty context window on a
  // session that is actually deep into one -- a lie. Skip zero-tail entries.
  //
  // Fixture (the real-corpus shape with the zero tail LAST):
  //   a1 (openai/gpt-5.6-sol, NONZERO): input=868 cacheRead=18176 cacheWrite=0
  //      -> occ = 868+18176+0 = 19044  <- this entry wins
  //   tr1: toolResult plumbing (no tokens, never a candidate)
  //   a2 (openai/model-zero, LAST, ALL-ZERO): input=0 cacheRead=0 cacheWrite=0
  //      -> occ = 0 -- must be SKIPPED, and its model ("model-zero") must NOT be reported.
  const home = tmp("df-ctx-openclaw-zerotail-");
  try {
    writeOpenClawSessionFile(home, "main", "sess-zerotail", [
      ocSessionEvent({ id: "sess-zerotail", ts: "2026-07-14T16:21:55.000Z", cwd: "/home/m/proj" }),
      ocUserEvent({ id: "u1", ts: "2026-07-14T16:21:56.000Z" }),
      ocAssistantEvent({ id: "a1", ts: "2026-07-14T16:22:10.000Z", provider: "openai", model: "gpt-5.6-sol", input: 868, output: 5, cacheRead: 18176, cacheWrite: 0 }),
      JSON.stringify({
        type: "message", id: "tr1", parentId: "a1", timestamp: "2026-07-14T16:22:15.000Z",
        message: { role: "toolResult", toolCallId: "exec-1", toolName: "bash", isError: false, content: [{ type: "toolResult", text: "ok" }] },
      }),
      // The all-zero tool-call snapshot, chronologically LAST (usage present, all zeros --
      // a real recorded zero per the known capture limit, not drift).
      ocAssistantEvent({ id: "a2", ts: "2026-07-14T16:22:20.000Z", provider: "openai", model: "model-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ]);
    const [s] = scanOpenClawCorpus(STATE, home).sessions;
    assert.ok(s, "fixture session parses");
    const context = (s as unknown as { context?: { occupancyTokens: number; model: string; windowTokens?: number; at?: string } }).context;
    assert.ok(context, "SessionSummary.context is present -- a nonzero-occupancy entry exists (RED: field does not exist yet)");
    assert.equal(context!.occupancyTokens, 19044, "the last NONZERO entry's cost (868+18176+0), never the zero tail's 0");
    assert.equal(context!.model, "gpt-5.6-sol", "the nonzero entry's own model, not the zero tail's model-zero");
    assert.equal(context!.at, "2026-07-14T16:22:10.000Z", "the nonzero entry's own timestamp, not the zero tail's");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("OpenClaw: a session whose EVERY entry is zero-usage yields context undefined -- honest absence, never a reported zero occupancy", () => {
  // Same ruling, degenerate case: no entry has nonzero occupancy, so there is nothing
  // honest to report. The session itself still emits (an all-zero usage object is a real
  // recorded zero and resolves a usage atom -- src/openclaw.ts:738 only drops sessions
  // with NO usage atoms at all), but context must stay absent, never {occupancyTokens: 0}.
  const home = tmp("df-ctx-openclaw-allzero-");
  try {
    writeOpenClawSessionFile(home, "main", "sess-allzero", [
      ocSessionEvent({ id: "sess-allzero", ts: "2026-07-14T17:00:00.000Z", cwd: "/home/m/proj" }),
      ocUserEvent({ id: "u1", ts: "2026-07-14T17:00:01.000Z" }),
      ocAssistantEvent({ id: "a1", ts: "2026-07-14T17:00:10.000Z", provider: "openai", model: "gpt-5.6-sol", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      ocAssistantEvent({ id: "a2", ts: "2026-07-14T17:00:20.000Z", provider: "openai", model: "gpt-5.6-sol", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ]);
    const [s] = scanOpenClawCorpus(STATE, home).sessions;
    assert.ok(s, "the all-zero session still emits (zero usage atoms are real recorded zeros)");
    const context = (s as unknown as { context?: unknown }).context;
    assert.equal(context, undefined, "every entry has zero occupancy -- context is honestly absent, never a fabricated zero");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// =============================================================================
// Copilot — assistant_usage_events rows, ordered by turn_index (copilot.test.ts's own
// documented convention: "primary model = last event's model (turn_index order)").
// =============================================================================

function copilotSqliteModule(): { DatabaseSync: new (p: string, o?: object) => any } {
  return (process as unknown as { getBuiltinModule: (id: string) => any }).getBuiltinModule("node:sqlite");
}
function makeCopilotSchemaDb(dir: string): { path: string; db: any } {
  const path = join(dir, "session-store.db");
  const { DatabaseSync } = copilotSqliteModule();
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT,
      summary TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_index INTEGER, agent_id TEXT,
      parent_tool_call_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
      total_nano_aiu INTEGER, request_multiplier REAL, duration_ms INTEGER,
      time_to_first_token_ms INTEGER, inter_token_latency_ms INTEGER, initiator TEXT,
      api_endpoint TEXT, reasoning_effort TEXT, finish_reason TEXT,
      content_filter_triggered INTEGER, token_details_json TEXT, created_at TEXT
    );
  `);
  return { path, db };
}
function copilotInsertSession(db: any, id: string, cwd: string | null): void {
  db.prepare(`INSERT INTO sessions (id, cwd, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    id, cwd, null, "2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z",
  );
}
function copilotInsertEvent(
  db: any,
  r: { sessionId: string; turnIndex: number; model: string; input: number; output: number; cacheRead?: number; cacheWrite?: number; createdAt: string },
): void {
  db.prepare(
    `INSERT INTO assistant_usage_events
      (session_id, turn_index, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(r.sessionId, r.turnIndex, r.model, r.input, r.output, r.cacheRead ?? 0, r.cacheWrite ?? 0, r.createdAt);
}

test("Copilot: context.occupancyTokens = last (highest turn_index) event's own input+cacheRead+cacheCreation, not the max; context.model = that event's model", () => {
  // turn0 (gpt-5-mini):    input=2000 cacheRead=0   cacheWrite=0   -> occ = 2000+0+0     = 2000
  // turn1 (claude-opus-4-8): input=9000 cacheRead=500 cacheWrite=0  -> occ = 9000+500+0   = 9500  (the MAX)
  // turn2 (gpt-5.6, LAST):  input=1200 cacheRead=3000 cacheWrite=100 -> occ = 1200+3000+100 = 4300
  const home = tmp("df-ctx-copilot-");
  try {
    const { db } = makeCopilotSchemaDb(home);
    copilotInsertSession(db, "sess-ctx", "C:\\Users\\m\\proj");
    copilotInsertEvent(db, { sessionId: "sess-ctx", turnIndex: 0, model: "gpt-5-mini", input: 2000, output: 100, cacheRead: 0, cacheWrite: 0, createdAt: "2026-07-15T18:00:00.000Z" });
    copilotInsertEvent(db, { sessionId: "sess-ctx", turnIndex: 1, model: "claude-opus-4-8", input: 9000, output: 300, cacheRead: 500, cacheWrite: 0, createdAt: "2026-07-15T18:01:00.000Z" });
    copilotInsertEvent(db, { sessionId: "sess-ctx", turnIndex: 2, model: "gpt-5.6", input: 1200, output: 150, cacheRead: 3000, cacheWrite: 100, createdAt: "2026-07-15T18:02:00.000Z" });
    db.close();

    const [s] = scanCopilotCorpus(STATE, home).sessions;
    assert.ok(s, "fixture session parses");
    const context = (s as unknown as { context?: { occupancyTokens: number; model: string; windowTokens?: number; at?: string } }).context;
    assert.ok(context, "SessionSummary.context is present for a Copilot session with per-turn events (RED: field does not exist yet)");
    assert.equal(context!.occupancyTokens, 4300, "last event's own cost (1200+3000+100), not turn1's larger 9500");
    assert.equal(context!.model, "gpt-5.6", "the last (turn_index order) event's own model");
    assert.equal(context!.at, "2026-07-15T18:02:00.000Z", "the last event's own created_at");
    assert.equal(context!.windowTokens, undefined, "Copilot transcripts never state a context-window size");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// =============================================================================
// opencode — SESSION-CUMULATIVE ONLY. src/opencode.ts's own header: "the `message` table
// has NO per-message token columns... Per-message token/model/role granularity therefore
// lives ONLY inside [the forbidden] `data` column... this parser reads ONLY the `session`
// table's cumulative totals." There is no "last turn" to report — context must stay absent.
// =============================================================================

function opencodeSqliteModule(): any {
  return (process as unknown as { getBuiltinModule: (id: string) => any }).getBuiltinModule("node:sqlite");
}
function makeOpencodeDb(dir: string): { path: string; db: any } {
  const path = join(dir, "opencode.db");
  const db = new (opencodeSqliteModule().DatabaseSync)(path);
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, directory TEXT, title TEXT, model TEXT, cost REAL,
    tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
    tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER
  )`);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)`);
  return { path, db };
}

test("opencode: context is honestly UNDEFINED -- session-cumulative harness, no per-turn series to report a last-turn occupancy from", () => {
  const home = tmp("df-ctx-opencode-");
  try {
    const { db } = makeOpencodeDb(home);
    const t0 = Date.UTC(2026, 6, 12, 10, 0, 0);
    db.prepare(
      `INSERT INTO session (id, directory, title, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("sess-ctx", "/home/m/proj", null, JSON.stringify({ id: "model-a", providerID: "anthropic" }), 0, 1000, 200, 0, 100, 20, t0, t0 + 60_000);
    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`).run("m1", "sess-ctx", t0, t0, JSON.stringify({ role: "assistant" }));
    db.close();

    const [s] = scanOpencodeCorpus(STATE, home).sessions;
    assert.ok(s, "fixture session parses (cumulative totals are non-zero)");
    const context = (s as unknown as { context?: unknown }).context;
    assert.equal(context, undefined, "opencode exposes only session-cumulative tokens_* columns -- absence here is the HONEST behavior, never a smeared/estimated occupancy");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// =============================================================================
// Hermes — SESSION-CUMULATIVE ONLY. src/hermes.ts's own header: "messages.token_count ...
// NEITHER the source code NOR the published docs document what it represents for a
// user/assistant/tool row ... Tokens are therefore read ONLY at SESSION grain." Same
// honest-absence rule as opencode.
// =============================================================================

function hermesSqliteModule(): { DatabaseSync: new (p: string, o?: object) => any } {
  return (process as unknown as { getBuiltinModule: (id: string) => any }).getBuiltinModule("node:sqlite");
}
function makeHermesDb(dir: string): { path: string; db: any } {
  const path = join(dir, "state.db");
  const { DatabaseSync } = hermesSqliteModule();
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, model_config TEXT,
      system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL,
      end_reason TEXT, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0, cwd TEXT, title TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL, token_count INTEGER
    );
  `);
  return { path, db };
}

test("Hermes: context is honestly UNDEFINED -- session-cumulative harness, messages.token_count has no documented per-role split to build an occupancy formula from", () => {
  const home = tmp("df-ctx-hermes-");
  try {
    const { db } = makeHermesDb(home);
    const startedAt = Date.UTC(2026, 6, 12, 10, 0, 0) / 1000; // unix seconds
    db.prepare(
      `INSERT INTO sessions (id, source, model, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cwd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("sess-ctx", "cli", "hermes-4", startedAt, startedAt + 60, 1000, 200, 100, 20, 10, "/home/m/proj");
    db.prepare(`INSERT INTO messages (session_id, role, timestamp) VALUES (?, ?, ?)`).run("sess-ctx", "user", startedAt);
    db.prepare(`INSERT INTO messages (session_id, role, timestamp) VALUES (?, ?, ?)`).run("sess-ctx", "assistant", startedAt + 30);
    db.close();

    const [s] = scanHermesCorpus(STATE, home).sessions;
    assert.ok(s, "fixture session parses (session-grain counters are non-zero)");
    const context = (s as unknown as { context?: unknown }).context;
    assert.equal(context, undefined, "Hermes exposes only session-grain token counters -- absence here is the HONEST behavior, never a smeared/estimated occupancy");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
