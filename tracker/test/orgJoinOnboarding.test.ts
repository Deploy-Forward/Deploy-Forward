/**
 * D14 two-way org join — CLI onboarding lane (docs/d14-two-way-join-spec.md, C1/C2/C7).
 *
 * Covers:
 *   1. orgJoinOnboarding(ask) — the pure question composer (mirrors billingModeOnboarding's
 *      test style: it reads no state, remembers nothing across calls).
 *   2. orgSettingsValue / settingsRows — the C7 read-only Org row.
 *   3. runSuperStart's onboarding sequencing (C1a): opts.askOrgJoin fires ONLY after a
 *      SUCCESSFUL opts.pairOnboarding(), and BEFORE opts.askBillingMode; it never fires on
 *      decline, on a failed pair, on an already-paired device, or on non-TTY/--static.
 *      Mirrors test/superStartOnboarding.test.ts's fixtures and style exactly.
 *
 * Run: npx tsx --test test/orgJoinOnboarding.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLine } from "./fixtures.ts";
import { PARSER_EPOCH } from "../src/config.ts";
import { runSuperStart, orgJoinOnboarding, orgSettingsValue, settingsRows, type ShowcaseIO } from "../src/superStart.ts";

// ---- 1. orgJoinOnboarding (pure) ------------------------------------------------------

function makeAsk(
  choice: "code" | "request" | "skip",
  codeAnswer = "",
  slugAnswer = "",
): { ask: Parameters<typeof orgJoinOnboarding>[0]; calls: { choice: number; code: number; slug: number } } {
  const calls = { choice: 0, code: 0, slug: 0 };
  const ask = {
    choice: async () => {
      calls.choice++;
      return choice;
    },
    code: async () => {
      calls.code++;
      return codeAnswer;
    },
    slug: async () => {
      calls.slug++;
      return slugAnswer;
    },
  };
  return { ask, calls };
}

test("orgJoinOnboarding: choosing 'code' asks ask.code() and returns it, never touches ask.slug()", async () => {
  const { ask, calls } = makeAsk("code", "acme:secret123");
  const result = await orgJoinOnboarding(ask);
  assert.deepEqual(result, { action: "code", code: "acme:secret123" });
  assert.equal(calls.choice, 1);
  assert.equal(calls.code, 1);
  assert.equal(calls.slug, 0, "choosing code must never ask for a slug");
});

test("orgJoinOnboarding: choosing 'request' asks ask.slug() and returns it, never touches ask.code()", async () => {
  const { ask, calls } = makeAsk("request", "", "acme");
  const result = await orgJoinOnboarding(ask);
  assert.deepEqual(result, { action: "request", slug: "acme" });
  assert.equal(calls.slug, 1);
  assert.equal(calls.code, 0, "choosing request must never ask for a code");
});

test("orgJoinOnboarding: choosing 'skip' (the default) asks nothing further", async () => {
  const { ask, calls } = makeAsk("skip");
  const result = await orgJoinOnboarding(ask);
  assert.deepEqual(result, { action: "skip" });
  assert.equal(calls.code, 0);
  assert.equal(calls.slug, 0);
});

test("orgJoinOnboarding: is PURE -- remembers nothing across calls", async () => {
  const first = await orgJoinOnboarding(makeAsk("skip").ask);
  const second = await orgJoinOnboarding(makeAsk("code", "x:y").ask);
  assert.deepEqual(first, { action: "skip" });
  assert.deepEqual(second, { action: "code", code: "x:y" });
});

// ---- 2. orgSettingsValue / settingsRows (C7) -------------------------------------------

const BASE_STATE = {
  apiBase: "http://x/api",
  deviceToken: "tok",
  uid: "u1",
  handle: "tester",
  repoHmacKey: "k".repeat(64),
  cursors: {},
  threadDigests: {},
  orgStamp: "none",
  parserEpoch: PARSER_EPOCH,
  lastSyncAt: 0,
  gapMs: 300000,
};

test("orgSettingsValue: no org context -> 'none'", () => {
  assert.equal(orgSettingsValue(undefined), "none");
  assert.equal(orgSettingsValue({ enrolled: false, checkedAt: 0 }), "none");
});

test("orgSettingsValue: enrolled with a known role+team renders '{label} ({role}, {team})'", () => {
  const org = {
    enrolled: true,
    orgId: "org1",
    teamId: "team-eng",
    orgLabel: "Acme",
    attribution: { organizations: [{ orgId: "org1", label: "Acme", role: "admin", teamId: "team-eng", projects: [] }], grants: [], fingerprint: "f" },
    checkedAt: 0,
  };
  assert.equal(orgSettingsValue(org), "Acme (admin, team-eng)");
});

test("orgSettingsValue: enrolled with no role known (attribution absent) renders just the label", () => {
  assert.equal(orgSettingsValue({ enrolled: true, orgId: "org1", orgLabel: "Acme", checkedAt: 0 }), "Acme");
});

test("orgSettingsValue: one pending request renders 'request pending - {label} (expires {n}d)'", () => {
  const now = Date.parse("2026-07-01T00:00:00.000Z");
  const org = {
    enrolled: false,
    pendingRequests: [{ orgId: "org1", orgLabel: "Acme", slug: "acme", status: "pending", expiresAt: now + 3 * 86_400_000 }],
    checkedAt: 0,
  };
  assert.equal(orgSettingsValue(org, now), "request pending - Acme (expires 3d)");
});

test("orgSettingsValue: multiple pending requests show the MOST RECENT (latest expiresAt) + a '+N more' suffix", () => {
  const now = Date.parse("2026-07-01T00:00:00.000Z");
  const org = {
    enrolled: false,
    pendingRequests: [
      { orgId: "org1", orgLabel: "Older", slug: "older", status: "pending", expiresAt: now + 1 * 86_400_000 },
      { orgId: "org2", orgLabel: "Newest", slug: "newest", status: "pending", expiresAt: now + 6 * 86_400_000 },
      { orgId: "org3", orgLabel: "Middle", slug: "middle", status: "pending", expiresAt: now + 3 * 86_400_000 },
    ],
    checkedAt: 0,
  };
  assert.equal(orgSettingsValue(org, now), "request pending - Newest (expires 6d) (+2 more - df status)");
});

test("settingsRows: an Org row exists beside Device (both non-toggleable)", () => {
  const rows = settingsRows({ ...BASE_STATE, org: { enrolled: true, orgId: "org1", orgLabel: "Acme", checkedAt: 0 } } as any);
  const names = rows.map((r) => r.name);
  assert.ok(names.includes("Org"), `Org row missing -- got: ${names.join(", ")}`);
  const orgIdx = names.indexOf("Org");
  const deviceIdx = names.indexOf("Device");
  assert.ok(deviceIdx === orgIdx + 1, "Org sits immediately beside Device");
  const orgRow = rows[orgIdx];
  assert.equal(orgRow.toggleable, false);
  assert.equal(orgRow.value, "Acme");
});

test("settingsRows: toggling 'Org' is a documented no-op (read-only display, not a boolean)", () => {
  // toggleSettingsRow's contract: any row without a case is untouched -- verified via
  // settingsStep's own toggleable gate (settingsStep never calls toggleSettingsRow for
  // a non-toggleable row), so this just pins that the row IS marked non-toggleable.
  const rows = settingsRows({ ...BASE_STATE, org: undefined } as any);
  const org = rows.find((r) => r.name === "Org");
  assert.equal(org?.toggleable, false);
});

// ---- 3. runSuperStart onboarding sequencing (C1a) --------------------------------------

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

function seedCorpus(opts: { deviceToken?: string | null } = {}): { home: string; projects: string } {
  const home = mkdtempSync(join(tmpdir(), "df-orgonboard-home-"));
  const projects = mkdtempSync(join(tmpdir(), "df-orgonboard-projects-"));
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

function boolCounter(result: boolean): { fn: () => Promise<boolean>; calls: number } {
  const state = { fn: async () => false, calls: 0 };
  state.fn = async () => {
    state.calls++;
    return result;
  };
  return state;
}

function voidTracker(): { fn: () => Promise<void>; calls: number } {
  const state = { fn: async () => {}, calls: 0 };
  state.fn = async () => {
    state.calls++;
  };
  return state;
}

function neverCalledVoid(label: string): () => Promise<void> {
  return async () => {
    throw new Error(`${label} must never be called on this path`);
  };
}
function neverCalledBool(label: string): () => Promise<boolean> {
  return async () => {
    throw new Error(`${label} must never be called on this path`);
  };
}

test("C1a: ACCEPT + successful pair -> askOrgJoin fires exactly once, AFTER pairOnboarding, BEFORE askBillingMode", async () => {
  const { home, projects } = seedCorpus({ deviceToken: null });
  const prev = pinnedEnv(home, projects);
  try {
    const { io } = fakeInteractiveIO();
    const order: string[] = [];
    const ask = boolCounter(true);
    const pair = { fn: async () => (order.push("pair"), true), calls: 0 } as unknown as { fn: () => Promise<boolean>; calls: number };
    const orgJoin = { fn: async () => void order.push("orgJoin"), calls: 0 } as unknown as { fn: () => Promise<void>; calls: number };
    const billing = { fn: async () => void order.push("billing"), calls: 0 } as unknown as { fn: () => Promise<void>; calls: number };
    await runSuperStart(
      {
        now: Date.parse("2026-06-05T00:00:00.000Z"),
        askOnboarding: ask.fn,
        pairOnboarding: pair.fn,
        askOrgJoin: orgJoin.fn,
        askBillingMode: billing.fn,
      } as any,
      io,
    );
    assert.deepEqual(order, ["pair", "orgJoin", "billing"], "org-join must fire strictly after a successful pair and strictly before billing");
  } finally {
    restoreEnv(prev);
  }
});

test("C1a: DECLINE the board -> askOrgJoin is NEVER called (no device token, nothing to attach a membership to)", async () => {
  const { home, projects } = seedCorpus({ deviceToken: null });
  const prev = pinnedEnv(home, projects);
  try {
    const { io } = fakeInteractiveIO();
    const ask = boolCounter(false);
    await runSuperStart(
      {
        now: Date.parse("2026-06-05T00:00:00.000Z"),
        askOnboarding: ask.fn,
        pairOnboarding: neverCalledBool("pairOnboarding"),
        askOrgJoin: neverCalledVoid("askOrgJoin"),
        askBillingMode: voidTracker().fn,
      } as any,
      io,
    );
    assert.equal(ask.calls, 1);
  } finally {
    restoreEnv(prev);
  }
});

test("C1a: ACCEPT but a FAILED pair -> askOrgJoin is NEVER called", async () => {
  const { home, projects } = seedCorpus({ deviceToken: null });
  const prev = pinnedEnv(home, projects);
  try {
    const { io } = fakeInteractiveIO();
    const ask = boolCounter(true);
    const pair = boolCounter(false);
    await runSuperStart(
      {
        now: Date.parse("2026-06-05T00:00:00.000Z"),
        askOnboarding: ask.fn,
        pairOnboarding: pair.fn,
        askOrgJoin: neverCalledVoid("askOrgJoin"),
      } as any,
      io,
    );
    assert.equal(pair.calls, 1);
  } finally {
    restoreEnv(prev);
  }
});

test("C1a: an already-PAIRED device -> askOrgJoin is NEVER called (no onboarding block at all)", async () => {
  const { home, projects } = seedCorpus({ deviceToken: "test-token" });
  const prev = pinnedEnv(home, projects);
  try {
    const { io } = fakeInteractiveIO();
    await runSuperStart(
      {
        now: Date.parse("2026-06-05T00:00:00.000Z"),
        askOnboarding: neverCalledBool("askOnboarding"),
        pairOnboarding: neverCalledBool("pairOnboarding"),
        askOrgJoin: neverCalledVoid("askOrgJoin"),
      } as any,
      io,
    );
  } finally {
    restoreEnv(prev);
  }
});

test("C1a: NON-INTERACTIVE (no TTY) -> askOrgJoin is NEVER called", async () => {
  const { home, projects } = seedCorpus({ deviceToken: null });
  const prev = pinnedEnv(home, projects);
  try {
    const writes: string[] = [];
    const io: ShowcaseIO = { write: (s) => writes.push(s), isTTY: false, rows: () => 24, cols: () => 80 };
    await runSuperStart(
      {
        now: Date.parse("2026-06-05T00:00:00.000Z"),
        askOnboarding: neverCalledBool("askOnboarding"),
        pairOnboarding: neverCalledBool("pairOnboarding"),
        askOrgJoin: neverCalledVoid("askOrgJoin"),
      } as any,
      io,
    );
  } finally {
    restoreEnv(prev);
  }
});

test("C1a: --static -> askOrgJoin is NEVER called", async () => {
  const { home, projects } = seedCorpus({ deviceToken: null });
  const prev = pinnedEnv(home, projects);
  try {
    const writes: string[] = [];
    const io: ShowcaseIO = { write: (s) => writes.push(s), isTTY: true, rows: () => 40, cols: () => 120 };
    await runSuperStart(
      {
        static: true,
        now: Date.parse("2026-06-05T00:00:00.000Z"),
        askOnboarding: neverCalledBool("askOnboarding"),
        pairOnboarding: neverCalledBool("pairOnboarding"),
        askOrgJoin: neverCalledVoid("askOrgJoin"),
      } as any,
      io,
    );
  } finally {
    restoreEnv(prev);
  }
});

test("C1a: askOrgJoin/askBillingMode omitted entirely (production seam optionality) -> no crash, existing behavior unaffected", async () => {
  const { home, projects } = seedCorpus({ deviceToken: null });
  const prev = pinnedEnv(home, projects);
  try {
    const { io } = fakeInteractiveIO();
    const ask = boolCounter(true);
    const pair = boolCounter(true);
    await runSuperStart(
      {
        now: Date.parse("2026-06-05T00:00:00.000Z"),
        askOnboarding: ask.fn,
        pairOnboarding: pair.fn,
        // askOrgJoin / askBillingMode both omitted -- exactly today's existing test shape.
      } as any,
      io,
    );
    assert.equal(pair.calls, 1);
  } finally {
    restoreEnv(prev);
  }
});
