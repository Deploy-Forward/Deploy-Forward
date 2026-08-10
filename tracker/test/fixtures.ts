/**
 * Deploy Forward Atomic Capture Standard — SYNTHETIC FIXTURES (Phase 0).
 *
 * Known-answer transcripts that deliberately emit every pathological shape the standard must
 * handle. Every `expected` block is computed BY HAND while the fixture is written — it is the
 * generator-truth leg of the Phase-0 gate (fixture truth == oracle == pipeline) and must never
 * be derived by running either implementation.
 *
 * Shapes covered (plan §3 Phase 0): intra-file re-logs, resume/fork cross-file copies (incl. a
 * content-upgrading replay and a fully-deduped zero-token fork), sidechain msgid fallback and
 * its non-sidechain NO-merge dual, validity-gate rejects (present-but-empty ids/model,
 * non-semver version) vs absent-field accepts, missing-requestId dedup, verbatim multi-model
 * capture (`<synthetic>`, >64-char ids), cache-heavy threads, the <parent>/subagents/*.jsonl
 * on-disk layout, entryPoint/thinkingTokens metadata non-perturbation, and a Codex cumulative
 * rollout.
 */

export interface FixtureTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface FixtureFile {
  /** "/"-separated path relative to the fixture project dir. No "/" = a root transcript. */
  relPath: string;
  lines: string[];
}

export interface Fixture {
  name: string;
  files: FixtureFile[];
  expected: {
    /** Global per-model verbatim totals (capture truth). Hand-computed. */
    byModel: Record<string, FixtureTokens>;
    /** Per-thread totals after global dedup + first-occurrence assignment. Hand-computed. */
    perThread: Record<string, FixtureTokens>;
    /** Threads expected to survive as ZEROED records (all entries deduped away). */
    zeroedThreads?: string[];
    /** Per-thread metadata expectations (pipeline-only; must not perturb any token number). */
    entryPoint?: Record<string, string>;
    thinkingTokens?: Record<string, number>;
  };
}

const T = (t: Partial<FixtureTokens>): FixtureTokens => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  ...t,
});

/**
 * One canonical assistant usage line. Field-presence is explicit:
 * a string value (even "") makes the field PRESENT; null OMITS it entirely.
 */
export function claudeLine(o: {
  sessionId: string | null;
  ts: string;
  msgId: string | null;
  reqId: string | null;
  model: string | null;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  sidechain?: boolean;
  version?: string | null;
  cost?: number;
  speed?: string;
  entryPoint?: string;
  thinking?: number;
  uuid?: string;
}): string {
  const usage: Record<string, unknown> = {
    input_tokens: o.input ?? 0,
    output_tokens: o.output ?? 0,
    cache_read_input_tokens: o.cacheRead ?? 0,
    cache_creation_input_tokens: o.cacheCreation ?? 0,
  };
  if (o.speed !== undefined) usage.speed = o.speed;
  if (o.thinking !== undefined) usage.thinking_tokens = o.thinking;
  const message: Record<string, unknown> = { role: "assistant", usage };
  if (o.msgId !== null) message.id = o.msgId;
  if (o.model !== null) message.model = o.model;
  const entry: Record<string, unknown> = { type: "assistant", timestamp: o.ts, message };
  if (o.sessionId !== null) entry.sessionId = o.sessionId;
  if (o.reqId !== null) entry.requestId = o.reqId;
  // version defaults to a valid semver prefix; pass null to omit, a string to control it.
  if (o.version !== null) entry.version = o.version ?? "2.1.0";
  if (o.sidechain !== undefined) entry.isSidechain = o.sidechain;
  if (o.cost !== undefined) entry.costUSD = o.cost;
  if (o.entryPoint !== undefined) entry.entryPoint = o.entryPoint;
  if (o.uuid !== undefined) entry.uuid = o.uuid;
  return JSON.stringify(entry);
}

/**
 * One AGENT-PROGRESS usage line — the nested shape subagent progress events log:
 * `{"data":{"message":{timestamp, requestId, isSidechain, message:{id, model, usage}}}}`.
 * Shape pinned verbatim from the steward reference test
 * `propagates_sidechain_metadata_from_agent_progress_lines` (daily.rs:570-578).
 * Carries NO sessionId/version/uuid — absent (valid), not empty (invalid).
 */
export function agentProgressLine(o: {
  ts: string;
  msgId: string;
  reqId: string;
  model: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  sidechain?: boolean;
}): string {
  return JSON.stringify({
    data: {
      message: {
        timestamp: o.ts,
        requestId: o.reqId,
        ...(o.sidechain !== undefined ? { isSidechain: o.sidechain } : {}),
        message: {
          id: o.msgId,
          model: o.model,
          usage: {
            input_tokens: o.input ?? 0,
            output_tokens: o.output ?? 0,
            cache_read_input_tokens: o.cacheRead ?? 0,
            cache_creation_input_tokens: o.cacheCreation ?? 0,
          },
        },
      },
    },
  });
}

export const CLAUDE_FIXTURES: Fixture[] = [
  {
    // Intra-file re-log: a partial/thinking snapshot then the complete usage under the SAME
    // (msgId, reqId). Whole-record max-wins keeps the complete copy exactly once.
    name: "intra-file-relog",
    files: [
      {
        relPath: "s-relog.jsonl",
        lines: [
          claudeLine({ sessionId: "s-relog", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 0 }),
          claudeLine({ sessionId: "s-relog", ts: "2026-06-01T10:00:05.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50, cacheRead: 200, cacheCreation: 10 }),
          claudeLine({ sessionId: "s-relog", ts: "2026-06-01T10:00:10.000Z", msgId: "m2", reqId: "r2", model: "claude-opus-4-8", input: 10, output: 5 }),
        ],
      },
    ],
    expected: {
      byModel: { "claude-opus-4-8": T({ input: 110, output: 55, cacheRead: 200, cacheCreation: 10 }) },
      perThread: { "s-relog": T({ input: 110, output: 55, cacheRead: 200, cacheCreation: 10 }) },
    },
  },
  {
    // Resume/fork replay across SIBLING files: the same (msgId, reqId) genuinely reappears in a
    // new file with a NEW sessionId. Global dedup counts it once; the first-occurrence thread
    // owns it; the fork keeps only its genuinely-new messages.
    name: "cross-file-resume",
    files: [
      {
        relPath: "s-aaa.jsonl",
        lines: [
          claudeLine({ sessionId: "s-aaa", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
          claudeLine({ sessionId: "s-aaa", ts: "2026-06-01T10:01:00.000Z", msgId: "m2", reqId: "r2", model: "claude-opus-4-8", input: 20, output: 10 }),
        ],
      },
      {
        relPath: "s-bbb.jsonl",
        lines: [
          claudeLine({ sessionId: "s-bbb", ts: "2026-06-01T11:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
          claudeLine({ sessionId: "s-bbb", ts: "2026-06-01T11:01:00.000Z", msgId: "m3", reqId: "r3", model: "claude-sonnet-4-6", input: 30, output: 15 }),
        ],
      },
    ],
    expected: {
      byModel: {
        "claude-opus-4-8": T({ input: 120, output: 60 }),
        "claude-sonnet-4-6": T({ input: 30, output: 15 }),
      },
      perThread: {
        "s-aaa": T({ input: 120, output: 60 }),
        "s-bbb": T({ input: 30, output: 15 }),
      },
    },
  },
  {
    // Cross-file content UPGRADE: the fork's replay of m1 carries the COMPLETE usage (the
    // original had a partial snapshot). Max-wins replaces the record's CONTENT with the fork's
    // copy, but the first-occurrence thread still OWNS the message — totals use the upgraded
    // numbers, lineage stays put.
    name: "cross-file-upgrade",
    files: [
      {
        relPath: "s-aaa.jsonl",
        lines: [
          claudeLine({ sessionId: "s-aaa", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 0 }),
        ],
      },
      {
        relPath: "s-bbb.jsonl",
        lines: [
          claudeLine({ sessionId: "s-bbb", ts: "2026-06-01T11:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 80, cacheRead: 500, cacheCreation: 20 }),
          claudeLine({ sessionId: "s-bbb", ts: "2026-06-01T11:01:00.000Z", msgId: "m2", reqId: "r2", model: "claude-opus-4-8", input: 5, output: 5 }),
        ],
      },
    ],
    expected: {
      byModel: { "claude-opus-4-8": T({ input: 105, output: 85, cacheRead: 500, cacheCreation: 20 }) },
      perThread: {
        "s-aaa": T({ input: 100, output: 80, cacheRead: 500, cacheCreation: 20 }),
        "s-bbb": T({ input: 5, output: 5 }),
      },
    },
  },
  {
    // A fork that ONLY replays — after global dedup it owns nothing. It must still surface as a
    // ZEROED thread (so a previously-uploaded inflated record gets overwritten), and the
    // original thread keeps every token.
    name: "zero-token-fork",
    files: [
      {
        relPath: "s-aaa.jsonl",
        lines: [
          claudeLine({ sessionId: "s-aaa", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
          claudeLine({ sessionId: "s-aaa", ts: "2026-06-01T10:01:00.000Z", msgId: "m2", reqId: "r2", model: "claude-opus-4-8", input: 20, output: 10 }),
        ],
      },
      {
        relPath: "s-bbb.jsonl",
        lines: [
          claudeLine({ sessionId: "s-bbb", ts: "2026-06-01T11:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
          claudeLine({ sessionId: "s-bbb", ts: "2026-06-01T11:01:00.000Z", msgId: "m2", reqId: "r2", model: "claude-opus-4-8", input: 20, output: 10 }),
        ],
      },
    ],
    expected: {
      byModel: { "claude-opus-4-8": T({ input: 120, output: 60 }) },
      perThread: {
        "s-aaa": T({ input: 120, output: 60 }),
        "s-bbb": T({}),
      },
      zeroedThreads: ["s-bbb"],
    },
  },
  {
    // Sidechain msgid fallback: a parent message replayed INSIDE a sidechain with a NEW
    // requestId dedups via the msgid-only fallback (>=1 side is a sidechain) and the
    // NON-sidechain parent copy is kept. The sidechain's own unique message still counts.
    name: "sidechain-fallback",
    files: [
      {
        relPath: "s-side.jsonl",
        lines: [
          claudeLine({ sessionId: "s-side", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
          claudeLine({ sessionId: "s-side", ts: "2026-06-01T10:00:30.000Z", msgId: "m1", reqId: "r2", model: "claude-opus-4-8", input: 100, output: 50, sidechain: true }),
          claudeLine({ sessionId: "s-side", ts: "2026-06-01T10:01:00.000Z", msgId: "m9", reqId: "r9", model: "claude-opus-4-8", input: 40, output: 20, sidechain: true }),
        ],
      },
    ],
    expected: {
      byModel: { "claude-opus-4-8": T({ input: 140, output: 70 }) },
      perThread: { "s-side": T({ input: 140, output: 70 }) },
    },
  },
  {
    // The fallback's dual: two NON-sidechain entries sharing a msgId but differing on requestId
    // must NOT merge — both count. (A wrongly-broadened fallback under-counts here.)
    name: "sidechain-no-merge",
    files: [
      {
        relPath: "s-nomerge.jsonl",
        lines: [
          claudeLine({ sessionId: "s-nomerge", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
          claudeLine({ sessionId: "s-nomerge", ts: "2026-06-01T10:00:30.000Z", msgId: "m1", reqId: "r2", model: "claude-opus-4-8", input: 100, output: 50 }),
        ],
      },
    ],
    expected: {
      byModel: { "claude-opus-4-8": T({ input: 200, output: 100 }) },
      perThread: { "s-nomerge": T({ input: 200, output: 100 }) },
    },
  },
  {
    // Validity gate: present-but-EMPTY sessionId/requestId/messageId/model and a present
    // non-semver version reject the WHOLE entry (999s make a leak loud). ABSENT fields are
    // fine: no-msgId counts as-is, no-version counts, no-model buckets as "unknown".
    name: "validity-gate",
    files: [
      {
        relPath: "s-valid.jsonl",
        lines: [
          claudeLine({ sessionId: "s-valid", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 10, output: 5 }),
          claudeLine({ sessionId: "s-valid", ts: "2026-06-01T10:00:10.000Z", msgId: "", reqId: "r2", model: "claude-opus-4-8", input: 999, output: 999 }),
          claudeLine({ sessionId: "s-valid", ts: "2026-06-01T10:00:20.000Z", msgId: null, reqId: "r3", model: "claude-opus-4-8", input: 7, output: 3 }),
          claudeLine({ sessionId: "s-valid", ts: "2026-06-01T10:00:30.000Z", msgId: "m3", reqId: "r3b", model: "claude-opus-4-8", input: 50, output: 25, version: "dev" }),
          claudeLine({ sessionId: "s-valid", ts: "2026-06-01T10:00:40.000Z", msgId: "m4", reqId: "r4", model: "", input: 60, output: 30 }),
          claudeLine({ sessionId: "", ts: "2026-06-01T10:00:50.000Z", msgId: "m5", reqId: "r5", model: "claude-opus-4-8", input: 70, output: 35 }),
          claudeLine({ sessionId: "s-valid", ts: "2026-06-01T10:01:00.000Z", msgId: "m6", reqId: "", model: "claude-opus-4-8", input: 80, output: 40 }),
          claudeLine({ sessionId: "s-valid", ts: "2026-06-01T10:01:10.000Z", msgId: "m7", reqId: "r7", model: "claude-opus-4-8", input: 5, output: 2, version: null }),
          claudeLine({ sessionId: "s-valid", ts: "2026-06-01T10:01:20.000Z", msgId: "m8", reqId: "r8", model: null, input: 3, output: 1 }),
        ],
      },
    ],
    expected: {
      byModel: {
        "claude-opus-4-8": T({ input: 22, output: 10 }), // 10+7+5 / 5+3+2
        unknown: T({ input: 3, output: 1 }),
      },
      perThread: { "s-valid": T({ input: 25, output: 11 }) },
    },
  },
  {
    // Missing requestId: absent === absent matches the EXACT tier (two no-reqId copies of m1
    // dedup), while (m1, r1) vs (m1, absent) stays distinct — no sidechain, no fallback.
    name: "missing-request-id",
    files: [
      {
        relPath: "s-noreq.jsonl",
        lines: [
          claudeLine({ sessionId: "s-noreq", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: null, model: "claude-opus-4-8", input: 100, output: 50 }),
          claudeLine({ sessionId: "s-noreq", ts: "2026-06-01T10:00:10.000Z", msgId: "m1", reqId: null, model: "claude-opus-4-8", input: 100, output: 50 }),
          claudeLine({ sessionId: "s-noreq", ts: "2026-06-01T10:00:20.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 30, output: 15 }),
        ],
      },
    ],
    expected: {
      byModel: { "claude-opus-4-8": T({ input: 130, output: 65 }) },
      perThread: { "s-noreq": T({ input: 130, output: 65 }) },
    },
  },
  {
    // Verbatim multi-model capture: `<synthetic>` kept as its own bucket, a >64-char router id
    // kept at full length, no cap, no "other" fold. (Display shortening is render's job.)
    name: "multi-model-verbatim",
    files: [
      {
        relPath: "s-models.jsonl",
        lines: [
          claudeLine({ sessionId: "s-models", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "<synthetic>", input: 0, output: 5 }),
          claudeLine({ sessionId: "s-models", ts: "2026-06-01T10:00:10.000Z", msgId: "m2", reqId: "r2", model: "custom/routed-model-id-" + "x".repeat(60), input: 10, output: 5 }),
          claudeLine({ sessionId: "s-models", ts: "2026-06-01T10:00:20.000Z", msgId: "m3", reqId: "r3", model: "gpt-5.5-codex-preview", input: 20, output: 10 }),
        ],
      },
    ],
    expected: {
      byModel: {
        "<synthetic>": T({ input: 0, output: 5 }),
        ["custom/routed-model-id-" + "x".repeat(60)]: T({ input: 10, output: 5 }),
        "gpt-5.5-codex-preview": T({ input: 20, output: 10 }),
      },
      perThread: { "s-models": T({ input: 30, output: 20 }) },
    },
  },
  {
    // Cache-heavy thread: exact per-type sums with cacheRead/cacheCreation dominant.
    name: "cache-heavy",
    files: [
      {
        relPath: "s-cache.jsonl",
        lines: [
          claudeLine({ sessionId: "s-cache", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 10, output: 5, cacheRead: 100000, cacheCreation: 5000 }),
          claudeLine({ sessionId: "s-cache", ts: "2026-06-01T10:00:10.000Z", msgId: "m2", reqId: "r2", model: "claude-opus-4-8", input: 1, output: 1, cacheRead: 50000 }),
        ],
      },
    ],
    expected: {
      byModel: { "claude-opus-4-8": T({ input: 11, output: 6, cacheRead: 150000, cacheCreation: 5000 }) },
      perThread: { "s-cache": T({ input: 11, output: 6, cacheRead: 150000, cacheCreation: 5000 }) },
    },
  },
  {
    // The <parent>/subagents/*.jsonl ON-DISK LAYOUT (explicit fixture per plan §2 — this layout
    // is a fixture requirement, not a verified premise). Subagent usage attributes to the
    // PARENT thread; a parent message replayed inside a subagent file with a new requestId
    // dedups via the sidechain fallback; the nested workflows/ tree is walked too.
    name: "subagent-layout",
    files: [
      {
        relPath: "s-root.jsonl",
        lines: [
          claudeLine({ sessionId: "s-root", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
        ],
      },
      {
        relPath: "s-root/subagents/agent-x.jsonl",
        lines: [
          claudeLine({ sessionId: "s-root", ts: "2026-06-01T10:00:30.000Z", msgId: "m1", reqId: "r2", model: "claude-opus-4-8", input: 100, output: 50, sidechain: true }),
          claudeLine({ sessionId: "s-root", ts: "2026-06-01T10:01:00.000Z", msgId: "m2", reqId: "r9", model: "claude-sonnet-4-6", input: 200, output: 80, sidechain: true }),
        ],
      },
      {
        relPath: "s-root/subagents/workflows/wf_1/agent-y.jsonl",
        lines: [
          claudeLine({ sessionId: "s-root", ts: "2026-06-01T10:02:00.000Z", msgId: "m3", reqId: "r10", model: "claude-opus-4-8", input: 10, output: 0, sidechain: true }),
        ],
      },
    ],
    expected: {
      byModel: {
        "claude-opus-4-8": T({ input: 110, output: 50 }),
        "claude-sonnet-4-6": T({ input: 200, output: 80 }),
      },
      perThread: { "s-root": T({ input: 310, output: 130 }) },
    },
  },
  {
    // The AGENT-PROGRESS transcript shape (usage nested at data.message.message.usage,
    // isSidechain/requestId at data.message). A parent message replayed via an
    // agent-progress line with a NEW requestId must dedup through the sidechain fallback
    // (the nested isSidechain drives the tier — spec §1 "from the direct entry AND the
    // nested agent-progress shape"); the progress event's own unique message still counts.
    name: "agent-progress-shape",
    files: [
      {
        relPath: "s-agent.jsonl",
        lines: [
          claudeLine({ sessionId: "s-agent", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
          agentProgressLine({ ts: "2026-06-01T10:00:30.000Z", msgId: "m1", reqId: "r2", model: "claude-opus-4-8", input: 100, output: 50, sidechain: true }),
          agentProgressLine({ ts: "2026-06-01T10:01:00.000Z", msgId: "m9", reqId: "r9", model: "claude-sonnet-4-6", input: 40, output: 20, sidechain: true }),
        ],
      },
    ],
    expected: {
      byModel: {
        "claude-opus-4-8": T({ input: 100, output: 50 }),
        "claude-sonnet-4-6": T({ input: 40, output: 20 }),
      },
      perThread: { "s-agent": T({ input: 140, output: 70 }) },
    },
  },
  {
    // Replacement step 3 (cost tiebreak): equal totals, no speed on either copy, greater
    // costUSD wins. The copies carry DIFFERENT model ids so the surviving record is
    // observable in byModel (whole-record replacement carries the model field along).
    name: "cost-tiebreak",
    files: [
      {
        relPath: "s-cost.jsonl",
        lines: [
          claudeLine({ sessionId: "s-cost", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "model-cheap-copy", input: 100, output: 50, cost: 0.001 }),
          claudeLine({ sessionId: "s-cost", ts: "2026-06-01T10:00:05.000Z", msgId: "m1", reqId: "r1", model: "model-costly-copy", input: 100, output: 50, cost: 0.002 }),
        ],
      },
    ],
    expected: {
      byModel: { "model-costly-copy": T({ input: 100, output: 50 }) },
      perThread: { "s-cost": T({ input: 100, output: 50 }) },
    },
  },
  {
    // Replacement step 4 (speed tiebreak): equal totals, equal cost, the copy with a
    // populated `speed` field wins. Different model ids make the survivor observable.
    name: "speed-tiebreak",
    files: [
      {
        relPath: "s-speed.jsonl",
        lines: [
          claudeLine({ sessionId: "s-speed", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "model-no-speed", input: 100, output: 50 }),
          claudeLine({ sessionId: "s-speed", ts: "2026-06-01T10:00:05.000Z", msgId: "m1", reqId: "r1", model: "model-with-speed", input: 100, output: 50, speed: "fast" }),
        ],
      },
    ],
    expected: {
      byModel: { "model-with-speed": T({ input: 100, output: 50 }) },
      perThread: { "s-speed": T({ input: 100, output: 50 }) },
    },
  },
  {
    // entryPoint + thinkingTokens are STATUS metadata: same token numbers as intra-file-relog,
    // now with entryPoint fields and thinking counts attached. Token totals must be IDENTICAL
    // (metadata cannot perturb the standard), thinking sums over SURVIVORS only (the replaced
    // partial's 10 must not count), and the thread reports entryPoint "vscode".
    name: "metadata-no-perturbation",
    files: [
      {
        relPath: "s-meta.jsonl",
        lines: [
          claudeLine({ sessionId: "s-meta", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 0, entryPoint: "vscode", thinking: 10 }),
          claudeLine({ sessionId: "s-meta", ts: "2026-06-01T10:00:05.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50, cacheRead: 200, cacheCreation: 10, entryPoint: "vscode", thinking: 25 }),
          claudeLine({ sessionId: "s-meta", ts: "2026-06-01T10:00:10.000Z", msgId: "m2", reqId: "r2", model: "claude-opus-4-8", input: 10, output: 5, entryPoint: "vscode", thinking: 5 }),
        ],
      },
    ],
    expected: {
      byModel: { "claude-opus-4-8": T({ input: 110, output: 55, cacheRead: 200, cacheCreation: 10 }) },
      perThread: { "s-meta": T({ input: 110, output: 55, cacheRead: 200, cacheCreation: 10 }) },
      entryPoint: { "s-meta": "vscode" },
      thinkingTokens: { "s-meta": 30 },
    },
  },
];

// ---- Codex cumulative rollout (pipeline-only leg: generator truth == parseCodexRollout) ------

export interface CodexFixture {
  name: string;
  lines: string[];
  expected: {
    tokens: FixtureTokens;
    byModel: Record<string, FixtureTokens>;
    thinkingTokens: number;
  };
}

export const CODEX_FIXTURE: CodexFixture = {
  // Cumulative snapshots: the session total is the LAST snapshot (input_tokens INCLUSIVE of
  // cached_input_tokens -> fresh input = input - cached, cached -> cacheRead). Per-model
  // attribution accumulates consecutive snapshot DELTAS. Hand-computed:
  //   snapshot1 {in:100, cached:40, out:20, reasoning:5}  -> delta {fresh:60, cacheRead:40, out:20}
  //   snapshot2 {in:300, cached:100, out:80, reasoning:20} -> delta {fresh:140, cacheRead:60, out:60}
  //   session total = last snapshot = {fresh:200, out:80, cacheRead:100}; thinking = 20.
  name: "codex-cumulative",
  lines: [
    JSON.stringify({ timestamp: "2026-06-01T12:00:00.000Z", type: "session_meta", payload: { id: "c-1" } }),
    JSON.stringify({ timestamp: "2026-06-01T12:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.5" } }),
    JSON.stringify({
      timestamp: "2026-06-01T12:00:10.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } },
    }),
    JSON.stringify({ timestamp: "2026-06-01T12:00:30.000Z", type: "turn_context", payload: { model: "gpt-5.5" } }),
    JSON.stringify({
      timestamp: "2026-06-01T12:01:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 80, reasoning_output_tokens: 20, total_tokens: 380 } } },
    }),
  ],
  expected: {
    tokens: T({ input: 200, output: 80, cacheRead: 100 }),
    byModel: { "gpt-5.5": T({ input: 200, output: 80, cacheRead: 100 }) },
    thinkingTokens: 20,
  },
};
