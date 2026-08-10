/**
 * CONTEXT WINDOW REGISTRY — behavioral pins for tracker/src/contextWindows.ts.
 *
 * FAILING BY DESIGN (lane T0): tracker/src/contextWindows.ts does not exist yet. This
 * file pins the CONTRACT the implementation must satisfy — a separate agent builds the
 * module to make these green. Do not add src/contextWindows.ts here.
 *
 * WHY THIS MODULE: `usage --cost` prices a model but has no notion of how much of that
 * model's window is actually in play (the context-capacity feature, lane T0's slice of
 * it). Nothing today maps a model id to an input-context window in tokens. This module
 * is that map, resolved with the SAME semantics priceForModel already uses in
 * src/usageView.ts (normalizeModelId, then longest-prefix match over model families) —
 * see PRICES/resolveBase/normalizeModelId/priceForModel there, ~lines 305-379.
 *
 * ONE semantic pricing does NOT have: a routing suffix can carry window info on its own.
 * "claude-opus-4-8[1m]" must resolve to 1_000_000 even though the opus family's default
 * window is 200_000 — Anthropic's 1M-context beta is a distinct capability from the base
 * model, keyed off the literal "[1m]" suffix, not a separate table entry per family.
 *
 * Every VERIFY-tagged number below is copied from a model's context-window claim as
 * currently believed, UNCONFIRMED against the vendor's own page — same labeling
 * discipline test/coreParity.test.ts and usage-core/src/pricing.ts already apply to
 * dollar rates. Agreement between the CLI and the server is guaranteed by
 * test/coreParity.test.ts; correctness against the vendor is not claimed by
 * either. Run: npx tsx --test test/contextWindows.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTEXT_WINDOWS, contextWindowForModel } from "../src/contextWindows.ts";
import { PRICES } from "../src/usageView.ts";

// ---- Behavioral pins ---------------------------------------------------------------------

test("claude-opus-4-8 resolves to its published 200K window", () => {
  // VERIFY: vendor-stated 200,000-token window, unconfirmed against anthropic.com/pricing —
  // same labeling discipline as the pricing VERIFY notes.
  assert.equal(contextWindowForModel("claude-opus-4-8"), 200_000);
});

test("the [1m] routing suffix overrides the family default to 1,000,000 regardless of base", () => {
  // Opus's own family default is 200_000 (see above); the [1m] suffix is a DISTINCT
  // capability (Anthropic's 1M-context beta), not a family, so it must win over
  // whatever the base family resolves to.
  assert.equal(contextWindowForModel("claude-opus-4-8[1m]"), 1_000_000);
  assert.notEqual(
    contextWindowForModel("claude-opus-4-8[1m]"),
    contextWindowForModel("claude-opus-4-8"),
    "the [1m] suffix must change the resolved window, not fall through to the family default",
  );
});

test("an OpenRouter-routed id resolves to the same window as the bare model id", () => {
  const routed = contextWindowForModel("openrouter/anthropic/claude-sonnet-5");
  const bare = contextWindowForModel("claude-sonnet-5");
  assert.equal(routed, bare);
  assert.ok(typeof bare === "number" && bare > 0, "claude-sonnet-5 must resolve to a positive window");
});

test("unknown and empty ids resolve to null -- never a guessed window", () => {
  assert.equal(contextWindowForModel("totally-unknown-model"), null);
  assert.equal(contextWindowForModel(""), null);
});

test("longest-prefix resolution: a suffixed id resolves via its longest matching family, never a shorter one", () => {
  // Mirrors resolveBase's "longest, not first-match" contract in usageView.ts verbatim:
  // "claude-sonnet-5-something" must resolve through the "claude-sonnet-5" family (the
  // longest prefix that matches), landing on the SAME window as the bare family id --
  // never a shorter, more generic prefix that happens to also match.
  assert.equal(contextWindowForModel("claude-sonnet-5-something"), contextWindowForModel("claude-sonnet-5"));
});

// ---- Table-shape invariants ---------------------------------------------------------------

test("every value in CONTEXT_WINDOWS is a positive integer", () => {
  for (const [family, window] of Object.entries(CONTEXT_WINDOWS)) {
    assert.ok(Number.isInteger(window), `${family}: window ${window} is not an integer`);
    assert.ok(window > 0, `${family}: window ${window} is not positive`);
  }
});

test("every model id the CLI prices (PRICES) also has a resolvable context window", () => {
  // The surface that prices a model must also know its window -- a model that shows up
  // in `usage --cost` but silently has no window would be the context-capacity analog
  // of the pricing bug the old pricingSync guard existed to catch: real coverage quietly missing
  // from one surface while another has it.
  for (const id of Object.keys(PRICES)) {
    assert.notEqual(contextWindowForModel(id), null, `${id}: priced by the CLI but has NO resolvable context window`);
  }
});
