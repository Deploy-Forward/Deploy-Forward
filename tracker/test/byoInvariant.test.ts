/**
 * L17 THE HARD INVARIANT (RED — TEST-FIRST): nothing a user typed with `df pricing set`
 * ever leaves the machine.
 *
 * User rates are a LOCAL display convenience for `usage --cost`. The ingest payload the
 * tracker builds for a session must carry tokens + per-model buckets EXACTLY as always,
 * and must NEVER carry a rate, a spend/cost figure, or a userRate field — not for a
 * user-rated model, not for any model. The server's explicit whitelist already drops
 * unknown fields; this test pins the CLIENT so it never even sends them.
 *
 * Imports `toIngest` from sync.ts (NOT exported yet) and the userRates seam (does not
 * exist yet) -> RED for the right reason. Hermetic: DF_HOME pinned to a temp dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toIngest } from "../src/sync.ts";
import { setUserRate, listUserRates } from "../src/userRates.ts";
import { resolveModelPricing } from "../src/usageView.ts";
import type { SessionSummary } from "../src/types.ts";

/** Every field name that would mean a rate or user-supplied cost leaked onto the wire. */
const FORBIDDEN_WIRE_FIELDS = ["userRate", "userRates", "rate", "rates", "spend", "cost", "estCostUsd", "estCost"];

test("built ingest payload for a user-rated session carries tokens/models but NO rate/spend/userRate", (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-byo-invariant-"));
  const prev = process.env.DF_HOME;
  process.env.DF_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.DF_HOME;
    else process.env.DF_HOME = prev;
  });

  // A model the bundled table can't price, given a user rate — so it is GENUINELY user-rated.
  setUserRate("my-local-model", { input: 3, output: 12, cacheWrite: 1 });
  const resolved = resolveModelPricing("my-local-model", listUserRates());
  assert.equal(resolved?.basis, "user", "precondition: the model really is priced by the user rate");

  const summary: SessionSummary = {
    tool: "claude_code",
    toolSessionId: "s-byo",
    model: "my-local-model",
    tokens: { input: 100, output: 50, cacheRead: 10, cacheCreation: 5 },
    models: [{ id: "my-local-model", input: 100, output: 50, cacheRead: 10, cacheCreation: 5 }],
    entryPoint: "cli",
    thinkingTokens: 0,
    wallMs: 1000,
    activeMs: 800,
    idleMs: 200,
    startedAt: 1,
    endedAt: 1001,
    repoHash: null,
    messageCount: 2,
    turns: 1,
    longestLoopMs: 0,
  };

  const wire = toIngest(summary) as Record<string, unknown>;

  // Tokens and per-model buckets ride exactly as always.
  assert.deepEqual(wire.tokens, { input: 100, output: 50, cacheRead: 10, cacheCreation: 5 });
  assert.deepEqual(wire.models, [{ id: "my-local-model", input: 100, output: 50, cacheRead: 10, cacheCreation: 5 }]);

  // The whole point: no rate, no spend, no userRate — anywhere in the built payload.
  const serialized = JSON.stringify(wire);
  for (const field of FORBIDDEN_WIRE_FIELDS) {
    assert.equal(field in wire, false, `top-level field "${field}" must never be on the wire`);
  }
  assert.equal(/userRate|"rate"|"spend"|estCost/i.test(serialized), false, "no rate/spend token anywhere in the serialized payload");
});
