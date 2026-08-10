import { test } from "node:test";
import assert from "node:assert/strict";
import { isDfBeatEntry, syncDueForEvent } from "../src/hooks.ts";

// --- legacy-orphan recognition (the 7-entries-per-event bug, 2026-07-10) ---------------
// Pre-0.9.x installs wrote UNTAGGED hook entries; the tag-only dedup let one orphan per
// historical install location pile up (evicted npx cache dirs -> exit-code-1 per prompt).

test("isDfBeatEntry recognizes ours — tagged or legacy-untagged, any install location", () => {
  const cmd = (c: string) => ({ hooks: [{ type: "command", command: c }] });
  // Legacy untagged entries from every location shape seen in the wild:
  assert.equal(isDfBeatEntry(cmd('"C:/Program Files/nodejs/node.exe" "C:/Users/m/AppData/Local/npm-cache/_npx/9cc6e3c33e6062fa/node_modules/deploy-forward/dist/bin/df.js" beat --event Stop')), true);
  assert.equal(isDfBeatEntry(cmd('"C:/Program Files/nodejs/node.exe" "C:/Users/m/ola/deploy-forward/tracker/dist/bin/df.js" beat --event SessionStart')), true);
  assert.equal(isDfBeatEntry(cmd("npx -y deploy-forward beat --event SessionEnd")), true);
  assert.equal(isDfBeatEntry(cmd('"node" "C:/x/bin/df.ts" beat --event Stop')), true); // dev-run era
});

test("isDfBeatEntry never matches another product's hooks", () => {
  const cmd = (c: string) => ({ hooks: [{ type: "command", command: c }] });
  assert.equal(isDfBeatEntry(cmd("python -m ola_brain.cli hook post-tool-use")), false);
  assert.equal(isDfBeatEntry(cmd("echo deploy-forward is great")), false); // mentions us, no beat verb
  assert.equal(isDfBeatEntry(cmd("df -h")), false); // coreutils df
  assert.equal(isDfBeatEntry({}), false);
  assert.equal(isDfBeatEntry(null), false);
  assert.equal(isDfBeatEntry({ hooks: [{ type: "command", command: 42 }] }), false);
});

test("beat debounce: session boundaries sync on a 60s window, turn ends on 5min, prompts never", () => {
  const t0 = 1_000_000_000;
  // SessionStart / SessionEnd: tight window (catch-up + final flush)
  assert.equal(syncDueForEvent("SessionEnd", t0, t0 + 61_000), true);
  assert.equal(syncDueForEvent("SessionEnd", t0, t0 + 59_000), false);
  assert.equal(syncDueForEvent("SessionStart", t0, t0 + 61_000), true);
  // Stop (turn end): lazy 5-minute debounce
  assert.equal(syncDueForEvent("Stop", t0, t0 + 4 * 60_000), false);
  assert.equal(syncDueForEvent("Stop", t0, t0 + 6 * 60_000), true);
  // Prompt beats are presence-only — syncing mid-turn would race the transcript write
  assert.equal(syncDueForEvent("UserPromptSubmit", 0, t0), false);
  // Never-synced state (lastSyncAt 0) is due immediately on any sync-eligible event
  assert.equal(syncDueForEvent("SessionStart", 0, t0), true);
});

// --- dev-run guard (the Stop-hook ERR_MODULE_NOT_FOUND bug, 2026-07-09) ----------------
import { cliInvocation, resolveRunnableEntry } from "../src/hooks.js";
import { resolve as rp } from "node:path";

test("resolveRunnableEntry: a .ts entry remaps to the compiled dist twin when it exists", () => {
  const tsEntry = rp("/repo/tracker/bin/df.ts");
  const compiled = rp("/repo/tracker/dist/bin/df.js");
  assert.equal(resolveRunnableEntry(tsEntry, (p) => p === compiled), compiled);
  // dist missing -> null (caller falls back to npx, never a raw .ts hook command)
  assert.equal(resolveRunnableEntry(tsEntry, () => false), null);
  // a compiled .js entry passes through untouched
  assert.equal(resolveRunnableEntry(compiled, () => true), compiled);
});

test("cliInvocation: never emits a raw .ts entry and never falls back to bare df", () => {
  const tsEntry = rp("/repo/tracker/bin/df.ts");
  const withDist = cliInvocation("/usr/bin/node", tsEntry, (p) => p.endsWith("df.js"));
  assert.match(withDist, /dist\/bin\/df\.js/);
  assert.doesNotMatch(withDist, /\.ts"/);
  const noDist = cliInvocation("/usr/bin/node", tsEntry, () => false);
  assert.equal(noDist, "npx -y deploy-forward");
});

// --- healHooks: idempotent de-duplication of accumulated beat entries -------------------
// The recurrence Grok surfaced 2026-07-14: installHooks() collapses to one, but only at
// setup; a second live npx-cache entry appended between setups fires on every event, and
// Grok additionally runs a FROZEN import copy installHooks never touched.
import { healHooks } from "../src/hooks.ts";
import { mkdtempSync, mkdirSync, writeFileSync as wf, readFileSync as rf, rmSync } from "node:fs";
import { join as pj } from "node:path";
import { tmpdir } from "node:os";

const beatCmd = (path: string, event: string) => ({
  hooks: [{ type: "command", command: `"node" "${path}" beat --event ${event}` }],
});
const countBeats = (arr: any[]) =>
  arr.filter((e) => e?._source === "deployforward-buildboard" || isDfBeatEntry(e)).length;

test("healHooks: collapses duplicate beat entries in settings.json to one, preserves foreign hooks", () => {
  const dir = mkdtempSync(pj(tmpdir(), "df-heal-settings-"));
  const settingsFile = pj(dir, "settings.json");
  const prevS = process.env.DF_CLAUDE_SETTINGS;
  const prevG = process.env.DF_GROK_HOME;
  try {
    process.env.DF_CLAUDE_SETTINGS = settingsFile;
    process.env.DF_GROK_HOME = pj(dir, "no-grok"); // absent -> grok heal is a no-op
    const foreign = { hooks: [{ type: "command", command: "python -m ola_brain.cli hook post-tool-use" }] };
    wf(
      settingsFile,
      JSON.stringify({
        model: "keep-me",
        hooks: {
          // two live df paths (the exact accumulation shape) + one foreign hook
          UserPromptSubmit: [
            beatCmd("/npx/AAA/deploy-forward/dist/bin/df.js", "UserPromptSubmit"),
            beatCmd("/npx/BBB/deploy-forward/dist/bin/df.js", "UserPromptSubmit"),
            foreign,
          ],
          Stop: [beatCmd("/npx/AAA/deploy-forward/dist/bin/df.js", "Stop")], // already single -> untouched
        },
      }),
    );

    healHooks();

    const out = JSON.parse(rf(settingsFile, "utf8"));
    assert.equal(out.model, "keep-me", "unrelated settings preserved");
    assert.equal(countBeats(out.hooks.UserPromptSubmit), 1, "duplicates collapsed to one");
    assert.ok(
      out.hooks.UserPromptSubmit.some((e: any) => e.hooks?.[0]?.command?.includes("ola_brain")),
      "foreign hook preserved",
    );
    assert.equal(countBeats(out.hooks.Stop), 1, "an already-single event stays single");
  } finally {
    if (prevS === undefined) delete process.env.DF_CLAUDE_SETTINGS;
    else process.env.DF_CLAUDE_SETTINGS = prevS;
    if (prevG === undefined) delete process.env.DF_GROK_HOME;
    else process.env.DF_GROK_HOME = prevG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("healHooks: collapses Grok's frozen import copy, but NEVER introduces a beat where none exists", () => {
  const dir = mkdtempSync(pj(tmpdir(), "df-heal-grok-"));
  const grokHome = pj(dir, "grok");
  mkdirSync(pj(grokHome, "hooks"), { recursive: true });
  const importFile = pj(grokHome, "hooks", "imported-from-claude.json");
  const prevS = process.env.DF_CLAUDE_SETTINGS;
  const prevG = process.env.DF_GROK_HOME;
  try {
    process.env.DF_CLAUDE_SETTINGS = pj(dir, "no-settings.json"); // absent -> settings heal no-op
    process.env.DF_GROK_HOME = grokHome;
    wf(
      importFile,
      JSON.stringify({
        hooks: {
          // four stale df paths (Marco's exact shape) -> must collapse to one
          UserPromptSubmit: [
            beatCmd("/npx/AAA/deploy-forward/dist/bin/df.js", "UserPromptSubmit"),
            beatCmd("/home/m/node_modules/deploy-forward/dist/bin/df.js", "UserPromptSubmit"),
            beatCmd("/npx/BBB/deploy-forward/dist/bin/df.js", "UserPromptSubmit"),
            beatCmd("/repo/tracker/dist/bin/df.js", "UserPromptSubmit"),
          ],
          // an event with NO df entry (only a foreign hook) -> we must not add one
          PreToolUse: [{ hooks: [{ type: "command", command: "some-other-tool run" }] }],
        },
      }),
    );

    healHooks();

    const out = JSON.parse(rf(importFile, "utf8"));
    assert.equal(countBeats(out.hooks.UserPromptSubmit), 1, "four frozen dups collapsed to one");
    assert.equal(countBeats(out.hooks.PreToolUse), 0, "never introduced a beat into a df-free event");
    assert.equal(out.hooks.PreToolUse.length, 1, "foreign event left exactly as-is");
  } finally {
    if (prevS === undefined) delete process.env.DF_CLAUDE_SETTINGS;
    else process.env.DF_CLAUDE_SETTINGS = prevS;
    if (prevG === undefined) delete process.env.DF_GROK_HOME;
    else process.env.DF_GROK_HOME = prevG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("healHooks: soft — a missing or unparseable file is left untouched, never throws", () => {
  const dir = mkdtempSync(pj(tmpdir(), "df-heal-soft-"));
  const settingsFile = pj(dir, "settings.json");
  const prevS = process.env.DF_CLAUDE_SETTINGS;
  const prevG = process.env.DF_GROK_HOME;
  try {
    process.env.DF_GROK_HOME = pj(dir, "no-grok");
    // (1) absent settings file -> no throw, nothing created
    process.env.DF_CLAUDE_SETTINGS = pj(dir, "nope.json");
    assert.doesNotThrow(() => healHooks());
    // (2) unparseable settings -> left byte-identical (never clobbered)
    const garbage = "{ not json ";
    wf(settingsFile, garbage);
    process.env.DF_CLAUDE_SETTINGS = settingsFile;
    assert.doesNotThrow(() => healHooks());
    assert.equal(rf(settingsFile, "utf8"), garbage, "unparseable config left untouched");
  } finally {
    if (prevS === undefined) delete process.env.DF_CLAUDE_SETTINGS;
    else process.env.DF_CLAUDE_SETTINGS = prevS;
    if (prevG === undefined) delete process.env.DF_GROK_HOME;
    else process.env.DF_GROK_HOME = prevG;
    rmSync(dir, { recursive: true, force: true });
  }
});
