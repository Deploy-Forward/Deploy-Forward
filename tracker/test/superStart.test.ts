/**
 * `deploy-forward super-start` — the full-screen read-only showcase
 * (docs/super-start-showcase-spec.md). Tests the PURE parts (layout math, chart
 * builders, frame composition) plus the spec's hard invariants: the no-mutation
 * contract (state.json byte-identical across a full read + static run), the
 * non-TTY plain-text degradation (no escape codes, ever), the guaranteed
 * terminal-restore sequence, and the honest empty state. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLine, CODEX_FIXTURE } from "./fixtures.ts";
import { PARSER_EPOCH } from "../src/config.ts";
import { TRACKER_VERSION } from "../src/sync.ts";
import { staleVersionBanner } from "../src/update.ts";
import {
  formatComma,
  easeOutCubic,
  niceCeil,
  moneyTick,
  moneyExact,
  bigDigitLines,
  mixBarSegments,
  tickerText,
  tickerWindow,
  shortModel,
  liveSessionChartLines,
  probeActivity,
  newProbeCache,
  normalizeKey,
  SUPER_START_ACTIONS,
  barChartLines,
  composeScreen,
  settledPlainText,
  readShowcaseData,
  runSuperStart,
  withFullScreen,
  type ShowcaseData,
  type ShowcaseIO,
} from "../src/superStart.ts";

const ANSI = /\[[0-9;?]*[a-zA-Z]/g;
/** OSC 8 hyperlinks: ESC ] 8 ;; URL BEL ... ESC ] 8 ;; BEL. They cost ZERO visible
 * cells, so the frame's exact-width assertions only hold if these are stripped too. */
const OSC = /\]8;;[^]*/g;
const strip = (s: string): string => s.replace(OSC, "").replace(ANSI, "");

// ---- pure builders ---------------------------------------------------------------------------

test("formatComma groups digits", () => {
  assert.equal(formatComma(0), "0");
  assert.equal(formatComma(999), "999");
  assert.equal(formatComma(1234), "1,234");
  assert.equal(formatComma(10_412_388_204), "10,412,388,204");
});

test("easeOutCubic lands exactly on 0 and 1", () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.ok(easeOutCubic(0.5) > 0.5, "ease-OUT: front-loaded");
});

test("niceCeil picks a round ceiling at or above the max", () => {
  for (const [input, expected] of [
    [0.7, 1],
    [1, 1],
    [1.3, 2],
    [3.2, 5],
    [6, 10],
    [12, 20],
    [130, 200],
    [1130, 2000],
  ] as const) {
    assert.equal(niceCeil(input), expected, `niceCeil(${input})`);
  }
  assert.equal(niceCeil(0), 0, "an all-zero series has no ceiling to invent");
});

test("moneyTick renders round dollar ticks", () => {
  assert.equal(moneyTick(0), "$0");
  assert.equal(moneyTick(600), "$600");
  assert.equal(moneyTick(1200), "$1.2k");
  assert.equal(moneyTick(2000), "$2k");
});

test("moneyExact: grouped whole dollars at scale, cell precision below, + marks a floor", () => {
  assert.equal(moneyExact(14238), "$14,238");
  assert.equal(moneyExact(14238.4, true), "$14,238+");
  assert.equal(moneyExact(3.2), "$3.20");
  assert.equal(moneyExact(0.0063), "$0.0063", "a real tiny cost never reads as $0.00");
});

test("mixBarSegments: cells sum EXACTLY to the width, shares proportional, tail folds", () => {
  const rows = [
    { model: "a", total: 500 },
    { model: "b", total: 300 },
    { model: "c", total: 100 },
    { model: "d", total: 60 },
    { model: "e", total: 30 },
    { model: "f", total: 10 },
  ];
  const segs = mixBarSegments(rows, 40);
  assert.equal(segs.reduce((s, x) => s + x.cells, 0), 40, "no ragged end, no lost cell");
  assert.equal(segs[0].model, "a");
  assert.equal(segs[0].sharePct, 50);
  assert.equal(segs[0].cells, 20, "half the tokens = half the bar");
  const tail = segs.at(-1)!;
  assert.equal(tail.model, "+2 more", "models beyond the density ramp fold into one labeled tail");
  assert.equal(tail.glyph, "·");
  assert.deepEqual(mixBarSegments([], 40), [], "no models, no bar");
  assert.deepEqual(mixBarSegments([{ model: "a", total: 0 }], 40), [], "zero total, no invented bar");
});

test("bigDigitLines: 5 equal-width plain rows for every compact figure shape", () => {
  for (const s of ["0", "10.2B", "482.1M", "999", "4.5K", "$14.2K"]) {
    const rows = bigDigitLines(s);
    assert.equal(rows.length, 5, `${s}: five glyph rows`);
    const widths = new Set(rows.map((r) => r.length));
    assert.equal(widths.size, 1, `${s}: rectangular band (widths ${[...widths]})`);
    for (const r of rows) assert.equal(strip(r), r, `${s}: plain glyphs only`);
  }
  assert.ok(bigDigitLines("10.2B").some((r) => r.includes("█")), "block glyphs actually render");
});

// ---- barChartLines: tick-ladder chart, plain glyphs only (no ANSI by construction) ------------

test("barChartLines: exact height, bars scale to the nice max, baseline present", () => {
  const lines = barChartLines([0, 5, 10], { height: 4, width: 30, tick: String });
  assert.equal(lines.length, 5, "height body rows + 1 baseline row");
  for (const l of lines) assert.equal(strip(l), l, "chart builder emits no ANSI");
  const body = lines.slice(0, 4).join("\n");
  assert.ok(body.includes("█"), "a full-height column exists (10 of nice-max 10)");
  const baseline = lines[4];
  assert.ok(baseline.includes("┼"), "axis corner on the baseline");
  assert.ok(baseline.includes("─"), "baseline rail");
  // Column 1 (value 0) paints NOTHING above the baseline — a real zero, not a fabricated bar.
  const colCells = lines.slice(0, 4).map((l) => strip(l).charAt(strip(baseline).indexOf("┼") + 2));
  assert.ok(colCells.every((c) => c === " " || c === ""), "zero-value column stays empty");
});

test("barChartLines: top tick labels the nice max, bottom labels zero", () => {
  const lines = barChartLines([120, 480, 990], { height: 6, width: 40, tick: moneyTick });
  assert.ok(strip(lines[0]).trimStart().startsWith("$1k"), `top tick is the nice ceiling: ${lines[0]}`);
  assert.ok(strip(lines[6]).trimStart().startsWith("$0"), "baseline tick is $0");
});

test("barChartLines: all-zero series draws an empty track, never an invented bar", () => {
  const lines = barChartLines([0, 0, 0], { height: 3, width: 20, tick: String });
  const body = lines.slice(0, 3).join("");
  assert.ok(!body.includes("█") && !body.includes("▁"), "no glyphs from nothing");
});

// ---- composeScreen: full-screen frame discipline -----------------------------------------------

const DATA: ShowcaseData = {
  harnesses: [
    { name: "Claude Code", sessions: 1204 },
    { name: "Codex", sessions: 311 },
    { name: "Copilot", sessions: 64 },
  ],
  totalSessions: 1579,
  tokenTotal: 10_412_388_204,
  modelRows: [
    { model: "claude-opus-4-8", input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 9_000_000_000 },
    { model: "claude-sonnet-4", input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 1_412_388_204 },
  ],
  spendTotalUsd: 14238,
  spendIsPartial: false,
  activeHours: 579,
  topSkill: "frontend-design",
  topAgent: "general-purpose",
  sessions: [
    { key: "claude_code_s1", tool: "Claude Code", model: "claude-opus-4-8", tokens: 9_000_000_000 },
    { key: "codex_s2", tool: "Codex", model: "gpt-5.5", tokens: 1_412_388_204 },
  ],
  days: Array.from({ length: 30 }, (_, i) => ({ day: `2026-06-${String(i + 1).padStart(2, "0")}`, spendUsd: (i % 7) * 40, tokens: (i % 7) * 1e6 })),
  spend30dUsd: 720,
};

test("composeScreen: exactly rows lines, every line exactly cols visible cells", () => {
  for (const p of [0, 0.5, 1]) {
    for (const size of [{ rows: 24, cols: 80 }, { rows: 40, cols: 120 }, { rows: 60, cols: 200 }]) {
      const lines = composeScreen(DATA, size, p);
      assert.equal(lines.length, size.rows, `p=${p} ${size.cols}x${size.rows}: fills the WHOLE screen`);
      for (const [i, l] of lines.entries()) {
        assert.equal(strip(l).length, size.cols, `p=${p} ${size.cols}x${size.rows} line ${i}: exact width (no wrap, no gap)`);
      }
    }
  }
});

test("composeScreen at p=1 shows the exact real totals (motion lands on the truth)", () => {
  const screen = composeScreen(DATA, { rows: 40, cols: 120 }, 1).map(strip).join("\n");
  assert.ok(screen.includes("10,412,388,204"), "token odometer landed on the exact figure");
  assert.ok(screen.includes("1,204"), "Claude Code sessions exact");
  assert.ok(screen.includes("1,579 sessions scanned"), "aggregate summed from the rows");
  assert.ok(screen.includes("3 harnesses"), "harness count = rows shown, never a hardcoded 8");
  assert.ok(screen.includes("$14,238 est spend"), "spend hero landed on the exact figure");
  assert.ok(screen.includes("EST SPEND"), "spend hero labeled");
  assert.ok(screen.includes("this machine · all harnesses"), "token scope names the real boundary");
  assert.ok(screen.includes("Deploy Forward v"), "the full lockup carries name + version on tall screens");
  assert.ok(screen.includes("leaderboard.deployforward.dev"), "and the domain");
  assert.ok(screen.includes("←→ chart"), "the arrow affordance is discoverable, not hidden");
  assert.ok(screen.includes("TOKENS TRACKED"), "the running ticker rides the top rail in lockup mode");
  assert.ok(screen.includes("MODEL MIX"), "full model mix present");
  assert.ok(screen.includes("claude-opus-4-8 86%"), "mix share from real proportions (9.0B of the 10.41B model sum)");
  assert.ok(screen.includes("priced models only"), "spend scope labeled verbatim");
  assert.ok(screen.includes("q to quit"), "controls visible");
});

test("composeScreen renders the live rail and the delta chip", () => {
  const screen = composeScreen(DATA, { rows: 40, cols: 140 }, 1, {
    scanAgoS: 3,
    nextInS: 12,
    delta: { tokens: 2341, spendUsd: 0.04 },
  })
    .map(strip)
    .join("\n");
  assert.ok(screen.includes("● live · scanned 3s ago · next in 12s · ←→ chart · q to quit"), "footer carries the honest cadence + the controls");
  assert.ok(screen.includes("+2.3K tok"), "token delta chip");
  assert.ok(screen.includes("+$0.04"), "spend delta chip");
  const scanning = composeScreen(DATA, { rows: 40, cols: 140 }, 1, { scanAgoS: 15, nextInS: 0, scanning: true })
    .map(strip)
    .join("\n");
  assert.ok(scanning.includes("● scanning local sessions"), "scanning state named while the re-read runs");
});

test("composeScreen live rail claims 'synced' ONLY when the watch actually pushes", () => {
  const pushing = composeScreen(DATA, { rows: 40, cols: 140 }, 1, { scanAgoS: 3, nextInS: 12, pushing: true })
    .map(strip)
    .join("\n");
  assert.ok(pushing.includes("● live · synced 3s ago"), "paired watch says synced");
  const failing = composeScreen(DATA, { rows: 40, cols: 140 }, 1, { scanAgoS: 3, nextInS: 12, pushing: true, note: "sync failed — retrying" })
    .map(strip)
    .join("\n");
  assert.ok(failing.includes("sync failed — retrying"), "a failed push is said, not hidden");
  const local = composeScreen(DATA, { rows: 40, cols: 140 }, 1, { scanAgoS: 3, nextInS: 12 }).map(strip).join("\n");
  assert.ok(local.includes("● live · scanned 3s ago"), "unpaired watch never claims a push");
  assert.ok(!local.includes("synced"), "no sync claim without a sync");
});

test("composeScreen: a stale-version live.updateBanner renders loud and verbatim, and stays absent otherwise", () => {
  const banner = "deploy-forward v0.22.2 is behind v0.22.3 - run: npx --yes deploy-forward@latest";
  const stale = composeScreen(DATA, { rows: 40, cols: 140 }, 1, { scanAgoS: 3, nextInS: 12, updateBanner: banner });
  const strippedLines = stale.map(strip);
  assert.ok(strippedLines.some((l) => l.includes(banner)), "the exact composer banner text renders on screen");
  // Frame exactness holds even with the extra line — no line grows or the screen shrinks.
  assert.equal(stale.length, 40, "still exactly rows lines");
  for (const l of stale) assert.equal(strip(l).length, 140, "still exactly cols visible cells");

  const current = composeScreen(DATA, { rows: 40, cols: 140 }, 1, { scanAgoS: 3, nextInS: 12 }).map(strip).join("\n");
  assert.ok(!current.includes("is behind"), "no live.updateBanner -> nothing printed, never a phantom nag");
});

test("runSuperStart --static NEVER touches the network, even on a paired device", async () => {
  const { home, projects } = seedCorpus();
  // Re-seed the state as a PAIRED device: the push gate is interactivity, not the token.
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://mock.invalid/api",
      deviceToken: "test-token",
      uid: "u1",
      handle: "tester",
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
    }),
  );
  const prev = pinnedEnv(home, projects);
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
  try {
    const before = readFileSync(join(home, "state.json"), "utf8");
    const writes: string[] = [];
    const io: ShowcaseIO = { write: (s) => writes.push(s), isTTY: false, rows: () => 24, cols: () => 80 };
    await runSuperStart({ static: true, now: Date.parse("2026-06-05T00:00:00.000Z") }, io);
    assert.equal(fetchCalls, 0, "a scripted run must never write to the board");
    assert.equal(readFileSync(join(home, "state.json"), "utf8"), before, "and never to local state");
  } finally {
    globalThis.fetch = origFetch;
    restoreEnv(prev);
  }
});

test("composeScreen at p=0 leaks no settled numbers", () => {
  const screen = composeScreen(DATA, { rows: 40, cols: 120 }, 0).map(strip).join("\n");
  assert.ok(!screen.includes("10,412,388,204"), "the odometer has not raced yet");
});

test("composeScreen with no priced usage charts token volume, never an all-$0 spend chart", () => {
  const data: ShowcaseData = { ...DATA, spend30dUsd: null, spendTotalUsd: null, days: DATA.days.map((d) => ({ ...d, spendUsd: 0 })) };
  const screen = composeScreen(data, { rows: 40, cols: 120 }, 1).map(strip).join("\n");
  assert.ok(/TOKEN VOLUME/i.test(screen), "chart metric flips to tokens");
  assert.ok(!/ESTIMATED SPEND/i.test(screen), "no spend header without a priced dollar");
  assert.ok(!screen.includes("est spend"), "no spend hero without a priced dollar");
});

// ---- the live watch: activity probe, session bars, and the no-paths rule -----------------------

test("shortModel drops only the claude- prefix, keeps every id verbatim otherwise", () => {
  assert.equal(shortModel("claude-opus-4-8"), "opus-4-8");
  assert.equal(shortModel("gpt-5.5"), "gpt-5.5", "a foreign id is never re-spelled");
  assert.equal(shortModel("custom/very-long-router-id-xxxxx", 12), "custom/very…", "truncation is marked, never silent");
});

test("liveSessionChartLines: fat labeled bars, values shown, tallest is full height", () => {
  const lines = liveSessionChartLines(
    [
      { label: "claude-opus-4-8", tokens: 900_000 },
      { label: "gpt-5.5", tokens: 300_000 },
    ],
    { height: 6, width: 60 },
  );
  for (const l of lines) assert.equal(strip(l), l, "plain glyphs only — paint is the composer's job");
  const text = lines.join("\n");
  assert.ok(text.includes("█"), "bars render");
  assert.ok(text.includes("┼"), "baseline present");
  assert.ok(text.includes("opus-4-8"), "each bar is labeled by its model");
  assert.ok(text.includes("900.0K"), "and carries its real value");
  assert.ok(!/[\\/]Users|ola|proj/i.test(text), "NEVER a path or project name — this screen gets recorded");
});

test("liveSessionChartLines: nothing burned yet renders no chart at all", () => {
  assert.deepEqual(liveSessionChartLines([], { height: 6, width: 60 }), []);
  assert.deepEqual(liveSessionChartLines([{ label: "m", tokens: 0 }], { height: 6, width: 60 }), [], "a zero delta is not a bar");
});

test("normalizeKey: arrows are matched BEFORE bare-Esc quit (or every arrow would kill the watch)", () => {
  assert.equal(normalizeKey("\x1b[D"), "left", "CSI left");
  assert.equal(normalizeKey("\x1b[C"), "right", "CSI right");
  assert.equal(normalizeKey("\x1bOD"), "left", "SS3 left (application cursor mode)");
  assert.equal(normalizeKey("\x1bOC"), "right", "SS3 right");
  assert.equal(normalizeKey("\x1b"), "quit", "a BARE Esc still quits");
  assert.equal(normalizeKey("q"), "quit");
  assert.equal(normalizeKey("Q"), "quit");
  assert.equal(normalizeKey("\x03"), "quit", "Ctrl-C is a keypress in raw mode");
  assert.equal(normalizeKey("\x1b[A"), "up", "CSI up drives the launcher");
  assert.equal(normalizeKey("\x1b[B"), "down");
  assert.equal(normalizeKey("\x1bOB"), "down", "SS3 down");
  assert.equal(normalizeKey("\r"), "enter", "CR — what Windows Terminal sends");
  assert.equal(normalizeKey("\n"), "enter", "LF — what some *nix terminals send");
  assert.equal(normalizeKey("x"), null, "an unbound key is ignored, never a stray quit");
  assert.equal(normalizeKey("\x1b[Z"), null, "shift-tab is not ours");
});

test("SUPER_START_ACTIONS are read-only views, spelled as real commands", () => {
  assert.ok(SUPER_START_ACTIONS.length > 0);
  for (const a of SUPER_START_ACTIONS) {
    // D16/D17 (2026-07-18) widened the launcher: usage/status stay the read-only views;
    // "settings" is the in-app settings view, "board" the explicit external open-in-
    // browser action. Still nothing that mutates tracked usage data.
    assert.ok(["usage", "status", "settings", "board"].includes(a.argv[0]), `: launcher offers known in-app commands only`);
    // The label must be exactly what runs — the frame promises "deploy-forward <label>".
    assert.equal(a.label, a.argv.join(" "), `${a.label}: label IS the command`);
    assert.ok(a.hint.length > 0, `${a.label}: says what it does`);
  }
});

test("withFullScreen delivers arrows to onKey and never quits on them", async () => {
  const { io, press } = fakeIO();
  const keys: string[] = [];
  await withFullScreen(io, async (ctx) => {
    ctx.onKey((k) => keys.push(k));
    press("\x1b[D");
    press("\x1b[C");
    assert.equal(ctx.quitRequested(), false, "arrows must NOT quit");
    setTimeout(() => press("q"), 5);
    await ctx.waitForQuit();
  });
  assert.deepEqual(keys, ["left", "right"], "both arrows delivered, quit key not");
});

test("withFullScreen: requestQuit ends the watch through the SAME restore path", async () => {
  const { io, writes } = fakeIO();
  await withFullScreen(io, async (ctx) => {
    ctx.requestQuit();
    await ctx.waitForQuit();
    assert.equal(ctx.quitRequested(), true);
  });
  const out = writes.join("");
  assert.ok(out.includes("\x1b[?1049l"), "left the alt screen — a launched command must print to real scrollback");
  assert.ok(out.includes("\x1b[?25h"), "cursor restored before the command runs");
});

test("composeScreen: the launcher shows the exact command ⏎ would run, and wraps", () => {
  const frame = (menuIndex: number): string =>
    composeScreen(DATA, { rows: 44, cols: 130 }, 1, { scanAgoS: 1, nextInS: 14, menuIndex }).map(strip).join("\n");
  const first = frame(0);
  assert.ok(first.includes(`deploy-forward ${SUPER_START_ACTIONS[0].label}`), "spelled as it will run");
  assert.ok(first.includes("↑↓ pick · ⏎ run"), "the affordance is stated");
  assert.ok(first.includes(`1/${SUPER_START_ACTIONS.length}`), "position is shown");
  const second = frame(1);
  assert.ok(second.includes(`deploy-forward ${SUPER_START_ACTIONS[1].label}`), "↓ moves the selection");
  assert.notEqual(first, second);
  // The index is normalized, so a wrapped selection can never index off the list.
  assert.ok(frame(SUPER_START_ACTIONS.length).includes(`1/${SUPER_START_ACTIONS.length}`), "wraps forward");
  assert.ok(frame(-1).includes(`${SUPER_START_ACTIONS.length}/${SUPER_START_ACTIONS.length}`), "wraps backward");
});

test("composeScreen: no launcher line on a non-interactive frame (no keyboard to serve)", () => {
  const entrance = composeScreen(DATA, { rows: 44, cols: 130 }, 1).map(strip).join("\n");
  assert.ok(!entrance.includes("↑↓ pick"), "the entrance frame promises no keys it can't answer");
});

test("composeScreen: chartView pins the region against the auto behavior", () => {
  const withLive = { scanAgoS: 1, nextInS: 14, sessions: [{ label: "claude-opus-4-8", tokens: 451_200 }] };
  // Auto would show live (a session burned tokens) — pinning to spend overrides it.
  const pinnedSpend = composeScreen(DATA, { rows: 44, cols: 120 }, 1, { ...withLive, chartView: "spend" }).map(strip).join("\n");
  assert.ok(pinnedSpend.includes("ESTIMATED SPEND · LAST 30 DAYS"), "→ pinned back to history");
  assert.ok(!pinnedSpend.includes("LIVE SESSIONS"), "even though live deltas exist");
  // Auto would show history (nothing burned) — pinning to live overrides it, honestly.
  const pinnedLive = composeScreen(DATA, { rows: 44, cols: 120 }, 1, { scanAgoS: 1, nextInS: 14, chartView: "live" }).map(strip).join("\n");
  assert.ok(pinnedLive.includes("LIVE SESSIONS"), "← pinned to live");
  assert.ok(pinnedLive.includes("no session has burned tokens since super-start began"), "honest empty state, not a fake bar");
});

test("composeScreen flips the chart to LIVE SESSIONS once a session burns tokens", () => {
  const idle = composeScreen(DATA, { rows: 44, cols: 120 }, 1, { scanAgoS: 1, nextInS: 14 }).map(strip).join("\n");
  assert.ok(idle.includes("ESTIMATED SPEND · LAST 30 DAYS"), "history until something happens");
  const liveScreen = composeScreen(DATA, { rows: 44, cols: 120 }, 1, {
    scanAgoS: 1,
    nextInS: 14,
    pushing: true,
    sessions: [{ label: "claude-opus-4-8", tokens: 451_200 }],
  })
    .map(strip)
    .join("\n");
  assert.ok(liveScreen.includes("LIVE SESSIONS · TOKENS SINCE SUPER-START"), "flips to now");
  assert.ok(liveScreen.includes("SYNCING TO BOARD"), "and says the data is flowing");
  assert.ok(liveScreen.includes("451.2K"), "the bar carries its real delta");
  assert.ok(!liveScreen.includes("ESTIMATED SPEND · LAST 30"), "one chart region, not two");
});

test("composeScreen pulses only the harnesses the probe says are live", () => {
  const frame = (beat: number): string =>
    composeScreen(DATA, { rows: 44, cols: 120 }, 1, { scanAgoS: 1, nextInS: 14, activeHarnesses: ["Codex"], beat })
      .map(strip)
      .join("\n");
  const a = frame(0);
  assert.ok(/Codex\s+⠋/.test(a), "the live harness wears the pulse");
  assert.ok(/Claude Code\s+●/.test(a), "an idle harness keeps its settled dot");
  assert.ok(a.includes("live"), "and is named live");
  assert.notEqual(frame(0), frame(1), "the pulse actually advances between beats");
});

test("probeActivity: stat-only, sees growth, and never claims a harness it can't see", () => {
  const { home, projects } = seedCorpus();
  const prev = pinnedEnv(home, projects);
  try {
    const cache = newProbeCache();
    const t0 = Date.parse("2026-06-01T10:05:00.000Z");
    const a = probeActivity(cache, t0);
    assert.ok(cache.paths.length > 0, "discovery found the corpus");
    assert.equal(a.fingerprint, probeActivity(cache, t0).fingerprint, "an unchanged corpus never moves the fingerprint");
    assert.ok(!a.activeHarnesses.includes("Grok"), "no Grok on disk -> never reported live");

    // A real append must move the fingerprint (the fold trigger).
    const f = join(projects, "proj1", "s-aaa.jsonl");
    appendFileSync(
      f,
      "\n" + claudeLine({ sessionId: "s-aaa", ts: "2026-06-01T10:02:00.000Z", msgId: "m9", reqId: "r9", model: "claude-opus-4-8", input: 5, output: 5 }),
    );
    cache.discoveredAt = 0; // force re-walk, as the TTL would
    const b = probeActivity(cache, Date.now());
    assert.notEqual(b.fingerprint, a.fingerprint, "growth moves the fingerprint");
    assert.ok(b.activeHarnesses.includes("Claude Code"), "a just-written harness reads as live");
    assert.ok(b.lastWriteMs > 0);
  } finally {
    restoreEnv(prev);
  }
});

// ---- tickerText / tickerWindow: the board strip's marquee, local scope -------------------------

test("tickerText carries the board strip's fields from real local stats", () => {
  const t = tickerText(DATA);
  assert.ok(t.includes("579 ACTIVE HOURS"));
  assert.ok(t.includes("10.4B TOKENS TRACKED"));
  assert.ok(t.includes("$14.2K SPENT (ESTIMATE)"));
  assert.ok(t.includes("TRENDING MODEL: OPUS-4-8"), "claude- prefix trimmed for display, id otherwise verbatim");
  assert.ok(t.includes("TRENDING SKILL: FRONTEND-DESIGN"));
  assert.ok(t.includes("TRENDING AGENT: GENERAL-PURPOSE"));
  assert.ok(t.includes("RANKED BY BUILD SCORE, NOT SPEND"));
  assert.ok(t.includes("LEADERBOARD.DEPLOYFORWARD.DEV"));
});

test("tickerText omits what was never observed — no invented trends", () => {
  const t = tickerText({ ...DATA, topSkill: undefined, topAgent: undefined, activeHours: 0, spendTotalUsd: null });
  assert.ok(!t.includes("TRENDING SKILL"));
  assert.ok(!t.includes("TRENDING AGENT"));
  assert.ok(!t.includes("ACTIVE HOURS"));
  assert.ok(!t.includes("SPENT"));
  assert.ok(t.includes("TOKENS TRACKED"), "tokens always have a real value");
});

test("tickerWindow: exact width, wraps around, shift actually moves the window", () => {
  const text = tickerText(DATA);
  for (const shift of [0, 7, text.length - 3, text.length * 5 + 11]) {
    const w = tickerWindow(text, 80, shift);
    assert.equal(strip(w).length, 80, `shift=${shift}: window is exactly the rail width`);
  }
  assert.notEqual(strip(tickerWindow(text, 80, 0)), strip(tickerWindow(text, 80, 10)), "the marquee moves");
  assert.equal(strip(tickerWindow(text, 80, 0)), strip(tickerWindow(text, 80, text.length)), "and wraps seamlessly");
});

// ---- settledPlainText: the non-TTY / --static / too-small renderer ----------------------------

test("settledPlainText: plain text only, settled figures present", () => {
  const lines = settledPlainText(DATA);
  for (const l of lines) assert.equal(strip(l), l, "no ANSI by construction");
  const text = lines.join("\n");
  assert.ok(text.includes("10,412,388,204"));
  assert.ok(text.includes("1,579 sessions scanned"));
  assert.ok(text.includes("priced models only"));
});

// ---- readShowcaseData + runSuperStart: the no-mutation contract against a real temp corpus ----

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

function seedCorpus(): { home: string; projects: string } {
  const home = mkdtempSync(join(tmpdir(), "df-super-home-"));
  const projects = mkdtempSync(join(tmpdir(), "df-super-projects-"));
  const proj = join(projects, "proj1");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "s-aaa.jsonl"),
    [
      claudeLine({ sessionId: "s-aaa", ts: "2026-06-01T10:00:00.000Z", msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }),
      claudeLine({ sessionId: "s-aaa", ts: "2026-06-01T10:01:00.000Z", msgId: "m2", reqId: "r2", model: "claude-opus-4-8", input: 20, output: 10 }),
    ].join("\n"),
  );
  // A real Codex rollout (the shared known-answer fixture: fresh 200 / out 80 /
  // cacheRead 100 = 380 tokens) — proves the fold spans more than one harness.
  const codexDir = join(projects, "no-codex-here");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, "rollout-2026-06-01T12-00-00-c-1.jsonl"), CODEX_FIXTURE.lines.join("\n"));
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://mock.invalid/api",
      deviceToken: null,
      uid: null,
      handle: null,
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: { grok_g1: "d1", hermes_h1: "d2" },
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
    }),
  );
  return { home, projects };
}

test("readShowcaseData: real corpus counts + ledger rows, and NEVER mutates state", () => {
  const { home, projects } = seedCorpus();
  const prev = pinnedEnv(home, projects);
  try {
    const before = readFileSync(join(home, "state.json"), "utf8");
    const filesBefore = readdirSync(home).sort();
    const data = readShowcaseData(Date.parse("2026-06-05T00:00:00.000Z"));
    assert.equal(readFileSync(join(home, "state.json"), "utf8"), before, "state.json byte-identical");
    assert.deepEqual(readdirSync(home).sort(), filesBefore, "no new files in DF_HOME");

    const byName = new Map(data.harnesses.map((h) => [h.name, h.sessions]));
    assert.equal(byName.get("Claude Code"), 1, "corpus-scanned Claude session count");
    assert.equal(byName.get("Codex"), 1, "corpus-scanned Codex session count (multi-harness fold)");
    // Sessions come from the CORPUS SCAN, never the sync ledger: the stale grok/hermes
    // threadDigests in state.json must NOT surface as rows when no transcripts exist.
    assert.equal(byName.has("Grok"), false, "no local transcripts -> no row, whatever the ledger says");
    assert.equal(byName.has("Hermes"), false);
    assert.equal(data.totalSessions, 2, "aggregate summed from the rows");
    assert.equal(data.tokenTotal, 560, "exact all-harness token total (Claude 180 + Codex 380)");
    assert.ok(data.modelRows.some((m) => m.model === "gpt-5.5"), "Codex models join the mix");
    // Hand-computed against the canonical usage-core rates (test/coreParity.test.ts pins them):
    //   opus-4-8  in 120 @ $5/M + out 60 @ $25/M            = 0.0006  + 0.0015   = 0.0021
    //   gpt-5.5   in 200 @ $1.25/M + out 80 @ $10/M
    //             + cacheRead 100 @ $0.125/M                 = 0.00025 + 0.0008
    //                                                          + 0.0000125       = 0.0010625
    //   total                                                                    = 0.0031625
    // NOTE: gpt-5.5 prices through the "gpt-5" key by longest-prefix — the server's own
    // resolveBase does exactly this, so the board charges it the same way. Whether a
    // ".5" release is really a gpt-5 variant is a REAL open question (flagged to Marco),
    // but the two surfaces now agree, which is what this fixture guards.
    const expected = 0.0021 + 0.0010625;
    assert.ok(
      data.spendTotalUsd !== null && Math.abs(data.spendTotalUsd - expected) < 1e-12,
      `corpus spend exact: expected ${expected}, got ${data.spendTotalUsd}`,
    );
    assert.equal(data.spendIsPartial, false, "every model in the fixture is priced now — no phantom floor mark");
    assert.ok(data.days.length > 0, "day series present");
  } finally {
    restoreEnv(prev);
  }
});

test("runSuperStart --static on a non-TTY: plain settled frames, clean exit, no mutation", async () => {
  const { home, projects } = seedCorpus();
  const prev = pinnedEnv(home, projects);
  try {
    const before = readFileSync(join(home, "state.json"), "utf8");
    const writes: string[] = [];
    const io: ShowcaseIO = { write: (s) => writes.push(s), isTTY: false, rows: () => 24, cols: () => 80 };
    await runSuperStart({ static: true, now: Date.parse("2026-06-05T00:00:00.000Z") }, io);
    const out = writes.join("");
    assert.equal(strip(out), out, "non-TTY output carries NO escape sequences");
    assert.ok(!out.includes("\x1b"), "not even an OSC title write — no ESC byte at all");
    assert.ok(out.includes("sessions scanned"), "settled figures present");
    assert.equal(readFileSync(join(home, "state.json"), "utf8"), before, "state untouched");
  } finally {
    restoreEnv(prev);
  }
});

test("runSuperStart on an empty corpus prints the honest empty state", async () => {
  const home = mkdtempSync(join(tmpdir(), "df-super-empty-home-"));
  const projects = mkdtempSync(join(tmpdir(), "df-super-empty-projects-"));
  mkdirSync(join(projects, "empty"), { recursive: true });
  const prev = pinnedEnv(home, projects);
  try {
    const writes: string[] = [];
    const io: ShowcaseIO = { write: (s) => writes.push(s), isTTY: false, rows: () => 24, cols: () => 80 };
    await runSuperStart({ static: true }, io);
    const out = writes.join("");
    assert.ok(out.includes("No local agent history found yet"), "honest empty state");
    assert.ok(!out.includes("sessions scanned"), "no zero-dressed dashboard");
  } finally {
    restoreEnv(prev);
  }
});

/** A real interactive full-screen takeover that auto-presses `q` once the takeover's own
 * key listener actually exists, mirroring test/tabTitle.test.ts's fakeInteractiveIO. */
function fakeAutoQuitIO(quitAfterMs = 300, size: { rows: number; cols: number } = { rows: 40, cols: 120 }): { io: ShowcaseIO; writes: string[] } {
  const writes: string[] = [];
  let dataListener: ((d: Buffer) => void) | null = null;
  const io: ShowcaseIO = {
    write: (s) => writes.push(s),
    isTTY: true,
    rows: () => size.rows,
    cols: () => size.cols,
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

// The field bug (root-caused 2026-07-20): a stale npx cache silently ran an old build for
// days. checkUpdate is the injectable seam (SuperStartOptions, same discipline as
// limitsFetchImpl) that lets THIS test drive the real interactive pipeline without a real
// registry fetch, while proving the showcase actually renders update.ts's composer output.
test("runSuperStart: an injected stale checkUpdate renders the loud banner on the real interactive watch", async () => {
  const { home, projects } = seedCorpus();
  const prev = pinnedEnv(home, projects);
  try {
    const { io, writes } = fakeAutoQuitIO(300);
    const expected = staleVersionBanner({ running: TRACKER_VERSION, latest: "999.0.0" });
    await runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z"), checkUpdate: async () => "999.0.0" }, io);
    const out = strip(writes.join(""));
    assert.ok(out.includes(expected), `the exact composer banner text renders on the real watch -- got:\n${out}`);
  } finally {
    restoreEnv(prev);
  }
});

test("runSuperStart: checkUpdate reporting current (or omitted entirely) never renders a nag", async () => {
  const { home, projects } = seedCorpus();
  const prev = pinnedEnv(home, projects);
  try {
    const current = fakeAutoQuitIO(300);
    await runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z"), checkUpdate: async () => TRACKER_VERSION }, current.io);
    assert.ok(!strip(current.writes.join("")).includes("is behind"), "running == latest: no nag");

    const omitted = fakeAutoQuitIO(300);
    await runSuperStart({ now: Date.parse("2026-06-05T00:00:00.000Z") }, omitted.io);
    assert.ok(!strip(omitted.writes.join("")).includes("is behind"), "checkUpdate omitted: never a network call, never a nag");
  } finally {
    restoreEnv(prev);
  }
});

// ---- withFullScreen: guaranteed terminal restoration -------------------------------------------

function fakeIO(): { io: ShowcaseIO; writes: string[]; press: (b: string) => void } {
  const writes: string[] = [];
  const listeners = new Map<string, ((d: Buffer) => void)[]>();
  const io: ShowcaseIO = {
    write: (s) => writes.push(s),
    isTTY: true,
    rows: () => 24,
    cols: () => 80,
    input: {
      isTTY: true,
      setRawMode: () => {},
      on: (e: string, f: (d: Buffer) => void) => listeners.set(e, [...(listeners.get(e) ?? []), f]),
      off: (e: string, f: (d: Buffer) => void) =>
        listeners.set(e, (listeners.get(e) ?? []).filter((g) => g !== f)),
      resume: () => {},
      pause: () => {},
    },
    onResize: () => () => {},
  };
  return { io, writes, press: (b) => (listeners.get("data") ?? []).forEach((f) => f(Buffer.from(b))) };
}

test("withFullScreen emits the leave sequence on normal completion", async () => {
  const { io, writes } = fakeIO();
  await withFullScreen(io, async () => {});
  const out = writes.join("");
  assert.ok(out.includes("[?1049h"), "entered the alternate screen");
  assert.ok(out.includes("[?25l"), "hid the cursor");
  const leaveAt = out.lastIndexOf("[?1049l");
  assert.ok(leaveAt >= 0, "left the alternate screen");
  assert.ok(out.lastIndexOf("[?25h") >= 0, "cursor restored");
});

test("withFullScreen emits the leave sequence even when run throws", async () => {
  const { io, writes } = fakeIO();
  await assert.rejects(withFullScreen(io, async () => {
    throw new Error("boom");
  }));
  const out = writes.join("");
  assert.ok(out.includes("[?1049l"), "restore is guaranteed, not best-effort");
  assert.ok(out.includes("[?25h"), "cursor comes back");
});

test("withFullScreen resolves the quit wait on q", async () => {
  const { io, press } = fakeIO();
  let sawQuit = false;
  const done = withFullScreen(io, async (ctx) => {
    setTimeout(() => press("q"), 10);
    await ctx.waitForQuit();
    sawQuit = true;
  });
  await done;
  assert.ok(sawQuit, "q resolves the hold");
});
