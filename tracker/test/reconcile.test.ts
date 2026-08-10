/**
 * Deploy Forward Atomic Capture Standard — the PHASE-0 GATE.
 *
 * For every synthetic fixture the three legs must agree exactly, per model, per token type,
 * to the token:
 *
 *     fixture truth (hand-computed)  ==  independent oracle  ==  tracker pipeline
 *
 * The pipeline leg runs the REAL sync-level corpus summarizer over real files on disk (global
 * cross-file dedup + first-occurrence thread assignment + zero-token thread emission), not just
 * the per-file parser. The oracle receives the files in REVERSED declaration order to prove the
 * corpus ordering is derived internally, not inherited from input order.
 *
 * Also asserted here (acceptance criterion 3): Σ models == tokens on every emitted summary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { CLAUDE_FIXTURES, CODEX_FIXTURE, type Fixture, type FixtureTokens } from "./fixtures.ts";
import { runOracle } from "./oracle.ts";
import { summarizeClaudeCorpus } from "../src/sync.ts";
import { parseCodexRollout } from "../src/codex.ts";
import { PARSER_EPOCH, type TrackerState } from "../src/config.ts";
import type { SessionSummary } from "../src/types.ts";

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

/** Write a fixture's files under a temp project dir; return the corpus sources (roots + subs). */
function writeFixture(fx: Fixture): { path: string; subagents: string[] }[] {
  const proj = join(mkdtempSync(join(tmpdir(), `df-fx-${fx.name}-`)), "proj");
  for (const f of fx.files) {
    const full = join(proj, ...f.relPath.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.lines.join("\n"));
  }
  return fx.files
    .filter((f) => !f.relPath.includes("/"))
    .map((root) => ({
      path: join(proj, root.relPath),
      subagents: fx.files
        .filter((f) => f.relPath.startsWith(root.relPath.replace(/\.jsonl$/, "") + "/subagents/"))
        .map((f) => join(proj, ...f.relPath.split("/"))),
    }));
}

function sumModels(s: SessionSummary): FixtureTokens {
  return s.models.reduce(
    (a, m) => ({
      input: a.input + m.input,
      output: a.output + m.output,
      cacheRead: a.cacheRead + m.cacheRead,
      cacheCreation: a.cacheCreation + m.cacheCreation,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  );
}

function foldByModel(summaries: SessionSummary[]): Record<string, FixtureTokens> {
  const out: Record<string, FixtureTokens> = {};
  for (const s of summaries) {
    for (const m of s.models) {
      out[m.id] ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      out[m.id].input += m.input;
      out[m.id].output += m.output;
      out[m.id].cacheRead += m.cacheRead;
      out[m.id].cacheCreation += m.cacheCreation;
    }
  }
  return out;
}

for (const fx of CLAUDE_FIXTURES) {
  test(`capture standard: ${fx.name} — oracle matches generator truth`, () => {
    // Reversed input order: the oracle must derive the corpus order itself.
    const result = runOracle(
      [...fx.files].reverse().map((f) => ({ relPath: f.relPath, content: f.lines.join("\n") })),
    );
    assert.deepEqual(result.byModel, fx.expected.byModel, "global per-model totals");
    assert.deepEqual(result.perThread, fx.expected.perThread, "per-thread first-occurrence totals");
    assert.deepEqual(result.zeroedThreads, fx.expected.zeroedThreads ?? [], "zeroed threads");
    // Derived-total invariant: totals == Σ byModel.
    const derived = Object.values(result.byModel).reduce(
      (a, t) => ({
        input: a.input + t.input,
        output: a.output + t.output,
        cacheRead: a.cacheRead + t.cacheRead,
        cacheCreation: a.cacheCreation + t.cacheCreation,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    );
    assert.deepEqual(result.totals, derived, "totals derive from Σ models");
  });

  test(`capture standard: ${fx.name} — pipeline matches generator truth`, () => {
    const sources = writeFixture(fx);
    const summaries = summarizeClaudeCorpus(sources, testState());
    const byThread = new Map(summaries.map((s) => [s.toolSessionId, s]));

    const expectedThreads = Object.keys(fx.expected.perThread).sort();
    assert.deepEqual(
      [...byThread.keys()].sort(),
      expectedThreads,
      "one summary per expected thread (zeroed forks included)",
    );

    for (const [threadId, tokens] of Object.entries(fx.expected.perThread)) {
      const s = byThread.get(threadId)!;
      assert.deepEqual(s.tokens, tokens, `thread ${threadId} token totals`);
      // Acceptance criterion 3: the stored total IS the sum of the per-model atoms.
      assert.deepEqual(s.tokens, sumModels(s), `thread ${threadId}: Σ models == tokens`);
    }
    assert.deepEqual(foldByModel(summaries), fx.expected.byModel, "global per-model totals");

    for (const threadId of fx.expected.zeroedThreads ?? []) {
      const s = byThread.get(threadId)!;
      // A replay-only fork is a full TOMBSTONE: every aggregate-visible atom is zeroed,
      // not just tokens — its timestamps/prompts are verbatim copies of the original
      // thread's, so crediting activity/turns/practices from them would double-count.
      assert.equal(s.messageCount, 0, `zeroed thread ${threadId} owns no surviving messages`);
      assert.deepEqual(s.models, [], `zeroed thread ${threadId} has an empty model mix`);
      assert.equal(s.turns, 0, `zeroed thread ${threadId} mints no turns`);
      assert.equal(s.activeMs, 0, `zeroed thread ${threadId} mints no active time`);
      assert.equal(s.wallMs, 0, `zeroed thread ${threadId} mints no wall time`);
      assert.equal(s.longestLoopMs, 0, `zeroed thread ${threadId} mints no loop span`);
      assert.equal(s.thinkingTokens, 0, `zeroed thread ${threadId} mints no thinking`);
      assert.equal(s.skills, undefined, `zeroed thread ${threadId} mints no practice counts`);
      assert.equal(s.entryPoint, "unknown", `zeroed thread ${threadId} mints no entrypoint signal`);
    }
    for (const [threadId, ep] of Object.entries(fx.expected.entryPoint ?? {})) {
      assert.equal(byThread.get(threadId)!.entryPoint, ep, `thread ${threadId} entryPoint`);
    }
    for (const [threadId, tt] of Object.entries(fx.expected.thinkingTokens ?? {})) {
      assert.equal(byThread.get(threadId)!.thinkingTokens, tt, `thread ${threadId} thinkingTokens`);
    }
  });
}

test("capture standard: three consecutive corpus summarizations are identical (idempotent re-sync, criterion 5)", () => {
  const fx = CLAUDE_FIXTURES.find((f) => f.name === "cross-file-upgrade")!;
  const sources = writeFixture(fx);
  const a = summarizeClaudeCorpus(sources, testState());
  const b = summarizeClaudeCorpus(sources, testState());
  const c = summarizeClaudeCorpus(sources, testState());
  assert.deepEqual(a, b, "run 2 == run 1");
  assert.deepEqual(b, c, "run 3 == run 2");
});

test(`capture standard: ${CODEX_FIXTURE.name} — pipeline matches generator truth`, () => {
  const p = parseCodexRollout(CODEX_FIXTURE.lines.join("\n"));
  assert.deepEqual(p.tokens, CODEX_FIXTURE.expected.tokens, "session total = last cumulative snapshot");
  assert.equal(p.thinkingTokens, CODEX_FIXTURE.expected.thinkingTokens);
  const byModel: Record<string, FixtureTokens> = {};
  for (const m of p.models) byModel[m.id] = { input: m.input, output: m.output, cacheRead: m.cacheRead, cacheCreation: m.cacheCreation };
  assert.deepEqual(byModel, CODEX_FIXTURE.expected.byModel, "per-model delta attribution");
});
