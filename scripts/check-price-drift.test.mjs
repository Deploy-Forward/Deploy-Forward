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
// and reported as drift against glm-5.2's rates. A dashed remainder is a dated pin only when
// it is a pure build/date number (the next test pins the rule).
test("a catalog key that spells ANOTHER priced id with a dash is not a dated pin of the shorter id", () => {
  const catalog = { "mistral/glm-5-2": entry(1.4, 4.4, 0.14), "moonshot/kimi-k2-0905": entry(0.6, 2.5, 0.15) };
  assert.equal(lookupCatalog(catalog, "glm-5"), null, "glm-5-2 is glm-5.2's key, not glm-5's");
  assert.equal(lookupCatalog(catalog, "glm-5.2"), null, "and the dotted id does not match the dashed key either (exact keys only)");
  // The real dated-pin case is untouched: kimi-k2-0905 is still kimi-k2's own build pin,
  // even with a longer kimi-k2.6 row present.
  assert.equal(lookupCatalog(catalog, "kimi-k2")?.key, "moonshot/kimi-k2-0905");
});

test("lookupCatalog never reaches an azure/ or regional reseller row", () => {
  const catalog = { "azure/gpt-6-sol": entry(2, 10, 0.2), "azure/us/gpt-6-sol": entry(2.2, 11, 0.22), "us.anthropic.claude-opus-5": entry(5.5, 27.5, 0.55) };
  assert.equal(lookupCatalog(catalog, "gpt-6-sol"), null);
  assert.equal(lookupCatalog(catalog, "claude-opus-5"), null);
});

// 2026-11-04 to 2026-11-10, seven red daily runs: LiteLLM added the reseller keys
// "empiriolabs/kimi-k2-7-code:variant1" and "empiriolabs/glm-5-2:variant2". Each begins with a
// priced id, a dash and a digit, so the dated-pin fallback paired kimi-k2 with a kimi-k2.7-code
// reseller row and glm-5 with a glm-5.2 one, and reported both as drift against the WRONG
// product. A dated pin is the id plus a build or date number (4+ digits) and nothing else.
test("a dated pin is the id plus a pure build/date number: reseller ':variant' keys and other models' names never qualify", () => {
  const catalog = {
    "empiriolabs/kimi-k2-7-code:variant1": entry(0.8939, 3.7131, 0.1788),
    "empiriolabs/kimi-k2-7-code-highspeed": entry(1.9, 8, 0.19),
    "empiriolabs/glm-5-2:variant2": entry(1.4, 4.4, 0.14),
    "empiriolabs/glm-5-3-flash": entry(0.2, 0.8, 0.02),
  };
  assert.equal(lookupCatalog(catalog, "kimi-k2"), null, "kimi-k2-7-code:variant1 is a kimi-k2.7-code reseller row, not a kimi-k2 pin");
  assert.equal(lookupCatalog(catalog, "glm-5"), null, "glm-5-2:variant2 is a glm-5.2 reseller row, not a glm-5 pin");
  // The real pins still resolve, and the newest one wins.
  const pinned = { ...catalog, "moonshot/kimi-k2-0711": entry(0.6, 2.5, 0.15), "moonshot/kimi-k2-0905": entry(0.6, 2.5, 0.15), "openai/gpt-4o-2024-08-06": entry(2.5, 10, 1.25) };
  assert.equal(lookupCatalog(pinned, "kimi-k2")?.key, "moonshot/kimi-k2-0905");
  assert.equal(lookupCatalog(pinned, "gpt-4o")?.key, "openai/gpt-4o-2024-08-06");
  // A one- or two-digit remainder is a version (glm-5-2 is glm-5.2), never a pin -- whether or
  // not the longer sibling is priced here.
  assert.equal(lookupCatalog({ "mistral/glm-5-2": entry(1.4, 4.4, 0.14) }, "glm-5"), null);
});
