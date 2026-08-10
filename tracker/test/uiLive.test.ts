/**
 * renderLive: the live-monitor line builder. Terminals can report `columns` a few
 * characters wider than they actually render (Windows ConPTY/scrollbar off-by-a-few),
 * so the 0.5.6 exact-width clamp still wrapped — renderLive keeps a hard safety margin
 * and drops whole trailing segments (never mid-word "...") until the line fits.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLive } from "../src/ui.ts";

const seg = (t: string) => ({ t });

test("renderLive joins segments with the themed separator when everything fits", () => {
  const out = renderLive([seg("10m 5s"), seg("Watching..."), seg("last 56s ago")], 120);
  assert.equal(out, "  10m 5s · Watching... · last 56s ago");
});

test("renderLive drops trailing segments (not mid-word) when width is tight", () => {
  const segs = [seg("10m 5s"), seg("Watching for new sessions"), seg("files Claude 85 / Codex 58"), seg("@octocat")];
  const out = renderLive(segs, 60);
  assert.ok(out.length <= 58, `must respect margin, got ${out.length}`);
  assert.ok(out.includes("Watching for new sessions"));
  assert.ok(!out.includes("@octocat"), "lowest-priority tail drops first");
  assert.ok(!out.includes("..."), "never mid-word truncation");
});

test("renderLive never exceeds width-2 even when columns over-reports (the 10-minute wrap bug)", () => {
  // the real 0.5.6 line that wrapped at ~186 visible chars on a terminal reporting 190
  const segs = [
    seg("10m 15s"),
    seg("Synced 1 session(s). Watching for new sessions... next sync in 13s"),
    seg("+1 session(s)"),
    seg("files Claude 85 / Codex 58"),
    seg("sessions Claude 65 / Codex 58"),
    seg("last 1m ago"),
    seg("@octocat"),
  ];
  const out = renderLive(segs, 190);
  assert.ok(out.length <= 160, `hard cap keeps clear of any real edge, got ${out.length}`);
});

test("renderLive always keeps the first segment even at absurdly narrow widths", () => {
  const out = renderLive([seg("10m 5s"), seg("Watching...")], 8);
  assert.ok(out.includes("10m 5s"));
});

test("renderLive applies per-segment paint AFTER width math (ANSI never counts as width)", () => {
  const red = (s: string) => `[31m${s}[39m`;
  const out = renderLive([seg("ok"), { t: "ERR", c: red }], 120);
  assert.ok(out.includes("[31mERR[39m"));
  // plain width = "  ok · ERR" = 10 chars; painted string is longer but visible width is what fit
});

test("renderLive falls back to the hard cap when width is unknown", () => {
  const long = Array.from({ length: 30 }, (_, i) => seg(`segment-number-${i}`));
  const out = renderLive(long, undefined);
  assert.ok(out.length <= 160);
});
