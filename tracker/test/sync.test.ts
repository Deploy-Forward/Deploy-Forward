import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTranscripts, findSubagentTranscripts, summarizeFile, summarizeClaudeCorpus } from "../src/sync.ts";
import { PARSER_EPOCH, type TrackerState } from "../src/config.ts";

test("findTranscripts collects across roots and dedups the same session, keeping the largest (most complete) copy", () => {
  const base = mkdtempSync(join(tmpdir(), "df-tx-"));
  const rootA = join(base, "a");
  const rootB = join(base, "b");
  const projA = join(rootA, "proj1");
  const projB = join(rootB, "proj1");
  mkdirSync(projA, { recursive: true });
  mkdirSync(projB, { recursive: true });

  // The same session id (file name) lives under BOTH roots (a session copied between homes),
  // plus one session unique to each root.
  const shared = "11111111-1111-1111-1111-111111111111.jsonl";
  const aOnly = "aaaaaaaa-0000.jsonl";
  const bOnly = "bbbbbbbb-0000.jsonl";
  // A's shared copy is SMALL but has a NEWER mtime; B's is larger (more complete) but older.
  writeFileSync(join(projA, shared), "{}");
  writeFileSync(join(projB, shared), '{"x":"' + "y".repeat(200) + '"}');
  writeFileSync(join(projA, aOnly), "{}");
  writeFileSync(join(projB, bOnly), "{}");
  const older = new Date("2026-01-01T00:00:00Z");
  const newer = new Date("2026-06-01T00:00:00Z");
  utimesSync(join(projA, shared), newer, newer); // newer but truncated
  utimesSync(join(projB, shared), older, older); // older but complete

  const found = findTranscripts([rootA, rootB]);

  // Three distinct sessions — the shared one is not double-counted.
  assert.equal(found.length, 3);
  // Size wins over mtime: a stale, touched-but-truncated copy must not shadow the full session.
  assert.ok(found.includes(join(projB, shared)), "keeps the largest (most complete) copy");
  assert.ok(!found.includes(join(projA, shared)), "drops the smaller copy even though it is newer");
  assert.ok(found.includes(join(projA, aOnly)));
  assert.ok(found.includes(join(projB, bOnly)));
});

test("findTranscripts skips missing/unreadable roots without throwing", () => {
  const found = findTranscripts([join(tmpdir(), "df-does-not-exist-" + process.pid)]);
  assert.deepEqual(found, []);
});

// ---- RC-D: recursive subagent walk + parent-merge attribution -----------------------------

const SID = "abcd1234-0000-0000-0000-000000000000";
function asst(ts: string, id: string, model: string, input: number, output: number): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: SID,
    timestamp: ts,
    requestId: "req-" + id,
    uuid: "u-" + id,
    message: {
      id,
      model,
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
}
function humanPrompt(ts: string, text: string): string {
  return JSON.stringify({ type: "user", sessionId: SID, timestamp: ts, message: { role: "user", content: text } });
}
function testState(): TrackerState {
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
  };
}

test("findSubagentTranscripts collects nested subagent transcripts (agents + workflows tree)", () => {
  const base = mkdtempSync(join(tmpdir(), "df-sub-"));
  const proj = join(base, "proj");
  mkdirSync(join(proj, SID, "subagents", "workflows", "wf_1"), { recursive: true });
  const root = join(proj, SID + ".jsonl");
  writeFileSync(root, humanPrompt("2026-06-28T10:00:00.000Z", "hi"));
  writeFileSync(join(proj, SID, "subagents", "agent-x.jsonl"), "{}");
  writeFileSync(join(proj, SID, "subagents", "workflows", "wf_1", "agent-y.jsonl"), "{}");
  // a non-jsonl sibling must be ignored
  writeFileSync(join(proj, SID, "subagents", "notes.txt"), "ignore me");

  const subs = findSubagentTranscripts(root);
  assert.equal(subs.length, 2, "both nested .jsonl files found, recursively");
  assert.ok(subs.some((p) => p.endsWith("agent-x.jsonl")));
  assert.ok(subs.some((p) => p.endsWith("agent-y.jsonl")));

  // A root with no subagents dir yields none, never throws.
  assert.deepEqual(findSubagentTranscripts(join(proj, "no-such-session.jsonl")), []);
});

test("summarizeFile merges subagent tokens/models into the PARENT session (no session-count inflation)", () => {
  const base = mkdtempSync(join(tmpdir(), "df-merge-"));
  const proj = join(base, "proj");
  mkdirSync(join(proj, SID, "subagents", "workflows", "wf_1"), { recursive: true });
  const root = join(proj, SID + ".jsonl");
  // Parent: 1 human prompt + 1 opus assistant message (100 in / 50 out).
  writeFileSync(
    root,
    [humanPrompt("2026-06-28T10:00:00.000Z", "build it"), asst("2026-06-28T10:00:05.000Z", "m1", "claude-opus-4-8", 100, 50)].join("\n"),
  );
  // Subagent A: its OWN opening "user" line (the Task dispatch, NOT a human turn) + a sonnet
  // assistant message (200 in / 80 out).
  writeFileSync(
    join(proj, SID, "subagents", "agent-x.jsonl"),
    [humanPrompt("2026-06-28T10:00:06.000Z", "subagent task"), asst("2026-06-28T10:00:08.000Z", "m2", "claude-sonnet-4-5", 200, 80)].join("\n"),
  );
  // Subagent B (nested under workflows): a second opus message (10 in / 0 out).
  writeFileSync(
    join(proj, SID, "subagents", "workflows", "wf_1", "agent-y.jsonl"),
    asst("2026-06-28T10:00:09.000Z", "m3", "claude-opus-4-8", 10, 0),
  );

  const subs = findSubagentTranscripts(root);
  const merged = summarizeFile(root, testState(), "claude_code", subs)!;
  const rootOnly = summarizeFile(root, testState(), "claude_code", [])!;

  // Identity is the PARENT session id — one record, not thousands (no count inflation).
  assert.equal(merged.toolSessionId, SID);
  // Tokens fold in: input 100+200+10 = 310, output 50+80 = 130.
  assert.equal(merged.tokens.input, 310);
  assert.equal(merged.tokens.output, 130);
  assert.ok(merged.tokens.input > rootOnly.tokens.input, "merge strictly increases coverage over root-only");
  // Per-model buckets decompose the merged totals across BOTH models.
  const byId = new Map(merged.models.map((m) => [m.id, m]));
  assert.equal(byId.get("claude-opus-4-8")!.input, 110); // 100 (root) + 10 (nested)
  assert.equal(byId.get("claude-opus-4-8")!.output, 50);
  assert.equal(byId.get("claude-sonnet-4-5")!.input, 200);
  assert.equal(byId.get("claude-sonnet-4-5")!.output, 80);
  // turns counts only the PARENT's human prompt — the subagent's dispatch line is not a human turn.
  assert.equal(merged.turns, 1);
});

test("summarizeFile wires skills through (parent + subagent merge) and OMITS the field when none", () => {
  const base = mkdtempSync(join(tmpdir(), "df-skills-"));
  const proj = join(base, "proj");
  mkdirSync(join(proj, SID, "subagents"), { recursive: true });
  const root = join(proj, SID + ".jsonl");
  const commandLine = JSON.stringify({
    type: "user",
    sessionId: SID,
    isMeta: true,
    timestamp: "2026-06-28T10:00:00.000Z",
    message: { role: "user", content: "<command-name>/grilling</command-name><command-args>secret args</command-args>" },
  });
  const skillCall = JSON.stringify({
    type: "assistant",
    sessionId: SID,
    timestamp: "2026-06-28T10:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_p1", name: "Skill", input: { skill: "superpowers:brainstorming", args: "x" } }],
    },
  });
  writeFileSync(root, [commandLine, skillCall, asst("2026-06-28T10:00:05.000Z", "m1", "claude-opus-4-8", 100, 50)].join("\n"));
  // Subagent invokes the SAME skill once more — counts must merge (1 + 1 = 2).
  const subSkill = JSON.stringify({
    type: "assistant",
    sessionId: SID,
    timestamp: "2026-06-28T10:00:06.000Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_s1", name: "Skill", input: { skill: "superpowers:brainstorming" } }],
    },
  });
  writeFileSync(
    join(proj, SID, "subagents", "agent-x.jsonl"),
    [subSkill, asst("2026-06-28T10:00:07.000Z", "m2", "claude-sonnet-4-5", 10, 5)].join("\n"),
  );

  const merged = summarizeFile(root, testState(), "claude_code", findSubagentTranscripts(root))!;
  assert.deepEqual(
    merged.skills!.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "grilling", count: 1 },
      { id: "superpowers:brainstorming", count: 2 },
    ],
  );

  // A session with NO skill markers omits the field entirely (undefined, not []).
  const bare = join(proj, "bare-0000.jsonl");
  writeFileSync(bare, asst("2026-06-28T11:00:00.000Z", "m9", "claude-opus-4-8", 1, 1));
  const plain = summarizeFile(bare, testState(), "claude_code", [])!;
  assert.equal(plain.skills, undefined);
});

test("skills dedup GLOBALLY across files: a fork replaying the same tool_use block / command line counts ONCE", () => {
  const base = mkdtempSync(join(tmpdir(), "df-skilldedup-"));
  const proj = join(base, "proj");
  mkdirSync(proj, { recursive: true });

  // Original thread: one /grilling command line (uuid u-cmd-1) + one Skill tool_use
  // (block toolu_g1) + one assistant usage message.
  const commandLine = JSON.stringify({
    type: "user",
    sessionId: "s-orig",
    uuid: "u-cmd-1",
    isMeta: true,
    timestamp: "2026-06-28T10:00:00.000Z",
    message: { role: "user", content: "<command-name>/grilling</command-name>" },
  });
  const skillCall = JSON.stringify({
    type: "assistant",
    sessionId: "s-orig",
    timestamp: "2026-06-28T10:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_g1", name: "Skill", input: { skill: "code-review" } }],
    },
  });
  writeFileSync(
    join(proj, "s-orig.jsonl"),
    [commandLine, skillCall, asst("2026-06-28T10:00:05.000Z", "m1", "claude-opus-4-8", 100, 50)].join("\n"),
  );
  // Fork: replays the SAME lines verbatim (same uuid, same tool_use block id, same
  // message ids AND original timestamps — realistic resume behavior) plus one genuinely
  // new skill. Its id ("s-zfork") sorts after "s-orig" so the tied first-usage timestamp
  // resolves to the original as first occurrence (the deterministic threadId tiebreak).
  const newSkill = JSON.stringify({
    type: "assistant",
    sessionId: "s-zfork",
    timestamp: "2026-06-28T11:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_g2", name: "Skill", input: { skill: "simplify" } }],
    },
  });
  writeFileSync(
    join(proj, "s-zfork.jsonl"),
    [
      commandLine.replace('"s-orig"', '"s-zfork"'),
      skillCall.replace('"s-orig"', '"s-zfork"'),
      asst("2026-06-28T10:00:05.000Z", "m1", "claude-opus-4-8", 100, 50).replace(SID, "s-zfork"),
      newSkill,
      asst("2026-06-28T11:00:01.000Z", "m2", "claude-opus-4-8", 10, 5).replace(SID, "s-zfork"),
    ].join("\n"),
  );

  const summaries = summarizeClaudeCorpus(
    [
      { path: join(proj, "s-orig.jsonl"), subagents: [] },
      { path: join(proj, "s-zfork.jsonl"), subagents: [] },
    ],
    testState(),
  );
  const byId = new Map(summaries.map((s) => [s.toolSessionId, s]));

  // The replayed command line (same uuid) and Skill block (same toolu_ id) count ONCE,
  // attributed to the first-occurrence thread; the fork keeps only its new skill.
  assert.deepEqual(
    byId.get("s-orig")!.skills!.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "code-review", count: 1 },
      { id: "grilling", count: 1 },
    ],
  );
  assert.deepEqual(byId.get("s-zfork")!.skills, [{ id: "simplify", count: 1 }]);
});
