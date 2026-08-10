/**
 * L17 consented unknown-model share (RED — TEST-FIRST), CLIENT side.
 *
 * `df config share-unknown-models on|off` (default OFF). When ON — and ONLY then — sync
 * may attach a minimal `unknownModels: [{ id, tool, count }]` list (models the bundled
 * price table can't price) so the project can learn what to price next. It is capped at
 * 20 entries and the ids are charset/length sanitized before they ever go near the wire.
 * User-supplied RATES are never part of this — only occurrence counts of model ids.
 *
 * Imports src/unknownModels.ts, which does NOT exist yet -> RED for the right reason.
 * Pure builder (consent passed in explicitly), so no DF_HOME/network is touched here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildUnknownModelShare,
  MAX_UNKNOWN_MODELS_SHARE,
  type UnknownModelShare,
} from "../src/unknownModels.ts";

/** A minimal session-shaped stub: only the fields the builder reads (tool + models). */
function sess(tool: string, modelId: string) {
  return {
    tool,
    models: [{ id: modelId, input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }],
  };
}

test("consent OFF: nothing is built even when unknown models exist", () => {
  const summaries = [sess("claude_code", "some-unpriced-model"), sess("claude_code", "another-unknown")];
  assert.equal(
    buildUnknownModelShare(summaries as any, { consent: false }),
    undefined,
    "OFF is the default and it shares NOTHING",
  );
});

test("consent ON but every model is canonically priced: still nothing to share", () => {
  const summaries = [sess("claude_code", "claude-opus-4-8"), sess("codex", "gpt-5.4")];
  assert.equal(
    buildUnknownModelShare(summaries as any, { consent: true }),
    undefined,
    "only UNPRICED (unknown) ids are candidates",
  );
});

test("consent ON: unknown ids share as {id,tool,count}, counted by occurrence, sorted desc", () => {
  const summaries = [
    sess("claude_code", "weird-model-a"),
    sess("claude_code", "weird-model-a"),
    sess("claude_code", "weird-model-a"),
    sess("codex", "weird-model-b"),
    sess("claude_code", "claude-opus-4-8"), // canonical -> excluded
  ];
  const out = buildUnknownModelShare(summaries as any, { consent: true });
  assert.ok(out, "consent ON with unknowns builds a list");
  const list = out as UnknownModelShare[];

  const a = list.find((e) => e.id === "weird-model-a");
  const b = list.find((e) => e.id === "weird-model-b");
  assert.ok(a && b, "both unknown ids present");
  assert.equal(a!.count, 3, "occurrence count = number of sessions the id appeared in");
  assert.equal(a!.tool, "claude_code");
  assert.equal(b!.count, 1);
  assert.equal(b!.tool, "codex");

  assert.equal(list.find((e) => e.id === "claude-opus-4-8"), undefined, "canonical id never shared");
  assert.equal(list[0].id, "weird-model-a", "sorted by count, most-frequent first");
});

test("consent ON: the share is capped at 20 entries (the most-frequent survive)", () => {
  const summaries: ReturnType<typeof sess>[] = [];
  // model mNN appears (NN + 1) times, so counts run 1..25; the top 20 (counts 25..6) survive.
  for (let i = 0; i < 25; i++) {
    const id = "unk-model-" + String(i).padStart(2, "0");
    for (let k = 0; k <= i; k++) summaries.push(sess("claude_code", id));
  }
  const out = buildUnknownModelShare(summaries as any, { consent: true }) as UnknownModelShare[];
  assert.equal(out.length, MAX_UNKNOWN_MODELS_SHARE, "capped");
  assert.equal(MAX_UNKNOWN_MODELS_SHARE, 20, "the cap is 20");
  assert.equal(out[0].id, "unk-model-24", "highest count first");
  assert.equal(out[0].count, 25);
  assert.equal(out.find((e) => e.id === "unk-model-00"), undefined, "the least-frequent overflow is dropped");
});

test("consent ON: ids failing the charset/length gate are dropped, never mangled onto the wire", () => {
  const summaries = [
    sess("claude_code", "clean-model-id"),
    sess("claude_code", "bad model id with spaces"),
    sess("claude_code", "x".repeat(200)),
  ];
  const out = buildUnknownModelShare(summaries as any, { consent: true }) as UnknownModelShare[];
  assert.ok(out.some((e) => e.id === "clean-model-id"), "the legal id survives");
  assert.equal(out.some((e) => e.id.includes(" ")), false, "no whitespace id ever leaves");
  assert.equal(out.some((e) => e.id.length > 128), false, "no over-length id ever leaves");
});
