/**
 * L22 PART A — headless auth via DF_DEVICE_TOKEN (test-first; a different agent implements).
 *
 * The payoff: a box with no browser and no TTY (EC2 over SSH, CI, a container, an agent
 * host) runs the tracker and syncs spend authed ONLY by an env var. Twelve-factor: the
 * box is controlled by its environment, so DF_DEVICE_TOKEN WINS over any on-disk token,
 * and — critically — the env token is NEVER written to disk by the read path (a headless
 * box may be read-only or ephemeral; its env is the source of truth, not a state file).
 *
 * THE SEAM (does not exist yet — this is the intentional red): src/config.ts's loadState()
 * must consume process.env.DF_DEVICE_TOKEN. Today it reads only state.json's deviceToken
 * (parsed.deviceToken ?? null) and ignores the env entirely, so every assertion below
 * fails red for the right reason:
 *   - loadState() returns the env token as state.deviceToken when the env var is set;
 *   - a set env token wins over a different on-disk token;
 *   - a GARBAGE env token is rejected with a one-line stderr note and treated as unauthed
 *     (deviceToken === null), never crashing;
 *   - the read path never creates or mutates state.json to persist the env token; and
 *   - end-to-end, `syncOnce` (which DOES persist cursors/digests at the end of a pass)
 *     authenticates with the env token, uploads with a `Bearer <envToken>` header, and
 *     still leaves the on-disk deviceToken untouched (null) while installing no hooks.
 *
 * Hermetic: DF_HOME + every provider home is pinned to temp dirs, and the pair/ingest/
 * context HTTP is mocked on globalThis.fetch — no real API, no real home is ever read.
 *
 * Run: npx tsx --test test/deviceTokenEnv.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLine } from "./fixtures.ts";
import { PARSER_EPOCH, loadState } from "../src/config.ts";

// A realistically-shaped device token: the server mints `df_` + base64url(32 bytes) — a
// 43-char base64url tail (functions/src/pairing.ts, functions/src/githubDevice.ts).
const validToken = (tail: string): string => "df_" + tail.padEnd(43, "0").slice(0, 43);
const ENV_TOKEN = validToken("envenvenvenvenvenvenvenvenvenvenvenvenvAAAA");
const DISK_TOKEN = validToken("diskdiskdiskdiskdiskdiskdiskdiskdiskdiskBBB");

// ---- env plumbing (mirror syncOnce.test.ts / superStartOnboarding.test.ts) --------------------

const PROVIDER_HOME_KEYS = [
  "DF_CLAUDE_PROJECTS",
  "DF_CODEX_SESSIONS",
  "DF_GROK_HOME",
  "DF_PI_HOME",
  "DF_OPENCLAW_HOME",
  "DF_OPENCODE_HOME",
  "DF_HERMES_HOME",
  "DF_COPILOT_HOME",
  // Added when this branch merged main (2026-07-28): the Gemini adapter landed after this
  // test was written, and an UNPINNED provider home is not an inert omission — it makes the
  // test read the developer's REAL ~/.gemini, which is how this failed (n=2: one seeded
  // session plus one real one). Every entry added to a provider-site list in src/ must be
  // added here in the same change, or this suite silently stops being hermetic.
  "DF_GEMINI_HOME",
] as const;

/** Pin DF_HOME, DF_DEVICE_TOKEN, DF_CLAUDE_SETTINGS and every provider home; capture the
 * prior values so the test restores the process env exactly. Provider homes point at
 * nonexistent dirs so no real ~/.claude, ~/.codex, ~/.grok … is ever fingerprinted. */
function pinEnv(opts: {
  home: string;
  deviceToken?: string;
  claudeProjects?: string;
  claudeSettings?: string;
}): Record<string, string | undefined> {
  const prev: Record<string, string | undefined> = {};
  const set = (k: string, v: string | undefined): void => {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  set("DF_HOME", opts.home);
  set("DF_DEVICE_TOKEN", opts.deviceToken);
  set("DF_CLAUDE_SETTINGS", opts.claudeSettings ?? join(opts.home, "no-settings.json"));
  for (const k of PROVIDER_HOME_KEYS) {
    if (k === "DF_CLAUDE_PROJECTS" && opts.claudeProjects) set(k, opts.claudeProjects);
    else set(k, join(opts.home, `absent-${k}`));
  }
  return prev;
}

function restoreEnv(prev: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function writeState(home: string, extra: Record<string, unknown>): void {
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://mock.invalid/api",
      deviceToken: null,
      uid: null,
      handle: null,
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
      ...extra,
    }),
  );
}

// ---- PART A: loadState() env consumption --------------------------------------------------------

test("loadState: DF_DEVICE_TOKEN is the effective deviceToken when there is no on-disk token", () => {
  const home = mkdtempSync(join(tmpdir(), "df-env-notoken-"));
  const prev = pinEnv({ home, deviceToken: ENV_TOKEN });
  try {
    // No state.json at all — a fresh, ephemeral box that only carries the env var.
    const state = loadState();
    assert.equal(state.deviceToken, ENV_TOKEN, "the env token authenticates a box with no state file");
    // uid is display-only locally; ingest authenticates by token, so an absent uid is fine.
    assert.equal(state.uid, null, "an absent uid is not an error under DF_DEVICE_TOKEN");
    // repoHmacKey is a local dedup key — generated locally as today, never required from disk.
    assert.equal(typeof state.repoHmacKey, "string");
    assert.ok(state.repoHmacKey.length > 0, "a per-box HMAC key is generated locally when absent");
    assert.equal(existsSync(join(home, "state.json")), false, "reading the env token must not create a state file");
  } finally {
    restoreEnv(prev);
  }
});

test("loadState: a set DF_DEVICE_TOKEN WINS over a different on-disk token (twelve-factor)", () => {
  const home = mkdtempSync(join(tmpdir(), "df-env-wins-"));
  writeState(home, { deviceToken: DISK_TOKEN, uid: "u-disk", handle: "diskuser" });
  const prev = pinEnv({ home, deviceToken: ENV_TOKEN });
  try {
    const state = loadState();
    assert.equal(state.deviceToken, ENV_TOKEN, "the env token overrides the on-disk token");
    assert.notEqual(state.deviceToken, DISK_TOKEN, "the on-disk token is not what authenticates when the env is set");
  } finally {
    restoreEnv(prev);
  }
});

test("loadState: a GARBAGE DF_DEVICE_TOKEN is rejected — unauthed (null), a one-line stderr note, no crash", () => {
  const home = mkdtempSync(join(tmpdir(), "df-env-garbage-"));
  const prev = pinEnv({ home, deviceToken: "$$ not a real token $$" });
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origConsoleError = console.error;
  const noise: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    noise.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  console.error = (...args: unknown[]) => {
    noise.push(args.map(String).join(" "));
  };
  try {
    let state: ReturnType<typeof loadState>;
    assert.doesNotThrow(() => {
      state = loadState();
    }, "a garbage env token must never crash loadState");
    // treat-as-unauthed: the garbage token is NOT accepted as the device token.
    assert.equal(state!.deviceToken, null, "a garbage env token is treated as unauthed, not accepted verbatim");
    const printed = noise.join("\n");
    assert.match(printed, /DF_DEVICE_TOKEN/, "a clear stderr note names the offending env var");
  } finally {
    process.stderr.write = origErrWrite;
    console.error = origConsoleError;
    restoreEnv(prev);
  }
});

test("loadState: the env token is never written to disk by the read path", () => {
  const home = mkdtempSync(join(tmpdir(), "df-env-nowrite-"));
  // A state file that carries NO token but does carry a distinctive marker cursor, so a
  // byte-for-byte comparison proves the read neither persisted the env token nor rewrote
  // the file at all.
  writeState(home, { cursors: { "/marker/path.jsonl": { byteOffset: 7 } } });
  const before = readFileSync(join(home, "state.json"), "utf8");
  const prev = pinEnv({ home, deviceToken: ENV_TOKEN });
  try {
    const state = loadState();
    assert.equal(state.deviceToken, ENV_TOKEN, "the env token is still the effective token");
    const after = readFileSync(join(home, "state.json"), "utf8");
    assert.equal(after, before, "loadState() must not rewrite state.json to persist the env token");
    assert.equal(after.includes(ENV_TOKEN), false, "the env token must never appear on disk");
  } finally {
    restoreEnv(prev);
  }
});

// ---- PART A payoff: headless `sync` authenticates via env, persists no token, installs nothing --

test("headless sync: DF_DEVICE_TOKEN + non-TTY authenticates and uploads with no browser, and never persists the token or installs hooks", async (t) => {
  // A different agent adds the loadState() env handling; this proves the end-to-end payoff
  // through syncOnce, which DOES saveState() (cursors/digests/lastSyncAt) at the end of a
  // pass — the exact place a naive impl would leak the env token onto disk.
  const { syncOnce } = await import("../src/sync.ts");
  const { hooksInstalled } = await import("../src/hooks.ts");

  const home = mkdtempSync(join(tmpdir(), "df-headless-home-"));
  const projects = mkdtempSync(join(tmpdir(), "df-headless-projects-"));
  const proj = join(projects, "proj1");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "s-head.jsonl"),
    claudeLine({ sessionId: "s-head", ts: "2026-07-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
  );
  // The on-disk token is explicitly NULL, so ONLY the env token can authenticate this pass.
  writeState(home, { deviceToken: null });

  const prev = pinEnv({ home, deviceToken: ENV_TOKEN, claudeProjects: projects });

  const ingestCalls: { auth: unknown; sessions: unknown[] }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: any) => {
    const u = String(url);
    if (u.endsWith("/ingest")) {
      const body = JSON.parse(init.body);
      ingestCalls.push({ auth: init.headers.authorization, sessions: body.sessions });
      return { ok: true, json: async () => ({ accepted: body.sessions.length, flagged: 0 }) };
    }
    // Any other endpoint (org/device context): fail closed to "not enrolled" with an
    // empty body — never a browser, never a pairing round-trip on a headless sync.
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;

  t.after(() => {
    globalThis.fetch = origFetch;
    restoreEnv(prev);
  });

  const n = await syncOnce({ verbose: false });

  assert.equal(n, 1, "the one seeded session uploads — the pass is authed purely by the env token");
  assert.equal(ingestCalls.length, 1, "exactly one ingest POST, no browser and no pairing call");
  assert.equal(ingestCalls[0].auth, `Bearer ${ENV_TOKEN}`, "the ingest request carries the env token as the bearer credential");

  // The security lynchpin: syncOnce persisted its cursors/digests, but the env token must
  // NOT have ridden along onto disk (the box's env stays the sole source of truth).
  const persisted = JSON.parse(readFileSync(join(home, "state.json"), "utf8")) as { deviceToken: unknown };
  assert.equal(persisted.deviceToken, null, "a headless pass must never write the env token into state.json");
  assert.equal(readFileSync(join(home, "state.json"), "utf8").includes(ENV_TOKEN), false, "the env token appears nowhere on disk after a sync");

  // A server run records cleanly and installs nothing it should not.
  assert.equal(hooksInstalled(), false, "a headless sync installs no Claude Code hooks");
});
