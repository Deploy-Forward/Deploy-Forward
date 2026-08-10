/**
 * Unit tests for CLI presentation guards. The live monitor rewrites ONE line with \r —
 * that only stays one line while it is narrower than the terminal: at >= columns the
 * terminal soft-wraps and \r returns to the start of the LAST wrapped row, appending a
 * new physical line on every repaint (the 0.5.5 PowerShell scroll bug). clampLine is
 * the guard that makes wrapping impossible. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampLine, parseChoice, brandRgb, setTheme, link } from "../src/ui.ts";

// ── OSC 8 hyperlink. In a test stdout is not a TTY, so paints no-op — which is
// itself the contract worth pinning: a piped/redirected run must never see an
// escape byte (the full-screen frame's width math depends on links costing zero
// visible cells, and superStart's own tests assert the exact widths). ───────────

test("link() emits nothing extra when stdout is not a TTY", () => {
  const out = link("https://leaderboard.deployforward.dev", "leaderboard.deployforward.dev");
  assert.equal(out, "leaderboard.deployforward.dev", "no escape bytes into a pipe");
  assert.ok(!out.includes("\x1b"));
});

// ── The brand blue is TRUECOLOR, so it bypasses the terminal's palette entirely: a
// light-background user cannot fix it from their color scheme, the CLI must. Measured
// WCAG (2026-07-17): #60a5fa = 7.79:1 on #0a0a0a but 2.44:1 on #fafafa (fails even the
// large-text bar); #1d4ed8 = 6.42:1 on #fafafa. Neither works on both grounds. ──────

test("brandRgb picks the blue that is legible on the given ground", () => {
  assert.deepEqual(brandRgb("dark"), [96, 165, 250], "#60a5fa — 7.79:1 on near-black");
  assert.deepEqual(brandRgb("light"), [29, 78, 216], "#1d4ed8 — 6.42:1 on near-white, the tile's own blue");
  assert.notDeepEqual(brandRgb("dark"), brandRgb("light"), "a single blue cannot serve both grounds");
});

test("setTheme flips the default ground, and back", () => {
  const before = brandRgb();
  try {
    setTheme("light");
    assert.deepEqual(brandRgb(), [29, 78, 216], "--light reaches the paint");
    setTheme("dark");
    assert.deepEqual(brandRgb(), [96, 165, 250]);
  } finally {
    setTheme(before[0] === 29 ? "light" : "dark"); // never leak theme state into a sibling test
  }
});

// ── parseChoice: the connect-menu validator. Enter alone must never select —
// picking an identity path is consent, and silence is not consent. ──────────────

test("parseChoice accepts each in-range selection", () => {
  assert.equal(parseChoice("1", 3), 1);
  assert.equal(parseChoice("3", 3), 3);
  assert.equal(parseChoice("  2  ", 3), 2, "surrounding whitespace is a typo, not a different answer");
});

test("parseChoice rejects the empty answer (Enter is not a choice)", () => {
  assert.equal(parseChoice("", 3), null);
  assert.equal(parseChoice("   ", 3), null);
});

test("parseChoice rejects out-of-range numbers", () => {
  assert.equal(parseChoice("0", 3), null);
  assert.equal(parseChoice("4", 3), null);
});

test("parseChoice rejects non-numeric and mixed input", () => {
  assert.equal(parseChoice("y", 3), null);
  assert.equal(parseChoice("one", 3), null);
  assert.equal(parseChoice("1x", 3), null);
  assert.equal(parseChoice("-1", 3), null, "a sign is not a digit — negative selection is garbage");
  assert.equal(parseChoice("1.5", 3), null);
});

test("clampLine returns short lines unchanged", () => {
  assert.equal(clampLine("hello", 80), "hello");
});

test("clampLine keeps a line one short of the width unchanged (widest safe line)", () => {
  const s = "x".repeat(79);
  assert.equal(clampLine(s, 80), s);
});

test("clampLine truncates a line at exactly the terminal width (wrap trigger)", () => {
  const out = clampLine("x".repeat(80), 80);
  assert.equal(out.length, 79);
  assert.ok(out.endsWith("..."));
});

test("clampLine truncates the real 0.5.5 monitor line to fit a 190-col PowerShell", () => {
  const line =
    "  Deploy Forward Live v0.5.5 | 150m 20s | Synced 1 session(s). Watching for new sessions... next sync in 20s | " +
    "@octocat | files Claude 85 / Codex 58 | sessions Claude 65 / Codex 58 | last 1m ago | +1 session(s)";
  assert.ok(line.length >= 190, "reproduction line must be wider than the terminal");
  const out = clampLine(line, 190);
  assert.equal(out.length, 189);
  assert.ok(out.endsWith("..."));
});

test("clampLine survives tiny widths without going negative", () => {
  assert.equal(clampLine("hello world", 4), "hel");
  assert.equal(clampLine("hello world", 1), "");
});

test("clampLine passes through when width is unknown (piped stdout)", () => {
  const s = "x".repeat(500);
  assert.equal(clampLine(s, undefined), s);
});
