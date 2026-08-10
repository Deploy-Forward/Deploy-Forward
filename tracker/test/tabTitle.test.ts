/**
 * D23 — "the tab is a surface" (docs/context-capacity-plan.md, RULED 2026-07-19).
 * The terminal tab title (OSC 0, already written by setTitle) becomes an ANIMATED
 * surface across three phases: an animated pulse during preload/loading, the live
 * ticker's compact numbers while the watch runs, and a settled plain wordmark —
 * plus OSC 9;4 taskbar/tab progress for determinate phases, always cleared on
 * settle and on exit. This suite is TEST-FIRST: none of the seams below exist yet
 * in src/superStart.ts. A separate code-author pass makes this green. Run:
 *   npx tsx --test test/tabTitle.test.ts
 *
 * ---- Seams this suite requires src/superStart.ts to export (designed here,
 * ---- built by the code author; kept intentionally small and pure where possible
 * ---- so the throttle/OSC-format math is testable without a real terminal) ----
 *
 * `PULSE` — the existing preloader pulse glyph table (superStart.ts ~line 2116),
 *   gains an `export` so this suite pins frame-cycling against the REAL glyphs
 *   instead of a second, driftable copy.
 *
 * `composeTabTitle(state: TabTitleState): string` — PURE. Three phases:
 *   - `{ phase: "loading", frame, phaseLabel }` -> "<PULSE[frame % PULSE.length]>
 *     deploy-forward · <phaseLabel>" (frame indexes the SAME glyph table the
 *     preloader's spinner line already cycles).
 *   - `{ phase: "live", delta? }` -> when `delta` carries `tokens > 0`:
 *     "deploy-forward · +<formatCompact(tokens)>" and, only when `spendUsd` is
 *     priced and > 0, " · <formatCostUsd(spendUsd)>" appended (mirrors the hero's
 *     own delta chip and the marquee's number painting — no new formatting
 *     invented). No delta, an undefined/null delta, or a zero-token delta all
 *     settle to the bare wordmark — never a stale "+0" or a dangling separator.
 *   - `{ phase: "settled" }` -> "deploy-forward", always.
 *
 * `createTitleWriter(io: ShowcaseIO, now: () => number): (title: string) => void`
 *   — a STATEFUL wrapper around `setTitle`'s OSC 0 write. Two independent guards,
 *   both required: (a) throttle — at most one write per 500ms of the INJECTED
 *   clock (never `Date.now` — tests must control it exactly); a title offered
 *   inside the window is DROPPED, not queued, so the next call still measures
 *   from the last WRITE, not from the drop; (b) dedup — a title identical to the
 *   one last WRITTEN never re-fires the escape sequence, even long after the
 *   throttle window has passed (a settled tab must not flicker). Non-TTY `io`
 *   never writes, full stop (the existing setTitle rule, carried into the
 *   wrapper).
 *
 * `composeProgressOsc(pct: number | null): string` — PURE. `pct !== null`
 *   (determinate) -> `ESC ] 9 ; 4 ; 1 ; <clamped 0-100, rounded> BEL`; `null`
 *   (settle / exit) -> the clear, `ESC ] 9 ; 4 ; 0 ; BEL`. Windows Terminal
 *   renders this in the tab AND the taskbar; other terminals silently ignore an
 *   unknown OSC (already the project's stance on OSC 8/0).
 *
 * `writeProgress(io: ShowcaseIO, pct: number | null): void` — writes
 *   `composeProgressOsc(pct)` to `io`, gated the same way as the title writer:
 *   nothing reaches a non-TTY `io`.
 *
 * ---- The wiring contract this suite's integration test pins (not unit-tested
 * ---- in isolation, because it is a sequencing property of runSuperStart) ----
 * On exit (q / Ctrl-C -> withFullScreen's restore path, superStart.ts ~line
 * 2553's `setTitle(io, "deploy-forward")`), the run MUST ALSO emit the OSC 9;4
 * clear, in this order: progress clear FIRST, then the plain title reset —
 * UNCONDITIONALLY, regardless of what phase (loading / live / settled) the
 * watch was in when quit landed. A live ticker title must never be the last
 * thing left in a closed tab.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLine } from "./fixtures.ts";
import { PARSER_EPOCH } from "../src/config.ts";
import { formatCompact, formatCostUsd } from "../src/usageView.ts";
import {
  PULSE,
  composeTabTitle,
  createTitleWriter,
  composeProgressOsc,
  writeProgress,
  runSuperStart,
  type ShowcaseIO,
} from "../src/superStart.ts";

// ---- a tiny injectable clock -------------------------------------------------------------------

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

function plainIO(isTTY: boolean): { io: ShowcaseIO; writes: string[] } {
  const writes: string[] = [];
  const io: ShowcaseIO = { write: (s) => writes.push(s), isTTY, rows: () => 24, cols: () => 80 };
  return { io, writes };
}

// ---- 1. the title composer: loading / live / settled -------------------------------------------

test("composeTabTitle loading: cycles the EXISTING PULSE glyphs by frame index", () => {
  for (let i = 0; i < PULSE.length; i++) {
    assert.equal(
      composeTabTitle({ phase: "loading", frame: i, phaseLabel: "reading local agent history" }),
      `${PULSE[i]} deploy-forward · reading local agent history`,
      `frame ${i}`,
    );
  }
});

test("composeTabTitle loading: frame indexing WRAPS past the glyph table's length", () => {
  assert.equal(
    composeTabTitle({ phase: "loading", frame: PULSE.length, phaseLabel: "x" }),
    `${PULSE[0]} deploy-forward · x`,
    "one full lap lands back on glyph 0",
  );
  assert.equal(
    composeTabTitle({ phase: "loading", frame: PULSE.length * 3 + 2, phaseLabel: "x" }),
    `${PULSE[2]} deploy-forward · x`,
    "several laps still resolve to frame % length",
  );
});

test("composeTabTitle live: mirrors the delta ticker's own compact numbers, tokens + priced spend", () => {
  assert.equal(
    composeTabTitle({ phase: "live", delta: { tokens: 388_000, spendUsd: 2.47 } }),
    `deploy-forward · +${formatCompact(388_000)} · ${formatCostUsd(2.47)}`,
  );
});

test("composeTabTitle live: unpriced spend (null) drops the dollar clause, no dangling separator", () => {
  const title = composeTabTitle({ phase: "live", delta: { tokens: 12_000, spendUsd: null } });
  assert.equal(title, `deploy-forward · +${formatCompact(12_000)}`);
  assert.ok(!title.endsWith("·"), "never a trailing separator with nothing after it");
});

test("composeTabTitle live: a priced-but-zero spend also drops the dollar clause", () => {
  assert.equal(
    composeTabTitle({ phase: "live", delta: { tokens: 5_000, spendUsd: 0 } }),
    `deploy-forward · +${formatCompact(5_000)}`,
  );
});

test("composeTabTitle live: no delta, an explicit null/undefined delta, or a zero-token delta all settle to the bare wordmark", () => {
  assert.equal(composeTabTitle({ phase: "live" }), "deploy-forward");
  assert.equal(composeTabTitle({ phase: "live", delta: undefined }), "deploy-forward");
  assert.equal(composeTabTitle({ phase: "live", delta: null }), "deploy-forward");
  assert.equal(composeTabTitle({ phase: "live", delta: { tokens: 0, spendUsd: 1.2 } }), "deploy-forward", "no burn yet — never a stale +0");
});

test("composeTabTitle settled: the plain wordmark, always", () => {
  assert.equal(composeTabTitle({ phase: "settled" }), "deploy-forward");
});

// ---- 2. throttled title writer: 500ms-per-write, never a repeat write --------------------------

test("createTitleWriter: writes immediately on the first call", () => {
  const { io, writes } = plainIO(true);
  const clock = fakeClock(0);
  const writeTitle = createTitleWriter(io, clock.now);
  writeTitle("deploy-forward · +1.0K");
  assert.deepEqual(writes, ["\x1b]0;deploy-forward · +1.0K\x07"]);
});

test("createTitleWriter: a second, DIFFERENT title inside the 500ms window is dropped, not queued", () => {
  const { io, writes } = plainIO(true);
  const clock = fakeClock(0);
  const writeTitle = createTitleWriter(io, clock.now);
  writeTitle("A");
  clock.advance(100);
  writeTitle("B");
  assert.deepEqual(writes, ["\x1b]0;A\x07"], "B never reached the wire — still inside the throttle window");
});

test("createTitleWriter: the NEXT eligible write measures from the last WRITE, not from a dropped attempt", () => {
  const { io, writes } = plainIO(true);
  const clock = fakeClock(0);
  const writeTitle = createTitleWriter(io, clock.now);
  writeTitle("A"); // t=0, written
  clock.advance(100);
  writeTitle("B"); // t=100, dropped (only 100ms since the last write)
  clock.advance(100);
  writeTitle("C"); // t=200, still dropped (only 200ms since the last write)
  clock.advance(300);
  writeTitle("D"); // t=500, 500ms since the LAST WRITE (t=0) -> eligible
  assert.deepEqual(writes, ["\x1b]0;A\x07", "\x1b]0;D\x07"], "B and C never fired; D fires at exactly 500ms since A");
});

test("createTitleWriter: a burst of many different titles inside one window still coalesces to exactly one write", () => {
  const { io, writes } = plainIO(true);
  const clock = fakeClock(0);
  const writeTitle = createTitleWriter(io, clock.now);
  for (const t of ["1", "2", "3", "4", "5"]) writeTitle(t);
  clock.advance(499);
  writeTitle("6");
  assert.deepEqual(writes, ["\x1b]0;1\x07"], "the tab must never flicker — one write per 500ms window, no exceptions");
});

test("createTitleWriter: never re-fires an IDENTICAL title, even long after the throttle window has passed", () => {
  const { io, writes } = plainIO(true);
  const clock = fakeClock(0);
  const writeTitle = createTitleWriter(io, clock.now);
  writeTitle("deploy-forward");
  clock.advance(10_000); // ten full throttle windows later
  writeTitle("deploy-forward"); // identical to what's already shown
  assert.deepEqual(writes, ["\x1b]0;deploy-forward\x07"], "a settled title must not re-fire the escape sequence forever");
});

test("createTitleWriter: a DIFFERENT title after a long-repeated one still writes once eligible", () => {
  const { io, writes } = plainIO(true);
  const clock = fakeClock(0);
  const writeTitle = createTitleWriter(io, clock.now);
  writeTitle("deploy-forward");
  clock.advance(10_000);
  writeTitle("deploy-forward"); // deduped
  writeTitle("deploy-forward · +2.0K"); // different — and well past the throttle window
  assert.deepEqual(writes, ["\x1b]0;deploy-forward\x07", "\x1b]0;deploy-forward · +2.0K\x07"]);
});

// ---- 3. OSC 9;4 progress: determinate + clear ---------------------------------------------------

test("composeProgressOsc: determinate progress is ESC ] 9 ; 4 ; 1 ; <pct> BEL", () => {
  assert.equal(composeProgressOsc(0), "\x1b]9;4;1;0\x07");
  assert.equal(composeProgressOsc(42), "\x1b]9;4;1;42\x07");
  assert.equal(composeProgressOsc(100), "\x1b]9;4;1;100\x07");
});

test("composeProgressOsc: clamps to 0-100 and rounds a fractional pct", () => {
  assert.equal(composeProgressOsc(142), "\x1b]9;4;1;100\x07", "never a progress value over 100");
  assert.equal(composeProgressOsc(-5), "\x1b]9;4;1;0\x07", "never a negative progress value");
  assert.equal(composeProgressOsc(33.6), "\x1b]9;4;1;34\x07", "rounds, not truncates");
});

test("composeProgressOsc: null composes the settle/clear state, 9;4;0", () => {
  assert.equal(composeProgressOsc(null), "\x1b]9;4;0;\x07");
});

test("writeProgress: writes the composed OSC 9;4 sequence to a TTY io, determinate then clear", () => {
  const { io, writes } = plainIO(true);
  writeProgress(io, 50);
  writeProgress(io, null);
  assert.deepEqual(writes, ["\x1b]9;4;1;50\x07", "\x1b]9;4;0;\x07"]);
});

// ---- 4. piped/non-TTY: the composer may run, but no OSC write ever reaches the wire -------------

test("piped/non-TTY: the title writer composes but never writes — the guard, not the composer, is what's tested here", () => {
  const { io, writes } = plainIO(false);
  const writeTitle = createTitleWriter(io, () => 0);
  const title = composeTabTitle({ phase: "loading", frame: 0, phaseLabel: "reading local agent history" });
  assert.ok(title.length > 0, "the composer itself has no TTY opinion — it still produces a title");
  writeTitle(title);
  writeTitle(composeTabTitle({ phase: "live", delta: { tokens: 5_000, spendUsd: 1 } }));
  assert.deepEqual(writes, [], "no OSC 0 write reaches a non-TTY io, ever — the existing setTitle rule");
});

test("piped/non-TTY: the progress writer composes but never writes either", () => {
  const { io, writes } = plainIO(false);
  writeProgress(io, 50);
  writeProgress(io, null);
  assert.deepEqual(writes, [], "no OSC 9;4 write reaches a non-TTY io");
});

// ---- 5. exit restore: the OSC trail ALWAYS ends clear-then-plain-title -------------------------

function pinnedEnv(home: string, projects: string): Record<string, string | undefined> {
  const prev: Record<string, string | undefined> = {};
  const pins: Record<string, string> = {
    DF_HOME: home,
    DF_CLAUDE_PROJECTS: projects,
    DF_CODEX_SESSIONS: join(projects, "no-codex-here"),
    DF_GROK_HOME: join(projects, "no-grok-here"),
    DF_PI_HOME: join(projects, "no-pi-here"),
    DF_OPENCLAW_HOME: join(projects, "no-openclaw-here"),
    DF_OPENCODE_HOME: join(projects, "no-opencode-here"),
    DF_HERMES_HOME: join(projects, "no-hermes-here"),
    DF_COPILOT_HOME: join(projects, "no-copilot-here"),
  };
  for (const [k, v] of Object.entries(pins)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  return prev;
}

function restoreEnv(prev: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** A minimal non-empty corpus + a state.json under test control (unpaired — the read-only
 * path, so no network is ever touched by this suite; the tab-surface contract does not
 * depend on push state). */
function seedCorpus(): { home: string; projects: string } {
  const home = mkdtempSync(join(tmpdir(), "df-tabtitle-home-"));
  const projects = mkdtempSync(join(tmpdir(), "df-tabtitle-projects-"));
  const proj = join(projects, "proj1");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "s-aaa.jsonl"),
    claudeLine({ sessionId: "s-aaa", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
  );
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://127.0.0.1:1/api",
      deviceToken: null,
      uid: null,
      handle: null,
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
    }),
  );
  return { home, projects };
}

/** A real interactive full-screen takeover that auto-presses `q` once the takeover's own
 * key listener actually exists (deterministic — no race with setup), mirroring
 * test/superStartOnboarding.test.ts's fakeInteractiveIO. */
function fakeInteractiveIO(quitAfterMs = 300): { io: ShowcaseIO; writes: string[] } {
  const writes: string[] = [];
  let dataListener: ((d: Buffer) => void) | null = null;
  const io: ShowcaseIO = {
    write: (s) => writes.push(s),
    isTTY: true,
    rows: () => 40,
    cols: () => 120,
    input: {
      isTTY: true,
      setRawMode: () => {},
      on: (e, f) => {
        if (e === "data") {
          dataListener = f;
          setTimeout(() => dataListener?.(Buffer.from("q")), quitAfterMs);
        }
      },
      off: () => {
        dataListener = null;
      },
      resume: () => {},
      pause: () => {},
    },
    onResize: () => () => {},
  };
  return { io, writes };
}

/** Every OSC 0 (title) and OSC 9;4 (progress) sequence in the raw write log, in the
 * order they were written — everything else (CSI cursor/paint codes, plain text) is
 * noise for this test and is filtered out. */
function extractTabSurfaceOsc(raw: string): string[] {
  return raw.match(/\x1b\](?:0;[^\x07]*|9;4;[^\x07]*)\x07/g) ?? [];
}

test("exit restore: q ALWAYS ends the OSC trail with the 9;4 clear, then a plain title reset — never a stale ticker title", async () => {
  const { home, projects } = seedCorpus();
  const prev = pinnedEnv(home, projects);
  try {
    const { io, writes } = fakeInteractiveIO(300);
    await runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z") }, io);
    const raw = writes.join("");
    const osc = extractTabSurfaceOsc(raw);
    assert.ok(osc.length >= 2, "at minimum, a progress clear and a title reset were written on exit");
    assert.equal(osc.at(-1), "\x1b]0;deploy-forward\x07", "the LAST title write leaving the tab is the bare wordmark");
    assert.equal(
      osc.at(-2),
      "\x1b]9;4;0;\x07",
      "and immediately before it, the OSC 9;4 clear — the taskbar/tab progress must not survive a closed watch",
    );
  } finally {
    restoreEnv(prev);
  }
});

test("exit restore: even a near-instant quit (before any determinate progress could plausibly show) still leaves a clean trail", async () => {
  const { home, projects } = seedCorpus();
  const prev = pinnedEnv(home, projects);
  try {
    const { io, writes } = fakeInteractiveIO(5);
    await runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z") }, io);
    const osc = extractTabSurfaceOsc(writes.join(""));
    assert.equal(osc.at(-1), "\x1b]0;deploy-forward\x07", "regardless of prior phase, exit always resets the title");
    assert.equal(osc.at(-2), "\x1b]9;4;0;\x07", "regardless of prior phase, exit always clears the progress state");
  } finally {
    restoreEnv(prev);
  }
});
