// node --test scripts/  (run from the repository root)
import { test } from "node:test";
import assert from "node:assert/strict";
import { driftFor, lookupCatalog } from "./check-price-drift.mjs";

// LiteLLM prices are USD per TOKEN; ours are USD per MTok.
const entry = (input, output, cacheRead, cacheWrite) => ({
  input_cost_per_token: input / 1e6,
  output_cost_per_token: output / 1e6,
  cache_read_input_token_cost: cacheRead / 1e6,
  ...(cacheWrite === undefined ? {} : { cache_creation_input_token_cost: cacheWrite / 1e6 }),
});

test("cache-WRITE drift is caught when the catalog carries it (the 2026-09-29 gpt-5.6 miss)", () => {
  // Our row assumed writes bill as input (4.0); OpenAI moved them to 1.25x (5.0).
  const ours = { input: 4, output: 20, cacheRead: 0.4, cacheCreation: 4 };
  const drifts = driftFor("gpt-5.6-sol", ours, "gpt-5.6-sol", entry(4, 20, 0.4, 5));
  assert.deepEqual(drifts, [{ id: "gpt-5.6-sol", key: "gpt-5.6-sol", field: "cacheCreation", ours: 4, catalog: 5 }]);
});

test("a catalog row without a cache-write figure cannot drift on it", () => {
  const ours = { input: 2, output: 6, cacheRead: 0.5, cacheCreation: 2 };
  assert.deepEqual(driftFor("grok-4.6", ours, "grok-4.6", entry(2, 6, 0.5)), []);
});

// 2026-11-01, exported-tree run: our glm-5 row was paired with LiteLLM's "mistral/glm-5-2"
// -- that catalog's dash spelling of glm-5.2, a DIFFERENT product with its own row here --
// and reported as drift against glm-5.2's rates. A dashed-digit remainder is a dated pin
// of the shorter id only when no longer priced id claims the key.
test("a catalog key that spells ANOTHER priced id with a dash is not a dated pin of the shorter id", () => {
  const catalog = { "mistral/glm-5-2": entry(1.4, 4.4, 0.14), "moonshot/kimi-k2-0905": entry(0.6, 2.5, 0.15) };
  assert.equal(lookupCatalog(catalog, "glm-5", ["glm-5", "glm-5.2"]), null, "glm-5-2 is glm-5.2's key, not glm-5's");
  assert.equal(lookupCatalog(catalog, "glm-5.2", ["glm-5", "glm-5.2"]), null, "and the dotted id does not match the dashed key either (exact keys only)");
  // The real dated-pin case is untouched: kimi-k2-0905 is still kimi-k2's own build pin,
  // even with a longer kimi-k2.6 row present.
  assert.equal(lookupCatalog(catalog, "kimi-k2", ["kimi-k2", "kimi-k2.6"])?.key, "moonshot/kimi-k2-0905");
});

test("lookupCatalog never reaches an azure/ or regional reseller row", () => {
  const catalog = { "azure/gpt-6-sol": entry(2, 10, 0.2), "azure/us/gpt-6-sol": entry(2.2, 11, 0.22), "us.anthropic.claude-opus-5": entry(5.5, 27.5, 0.55) };
  assert.equal(lookupCatalog(catalog, "gpt-6-sol"), null);
  assert.equal(lookupCatalog(catalog, "claude-opus-5"), null);
});
