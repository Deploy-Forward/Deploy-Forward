/**
 * MUE capture at the CORPUS grain (docs/model-use-efficiency.md).
 *
 * The pure math is unit-tested in contextEfficiency.test.ts. THIS pins the INTEGRATION the
 * summary flagged as load-bearing: summarizeClaudeCorpus must compute MUE on the GLOBAL
 * cross-file deduped MAIN-THREAD series — not per-file — attach it to the first-occurrence
 * (owning) thread, reconcile cActual with that session's own context total, exclude subagent
 * windows (a separate context window would corrupt the exponent), and mint NO MUE for a
 * replay-only tombstone (consistent with the zeroed-record invariant). Hermetic: real files
 * under a temp dir, no network/admin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { claudeLine } from "./fixtures.ts";
import { summarizeClaudeCorpus } from "../src/sync.ts";
import { PARSER_EPOCH, type TrackerState } from "../src/config.ts";

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

/** Write files under a temp project dir; return corpus sources (roots + their subagents). */
function write(files: { relPath: string; lines: string[] }[]): { path: string; subagents: string[] }[] {
  const proj = join(mkdtempSync(join(tmpdir(), "df-mue-")), "proj");
  for (const f of files) {
    const full = join(proj, ...f.relPath.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.lines.join("\n"));
  }
  return files
    .filter((f) => !f.relPath.includes("/"))
    .map((root) => ({
      path: join(proj, root.relPath),
      subagents: files
        .filter((f) => f.relPath.startsWith(root.relPath.replace(/\.jsonl$/, "") + "/subagents/"))
        .map((f) => join(proj, ...f.relPath.split("/"))),
    }));
}

/** N disciplined assistant messages on one thread: FLAT per-turn context ⟹ K ∝ O ⟹ alpha = 1. */
function flatThread(sessionId: string, n: number, ctx: number, out: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    claudeLine({
      sessionId,
      ts: `2026-06-01T10:${String(i).padStart(2, "0")}:00.000Z`,
      msgId: `${sessionId}-m${i + 1}`,
      reqId: `${sessionId}-r${i + 1}`,
      model: "claude-opus-4-8",
      input: ctx,
      output: out,
    }),
  );
}

test("MUE attaches to a disciplined single-file session: alpha=1, ratio=1, cActual reconciles", () => {
  const sources = write([{ relPath: "s-disc.jsonl", lines: flatThread("s-disc", 10, 30_000, 1_000) }]);
  const [s] = summarizeClaudeCorpus(sources, testState());
  assert.ok(s.mue, "MUE present on a 10-message session");
  assert.equal(s.mue!.points, 10);
  assert.ok(Math.abs(s.mue!.alpha - 1) < 1e-9, `alpha ~1, got ${s.mue!.alpha}`);
  assert.equal(s.mue!.ratio, 1);
  assert.equal(s.mue!.cActual, 300_000);
  // Reconciliation: with no sidechains, cActual is exactly the session's own non-output context.
  assert.equal(s.mue!.cActual, s.tokens.input + s.tokens.cacheRead + s.tokens.cacheCreation);
});

test("MUE is computed on the GLOBAL series: the owning thread carries it, a replay-only fork mints none", () => {
  // s-bbb replays every one of s-aaa's messages (SAME msgId+reqId) under a new sessionId and a
  // later clock — a pure-replay fork. Global dedup gives every message to s-aaa (first occurrence);
  // s-bbb owns nothing and surfaces as a tombstone.
  const replay = (i: number): string =>
    claudeLine({
      sessionId: "s-bbb",
      ts: `2026-06-01T12:${String(i).padStart(2, "0")}:00.000Z`,
      msgId: `s-aaa-m${i + 1}`,
      reqId: `s-aaa-r${i + 1}`,
      model: "claude-opus-4-8",
      input: 30_000,
      output: 1_000,
    });
  const sources = write([
    { relPath: "s-aaa.jsonl", lines: flatThread("s-aaa", 10, 30_000, 1_000) },
    { relPath: "s-bbb.jsonl", lines: Array.from({ length: 10 }, (_, i) => replay(i)) },
  ]);
  const byThread = new Map(summarizeClaudeCorpus(sources, testState()).map((s) => [s.toolSessionId, s]));
  const owner = byThread.get("s-aaa")!;
  const fork = byThread.get("s-bbb")!;
  assert.ok(owner.mue, "the first-occurrence owner carries the MUE");
  assert.equal(owner.mue!.points, 10);
  assert.ok(Math.abs(owner.mue!.alpha - 1) < 1e-9);
  assert.equal(fork.messageCount, 0, "the replay fork is a tombstone");
  assert.equal(fork.mue, undefined, "a replay-only tombstone mints no MUE");
});

test("MUE excludes subagent windows: cActual counts only the main-thread context", () => {
  const root = flatThread("s-root", 10, 30_000, 1_000);
  // A subagent file: a huge SEPARATE context window (900k) that must not enter the main-thread
  // exponent or cActual — but the session TOKEN total still includes it (it is real spend).
  const sub = [
    claudeLine({ sessionId: "s-root", ts: "2026-06-01T10:20:00.000Z", msgId: "sub-m1", reqId: "sub-r1", model: "claude-sonnet-4-6", input: 500_000, output: 50_000, sidechain: true }),
    claudeLine({ sessionId: "s-root", ts: "2026-06-01T10:21:00.000Z", msgId: "sub-m2", reqId: "sub-r2", model: "claude-sonnet-4-6", input: 400_000, output: 40_000, sidechain: true }),
  ];
  const sources = write([
    { relPath: "s-root.jsonl", lines: root },
    { relPath: "s-root/subagents/agent-x.jsonl", lines: sub },
  ]);
  const [s] = summarizeClaudeCorpus(sources, testState());
  assert.ok(s.mue);
  assert.equal(s.mue!.points, 10, "only the 10 main-thread messages are MUE points");
  assert.equal(s.mue!.cActual, 300_000, "the subagent's 900k context is excluded from cActual");
  assert.notEqual(
    s.mue!.cActual,
    s.tokens.input + s.tokens.cacheRead + s.tokens.cacheCreation,
    "cActual is a deliberate main-thread subset, so it must differ from the session total here",
  );
});
