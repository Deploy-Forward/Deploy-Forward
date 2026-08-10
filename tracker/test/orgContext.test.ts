/**
 * P1.1 enrollment bridge tests.
 *
 * Pure units: normalizeRepoSlug (host-agnostic slug normalization) and orgRepoFor (THE
 * payload gating decision — the client-side privacy boundary: a non-enrolled device
 * never puts a repo name on the wire, spec ruling 2.1 #3).
 *
 * refreshOrgContext: cache TTL, authoritative overwrite (not_enrolled / 401 beats a
 * stale enrolled cache), and FAIL CLOSED on network error.
 *
 * syncOnce integration (skipped when git is unavailable): the full enrollment cycle —
 * not-enrolled uploads carry no orgRepo key; a confirmed enroll flips the digest and
 * re-uploads the byte-identical corpus WITH orgRepo; a confirmed un-enroll re-uploads
 * WITHOUT it; steady state uploads nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeRepoSlug,
  orgRepoFor,
  repoSlugForCwd,
  refreshOrgContext,
  ORG_CONTEXT_TTL_MS,
} from "../src/orgContext.ts";
import { PARSER_EPOCH, type TrackerState } from "../src/config.ts";
import { syncOnce } from "../src/sync.ts";
import { claudeLine } from "./fixtures.ts";

// ---- normalizeRepoSlug (pure) ----------------------------------------------------------------

test("normalizeRepoSlug: every remote URL shape folds to a lowercase owner/name slug", () => {
  const cases: [string, string | null][] = [
    // scp-like ssh
    ["git@github.com:Marco/Deploy-Forward.git", "marco/deploy-forward"],
    ["git@github.com:owner/name", "owner/name"],
    // https, .git suffix, trailing slash
    ["https://github.com/Owner/Repo.git", "owner/repo"],
    ["https://github.com/owner/repo/", "owner/repo"],
    ["https://github.com/owner/repo", "owner/repo"],
    // ssh:// scheme (with and without port)
    ["ssh://git@github.com/owner/repo", "owner/repo"],
    ["ssh://git@gitlab.corp.io:2222/group/sub/project.git", "sub/project"],
    // non-github hosts; deep group paths keep the LAST TWO segments
    ["https://gitlab.example.com/team/repo", "team/repo"],
    ["https://bitbucket.org/Team/Thing.git", "team/thing"],
    ["https://gitlab.example.com/org/group/subgroup/project.git", "subgroup/project"],
    // uppercase -> lowercase (including an uppercase .GIT suffix)
    ["GIT@GitHub.com:OWNER/NAME.GIT", "owner/name"],
    // garbage -> null
    ["", null],
    ["   ", null],
    ["not-a-url", null],
    ["https://", null],
    ["https://host-only", null],
    ["owner name/repo name", null], // spaces fail the slug charset
    ["C:\\Users\\m\\repo", null], // a Windows path is not a remote
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeRepoSlug(input), expected, `normalizeRepoSlug(${JSON.stringify(input)})`);
  }
  assert.equal(normalizeRepoSlug(null), null);
  assert.equal(normalizeRepoSlug(undefined), null);
});

// ---- orgRepoFor (pure — THE gating decision) --------------------------------------------------

test("orgRepoFor: repo names reach the wire ONLY when enrolled AND a valid slug resolved", () => {
  // Not enrolled -> never a repo name, even with a perfectly good slug in hand.
  assert.equal(orgRepoFor(false, "owner/name"), undefined);
  // Enrolled but no slug (no git, no remote, no cwd) -> no key.
  assert.equal(orgRepoFor(true, null), undefined);
  assert.equal(orgRepoFor(true, undefined), undefined);
  assert.equal(orgRepoFor(true, ""), undefined);
  // Enrolled + valid slug -> the slug, lowercased.
  assert.equal(orgRepoFor(true, "owner/name"), "owner/name");
  assert.equal(orgRepoFor(true, "Owner/Name"), "owner/name");
  // Enrolled + slug that fails the server's regex -> dropped client-side.
  assert.equal(orgRepoFor(true, "not a slug"), undefined);
  assert.equal(orgRepoFor(true, "too/many/segments"), undefined);
});

// ---- repoSlugForCwd (never throws) ------------------------------------------------------------

test("repoSlugForCwd: missing cwd / missing dir resolve to null; the cache is authoritative", () => {
  assert.equal(repoSlugForCwd(undefined, new Map()), null);
  const cache = new Map<string, string | null>();
  assert.equal(repoSlugForCwd(join(tmpdir(), "df-definitely-does-not-exist-xyz"), cache), null);
  // Negative result is cached (one spawn per distinct cwd per process run).
  assert.equal(cache.get(join(tmpdir(), "df-definitely-does-not-exist-xyz")), null);
  // A pre-seeded cache short-circuits git entirely.
  const seeded = new Map<string, string | null>([["/fake/dir", "owner/name"]]);
  assert.equal(repoSlugForCwd("/fake/dir", seeded), "owner/name");
});

// ---- refreshOrgContext ------------------------------------------------------------------------

function stateWith(org?: TrackerState["org"]): TrackerState {
  return {
    apiBase: "http://mock.invalid/api",
    deviceToken: "tok",
    uid: null,
    handle: null,
    repoHmacKey: "k".repeat(64),
    cursors: {},
    threadDigests: {},
    org,
    orgStamp: "none",
    parserEpoch: PARSER_EPOCH,
    lastSyncAt: 0,
    gapMs: 5 * 60 * 1000,
  };
}

function withFetch(t: { after: (fn: () => void) => void }, impl: typeof fetch): void {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => {
    globalThis.fetch = orig;
  });
}

test("refreshOrgContext: a fresh cache is used without any network call", async (t) => {
  withFetch(t, (async () => {
    throw new Error("must not fetch");
  }) as typeof fetch);
  const now = Date.now();
  const state = stateWith({ enrolled: true, orgId: "org1", teamId: null, orgLabel: "Acme", checkedAt: now - 1000 });
  const a = await refreshOrgContext(state, now);
  assert.equal(a.confirmed, true);
  assert.equal(a.ctx.enrolled, true);
  assert.equal(a.ctx.orgLabel, "Acme");
});

test("refreshOrgContext: a not_enrolled answer OVERWRITES a stale enrolled cache", async (t) => {
  withFetch(t, (async () => ({ ok: true, status: 200, json: async () => ({ enrolled: false }) })) as unknown as typeof fetch);
  const now = Date.now();
  const state = stateWith({ enrolled: true, orgId: "org1", teamId: null, orgLabel: "Acme", checkedAt: now - ORG_CONTEXT_TTL_MS - 1 });
  const a = await refreshOrgContext(state, now);
  assert.equal(a.confirmed, true);
  assert.equal(a.ctx.enrolled, false);
  assert.equal(state.org?.enrolled, false, "stale enrolled cache must be overwritten");
});

test("refreshOrgContext: a 401 (revoked) answer overwrites a stale enrolled cache", async (t) => {
  withFetch(t, (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch);
  const now = Date.now();
  const state = stateWith({ enrolled: true, orgId: "org1", teamId: null, orgLabel: "Acme", checkedAt: now - ORG_CONTEXT_TTL_MS - 1 });
  const a = await refreshOrgContext(state, now);
  assert.equal(a.confirmed, true);
  assert.equal(a.ctx.enrolled, false);
  assert.equal(state.org?.enrolled, false);
});

test("refreshOrgContext: network error FAILS CLOSED (not enrolled) and keeps the stale cache on disk", async (t) => {
  withFetch(t, (async () => {
    throw new Error("network down");
  }) as typeof fetch);
  const now = Date.now();
  const stale = { enrolled: true, orgId: "org1", teamId: null, orgLabel: "Acme", checkedAt: now - ORG_CONTEXT_TTL_MS - 1 };
  const state = stateWith({ ...stale });
  const a = await refreshOrgContext(state, now);
  assert.equal(a.confirmed, false);
  assert.equal(a.ctx.enrolled, false, "fail closed: no confirmed answer means NOT enrolled");
  assert.deepEqual(state.org, stale, "a transient outage must not wipe the cache");
});

test("refreshOrgContext: no cache + non-200 fails closed", async (t) => {
  withFetch(t, (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch);
  const state = stateWith(undefined);
  const a = await refreshOrgContext(state, Date.now());
  assert.equal(a.confirmed, false);
  assert.equal(a.ctx.enrolled, false);
  assert.equal(state.org, undefined);
});

test("refreshOrgContext: an enrolled answer populates and caches the full context", async (t) => {
  withFetch(t, (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ enrolled: true, orgId: "org9", teamId: "team3", orgLabel: "Deploy Forward" }),
  })) as unknown as typeof fetch);
  const now = Date.now();
  const state = stateWith(undefined);
  const a = await refreshOrgContext(state, now);
  assert.equal(a.confirmed, true);
  assert.deepEqual(a.ctx, { enrolled: true, orgId: "org9", teamId: "team3", orgLabel: "Deploy Forward", checkedAt: now });
  assert.deepEqual(state.org, a.ctx);
});

// ---- D14 C9: pendingJoinRequests (device/context's S11 CLI extension) -------------------------

test("refreshOrgContext: pendingJoinRequests in the server answer populates ctx.pendingRequests", async (t) => {
  const pending = [{ orgId: "org1", orgLabel: "Acme", slug: "acme", status: "pending", expiresAt: 123 }];
  withFetch(t, (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ enrolled: false, pendingJoinRequests: pending }),
  })) as unknown as typeof fetch);
  const now = Date.now();
  const state = stateWith(undefined);
  const a = await refreshOrgContext(state, now);
  assert.deepEqual(a.ctx.pendingRequests, pending);
});

test("refreshOrgContext: a malformed pendingJoinRequests entry is dropped, well-formed siblings survive", async (t) => {
  withFetch(t, (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      enrolled: false,
      pendingJoinRequests: [{ orgId: "org1", orgLabel: "Acme", slug: "acme", status: "pending", expiresAt: 1 }, { orgId: "bad" }, null],
    }),
  })) as unknown as typeof fetch);
  const a = await refreshOrgContext(stateWith(undefined), Date.now());
  assert.deepEqual(a.ctx.pendingRequests, [{ orgId: "org1", orgLabel: "Acme", slug: "acme", status: "pending", expiresAt: 1 }]);
});

test("refreshOrgContext: pendingJoinRequests ABSENT from the server answer means the key stays absent (never a fabricated [])", async (t) => {
  withFetch(t, (async () => ({ ok: true, status: 200, json: async () => ({ enrolled: false }) })) as unknown as typeof fetch);
  const a = await refreshOrgContext(stateWith(undefined), Date.now());
  assert.ok(!("pendingRequests" in a.ctx), "no key at all when the server didn't send the field");
});

// ---- syncOnce integration: the enrollment digest cycle ----------------------------------------

const gitAvailable = (() => {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true }).status === 0;
  } catch {
    return false;
  }
})();

test("syncOnce: enroll -> re-upload WITH orgRepo; un-enroll -> re-upload WITHOUT it", { skip: !gitAvailable && "git not available" }, async (t) => {
  // A real repo whose origin resolves to a known slug.
  const repo = mkdtempSync(join(tmpdir(), "df-org-repo-"));
  spawnSync("git", ["-C", repo, "init"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  spawnSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/Test-Owner/Test-Repo.git"], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });

  const home = mkdtempSync(join(tmpdir(), "df-org-home-"));
  const projects = mkdtempSync(join(tmpdir(), "df-org-projects-"));
  const proj = join(projects, "proj1");
  mkdirSync(proj, { recursive: true });
  // One session whose entries carry the repo's cwd as transcript METADATA.
  const withCwd = (line: string): string => JSON.stringify({ ...JSON.parse(line), cwd: repo });
  writeFileSync(
    join(proj, "s-org.jsonl"),
    [
      withCwd(claudeLine({ sessionId: "s-org", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 })),
      withCwd(claudeLine({ sessionId: "s-org", ts: "2026-06-01T10:01:00.000Z", msgId: "m2", reqId: "r2", model: "claude-opus-4-8", input: 20, output: 10 })),
    ].join("\n"),
  );

  // One Codex rollout in the SAME repo (session_meta.payload.cwd). Codex must ride the
  // same enrollment flips as Claude even though a rollout file never changes bytes —
  // pre-0.11.5 the cursor skip made Codex sessions PERMANENTLY unattributable (the
  // /org "unattributed usage" bucket was mostly this).
  const codexRoot = mkdtempSync(join(tmpdir(), "df-org-codex-"));
  const codexDay = join(codexRoot, "2026", "06", "01");
  mkdirSync(codexDay, { recursive: true });
  writeFileSync(
    join(codexDay, "rollout-2026-06-01T10-00-00-000Z-sess-oc.jsonl"),
    [
      JSON.stringify({ timestamp: "2026-06-01T10:00:00.000Z", type: "session_meta", payload: { id: "sess-oc", cwd: repo } }),
      JSON.stringify({ timestamp: "2026-06-01T10:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.5-codex" } }),
      JSON.stringify({ timestamp: "2026-06-01T10:00:02.000Z", type: "event_msg", payload: { type: "user_message" } }),
      JSON.stringify({
        timestamp: "2026-06-01T10:00:05.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 120 } } },
      }),
    ].join("\n"),
  );

  const statePath = join(home, "state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      apiBase: "http://mock.invalid/api",
      deviceToken: "test-token",
      uid: null,
      handle: null,
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
    }),
  );

  const prevEnv = {
    DF_HOME: process.env.DF_HOME,
    DF_CLAUDE_PROJECTS: process.env.DF_CLAUDE_PROJECTS,
    DF_CODEX_SESSIONS: process.env.DF_CODEX_SESSIONS,
    DF_GROK_HOME: process.env.DF_GROK_HOME,
    DF_PI_HOME: process.env.DF_PI_HOME,
    DF_OPENCLAW_HOME: process.env.DF_OPENCLAW_HOME,
    DF_OPENCODE_HOME: process.env.DF_OPENCODE_HOME,
    DF_HERMES_HOME: process.env.DF_HERMES_HOME,
    DF_COPILOT_HOME: process.env.DF_COPILOT_HOME,
    DF_GEMINI_HOME: process.env.DF_GEMINI_HOME,
  };
  process.env.DF_HOME = home;
  process.env.DF_CLAUDE_PROJECTS = projects;
  process.env.DF_CODEX_SESSIONS = codexRoot;
  // Hermetic: without these, syncOnce would fingerprint the REAL ~/.grok (0.10.0
  // lesson) — or the real ~/.pi etc. — on a dev machine and fold its live corpus into
  // the fixture pass. Proven again the day pi was installed on the corpus machine:
  // this test read 5 uploads where the fixture promises 2. EVERY provider home an
  // adapter can discover must be pinned here the day that adapter ships.
  process.env.DF_GROK_HOME = join(projects, "no-grok-here");
  process.env.DF_PI_HOME = join(projects, "no-pi-here");
  process.env.DF_OPENCLAW_HOME = join(projects, "no-openclaw-here");
  process.env.DF_OPENCODE_HOME = join(projects, "no-opencode-here");
  process.env.DF_HERMES_HOME = join(projects, "no-hermes-here");
  process.env.DF_COPILOT_HOME = join(projects, "no-copilot-here");
  process.env.DF_GEMINI_HOME = join(projects, "no-gemini-here");

  let contextAnswer: unknown = { enrolled: false };
  const ingests: { sessions: any[] }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).endsWith("/device/context")) {
      return { ok: true, status: 200, json: async () => contextAnswer };
    }
    const body = JSON.parse(init.body);
    ingests.push(body);
    return { ok: true, status: 200, json: async () => ({ accepted: body.sessions.length, flagged: 0 }) };
  }) as any;
  t.after(() => {
    globalThis.fetch = origFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k as keyof typeof prevEnv];
      else process.env[k] = v;
    }
  });

  // The context cache is fresh for 6h after each pass; age it so the next pass re-asks.
  const ageOrgCache = (): void => {
    const s = JSON.parse(readFileSync(statePath, "utf8"));
    if (s.org) s.org.checkedAt = Date.now() - ORG_CONTEXT_TTL_MS - 1;
    writeFileSync(statePath, JSON.stringify(s));
  };

  // Wire helpers: one upload pass can span multiple ingest POSTs; flatten + index by id.
  const sessionsOf = (ingest: { sessions: any[] }): Map<string, any> =>
    new Map(ingest.sessions.map((s: any) => [s.toolSessionId, s]));

  // Pass 1 (NOT enrolled): BOTH sessions upload (new threads) with NO orgRepo key on
  // the wire — the privacy boundary, even though the slug is derivable locally.
  assert.equal(await syncOnce(), 2);
  assert.equal(ingests.length, 1);
  const p1 = sessionsOf(ingests[0]);
  assert.equal("orgRepo" in p1.get("s-org")!, false, "non-enrolled Claude payload must not carry orgRepo");
  assert.equal("orgRepo" in p1.get("sess-oc")!, false, "non-enrolled Codex payload must not carry orgRepo");

  // Pass 2 (still not enrolled, nothing changed): no upload.
  assert.equal(await syncOnce(), 0);
  assert.equal(ingests.length, 1);

  // Enroll. Pass 3: every file is BYTE-IDENTICAL, but the confirmed enrollment flip
  // changes the upload digests (orgRepo joins the payloads), so BOTH sessions
  // re-upload WITH attribution — the Codex rollout included (0.11.5; its cursor skip
  // previously made this impossible).
  contextAnswer = { enrolled: true, orgId: "org1", teamId: "team1", orgLabel: "Acme" };
  ageOrgCache();
  assert.equal(await syncOnce(), 2);
  assert.equal(ingests.length, 2);
  const p3 = sessionsOf(ingests[1]);
  assert.equal(p3.get("s-org")!.orgRepo, "test-owner/test-repo");
  assert.equal(p3.get("sess-oc")!.orgRepo, "test-owner/test-repo", "Codex attributes from session_meta cwd");

  // Pass 4 (enrolled steady state): digests now include orgRepo — nothing re-uploads.
  assert.equal(await syncOnce(), 0);
  assert.equal(ingests.length, 2);

  // Un-enroll (revocation). Pass 5: the confirmed flip re-uploads BOTH without the key.
  contextAnswer = { enrolled: false };
  ageOrgCache();
  assert.equal(await syncOnce(), 2);
  assert.equal(ingests.length, 3);
  const p5 = sessionsOf(ingests[2]);
  assert.equal("orgRepo" in p5.get("s-org")!, false, "revoked device must stop attributing");
  assert.equal("orgRepo" in p5.get("sess-oc")!, false, "revoked Codex must stop attributing too");
});
