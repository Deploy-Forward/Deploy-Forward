/**
 * "Onboarding freshness" fix lane — three real bugs found by a scripted human-use
 * simulation of the published deploy-forward@0.22.1 tarball (device-flow driven,
 * frame-reconstructed, hermetic: DF_* homes pinned, DF_API_BASE closed). Full report:
 * the simulation report (Findings 1-3, internal). TEST
 * AUTHOR pass only — no production code in this file; a code author follows.
 *
 * THE SEAMS THIS SUITE PINS (verified against src/superStart.ts and bin/df.ts as of
 * this branch's base — see the inline code citations under each finding):
 *
 * ---------------------------------------------------------------------------------
 * FINDING 1 (sim-report.md "Same-run billing-mode staleness"): the billing mode /
 * budget answered DURING onboarding never reaches the limits page for the REST of
 * that same watch session — only the NEXT run sees it.
 *
 *   src/superStart.ts ~2195-2196:
 *     const billingMode = loadState().billingMode;          // read BEFORE onboarding
 *     const monthlyBudgetUsd = loadState().monthlyBudgetUsd; // read BEFORE onboarding
 *   ~2206-2211:
 *     if (!pushing && opts.askOnboarding) {
 *       const wantsBoard = await opts.askOnboarding();   // <- billingMode/budget are
 *       ...                                                //    WRITTEN here (bin/df.ts's
 *     }                                                    //    askSuperStartBillingMode)
 *   ~2423, ~2466, ~2506, ~2515, ~2522: every `live = {...}` object built for the rest
 *   of the watch threads the STALE closured `billingMode`/`budgetFor(...)` — never a
 *   fresh `loadState()` read — so limitsPanelLines' budget gate
 *   `(billingMode==="api"||billingMode==="mix") && budget` never fires this run.
 *
 *   THE SEAM: whatever mechanism the fix uses (a re-read after onboarding, or
 *   threading onboarding's own result forward instead of a pre-onboarding const
 *   snapshot), the pinned OBSERVABLE contract is: onboarding persists mode=mix +
 *   budget=$150 -> the SAME run's limits page (reachable by the user, same process)
 *   renders the BUDGET gauge. No new SuperStartOptions field is required to test
 *   this — it drives the real runSuperStart()/withFullScreen() pipeline end to end.
 *
 * ---------------------------------------------------------------------------------
 * FINDING 2 (sim-report.md "keys dropped before the watch's key handler is wired"):
 * keys pressed during the entrance animation are silently discarded, never buffered.
 *
 *   src/superStart.ts ~1923-1933 (withFullScreen): `io.input.on("data", onData)` is
 *   wired IMMEDIATELY on entering the alt-screen; `onData` dispatches into
 *   `keyHandlers` (`for (const f of keyHandlers) f(k)`), an array that starts EMPTY.
 *   ~2371: `ctx.onKey((k) => {...})` — the watch's own subscriber — is registered
 *   only after Act I's entrance animation (ANIMATE_MS = 5000ms, ~2274-2280) and part
 *   of Act II's setup finish. Any non-quit key byte that arrives before that
 *   subscription exists matches against an empty `keyHandlers` and is discarded —
 *   never queued, never replayed once a real handler subscribes.
 *
 *   THE SEAM: an early-wire contract at the withFullScreen boundary — keys pressed
 *   before any onKey() subscriber exists are buffered and replayed, IN ORDER, the
 *   moment the first subscriber calls onKey(). ("quit" keys are unaffected — they
 *   are handled inline in onData today and already work.)
 *
 * ---------------------------------------------------------------------------------
 * FINDING 3 (sim-report.md "'returning run' has two different meanings"): a device
 * that DECLINED the board on a prior run is re-asked the full onboarding sequence
 * EVERY subsequent run, forever — because the only gate is pairing, not "was this
 * device ever asked."
 *
 *   src/superStart.ts ~2185: `let pushing = loadState().deviceToken !== null;`
 *   ~2206: `if (!pushing && opts.askOnboarding) { ... }` — the ENTIRE gate. A decline
 *   never mints a deviceToken, so `pushing` stays false forever and this branch fires
 *   on every run for that device, unconditionally.
 *   bin/df.ts ~120-127 (askSuperStartOnboarding): asks the board question AND the
 *   billing-mode question unconditionally, every time it is called — it has no
 *   memory of a prior decline either.
 *
 *   THE SEAM: a new persisted enrollment-truth field — pinned here as
 *   `TrackerState.onboardedAt?: number` (src/config.ts, alongside billingMode/
 *   redact/limitsProviders: enrollment truth, sanitized on load, epoch-proof) — set
 *   ONCE runSuperStart calls opts.askOnboarding, regardless of the answer (asked !=
 *   accepted, but both must be recorded so the question is never repeated). The gate
 *   becomes `if (!pushing && !loadState().onboardedAt && opts.askOnboarding)`. NOT
 *   epoch-gated (no re-ask-after-N-days logic) — presence alone means "already
 *   asked"; per Marco's ruling, returning users change their answer via Settings,
 *   never by being re-asked. Placement (superStart.ts vs config.ts) is this suite's
 *   choice, flagged to the impl agent same as onboardingV2.test.ts's precedent.
 *
 * Run: npx tsx --test test/onboardingFreshness.test.ts
 *
 * NOTE on timing: Findings 1 and 2's integration-level tests drive the REAL
 * runSuperStart()/withFullScreen() pipeline through its entrance animation, whose
 * ANIMATE_MS (5000ms, src/superStart.ts) is real wall-clock and not fixture-clock-
 * controlled — there is no injectable seam for it today, and adding one is out of
 * scope for a bug that has nothing to do with animation timing. Those two tests each
 * cost ~6s of real time; this is accepted as the honest cost of pinning the real
 * end-to-end regression rather than a unit stand-in that could pass for the wrong
 * reason. Finding 2 also gets a fast, precise unit-level pin at the exact
 * withFullScreen boundary (no wait) as the primary, fast-feedback test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLine } from "./fixtures.ts";
import { PARSER_EPOCH, loadState, saveState } from "../src/config.ts";
import { runSuperStart, withFullScreen, type ShowcaseIO } from "../src/superStart.ts";

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const OSC = /\x1b\]8;;[^]*?\x1b\]8;;\x07/g;
const strip = (s: string): string => s.replace(OSC, "").replace(ANSI, "");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The real, hardcoded entrance animation (ANIMATE_MS = 5000ms in src/superStart.ts)
// plus a margin for preload + Act II setup, before the watch's onKey handler is
// wired and safe to drive.
const PAST_ENTRANCE_MS = 5600;

// ---- env + corpus plumbing (mirrors test/superStart.test.ts's / test/superStartOnboarding.test.ts's) --

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
    // installHooks()/healHooks() run on several runSuperStart paths (a paired
    // interactive run self-heals lost hooks) -- an unpinned DF_CLAUDE_SETTINGS would
    // write into the REAL ~/.claude/settings.json, exactly the regression the sim's
    // own hermeticity rule (sim-report.md) exists to prevent.
    DF_CLAUDE_SETTINGS: join(home, "claude-settings.json"),
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

/** A minimal non-empty corpus (skips the honest-empty-state early return) plus a
 * state.json under test control. apiBase points at a LOCAL CLOSED port so a
 * would-be sync push fails fast (ECONNREFUSED) instead of riding out a DNS timeout —
 * same discipline as the sim's own hermeticity rule and the sibling onboarding
 * suites. The fixture's session timestamp is real-clock-old (2026-06-01), so no
 * session reads as "live" against the real Date.now() the watch's activity probe
 * actually uses -- chart auto-view starts on "spend", not "live" (see the two
 * RIGHT-arrow comment in Finding 1's test below). */
function seedCorpus(opts: { deviceToken?: string | null } = {}): { home: string; projects: string } {
  const home = mkdtempSync(join(tmpdir(), "df-onboardfresh-home-"));
  const projects = mkdtempSync(join(tmpdir(), "df-onboardfresh-projects-"));
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

// ---- fake interactive IO ------------------------------------------------------------------------

/** A real full-screen takeover with a manually-driven `press()` (synchronous, not
 * scheduled) — the test controls exactly when keys arrive relative to the real
 * entrance animation, which fakeInteractiveIO's fixed setTimeout cannot do. Mirrors
 * test/superStart.test.ts's own fakeIO (same shape, plus `writes` returned inline). */
function fakeIO(): { io: ShowcaseIO; writes: string[]; press: (b: string) => void } {
  const writes: string[] = [];
  const listeners = new Map<string, ((d: Buffer) => void)[]>();
  const io: ShowcaseIO = {
    write: (s) => writes.push(s),
    isTTY: true,
    rows: () => 40,
    cols: () => 120,
    input: {
      isTTY: true,
      setRawMode: () => {},
      on: (e: string, f: (d: Buffer) => void) => listeners.set(e, [...(listeners.get(e) ?? []), f]),
      off: (e: string, f: (d: Buffer) => void) => listeners.set(e, (listeners.get(e) ?? []).filter((g) => g !== f)),
      resume: () => {},
      pause: () => {},
    },
    onResize: () => () => {},
  };
  return { io, writes, press: (b) => (listeners.get("data") ?? []).forEach((f) => f(Buffer.from(b))) };
}

/** A real full-screen takeover that quits itself shortly after its own key handler
 * registers — for tests that only care about WHETHER onboarding fires, never about
 * navigating the watch (mirrors test/superStartOnboarding.test.ts's helper of the
 * same name). */
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

// ===================================================================================================
// FINDING 1 — same-run billing-mode/budget staleness
// ===================================================================================================

test("FINDING 1 (real bug): billing mode + budget answered during onboarding must reach the SAME watch session's limits page, not wait for the next run", async () => {
  const { home, projects } = seedCorpus({ deviceToken: null });
  const prev = pinnedEnv(home, projects);
  try {
    const { io, writes, press } = fakeIO();
    const ask = async (): Promise<boolean> => {
      // Mirrors production's askSuperStartOnboarding -> askSuperStartBillingMode
      // (bin/df.ts ~120-183): the fresh billing answer is persisted to state.json
      // from INSIDE the onboarding callback -- exactly where the real CLI prompt
      // sequence writes it, and exactly the write runSuperStart's pre-onboarding
      // const snapshot (src/superStart.ts ~2195-2196) misses.
      saveState({ ...loadState(), billingMode: "mix", monthlyBudgetUsd: 150 });
      return false; // declines the board -- pairing is irrelevant to this bug
    };
    const runP = runSuperStart(
      {
        now: Date.parse("2026-06-05T00:00:00.000Z"),
        askOnboarding: ask,
        pairOnboarding: neverCalled("pairOnboarding"),
      } as any,
      io,
    );
    // Real wall-clock wait past the entrance animation -- see PAST_ENTRANCE_MS's doc.
    await sleep(PAST_ENTRANCE_MS);
    // The fixture's session is real-clock-old, so liveSessions is empty at Act II
    // start and chart auto-view resolves to "spend" first (CHART_PAGES = [spend,
    // live, limits] in src/superStart.ts). Two RIGHT presses: spend -> live -> limits.
    press("\x1b[C");
    await sleep(200);
    press("\x1b[C");
    await sleep(200);
    press("q");
    await runP;
    const out = strip(writes.join(""));
    assert.ok(out.includes("LIMITS · WHAT'S LEFT"), `sanity: navigation must actually reach the limits page -- got:\n${out}`);
    assert.ok(
      out.includes("BUDGET"),
      "the SAME run must render the fresh $150 budget gauge on its limits page -- billingMode/monthlyBudgetUsd must be re-read (or threaded) AFTER onboarding writes them, never captured as a pre-onboarding const snapshot",
    );
  } finally {
    restoreEnv(prev);
  }
});

// ===================================================================================================
// FINDING 2 — keys dropped before the watch's onKey handler is wired
// ===================================================================================================

test("FINDING 2 (real bug, fast unit pin): keys pressed BEFORE any onKey() subscriber exists must be buffered and replayed, in order, once the first subscriber wires up", async () => {
  const { io, press } = fakeIO();
  const keys: string[] = [];
  await withFullScreen(io, async (ctx) => {
    // The eager-human scenario, sim-report.md Finding 2: 5 early down-arrows, sent
    // the instant the full-screen takeover appears -- BEFORE ctx.onKey has been
    // called even once (production doesn't call it until well after Act I's
    // entrance animation, src/superStart.ts ~2371).
    for (let i = 0; i < 5; i++) press("\x1b[B");
    ctx.onKey((k) => keys.push(k));
    setTimeout(() => press("q"), 5);
    await ctx.waitForQuit();
  });
  assert.deepEqual(
    keys,
    ["down", "down", "down", "down", "down"],
    "all 5 early presses must be buffered and replayed, IN ORDER, once onKey subscribes -- not silently discarded against an empty handler list",
  );
});

test("FINDING 2 (real bug, integration pin): 5 early down-arrows sent before the watch settles still land as 5 real menu moves once it does", async () => {
  // Paired device (deviceToken set): no onboarding noise, isolates this test to the
  // key-buffering bug alone.
  const { home, projects } = seedCorpus({ deviceToken: "test-token" });
  const prev = pinnedEnv(home, projects);
  try {
    const { io, writes, press } = fakeIO();
    const runP = runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z") } as any, io);
    // Fired IMMEDIATELY -- before withFullScreen's own onData listener has even had
    // a chance to see a real subscriber registered (Act I hasn't started painting
    // yet). menuIndex starts at 0; SUPER_START_ACTIONS[5] is "settings" (6th of 7).
    for (let i = 0; i < 5; i++) press("\x1b[B");
    await sleep(PAST_ENTRANCE_MS);
    press("q");
    await runP;
    const out = strip(writes.join(""));
    assert.ok(
      out.includes("6/7") && out.includes("deploy-forward settings"),
      `the 5 early presses must still land as 5 real menu moves once the watch settles (menuIndex 0 -> 5, "6/7", "settings") -- got:\n${out}`,
    );
  } finally {
    restoreEnv(prev);
  }
});

// ===================================================================================================
// FINDING 3 — "returning run" re-asks onboarding forever for a device that declined
// ===================================================================================================

test("FINDING 3a (real bug): a first run that DECLINES the board must persist that onboarding was ASKED (not just what was answered)", async () => {
  const { home, projects } = seedCorpus({ deviceToken: null });
  const prev = pinnedEnv(home, projects);
  try {
    const { io } = fakeInteractiveIO();
    const ask = counter(false);
    await runSuperStart(
      {
        now: Date.parse("2026-06-05T00:00:00.000Z"),
        askOnboarding: ask.fn,
        pairOnboarding: neverCalled("pairOnboarding"),
      } as any,
      io,
    );
    assert.equal(ask.calls, 1, "the board question is asked exactly once, same as today");
    // THE SEAM (see header): a new enrollment-truth field, pinned here as
    // `onboardedAt`, must survive this run regardless of the (declined) answer --
    // "asked" and "accepted" are different facts, and only "asked" gates re-asking.
    const after = loadState() as unknown as { onboardedAt?: number };
    assert.ok(
      after.onboardedAt,
      "declining the board must still record that this device was asked -- today nothing persists this at all, so a later run re-asks forever (sim-report.md Finding 3)",
    );
  } finally {
    restoreEnv(prev);
  }
});

test("FINDING 3b (real bug): a returning UNPAIRED device that was already asked must NOT be re-asked -- straight to the watch", async () => {
  const { home, projects } = seedCorpus({ deviceToken: null });
  // Seed the marker directly, as if FINDING 3a's run already happened and recorded
  // it -- this device is still unpaired (declining never mints a deviceToken), so
  // `pushing` alone can never distinguish "never asked" from "asked and declined."
  const seeded = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  writeFileSync(join(home, "state.json"), JSON.stringify({ ...seeded, onboardedAt: Date.parse("2026-06-01T00:00:00.000Z") }));
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
    const raw = writes.join("");
    assert.ok(raw.includes("\x1b[?1049h") && raw.includes("\x1b[?1049l"), "the watch actually ran, straight through, no ceremony");
  } finally {
    restoreEnv(prev);
  }
});
