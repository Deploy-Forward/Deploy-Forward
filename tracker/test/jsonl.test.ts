import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript } from "../src/jsonl.ts";

const line = (o: unknown) => JSON.stringify(o);

test("sums usage across assistant messages and captures model + session id", () => {
  const content = [
    line({ type: "summary", summary: "x" }),
    line({ type: "user", sessionId: "sess-1", timestamp: "2026-06-28T10:00:00Z" }),
    line({
      type: "message",
      uuid: "m1",
      sessionId: "sess-1",
      timestamp: "2026-06-28T10:00:05Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      },
    }),
    line({
      type: "message",
      uuid: "m2",
      sessionId: "sess-1",
      timestamp: "2026-06-28T10:01:00Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        usage: { input_tokens: 200, output_tokens: 80 },
      },
    }),
  ].join("\n");

  const p = parseTranscript(content);
  assert.equal(p.toolSessionId, "sess-1");
  assert.equal(p.model, "claude-opus-4-8");
  assert.deepEqual(p.tokens, { input: 300, output: 130, cacheRead: 10, cacheCreation: 5 });
  assert.equal(p.messageCount, 2);
  assert.equal(p.lastMessageUuid, "m2");
});

test("tolerates a top-level usage shape (schema drift)", () => {
  const content = [
    line({ uuid: "a", timestamp: "2026-06-28T10:00:00Z", model: "grok", usage: { input_tokens: 7, output_tokens: 3 } }),
  ].join("\n");
  const p = parseTranscript(content);
  assert.equal(p.tokens.input, 7);
  assert.equal(p.tokens.output, 3);
  assert.equal(p.model, "grok");
});

test("never throws on malformed lines; counts them as skipped", () => {
  const content = ["{ not json", "", "   ", line({ type: "user", timestamp: "2026-06-28T10:00:00Z" })].join("\n");
  const p = parseTranscript(content);
  assert.equal(p.skipped, 1);
  assert.equal(p.totalLines, 2, "non-blank lines only — the W1.5 drift-rate denominator");
  assert.equal(p.messageCount, 0);
  assert.equal(p.tokens.input, 0);
});

test("dedups a replayed message: same (message.id, requestId) counts ONCE", () => {
  // Claude Code re-logs the same assistant message across lines (resume/compaction), each copy
  // carrying identical usage. Summing them over-counts; we credit the (id, requestId) once.
  const dup = (uuid: string, ts: string) =>
    line({
      type: "message",
      uuid,
      requestId: "req-1",
      timestamp: ts,
      message: {
        role: "assistant",
        id: "msg_A",
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 },
      },
    });
  const content = [
    dup("m1", "2026-06-28T10:00:01Z"),
    dup("m2", "2026-06-28T10:00:02Z"),
    dup("m3", "2026-06-28T10:00:03Z"),
  ].join("\n");
  const p = parseTranscript(content);
  assert.deepEqual(p.tokens, { input: 100, output: 50, cacheRead: 1000, cacheCreation: 20 });
  assert.equal(p.messageCount, 1);
});

test("same message.id under a DIFFERENT requestId counts separately (distinct API calls)", () => {
  const mk = (req: string, out: number) =>
    line({
      type: "message",
      uuid: "u" + req,
      requestId: req,
      timestamp: "2026-06-28T10:00:00Z",
      message: { role: "assistant", id: "msg_A", usage: { input_tokens: 0, output_tokens: out } },
    });
  const p = parseTranscript([mk("req-1", 10), mk("req-2", 20)].join("\n"));
  assert.equal(p.tokens.output, 30);
  assert.equal(p.messageCount, 2);
});

test("message-id fallback dedups only when at least one side is sidechain", () => {
  const mk = (req: string, sidechain: boolean, cacheRead: number) =>
    line({
      type: "message",
      uuid: "u-" + req,
      requestId: req,
      isSidechain: sidechain,
      timestamp: "2026-06-28T10:00:00Z",
      message: {
        role: "assistant",
        id: "msg-parent",
        model: "claude-opus-4-8",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: cacheRead },
      },
    });

  const withSidechain = parseTranscript([mk("req-parent", false, 20), mk("req-sidechain", true, 50000)].join("\n"));
  assert.deepEqual(withSidechain.tokens, { input: 1, output: 1, cacheRead: 20, cacheCreation: 0 });
  assert.equal(withSidechain.messageCount, 1);

  const nonSidechainOnly = parseTranscript([mk("req-a", false, 20), mk("req-b", false, 30)].join("\n"));
  assert.deepEqual(nonSidechainOnly.tokens, { input: 2, output: 2, cacheRead: 50, cacheCreation: 0 });
  assert.equal(nonSidechainOnly.messageCount, 2);
});

test("agent-progress shape carries isSidechain into the message-id fallback", () => {
  const parent = line({
    type: "message",
    requestId: "req-parent",
    timestamp: "2026-06-28T10:00:00Z",
    message: {
      role: "assistant",
      id: "msg-parent",
      model: "claude-opus-4-8",
      usage: { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 20 },
    },
  });
  const replayInsideSidechain = line({
    data: {
      message: {
        timestamp: "2026-06-28T10:00:01Z",
        requestId: "req-sidechain-replay",
        isSidechain: true,
        message: {
          id: "msg-parent",
          model: "claude-opus-4-8",
          usage: { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 50000 },
        },
      },
    },
  });
  const p = parseTranscript([parent, replayInsideSidechain].join("\n"));
  assert.deepEqual(p.tokens, { input: 1, output: 10, cacheRead: 20, cacheCreation: 0 });
  assert.equal(p.messageCount, 1);
});

test("whole-record max-wins never fabricates per-field maxima", () => {
  const mk = (output: number, cacheRead: number) =>
    line({
      type: "message",
      requestId: "req-1",
      timestamp: "2026-06-28T10:00:00Z",
      message: {
        role: "assistant",
        id: "msg_A",
        model: "claude-opus-4-8",
        usage: { input_tokens: 0, output_tokens: output, cache_read_input_tokens: cacheRead },
      },
    });
  const p = parseTranscript([mk(10, 100), mk(200, 0)].join("\n"));
  assert.deepEqual(p.tokens, { input: 0, output: 200, cacheRead: 0, cacheCreation: 0 });
  assert.equal(p.messageCount, 1);
});

test("captures entryPoint and thinking tokens as status metadata only", () => {
  const p = parseTranscript(
    line({
      type: "message",
      entryPoint: "VS-Code",
      requestId: "req-1",
      timestamp: "2026-06-28T10:00:00Z",
      message: {
        role: "assistant",
        id: "msg_A",
        model: "claude-opus-4-8",
        usage: { input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 7 },
      },
    }),
  );
  assert.equal(p.entryPoint, "vscode");
  assert.equal(p.thinkingTokens, 7);
  assert.deepEqual(p.tokens, { input: 10, output: 20, cacheRead: 0, cacheCreation: 0 });
});

test("ccusage validity gate rejects present-but-empty ids/models and non-semver versions", () => {
  const mk = (patch: Record<string, unknown>) =>
    line({
      type: "message",
      uuid: "x",
      sessionId: "sess-1",
      requestId: "req-1",
      timestamp: "2026-06-28T10:00:00Z",
      version: "1.2.3",
      message: {
        role: "assistant",
        id: "msg_A",
        model: "claude-opus-4-8",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      ...patch,
    });

  assert.equal(parseTranscript(mk({ message: { role: "assistant", id: "", model: "claude-opus-4-8", usage: { input_tokens: 10 } } })).tokens.input, 0);
  assert.equal(parseTranscript(mk({ requestId: "" })).tokens.input, 0);
  assert.equal(parseTranscript(mk({ sessionId: "" })).tokens.input, 0);
  assert.equal(parseTranscript(mk({ version: "not-semver" })).tokens.input, 0);
  assert.equal(parseTranscript(mk({ message: { role: "assistant", id: "msg_A", model: "", usage: { input_tokens: 10 } } })).tokens.input, 0);

  const absentMessageId = line({
    type: "message",
    requestId: "req-absent",
    timestamp: "2026-06-28T10:00:00Z",
    message: { role: "assistant", model: "claude-opus-4-8", usage: { input_tokens: 10 } },
  });
  assert.equal(parseTranscript(absentMessageId).tokens.input, 10, "absent message id still counts");
});

test("lines with no message.id are never dropped (defensive: always counted)", () => {
  const mk = (out: number) =>
    line({
      type: "message",
      uuid: "x",
      timestamp: "2026-06-28T10:00:00Z",
      message: { role: "assistant", usage: { input_tokens: 0, output_tokens: out } },
    });
  const p = parseTranscript([mk(5), mk(7)].join("\n"));
  assert.equal(p.tokens.output, 12);
  assert.equal(p.messageCount, 2);
});

test("keeps the COMPLETE (max) usage when a message is re-logged partial-then-final", () => {
  // Claude Code writes a streaming/partial usage first, then the complete usage for the SAME
  // (message.id, requestId). We must keep the final (per-field max), not the first — keeping the
  // first would drop the larger final value and under-count. (This is the bug the verify pass caught.)
  const at = (out: number, cr: number, ts: string) =>
    line({
      type: "message",
      uuid: "u" + ts,
      requestId: "req-1",
      timestamp: ts,
      message: {
        role: "assistant",
        id: "msg_A",
        usage: { input_tokens: 2, output_tokens: out, cache_read_input_tokens: cr, cache_creation_input_tokens: 0 },
      },
    });
  const p = parseTranscript(
    [at(3, 0, "2026-06-28T10:00:01Z"), at(253, 8000, "2026-06-28T10:00:02Z")].join("\n"),
  );
  assert.deepEqual(p.tokens, { input: 2, output: 253, cacheRead: 8000, cacheCreation: 0 });
  assert.equal(p.messageCount, 1);
});

test("splits totals into per-model buckets on a multi-model session", () => {
  // Real shape: fable-5 + opus-4-7 + opus-4-8 mixes observed in 6/30 sampled sessions.
  const mk = (id: string, model: string, inTok: number, outTok: number) =>
    line({
      type: "message",
      uuid: "u-" + id,
      requestId: "req-" + id,
      timestamp: "2026-06-28T10:00:00Z",
      message: { role: "assistant", id, model, usage: { input_tokens: inTok, output_tokens: outTok } },
    });
  const p = parseTranscript(
    [
      mk("m1", "claude-fable-5", 100, 10),
      mk("m2", "claude-opus-4-7", 200, 20),
      mk("m3", "claude-fable-5", 300, 30),
      mk("m4", "claude-opus-4-8", 400, 40),
    ].join("\n"),
  );
  // Totals math unchanged: the buckets are additive detail on top.
  assert.deepEqual(p.tokens, { input: 1000, output: 100, cacheRead: 0, cacheCreation: 0 });
  const byId = new Map(p.models.map((m) => [m.id, m]));
  assert.equal(p.models.length, 3);
  assert.deepEqual(byId.get("claude-fable-5"), { id: "claude-fable-5", input: 400, output: 40, cacheRead: 0, cacheCreation: 0 });
  assert.deepEqual(byId.get("claude-opus-4-7"), { id: "claude-opus-4-7", input: 200, output: 20, cacheRead: 0, cacheCreation: 0 });
  assert.deepEqual(byId.get("claude-opus-4-8"), { id: "claude-opus-4-8", input: 400, output: 40, cacheRead: 0, cacheCreation: 0 });
});

test("keep-max dedup is preserved per model: replayed copies credit their model ONCE", () => {
  // The same (message.id, requestId) re-logged partial-then-final must land in its model's
  // bucket exactly once, at the complete (max) usage — same semantics as the totals.
  const at = (out: number, ts: string) =>
    line({
      type: "message",
      uuid: "u" + ts,
      requestId: "req-1",
      timestamp: ts,
      message: { role: "assistant", id: "msg_A", model: "claude-fable-5", usage: { input_tokens: 2, output_tokens: out } },
    });
  const other = line({
    type: "message",
    uuid: "u-other",
    requestId: "req-2",
    timestamp: "2026-06-28T10:00:03Z",
    message: { role: "assistant", id: "msg_B", model: "claude-opus-4-8", usage: { input_tokens: 5, output_tokens: 1 } },
  });
  const p = parseTranscript([at(3, "2026-06-28T10:00:01Z"), at(253, "2026-06-28T10:00:02Z"), other].join("\n"));
  const byId = new Map(p.models.map((m) => [m.id, m]));
  assert.deepEqual(byId.get("claude-fable-5"), { id: "claude-fable-5", input: 2, output: 253, cacheRead: 0, cacheCreation: 0 });
  assert.deepEqual(byId.get("claude-opus-4-8"), { id: "claude-opus-4-8", input: 5, output: 1, cacheRead: 0, cacheCreation: 0 });
  assert.deepEqual(p.tokens, { input: 7, output: 254, cacheRead: 0, cacheCreation: 0 });
});

test("keeps <synthetic> in capture model buckets; reconcile/render can drop it later", () => {
  const mk = (id: string, model: string, out: number) =>
    line({
      type: "message",
      uuid: "u-" + id,
      requestId: "req-" + id,
      timestamp: "2026-06-28T10:00:00Z",
      message: { role: "assistant", id, model, usage: { input_tokens: 10, output_tokens: out } },
    });
  const p = parseTranscript([mk("m1", "claude-fable-5", 50), mk("m2", "<synthetic>", 7)].join("\n"));
  assert.deepEqual(p.tokens, { input: 20, output: 57, cacheRead: 0, cacheCreation: 0 }, "totals unchanged");
  assert.deepEqual(p.models, [
    { id: "claude-fable-5", input: 10, output: 50, cacheRead: 0, cacheCreation: 0 },
    { id: "<synthetic>", input: 10, output: 7, cacheRead: 0, cacheCreation: 0 },
  ]);
});

test("keeps every distinct model entry in capture; render can cap/fold later", () => {
  // 30 models with descending usage — the 7 smallest must fold into a single "other" bucket.
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) {
    lines.push(
      line({
        type: "message",
        uuid: "u" + i,
        requestId: "req-" + i,
        timestamp: "2026-06-28T10:00:00Z",
        message: { role: "assistant", id: "msg_" + i, model: "model-" + i, usage: { input_tokens: 0, output_tokens: 100 - i } },
      }),
    );
  }
  const p = parseTranscript(lines.join("\n"));
  assert.equal(p.models.length, 30);
  assert.equal(p.models.some((m) => m.id === "other"), false);
  const sum = p.models.reduce((acc, m) => acc + m.output, 0);
  assert.equal(sum, p.tokens.output, "bucket sum equals totals");
});

test("no-id fallback lines credit their line's model bucket", () => {
  const mk = (model: string, out: number) =>
    line({
      type: "message",
      uuid: "x",
      timestamp: "2026-06-28T10:00:00Z",
      message: { role: "assistant", model, usage: { input_tokens: 0, output_tokens: out } },
    });
  const p = parseTranscript([mk("claude-fable-5", 5), mk("claude-opus-4-8", 7)].join("\n"));
  const byId = new Map(p.models.map((m) => [m.id, m]));
  assert.equal(byId.get("claude-fable-5")?.output, 5);
  assert.equal(byId.get("claude-opus-4-8")?.output, 7);
  assert.equal(p.tokens.output, 12);
});

test("preserves model ids verbatim in capture", () => {
  const longId = "m".repeat(80);
  const mk = (id: string, model: string) =>
    line({
      type: "message",
      uuid: "u-" + id,
      requestId: "req-" + id,
      timestamp: "2026-06-28T10:00:00Z",
      message: { role: "assistant", id, model, usage: { input_tokens: 1, output_tokens: 1 } },
    });
  const p = parseTranscript([mk("m1", "  claude-fable-5  "), mk("m2", longId)].join("\n"));
  const ids = p.models.map((m) => m.id).sort();
  assert.deepEqual(ids, ["  claude-fable-5  ", longId].sort());
});

test("ignores non-finite/garbage usage numbers", () => {
  const content = line({
    uuid: "x",
    timestamp: "bad-date",
    message: { role: "assistant", usage: { input_tokens: "lots", output_tokens: null } },
  });
  const p = parseTranscript(content);
  assert.equal(p.tokens.input, 0);
  assert.equal(p.tokens.output, 0);
  assert.equal(p.timestamps.length, 0); // bad-date dropped
});
