/**
 * `deploy-forward super-start` — onboarding for UNPAIRED interactive devices (lane T7,
 * docs/super-start-showcase-spec.md). Today (see src/superStart.ts ~line 1341):
 *
 *   const pushing = loadState().deviceToken !== null;
 *
 * A paired device pushes; an UNPAIRED device silently stays read-only forever — it is
 * never offered onboarding. Marco's ruling (verbatim intent, relayed by the orchestrator):
 *
 *   - Device registration is DEVICE->USER: pairing links this device to the user's
 *     existing profile (multiple devices per user). "Do you want to be on the board?"
 *     IS the pairing question.
 *   - An UNPAIRED + INTERACTIVE super-start offers onboarding BEFORE entering the
 *     full-screen watch. It must REUSE start's existing pairing flow (bin/df.ts
 *     firstRun()'s ceremony, which calls src/auth.ts's githubOnboard()/pair()) —
 *     never a reimplementation.
 *   - DECLINE -> the watch still runs with every local feature, read-only: pushing
 *     stays false, the footer never renders "synced", no state write happens, and the
 *     question is NOT re-asked within the same run.
 *   - ACCEPT -> the pairing flow runs; if it succeeds, the watch runs with pushing true.
 *   - PAIRED device -> NO question, straight to the watch pushing (today's behavior,
 *     unchanged).
 *   - NON-INTERACTIVE (no TTY) -> NO question ever, read-only fallback exactly as today.
 *
 * THE SEAM (does not exist yet — this is the intentional red): runSuperStart's current
 * signature (SuperStartOptions = { static?, now? }) gives no way to fake the onboarding
 * question or the pairing ceremony from a test, and superStart.ts has no business calling
 * bin/df.ts's private firstRun() directly (wrong dependency direction) or reimplementing
 * auth.ts's ceremony inline. So this suite pins two new SuperStartOptions fields the impl
 * must add — tests only; production wires the real prompt + the real pairing flow:
 *
 *   askOnboarding?: () => Promise<boolean>;
 *     Called at most once, only when the loaded device is unpaired AND the run is
 *     interactive (never on --static, non-TTY, or an already-paired device). This IS the
 *     "do you want to be on the board?" question. true = accept, false = decline.
 *
 *   pairOnboarding?: () => Promise<boolean>;
 *     Called ONLY after askOnboarding resolves true. Production wires this to the SAME
 *     pairing flow `start` uses (bin/df.ts firstRun() -> src/auth.ts githubOnboard()/
 *     pair()) — not a reimplementation. Resolving true means pairing succeeded and the
 *     watch should run pushing; false means it failed and the watch stays read-only.
 *
 * Both are optional so every existing call site (and every already-paired / non-
 * interactive run) is unaffected — the omitted-in-production default is the real prompt.
 *
 * Run: npx tsx --test test/superStartOnboarding.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLine } from "./fixtures.ts";
import { PARSER_EPOCH } from "../src/config.ts";
import { runSuperStart, type ShowcaseIO } from "../src/superStart.ts";

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const OSC = /\x1b\]8;;[^]*?\x1b\]8;;\x07/g;
const strip = (s: string): string => s.replace(OSC, "").replace(ANSI, "");

// ---- env + corpus plumbing (mirrors test/superStart.test.ts's pinnedEnv/seedCorpus) -----------

function pinnedEnv(home: string, projects: string): Record<string, string | undefined> {
  const prev: Record<string, string | undefined> = {};
  const pins: Record<string, string> = {
    DF_HOME: home,
    DF_CLAUDE_PROJECTS: projects,
    DF_CODEX_SESSIONS: join(projects, "no-codex-here"),
    DF_GROK_HOME: join(projects, "no-grok-here"),
    DF_PI_HOME: join(projects, "no-pi-here"),
    DF_OPENCLAW_HOME: join(projects, "no-openclaw-here"),
    DF_OPENCODE_HOME: join(projects, "no-opencode-here"),
    DF_HERMES_HOME: join(projects, "no-hermes-here"),
    DF_COPILOT_HOME: join(projects, "no-copilot-here"),
  };
  for (const [k, v] of Object.entries(pins)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  return prev;
}

function restoreEnv(prev: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/**
 * A minimal non-empty corpus (skips the honest-empty-state early return) plus a
 * state.json under test control. apiBase deliberately points at a LOCAL closed port
 * (not a DNS name) so that if the watch ever does flip to pushing and a real corpus
 * scan fires in its worker thread, the resulting fetch fails fast (ECONNREFUSED)
 * instead of riding out a DNS timeout.
 */
function seedCorpus(opts: { deviceToken?: string | null } = {}): { home: string; projects: string } {
  const home = mkdtempSync(join(tmpdir(), "df-onboard-home-"));
  const projects = mkdtempSync(join(tmpdir(), "df-onboard-projects-"));
  const proj = join(projects, "proj1");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "s-aaa.jsonl"),
    claudeLine({ sessionId: "s-aaa", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
  );
  const deviceToken = opts.deviceToken ?? null;
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://127.0.0.1:1/api",
      deviceToken,
      uid: deviceToken ? "u1" : null,
      handle: deviceToken ? "tester" : null,
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
    }),
  );
  return { home, projects };
}

// ---- fake interactive IO: a real full-screen takeover, auto-quit shortly after the ------------
// ---- takeover actually registers its key handler (deterministic — no race with setup) ---------

function fakeInteractiveIO(quitAfterMs = 300): { io: ShowcaseIO; writes: string[] } {
  const writes: string[] = [];
  let dataListener: ((d: Buffer) => void) | null = null;
  const io: ShowcaseIO = {
    write: (s) => writes.push(s),
    isTTY: true,
    rows: () => 40,
    cols: () => 120,
    input: {
      isTTY: true,
      setRawMode: () => {},
      on: (e, f) => {
        if (e === "data") {
          dataListener = f;
          // The quit key is scheduled ONLY once the takeover's own listener exists, so
          // this never races test setup — and it fires late enough (a few
          // TICKER_STEP_MS beats) to catch a re-ask bug, not just the first frame.
          setTimeout(() => dataListener?.(Buffer.from("q")), quitAfterMs);
        }
      },
      off: () => {
        dataListener = null;
      },
      resume: () => {},
      pause: () => {},
    },
    onResize: () => () => {},
  };
  return { io, writes };
}

function counter(result: boolean | (() => boolean)): { fn: () => Promise<boolean>; calls: number } {
  const state = { fn: async () => false, calls: 0 };
  state.fn = async () => {
    state.calls++;
    return typeof result === "function" ? result() : result;
  };
  return state;
}

function neverCalled(label: string): () => Promise<boolean> {
  return async () => {
    throw new Error(`${label} must never be called on this path`);
  };
}

// ---- the tests ----------------------------------------------------------------------------------

test("unpaired + interactive: DECLINE stays read-only, writes exactly onboardedAt, and is not re-asked", async () => {
  const { home, projects } = seedCorpus({ deviceToken: null });
  const prev = pinnedEnv(home, projects);
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("declining the board question must never touch the network");
  }) as unknown as typeof fetch;
  try {
    const before = readFileSync(join(home, "state.json"), "utf8");
    const { io, writes } = fakeInteractiveIO();
    const ask = counter(false);
    const pair = counter(true);
    await runSuperStart(
      {
        now: Date.parse("2026-06-05T00:00:00.000Z"),
        askOnboarding: ask.fn,
        pairOnboarding: pair.fn,
      } as any,
      io,
    );
    const raw = writes.join("");
    const out = strip(raw);
    assert.equal(ask.calls, 1, "the board question is asked exactly once");
    assert.equal(pair.calls, 0, "declining must never run the pairing flow");
    // Enter/leave are ANSI sequences, so they must be checked on the RAW writes —
    // strip() removes them by construction (the stripped variable serves the text
    // assertions below).
    assert.ok(raw.includes("\x1b[?1049h") && raw.includes("\x1b[?1049l"), "the full-screen watch actually ran");
    assert.ok(!out.includes("synced"), "the footer never claims a push it never made");
    assert.equal(fetchCalls, 0, "a declined device must never reach the network");
    // Ask-once ruling 2026-07-19 (docs/context-capacity-plan.md) supersedes the 2026-07-17 no-write pin: decline writes exactly onboardedAt, nothing else.
    const beforeState = JSON.parse(before) as Record<string, unknown>;
    const afterState = JSON.parse(readFileSync(join(home, "state.json"), "utf8")) as Record<string, unknown>;
    assert.ok(
      typeof afterState.onboardedAt === "number" && Number.isFinite(afterState.onboardedAt),
      "decline must persist onboardedAt (a finite epoch-ms number) so the question is never re-asked",
    );
    delete afterState.onboardedAt;
    assert.deepEqual(afterState, beforeState, "every field OTHER than onboardedAt is untouched by a decline");
  } finally {
    globalThis.fetch = origFetch;
    restoreEnv(prev);
  }
});

test("unpaired + interactive: ACCEPT reuses the pairing flow and pushes once it succeeds", async () => {
  const { home, projects } = seedCorpus({ deviceToken: null });
  const prev = pinnedEnv(home, projects);
  try {
    const { io, writes } = fakeInteractiveIO();
    const ask = counter(true);
    const pair = counter(true);
    await runSuperStart(
      {
        now: Date.parse("2026-06-05T00:00:00.000Z"),
        askOnboarding: ask.fn,
        pairOnboarding: pair.fn,
      } as any,
      io,
    );
    const out = strip(writes.join(""));
    assert.equal(ask.calls, 1, "the board question is asked exactly once");
    assert.equal(pair.calls, 1, "accepting runs the (reused) pairing flow exactly once");
    assert.ok(out.includes("synced"), "a successful pair flips the watch to pushing");
  } finally {
    restoreEnv(prev);
  }
});

test("unpaired + interactive: ACCEPT but a FAILED pairing leaves the watch read-only", async () => {
  const { home, projects } = seedCorpus({ deviceToken: null });
  const prev = pinnedEnv(home, projects);
  try {
    const { io, writes } = fakeInteractiveIO();
    const ask = counter(true);
    const pair = counter(false);
    await runSuperStart(
      {
        now: Date.parse("2026-06-05T00:00:00.000Z"),
        askOnboarding: ask.fn,
        pairOnboarding: pair.fn,
      } as any,
      io,
    );
    const out = strip(writes.join(""));
    assert.equal(pair.calls, 1, "the pairing flow still runs on accept");
    assert.ok(!out.includes("synced"), "a failed pair must never claim a push");
  } finally {
    restoreEnv(prev);
  }
});

test("PAIRED device: no question is asked, watch pushes exactly like today", async () => {
  const { home, projects } = seedCorpus({ deviceToken: "test-token" });
  const prev = pinnedEnv(home, projects);
  try {
    const { io, writes } = fakeInteractiveIO();
    await runSuperStart(
      {
        now: Date.parse("2026-06-05T00:00:00.000Z"),
        askOnboarding: neverCalled("askOnboarding"),
        pairOnboarding: neverCalled("pairOnboarding"),
      } as any,
      io,
    );
    const out = strip(writes.join(""));
    assert.ok(out.includes("synced"), "an already-paired device pushes exactly like today");
  } finally {
    restoreEnv(prev);
  }
});

test("NON-INTERACTIVE (no TTY): no question ever, read-only fallback exactly as today", async () => {
  const { home, projects } = seedCorpus({ deviceToken: null });
  const prev = pinnedEnv(home, projects);
  try {
    const before = readFileSync(join(home, "state.json"), "utf8");
    const writes: string[] = [];
    const io: ShowcaseIO = { write: (s) => writes.push(s), isTTY: false, rows: () => 24, cols: () => 80 };
    await runSuperStart(
      {
        now: Date.parse("2026-06-05T00:00:00.000Z"),
        askOnboarding: neverCalled("askOnboarding"),
        pairOnboarding: neverCalled("pairOnboarding"),
      } as any,
      io,
    );
    const out = writes.join("");
    assert.equal(strip(out), out, "a scripted run must never emit escape sequences, question or not");
    assert.ok(out.includes("sessions scanned"), "the honest settled read-only view still renders");
    assert.equal(readFileSync(join(home, "state.json"), "utf8"), before, "a scripted run must never write state");
  } finally {
    restoreEnv(prev);
  }
});

test("--static (interactive terminal, but --static): no question ever, plain settled frames", async () => {
  const { home, projects } = seedCorpus({ deviceToken: null });
  const prev = pinnedEnv(home, projects);
  try {
    const before = readFileSync(join(home, "state.json"), "utf8");
    const writes: string[] = [];
    const io: ShowcaseIO = { write: (s) => writes.push(s), isTTY: true, rows: () => 40, cols: () => 120 };
    await runSuperStart(
      {
        static: true,
        now: Date.parse("2026-06-05T00:00:00.000Z"),
        askOnboarding: neverCalled("askOnboarding"),
        pairOnboarding: neverCalled("pairOnboarding"),
      } as any,
      io,
    );
    const out = writes.join("");
    assert.equal(strip(out), out, "--static must never emit escape sequences, question or not");
    assert.equal(readFileSync(join(home, "state.json"), "utf8"), before, "--static must never write state");
  } finally {
    restoreEnv(prev);
  }
});
