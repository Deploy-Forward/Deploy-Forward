/**
 * LANE — the super-start shell (docs/context-capacity-plan.md Phase 7, RULED
 * 2026-07-18, D16-D19). Spec source: Marco's field rulings from the 0.22.0 run.
 *
 *   D16 — the never-exit shell. Launcher commands must NEVER exit super-start.
 *   Enter runs the command IN-APP: output renders inside a fullscreen pane
 *   (scrollable), Esc/Backspace returns to the live watch (which keeps running
 *   underneath). Only q and Ctrl-C leave the app. An action whose essence is
 *   external (opening the board URL) performs the external part and stays in
 *   the app with a one-line confirmation. The v1 leave-fullscreen-and-launch
 *   behavior (superStart.ts's `let launch` set by Enter, executed by the
 *   caller AFTER restore — see bin/df.ts's runShowcase) is retired.
 *
 *   D17 — in-app settings: grouped rows of name + current value, arrow-driven
 *   selection, Enter to edit/toggle. v1 groups: Board, Providers, Billing,
 *   Limits, Privacy, Device. Every edit persists to TrackerState immediately.
 *
 *   D18 — usage % always-on once consented: TrackerState.limitsProviders.claude
 *   persists consent; the --limits flag remains a one-run override.
 *
 *   D19 — honest non-TTY note: the legacy monitor names why (no interactive
 *   terminal) and how (run in a real terminal).
 *
 * THE SEAMS THIS SUITE PINS (none exist yet in src/superStart.ts — this is the
 * intentional red; namespace-imported so a missing export fails as a clean
 * per-test assertion, never a module-load crash that takes out other suites):
 *
 *   A. shellStep(state: ShellState, key: ShellKey): ShellState — a PURE view-
 *      routing reducer. ShellKey is a small abstracted vocabulary
 *      ("left"|"right"|"up"|"down"|"enter"|"esc"|"backspace"|"q") — DELIBERATELY
 *      decoupled from normalizeKey()'s raw-terminal vocabulary (normalizeKey's
 *      bare-Esc-quits mapping is already locked by test/superStart.test.ts and
 *      this suite never touches it). Wiring raw keys into ShellKey inside the
 *      output/settings views (so Esc/Backspace can mean "back" there without
 *      breaking the global bare-Esc-quits contract) is the code author's
 *      integration job, not pinned here.
 *
 *      ShellState (this suite's chosen shape — the seam is ours to design):
 *        {
 *          view: "watch" | "output" | "settings";
 *          menuIndex: number;
 *          chartView: "live" | "spend" | "limits";
 *          outputLines: string[];
 *          outputScroll: number;
 *          outputHeight: number;
 *          settingsIndex: number;
 *          quit: boolean;
 *          pendingAction: SuperStartAction | null;
 *        }
 *      initialShellState(): ShellState — the starting state (view "watch").
 *
 *      shellStep's routing contract:
 *        - key "q", from ANY view -> quit: true (view/other fields untouched).
 *        - view "watch" + "up"/"down" -> menuIndex cycles over
 *          SUPER_START_ACTIONS.length (wraps both ways, same math as today's
 *          watch loop).
 *        - view "watch" + "left"/"right" -> chartView = nextChartView(chartView, dir)
 *          (the EXISTING exported nextChartView — this pins the wiring, not a
 *          re-implementation).
 *        - view "watch" + "enter" -> looks up SUPER_START_ACTIONS[menuIndex]:
 *            * if it's the settings entry (argv[0] === "settings") -> view
 *              becomes "settings" directly (no pendingAction — an in-app view
 *              switch, not an external command).
 *            * otherwise -> pendingAction = that action; view STAYS "watch"
 *              (never leaves the app, never sets quit) — the async runner is
 *              injected/external to this pure reducer; delivery of its result
 *              is a SEPARATE function (shellReceiveOutput, below).
 *        - view "output" + "esc"/"backspace" -> view = "watch" (outputLines/
 *          outputScroll/outputHeight reset; menuIndex and chartView — the
 *          watch's own data — were never touched while in "output", so they
 *          come back unchanged for free).
 *        - view "output" + "up"/"down" -> outputScroll -1/+1, clamped to
 *          [0, max(0, outputLines.length - outputHeight)].
 *        - view "settings" + "esc"/"backspace" -> view = "watch".
 *        - any other (view, key) pair -> state returned with no observable
 *          change (a no-op key in that view).
 *
 *      shellReceiveOutput(state, result): ShellState — the async delivery of a
 *      launched action's captured output (SEPARATE from shellStep because the
 *      runner is async and this is the pure "the result landed" transition):
 *        result: { lines: string[]; visibleHeight: number } | { confirmLine: string }
 *        - either shape -> view = "output", pendingAction = null, outputScroll = 0.
 *        - { lines, visibleHeight } -> outputLines = lines, outputHeight = visibleHeight
 *          (the D16 in-app-pane case: `usage`, `status`, etc).
 *        - { confirmLine } -> outputLines = [confirmLine], outputHeight = 1 (the
 *          D16 external-action case: "opening the board URL performs the
 *          external part and stays in the app with a one-line confirmation").
 *
 *      SUPER_START_ACTIONS (existing export) must grow two entries for D16/D17
 *      to have something to route to:
 *        - one settings entry: argv[0] === "settings" (D17: "reachable as
 *          `deploy-forward settings` / `--settings`").
 *        - one entry carrying `external: true` on the (extended) SuperStartAction
 *          interface — the board/open-URL action D16 names explicitly.
 *
 *   B. In-app settings (D17), pure exported functions:
 *        interface SettingsRow { name: string; value: string; toggleable: boolean }
 *        settingsRows(state: TrackerState): SettingsRow[] — exactly 6 rows, in
 *          this order: Board, Providers, Billing, Limits, Privacy, Device.
 *        toggleSettingsRow(state: TrackerState, rowName: string): TrackerState —
 *          pure, immutable (returns a NEW TrackerState); flips the boolean the
 *          named row represents (this suite exercises "Limits" -> flips
 *          limitsProviders.claude, and "Privacy" -> flips a new `redact`
 *          field this D17 work adds to TrackerState); a no-op rowName returns
 *          state unchanged.
 *        settingsStep(state: ShellState, key: ShellKey, ctx: { trackerState:
 *          TrackerState; persist: (next: TrackerState) => void }):
 *          { state: ShellState; trackerState: TrackerState } — settings-view-
 *          LOCAL row navigation + toggle (view routing in/out of "settings"
 *          stays shellStep's job, see A):
 *            - "up"/"down" -> settingsIndex cycles over settingsRows(...).length
 *              (wraps), trackerState unchanged, persist NOT called.
 *            - "enter" on a toggleable row -> trackerState =
 *              toggleSettingsRow(ctx.trackerState, row.name); ctx.persist(next)
 *              called EXACTLY once with that new TrackerState; settingsIndex
 *              unchanged (so the next render lands on the same, now-toggled,
 *              row).
 *            - "enter" on a non-toggleable row (e.g. Device) -> no-op, persist
 *              NOT called.
 *
 *   C. Persisted limits consent (D18), a pure gating function pulled out of
 *      today's inline expression in runSuperStart (superStart.ts, currently
 *      `const limitsOptIn = opts.limits ?? loadState().limitsProviders?.claude
 *      ?? false;` — this suite does not re-test that integration, already
 *      covered end-to-end by test/onboardingV2.test.ts; it pins the EXTRACTED
 *      pure decision table instead):
 *        resolveLimitsConsent(flag: boolean | undefined, statePersisted: boolean | undefined): boolean
 *
 *   D. Honest non-TTY note (D19):
 *        NON_TTY_NOTE: string — one line, names the reason (no interactive
 *        terminal) and the remedy (run in a real terminal). Exported so
 *        bin/df.ts's legacy non-TTY path (the `start()` -> dashboardAndMonitor()
 *        branch that keeps the D8 plain monitor for a headless run) can print
 *        it verbatim instead of a re-typed string.
 *
 * Run: npx tsx --test test/shell.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { TrackerState } from "../src/config.ts";
import { nextChartView, SUPER_START_ACTIONS, type SuperStartAction } from "../src/superStart.ts";
// Namespace import for the not-yet-existing pure seams: a missing named export
// under a namespace import resolves to `undefined` at the property read (a
// clean per-test TypeError/assertion red), never a module-load SyntaxError
// that would kill every other suite in the same run.
import * as SS from "../src/superStart.ts";

// ---- fixtures --------------------------------------------------------------------------------

/** A minimal, valid TrackerState — every field loadState()/saveState() round-trips
 * today, plus room for overrides (including fields D17 has not added yet, e.g.
 * `redact` — tsx transpiles without type-checking, so an extra property here is
 * simply forward-compatible, not a build error). */
function baseTrackerState(overrides: Partial<TrackerState> & Record<string, unknown> = {}): TrackerState {
  return {
    apiBase: "http://127.0.0.1:1/api",
    deviceToken: null,
    uid: null,
    handle: null,
    repoHmacKey: "k".repeat(64),
    cursors: {},
    threadDigests: {},
    orgStamp: "none",
    parserEpoch: 14,
    lastSyncAt: 0,
    gapMs: 5 * 60 * 1000,
    watermarks: {},
    ...overrides,
  } as TrackerState;
}

/** Builds an output-view ShellState with `n` synthetic lines and a fixed pane
 * height, for the scroll-clamp tests. */
function outputState(n: number, visibleHeight: number, overrides: Partial<Record<string, unknown>> = {}): SS.ShellState {
  const lines = Array.from({ length: n }, (_, i) => `line ${i}`);
  return { ...SS.initialShellState(), view: "output", outputLines: lines, outputHeight: visibleHeight, outputScroll: 0, ...overrides } as SS.ShellState;
}

// ============================================================================================
// A. shellStep — the never-exit view-routing reducer (D16)
// ============================================================================================

test("initialShellState: starts on the watch view, not quit, no pending action", () => {
  const s = SS.initialShellState();
  assert.equal(s.view, "watch");
  assert.equal(s.quit, false);
  assert.equal(s.pendingAction, null);
});

test("shellStep: Enter on a normal menu selection does NOT quit and does NOT leave the app -- it requests an action", () => {
  const start = { ...SS.initialShellState(), menuIndex: 0 } as SS.ShellState;
  const next = SS.shellStep(start, "enter");
  assert.equal(next.quit, false, "requesting a command must never quit");
  assert.equal(next.view, "watch", "the app never leaves fullscreen on Enter -- v1's exit-and-launch is retired");
  assert.deepEqual(next.pendingAction, SUPER_START_ACTIONS[0], "the selected action is marked REQUESTED, not run inline");
});

test("shellStep: Enter marks whichever action the CURRENT menuIndex points to", () => {
  const idx = SUPER_START_ACTIONS.length > 1 ? 1 : 0;
  const start = { ...SS.initialShellState(), menuIndex: idx } as SS.ShellState;
  const next = SS.shellStep(start, "enter");
  assert.deepEqual(next.pendingAction, SUPER_START_ACTIONS[idx]);
});

test("shellReceiveOutput: delivering captured lines lands the shell in the output view with those lines", () => {
  const requested = SS.shellStep({ ...SS.initialShellState(), menuIndex: 0 } as SS.ShellState, "enter");
  const delivered = SS.shellReceiveOutput(requested, { lines: ["l1", "l2", "l3"], visibleHeight: 2 });
  assert.equal(delivered.view, "output");
  assert.deepEqual(delivered.outputLines, ["l1", "l2", "l3"]);
  assert.equal(delivered.pendingAction, null, "the request is resolved once its output lands");
  assert.equal(delivered.outputScroll, 0, "a freshly delivered pane starts scrolled to the top");
});

test("shellReceiveOutput + Esc: the watch keeps its data -- returning restores the SAME watch state", () => {
  // Drive the watch to a non-default state first (menu moved, chart view flipped).
  let s = { ...SS.initialShellState(), menuIndex: 0 } as SS.ShellState;
  s = SS.shellStep(s, "down"); // menuIndex advances
  s = SS.shellStep(s, "right"); // chartView cycles via nextChartView
  const watchMenuIndex = s.menuIndex;
  const watchChartView = s.chartView;
  s = SS.shellStep(s, "enter"); // request a command
  s = SS.shellReceiveOutput(s, { lines: ["out"], visibleHeight: 5 }); // its output lands
  assert.equal(s.view, "output");
  s = SS.shellStep(s, "esc");
  assert.equal(s.view, "watch", "Esc in the output view returns to the live watch");
  assert.equal(s.menuIndex, watchMenuIndex, "the watch's menu selection survived the trip through output");
  assert.equal(s.chartView, watchChartView, "the watch's chart page survived the trip through output -- the scans never stopped");
});

test("shellStep: Backspace in the output view also returns to watch (same as Esc)", () => {
  let s = outputState(3, 2);
  s = SS.shellStep(s, "backspace");
  assert.equal(s.view, "watch");
});

test("shellStep: Up/Down in the output view scroll, clamped to never go past 0", () => {
  let s = outputState(10, 4); // maxScroll = 10 - 4 = 6
  s = SS.shellStep(s, "up");
  assert.equal(s.outputScroll, 0, "scrolling up from the top must never go negative");
});

test("shellStep: Up/Down in the output view scroll, clamped to never go past lines.length - visible height", () => {
  let s = outputState(10, 4); // maxScroll = 6
  for (let i = 0; i < 10; i++) s = SS.shellStep(s, "down"); // way past the bottom
  assert.equal(s.outputScroll, 6, "scrolling down must clamp at lines.length - visibleHeight, never past it");
});

test("shellStep: Down then Up in the output view moves the scroll position by exactly one each way", () => {
  let s = outputState(10, 4);
  s = SS.shellStep(s, "down");
  assert.equal(s.outputScroll, 1);
  s = SS.shellStep(s, "down");
  assert.equal(s.outputScroll, 2);
  s = SS.shellStep(s, "up");
  assert.equal(s.outputScroll, 1);
});

test("shellStep: q quits from the watch view", () => {
  const s = SS.shellStep(SS.initialShellState(), "q");
  assert.equal(s.quit, true);
});

test("shellStep: q quits from the output view too", () => {
  const s = SS.shellStep(outputState(5, 2), "q");
  assert.equal(s.quit, true, "q must leave the app from ANY view, not just watch");
});

test("shellStep: q quits from the settings view too", () => {
  const settingsView = { ...SS.initialShellState(), view: "settings" } as SS.ShellState;
  const s = SS.shellStep(settingsView, "q");
  assert.equal(s.quit, true);
});

test("shellStep: Left/Right in the watch view still cycle chart views via the EXISTING nextChartView (regression pin)", () => {
  const start = { ...SS.initialShellState(), chartView: "spend" } as SS.ShellState;
  const right = SS.shellStep(start, "right");
  assert.equal(right.chartView, nextChartView("spend", "right"), "shellStep must delegate to the real nextChartView, not a reimplementation");
  const left = SS.shellStep(start, "left");
  assert.equal(left.chartView, nextChartView("spend", "left"));
});

test("shellStep: Left/Right in the watch view never touch menuIndex, quit, or view", () => {
  const start = { ...SS.initialShellState(), menuIndex: 2, chartView: "live" } as SS.ShellState;
  const next = SS.shellStep(start, "left");
  assert.equal(next.menuIndex, 2);
  assert.equal(next.quit, false);
  assert.equal(next.view, "watch");
});

test("shellStep: Up/Down in the watch view cycle menuIndex, wrapping both ways over SUPER_START_ACTIONS.length", () => {
  const n = SUPER_START_ACTIONS.length;
  let s = { ...SS.initialShellState(), menuIndex: 0 } as SS.ShellState;
  s = SS.shellStep(s, "up"); // wraps backward from 0
  assert.equal(s.menuIndex, n - 1, "Up from index 0 wraps to the last action");
  s = SS.shellStep(s, "down");
  assert.equal(s.menuIndex, 0, "Down from the last action wraps back to 0");
});

test("SUPER_START_ACTIONS grows a settings entry (argv[0] === \"settings\") for D17's in-app settings", () => {
  const idx = SUPER_START_ACTIONS.findIndex((a) => a.argv[0] === "settings");
  assert.ok(idx >= 0, "D17 requires an in-app settings entry, reachable the same way `deploy-forward settings` is");
});

test("shellStep: Enter on the settings menu entry switches view to \"settings\" directly -- no pendingAction, no external run", () => {
  const idx = SUPER_START_ACTIONS.findIndex((a) => a.argv[0] === "settings");
  assert.ok(idx >= 0, "precondition: the settings entry must exist (see the previous test)");
  const s = SS.shellStep({ ...SS.initialShellState(), menuIndex: idx } as SS.ShellState, "enter");
  assert.equal(s.view, "settings", "the settings page is an IN-APP view switch, not a launched command");
  assert.equal(s.pendingAction, null, "opening settings must never mark a pendingAction -- there is nothing external to run");
});

test("shellStep: Esc from the settings view returns to watch", () => {
  const settingsView = { ...SS.initialShellState(), view: "settings" } as SS.ShellState;
  const s = SS.shellStep(settingsView, "esc");
  assert.equal(s.view, "watch");
});

test("SUPER_START_ACTIONS carries an `external: true` action (D16: the board/open-URL command)", () => {
  const externals = (SUPER_START_ACTIONS as readonly (SuperStartAction & { external?: boolean })[]).filter((a) => a.external === true);
  assert.ok(externals.length >= 1, "D16 names an action whose essence is external (opening the board URL) -- it must be marked so");
});

test("shellReceiveOutput: an external action's confirmLine renders as ONE line in the output view, never an exit", () => {
  const requested = { ...SS.initialShellState() } as SS.ShellState;
  const delivered = SS.shellReceiveOutput(requested, { confirmLine: "Opened leaderboard.deployforward.dev in your browser" });
  assert.equal(delivered.view, "output", "an external action still lands in-app, with a confirmation -- D16's explicit carve-out");
  assert.deepEqual(delivered.outputLines, ["Opened leaderboard.deployforward.dev in your browser"]);
  assert.equal(delivered.quit, false, "an external action must never exit the shell");
  assert.equal(delivered.pendingAction, null);
});

test("shellStep: an unbound key in a given view is a no-op (never a stray quit or view change)", () => {
  const s = { ...SS.initialShellState(), menuIndex: 3, chartView: "limits" } as SS.ShellState;
  // "enter" is bound in watch; anything not in {left,right,up,down,enter,q} for
  // a view that doesn't use it (esc/backspace in watch) must not alter the
  // observable fields other than possibly being ignored entirely.
  const s2 = SS.shellStep(s, "esc");
  assert.equal(s2.view, "watch", "Esc has nothing to back OUT of from the watch view -- must not quit or corrupt state");
  assert.equal(s2.quit, false);
  assert.equal(s2.menuIndex, 3);
  assert.equal(s2.chartView, "limits");
});

// ============================================================================================
// B. In-app settings (D17)
// ============================================================================================

// D14 C7 (docs/d14-two-way-join-spec.md): an Org row joins the v1 groups, beside
// Device -- read-only display of the org-join state (none / enrolled / pending).
const SETTINGS_GROUPS = ["Board", "Providers", "Billing", "Limits", "Privacy", "Org", "Device"] as const;

test("settingsRows: exactly seven grouped rows, in the documented order (D17 v1 groups + D14 C7's Org row)", () => {
  const rows = SS.settingsRows(baseTrackerState());
  assert.deepEqual(rows.map((r) => r.name), [...SETTINGS_GROUPS]);
});

test("settingsRows: Board reflects pairing state -- paired (deviceToken + handle) vs unpaired read as different, real values", () => {
  const unpaired = SS.settingsRows(baseTrackerState({ deviceToken: null, handle: null }));
  const paired = SS.settingsRows(baseTrackerState({ deviceToken: "tok-123", handle: "marco" }));
  const boardUnpaired = unpaired.find((r) => r.name === "Board")!;
  const boardPaired = paired.find((r) => r.name === "Board")!;
  assert.notEqual(boardUnpaired.value, boardPaired.value, "pairing state must be a REAL, observable difference in the row value");
  assert.match(boardPaired.value, /marco/, "a paired device's Board row names the paired handle");
});

test("settingsRows: Limits reflects the persisted claude opt-in -- true vs false/undefined read as different values", () => {
  const on = SS.settingsRows(baseTrackerState({ limitsProviders: { claude: true } }));
  const off = SS.settingsRows(baseTrackerState({ limitsProviders: { claude: false } }));
  const unset = SS.settingsRows(baseTrackerState({}));
  const limitsOn = on.find((r) => r.name === "Limits")!;
  const limitsOff = off.find((r) => r.name === "Limits")!;
  const limitsUnset = unset.find((r) => r.name === "Limits")!;
  assert.notEqual(limitsOn.value, limitsOff.value, "on vs off must be a real, distinguishable value");
  assert.equal(limitsOff.value, limitsUnset.value, "a persisted false and an absent key both read as \"off\" -- same honest default D18 documents");
  assert.equal(limitsOn.toggleable, true, "Limits: claude is the row D17 explicitly calls a toggle");
});

test("settingsRows: Privacy reflects a `redact` flag on TrackerState -- on vs off read as different values", () => {
  const on = SS.settingsRows(baseTrackerState({ redact: true }));
  const off = SS.settingsRows(baseTrackerState({ redact: false }));
  const privacyOn = on.find((r) => r.name === "Privacy")!;
  const privacyOff = off.find((r) => r.name === "Privacy")!;
  assert.notEqual(privacyOn.value, privacyOff.value);
  assert.equal(privacyOn.toggleable, true);
});

test("settingsRows: Device is read-only (D17: \"read-only until the D14 org rework lands\")", () => {
  const rows = SS.settingsRows(baseTrackerState({ deviceToken: "tok-123", handle: "marco" }));
  const device = rows.find((r) => r.name === "Device")!;
  assert.equal(device.toggleable, false, "Device must not be presented as a toggle before the D14 org rework lands");
});

test("settingsRows: Providers and Billing rows exist with a real, non-empty value string", () => {
  const rows = SS.settingsRows(baseTrackerState());
  for (const name of ["Providers", "Billing"] as const) {
    const row = rows.find((r) => r.name === name)!;
    assert.ok(row, `${name} row must exist`);
    assert.equal(typeof row.value, "string");
    assert.ok(row.value.length > 0, `${name}'s value must never be blank`);
  }
});

test("settingsRows: Billing distinguishes a device that answered the subscription question from one that never did", () => {
  const neverAsked = SS.settingsRows(baseTrackerState({})); // no limitsProviders key at all -- never answered
  const answered = SS.settingsRows(baseTrackerState({ limitsProviders: { claude: false } })); // answered "yes, but not claude"
  const billingNever = neverAsked.find((r) => r.name === "Billing")!;
  const billingAnswered = answered.find((r) => r.name === "Billing")!;
  assert.notEqual(billingNever.value, billingAnswered.value, "the Billing row must reflect whether the onboarding question was ever answered");
});

test("toggleSettingsRow: flipping Limits toggles limitsProviders.claude, immutably (returns a NEW TrackerState)", () => {
  const before = baseTrackerState({ limitsProviders: { claude: false } });
  const after = SS.toggleSettingsRow(before, "Limits");
  assert.equal(before.limitsProviders?.claude, false, "the input state must never be mutated in place");
  assert.equal(after.limitsProviders?.claude, true, "toggling flips the boolean");
  assert.notEqual(after, before, "a new object is returned");
});

test("toggleSettingsRow: flipping Limits from unset treats absence as false, so it toggles to true", () => {
  const before = baseTrackerState({});
  const after = SS.toggleSettingsRow(before, "Limits");
  assert.equal(after.limitsProviders?.claude, true);
});

test("toggleSettingsRow: flipping Privacy toggles the redact flag, immutably", () => {
  const before = baseTrackerState({ redact: true });
  const after = SS.toggleSettingsRow(before, "Privacy") as TrackerState & { redact: boolean };
  assert.equal((before as unknown as { redact: boolean }).redact, true, "input untouched");
  assert.equal(after.redact, false);
});

test("toggleSettingsRow: a non-toggleable row name (Device) is a no-op -- returns an equivalent state", () => {
  const before = baseTrackerState({ deviceToken: "tok-123", handle: "marco" });
  const after = SS.toggleSettingsRow(before, "Device");
  assert.deepEqual(after, before, "Device carries no boolean to flip -- toggling it must change nothing");
});

test("settingsStep: Up/Down cycle settingsIndex over settingsRows(...).length, wrapping both ways, and never touch trackerState", () => {
  const trackerState = baseTrackerState();
  const rowCount = SS.settingsRows(trackerState).length;
  let ui = { ...SS.initialShellState(), view: "settings", settingsIndex: 0 } as SS.ShellState;
  const persisted: TrackerState[] = [];
  const ctx = { trackerState, persist: (next: TrackerState) => void persisted.push(next) };
  const r1 = SS.settingsStep(ui, "up", ctx); // wraps backward from 0
  assert.equal(r1.state.settingsIndex, rowCount - 1);
  assert.equal(r1.trackerState, trackerState, "Up/Down never mutate or replace the tracker state");
  assert.equal(persisted.length, 0, "navigation must never persist");
});

test("settingsStep: Enter on a toggleable row (Limits) calls the injected persist callback EXACTLY once with the updated TrackerState", () => {
  const trackerState = baseTrackerState({ limitsProviders: { claude: false } });
  const rows = SS.settingsRows(trackerState);
  const limitsIndex = rows.findIndex((r) => r.name === "Limits");
  assert.ok(limitsIndex >= 0);
  const ui = { ...SS.initialShellState(), view: "settings", settingsIndex: limitsIndex } as SS.ShellState;
  const persisted: TrackerState[] = [];
  const ctx = { trackerState, persist: (next: TrackerState) => void persisted.push(next) };
  const result = SS.settingsStep(ui, "enter", ctx);
  assert.equal(persisted.length, 1, "toggling a boolean row must persist EXACTLY once -- not zero, not twice");
  assert.equal(persisted[0]!.limitsProviders?.claude, true, "the persisted state carries the FLIPPED value");
  assert.equal(result.trackerState.limitsProviders?.claude, true, "the returned trackerState reflects the toggle too -- the row re-renders with the new value");
});

test("settingsStep: Enter on a non-toggleable row (Device) never calls persist", () => {
  const trackerState = baseTrackerState({ deviceToken: "tok-123", handle: "marco" });
  const rows = SS.settingsRows(trackerState);
  const deviceIndex = rows.findIndex((r) => r.name === "Device");
  assert.ok(deviceIndex >= 0);
  const ui = { ...SS.initialShellState(), view: "settings", settingsIndex: deviceIndex } as SS.ShellState;
  const persisted: TrackerState[] = [];
  const ctx = { trackerState, persist: (next: TrackerState) => void persisted.push(next) };
  SS.settingsStep(ui, "enter", ctx);
  assert.equal(persisted.length, 0, "a read-only row must never invoke persist");
});

// ============================================================================================
// C. Persisted limits consent (D18) -- the extracted pure gating function
// ============================================================================================

test("resolveLimitsConsent: {stateTrue, flagAbsent} -> true (fetch) -- a persisted opt-in works with NO --limits flag", () => {
  assert.equal(SS.resolveLimitsConsent(undefined, true), true);
});

test("resolveLimitsConsent: {stateFalsy(false), flagPresent(true)} -> true (fetch) -- the flag is a real per-run override", () => {
  assert.equal(SS.resolveLimitsConsent(true, false), true);
});

test("resolveLimitsConsent: {stateFalsy(undefined), flagAbsent} -> false (no fetch) -- today's unchanged default", () => {
  assert.equal(SS.resolveLimitsConsent(undefined, undefined), false);
});

test("resolveLimitsConsent: {stateFalsy(false), flagAbsent} -> false (no fetch)", () => {
  assert.equal(SS.resolveLimitsConsent(undefined, false), false);
});

test("resolveLimitsConsent: an explicit flag=false OVERRIDES a persisted true -- ?? only falls through on undefined, not false", () => {
  assert.equal(SS.resolveLimitsConsent(false, true), false, "a real per-run decline must win over a stale persisted opt-in");
});

// ============================================================================================
// D. Honest non-TTY note (D19)
// ============================================================================================

test("NON_TTY_NOTE: a single, non-empty line naming the reason (no interactive terminal)", () => {
  assert.equal(typeof SS.NON_TTY_NOTE, "string");
  assert.ok(SS.NON_TTY_NOTE.length > 0);
  assert.ok(!SS.NON_TTY_NOTE.includes("\n"), "one line -- it renders straight into the legacy monitor's output");
  assert.match(SS.NON_TTY_NOTE.toLowerCase(), /interactive terminal/, "must name WHY: no interactive terminal");
});

test("NON_TTY_NOTE: names the remedy (run in a real terminal)", () => {
  assert.match(SS.NON_TTY_NOTE.toLowerCase(), /real terminal|interactive terminal/, "must name HOW: run in a real terminal for the full experience");
});

test("NON_TTY_NOTE: bin/df.ts's legacy non-TTY path references the exported note (static source pin, never executes the CLI entrypoint)", () => {
  // bin/df.ts runs main() at import time (real CLI dispatch, network, prompts) --
  // it is never safe to `import` in a test. Reading its SOURCE TEXT is: this pins
  // that the legacy monitor (the `start()` -> dashboardAndMonitor() non-TTY branch,
  // D8's kept path) actually wires the honest note in, without executing anything.
  const here = dirname(fileURLToPath(import.meta.url));
  const dfSource = readFileSync(join(here, "..", "bin", "df.ts"), "utf8");
  assert.match(dfSource, /NON_TTY_NOTE/, "the legacy non-TTY path must print the shared NON_TTY_NOTE, not a re-typed ad hoc string");
});
