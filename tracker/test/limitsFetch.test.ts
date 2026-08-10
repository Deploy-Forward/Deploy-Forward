/**
 * LANE T8 — Claude usage-limits fetch (opt-in, read-only, vendor-reported).
 *
 * Marco's binding rulings (2026-07-17): opt-in only; READ-ONLY tokens (never refresh,
 * never write back — an expired token is REPORTED, not refreshed); tokens never leave
 * the machine except to their own vendor's endpoint, never logged, never in error
 * strings; fail soft (never throw); every figure labeled vendor-reported.
 *
 * The real endpoint shape below is captured LIVE (2026-07-17) from
 * GET https://api.anthropic.com/api/oauth/usage with headers
 * Authorization: Bearer <token> and anthropic-beta: oauth-2025-04-20 — used verbatim
 * as the primary fixture (no secrets in the body).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeAccessToken, parseClaudeLimits, fetchClaudeLimits } from "../src/limitsFetch.ts";
import type { ClaudeLimitLane, ClaudeLimitsResult } from "../src/limitsFetch.ts";

// The token literal used throughout — the secrecy pin checks this string never leaks
// into a stringified failure result.
const TOKEN = "sk-ant-oat01-REDACTED-FIXTURE-TOKEN-DO-NOT-USE";

function writeCreds(dir: string, o: { accessToken?: string; expiresAt?: number } | null): string {
  const p = join(dir, "credentials.json");
  if (o === null) return p; // caller wants a path that does not exist
  writeFileSync(
    p,
    JSON.stringify({
      claudeAiOauth: {
        ...(o.accessToken !== undefined ? { accessToken: o.accessToken } : {}),
        ...(o.expiresAt !== undefined ? { expiresAt: o.expiresAt } : {}),
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    }),
  );
  return p;
}

// ---- readClaudeAccessToken: fail-soft credentials read -----------------------------------------

test("readClaudeAccessToken: a well-formed credentials file yields the token + expiresAtMs verbatim", () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-creds-"));
  const p = writeCreds(home, { accessToken: TOKEN, expiresAt: 1_789_024_825_171 });
  const got = readClaudeAccessToken(p);
  assert.deepEqual(got, { token: TOKEN, expiresAtMs: 1_789_024_825_171 });
});

test("readClaudeAccessToken: a credentials file with no expiresAt field -> expiresAtMs null, token still read", () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-creds-"));
  const p = writeCreds(home, { accessToken: TOKEN });
  const got = readClaudeAccessToken(p);
  assert.deepEqual(got, { token: TOKEN, expiresAtMs: null });
});

test("readClaudeAccessToken: a missing file -> null, never a throw", () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-creds-"));
  const p = writeCreds(home, null); // never written
  assert.equal(readClaudeAccessToken(p), null);
});

test("readClaudeAccessToken: unparseable JSON -> null, never a throw", () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-creds-"));
  const p = join(home, "credentials.json");
  writeFileSync(p, "{ this is not json");
  assert.equal(readClaudeAccessToken(p), null);
});

test("readClaudeAccessToken: valid JSON missing accessToken -> null, never a guess", () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-creds-"));
  const p = join(home, "credentials.json");
  // claudeAiOauth present, but no accessToken field at all.
  writeFileSync(p, JSON.stringify({ claudeAiOauth: { expiresAt: 1_789_024_825_171 } }));
  assert.equal(readClaudeAccessToken(p), null);
});

test("readClaudeAccessToken: claudeAiOauth missing entirely -> null", () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-creds-"));
  const p = join(home, "credentials.json");
  writeFileSync(p, JSON.stringify({ somethingElse: true }));
  assert.equal(readClaudeAccessToken(p), null);
});

// ---- parseClaudeLimits: the real fixture + the fallback + the honest null ----------------------

// Verbatim (2026-07-17) from GET https://api.anthropic.com/api/oauth/usage.
const REAL_FIXTURE_BODY = {
  five_hour: {
    utilization: 12.0,
    resets_at: "2026-07-18T08:30:00.504493+00:00",
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day: {
    utilization: 56.0,
    resets_at: "2026-07-20T12:00:00.504518+00:00",
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  seven_day_cowork: null,
  seven_day_omelette: null,
  tangelo: null,
  iguana_necktie: null,
  omelette_promotional: null,
  nimbus_quill: null,
  cinder_cove: null,
  amber_ladder: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: null,
    used_credits: null,
    utilization: null,
    currency: null,
    decimal_places: null,
    disabled_reason: null,
    daily: null,
    weekly: null,
  },
  limits: [
    { kind: "session", group: "session", percent: 12, severity: "normal", resets_at: "2026-07-18T08:30:00.504493+00:00", scope: null, is_active: false },
    { kind: "weekly_all", group: "weekly", percent: 56, severity: "normal", resets_at: "2026-07-20T12:00:00.504518+00:00", scope: null, is_active: true },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 28,
      severity: "normal",
      resets_at: "2026-07-20T12:00:00.504858+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: false,
    },
  ],
  spend: {},
  member_dashboard_available: false,
};

test("parseClaudeLimits: the real fixture yields 3 lanes from limits[], scopeLabel from scope.model.display_name", () => {
  const lanes = parseClaudeLimits(REAL_FIXTURE_BODY);
  const expected: ClaudeLimitLane[] = [
    { kind: "session", group: "session", percent: 12, severity: "normal", resetsAt: "2026-07-18T08:30:00.504493+00:00", scopeLabel: null },
    { kind: "weekly_all", group: "weekly", percent: 56, severity: "normal", resetsAt: "2026-07-20T12:00:00.504518+00:00", scopeLabel: null },
    { kind: "weekly_scoped", group: "weekly", percent: 28, severity: "normal", resetsAt: "2026-07-20T12:00:00.504858+00:00", scopeLabel: "Fable" },
  ];
  assert.deepEqual(lanes, expected);
});

test("parseClaudeLimits: limits[] is PREFERRED even when five_hour/seven_day are also present (they are, in the real fixture)", () => {
  // The real fixture carries BOTH limits[] and five_hour/seven_day. The spec says limits[]
  // wins, so the result must be exactly the 3-lane array, never a 2-lane fallback synthesis.
  const lanes = parseClaudeLimits(REAL_FIXTURE_BODY);
  assert.equal(lanes?.length, 3, "limits[] (3 lanes) wins over the five_hour/seven_day fallback (2 lanes)");
});

test("parseClaudeLimits: falls back to five_hour/seven_day utilization when limits[] is absent", () => {
  const body = {
    five_hour: { utilization: 12.0, resets_at: "2026-07-18T08:30:00.504493+00:00" },
    seven_day: { utilization: 56.0, resets_at: "2026-07-20T12:00:00.504518+00:00" },
    // no limits[] field at all
  };
  const lanes = parseClaudeLimits(body);
  assert.equal(lanes?.length, 2, "two synthesized lanes: session (5h) + weekly_all (7d)");
  const session = lanes!.find((l) => l.kind === "session");
  const weekly = lanes!.find((l) => l.kind === "weekly_all");
  assert.ok(session, "the five_hour synthesized lane carries kind session");
  assert.equal(session!.percent, 12, "12.0 utilization -> 12 percent, hand-computed passthrough");
  assert.equal(session!.resetsAt, "2026-07-18T08:30:00.504493+00:00");
  assert.equal(session!.scopeLabel, null, "no scope info in the fallback shape");
  assert.ok(weekly, "the seven_day synthesized lane carries kind weekly_all");
  assert.equal(weekly!.percent, 56, "56.0 utilization -> 56 percent, hand-computed passthrough");
  assert.equal(weekly!.resetsAt, "2026-07-20T12:00:00.504518+00:00");
});

test("parseClaudeLimits: limits[] present but empty -> falls back to five_hour/seven_day, never an empty non-null array", () => {
  const body = {
    five_hour: { utilization: 5.0, resets_at: "2026-07-18T08:30:00.000000+00:00" },
    seven_day: { utilization: 10.0, resets_at: "2026-07-20T12:00:00.000000+00:00" },
    limits: [],
  };
  const lanes = parseClaudeLimits(body);
  assert.equal(lanes?.length, 2, "an empty limits[] is treated as absent, not as '0 lanes'");
});

test("parseClaudeLimits: a malformed entry inside limits[] is dropped; the good lanes survive; no survivors -> fallback", () => {
  // Coordinator ruling (lane T8 addendum): drop the bad entries, keep the good.
  // Three entries, the middle one lacks a numeric percent — only the two good survive.
  const body = {
    limits: [
      { kind: "session", group: "session", percent: 12, severity: "normal", resets_at: "2026-07-18T08:30:00.504493+00:00", scope: null, is_active: false },
      { kind: "weekly_all", group: "weekly", percent: "fifty-six", severity: "normal", resets_at: "2026-07-20T12:00:00.504518+00:00", scope: null, is_active: true },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 28,
        severity: "normal",
        resets_at: "2026-07-20T12:00:00.504858+00:00",
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
        is_active: false,
      },
    ],
  };
  const lanes = parseClaudeLimits(body);
  const expected: ClaudeLimitLane[] = [
    { kind: "session", group: "session", percent: 12, severity: "normal", resetsAt: "2026-07-18T08:30:00.504493+00:00", scopeLabel: null },
    { kind: "weekly_scoped", group: "weekly", percent: 28, severity: "normal", resetsAt: "2026-07-20T12:00:00.504858+00:00", scopeLabel: "Fable" },
  ];
  assert.deepEqual(lanes, expected, "the non-numeric-percent lane is dropped; the two good lanes survive verbatim");

  // If NO entry survives, ruling 2 applies: treat as empty and fall back to five_hour/seven_day.
  const noSurvivors = {
    five_hour: { utilization: 12.0, resets_at: "2026-07-18T08:30:00.504493+00:00" },
    seven_day: { utilization: 56.0, resets_at: "2026-07-20T12:00:00.504518+00:00" },
    limits: [
      { kind: "session", group: "session", percent: "twelve", severity: "normal", resets_at: "2026-07-18T08:30:00.504493+00:00", scope: null, is_active: false },
      { kind: "weekly_all", group: "weekly", severity: "normal", resets_at: "2026-07-20T12:00:00.504518+00:00", scope: null, is_active: true }, // percent absent
    ],
  };
  const fallback = parseClaudeLimits(noSurvivors);
  assert.equal(fallback?.length, 2, "all-malformed limits[] is treated as empty -> the five_hour/seven_day fallback fires");
  assert.deepEqual(
    fallback!.map((l) => [l.kind, l.percent]),
    [
      ["session", 12],
      ["weekly_all", 56],
    ],
    "the fallback lanes carry the headline utilizations, hand-computed passthrough",
  );
});

test("parseClaudeLimits: garbage or missing both sources -> null, never a guess, never a throw", () => {
  assert.equal(parseClaudeLimits(undefined), null);
  assert.equal(parseClaudeLimits(null), null);
  assert.equal(parseClaudeLimits("not an object"), null);
  assert.equal(parseClaudeLimits(42), null);
  assert.equal(parseClaudeLimits({}), null, "no limits[], no five_hour, no seven_day -> null");
  assert.equal(
    parseClaudeLimits({ five_hour: { utilization: "not-a-number" } }),
    null,
    "a non-numeric utilization is garbage, not a guessed percent",
  );
});

// ---- fetchClaudeLimits: consent gate, read-only, fail-soft, secrecy pin ------------------------

function fakeFetch(handler: (url: unknown, init: RequestInit | undefined) => { status: number; ok: boolean; json?: () => Promise<unknown> } | Promise<never>) {
  const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    if (r instanceof Promise) return r; // rejecting promise -> network failure path
    return { ok: r.ok, status: r.status, json: r.json ?? (async () => ({})) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("fetchClaudeLimits: optedIn false -> not-opted-in, fetchImpl is NEVER called (consent is a hard gate)", async () => {
  const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200 }));
  const res = await fetchClaudeLimits({ optedIn: false, credPath: "/nonexistent/whatever.json", fetchImpl: impl, nowMs: 1_000 });
  assert.deepEqual(res, { ok: false, reason: "not-opted-in" });
  assert.equal(calls.length, 0, "consent is a hard gate — no network call is ever made without opt-in");
});

test("fetchClaudeLimits: no credentials file -> no-credentials, fetchImpl is never called", async () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-fetch-"));
  const p = writeCreds(home, null); // never written
  const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200 }));
  const res = await fetchClaudeLimits({ optedIn: true, credPath: p, fetchImpl: impl, nowMs: 1_000 });
  assert.deepEqual(res, { ok: false, reason: "no-credentials" });
  assert.equal(calls.length, 0);
});

test("fetchClaudeLimits: a token in the past -> token-expired, WITHOUT calling fetch (never refresh)", async () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-fetch-"));
  const now = 2_000_000;
  const p = writeCreds(home, { accessToken: TOKEN, expiresAt: now - 1 }); // expired by 1ms
  const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200 }));
  const res = await fetchClaudeLimits({ optedIn: true, credPath: p, fetchImpl: impl, nowMs: now });
  assert.deepEqual(res, { ok: false, reason: "token-expired" });
  assert.equal(calls.length, 0, "an expired token is REPORTED, never used to attempt a refresh or a doomed call");
});

test("fetchClaudeLimits: happy path — exact Authorization + anthropic-beta headers, the oauth/usage URL, lanes parsed", async () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-fetch-"));
  const now = 2_000_000;
  const p = writeCreds(home, { accessToken: TOKEN, expiresAt: now + 1_000_000 }); // not expired
  const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200, json: async () => REAL_FIXTURE_BODY }));
  const res = await fetchClaudeLimits({ optedIn: true, credPath: p, fetchImpl: impl, nowMs: now });

  assert.equal(calls.length, 1, "exactly one network call on the happy path");
  const { url, init } = calls[0];
  assert.equal(String(url), "https://api.anthropic.com/api/oauth/usage");
  const headers = new Headers((init as RequestInit | undefined)?.headers as HeadersInit);
  assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`, "the exact bearer token, verbatim");
  assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.lanes.length, 3, "the real fixture's limits[] array wins");
    assert.deepEqual(
      res.lanes.map((l) => [l.kind, l.percent, l.scopeLabel]),
      [
        ["session", 12, null],
        ["weekly_all", 56, null],
        ["weekly_scoped", 28, "Fable"],
      ],
    );
    assert.equal(res.fetchedAtMs, now, "fetchedAtMs is the injected nowMs, not a fresh Date.now() call");
  }
});

test("fetchClaudeLimits: 401 -> http-error, never a throw", async () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-fetch-"));
  const now = 2_000_000;
  const p = writeCreds(home, { accessToken: TOKEN, expiresAt: now + 1_000_000 });
  const { impl } = fakeFetch(() => ({ ok: false, status: 401 }));
  const res = await fetchClaudeLimits({ optedIn: true, credPath: p, fetchImpl: impl, nowMs: now });
  assert.deepEqual(res, { ok: false, reason: "http-error" });
});

test("fetchClaudeLimits: 500 -> http-error, never a throw", async () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-fetch-"));
  const now = 2_000_000;
  const p = writeCreds(home, { accessToken: TOKEN, expiresAt: now + 1_000_000 });
  const { impl } = fakeFetch(() => ({ ok: false, status: 500 }));
  const res = await fetchClaudeLimits({ optedIn: true, credPath: p, fetchImpl: impl, nowMs: now });
  assert.deepEqual(res, { ok: false, reason: "http-error" });
});

test("fetchClaudeLimits: fetchImpl throwing -> network, never a throw out of fetchClaudeLimits", async () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-fetch-"));
  const now = 2_000_000;
  const p = writeCreds(home, { accessToken: TOKEN, expiresAt: now + 1_000_000 });
  const throwingFetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const res = await fetchClaudeLimits({ optedIn: true, credPath: p, fetchImpl: throwingFetch, nowMs: now });
  assert.deepEqual(res, { ok: false, reason: "network" });
});

test("fetchClaudeLimits: 200 with garbage body -> bad-shape, never a throw", async () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-fetch-"));
  const now = 2_000_000;
  const p = writeCreds(home, { accessToken: TOKEN, expiresAt: now + 1_000_000 });
  const { impl } = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ nonsense: true }) }));
  const res = await fetchClaudeLimits({ optedIn: true, credPath: p, fetchImpl: impl, nowMs: now });
  assert.deepEqual(res, { ok: false, reason: "bad-shape" });
});

test("fetchClaudeLimits: 200 whose body fails to JSON-parse -> bad-shape, never a throw, secrecy pin holds", async () => {
  // Coordinator ruling (lane T8 addendum): a 200 with an unparseable body is the same
  // class as a well-formed-but-garbage object — "bad-shape", not "network".
  const home = mkdtempSync(join(tmpdir(), "df-limits-fetch-"));
  const now = 2_000_000;
  const p = writeCreds(home, { accessToken: TOKEN, expiresAt: now + 1_000_000 });
  const { impl } = fakeFetch(() => ({
    ok: true,
    status: 200,
    // The body was "not-json": Response.json() rejects with a SyntaxError.
    json: async () => {
      throw new SyntaxError("Unexpected token 'n', \"not-json\" is not valid JSON");
    },
  }));
  const res = await fetchClaudeLimits({ optedIn: true, credPath: p, fetchImpl: impl, nowMs: now });
  assert.deepEqual(res, { ok: false, reason: "bad-shape" });
  assert.ok(!JSON.stringify(res).includes(TOKEN), "a JSON-parse failure result must never echo the token");
});

// ---- Secrecy pin: no failure result may ever carry the token, in any form -----------------------

test("fetchClaudeLimits SECRECY PIN: token-expired result never contains the token", async () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-fetch-"));
  const now = 2_000_000;
  const p = writeCreds(home, { accessToken: TOKEN, expiresAt: now - 1 });
  const { impl } = fakeFetch(() => ({ ok: true, status: 200 }));
  const res = await fetchClaudeLimits({ optedIn: true, credPath: p, fetchImpl: impl, nowMs: now });
  assert.ok(!JSON.stringify(res).includes(TOKEN), "an expired-token result must never echo the token");
});

test("fetchClaudeLimits SECRECY PIN: http-error result never contains the token", async () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-fetch-"));
  const now = 2_000_000;
  const p = writeCreds(home, { accessToken: TOKEN, expiresAt: now + 1_000_000 });
  const { impl } = fakeFetch(() => ({ ok: false, status: 401 }));
  const res = await fetchClaudeLimits({ optedIn: true, credPath: p, fetchImpl: impl, nowMs: now });
  assert.ok(!JSON.stringify(res).includes(TOKEN), "an http-error result must never echo the token used to make the call");
});

test("fetchClaudeLimits SECRECY PIN: network-failure result never contains the token", async () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-fetch-"));
  const now = 2_000_000;
  const p = writeCreds(home, { accessToken: TOKEN, expiresAt: now + 1_000_000 });
  const throwingFetch = (async () => {
    // Even a thrown error carrying the token in its message must not leak into the result.
    throw new Error(`network reset while calling with token ${TOKEN}`);
  }) as unknown as typeof fetch;
  const res = await fetchClaudeLimits({ optedIn: true, credPath: p, fetchImpl: throwingFetch, nowMs: now });
  assert.ok(!JSON.stringify(res).includes(TOKEN), "a network-failure result must never echo the token, even if the underlying error message did");
});

test("fetchClaudeLimits SECRECY PIN: bad-shape result never contains the token", async () => {
  const home = mkdtempSync(join(tmpdir(), "df-limits-fetch-"));
  const now = 2_000_000;
  const p = writeCreds(home, { accessToken: TOKEN, expiresAt: now + 1_000_000 });
  const { impl } = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ nonsense: true }) }));
  const res = await fetchClaudeLimits({ optedIn: true, credPath: p, fetchImpl: impl, nowMs: now });
  assert.ok(!JSON.stringify(res).includes(TOKEN), "a bad-shape result must never echo the token");
});
