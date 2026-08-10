/**
 * Onboarding v2 — billing-aware onboarding + persisted per-provider limits opt-in.
 * Marco's D9 ruling (2026-07-18, docs/context-capacity-plan.md Phase 6, verbatim intent):
 *
 *   "Are you on any monthly-based subscription plans?" Yes -> offer the supported
 *   providers (Codex -> GPT models [disk, already on], Claude -> Claude models
 *   [opt-in endpoint], Grok -> grok models [research], Cursor -> usage-maybe
 *   [research]) and persist per-provider limits opt-ins in state; the watch then
 *   fetches vendor-reported lanes WITHOUT needing --limits each run (the flag
 *   remains as per-run override). Token/API users skip limits entirely; token
 *   tracking stays the product's focus for everyone.
 *
 * THE SEAMS THIS SUITE PINS (none exist yet — this is the intentional red):
 *
 *   1. TrackerState.limitsProviders?: { claude?: boolean } (src/config.ts) — a
 *      persisted per-provider opt-in map. Codex needs no entry (disk-read, always
 *      on). Grok/Cursor are future research; the type stays open via optional keys,
 *      but this suite pins ONLY claude. loadState()/saveState() must round-trip it
 *      like every other field.
 *
 *   2. billingOnboarding(ask): Promise<{ claude?: boolean }> — a new exported PURE
 *      helper. Placement choice made BY THIS SUITE (the spec left it open — "src/
 *      superStart.ts, or a small new module"): pinned to src/superStart.ts, next to
 *      the other onboarding seam (askOnboarding/pairOnboarding, lane T7). Flag this
 *      placement to the impl agent — it is a choice, not a requirement, and may move.
 *
 *        billingOnboarding(ask: {
 *          subscription: () => Promise<boolean>;
 *          provider: (name: string) => Promise<boolean>;
 *        }): Promise<{ claude?: boolean }>
 *
 *      - asks ask.subscription() exactly once ("monthly-based subscription plans?");
 *      - false -> returns {} and NEVER calls ask.provider (token/API users skip
 *        limits entirely, no per-provider prompt at all);
 *      - true -> calls ask.provider EXACTLY for the providers that need consent
 *        (today: only "claude" — Codex is disk-only/always-on and must never be
 *        asked); the result carries exactly what was answered, verbatim, including
 *        an explicit `false` (a decline is a real persisted no, not an omitted key).
 *      - it is a PURE function: it reads no state and remembers nothing across
 *        calls, so decline is never sticky-forever — a later call with a different
 *        answer simply returns that different answer (see the last test below).
 *
 *   3. Watch defaulting (src/superStart.ts's runSuperStart): today the lanes fetch
 *      is gated by `if (!opts.limits || ...) return;` — a bare per-run flag with no
 *      persisted memory. The contract requires:
 *
 *        const limitsOptIn = opts.limits ?? loadState().limitsProviders?.claude ?? false;
 *
 *      i.e. an explicit opts.limits (true OR false — `??` only falls through on
 *      undefined) always wins as the per-run override; omitted opts.limits falls
 *      back to the persisted claude opt-in; both absent -> false (today's default,
 *      unchanged). No test-reachable seam exists today to fake the network call
 *      this gate guards, so this suite also pins the minimal one:
 *
 *        SuperStartOptions.limitsFetchImpl?: typeof fetch
 *
 *      threaded into the existing fetchClaudeLimits({ ..., fetchImpl: ... }) call
 *      in place of the hardcoded global `fetch` (falling back to it when omitted —
 *      every production call site is unaffected).
 *
 * Run: npx tsx --test test/onboardingV2.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLine } from "./fixtures.ts";
import { PARSER_EPOCH, loadState, saveState } from "../src/config.ts";
import { runSuperStart, type ShowcaseIO } from "../src/superStart.ts";
// Namespace import for the not-yet-existing pure helper: a missing named export
// under a namespace import resolves to `undefined` at the property read (a clean
// per-test TypeError/assertion red), never a module-load SyntaxError that would
// kill every test in this file at once.
import * as SS from "../src/superStart.ts";

// ---- env + corpus plumbing (mirrors test/superStart.test.ts's & test/superStartOnboarding.test.ts's) --

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

/** A minimal non-empty corpus (skips the honest-empty-state early return) plus a
 * state.json under test control, optionally carrying a limitsProviders opt-in map.
 * apiBase points at a local closed port so a would-be sync push fails fast. */
function seedCorpus(opts: { deviceToken?: string | null; limitsProviders?: { claude?: boolean } } = {}): {
  home: string;
  projects: string;
} {
  const home = mkdtempSync(join(tmpdir(), "df-onboardingv2-home-"));
  const projects = mkdtempSync(join(tmpdir(), "df-onboardingv2-projects-"));
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
      ...(opts.limitsProviders !== undefined ? { limitsProviders: opts.limitsProviders } : {}),
    }),
  );
  return { home, projects };
}

/** A well-formed, NOT-expired Claude Code credentials file — real wall-clock time
 * (fetchClaudeLimits is called with nowMs: Date.now() inside superStart.ts, not the
 * fixture's injected `now`), so the expiry is pinned a year out to stay valid
 * regardless of when the suite runs. */
function writeValidCreds(dir: string): string {
  const p = join(dir, "credentials.json");
  writeFileSync(
    p,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-onboardingv2-fixture-token",
        expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 365,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    }),
  );
  return p;
}

/** Counts attempts against SuperStartOptions.limitsFetchImpl — mirrors
 * test/limitsFetch.test.ts's fakeFetch, trimmed to a bare call counter (the gate
 * under test is WHETHER the vendor call is attempted, not its body).
 * `calls` is a live getter: NEVER destructure it (`const { calls } = ...` reads it
 * ONCE and freezes 0 forever — the exact defect this comment guards against). Keep
 * the returned object whole and read `.calls` AFTER the awaited run. */
function fakeFetchImpl(): { impl: typeof fetch; readonly calls: number } {
  const counter = { calls: 0 };
  const impl = (async () => {
    counter.calls++;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, get calls() { return counter.calls; } };
}

/** A real full-screen takeover, auto-quit shortly after the takeover actually
 * registers its key handler (deterministic — no race with setup). Mirrors
 * test/superStartOnboarding.test.ts's fakeInteractiveIO. */
function fakeInteractiveIO(quitAfterMs = 300): { io: ShowcaseIO } {
  let dataListener: ((d: Buffer) => void) | null = null;
  const io: ShowcaseIO = {
    write: () => {},
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
  return { io };
}

/** Fakes billingOnboarding's `ask` seam, recording exactly what was asked. */
function makeAsk(
  subscriptionAnswer: boolean,
  providerAnswers: Record<string, boolean>,
): {
  ask: { subscription: () => Promise<boolean>; provider: (name: string) => Promise<boolean> };
  calls: { subscription: number; provider: string[] };
} {
  const calls = { subscription: 0, provider: [] as string[] };
  const ask = {
    subscription: async () => {
      calls.subscription++;
      return subscriptionAnswer;
    },
    provider: async (name: string) => {
      calls.provider.push(name);
      return providerAnswers[name] ?? false;
    },
  };
  return { ask, calls };
}

// ---- 1. TrackerState.limitsProviders?: { claude?: boolean } — persisted round trip ------------

test("TrackerState.limitsProviders.claude: an ACCEPTED opt-in survives a save/load round trip", () => {
  const home = mkdtempSync(join(tmpdir(), "df-onboardingv2-state-"));
  const prevHome = process.env.DF_HOME;
  process.env.DF_HOME = home;
  try {
    const base = loadState();
    assert.equal(base.limitsProviders?.claude, undefined, "a fresh state carries no opt-in yet");
    saveState({ ...base, limitsProviders: { claude: true } });
    const reloaded = loadState();
    assert.equal(reloaded.limitsProviders?.claude, true, "a persisted claude:true opt-in must survive save/load, like every other field");
  } finally {
    if (prevHome === undefined) delete process.env.DF_HOME;
    else process.env.DF_HOME = prevHome;
  }
});

test("TrackerState.limitsProviders.claude: a DECLINED opt-in (false) persists as an explicit false, not an absent key", () => {
  const home = mkdtempSync(join(tmpdir(), "df-onboardingv2-state-"));
  const prevHome = process.env.DF_HOME;
  process.env.DF_HOME = home;
  try {
    const base = loadState();
    saveState({ ...base, limitsProviders: { claude: false } });
    const reloaded = loadState();
    assert.notEqual(reloaded.limitsProviders, undefined, "the map itself must survive a decline, not collapse to absent");
    assert.equal(reloaded.limitsProviders?.claude, false, "a decline is a real persisted false, verbatim");
  } finally {
    if (prevHome === undefined) delete process.env.DF_HOME;
    else process.env.DF_HOME = prevHome;
  }
});

// ---- 2. billingOnboarding — the pure onboarding helper (D9's billing question) -----------------

test("billingOnboarding: declining the subscription question returns {} and NEVER asks a per-provider question", async () => {
  const { ask, calls } = makeAsk(false, {});
  const result = await SS.billingOnboarding(ask);
  assert.deepEqual(result, {}, "a token/API user's opt-in map is empty -- limits are skipped entirely");
  assert.equal(calls.subscription, 1, "the subscription question is asked exactly once");
  assert.deepEqual(calls.provider, [], "declining the subscription question must never reach a per-provider question");
});

test("billingOnboarding: accepting the subscription question asks per-provider consent for claude ONLY, never codex", async () => {
  const { ask, calls } = makeAsk(true, { claude: true });
  const result = await SS.billingOnboarding(ask);
  assert.equal(calls.subscription, 1, "the subscription question is asked exactly once, even on accept");
  assert.deepEqual(calls.provider, ["claude"], "only claude needs consent -- Codex is disk-read and always on, never asked");
  assert.deepEqual(result, { claude: true });
});

test("billingOnboarding: a per-provider DECLINE persists as a real false, not an omitted key", async () => {
  const { ask } = makeAsk(true, { claude: false });
  const result = await SS.billingOnboarding(ask);
  assert.deepEqual(result, { claude: false }, "the caller persists exactly this -- a decline must be an explicit opt-out, not silence");
});

test("billingOnboarding: is PURE -- it remembers nothing across calls, so a later call can answer differently", async () => {
  const declined = await SS.billingOnboarding(makeAsk(true, { claude: false }).ask);
  const accepted = await SS.billingOnboarding(makeAsk(true, { claude: true }).ask);
  assert.deepEqual(declined, { claude: false });
  assert.deepEqual(accepted, { claude: true }, "no hidden sticky state -- each call reflects only its own answers");
});

// ---- 3. Watch defaulting: opts.limits ?? loadState().limitsProviders?.claude ?? false ----------

test("watch defaulting: limitsProviders.claude=true + no --limits flag -> the vendor lanes fetch IS attempted", async () => {
  const credHome = mkdtempSync(join(tmpdir(), "df-onboardingv2-creds-"));
  const credPath = writeValidCreds(credHome);
  const { home, projects } = seedCorpus({ deviceToken: "test-token", limitsProviders: { claude: true } });
  const prevEnv = pinnedEnv(home, projects);
  const prevCred = process.env.DF_CLAUDE_CREDENTIALS;
  process.env.DF_CLAUDE_CREDENTIALS = credPath;
  try {
    const { io } = fakeInteractiveIO();
    const fetchInfo = fakeFetchImpl();
    await runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z"), limitsFetchImpl: fetchInfo.impl } as any, io);
    assert.ok(fetchInfo.calls >= 1, "a persisted claude opt-in with no --limits override must still fetch vendor-reported lanes");
  } finally {
    if (prevCred === undefined) delete process.env.DF_CLAUDE_CREDENTIALS;
    else process.env.DF_CLAUDE_CREDENTIALS = prevCred;
    restoreEnv(prevEnv);
  }
});

test("watch defaulting: limitsProviders.claude=false + no --limits flag -> zero fetch calls", async () => {
  const credHome = mkdtempSync(join(tmpdir(), "df-onboardingv2-creds-"));
  const credPath = writeValidCreds(credHome);
  const { home, projects } = seedCorpus({ deviceToken: "test-token", limitsProviders: { claude: false } });
  const prevEnv = pinnedEnv(home, projects);
  const prevCred = process.env.DF_CLAUDE_CREDENTIALS;
  process.env.DF_CLAUDE_CREDENTIALS = credPath;
  try {
    const { io } = fakeInteractiveIO();
    const fetchInfo = fakeFetchImpl();
    await runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z"), limitsFetchImpl: fetchInfo.impl } as any, io);
    assert.equal(fetchInfo.calls, 0, "a persisted decline must never be overridden into a fetch");
  } finally {
    if (prevCred === undefined) delete process.env.DF_CLAUDE_CREDENTIALS;
    else process.env.DF_CLAUDE_CREDENTIALS = prevCred;
    restoreEnv(prevEnv);
  }
});

test("watch defaulting: no limitsProviders in state at all -> defaults to false, zero fetch calls (unchanged default)", async () => {
  const credHome = mkdtempSync(join(tmpdir(), "df-onboardingv2-creds-"));
  const credPath = writeValidCreds(credHome);
  const { home, projects } = seedCorpus({ deviceToken: "test-token" }); // no limitsProviders key at all
  const prevEnv = pinnedEnv(home, projects);
  const prevCred = process.env.DF_CLAUDE_CREDENTIALS;
  process.env.DF_CLAUDE_CREDENTIALS = credPath;
  try {
    const { io } = fakeInteractiveIO();
    const fetchInfo = fakeFetchImpl();
    await runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z"), limitsFetchImpl: fetchInfo.impl } as any, io);
    assert.equal(fetchInfo.calls, 0, "no persisted opt-in at all must default to off, exactly like today");
  } finally {
    if (prevCred === undefined) delete process.env.DF_CLAUDE_CREDENTIALS;
    else process.env.DF_CLAUDE_CREDENTIALS = prevCred;
    restoreEnv(prevEnv);
  }
});

test("watch defaulting: an explicit --limits override (true) still fetches even when the persisted opt-in is false", async () => {
  const credHome = mkdtempSync(join(tmpdir(), "df-onboardingv2-creds-"));
  const credPath = writeValidCreds(credHome);
  const { home, projects } = seedCorpus({ deviceToken: "test-token", limitsProviders: { claude: false } });
  const prevEnv = pinnedEnv(home, projects);
  const prevCred = process.env.DF_CLAUDE_CREDENTIALS;
  process.env.DF_CLAUDE_CREDENTIALS = credPath;
  try {
    const { io } = fakeInteractiveIO();
    const fetchInfo = fakeFetchImpl();
    await runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z"), limits: true, limitsFetchImpl: fetchInfo.impl } as any, io);
    assert.ok(fetchInfo.calls >= 1, "--limits remains a real per-run override in EITHER direction, independent of the persisted opt-in");
  } finally {
    if (prevCred === undefined) delete process.env.DF_CLAUDE_CREDENTIALS;
    else process.env.DF_CLAUDE_CREDENTIALS = prevCred;
    restoreEnv(prevEnv);
  }
});

test("watch defaulting: an explicit false override wins over a persisted true opt-in (?? only falls through on undefined, not false)", async () => {
  const credHome = mkdtempSync(join(tmpdir(), "df-onboardingv2-creds-"));
  const credPath = writeValidCreds(credHome);
  const { home, projects } = seedCorpus({ deviceToken: "test-token", limitsProviders: { claude: true } });
  const prevEnv = pinnedEnv(home, projects);
  const prevCred = process.env.DF_CLAUDE_CREDENTIALS;
  process.env.DF_CLAUDE_CREDENTIALS = credPath;
  try {
    const { io } = fakeInteractiveIO();
    const fetchInfo = fakeFetchImpl();
    await runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z"), limits: false, limitsFetchImpl: fetchInfo.impl } as any, io);
    assert.equal(fetchInfo.calls, 0, "an explicit false is not undefined -- it must win over the persisted true, never fall through to state");
  } finally {
    if (prevCred === undefined) delete process.env.DF_CLAUDE_CREDENTIALS;
    else process.env.DF_CLAUDE_CREDENTIALS = prevCred;
    restoreEnv(prevEnv);
  }
});

// ---- 4. Decline persists across runs, but re-onboarding can flip it (the doc's promise) --------

test("decline path: a persisted claude:false state never fetches on a later run, but re-running onboarding CAN flip it for the NEXT run", async () => {
  const credHome = mkdtempSync(join(tmpdir(), "df-onboardingv2-creds-"));
  const credPath = writeValidCreds(credHome);
  const { home, projects } = seedCorpus({ deviceToken: "test-token", limitsProviders: { claude: false } });
  const prevEnv = pinnedEnv(home, projects);
  const prevCred = process.env.DF_CLAUDE_CREDENTIALS;
  process.env.DF_CLAUDE_CREDENTIALS = credPath;
  try {
    const NOW = Date.parse("2026-06-05T00:00:00.000Z");

    // Run 1: the earlier decline holds -- honored on a later run with no flag at all.
    {
      const { io } = fakeInteractiveIO();
      const fetchInfo = fakeFetchImpl();
      await runSuperStart({ now: NOW, limitsFetchImpl: fetchInfo.impl } as any, io);
      assert.equal(fetchInfo.calls, 0, "a persisted decline is honored on a later run");
    }

    // Re-running onboarding: the user changes their mind. billingOnboarding is PURE --
    // it has no memory of the earlier decline -- so answering differently this time
    // simply returns the new answer; the CALLER (production: bin/df.ts) is responsible
    // for persisting it, mirrored here with the same loadState/saveState round trip
    // pinned in section 1.
    const flipped = await SS.billingOnboarding(makeAsk(true, { claude: true }).ask);
    assert.deepEqual(flipped, { claude: true }, "re-onboarding CAN flip a prior decline -- nothing is sticky-forever");
    const current = loadState();
    saveState({ ...current, limitsProviders: { ...current.limitsProviders, ...flipped } });
    assert.equal(loadState().limitsProviders?.claude, true, "the flip is persisted");

    // Run 2: the flipped opt-in takes effect immediately, no --limits flag needed.
    {
      const { io } = fakeInteractiveIO();
      const fetchInfo = fakeFetchImpl();
      await runSuperStart({ now: NOW, limitsFetchImpl: fetchInfo.impl } as any, io);
      assert.ok(fetchInfo.calls >= 1, "the flipped opt-in fetches on the very next run");
    }
  } finally {
    if (prevCred === undefined) delete process.env.DF_CLAUDE_CREDENTIALS;
    else process.env.DF_CLAUDE_CREDENTIALS = prevCred;
    restoreEnv(prevEnv);
  }
});
