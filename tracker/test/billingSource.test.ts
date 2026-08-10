/**
 * L18 (OPEN half) — Claude Code billing-source detection + silent-flip warning.
 * TEST AUTHOR pass only: this file pins the contract of a module that does NOT
 * exist yet (src/billingSource.ts) — it is an intentional RED. A code author
 * follows and makes it green; the wiring (config.ts state, superStart local
 * view, ui.ts warning, HOOKS.md/README.md docs) is theirs, not pinned here.
 *
 * WHY THIS EXISTS (verified at code.claude.com/docs/en/authentication.md):
 * Claude Code's auth precedence puts ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
 * ABOVE the subscription OAuth login. A stray API key therefore silently
 * converts subscription work into metered API billing (a founder was billed
 * $2,200 in 12 days). We detect the source and WARN on a silent flip to the
 * metered path.
 *
 * THE PRIVACY INVARIANT (load-bearing, the deliberate inverse of the CCgather
 * anti-pattern): we read PRESENCE and TYPE ONLY. We NEVER read, parse, log,
 * hash, upload, or store the CONTENTS of ~/.claude/.credentials.json or the
 * VALUE of any API-key env var. Three things are observed, nothing more:
 *   (1) whether ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN /
 *       CLAUDE_CODE_OAUTH_TOKEN are PRESENT (a non-empty string), never the
 *       value;
 *   (2) whether ~/.claude/.credentials.json EXISTS (existsSync/statSync only —
 *       NEVER readFile);
 *   (3) the cloud-provider flags CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY
 *       (presence).
 *
 * The module has three seams:
 *   - resolveBillingSource(env, hasSubscriptionLogin): BillingSource — the PURE
 *     core; takes presence booleans as inputs (no fs, no env) so it is
 *     hermetically testable. Precedence MIRRORS the doc exactly:
 *       cloud (any use* flag) > bearer (authToken) > api_key (apiKey)
 *       > (oauthToken OR hasSubscriptionLogin ? subscription : unknown).
 *   - detectFlip(prev, current): the flip classifier; 'to_api_key' is the
 *     costly subscription -> api_key case.
 *   - collectBillingEnv(homeDir, env): the ONLY impure seam — reads env
 *     presence + fs.existsSync of the credentials path, returns the booleans.
 *     Hermetic by construction: homeDir + env are injected.
 *
 * Run: npx tsx --test test/billingSource.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Direct import of the not-yet-existing module: an intentional RED. Until the
// code author creates src/billingSource.ts this file fails to load (right
// reason); node --test isolates per file, so it never takes out any other suite.
import {
  resolveBillingSource,
  detectFlip,
  collectBillingEnv,
  type BillingSource,
} from "../src/billingSource.ts";

// ============================================================================================
// helpers
// ============================================================================================

/** The 6 presence booleans resolveBillingSource consumes, all false unless overridden. */
function flags(
  over: Partial<{
    apiKey: boolean;
    authToken: boolean;
    oauthToken: boolean;
    useBedrock: boolean;
    useVertex: boolean;
    useFoundry: boolean;
  }> = {},
): {
  apiKey: boolean;
  authToken: boolean;
  oauthToken: boolean;
  useBedrock: boolean;
  useVertex: boolean;
  useFoundry: boolean;
} {
  return { apiKey: false, authToken: false, oauthToken: false, useBedrock: false, useVertex: false, useFoundry: false, ...over };
}

// ============================================================================================
// 1. resolveBillingSource — precedence MIRRORS the doc's auth order, rung by rung
// ============================================================================================

test("resolveBillingSource: a cloud flag (useBedrock) alone -> 'cloud' (top of the precedence)", () => {
  assert.equal(resolveBillingSource(flags({ useBedrock: true }), false), "cloud");
});

test("resolveBillingSource: useVertex alone -> 'cloud'", () => {
  assert.equal(resolveBillingSource(flags({ useVertex: true }), false), "cloud");
});

test("resolveBillingSource: useFoundry alone -> 'cloud'", () => {
  assert.equal(resolveBillingSource(flags({ useFoundry: true }), false), "cloud");
});

test("resolveBillingSource: a cloud flag OUTRANKS an auth token, an api key, and a subscription all at once (cloud is the ceiling)", () => {
  assert.equal(
    resolveBillingSource(flags({ useBedrock: true, authToken: true, apiKey: true, oauthToken: true }), true),
    "cloud",
    "any use* flag wins over everything below it in the doc order",
  );
});

test("resolveBillingSource: authToken with NO cloud flag -> 'bearer' (second rung)", () => {
  assert.equal(resolveBillingSource(flags({ authToken: true }), false), "bearer");
});

test("resolveBillingSource: authToken OUTRANKS an api key and a subscription (bearer beats api_key)", () => {
  assert.equal(
    resolveBillingSource(flags({ authToken: true, apiKey: true, oauthToken: true }), true),
    "bearer",
    "ANTHROPIC_AUTH_TOKEN sits above ANTHROPIC_API_KEY in the doc order",
  );
});

test("resolveBillingSource: apiKey with NO cloud/bearer -> 'api_key' (third rung)", () => {
  assert.equal(resolveBillingSource(flags({ apiKey: true }), false), "api_key");
});

test("resolveBillingSource: oauthToken only -> 'subscription' (the OAuth token IS a subscription token per the doc)", () => {
  assert.equal(resolveBillingSource(flags({ oauthToken: true }), false), "subscription");
});

test("resolveBillingSource: hasSubscriptionLogin only (credentials file present, no env at all) -> 'subscription'", () => {
  assert.equal(resolveBillingSource(flags(), true), "subscription");
});

test("resolveBillingSource: nothing present at all -> 'unknown' (never a false 'subscription')", () => {
  assert.equal(resolveBillingSource(flags(), false), "unknown");
});

test("resolveBillingSource: THE COSTLY COMBO — apiKey set AND a subscription login present -> 'api_key' (the key WINS, which is the whole point)", () => {
  assert.equal(
    resolveBillingSource(flags({ apiKey: true }), true),
    "api_key",
    "a present ANTHROPIC_API_KEY silently overrides the subscription -> billing is metered, not subscription",
  );
});

test("resolveBillingSource: bearer also wins over a present subscription login (the metered bearer path, not subscription)", () => {
  assert.equal(resolveBillingSource(flags({ authToken: true }), true), "bearer");
});

// ============================================================================================
// 2. detectFlip — flip classification (to_api_key is the costly case)
// ============================================================================================

test("detectFlip: subscription -> api_key is FLIPPED and classified 'to_api_key' (the costly, warn-worthy case)", () => {
  assert.deepEqual(detectFlip("subscription", "api_key"), { flipped: true, kind: "to_api_key" });
});

test("detectFlip: api_key -> subscription is FLIPPED but classified 'other_change' (reverting is not the costly direction)", () => {
  assert.deepEqual(detectFlip("api_key", "subscription"), { flipped: true, kind: "other_change" });
});

test("detectFlip: subscription -> subscription (unchanged) -> not flipped, kind 'none'", () => {
  assert.deepEqual(detectFlip("subscription", "subscription"), { flipped: false, kind: "none" });
});

test("detectFlip: null -> api_key (first-seen) -> not flipped, kind 'none' (no prior baseline to have flipped from)", () => {
  assert.deepEqual(detectFlip(null, "api_key"), { flipped: false, kind: "none" });
});

test("detectFlip: a non-costly change (subscription -> cloud) is flipped/'other_change', NOT 'to_api_key'", () => {
  assert.deepEqual(detectFlip("subscription", "cloud"), { flipped: true, kind: "other_change" });
});

test("detectFlip: 'to_api_key' is reserved for a SUBSCRIPTION origin — unknown -> api_key is only 'other_change'", () => {
  // Only the subscription -> api_key transition is the silent-metering case worth the loud warning.
  assert.deepEqual(detectFlip("unknown", "api_key"), { flipped: true, kind: "other_change" });
});

test("detectFlip: any unchanged pair is 'none' regardless of which source (never a spurious flip)", () => {
  for (const s of ["subscription", "api_key", "bearer", "cloud", "unknown"] as BillingSource[]) {
    assert.deepEqual(detectFlip(s, s), { flipped: false, kind: "none" }, `${s} -> ${s} must be a no-op`);
  }
});

// ============================================================================================
// 3. collectBillingEnv — the ONLY impure seam. HERMETIC by injection (homeDir + env),
//    presence-only, stat-only (never opens the credential).
// ============================================================================================

/** A fixture home with a .claude/ dir; optionally drops a ZERO-BYTE .credentials.json
 * (touch semantics — even if someone tried to read its contents there is nothing to read). */
function fixtureHome(opts: { withCreds?: boolean } = {}): string {
  const home = mkdtempSync(join(tmpdir(), "df-billingsource-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  if (opts.withCreds) writeFileSync(join(home, ".claude", ".credentials.json"), ""); // zero bytes on purpose
  return home;
}

test("collectBillingEnv: a ZERO-BYTE .credentials.json is enough for hasSubscriptionLogin=true (presence, not contents)", () => {
  const home = fixtureHome({ withCreds: true });
  const got = collectBillingEnv(home, {});
  assert.equal(got.hasSubscriptionLogin, true, "the file existing is the whole signal -- its (empty) contents are never read");
});

test("collectBillingEnv: no credentials file -> hasSubscriptionLogin=false", () => {
  const home = fixtureHome({ withCreds: false });
  assert.equal(collectBillingEnv(home, {}).hasSubscriptionLogin, false);
});

test("collectBillingEnv: reads the six env presence booleans from the INJECTED env, never process.env", () => {
  const home = fixtureHome();
  const got = collectBillingEnv(home, {
    ANTHROPIC_API_KEY: "sk-ant-doesnotmatter",
    ANTHROPIC_AUTH_TOKEN: "bearer-doesnotmatter",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-doesnotmatter",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "true",
    CLAUDE_CODE_USE_FOUNDRY: "yes",
  });
  assert.equal(got.apiKey, true);
  assert.equal(got.authToken, true);
  assert.equal(got.oauthToken, true);
  assert.equal(got.useBedrock, true);
  assert.equal(got.useVertex, true);
  assert.equal(got.useFoundry, true);
});

test("collectBillingEnv: an EMPTY-STRING env var counts as ABSENT (presence requires a non-empty string, never just 'defined')", () => {
  const home = fixtureHome();
  const got = collectBillingEnv(home, {
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    CLAUDE_CODE_USE_BEDROCK: "",
  });
  assert.equal(got.apiKey, false, "an empty ANTHROPIC_API_KEY is not a present key");
  assert.equal(got.authToken, false);
  assert.equal(got.oauthToken, false);
  assert.equal(got.useBedrock, false);
});

test("collectBillingEnv: an absent env var (key not on the object at all) -> false", () => {
  const home = fixtureHome();
  const got = collectBillingEnv(home, {}); // nothing set
  assert.equal(got.apiKey, false);
  assert.equal(got.authToken, false);
  assert.equal(got.oauthToken, false);
  assert.equal(got.useBedrock, false);
  assert.equal(got.useVertex, false);
  assert.equal(got.useFoundry, false);
});

test("collectBillingEnv: STAT-ONLY proof — a zero-byte credentials file is handled without throwing (a contents read would have nothing but must never even be attempted)", () => {
  const home = fixtureHome({ withCreds: true });
  assert.doesNotThrow(() => collectBillingEnv(home, {}));
});

test("collectBillingEnv: STAT-ONLY proof — a DIRECTORY at the credentials path does not throw (readFile of a dir would EISDIR; only existsSync/statSync survive this)", () => {
  // The strongest available structural assertion that the collector only STATS: point the
  // credentials path at a directory. fs.existsSync / statSync succeed on a directory; any
  // readFile/open of it throws EISDIR. Surviving this proves the collector never opens it.
  const home = mkdtempSync(join(tmpdir(), "df-billingsource-dirmode-"));
  mkdirSync(join(home, ".claude", ".credentials.json"), { recursive: true }); // a DIRECTORY, not a file
  let got: ReturnType<typeof collectBillingEnv> | undefined;
  assert.doesNotThrow(() => {
    got = collectBillingEnv(home, {});
  });
  assert.equal(typeof got!.hasSubscriptionLogin, "boolean", "returns a clean boolean, never a thrown EISDIR");
});

// ============================================================================================
// 4. End-to-end composition — collectBillingEnv feeds resolveBillingSource (the real path)
// ============================================================================================

/** Bridge helper: split collectBillingEnv's flat result into resolveBillingSource's two args. */
function resolveCollected(c: ReturnType<typeof collectBillingEnv>): BillingSource {
  const { hasSubscriptionLogin, apiKey, authToken, oauthToken, useBedrock, useVertex, useFoundry } = c;
  return resolveBillingSource({ apiKey, authToken, oauthToken, useBedrock, useVertex, useFoundry }, hasSubscriptionLogin);
}

test("collectBillingEnv -> resolveBillingSource: a subscription login and NO env keys resolves to 'subscription'", () => {
  const home = fixtureHome({ withCreds: true });
  assert.equal(resolveCollected(collectBillingEnv(home, {})), "subscription");
});

test("collectBillingEnv -> resolveBillingSource: THE COSTLY FIELD CASE — a subscription login AND a present ANTHROPIC_API_KEY resolves to 'api_key' (metered wins, silently)", () => {
  const home = fixtureHome({ withCreds: true });
  const c = collectBillingEnv(home, { ANTHROPIC_API_KEY: "sk-ant-value-never-read" });
  assert.equal(resolveCollected(c), "api_key", "a real subscription user with a stray key is billed the metered API path");
});

test("collectBillingEnv -> resolveBillingSource: neither a login nor any env key resolves to 'unknown'", () => {
  const home = fixtureHome({ withCreds: false });
  assert.equal(resolveCollected(collectBillingEnv(home, {})), "unknown");
});

// ============================================================================================
// 5. STATIC SOURCE GUARD — the privacy invariant, asserted against the module's own text
// ============================================================================================

test("STATIC GUARD: src/billingSource.ts NEVER reads file contents — no readFile / readFileSync / openSync / .read( anywhere in the module", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "billingSource.ts"), "utf8");
  // Strip line/block comments so a doc-comment mentioning these names for explanation can't
  // trip the guard — only real CODE using a contents-read API must fail this.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const forbidden of ["readFile", "readFileSync", "openSync", "createReadStream", ".read("]) {
    assert.ok(!code.includes(forbidden), `the presence-only detector must never use ${forbidden} — that would open the credential`);
  }
});

test("STATIC GUARD: src/billingSource.ts uses ONLY stat-class fs (existsSync/statSync) to observe the credential, proving presence-only", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "billingSource.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(/existsSync|statSync/.test(code), "the collector must detect the credential by stat, not by opening it");
});
