// node --test scripts/  (run from the repository root; the script imports the canonical table)
import { test } from "node:test";
import assert from "node:assert/strict";
import { findUnpricedIds, formatFlags, splitAcknowledged, formatAcknowledged } from "./check-unpriced-ids.mjs";

const TODAY = new Date("2026-09-29T12:00:00Z");
const text = { input: ["text"], output: ["text"] };
const model = (id, release_date, cost, extra = {}) => ({ id, release_date, cost, modalities: text, ...extra });

// A table shaped like the real one on 2026-09-28: opus-5 present, opus-5-5 absent.
const RATES = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 },
  "gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheCreation: 12.5 },
};

test("a new generation absent from the table is flagged, and the sibling-rate trap is named", () => {
  const catalog = {
    anthropic: { models: { "claude-opus-5-5": model("claude-opus-5-5", "2026-09-22", { input: 4, output: 20, cache_read: 0.2, cache_write: 5 }) } },
  };
  const flags = findUnpricedIds(catalog, RATES, TODAY);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, "claude-opus-5-5");
  // Expected fallback figures are Opus 5's row from the fixture — the real 2026-09-29 defect.
  assert.deepEqual(flags[0].pricedViaFallback, { input: 5, output: 25, cacheRead: 0.5 });
  assert.match(formatFlags(flags), /CURRENTLY PRICED VIA FALLBACK at 5\/25/);
});

test("an id with no fallback row reports as unpriced ($0), not as a trap", () => {
  const catalog = { xai: { models: { "grok-4.7": model("grok-4.7", "2026-09-21", { input: 2, output: 6, cache_read: 0.5 }) } } };
  const flags = findUnpricedIds(catalog, RATES, TODAY);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].pricedViaFallback, null);
  assert.match(formatFlags(flags), /unpriced: every token reads as \$0/);
});

test("exact keys, dated pins of known keys, old releases, resellers and non-text products are NOT flagged", () => {
  const catalog = {
    anthropic: {
      models: {
        "claude-opus-5": model("claude-opus-5", "2026-07-24", { input: 5, output: 25 }), // exact key
        "claude-haiku-4-5-20251001": model("claude-haiku-4-5-20251001", "2026-09-01", { input: 1, output: 5 }), // dated pin
        "claude-opus-4-1": model("claude-opus-4-1", "2025-08-05", { input: 15, output: 75 }), // too old to be "new"
      },
    },
    openai: {
      models: {
        "gpt-realtime-2.1": model("gpt-realtime-2.1", "2026-09-10", { input: 4, output: 16 }), // non-text product
        "gpt-image-2": model("gpt-image-2", "2026-09-10", { input: 5, output: 40 }, { modalities: { input: ["text"], output: ["image"] } }),
        "gpt-6-nova": { id: "gpt-6-nova", release_date: "2026-09-25", modalities: text }, // no cost upstream: nothing to enter
      },
    },
    "some-reseller": { models: { "claude-opus-5-5": model("claude-opus-5-5", "2026-09-22", { input: 4.4, output: 22 }) } },
  };
  assert.deepEqual(findUnpricedIds(catalog, RATES, TODAY), []);
});

// An id the VENDOR publishes no price for cannot be entered, and an alarm that goes
// red on it every day teaches people to ignore the alarm. Such an id is acknowledged
// ONCE, with the vendor evidence and a re-check date; until that date it reports as
// info, after it the flag returns on its own. Never a permanent mute.
test("an acknowledged id reports as info until its re-check date, then flags again", () => {
  const catalog = { openai: { models: { "gpt-daybreak-blue-latest": model("gpt-daybreak-blue-latest", "2026-08-07", { input: 4, output: 20 }) } } };
  const ack = [{ id: "gpt-daybreak-blue-latest", recheckBy: "2026-10-30", reason: "vendor page lists the model without rates" }];
  const before = splitAcknowledged(findUnpricedIds(catalog, RATES, new Date("2026-09-30T12:00:00Z")), ack, new Date("2026-09-30T12:00:00Z"));
  assert.deepEqual(before.flags, []);
  assert.equal(before.acknowledged.length, 1);
  assert.match(formatAcknowledged(before.acknowledged), /gpt-daybreak-blue-latest .*re-check by 2026-10-30/);
  const after = splitAcknowledged(findUnpricedIds(catalog, RATES, new Date("2026-10-31T12:00:00Z")), ack, new Date("2026-10-31T12:00:00Z"));
  assert.equal(after.flags.length, 1, "the acknowledgment expired: the id flags again");
  assert.deepEqual(after.acknowledged, []);
});

test("an acknowledgment never covers an id that is priced via fallback (that is the trap, not a vendor gap)", () => {
  const catalog = { anthropic: { models: { "claude-opus-5-5": model("claude-opus-5-5", "2026-09-22", { input: 4, output: 20 }) } } };
  const ack = [{ id: "claude-opus-5-5", recheckBy: "2099-01-01", reason: "someone tried to mute the trap" }];
  const r = splitAcknowledged(findUnpricedIds(catalog, RATES, TODAY), ack, TODAY);
  assert.equal(r.flags.length, 1);
  assert.deepEqual(r.acknowledged, []);
});

test("flags sort newest release first", () => {
  const catalog = {
    openai: {
      models: {
        "gpt-6-sol": model("gpt-6-sol", "2026-09-22", { input: 2, output: 10 }),
        "gpt-5.5": model("gpt-5.5", "2026-07-10", { input: 5, output: 30 }),
      },
    },
  };
  assert.deepEqual(findUnpricedIds(catalog, RATES, TODAY).map((f) => f.id), ["gpt-6-sol", "gpt-5.5"]);
});
