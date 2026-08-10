/**
 * D25a — live limits consent (docs/context-capacity-plan.md "D25 — Live consent +
 * multi-account limits", RULED 2026-07-20). TEST AUTHOR pass only — no production
 * code in this file; a code author follows.
 *
 * Field bug (Marco, 0.22.2): flipping the settings Limits toggle mid-run changes
 * nothing on screen. Root cause, as of this branch's base:
 *
 *   src/superStart.ts:2373
 *     const limitsOptIn = resolveLimitsConsent(opts.limits, loadState().limitsProviders?.claude);
 *   src/superStart.ts:2516-2519 (maybeFetchLanes, closed over by the beat loop)
 *     const maybeFetchLanes = (): void => {
 *       if (!limitsOptIn || Date.now() - lanesFetchedAt < LANES_REFRESH_MS) return;
 *       ...
 *     };
 *
 * `limitsOptIn` is a plain `const` snapshotted ONCE at watch start, before the
 * withFullScreen takeover even begins. `maybeFetchLanes` closes over that const and
 * is called every beat (TICKER_STEP_MS = 60ms) inside the live while-loop
 * (~line 2702) — but the const itself never changes for the life of the process, no
 * matter what the settings reducer (toggleSettingsRow ~1741, persisted via
 * settingsStep's `ctx.persist` callback ~1770-1771, i.e. saveState) writes to disk.
 * So: consent OFF at start -> toggling ON in-app never starts a fetch (the gate
 * stays permanently closed). Consent ON at start -> toggling OFF in-app never stops
 * anything, because `claudeLanes`/`claudeNote` (superStart.ts:2512-2513, both plain
 * `let`s assigned only inside `maybeFetchLanes`'s `.then()`) are never cleared by a
 * consent flip either — nothing in today's code path even looks at consent again
 * once the closure captures its initial value.
 *
 * THE SEAM this suite pins: whatever the fix's shape (dropping the const in favor of
 * a fresh `loadState().limitsProviders?.claude` read inside `maybeFetchLanes` itself,
 * a small consent-tracking variable updated at the top of each beat, or something
 * else), the pinned OBSERVABLE contract is D25a's own three sentences:
 *   1. the lane-fetch gate re-reads persisted consent every refresh cycle;
 *   2. a settings toggle triggers an immediate refetch (not the 5-min timer);
 *   3. flipping OFF clears the lanes and note on the next frame.
 * All five tests below drive the REAL runSuperStart()/withFullScreen() pipeline
 * end to end (SuperStartOptions.limitsFetchImpl as the only test seam — the same
 * seam test/onboardingV2.test.ts already pins for D18) — never a unit stand-in that
 * could pass for the wrong reason. The integration-driving style (pinnedEnv/
 * seedCorpus/fakeIO/PAST_ENTRANCE_MS) mirrors test/onboardingFreshness.test.ts and
 * test/onboardingV2.test.ts verbatim; see their headers for the real-wall-clock-cost
 * rationale (ANIMATE_MS = 5000ms has no injectable seam today, and adding one is out
 * of scope for a bug that has nothing to do with the entrance animation).
 *
 * Run: npx tsx --test test/liveConsent.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLine } from "./fixtures.ts";
import { PARSER_EPOCH, loadState, saveState } from "../src/config.ts";
import { runSuperStart, type ShowcaseIO } from "../src/superStart.ts";

// ---- env + corpus plumbing (mirrors test/onboardingFreshness.test.ts / test/onboardingV2.test.ts) --

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
    // A paired + interactive run can self-heal hooks — an unpinned DF_CLAUDE_SETTINGS
    // would write into the REAL ~/.claude/settings.json (onboardingFreshness.test.ts's
    // hermeticity rule, carried forward here since every test below pairs the device).
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

/** A minimal non-empty, real-clock-OLD corpus (2026-06-01) plus a state.json under
 * test control — old enough that no session reads as "live" against the real
 * Date.now() the watch's activity probe actually uses, so chart auto-view starts on
 * "spend" (CHART_PAGES = [spend, live, limits] in src/superStart.ts) and the same
 * two-RIGHT-presses navigation test/onboardingFreshness.test.ts's Finding 1 test
 * relies on lands on the limits page here too. deviceToken is always set (paired):
 * every test below cares about the consent gate, not onboarding, and a paired device
 * skips the onboarding branch entirely (superStart.ts's `if (!pushing && ...)` gate).
 * apiBase is a closed local port so a would-be sync push fails fast. */
function seedCorpus(opts: { limitsProviders?: { claude?: boolean } } = {}): { home: string; projects: string } {
  const home = mkdtempSync(join(tmpdir(), "df-liveconsent-home-"));
  const projects = mkdtempSync(join(tmpdir(), "df-liveconsent-projects-"));
  const proj = join(projects, "proj1");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "s-aaa.jsonl"),
    claudeLine({ sessionId: "s-aaa", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
  );
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://127.0.0.1:1/api",
      deviceToken: "test-token",
      uid: "u1",
      handle: "tester",
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
      ...(opts.limitsProviders !== undefined ? { limitsProviders: opts.limitsProviders } : {}),
    }),
  );
  return { home, projects };
}

/** A well-formed, NOT-expired Claude Code credentials file (mirrors
 * test/onboardingV2.test.ts's writeValidCreds — real wall-clock expiry, a year out,
 * since fetchClaudeLimits is called with nowMs: Date.now() inside superStart.ts). */
function writeValidCreds(dir: string): string {
  const p = join(dir, "credentials.json");
  writeFileSync(
    p,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-liveconsent-fixture-token",
        expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 365,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    }),
  );
  return p;
}

/** Injectable SuperStartOptions.limitsFetchImpl — records every call's wall-clock
 * timestamp (to pin "promptly", never the 5-min timer) alongside a plain count.
 * "ok" resolves the same vendor-shaped body test/limitsFetch.test.ts's own fixture
 * uses (one "session" lane, 12%) so limitsPanelLines' laneName() renders "CLAUDE
 * SESSION". "fail" resolves a non-2xx, producing fetchClaudeLimits's http-error note
 * ("claude: unavailable (http-error)") instead of any lanes.
 * `calls`/`callTimes` are live getters: NEVER destructure them — see
 * test/onboardingV2.test.ts's fakeFetchImpl comment for the exact defect that guards
 * against (destructuring reads a plain number once and freezes it at 0 forever). */
function fakeFetchImpl(mode: "ok" | "fail" = "ok"): { impl: typeof fetch; readonly calls: number; readonly callTimes: number[] } {
  const state = { calls: 0, callTimes: [] as number[] };
  const okBody = {
    limits: [{ kind: "session", group: "session", percent: 12, severity: "normal", resets_at: "2026-07-18T08:30:00.504493+00:00", scope: null, is_active: false }],
    spend: {},
    member_dashboard_available: false,
  };
  const impl = (async () => {
    state.calls++;
    state.callTimes.push(Date.now());
    if (mode === "fail") return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    return { ok: true, status: 200, json: async () => okBody } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    impl,
    get calls() {
      return state.calls;
    },
    get callTimes() {
      return state.callTimes;
    },
  };
}

/** A real full-screen takeover with a manually-driven `press()` (synchronous, not
 * scheduled) — mirrors test/onboardingFreshness.test.ts's fakeIO verbatim: the test
 * controls exactly when keys arrive relative to the real entrance animation. */
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

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const OSC = /\x1b\]8;;[^]*?\x1b\]8;;\x07/g;
const strip = (s: string): string => s.replace(OSC, "").replace(ANSI, "");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Guaranteed-quit teardown: presses q and drains the run promise even when the test
 * body threw (this suite is an INTENTIONAL red -- a failed assertion mid-watch must
 * never leave the live loop's timers holding the whole `npm test` process open, which
 * is exactly what happened on the first run of this file). `.catch` so a rejected run
 * can never mask the test body's own assertion error. */
async function quitRun(press: (b: string) => void, runP: Promise<unknown>): Promise<void> {
  press("q");
  await runP.catch(() => {});
}

// The real, hardcoded entrance animation (ANIMATE_MS = 5000ms in src/superStart.ts)
// plus a margin for preload + Act II setup, before the watch's onKey handler is
// wired and safe to drive — verbatim PAST_ENTRANCE_MS from test/onboardingFreshness.test.ts.
const PAST_ENTRANCE_MS = 5600;

/** Navigation shorthand, all through the real key router (never a private API):
 * from the watch view, SUPER_START_ACTIONS[5] is "settings" (src/superStart.ts
 * ~1919-1929) — 5 downs move menuIndex 0 -> 5, then enter switches shell.view to
 * "settings" in-app (D17), never spawning the captured-output pane. From there,
 * Board(0)/Providers(1)/Billing(2) precede Limits(3) whenever billingMode is unset
 * (no Budget row inserted — settingsRows only adds one for "api"/"mix"), so 3 downs
 * + enter selects and toggles the Limits row. */
async function toggleLimitsInApp(press: (b: string) => void): Promise<void> {
  for (let i = 0; i < 5; i++) press("\x1b[B");
  await sleep(50);
  press("\r"); // enter -> shell.view = "settings"
  await sleep(50);
  for (let i = 0; i < 3; i++) press("\x1b[B"); // Board, Providers, Billing -> lands on Limits
  await sleep(50);
  press("\r"); // enter -> toggles + persists Limits, still inside settingsStep's branch
}

/** From the settings view, back to the watch — plain Escape ("\x1b") means QUIT when
 * shell.view === "watch" (routeKey's own rule), but means "back" from any other view;
 * this is only ever called right after toggleLimitsInApp, so shell.view is "settings". */
function backToWatch(press: (b: string) => void): void {
  press("\x1b");
}

// ===================================================================================================
// 1 — consent OFF at start, toggled ON mid-run: immediate refetch + same-run render
// ===================================================================================================

test("D25a #1: consent OFF at start, toggled ON via in-app settings -> the fetch impl is invoked promptly (not the 5-min timer) and CLAUDE lanes render on the limits page in the SAME run", async () => {
  const { home, projects } = seedCorpus({ limitsProviders: { claude: false } });
  const prevEnv = pinnedEnv(home, projects);
  const credHome = mkdtempSync(join(tmpdir(), "df-liveconsent-creds-"));
  const credPath = writeValidCreds(credHome);
  const prevCred = process.env.DF_CLAUDE_CREDENTIALS;
  process.env.DF_CLAUDE_CREDENTIALS = credPath;
  try {
    const { io, writes, press } = fakeIO();
    const fetchInfo = fakeFetchImpl("ok");
    const runP = runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z"), limitsFetchImpl: fetchInfo.impl } as any, io);
    try {
      await sleep(PAST_ENTRANCE_MS);
      assert.equal(fetchInfo.calls, 0, "sanity: consent starts OFF, so no fetch attempt has happened yet");

      const toggledAt = Date.now();
      await toggleLimitsInApp(press);

      // Real wall-clock margin for the 60ms-cadence beat loop to notice and refetch —
      // nowhere near LANES_REFRESH_MS (5 minutes), which this test physically cannot wait for.
      await sleep(700);
      assert.ok(fetchInfo.calls >= 1, "toggling consent ON mid-run must trigger a refetch without restarting the process");
      const elapsed = (fetchInfo.callTimes[0] ?? Infinity) - toggledAt;
      assert.ok(elapsed >= 0 && elapsed < 2000, `the refetch must land promptly after the toggle, never waiting on the 5-min timer -- took ${elapsed}ms`);

      // Back to the watch, onto the limits page (spend -> live -> limits, two rights),
      // SAME run, no restart.
      backToWatch(press);
      await sleep(80);
      press("\x1b[C");
      await sleep(80);
      press("\x1b[C");
      await sleep(300);
    } finally {
      await quitRun(press, runP);
    }
    const out = strip(writes.join(""));
    assert.ok(
      out.includes("CLAUDE SESSION") && out.includes("vendor-reported"),
      `the freshly-fetched lanes must render on the limits page in the SAME run -- got:\n${out}`,
    );
  } finally {
    if (prevCred === undefined) delete process.env.DF_CLAUDE_CREDENTIALS;
    else process.env.DF_CLAUDE_CREDENTIALS = prevCred;
    restoreEnv(prevEnv);
  }
});

// ===================================================================================================
// 2 — consent ON at start, toggled OFF mid-run: lanes AND note clear by the next frame
// ===================================================================================================

test("D25a #2a: consent ON at start (lanes rendering), toggled OFF via in-app settings -> the lanes disappear by the next frame and no further fetch calls happen after the flip", async () => {
  const { home, projects } = seedCorpus({ limitsProviders: { claude: true } });
  const prevEnv = pinnedEnv(home, projects);
  const credHome = mkdtempSync(join(tmpdir(), "df-liveconsent-creds-"));
  const credPath = writeValidCreds(credHome);
  const prevCred = process.env.DF_CLAUDE_CREDENTIALS;
  process.env.DF_CLAUDE_CREDENTIALS = credPath;
  try {
    const { io, writes, press } = fakeIO();
    const fetchInfo = fakeFetchImpl("ok");
    const runP = runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z"), limitsFetchImpl: fetchInfo.impl } as any, io);
    try {
      await sleep(PAST_ENTRANCE_MS);
      assert.ok(fetchInfo.calls >= 1, "sanity: consent starts ON, so the initial fetch already ran");

      // Confirm the lanes actually render before touching anything, then isolate what
      // happens strictly AFTER the toggle.
      press("\x1b[C");
      await sleep(80);
      press("\x1b[C");
      await sleep(300);
      assert.ok(strip(writes.join("")).includes("CLAUDE SESSION"), "sanity: lanes must be rendering before the toggle");
      const callsBeforeToggle = fetchInfo.calls;

      await toggleLimitsInApp(press);
      writes.length = 0; // capture starts AFTER the toggle -- the nav frames before the flip legitimately render lanes
      backToWatch(press); // still parked on the limits chart page -- chartView untouched by settings nav
      await sleep(500); // several 60ms beats -- "the next frame", not a restart

      const out = strip(writes.join(""));
      assert.ok(!out.includes("CLAUDE SESSION"), `the lanes must be gone by the next frame once consent is revoked -- got:\n${out}`);
      assert.equal(fetchInfo.calls, callsBeforeToggle, "no further fetch attempts once consent is off -- clearing the lanes is a pure render decision, never a new call");
    } finally {
      await quitRun(press, runP);
    }
  } finally {
    if (prevCred === undefined) delete process.env.DF_CLAUDE_CREDENTIALS;
    else process.env.DF_CLAUDE_CREDENTIALS = prevCred;
    restoreEnv(prevEnv);
  }
});

test("D25a #2b: consent ON at start with a FAILING fetch (claude note showing), toggled OFF -> the note disappears by the next frame too, with no further fetch calls", async () => {
  const { home, projects } = seedCorpus({ limitsProviders: { claude: true } });
  const prevEnv = pinnedEnv(home, projects);
  const credHome = mkdtempSync(join(tmpdir(), "df-liveconsent-creds-"));
  const credPath = writeValidCreds(credHome);
  const prevCred = process.env.DF_CLAUDE_CREDENTIALS;
  process.env.DF_CLAUDE_CREDENTIALS = credPath;
  try {
    const { io, writes, press } = fakeIO();
    const fetchInfo = fakeFetchImpl("fail");
    const runP = runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z"), limitsFetchImpl: fetchInfo.impl } as any, io);
    try {
      await sleep(PAST_ENTRANCE_MS);
      assert.ok(fetchInfo.calls >= 1, "sanity: the initial opt-in fetch attempt happened");

      press("\x1b[C");
      await sleep(80);
      press("\x1b[C");
      await sleep(300);
      assert.ok(strip(writes.join("")).includes("claude: unavailable"), "sanity: a failed opt-in fetch must render its quiet note before the toggle");
      const callsBeforeToggle = fetchInfo.calls;

      await toggleLimitsInApp(press);
      writes.length = 0; // capture starts AFTER the toggle -- the nav frames before the flip legitimately render the note
      backToWatch(press);
      await sleep(500);

      const out = strip(writes.join(""));
      assert.ok(!out.includes("claude: unavailable"), `the failure note must be cleared by the next frame once consent is revoked -- got:\n${out}`);
      assert.equal(fetchInfo.calls, callsBeforeToggle, "no further fetch attempts once consent is off");
    } finally {
      await quitRun(press, runP);
    }
  } finally {
    if (prevCred === undefined) delete process.env.DF_CLAUDE_CREDENTIALS;
    else process.env.DF_CLAUDE_CREDENTIALS = prevCred;
    restoreEnv(prevEnv);
  }
});

// ===================================================================================================
// 3 — --limits stays a one-run additive override for the WHOLE run, through the live re-read
// ===================================================================================================

test("D25a #3 (regression): --limits false forces the fetch off for the ENTIRE run -- a live per-cycle consent re-read must never let a mid-run settings toggle override the explicit per-run flag", async () => {
  const { home, projects } = seedCorpus({ limitsProviders: { claude: false } });
  const prevEnv = pinnedEnv(home, projects);
  const credHome = mkdtempSync(join(tmpdir(), "df-liveconsent-creds-"));
  const credPath = writeValidCreds(credHome);
  const prevCred = process.env.DF_CLAUDE_CREDENTIALS;
  process.env.DF_CLAUDE_CREDENTIALS = credPath;
  try {
    const { io, press } = fakeIO();
    const fetchInfo = fakeFetchImpl("ok");
    const runP = runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z"), limits: false, limitsFetchImpl: fetchInfo.impl } as any, io);
    try {
      await sleep(PAST_ENTRANCE_MS);
      assert.equal(fetchInfo.calls, 0, "sanity: --limits false forces the fetch off for this run, matching the persisted false at start");

      // Toggle Limits ON in-app -- persisted state flips false -> true, diverging from
      // the explicit per-run decline (the ONLY way to create real divergence: a single
      // flip of whatever the persisted boolean currently is). The flag must still win.
      await toggleLimitsInApp(press);
      assert.equal(loadState().limitsProviders?.claude, true, "sanity: the in-app toggle really did flip the persisted value, creating a genuine divergence from the flag");
      backToWatch(press);

      await sleep(700);
      assert.equal(
        fetchInfo.calls,
        0,
        "an explicit --limits false must win over a persisted true for the ENTIRE run, even after a live per-cycle consent re-read starts honoring settings changes elsewhere",
      );
    } finally {
      await quitRun(press, runP);
    }
  } finally {
    if (prevCred === undefined) delete process.env.DF_CLAUDE_CREDENTIALS;
    else process.env.DF_CLAUDE_CREDENTIALS = prevCred;
    restoreEnv(prevEnv);
  }
});

// ===================================================================================================
// 4 — each fetch cycle reads CURRENT persisted state, not a value cached at watch start or at the
//     last in-app toggle (pinned via an EXTERNALLY-mutated state file -- no in-app toggle at all)
// ===================================================================================================

test("D25a #4 (regression): each refresh cycle reads CURRENT persisted state off disk -- a state file mutated EXTERNALLY between cycles (no in-app toggle) is honored on the very next cycle", async () => {
  const { home, projects } = seedCorpus(); // no limitsProviders key at all -> defaults false
  const prevEnv = pinnedEnv(home, projects);
  const credHome = mkdtempSync(join(tmpdir(), "df-liveconsent-creds-"));
  const credPath = writeValidCreds(credHome);
  const prevCred = process.env.DF_CLAUDE_CREDENTIALS;
  process.env.DF_CLAUDE_CREDENTIALS = credPath;
  try {
    const { io, press } = fakeIO();
    const fetchInfo = fakeFetchImpl("ok");
    const runP = runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z"), limitsFetchImpl: fetchInfo.impl } as any, io);
    try {
      await sleep(PAST_ENTRANCE_MS);
      assert.equal(fetchInfo.calls, 0, "sanity: never consented, so nothing has fetched yet");

      // A SEPARATE process (another `deploy-forward settings` invocation, or a future
      // multi-account credential add, D25b) changes consent on disk -- this run's own
      // in-app settings UI is never touched.
      saveState({ ...loadState(), limitsProviders: { claude: true } });

      await sleep(700); // several 60ms beats
      assert.ok(fetchInfo.calls >= 1, "the very next refresh cycle must read the fresh state off disk, not a value cached at watch start or at the last in-app toggle");
    } finally {
      await quitRun(press, runP);
    }
  } finally {
    if (prevCred === undefined) delete process.env.DF_CLAUDE_CREDENTIALS;
    else process.env.DF_CLAUDE_CREDENTIALS = prevCred;
    restoreEnv(prevEnv);
  }
});

// ===================================================================================================
// 5 — token invariants untouched: zero calls when never consented, across the WHOLE run
// ===================================================================================================

test("D25a #5 (regression): never consented (no --limits flag, no persisted opt-in at all) -> zero fetch calls across the whole run, not merely checked at the start", async () => {
  const { home, projects } = seedCorpus(); // no limitsProviders key at all
  const prevEnv = pinnedEnv(home, projects);
  const credHome = mkdtempSync(join(tmpdir(), "df-liveconsent-creds-"));
  const credPath = writeValidCreds(credHome);
  const prevCred = process.env.DF_CLAUDE_CREDENTIALS;
  process.env.DF_CLAUDE_CREDENTIALS = credPath;
  try {
    const { io, press } = fakeIO();
    const fetchInfo = fakeFetchImpl("ok");
    const runP = runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z"), limitsFetchImpl: fetchInfo.impl } as any, io);
    try {
      await sleep(PAST_ENTRANCE_MS);
      await sleep(1000); // well past the initial check -- many refresh cycles with nobody ever consenting
      assert.equal(
        fetchInfo.calls,
        0,
        "a live per-cycle consent re-read must never start firing on its own -- fetchClaudeLimits' own optedIn hard gate (never touching the network when not opted in, pinned exhaustively in test/limitsFetch.test.ts) must stay honored for the whole run, not just at watch start",
      );
    } finally {
      await quitRun(press, runP);
    }
  } finally {
    if (prevCred === undefined) delete process.env.DF_CLAUDE_CREDENTIALS;
    else process.env.DF_CLAUDE_CREDENTIALS = prevCred;
    restoreEnv(prevEnv);
  }
});
