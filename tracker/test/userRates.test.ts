/**
 * L17 BYO models (RED — TEST-FIRST): bring-your-own per-model rates, LOCAL-ONLY.
 *
 * `df pricing set/list/unset` writes user-supplied USD-per-MTok rates into the local
 * tracker state (key `userRates`) so `usage --cost` can price a model the bundled table
 * has never heard of. HARD RULE (Marco): nothing a user types here ever leaves the
 * machine — that invariant is pinned separately in byoInvariant.test.ts; this file pins
 * the round-trip, the set-time validation, and the pricing-resolution precedence.
 *
 * These import entry points that DO NOT EXIST YET (src/userRates.ts, plus
 * resolveModelPricing/USER_RATE_LABEL on usageView.ts), so the suite fails RED for the
 * right reason until L17 lands. Hermetic: every persistence test pins DF_HOME to a temp dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  setUserRate,
  listUserRates,
  unsetUserRate,
  validateUserRate,
  MAX_USER_RATE_PER_MTOK,
  type UserRate,
} from "../src/userRates.ts";
import { PRICES, resolveModelPricing, USER_RATE_LABEL } from "../src/usageView.ts";

/** Point DF_HOME at a fresh temp dir for one persistence test, restored on teardown. */
function withHome(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(join(tmpdir(), "df-userrates-"));
  const prev = process.env.DF_HOME;
  process.env.DF_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.DF_HOME;
    else process.env.DF_HOME = prev;
  });
  return home;
}

test("pricing set/list round-trip: a user rate persists to local state and reads back", (t) => {
  const home = withHome(t);

  setUserRate("my-local-model", { input: 3, output: 12 });
  setUserRate("vendor/other-model:tag", {
    input: 1.5,
    output: 6,
    cacheRead: 0.2,
    cacheWrite: 1,
    source: "https://example.com/pricing",
  });

  const rates = listUserRates();
  assert.equal(rates["my-local-model"].input, 3);
  assert.equal(rates["my-local-model"].output, 12);

  const other = rates["vendor/other-model:tag"];
  assert.equal(other.input, 1.5);
  assert.equal(other.output, 6);
  assert.equal(other.cacheRead, 0.2);
  assert.equal(other.cacheWrite, 1);
  assert.equal(other.source, "https://example.com/pricing");

  // Persisted to disk under the `userRates` key — this is what must NEVER reach the wire.
  const onDisk = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  assert.ok(onDisk.userRates, "userRates lives in local state");
  assert.equal(onDisk.userRates["my-local-model"].input, 3);
});

test("pricing unset removes a stored rate; a missing id is a no-op", (t) => {
  withHome(t);

  setUserRate("throwaway-model", { input: 2, output: 8 });
  assert.ok(listUserRates()["throwaway-model"], "stored first");

  assert.equal(unsetUserRate("throwaway-model"), true, "returns true when it removed one");
  assert.equal(listUserRates()["throwaway-model"], undefined, "gone after unset");

  assert.equal(unsetUserRate("never-existed"), false, "unset of an absent id removes nothing");
});

test("set-time validation REJECTS bad rates and bad model ids (never persisted)", (t) => {
  withHome(t);

  // 0 < rate <= 10000 per MTok; NaN/negative/zero and over-cap all rejected.
  assert.throws(() => setUserRate("m", { input: 0, output: 5 }), /rate|input/i, "zero rejected");
  assert.throws(() => setUserRate("m", { input: -1, output: 5 }), /rate|input/i, "negative rejected");
  assert.throws(() => setUserRate("m", { input: Number.NaN, output: 5 }), /rate|input/i, "NaN rejected");
  assert.throws(
    () => setUserRate("m", { input: MAX_USER_RATE_PER_MTOK + 1, output: 5 }),
    /rate|band|input/i,
    "above the sane band rejected",
  );

  // modelId charset [\w.\-/:@] and length <= 128.
  assert.throws(() => setUserRate("bad model id", { input: 1, output: 1 }), /model|id/i, "spaces rejected");
  assert.throws(() => setUserRate("x".repeat(129), { input: 1, output: 1 }), /model|id|length/i, "over-long id rejected");

  // Nothing above was ever written.
  assert.deepEqual(listUserRates(), {}, "no rejected rate leaked into state");
});

test("set-time validation ACCEPTS the sane-band boundaries", (t) => {
  withHome(t);
  // The cap itself is allowed (<=, not <); a permissive but non-word id set is allowed.
  setUserRate("edge-model", { input: MAX_USER_RATE_PER_MTOK, output: 0.000001 });
  setUserRate("org/repo-model_2:v1@edge", { input: 1, output: 1 });
  const rates = listUserRates();
  assert.equal(rates["edge-model"].input, MAX_USER_RATE_PER_MTOK);
  assert.ok(rates["org/repo-model_2:v1@edge"], "the full legal charset [\\w.\\-/:@] is accepted");
});

test("validateUserRate reports the same verdicts as a pure function (no I/O)", () => {
  assert.equal(validateUserRate("ok-model", { input: 1, output: 2 }).ok, true);

  const bad = validateUserRate("has spaces", { input: -3, output: 2 });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 1, "at least one reason is surfaced");
});

// ---- pricing resolution: canonical ALWAYS wins; a user rate prices only unknown ids ----

test("resolveModelPricing: a canonical model wins even when a user rate exists (user rate inert)", () => {
  const canonical = PRICES["claude-opus-4-8"];
  // A user rate stored for a canonically-priced id must be INERT — canonical wins.
  const r = resolveModelPricing("claude-opus-4-8", {
    "claude-opus-4-8": { input: 999, output: 999 },
  });
  assert.ok(r, "a canonical model resolves");
  assert.equal(r!.basis, "canonical", "canonical basis, not user");
  assert.equal(r!.price.input, canonical.input, "the bundled rate, not the user's 999");
  assert.equal(r!.price.output, canonical.output);
});

test("resolveModelPricing: an unknown id with a user rate prices as basis 'user'", () => {
  const r = resolveModelPricing("my-local-model", {
    "my-local-model": { input: 3, output: 12, cacheWrite: 1 },
  });
  assert.ok(r, "the user rate makes it priceable");
  assert.equal(r!.basis, "user", "labeled as a user rate everywhere spend basis renders");
  assert.equal(r!.price.input, 3);
  assert.equal(r!.price.output, 12);
  assert.equal(r!.price.cacheRead, 0, "cacheRead defaults to 0 when the user omitted it");
  assert.equal(r!.price.cacheCreation, 1, "cache-write maps to cacheCreation");
});

test("resolveModelPricing: an unknown id with no user rate stays unpriced (never guessed)", () => {
  assert.equal(resolveModelPricing("totally-unknown-model", {}), null);
});

test("USER_RATE_LABEL is the exact spend-basis marker", () => {
  assert.equal(USER_RATE_LABEL, "(user rate)");
});
