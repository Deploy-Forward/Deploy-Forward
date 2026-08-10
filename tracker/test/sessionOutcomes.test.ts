/**
 * Candidate-outcome capture (per-session outcome ledger v1). Hermetic: the git runner is INJECTED,
 * so no subprocess/disk/network. Pins the metadata-only contract (commit SHAs, never diff/code/prompt),
 * the session-window + local-author git scoping, dedup, and every fail-closed exit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateOutcomes, type GitRunner } from "../src/sessionOutcomes";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function fakeGit(email: string | null, log: string | null): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GitRunner = (args) => {
    calls.push(args);
    if (args.includes("user.email")) return email;
    if (args.includes("log")) return log;
    return null;
  };
  return { run, calls };
}

const session = (
  over: Partial<{ cwd: string | undefined; startedAt: number; endedAt: number; repoHash: string | null }> = {},
) => ({ cwd: "/repo" as string | undefined, startedAt: 1000, endedAt: 2000, repoHash: "rh" as string | null, ...over });

test("captures window commit SHAs as metadata-only commit outcomes", () => {
  const { run } = fakeGit("me@x.com\n", `${SHA_A}\n${SHA_B}\n`);
  const out = candidateOutcomes(session(), run, new Map())!;
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { type: "commit", sha: SHA_A, repoHash: "rh", observedAt: 2000 });
  // metadata ONLY — never a diff/code/prompt field
  assert.deepEqual(Object.keys(out[0]).sort(), ["observedAt", "repoHash", "sha", "type"]);
});

test("scopes git log to the session window and the local author", () => {
  const { run, calls } = fakeGit("me@x.com", SHA_A);
  candidateOutcomes(session(), run, new Map());
  const logCall = calls.find((c) => c.includes("log"))!;
  assert.ok(logCall.includes(`--since=${new Date(1000).toISOString()}`), "since = window start");
  assert.ok(logCall.includes(`--until=${new Date(2000).toISOString()}`), "until = window end");
  assert.ok(logCall.includes("--author=me@x.com"), "filtered to the local author");
  assert.ok(logCall.includes("--no-merges"), "no merge commits");
  assert.ok(logCall.includes("--format=%H"), "SHA only, never content");
});

test("no author filter when git has no user.email", () => {
  const { run, calls } = fakeGit(null, SHA_A);
  const out = candidateOutcomes(session(), run, new Map())!;
  assert.equal(out.length, 1);
  const logCall = calls.find((c) => c.includes("log"))!;
  assert.ok(!logCall.some((a) => a.startsWith("--author=")), "no author arg when email absent");
});

test("undefined (fail-closed) when git log fails", () => {
  const { run } = fakeGit("me@x.com", null);
  assert.equal(candidateOutcomes(session(), run, new Map()), undefined);
});

test("undefined with no cwd — never spawns git", () => {
  let spawned = false;
  const run: GitRunner = () => {
    spawned = true;
    return SHA_A;
  };
  assert.equal(candidateOutcomes(session({ cwd: undefined }), run, new Map()), undefined);
  assert.equal(spawned, false);
});

test("dedups repeated SHAs and ignores non-SHA noise", () => {
  const { run } = fakeGit("", `not-a-sha\n${SHA_A}\n${SHA_A}\n`);
  const out = candidateOutcomes(session(), run, new Map())!;
  assert.equal(out.length, 1);
  assert.equal(out[0].sha, SHA_A);
});

test("undefined when the window is degenerate (end before start)", () => {
  const { run } = fakeGit("x", SHA_A);
  assert.equal(candidateOutcomes(session({ startedAt: 2000, endedAt: 1000 }), run, new Map()), undefined);
});

test("undefined when no commits fall in the window (empty log)", () => {
  const { run } = fakeGit("me@x.com", "");
  assert.equal(candidateOutcomes(session(), run, new Map()), undefined);
});
