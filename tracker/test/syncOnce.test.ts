/**
 * syncOnce integration: the corpus rebuild + per-thread digest gating + zero-token
 * overwrite, against a mocked ingest endpoint and a temp DF_HOME/corpus on disk.
 *
 * Covers acceptance criterion 5 at the client edge: re-syncing an unchanged corpus
 * uploads NOTHING (digests match), and a change to one file re-uploads ONLY the
 * threads whose summaries actually moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLine } from "./fixtures.ts";
import { PARSER_EPOCH, loadState, saveState } from "../src/config.ts";
import { syncOnce } from "../src/sync.ts";

test("syncOnce: global dedup + digest gating + zero-token overwrite + idempotent re-sync", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-home-"));
  const projects = mkdtempSync(join(tmpdir(), "df-projects-"));
  const proj = join(projects, "proj1");
  mkdirSync(proj, { recursive: true });

  // s-aaa: two real messages. s-bbb: a fork that ONLY replays them (same msgid+reqid).
  writeFileSync(
    join(proj, "s-aaa.jsonl"),
    [
      claudeLine({ sessionId: "s-aaa", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
      claudeLine({ sessionId: "s-aaa", ts: "2026-06-01T10:01:00.000Z", msgId: "m2", reqId: "r2", model: "claude-opus-4-8", input: 20, output: 10 }),
    ].join("\n"),
  );
  writeFileSync(
    join(proj, "s-bbb.jsonl"),
    [
      claudeLine({ sessionId: "s-bbb", ts: "2026-06-01T11:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
      claudeLine({ sessionId: "s-bbb", ts: "2026-06-01T11:01:00.000Z", msgId: "m2", reqId: "r2", model: "claude-opus-4-8", input: 20, output: 10 }),
    ].join("\n"),
  );

  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://mock.invalid/api",
      deviceToken: "test-token",
      uid: null,
      handle: null,
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
    }),
  );

  const prevEnv = {
    DF_HOME: process.env.DF_HOME,
    DF_CLAUDE_PROJECTS: process.env.DF_CLAUDE_PROJECTS,
    DF_CODEX_SESSIONS: process.env.DF_CODEX_SESSIONS,
    DF_GROK_HOME: process.env.DF_GROK_HOME,
    DF_PI_HOME: process.env.DF_PI_HOME,
    DF_OPENCLAW_HOME: process.env.DF_OPENCLAW_HOME,
    DF_OPENCODE_HOME: process.env.DF_OPENCODE_HOME,
    DF_HERMES_HOME: process.env.DF_HERMES_HOME,
    DF_COPILOT_HOME: process.env.DF_COPILOT_HOME,
    DF_GEMINI_HOME: process.env.DF_GEMINI_HOME,
  };
  process.env.DF_HOME = home;
  process.env.DF_CLAUDE_PROJECTS = projects;
  process.env.DF_CODEX_SESSIONS = join(projects, "no-codex-here");
  // Hermetic: without this, syncOnce would fingerprint the REAL ~/.grok on a dev
  // machine and fold its live corpus into the fixture pass (0.10.0 lesson).
  process.env.DF_GROK_HOME = join(projects, "no-grok-here");
  // Same lesson for pi: no DF_PI_HOME override would fingerprint a REAL ~/.pi.
  process.env.DF_PI_HOME = join(projects, "no-pi-here");
  // And a third time for waves 2/3 (2026-07-14): the day opencode's fingerprint stopped
  // requiring auth.json, the REAL ~/.local/share/opencode walked into the unpinned sites
  // of this file (4 uploads where 1 was asserted). Every discoverable home, every site.
  process.env.DF_OPENCLAW_HOME = join(projects, "no-openclaw-here");
  process.env.DF_OPENCODE_HOME = join(projects, "no-opencode-here");
  process.env.DF_HERMES_HOME = join(projects, "no-hermes-here");
  process.env.DF_COPILOT_HOME = join(projects, "no-copilot-here");
  // Same lesson for gemini (L14): no DF_GEMINI_HOME override would fingerprint a REAL ~/.gemini.
  process.env.DF_GEMINI_HOME = join(projects, "no-gemini-here");

  const calls: { sessions: any[] }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return { ok: true, json: async () => ({ accepted: body.sessions.length, flagged: 0 }) };
  }) as any;
  t.after(() => {
    globalThis.fetch = origFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k as keyof typeof prevEnv];
      else process.env[k] = v;
    }
  });

  // Pass 1: both threads upload — s-aaa with the full globally-deduped totals, s-bbb as
  // the ZEROED overwrite record (its every message deduped into s-aaa).
  const n1 = await syncOnce();
  assert.equal(n1, 2);
  assert.equal(calls.length, 1);
  const byId = new Map(calls[0].sessions.map((s: any) => [s.toolSessionId, s]));
  assert.deepEqual(byId.get("s-aaa")!.tokens, { input: 120, output: 60, cacheRead: 0, cacheCreation: 0 });
  assert.equal(byId.get("s-aaa")!.messageCount, 2, "owner carries its surviving message count");
  // The fork is a FULL tombstone on the wire: zero tokens AND zero activity atoms, with
  // messageCount 0 so the server's day fold skips it (no minted session/active day).
  assert.deepEqual(byId.get("s-bbb")!.tokens, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  assert.equal(byId.get("s-bbb")!.messageCount, 0);
  assert.equal(byId.get("s-bbb")!.turns, 0);
  assert.equal(byId.get("s-bbb")!.activeMs, 0);
  assert.equal(byId.get("s-bbb")!.wallMs, 0);

  // Pass 2: nothing changed — nothing uploads (cursors short-circuit the rebuild).
  const n2 = await syncOnce();
  assert.equal(n2, 0);
  assert.equal(calls.length, 1);

  // Pass 3: the fork gains one genuinely-new message — ONLY s-bbb re-uploads (s-aaa's
  // digest is unchanged), and its totals are exactly the new message.
  appendFileSync(
    join(proj, "s-bbb.jsonl"),
    "\n" + claudeLine({ sessionId: "s-bbb", ts: "2026-06-01T11:02:00.000Z", msgId: "m4", reqId: "r4", model: "claude-opus-4-8", input: 7, output: 3 }),
  );
  const n3 = await syncOnce();
  assert.equal(n3, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sessions.length, 1);
  assert.equal(calls[1].sessions[0].toolSessionId, "s-bbb");
  assert.deepEqual(calls[1].sessions[0].tokens, { input: 7, output: 3, cacheRead: 0, cacheCreation: 0 });
});

function codexLine(o: unknown): string {
  return JSON.stringify(o);
}

test("syncOnce: Codex uploads persist codex session digests for provider-aware status", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-home-codex-"));
  const codexRoot = mkdtempSync(join(tmpdir(), "df-codex-"));
  const day = join(codexRoot, "2026", "07", "05");
  mkdirSync(day, { recursive: true });
  const rollout = join(day, "rollout-2026-07-05T10-00-00-000Z-sess-codex.jsonl");
  writeFileSync(
    rollout,
    [
      codexLine({ timestamp: "2026-07-05T10:00:00.000Z", type: "session_meta", payload: { id: "sess-codex" } }),
      codexLine({ timestamp: "2026-07-05T10:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.5-codex" } }),
      codexLine({ timestamp: "2026-07-05T10:00:02.000Z", type: "event_msg", payload: { type: "user_message" } }),
      codexLine({
        timestamp: "2026-07-05T10:00:05.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } },
      }),
    ].join("\n"),
  );

  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://mock.invalid/api",
      deviceToken: "test-token",
      uid: null,
      handle: null,
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
    }),
  );

  const prevEnv = {
    DF_HOME: process.env.DF_HOME,
    DF_CLAUDE_PROJECTS: process.env.DF_CLAUDE_PROJECTS,
    DF_CODEX_SESSIONS: process.env.DF_CODEX_SESSIONS,
    DF_GROK_HOME: process.env.DF_GROK_HOME,
    DF_PI_HOME: process.env.DF_PI_HOME,
    DF_OPENCLAW_HOME: process.env.DF_OPENCLAW_HOME,
    DF_OPENCODE_HOME: process.env.DF_OPENCODE_HOME,
    DF_HERMES_HOME: process.env.DF_HERMES_HOME,
    DF_COPILOT_HOME: process.env.DF_COPILOT_HOME,
    DF_GEMINI_HOME: process.env.DF_GEMINI_HOME,
  };
  process.env.DF_HOME = home;
  process.env.DF_CLAUDE_PROJECTS = join(codexRoot, "no-claude-here");
  process.env.DF_CODEX_SESSIONS = codexRoot;
  process.env.DF_GROK_HOME = join(codexRoot, "no-grok-here"); // hermetic vs a real ~/.grok
  process.env.DF_PI_HOME = join(codexRoot, "no-pi-here"); // hermetic vs a real ~/.pi
  process.env.DF_OPENCLAW_HOME = join(codexRoot, "no-openclaw-here"); // hermetic vs real wave-2/3 homes
  process.env.DF_OPENCODE_HOME = join(codexRoot, "no-opencode-here");
  process.env.DF_HERMES_HOME = join(codexRoot, "no-hermes-here");
  process.env.DF_COPILOT_HOME = join(codexRoot, "no-copilot-here");
  process.env.DF_GEMINI_HOME = join(codexRoot, "no-gemini-here"); // hermetic vs a real ~/.gemini

  const calls: { sessions: any[] }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return { ok: true, json: async () => ({ accepted: body.sessions.length, flagged: 0 }) };
  }) as any;
  t.after(() => {
    globalThis.fetch = origFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k as keyof typeof prevEnv];
      else process.env[k] = v;
    }
  });

  const n1 = await syncOnce();
  assert.equal(n1, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessions[0].tool, "codex");
  assert.equal(calls[0].sessions[0].toolSessionId, "sess-codex");
  assert.deepEqual(calls[0].sessions[0].tokens, { input: 60, output: 20, cacheRead: 40, cacheCreation: 0 });

  const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  assert.ok(state.threadDigests["codex_sess-codex"], "Codex session digest is persisted for monitor/status counts");

  const n2 = await syncOnce();
  assert.equal(n2, 0);
  assert.equal(calls.length, 1, "unchanged Codex rollout no-ops after cursor+digest persistence");
});

// ---- pi (W1.3): fixture line builders, synthesized from the docs-derived schema in
// src/pi.ts's header (same shapes as pi.test.ts's builders -- no real ~/.pi is read).
function piHeaderLine(o: { id: string; ts: string; cwd: string }): string {
  return JSON.stringify({ type: "session", version: 3, id: o.id, timestamp: o.ts, cwd: o.cwd });
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
      usage: { input: o.input, output: o.output, cacheRead: o.cacheRead ?? 0, cacheWrite: o.cacheWrite ?? 0, totalTokens: o.input + o.output },
    },
  });
}
function grokInfLine(ts: string, sid: string, prompt: number, cached: number, completion: number, reasoning: number): string {
  return JSON.stringify({
    ts, src: "shell", pid: 1, lvl: "info", sid,
    msg: "shell.turn.inference_done",
    ctx: { loop_index: 1, model_elapsed_ms: 100, prompt_tokens: prompt, cached_prompt_tokens: cached, completion_tokens: completion, reasoning_tokens: reasoning, tokens_per_sec: 1 },
  });
}

test("syncOnce: pi ingests alongside Claude/Codex/Grok; digest gate + grown-file re-parse", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-home-pi-"));
  const projects = mkdtempSync(join(tmpdir(), "df-projects-pi-"));

  // Claude: one thread.
  const proj = join(projects, "proj1");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "s-cl.jsonl"),
    claudeLine({ sessionId: "s-cl", ts: "2026-07-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
  );

  // Codex: one rollout.
  const codexRoot = mkdtempSync(join(tmpdir(), "df-codex-pi-"));
  const day = join(codexRoot, "2026", "07", "05");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, "rollout-2026-07-05T10-00-00-000Z-sess-cx.jsonl"),
    [
      codexLine({ timestamp: "2026-07-05T10:00:00.000Z", type: "session_meta", payload: { id: "sess-cx" } }),
      codexLine({ timestamp: "2026-07-05T10:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.5-codex" } }),
      codexLine({
        timestamp: "2026-07-05T10:00:05.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } },
      }),
    ].join("\n"),
  );

  // Grok: fingerprint mark + one token-accounted inference in the unified log.
  const grokHome = mkdtempSync(join(tmpdir(), "df-grok-pi-"));
  mkdirSync(join(grokHome, "logs"), { recursive: true });
  writeFileSync(join(grokHome, "models_cache.json"), JSON.stringify({ base_url: "https://cli-chat-proxy.grok.com/v1" }));
  writeFileSync(join(grokHome, "logs", "unified.jsonl"), grokInfLine("2026-07-01T10:00:30.000Z", "sid-g1", 1000, 400, 50, 10));

  // pi: TWO session files under one --cwd-- dir (the second grows in pass 3).
  const piHome = mkdtempSync(join(tmpdir(), "df-pi-sync-"));
  const piDir = join(piHome, "agent", "sessions", "--home-m-proj--");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "20260701_p1.jsonl"),
    [
      piHeaderLine({ id: "sess-p1", ts: "2026-07-01T10:00:00.000Z", cwd: "/home/m/proj" }),
      piUserLine({ id: "u1", ts: "2026-07-01T10:00:01.000Z" }),
      piAssistantLine({ id: "a1", ts: "2026-07-01T10:00:10.000Z", model: "model-a", input: 100, output: 50, cacheRead: 20, cacheWrite: 5 }),
    ].join("\n"),
  );
  const piGrowing = join(piDir, "20260702_p2.jsonl");
  writeFileSync(
    piGrowing,
    [
      piHeaderLine({ id: "sess-p2", ts: "2026-07-02T10:00:00.000Z", cwd: "/home/m/proj" }),
      piUserLine({ id: "u2", ts: "2026-07-02T10:00:01.000Z" }),
      piAssistantLine({ id: "b1", ts: "2026-07-02T10:00:10.000Z", model: "model-a", input: 40, output: 20 }),
    ].join("\n"),
  );

  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://mock.invalid/api",
      deviceToken: "test-token",
      uid: null,
      handle: null,
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
    }),
  );

  const prevEnv = {
    DF_HOME: process.env.DF_HOME,
    DF_CLAUDE_PROJECTS: process.env.DF_CLAUDE_PROJECTS,
    DF_CODEX_SESSIONS: process.env.DF_CODEX_SESSIONS,
    DF_GROK_HOME: process.env.DF_GROK_HOME,
    DF_PI_HOME: process.env.DF_PI_HOME,
    DF_OPENCLAW_HOME: process.env.DF_OPENCLAW_HOME,
    DF_OPENCODE_HOME: process.env.DF_OPENCODE_HOME,
    DF_HERMES_HOME: process.env.DF_HERMES_HOME,
    DF_COPILOT_HOME: process.env.DF_COPILOT_HOME,
    DF_GEMINI_HOME: process.env.DF_GEMINI_HOME,
  };
  process.env.DF_HOME = home;
  process.env.DF_CLAUDE_PROJECTS = projects;
  process.env.DF_CODEX_SESSIONS = codexRoot;
  process.env.DF_GROK_HOME = grokHome;
  process.env.DF_PI_HOME = piHome;
  process.env.DF_OPENCLAW_HOME = join(codexRoot, "no-openclaw-here"); // hermetic vs real wave-2/3 homes
  process.env.DF_OPENCODE_HOME = join(codexRoot, "no-opencode-here");
  process.env.DF_HERMES_HOME = join(codexRoot, "no-hermes-here");
  process.env.DF_COPILOT_HOME = join(codexRoot, "no-copilot-here");
  process.env.DF_GEMINI_HOME = join(codexRoot, "no-gemini-here"); // hermetic vs a real ~/.gemini

  const calls: { sessions: any[] }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return { ok: true, json: async () => ({ accepted: body.sessions.length, flagged: 0 }) };
  }) as any;
  t.after(() => {
    globalThis.fetch = origFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k as keyof typeof prevEnv];
      else process.env[k] = v;
    }
  });

  // Pass 1: all four providers ingest in ONE pass.
  const n1 = await syncOnce();
  assert.equal(n1, 5, "1 Claude + 1 Codex + 1 Grok + 2 pi sessions");
  assert.equal(calls.length, 1);
  const tools = new Set(calls[0].sessions.map((s: any) => s.tool));
  assert.deepEqual([...tools].sort(), ["claude_code", "codex", "grok", "pi"]);
  const byId = new Map(calls[0].sessions.map((s: any) => [s.toolSessionId, s]));
  const p1 = byId.get("sess-p1")!;
  assert.equal(p1.tool, "pi");
  assert.deepEqual(p1.tokens, { input: 100, output: 50, cacheRead: 20, cacheCreation: 5 });
  const p2 = byId.get("sess-p2")!;
  assert.deepEqual(p2.tokens, { input: 40, output: 20, cacheRead: 0, cacheCreation: 0 });

  // pi persists PER-FILE cursors (the Codex/Claude idiom, not Grok's single-log one)
  // and `pi_<sessionId>` digests for the provider-aware monitor/status counts.
  const state1 = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  assert.ok(state1.threadDigests["pi_sess-p1"]);
  assert.ok(state1.threadDigests["pi_sess-p2"]);
  const piCursorPaths = Object.keys(state1.cursors).filter((p) => p.includes("--home-m-proj--"));
  assert.equal(piCursorPaths.length, 2, "one byte cursor per pi session file");

  // W1.5 drift plumbing: the pass persists per-provider scan health (unknown/total
  // line counters) for every provider that actually re-scanned — all four here. The
  // fixtures are clean, so unknownLines is 0 everywhere; totalLines proves the
  // counters rode the same scan that produced the sessions (never a second parse).
  assert.deepEqual(Object.keys(state1.scanHealth).sort(), ["claude_code", "codex", "grok", "pi"]);
  for (const key of ["claude_code", "codex", "grok", "pi"]) {
    assert.equal(state1.scanHealth[key].unknownLines, 0, `${key}: clean fixture scans zero unknown`);
    assert.ok(state1.scanHealth[key].totalLines > 0, `${key}: the denominator covers the scanned lines`);
    assert.ok(state1.scanHealth[key].at > 0);
  }

  // Pass 2: nothing changed -- the digest gate uploads NOTHING for pi (or anyone).
  const n2 = await syncOnce();
  assert.equal(n2, 0);
  assert.equal(calls.length, 1);
  // Cursor-skipped providers KEEP their last real scan health (never a fake zero).
  const state2 = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  assert.deepEqual(Object.keys(state2.scanHealth).sort(), ["claude_code", "codex", "grok", "pi"]);

  // Pass 3: the LATEST pi session file grows during use -- it re-parses, and ONLY the
  // grown session re-uploads (the byte-unchanged sess-p1 stays digest-gated).
  appendFileSync(
    piGrowing,
    "\n" + piAssistantLine({ id: "b2", ts: "2026-07-02T10:01:00.000Z", model: "model-a", input: 7, output: 3 }),
  );
  const n3 = await syncOnce();
  assert.equal(n3, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sessions.length, 1);
  assert.equal(calls[1].sessions[0].tool, "pi");
  assert.equal(calls[1].sessions[0].toolSessionId, "sess-p2");
  assert.deepEqual(calls[1].sessions[0].tokens, { input: 47, output: 23, cacheRead: 0, cacheCreation: 0 });
});

test("syncOnce: an unfingerprinted ~/.pi contributes nothing and the pass still succeeds", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-home-pi-nofp-"));
  const projects = mkdtempSync(join(tmpdir(), "df-projects-pi-nofp-"));
  const proj = join(projects, "proj1");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "s-cl.jsonl"),
    claudeLine({ sessionId: "s-cl", ts: "2026-07-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 10, output: 5 }),
  );

  // A pi home WITHOUT the official structural mark: the session dir lacks the
  // documented --cwd-- wrapping, so isOfficialPiCli refuses and no file is parsed --
  // even though a perfectly parseable session sits right there (never guess which
  // product wrote a file).
  const piHome = mkdtempSync(join(tmpdir(), "df-pi-nofp-"));
  const strangerDir = join(piHome, "agent", "sessions", "home-m-proj");
  mkdirSync(strangerDir, { recursive: true });
  writeFileSync(
    join(strangerDir, "20260701_x.jsonl"),
    [
      piHeaderLine({ id: "sess-stranger", ts: "2026-07-01T10:00:00.000Z", cwd: "/home/m/proj" }),
      piAssistantLine({ id: "a1", ts: "2026-07-01T10:00:10.000Z", model: "model-a", input: 999, output: 999 }),
    ].join("\n"),
  );

  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://mock.invalid/api",
      deviceToken: "test-token",
      uid: null,
      handle: null,
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
    }),
  );

  const prevEnv = {
    DF_HOME: process.env.DF_HOME,
    DF_CLAUDE_PROJECTS: process.env.DF_CLAUDE_PROJECTS,
    DF_CODEX_SESSIONS: process.env.DF_CODEX_SESSIONS,
    DF_GROK_HOME: process.env.DF_GROK_HOME,
    DF_PI_HOME: process.env.DF_PI_HOME,
    DF_OPENCLAW_HOME: process.env.DF_OPENCLAW_HOME,
    DF_OPENCODE_HOME: process.env.DF_OPENCODE_HOME,
    DF_HERMES_HOME: process.env.DF_HERMES_HOME,
    DF_COPILOT_HOME: process.env.DF_COPILOT_HOME,
    DF_GEMINI_HOME: process.env.DF_GEMINI_HOME,
  };
  process.env.DF_HOME = home;
  process.env.DF_CLAUDE_PROJECTS = projects;
  process.env.DF_CODEX_SESSIONS = join(projects, "no-codex-here");
  process.env.DF_GROK_HOME = join(projects, "no-grok-here");
  process.env.DF_PI_HOME = piHome;
  process.env.DF_OPENCLAW_HOME = join(projects, "no-openclaw-here"); // hermetic vs real wave-2/3 homes
  process.env.DF_OPENCODE_HOME = join(projects, "no-opencode-here");
  process.env.DF_HERMES_HOME = join(projects, "no-hermes-here");
  process.env.DF_COPILOT_HOME = join(projects, "no-copilot-here");
  // Same lesson for gemini (L14): no DF_GEMINI_HOME override would fingerprint a REAL ~/.gemini.
  process.env.DF_GEMINI_HOME = join(projects, "no-gemini-here");

  const calls: { sessions: any[] }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return { ok: true, json: async () => ({ accepted: body.sessions.length, flagged: 0 }) };
  }) as any;
  t.after(() => {
    globalThis.fetch = origFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k as keyof typeof prevEnv];
      else process.env[k] = v;
    }
  });

  const n = await syncOnce();
  assert.equal(n, 1, "the Claude session still syncs; pi contributes nothing");
  assert.equal(calls[0].sessions.length, 1);
  assert.equal(calls[0].sessions[0].tool, "claude_code");
  const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  assert.equal(
    Object.keys(state.threadDigests).some((k) => k.startsWith("pi_")),
    false,
    "no pi digest was ever written",
  );
});

// ---- opencode/hermes (wiring task, docs/harness-adapters-implementation.md): fixture
// builders synthesized directly with node:sqlite, matching each adapter's OWN test
// file's schema (opencode.test.ts / hermes.test.ts) -- no real ~/.local/share/opencode
// or ~/.hermes install is read here.
function sqliteMod(): { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => any } {
  return (process as unknown as { getBuiltinModule: (id: string) => any }).getBuiltinModule("node:sqlite");
}

// ---- OpenClaw (re-based onto JSONL 2026-07-14 -- see src/openclaw.ts's header): one
// JSONL file per session under agents/<agentId>/sessions/<id>.jsonl. Reuses the SAME
// line shapes as the pi fixture builders above (piHeaderLine/piUserLine/piAssistantLine)
// -- OpenClaw's real header/message tree is byte-for-byte the same shape pi's is, per
// the ticket's verified real corpus -- no real ~/.openclaw install is read here.
function buildOpenClawFixture(
  home: string,
  agentId: string,
  sess: { id: string; model: string; input: number; output: number },
): string {
  const dir = join(home, "agents", agentId, "sessions");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sess.id}.jsonl`);
  writeFileSync(
    filePath,
    [
      piHeaderLine({ id: sess.id, ts: "2026-07-10T10:00:00.000Z", cwd: "C:\\Users\\m\\.openclaw\\workspace" }),
      piUserLine({ id: "u1", ts: "2026-07-10T10:00:05.000Z" }),
      piAssistantLine({ id: "a1", ts: "2026-07-10T10:00:10.000Z", model: sess.model, input: sess.input, output: sess.output }),
    ].join("\n"),
  );
  return filePath;
}

function buildOpencodeFixture(
  home: string,
  dbFileName: string,
  sess: { id: string; input: number; output: number; timeCreated: number; timeUpdated: number },
): string {
  mkdirSync(home, { recursive: true });
  if (!existsSync(join(home, "auth.json"))) writeFileSync(join(home, "auth.json"), "{}");
  const dbPath = join(home, dbFileName);
  const { DatabaseSync } = sqliteMod();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, model TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  db.prepare(
    `INSERT INTO session (id, directory, title, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    sess.id,
    "/home/m/oc-proj",
    null,
    JSON.stringify({ id: "model-oc", providerID: "opencode-vendor" }),
    0,
    sess.input,
    sess.output,
    0,
    0,
    0,
    sess.timeCreated,
    sess.timeUpdated,
  );
  db.close();
  return dbPath;
}

function buildHermesFixture(
  home: string,
  sess: { id: string; startedAtSec: number; endedAtSec: number; input: number; output: number },
): string {
  mkdirSync(home, { recursive: true });
  const dbPath = join(home, "state.db");
  const { DatabaseSync } = sqliteMod();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, model_config TEXT, system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0, cwd TEXT, title TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL, token_count INTEGER);
  `);
  db.prepare(
    `INSERT INTO sessions (id, source, model, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cwd) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(sess.id, "cli", "hermes-model", sess.startedAtSec, sess.endedAtSec, sess.input, sess.output, 0, 0, 0, null);
  db.prepare(`INSERT INTO messages (session_id, role, timestamp) VALUES (?, ?, ?)`).run(sess.id, "user", sess.startedAtSec);
  db.prepare(`INSERT INTO messages (session_id, role, timestamp) VALUES (?, ?, ?)`).run(sess.id, "assistant", sess.startedAtSec + 10);
  db.close();
  return dbPath;
}

function buildCopilotFixture(
  home: string,
  sess: { id: string; createdAt: string; input: number; output: number },
): string {
  mkdirSync(home, { recursive: true });
  const dbPath = join(home, "session-store.db");
  const { DatabaseSync } = sqliteMod();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_index INTEGER, agent_id TEXT, parent_tool_call_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, total_nano_aiu INTEGER, request_multiplier REAL, duration_ms INTEGER, time_to_first_token_ms INTEGER, inter_token_latency_ms INTEGER, initiator TEXT, api_endpoint TEXT, reasoning_effort TEXT, finish_reason TEXT, content_filter_triggered INTEGER, token_details_json TEXT, created_at TEXT);
  `);
  db.prepare(`INSERT INTO sessions (id, cwd, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(sess.id, null, sess.createdAt, sess.createdAt);
  db.prepare(
    `INSERT INTO assistant_usage_events (session_id, turn_index, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at) VALUES (?, 0, ?, ?, ?, 0, 0, 0, ?)`,
  ).run(sess.id, "gpt-5-mini", sess.input, sess.output, sess.createdAt);
  db.close();
  return dbPath;
}

test("syncOnce: openclaw/opencode/hermes/copilot join Claude/Codex/Grok/pi in one pass; digest gate holds on re-sync", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-home-allseven-"));
  const projects = mkdtempSync(join(tmpdir(), "df-projects-allseven-"));
  const proj = join(projects, "proj1");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "s-cl7.jsonl"),
    claudeLine({ sessionId: "s-cl7", ts: "2026-07-10T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 10, output: 5 }),
  );

  const codexRoot = mkdtempSync(join(tmpdir(), "df-codex-allseven-"));
  const day = join(codexRoot, "2026", "07", "10");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, "rollout-2026-07-10T10-00-00-000Z-sess-cx7.jsonl"),
    [
      codexLine({ timestamp: "2026-07-10T10:00:00.000Z", type: "session_meta", payload: { id: "sess-cx7" } }),
      codexLine({ timestamp: "2026-07-10T10:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.5-codex" } }),
      codexLine({
        timestamp: "2026-07-10T10:00:05.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } },
      }),
    ].join("\n"),
  );

  const grokHome = mkdtempSync(join(tmpdir(), "df-grok-allseven-"));
  mkdirSync(join(grokHome, "logs"), { recursive: true });
  writeFileSync(join(grokHome, "models_cache.json"), JSON.stringify({ base_url: "https://cli-chat-proxy.grok.com/v1" }));
  writeFileSync(join(grokHome, "logs", "unified.jsonl"), grokInfLine("2026-07-10T10:00:30.000Z", "sid-g7", 1000, 400, 50, 10));

  const piHome = mkdtempSync(join(tmpdir(), "df-pi-allseven-"));
  const piDir = join(piHome, "agent", "sessions", "--home-m-oc7--");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "20260710_p7.jsonl"),
    [
      piHeaderLine({ id: "sess-p7", ts: "2026-07-10T10:00:00.000Z", cwd: "/home/m/oc7" }),
      piUserLine({ id: "u7", ts: "2026-07-10T10:00:01.000Z" }),
      piAssistantLine({ id: "a7", ts: "2026-07-10T10:00:10.000Z", model: "model-a", input: 40, output: 15, cacheRead: 5, cacheWrite: 2 }),
    ].join("\n"),
  );

  const openclawHomeDir = mkdtempSync(join(tmpdir(), "df-openclaw-allseven-"));
  const openclawFilePath = buildOpenClawFixture(openclawHomeDir, "agent-a", { id: "sess-ocw7", model: "model-b", input: 100, output: 40 });

  const opencodeHomeDir = mkdtempSync(join(tmpdir(), "df-opencode-allseven-"));
  const ocT0 = Date.UTC(2026, 6, 10, 9, 0, 0);
  const opencodeDbPath = buildOpencodeFixture(opencodeHomeDir, "opencode.db", { id: "op-oc7", input: 60, output: 25, timeCreated: ocT0, timeUpdated: ocT0 + 5000 });

  const hermesHomeDir = mkdtempSync(join(tmpdir(), "df-hermes-allseven-"));
  const hermesStartedAtSec = Math.floor(Date.UTC(2026, 6, 10, 8, 0, 0) / 1000);
  const hermesDbPathFixture = buildHermesFixture(hermesHomeDir, { id: "sess-herm7", startedAtSec: hermesStartedAtSec, endedAtSec: hermesStartedAtSec + 60, input: 45, output: 15 });

  const copilotHomeDir = mkdtempSync(join(tmpdir(), "df-copilot-allseven-"));
  const copilotCreatedAt = "2026-07-10T07:00:00.000Z";
  const copilotDbPathFixture = buildCopilotFixture(copilotHomeDir, { id: "sess-cop7", createdAt: copilotCreatedAt, input: 32649, output: 115 });

  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://mock.invalid/api",
      deviceToken: "test-token",
      uid: null,
      handle: null,
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
    }),
  );

  const prevEnv = {
    DF_HOME: process.env.DF_HOME,
    DF_CLAUDE_PROJECTS: process.env.DF_CLAUDE_PROJECTS,
    DF_CODEX_SESSIONS: process.env.DF_CODEX_SESSIONS,
    DF_GROK_HOME: process.env.DF_GROK_HOME,
    DF_PI_HOME: process.env.DF_PI_HOME,
    DF_OPENCLAW_HOME: process.env.DF_OPENCLAW_HOME,
    DF_OPENCODE_HOME: process.env.DF_OPENCODE_HOME,
    DF_HERMES_HOME: process.env.DF_HERMES_HOME,
    DF_COPILOT_HOME: process.env.DF_COPILOT_HOME,
    DF_GEMINI_HOME: process.env.DF_GEMINI_HOME,
  };
  process.env.DF_HOME = home;
  process.env.DF_CLAUDE_PROJECTS = projects;
  process.env.DF_CODEX_SESSIONS = codexRoot;
  process.env.DF_GROK_HOME = grokHome;
  process.env.DF_PI_HOME = piHome;
  process.env.DF_OPENCLAW_HOME = openclawHomeDir;
  process.env.DF_OPENCODE_HOME = opencodeHomeDir;
  process.env.DF_HERMES_HOME = hermesHomeDir;
  process.env.DF_COPILOT_HOME = copilotHomeDir;
  process.env.DF_GEMINI_HOME = join(copilotHomeDir, "no-gemini-here"); // hermetic vs a real ~/.gemini

  const calls: { sessions: any[] }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return { ok: true, json: async () => ({ accepted: body.sessions.length, flagged: 0 }) };
  }) as any;
  t.after(() => {
    globalThis.fetch = origFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k as keyof typeof prevEnv];
      else process.env[k] = v;
    }
  });

  // Pass 1: all eight providers ingest in ONE pass.
  const n1 = await syncOnce();
  assert.equal(n1, 8, "1 Claude + 1 Codex + 1 Grok + 1 pi + 1 OpenClaw + 1 opencode + 1 Hermes + 1 Copilot session");
  assert.equal(calls.length, 1);
  const tools = new Set(calls[0].sessions.map((s: any) => s.tool));
  assert.deepEqual([...tools].sort(), ["claude_code", "codex", "copilot", "grok", "hermes", "openclaw", "opencode", "pi"]);
  const byId = new Map(calls[0].sessions.map((s: any) => [s.toolSessionId, s]));

  const ocw = byId.get("sess-ocw7")!;
  assert.equal(ocw.tool, "openclaw");
  assert.deepEqual(ocw.tokens, { input: 100, output: 40, cacheRead: 0, cacheCreation: 0 });

  const opc = byId.get("op-oc7")!;
  assert.equal(opc.tool, "opencode");
  assert.deepEqual(opc.tokens, { input: 60, output: 25, cacheRead: 0, cacheCreation: 0 });

  const herm = byId.get("sess-herm7")!;
  assert.equal(herm.tool, "hermes");
  assert.deepEqual(herm.tokens, { input: 45, output: 15, cacheRead: 0, cacheCreation: 0 });

  const cop = byId.get("sess-cop7")!;
  assert.equal(cop.tool, "copilot");
  assert.deepEqual(cop.tokens, { input: 32649, output: 115, cacheRead: 0, cacheCreation: 0 });

  const state1 = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  assert.ok(state1.threadDigests["openclaw_sess-ocw7"]);
  assert.ok(state1.threadDigests["opencode_op-oc7"]);
  assert.ok(state1.threadDigests["hermes_sess-herm7"]);
  assert.ok(state1.threadDigests["copilot_sess-cop7"]);
  // OpenClaw: no adapter-returned watermark -- the real per-file byte-size cursor
  // (the same idiom pi uses) is its WHOLE change-detection signal (see sync.ts's
  // OpenClaw block), so it gets a `cursors` entry but no `watermarks` entry.
  assert.ok(state1.cursors[openclawFilePath], "OpenClaw's per-session file has a byte-size cursor");
  assert.equal(state1.watermarks?.[openclawHomeDir], undefined, "OpenClaw carries no watermark entry");
  // opencode/Hermes/Copilot: a real db-file byte-size cursor AND a persisted watermark.
  assert.ok(state1.cursors[opencodeDbPath]);
  assert.ok(state1.cursors[hermesDbPathFixture]);
  assert.ok(state1.cursors[copilotDbPathFixture]);
  assert.equal(state1.watermarks[opencodeHomeDir], ocT0 + 5000, "opencode watermark = max(time_created, time_updated) across every row read");
  assert.equal(state1.watermarks[hermesHomeDir], hermesStartedAtSec * 1000, "Hermes watermark = max started_at (converted to ms)");
  assert.equal(state1.watermarks[copilotHomeDir], Date.parse(copilotCreatedAt), "Copilot watermark = max event created_at (ms)");
  assert.deepEqual(
    Object.keys(state1.scanHealth).sort(),
    ["claude_code", "codex", "copilot", "grok", "hermes", "openclaw", "opencode", "pi"],
    "every provider that actually re-scanned this pass gets a scanHealth entry",
  );

  // Pass 2: nothing changed anywhere -- the digest gate uploads NOTHING for any of the
  // four new providers (or anyone else).
  const n2 = await syncOnce();
  assert.equal(n2, 0);
  assert.equal(calls.length, 1);
});

test("syncOnce: opencode watermark advances on a healthy scan and never regresses when a sibling db fails to read", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-home-oc-watermark-"));
  const opencodeHomeDir = mkdtempSync(join(tmpdir(), "df-opencode-watermark-"));

  // "opencode.db" is the FINGERPRINT ANCHOR (opencodeDbPaths always lists it first, so
  // isOfficialOpencodeHome only ever opens THIS file) -- it stays healthy for the whole
  // test so the fingerprint gate never flips off, isolating the corruption below to
  // its sibling channel db, not the gate itself.
  const anchorT0 = Date.UTC(2026, 6, 1, 9, 0, 0);
  const anchorDbPath = buildOpencodeFixture(opencodeHomeDir, "opencode.db", { id: "op-anchor", input: 5, output: 2, timeCreated: anchorT0, timeUpdated: anchorT0 });

  const workT0 = Date.UTC(2026, 6, 10, 9, 0, 0);
  const workDbPath = buildOpencodeFixture(opencodeHomeDir, "opencode-work.db", { id: "op-work", input: 60, output: 25, timeCreated: workT0, timeUpdated: workT0 + 9000 });

  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://mock.invalid/api",
      deviceToken: "test-token",
      uid: null,
      handle: null,
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
    }),
  );

  const prevEnv = {
    DF_HOME: process.env.DF_HOME,
    DF_CLAUDE_PROJECTS: process.env.DF_CLAUDE_PROJECTS,
    DF_CODEX_SESSIONS: process.env.DF_CODEX_SESSIONS,
    DF_GROK_HOME: process.env.DF_GROK_HOME,
    DF_PI_HOME: process.env.DF_PI_HOME,
    DF_OPENCLAW_HOME: process.env.DF_OPENCLAW_HOME,
    DF_OPENCODE_HOME: process.env.DF_OPENCODE_HOME,
    DF_HERMES_HOME: process.env.DF_HERMES_HOME,
    DF_COPILOT_HOME: process.env.DF_COPILOT_HOME,
    DF_GEMINI_HOME: process.env.DF_GEMINI_HOME,
  };
  process.env.DF_HOME = home;
  process.env.DF_CLAUDE_PROJECTS = join(opencodeHomeDir, "no-claude-here");
  process.env.DF_CODEX_SESSIONS = join(opencodeHomeDir, "no-codex-here");
  process.env.DF_GROK_HOME = join(opencodeHomeDir, "no-grok-here");
  process.env.DF_PI_HOME = join(opencodeHomeDir, "no-pi-here");
  process.env.DF_OPENCLAW_HOME = join(opencodeHomeDir, "no-openclaw-here");
  process.env.DF_OPENCODE_HOME = opencodeHomeDir;
  process.env.DF_HERMES_HOME = join(opencodeHomeDir, "no-hermes-here");
  process.env.DF_COPILOT_HOME = join(opencodeHomeDir, "no-copilot-here");
  process.env.DF_GEMINI_HOME = join(opencodeHomeDir, "no-gemini-here"); // hermetic vs a real ~/.gemini

  const calls: { sessions: any[] }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return { ok: true, json: async () => ({ accepted: body.sessions.length, flagged: 0 }) };
  }) as any;
  t.after(() => {
    globalThis.fetch = origFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k as keyof typeof prevEnv];
      else process.env[k] = v;
    }
  });

  // Pass 1: both dbs healthy -- watermark is the MAX across the whole corpus (the
  // work db's later timestamps dominate the anchor's).
  const n1 = await syncOnce();
  assert.equal(n1, 2);
  const state1 = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  assert.equal(state1.watermarks[opencodeHomeDir], workT0 + 9000);
  const workCursor1 = state1.cursors[workDbPath].byteOffset;
  assert.ok(workCursor1 > 0);

  // Corrupt ONLY the work db (different byte size -> the cheap pre-check re-triggers a
  // scan). The anchor db is untouched, so the fingerprint gate stays open.
  writeFileSync(workDbPath, "not a sqlite database at all -- corrupted for this test");

  // Pass 2: op-anchor's digest is unchanged (nothing to re-upload); op-work fails to
  // read entirely (open_failed/schema_mismatch) and contributes nothing.
  const n2 = await syncOnce();
  assert.equal(n2, 0, "the anchor session is unchanged and the broken db contributes nothing");
  assert.equal(calls.length, 1, "no upload attempt when nothing new synced");

  const state2 = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  // The read-failure rule: a db that failed to read this pass keeps its OLD cursor, so
  // the next pass retries it instead of treating unread data as synced.
  assert.equal(state2.cursors[workDbPath].byteOffset, workCursor1, "the broken db's cursor did not advance to its corrupted size");
  // The watermark guard: this pass's scan could only read the (older) anchor db, whose
  // own watermark contribution is LESS than the persisted one from pass 1 -- the
  // watermark must never regress on a partial/failed pass.
  assert.equal(state2.watermarks[opencodeHomeDir], workT0 + 9000, "watermark never regresses when a sibling db fails to read");
  assert.notEqual(anchorDbPath, workDbPath);
});

test("softSkip: TrackerState.softSkip round-trips through save/load and drops garbage entries (marker plumbing, item 2)", async (t) => {
  // node:sqlite genuinely IS available on the machine running this test, so syncOnce's
  // real soft-skip branch (sqliteSupported() === false) cannot be driven end-to-end
  // here -- per the task, this tests the STATE PLUMBING directly instead: the exact
  // save/load path syncOnce uses to persist and later read back the marker.
  const home = mkdtempSync(join(tmpdir(), "df-home-softskip-"));
  const prevDfHome = process.env.DF_HOME;
  process.env.DF_HOME = home;
  t.after(() => {
    if (prevDfHome === undefined) delete process.env.DF_HOME;
    else process.env.DF_HOME = prevDfHome;
  });

  const state = loadState();
  state.deviceToken = "test-token";
  // The shape syncOnce writes when the probe fires: true for a provider whose db was
  // FOUND but unreadable on this Node.
  state.softSkip = { hermes: true, opencode: true };
  saveState(state);

  const reloaded = loadState();
  assert.deepEqual(reloaded.softSkip, { hermes: true, opencode: true }, "a well-formed soft-skip map round-trips");

  // Garbage written directly to disk (a non-true value, an unrecognized provider id)
  // must be dropped by the sanitizer, never trusted verbatim -- same defensive posture
  // sanitizeScanHealth already applies to scanHealth.
  const raw = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  raw.softSkip = { hermes: true, openclaw: "yes", notAProvider: true };
  writeFileSync(join(home, "state.json"), JSON.stringify(raw));
  const sanitized = loadState();
  assert.deepEqual(sanitized.softSkip, { hermes: true }, "only a `true` value under a recognized ToolName key survives");
});

// ---- account_deleted (403) hard-stop (PR #22 decision 4): syncOnce must mirror
// token_revoked and THROW (carrying restoreBy) instead of printing + returning 0 -- a
// print+return-0 lets the persistent monitorLoop (bin/df.ts) treat it as a normal empty
// sync and loop again, re-printing the "account deleted" line every cycle forever.
const ACCOUNT_DELETED_RESTORE_BY = 4102444800000; // fixed future epoch ms (2100-01-01T00:00:00.000Z)

function accountDeletedFetchStub(): typeof fetch {
  return (async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: "account_deleted", restoreBy: ACCOUNT_DELETED_RESTORE_BY }),
  })) as unknown as typeof fetch;
}

test("syncOnce: account_deleted (403) throws an Error carrying restoreBy -- never returns 0", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-home-acctdel-throw-"));
  const projects = mkdtempSync(join(tmpdir(), "df-projects-acctdel-throw-"));
  const proj = join(projects, "proj1");
  mkdirSync(proj, { recursive: true });
  // Seed a transcript so there is something to send -- an empty corpus takes the
  // sessions.length === 0 early-return path and never reaches the ingest fetch at all.
  writeFileSync(
    join(proj, "s-del.jsonl"),
    claudeLine({ sessionId: "s-del", ts: "2026-07-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 10, output: 5 }),
  );

  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://mock.invalid/api",
      deviceToken: "test-token",
      uid: null,
      handle: null,
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
    }),
  );

  const prevEnv = {
    DF_HOME: process.env.DF_HOME,
    DF_CLAUDE_PROJECTS: process.env.DF_CLAUDE_PROJECTS,
    DF_CODEX_SESSIONS: process.env.DF_CODEX_SESSIONS,
    DF_GROK_HOME: process.env.DF_GROK_HOME,
    DF_PI_HOME: process.env.DF_PI_HOME,
    DF_OPENCLAW_HOME: process.env.DF_OPENCLAW_HOME,
    DF_OPENCODE_HOME: process.env.DF_OPENCODE_HOME,
    DF_HERMES_HOME: process.env.DF_HERMES_HOME,
    DF_COPILOT_HOME: process.env.DF_COPILOT_HOME,
    DF_GEMINI_HOME: process.env.DF_GEMINI_HOME,
  };
  process.env.DF_HOME = home;
  process.env.DF_CLAUDE_PROJECTS = projects;
  process.env.DF_CODEX_SESSIONS = join(projects, "no-codex-here");
  process.env.DF_GROK_HOME = join(projects, "no-grok-here");
  process.env.DF_PI_HOME = join(projects, "no-pi-here");
  process.env.DF_OPENCLAW_HOME = join(projects, "no-openclaw-here");
  process.env.DF_OPENCODE_HOME = join(projects, "no-opencode-here");
  process.env.DF_HERMES_HOME = join(projects, "no-hermes-here");
  process.env.DF_COPILOT_HOME = join(projects, "no-copilot-here");
  // Same lesson for gemini (L14): no DF_GEMINI_HOME override would fingerprint a REAL ~/.gemini.
  process.env.DF_GEMINI_HOME = join(projects, "no-gemini-here");

  const origFetch = globalThis.fetch;
  globalThis.fetch = accountDeletedFetchStub();
  t.after(() => {
    globalThis.fetch = origFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k as keyof typeof prevEnv];
      else process.env[k] = v;
    }
  });

  await assert.rejects(
    syncOnce(),
    (e: unknown) => e instanceof Error && e.message === "account_deleted" && (e as Error & { restoreBy?: number }).restoreBy === ACCOUNT_DELETED_RESTORE_BY,
  );
});

test("syncOnce: account_deleted does not advance the cursor -- refused pass leaves threadDigests/lastSyncAt untouched", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-home-acctdel-cursor-"));
  const projects = mkdtempSync(join(tmpdir(), "df-projects-acctdel-cursor-"));
  const proj = join(projects, "proj1");
  mkdirSync(proj, { recursive: true });
  // Same seed as above -- a transcript a SUCCESSFUL pass would have advanced past, so a
  // refused pass leaving it untouched is actually proven, not vacuously true.
  writeFileSync(
    join(proj, "s-del2.jsonl"),
    claudeLine({ sessionId: "s-del2", ts: "2026-07-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 10, output: 5 }),
  );

  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://mock.invalid/api",
      deviceToken: "test-token",
      uid: null,
      handle: null,
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
      // A sentinel, not the real default -- proves the refused pass never wrote it (a
      // genuine successful pass sets Date.now(), a ~13-digit epoch ms nowhere near 1).
      lastSyncAt: 1,
    }),
  );

  const prevEnv = {
    DF_HOME: process.env.DF_HOME,
    DF_CLAUDE_PROJECTS: process.env.DF_CLAUDE_PROJECTS,
    DF_CODEX_SESSIONS: process.env.DF_CODEX_SESSIONS,
    DF_GROK_HOME: process.env.DF_GROK_HOME,
    DF_PI_HOME: process.env.DF_PI_HOME,
    DF_OPENCLAW_HOME: process.env.DF_OPENCLAW_HOME,
    DF_OPENCODE_HOME: process.env.DF_OPENCODE_HOME,
    DF_HERMES_HOME: process.env.DF_HERMES_HOME,
    DF_COPILOT_HOME: process.env.DF_COPILOT_HOME,
    DF_GEMINI_HOME: process.env.DF_GEMINI_HOME,
  };
  process.env.DF_HOME = home;
  process.env.DF_CLAUDE_PROJECTS = projects;
  process.env.DF_CODEX_SESSIONS = join(projects, "no-codex-here");
  process.env.DF_GROK_HOME = join(projects, "no-grok-here");
  process.env.DF_PI_HOME = join(projects, "no-pi-here");
  process.env.DF_OPENCLAW_HOME = join(projects, "no-openclaw-here");
  process.env.DF_OPENCODE_HOME = join(projects, "no-opencode-here");
  process.env.DF_HERMES_HOME = join(projects, "no-hermes-here");
  process.env.DF_COPILOT_HOME = join(projects, "no-copilot-here");
  // Same lesson for gemini (L14): no DF_GEMINI_HOME override would fingerprint a REAL ~/.gemini.
  process.env.DF_GEMINI_HOME = join(projects, "no-gemini-here");

  const origFetch = globalThis.fetch;
  globalThis.fetch = accountDeletedFetchStub();
  t.after(() => {
    globalThis.fetch = origFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k as keyof typeof prevEnv];
      else process.env[k] = v;
    }
  });

  await assert.rejects(syncOnce(), (e: unknown) => e instanceof Error && e.message === "account_deleted");

  // The cursor/digest persistence block at the end of syncOnce must never be reached on a
  // refused pass -- the deleted account's corpus has to re-offer INTACT after restore.
  const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  assert.deepEqual(state.threadDigests, {}, "no digest was recorded for the refused pass");
  assert.equal(state.lastSyncAt, 1, "lastSyncAt was never advanced past the seeded sentinel");
});
