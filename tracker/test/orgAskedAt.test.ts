/**
 * D14 C3/C9 (docs/d14-two-way-join-spec.md): the org-join onboarding ask-once marker
 * (TrackerState.orgAskedAt + markOrgAsked) and OrgContext.pendingRequests sanitization.
 * Mirrors the existing onboardedAt/markOnboarded and limitsProviders round-trip pins
 * (test/onboardingV2.test.ts, test/onboardingFreshness.test.ts) — same defensive
 * posture, same raw-patch discipline.
 *
 * Run: npx tsx --test test/orgAskedAt.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState, markOrgAsked, PARSER_EPOCH } from "../src/config.ts";

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "df-orgasked-"));
  const prev = process.env.DF_HOME;
  process.env.DF_HOME = home;
  return home;
}

function withHome(fn: (home: string) => void): void {
  const prevHome = process.env.DF_HOME;
  const home = freshHome();
  try {
    fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.DF_HOME;
    else process.env.DF_HOME = prevHome;
  }
}

// ---- orgAskedAt round trip -----------------------------------------------------------

test("orgAskedAt: a fresh state carries no marker", () => {
  withHome(() => {
    assert.equal(loadState().orgAskedAt, undefined);
  });
});

test("orgAskedAt: survives a save/load round trip like onboardedAt", () => {
  withHome(() => {
    const base = loadState();
    saveState({ ...base, orgAskedAt: 12345 });
    assert.equal(loadState().orgAskedAt, 12345);
  });
});

test("orgAskedAt sanitize: only a finite, strictly-positive number survives -- zero/negative/NaN/string are dropped", () => {
  withHome((home) => {
    const base = loadState();
    saveState(base); // establish a well-formed baseline file at the current PARSER_EPOCH
    for (const bad of [0, -5, NaN, Infinity, "12345"]) {
      const raw = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
      raw.orgAskedAt = bad;
      writeFileSync(join(home, "state.json"), JSON.stringify(raw));
      assert.equal(loadState().orgAskedAt, undefined, `orgAskedAt=${JSON.stringify(bad)} must be dropped, not trusted`);
    }
  });
});

test("orgAskedAt: survives a PARSER_EPOCH bump untouched, same as onboardedAt/billingMode (enrollment truth, not parse state)", () => {
  withHome((home) => {
    writeFileSync(
      join(home, "state.json"),
      JSON.stringify({
        apiBase: "http://x/api",
        deviceToken: null,
        uid: null,
        handle: null,
        repoHmacKey: "k".repeat(64),
        cursors: { "/some/file": { byteOffset: 10 } },
        threadDigests: { t1: "abc" },
        orgStamp: "none",
        parserEpoch: PARSER_EPOCH - 1, // stale epoch -- cursors/threadDigests must reset
        lastSyncAt: 0,
        gapMs: 300000,
        orgAskedAt: 999,
      }),
    );
    const state = loadState();
    assert.equal(state.orgAskedAt, 999, "orgAskedAt survives the epoch bump");
    assert.deepEqual(state.cursors, {}, "sanity: parse state (cursors) DOES reset on an epoch bump");
  });
});

// ---- markOrgAsked: raw-patch discipline (exactly one field written) -------------------

test("markOrgAsked: writes exactly orgAskedAt, touching nothing else in the stored file", () => {
  withHome((home) => {
    const base = loadState();
    saveState({ ...base, billingMode: "mix", redact: true });
    const before = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    markOrgAsked(555);
    const after = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    assert.equal(after.orgAskedAt, 555);
    delete after.orgAskedAt;
    assert.deepEqual(after, before, "every OTHER field is untouched by markOrgAsked");
  });
});

test("markOrgAsked: a missing state.json falls back to the full normalized default state, then patches orgAskedAt", () => {
  withHome((home) => {
    markOrgAsked(42);
    const after = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    assert.equal(after.orgAskedAt, 42);
    assert.equal(after.deviceToken, null);
  });
});

// ---- OrgContext.pendingRequests sanitize (config.ts's sanitizeOrg) --------------------

test("OrgContext.pendingRequests: a well-formed array survives a save/load round trip", () => {
  withHome(() => {
    const base = loadState();
    const pendingRequests = [{ orgId: "org1", orgLabel: "Acme", slug: "acme", status: "pending", expiresAt: Date.now() + 86_400_000 }];
    saveState({ ...base, org: { enrolled: false, pendingRequests, checkedAt: Date.now() } });
    const reloaded = loadState();
    assert.deepEqual(reloaded.org?.pendingRequests, pendingRequests);
  });
});

test("OrgContext.pendingRequests: malformed entries are dropped, well-formed siblings survive", () => {
  withHome((home) => {
    const base = loadState();
    saveState({ ...base, org: { enrolled: false, checkedAt: Date.now() } });
    const raw = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    raw.org.pendingRequests = [
      { orgId: "org1", orgLabel: "Acme", slug: "acme", status: "pending", expiresAt: 123 }, // valid
      { orgId: "org2" }, // missing fields -- dropped
      "not-an-object", // dropped
      null, // dropped
    ];
    writeFileSync(join(home, "state.json"), JSON.stringify(raw));
    const reloaded = loadState();
    assert.deepEqual(reloaded.org?.pendingRequests, [{ orgId: "org1", orgLabel: "Acme", slug: "acme", status: "pending", expiresAt: 123 }]);
  });
});

test("OrgContext.pendingRequests: absent in storage means absent after load (never fabricated as an empty array)", () => {
  withHome(() => {
    const base = loadState();
    saveState({ ...base, org: { enrolled: false, checkedAt: Date.now() } });
    const reloaded = loadState();
    assert.equal(reloaded.org?.pendingRequests, undefined, "no pendingRequests key on disk -> no key after load, distinct from a confirmed empty list");
  });
});
