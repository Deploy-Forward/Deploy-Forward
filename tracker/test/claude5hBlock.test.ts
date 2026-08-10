/**
 * Pins the correct Claude 5h-window semantics for computeCurrent5hBlock / formatClaude5hLine
 * (src/usageView.ts ~586-620, ~715-721), per the field report 2026-07-19 on published 0.22.1:
 * the CLAUDE 5H estimate line showed "window closed, last activity 21:35" while the user was
 * ACTIVELY in a Claude session.
 *
 * TWO DEFECTS pinned here, TEST-ONLY (no production code changed in this file):
 *
 * Defect 1 -- boundary rule. computeCurrent5hBlock currently cuts blocks on a gap >= 5h between
 * CONSECUTIVE entries. Anthropic's actual semantics: a window opens at its first message and
 * EXPIRES 5h later; the next message at/after expiry opens a NEW window. Under continuous
 * activity (no 5h gap all day) the gap rule never advances blockStart, so `now - blockStart`
 * eventually exceeds 5h and `active` goes false while the user is mid-session -- exactly the
 * bug report. Correct rule: walking entries ascending, an entry at ts >= anchor + windowMs
 * starts a new block anchored at THAT entry; this must apply iteratively, not just check the
 * gap to the immediately-previous entry.
 *
 * Defect 2 -- closed-window label. formatClaude5hLine's closed branch renders
 * hhmm(block.blockStartMs) labeled "last activity", which is wrong: it's the window's START,
 * not the last thing the user did. Closed messages must carry the LAST entry's timestamp.
 * This file pins the seam for that fix as a new `lastEntryMs` field on Claude5hBlock.
 *
 * Namespace import (UV) for containment: this file owns its own view onto usageView.ts so it
 * doesn't need to touch the existing named-import list in usageView.test.ts.
 *
 * Some assertions below are RED against the current (buggy) implementation by design -- that's
 * the point of a test-first pin. All pre-existing tests are unaffected and stay green.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as UV from "../src/usageView.ts";

const H = 60 * 60 * 1000;

/** Mirrors src/usageView.ts's private (unexported) hhmm() exactly, so expected strings are
 * derived the same way the production formatter derives them -- no hardcoded, timezone-fragile
 * literals. */
function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---- 1. Continuous activity spanning >5h: must stay ACTIVE (the field-report bug) -------------

test("computeCurrent5hBlock: continuous activity every 30min for 8h stays ACTIVE, anchored at the expiry boundary, not the gap rule", () => {
  const t0 = Date.parse("2026-07-05T09:00:00.000Z");
  const STEP = 30 * 60_000;
  const entries: { ts: number; total: number }[] = [];
  for (let m = 0; m <= 8 * H; m += STEP) entries.push({ ts: t0 + m, total: 100 });
  const lastEntryMs = t0 + 8 * H;
  const now = lastEntryMs + 60_000; // still mid-session, 1 minute after the latest message

  const block = UV.computeCurrent5hBlock(entries, now);
  assert.ok(block);

  // Correct anchor: the first entry at/after firstEntry + 5h = t0 + 300min (a 30min-grid point).
  assert.equal(block!.blockStartMs, t0 + 5 * H, "block should re-anchor at the expiry boundary entry, not stay pinned to the first entry");

  // Only entries from the re-anchored boundary onward count (7 entries * 100 = 700), not the
  // whole 8h corpus.
  assert.equal(block!.tokensUsed, 700, "tokensUsed must be scoped to the CURRENT (re-anchored) block only");

  // The core regression: under continuous activity with no >=5h gap between consecutive
  // entries, the OLD gap-only rule never advances blockStart, so `now (t0+481m) - blockStart
  // (t0)` = 481min >= 300min and active would go FALSE even though the user just sent a
  // message a minute ago. Correct semantics: active.
  assert.equal(block!.active, true, "a builder continuously active for >5h must still read as ACTIVE, never falsely closed");

  assert.equal(block!.resetMs, t0 + 10 * H, "resets 5h after the re-anchored block start, not the original first-message time");
});

// ---- 2. A lone recent entry, well within 5h: active, tokensUsed correct -----------------------

test("computeCurrent5hBlock: now inside 5h of a lone recent entry reads active with correct tokensUsed", () => {
  const t0 = Date.parse("2026-07-05T09:00:00.000Z");
  const block = UV.computeCurrent5hBlock([{ ts: t0, total: 500 }], t0 + 2 * H);
  assert.ok(block);
  assert.equal(block!.active, true);
  assert.equal(block!.tokensUsed, 500);
  assert.equal(block!.blockStartMs, t0);
});

// ---- 3. Genuinely closed window: message must show the LAST entry's time, not blockStart's ----

test("formatClaude5hLine: a genuinely closed window (>5h since last activity) labels the LAST entry's time, honestly, not the block start", () => {
  const t0 = Date.parse("2026-07-05T10:00:00.000Z"); // window opens here
  const lastEntryMs = t0 + 1 * H; // last real activity, one hour later, same block (gap < 5h)
  const now = lastEntryMs + 6 * H; // 6h since the last message -- definitively closed

  const block = UV.computeCurrent5hBlock(
    [
      { ts: t0, total: 10 },
      { ts: lastEntryMs, total: 20 },
    ],
    now,
  );
  assert.ok(block);
  assert.equal(block!.active, false);

  // Pin the seam: Claude5hBlock must carry the block's LAST entry timestamp so the closed
  // message can be honest about "last activity", distinct from blockStartMs.
  assert.equal((block as unknown as { lastEntryMs: number }).lastEntryMs, lastEntryMs, "Claude5hBlock must expose the block's last entry timestamp");

  const line = UV.formatClaude5hLine(block);
  assert.match(line, /last activity/, 'closed message must keep saying "last activity"');
  assert.ok(line.includes(hhmm(lastEntryMs)), `closed message must show the LAST entry's time (${hhmm(lastEntryMs)}): got "${line}"`);
  assert.ok(!line.includes(hhmm(t0)), `closed message must NOT show the block-START time (${hhmm(t0)}) as "last activity": got "${line}"`);
});

// ---- 4. Gap-based split still holds where it agrees with expiry semantics ---------------------

test("computeCurrent5hBlock: a real >=5h gap between entries still opens a new block, anchored at the later entry", () => {
  const t0 = 0;
  const entries = [
    { ts: t0, total: 1000 },
    { ts: t0 + 6 * H, total: 40 },
  ];
  const block = UV.computeCurrent5hBlock(entries, t0 + 6 * H + 20 * 60_000);
  assert.ok(block);
  assert.equal(block!.blockStartMs, t0 + 6 * H);
  assert.equal(block!.tokensUsed, 40, "the old block's entry must not bleed into the new one");
  assert.equal(block!.active, true);
});

// ---- 5. Empty entries -> null (unchanged) ------------------------------------------------------

test("computeCurrent5hBlock: empty entries yields null", () => {
  assert.equal(UV.computeCurrent5hBlock([], Date.now()), null);
});

// ---- 6. Iterative anchoring across several boundary crossings ---------------------------------

test("computeCurrent5hBlock: iterative anchoring -- entries at 0h,2h,6h,11h anchor at 0h, then 6h, then 11h", () => {
  const t0 = 0;
  const e0 = { ts: t0, total: 10 };
  const e2 = { ts: t0 + 2 * H, total: 20 };
  const e6 = { ts: t0 + 6 * H, total: 40 };
  const e11 = { ts: t0 + 11 * H, total: 80 };

  // 2h joins the 0h block: 2h < 0h + 5h, no boundary crossed yet.
  const withTwo = UV.computeCurrent5hBlock([e0, e2], t0 + 2 * H + 10 * 60_000);
  assert.ok(withTwo);
  assert.equal(withTwo!.blockStartMs, t0, "2h stays inside the 0h block");
  assert.equal(withTwo!.tokensUsed, 30);

  // 6h >= 0h + 5h: must re-anchor at 6h EVEN THOUGH the gap from the immediately-previous
  // entry (2h) is only 4h. This is the case a gap-only rule gets wrong: it checks proximity to
  // the previous message, not expiry from the block's own anchor.
  const withSix = UV.computeCurrent5hBlock([e0, e2, e6], t0 + 6 * H + 10 * 60_000);
  assert.ok(withSix);
  assert.equal(withSix!.blockStartMs, t0 + 6 * H, "6h must re-anchor the block on expiry from the 0h anchor, independent of the 4h gap since the 2h entry");
  assert.equal(withSix!.tokensUsed, 40, "only the re-anchored block's own entry counts, not the carried-over 0h+2h entries");

  // 11h >= 6h + 5h: re-anchor again, at 11h.
  const withEleven = UV.computeCurrent5hBlock([e0, e2, e6, e11], t0 + 11 * H + 10 * 60_000);
  assert.ok(withEleven);
  assert.equal(withEleven!.blockStartMs, t0 + 11 * H, "11h must re-anchor again on expiry from the 6h anchor");
  assert.equal(withEleven!.tokensUsed, 80);
});

// ---- 7. Regression: the active-path message wording is unchanged ------------------------------

test("formatClaude5hLine: active-path wording (tokens used / window opened / resets ~) is unchanged by the closed-path fix", () => {
  const t0 = Date.parse("2026-07-05T10:00:00.000Z");
  const block = UV.computeCurrent5hBlock([{ ts: t0, total: 12_345 }], t0 + 30 * 60_000);
  const line = UV.formatClaude5hLine(block);
  assert.match(line, /^Claude session \(5h window, est\., whole-corpus\): 12\.3K tokens used, window opened \d{2}:\d{2}, resets ~\d{2}:\d{2}$/);
  assert.equal(UV.formatClaude5hLine(null), "Claude session (5h window, est., whole-corpus): no recent activity");
});
