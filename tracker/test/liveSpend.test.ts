/**
 * L19 — the tracker's throttled LIVE spend push builder. TEST-AUTHOR pass only: no
 * production code here, and the module under test (../src/liveSpend) does NOT exist yet,
 * so EVERY test is EXPECTED TO FAIL RED until the code-author lands it. Do not fake a pass.
 *
 * The push is what the interactive live monitor loop (bin/df.ts monitorLoop) sends every
 * ~45s while a session is actively producing tokens AND the device is org-enrolled. This
 * suite pins the PURE decision seam, exactly the way orgContext.test.ts pins orgRepoFor
 * (the client-side privacy boundary) — the network POST + monitor wiring is fail-silent
 * plumbing the code-author adds on top.
 *
 *   liveSpendEnabled(env)        — the DF_* off switch (privacy/off), read from a
 *                                  synthetic env so the test stays hermetic.
 *   buildLiveSpendPush(args)     — enrolled + active + past-interval → a counts-only
 *                                  { sessionId, tokensByModel, ts } payload; otherwise
 *                                  null (unenrolled, idle, throttled, or nothing running).
 *   liveSpendSignatureOf(map)    — stable "have the tokens moved since last push" digest.
 *
 * INVARIANTS pinned: counts-only on the wire (no cwd/repoHash/orgRepo/entryPoint ever); a
 * non-enrolled device pushes NOTHING; idle/throttled/disabled are no-ops.
 *
 * Run: npm test   (node --import tsx --test test/*.test.ts)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildLiveSpendPush,
  liveSpendEnabled,
  liveSpendSignatureOf,
  LIVE_PUSH_INTERVAL_MS,
} from "../src/liveSpend.ts";

const NOW = 1_750_000_000_000;

/** A running-session shape carrying DELIBERATE extra local-only fields (cwd, repoHash,
 * orgRepo, entryPoint) that must NEVER leak onto the counts-only wire payload. */
function runningSession(over: Record<string, unknown> = {}) {
  return {
    toolSessionId: "sess-1",
    endedAt: NOW,
    models: [
      { id: "claude-opus-4-8", input: 10, output: 20, cacheRead: 30, cacheCreation: 40 },
    ],
    // local-only noise the builder must strip:
    cwd: "/home/m/secret-project",
    repoHash: "deadbeef",
    orgRepo: "acme/secret",
    entryPoint: "cli",
    ...over,
  };
}

// ---- liveSpendEnabled: the DF_* off switch ------------------------------------------

test("liveSpendEnabled: on by default, off when the DF_ kill switch is set", () => {
  assert.equal(liveSpendEnabled({}), true, "default is enabled");
  // The exact env NAME is the code-author's to finalize, but SOME DF_LIVE_SPEND=0/off/false
  // must disable it, and honoring an explicit off is the pinned contract.
  assert.equal(liveSpendEnabled({ DF_LIVE_SPEND: "0" }), false);
  assert.equal(liveSpendEnabled({ DF_LIVE_SPEND: "off" }), false);
  assert.equal(liveSpendEnabled({ DF_LIVE_SPEND: "false" }), false);
  assert.equal(liveSpendEnabled({ DF_LIVE_SPEND: "1" }), true, "any non-off value stays enabled");
});

// ---- buildLiveSpendPush: the happy path (enrolled + active + past interval) ----------

test("buildLiveSpendPush: enrolled + a running session + no prior push → a payload", () => {
  const push = buildLiveSpendPush({
    sessions: [runningSession()],
    enrolled: true,
    now: NOW,
    last: null,
  });
  assert.ok(push, "a first push for an enrolled, active device must be emitted");
  assert.equal(push!.sessionId, "sess-1");
  assert.equal(push!.ts, NOW);
  assert.deepEqual(push!.tokensByModel["claude-opus-4-8"], {
    input: 10, output: 20, cacheRead: 30, cacheCreation: 40,
  });
});

test("buildLiveSpendPush: the payload is COUNTS-ONLY — no local-only field ever leaks", () => {
  const push = buildLiveSpendPush({ sessions: [runningSession()], enrolled: true, now: NOW, last: null });
  assert.ok(push);
  // Exactly the three whitelisted keys — cwd/repoHash/orgRepo/entryPoint never ride along.
  assert.deepEqual(Object.keys(push!).sort(), ["sessionId", "tokensByModel", "ts"]);
  for (const counts of Object.values(push!.tokensByModel)) {
    assert.deepEqual(Object.keys(counts).sort(), ["cacheCreation", "cacheRead", "input", "output"]);
  }
});

// ---- buildLiveSpendPush: the gates that make it a no-op ------------------------------

test("buildLiveSpendPush: a NON-enrolled device pushes nothing (null)", () => {
  const push = buildLiveSpendPush({ sessions: [runningSession()], enrolled: false, now: NOW, last: null });
  assert.equal(push, null);
});

test("buildLiveSpendPush: nothing running (no sessions) → null", () => {
  assert.equal(buildLiveSpendPush({ sessions: [], enrolled: true, now: NOW, last: null }), null);
});

test("buildLiveSpendPush: IDLE (tokens unchanged since last push) → null", () => {
  const first = buildLiveSpendPush({ sessions: [runningSession()], enrolled: true, now: NOW, last: null });
  assert.ok(first);
  const sig = liveSpendSignatureOf(first!.tokensByModel);
  // Even well PAST the interval, an unchanged token signature must not re-push.
  const push = buildLiveSpendPush({
    sessions: [runningSession()],
    enrolled: true,
    now: NOW + LIVE_PUSH_INTERVAL_MS + 10_000,
    last: { pushedAt: NOW, sessionId: "sess-1", signature: sig },
  });
  assert.equal(push, null, "no new tokens since last push → paused");
});

test("buildLiveSpendPush: THROTTLED (inside the ~45s interval) → null even with new tokens", () => {
  const grown = runningSession({
    models: [{ id: "claude-opus-4-8", input: 999, output: 20, cacheRead: 30, cacheCreation: 40 }],
  });
  const push = buildLiveSpendPush({
    sessions: [grown],
    enrolled: true,
    now: NOW + 1_000, // < LIVE_PUSH_INTERVAL_MS since last push
    last: { pushedAt: NOW, sessionId: "sess-1", signature: "stale-sig" },
  });
  assert.equal(push, null, "a push inside the min interval is throttled");
});

test("buildLiveSpendPush: past the interval WITH new tokens → a fresh payload", () => {
  assert.ok(LIVE_PUSH_INTERVAL_MS >= 30_000, "the live push interval must be a real throttle (>= 30s)");
  const grown = runningSession({
    models: [{ id: "claude-opus-4-8", input: 999, output: 20, cacheRead: 30, cacheCreation: 40 }],
  });
  const push = buildLiveSpendPush({
    sessions: [grown],
    enrolled: true,
    now: NOW + LIVE_PUSH_INTERVAL_MS,
    last: { pushedAt: NOW, sessionId: "sess-1", signature: "stale-sig" },
  });
  assert.ok(push, "new tokens after the interval must re-push");
  assert.equal(push!.tokensByModel["claude-opus-4-8"].input, 999);
});

// ---- buildLiveSpendPush: picks the currently-running session (max endedAt) -----------

test("buildLiveSpendPush: the RUNNING session is the most-recently-active one (max endedAt)", () => {
  const older = runningSession({ toolSessionId: "old", endedAt: NOW - 3_600_000 });
  const active = runningSession({
    toolSessionId: "current",
    endedAt: NOW,
    models: [{ id: "m", input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }],
  });
  const push = buildLiveSpendPush({ sessions: [older, active], enrolled: true, now: NOW, last: null });
  assert.ok(push);
  assert.equal(push!.sessionId, "current", "the live push follows the currently-running session");
});

// ---- liveSpendSignatureOf: stable "have the tokens moved" digest ---------------------

test("liveSpendSignatureOf: equal maps → equal signature; a changed count → a different one", () => {
  const a = { m: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } };
  const b = { m: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } };
  const c = { m: { input: 2, output: 2, cacheRead: 3, cacheCreation: 4 } };
  assert.equal(liveSpendSignatureOf(a), liveSpendSignatureOf(b));
  assert.notEqual(liveSpendSignatureOf(a), liveSpendSignatureOf(c));
});
