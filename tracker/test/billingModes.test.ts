/**
 * LANE — billing modes for real (docs/context-capacity-plan.md Phase 8, RULED
 * 2026-07-19, D20-D22). Marco's ruling, verbatim-critical points preserved:
 *
 *   D20 — plan type is three-way enrollment truth. `api` | `subscription` |
 *   `mix`, declared at onboarding, editable in settings, stored in TrackerState
 *   (replaces the boolean subscription gate as the routing key; the existing
 *   per-provider consent remains nested under it). The ledger (layer 1) is
 *   never gated by any of this.
 *
 *   D21 — usage value-add = provider-provisioned remaining limits, live. What
 *   subscription and mix users get: the 5h/7day/model-scoped lanes exactly as
 *   the vendor provisions them (the CodexBar job). Never on the board.
 *
 *   D22 — budget is the tool over token spend. Optional explicit monthly $
 *   budget (api-equivalent) for `api` and `mix` modes. A budget gauge renders
 *   month-to-date spend against it. For API-only users the budget gauge IS the
 *   "remaining usage" visual; no provider lanes render (nothing is
 *   provisioned).
 *
 *   Mode-routed composition: subscription -> lanes; mix -> lanes + spend/
 *   budget; api -> spend/budget. All modes keep threads/context and the full
 *   ledger.
 *
 * THE SEAMS THIS SUITE PINS (none exist yet — this is the intentional red;
 * namespace-imported so a missing export fails as a clean per-test
 * TypeError/assertion red, never a module-load crash that takes out other
 * suites in the same run):
 *
 *   1. TrackerState.billingMode?: "api" | "subscription" | "mix" and
 *      TrackerState.monthlyBudgetUsd?: number (src/config.ts) — enrollment
 *      truth like limitsProviders/redact: sanitized on load (an invalid
 *      string or a non-finite/non-positive number is dropped, never trusted),
 *      and NOT epoch-gated (survives a PARSER_EPOCH bump untouched, same as
 *      limitsProviders and redact — this is enrollment truth, not parse
 *      state).
 *
 *   2. billingModeOnboarding(ask): Promise<{...}> — a NEW exported PURE
 *      helper, placed in src/superStart.ts next to the existing
 *      billingOnboarding (D9). Placement + naming choice made BY THIS SUITE
 *      (flagged to the impl agent, may move): the LEGACY billingOnboarding
 *      (boolean subscription gate) is left completely untouched — it is
 *      already pinned end-to-end by test/onboardingV2.test.ts, which is part
 *      of the 556-test baseline this lane must keep green. D20 retires it
 *      from the PRODUCTION onboarding path (bin/df.ts switches to the new
 *      function) but does not require deleting the old export; that's a
 *      future cleanup outside this suite's scope.
 *
 *        billingModeOnboarding(ask: {
 *          mode: () => Promise<"api" | "subscription" | "mix">;
 *          provider: (name: string) => Promise<boolean>;
 *          budget: () => Promise<number | null>;
 *        }): Promise<{
 *          mode: "api" | "subscription" | "mix";
 *          providers?: { claude?: boolean };
 *          budget?: number;
 *        }>
 *
 *      - calls ask.mode() exactly once;
 *      - "api" -> NEVER calls ask.provider (nothing is provisioned for an
 *        API-only user); DOES call ask.budget() (D22: budget applies to api
 *        too); result = { mode: "api", budget? } (budget key present only
 *        when ask.budget() resolved a number, never when it declined -> null);
 *      - "subscription" -> calls ask.provider EXACTLY for the providers that
 *        need consent (today: only "claude"); NEVER calls ask.budget() (D22
 *        scopes budget to api/mix only); result = { mode: "subscription",
 *        providers: { claude: <verbatim answer> } } (a decline persists as an
 *        explicit false, never an omitted key, same discipline as D9);
 *      - "mix" -> calls BOTH ask.provider and ask.budget(); result carries
 *        mode + providers + budget (budget key present only on a real
 *        answer);
 *      - declining the budget question (ask.budget() -> null) degrades
 *        NOTHING else: mode and providers (when asked) still land verbatim,
 *        only the budget key is omitted;
 *      - PURE: reads no state, remembers nothing across calls.
 *
 *   3. budgetGaugeLines(spentUsd: number, budgetUsd: number | undefined,
 *      width: number): string[] — a NEW pure line-producing function
 *      (src/superStart.ts, same style as the existing healthBar/
 *      limitsPanelLines: plain glyphs only, no ANSI, paint is the caller's
 *      job). Contract this suite pins (the spec left the exact rendering
 *      open — "renders ... as a bar + '$X of $Y' text ... pin presence of a
 *      distinguishable state, not exact styling"; this is the concrete
 *      contract chosen):
 *        - budgetUsd undefined, 0, or negative -> [] (nothing invented, no
 *          budget set).
 *        - otherwise ONE line containing "BUDGET", a health-bar-style glyph
 *          run of EXACTLY `width` cells (a mix of "█" filled / "░"
 *          empty, filled = Math.round(min(1, spentUsd/budgetUsd) * width) —
 *          so the bar visually caps FULL once spend reaches/exceeds budget,
 *          never overflows past width), and the exact text
 *          "<spentTxt> of <budgetTxt>" where both figures are formatCostUsd()
 *          of the REAL numbers (spentTxt is NEVER clamped down to budgetUsd);
 *        - spend/budget in [0.8, 1.0] (the ">=80%" band, inclusive of exactly
 *          on-budget) -> the line ALSO carries the exact substring
 *          "<remainingTxt> left" (remainingTxt = formatCostUsd(budgetUsd -
 *          spentUsd)) — this presence/absence IS the pinned distinguishable
 *          state (below 80% the line never says "left");
 *        - spend > budget (strictly over) -> budgetTxt is prefixed with ">"
 *          (">$Y", the spec's own honest-rendering hint) instead of the
 *          plain figure, the bar is fully filled (width cells of "█",
 *          zero "░"), and NO "left" text renders (there is nothing
 *          "remaining" once over — a distinct honest state, not a 100%+
 *          "remaining" claim).
 *
 *   4. limitsPanelLines grows two new opts (src/superStart.ts) — the
 *      mode-routed composition. Placement choice made BY THIS SUITE (the
 *      spec said "find it — limitsPanelLines or its caller"; pinned here
 *      since it is the pure line-producing function, same reasoning as #3):
 *        billingMode?: "api" | "subscription" | "mix";
 *        budget?: { spentUsd: number; budgetUsd: number };
 *      Routing this suite pins:
 *        - billingMode undefined -> REGRESSION: today's behavior, byte-
 *          identical — provider lanes render per the existing claudeLanes/
 *          codexLimits inputs, the budget gauge NEVER renders even if a
 *          `budget` opt is (mistakenly) supplied;
 *        - "subscription" -> provider lanes render exactly as today; the
 *          budget gauge NEVER renders, even if `budget` is supplied (D22
 *          scopes budget to api/mix only — this is an explicit override, not
 *          an oversight);
 *        - "mix" -> provider lanes render exactly as today, AND the budget
 *          gauge renders via budgetGaugeLines when `budget` is supplied
 *          (absent `budget` -> still no gauge, nothing invented);
 *        - "api" -> NO provider lane rows render AT ALL (Codex primary/
 *          secondary/"not reported" line, Claude vendor lanes, the Claude 5h
 *          estimate line) — this is a hard override: it holds even when
 *          claudeLanes/codexLimits carry real data (nothing is provisioned
 *          for an API-only user, D22, verbatim). The budget gauge renders
 *          when `budget` is supplied.
 *        - in every mode, thread/context rows (the live-session bars at the
 *          bottom of the panel) render identically — mode-independent, per
 *          D22's "all modes keep threads/context."
 *
 *   5. settingsRows / toggleSettingsRow grow Billing-cycling + a conditional
 *      Budget row (src/superStart.ts). Legacy-compatibility constraint this
 *      suite pins explicitly: shell.test.ts's existing "Billing distinguishes
 *      answered from never-asked" regression test uses ONLY the legacy
 *      `limitsProviders` signal (no billingMode at all) and is part of the
 *      556-test baseline — so the Billing row's "answered" detection must
 *      OR the two signals together, never replace the legacy one.
 *        - settingsRows: Billing.toggleable becomes true (D20: "editable in
 *          settings"). Billing.value: billingMode set -> exactly
 *          `mode: ${billingMode}` (distinguishable per mode); else, when only
 *          the legacy limitsProviders key is set -> the EXACT legacy text
 *          "subscription question answered" (byte-identical, protects the
 *          shell.test.ts regression pin); else (neither signal) -> the EXACT
 *          legacy text "not asked yet - answered during onboarding".
 *        - settingsRows: a Budget row is inserted immediately after Billing,
 *          ONLY when billingMode is "api" or "mix" (absent for "subscription"
 *          and for undefined — so baseTrackerState()'s 6-row/6-name
 *          regression pin in shell.test.ts is untouched). value: monthlyBudgetUsd
 *          set -> exactly `$${monthlyBudgetUsd} /mo`; unset -> exactly
 *          "not set". toggleable: false (editing the number itself is a
 *          future seam, out of this phase's scope — only the row's
 *          visibility/value is pinned here).
 *        - toggleSettingsRow(state, "Billing"): pure, immutable; cycles
 *          billingMode over ["api", "subscription", "mix"] wrapping forward
 *          (unset -> "api" on the first toggle); every OTHER field
 *          (including monthlyBudgetUsd) is left untouched — cycling INTO
 *          "subscription" does NOT wipe a previously-set monthlyBudgetUsd
 *          (settings edits are additive; mode routing simply ignores the
 *          budget for that mode, per limitsPanelLines' #4 override, not this
 *          function).
 *
 * Run: npx tsx --test test/billingModes.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARSER_EPOCH, loadState, saveState } from "../src/config.ts";
import type { TrackerState } from "../src/config.ts";
import { formatCostUsd } from "../src/usageView.ts";
import type { ShowcaseData } from "../src/superStart.ts";
// Namespace import for the not-yet-existing pure seams: a missing named export
// under a namespace import resolves to `undefined` at the property read (a
// clean per-test TypeError/assertion red), never a module-load SyntaxError
// that would kill every other suite in the same run. Same discipline as
// test/onboardingV2.test.ts and test/shell.test.ts.
import * as SS from "../src/superStart.ts";

// ============================================================================================
// fixtures / helpers
// ============================================================================================

function withTempHome<T>(fn: () => T): T {
  const home = mkdtempSync(join(tmpdir(), "df-billingmodes-home-"));
  const prev = process.env.DF_HOME;
  process.env.DF_HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.DF_HOME;
    else process.env.DF_HOME = prev;
  }
}

/** A minimal, valid TrackerState — every field loadState()/saveState() round-trips
 * today, plus room for overrides (including fields this phase has not added yet —
 * tsx transpiles without type-checking, so an extra property is forward-compatible,
 * not a build error). Mirrors shell.test.ts's baseTrackerState(). */
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
    parserEpoch: PARSER_EPOCH,
    lastSyncAt: 0,
    gapMs: 5 * 60 * 1000,
    watermarks: {},
    ...overrides,
  } as TrackerState;
}

/** Mirrors windowInference.test.ts's minimalData() — a bare ShowcaseData with room
 * for overrides (codexLimits/claude5h/sessions etc. for the mode-routing tests). */
function minimalData(overrides: Partial<ShowcaseData> = {}): ShowcaseData {
  return {
    harnesses: [{ name: "Claude Code", sessions: 1 }],
    totalSessions: 1,
    tokenTotal: 1_000_000,
    modelRows: [{ model: "claude-opus-4-8", input: 100, output: 50, cacheRead: 0, cacheCreation: 0, total: 150 }],
    sessions: [],
    spendTotalUsd: 1.23,
    spendIsPartial: false,
    activeHours: 10,
    days: [],
    spend30dUsd: null,
    codexLimits: null,
    claude5h: null,
    ...overrides,
  } as ShowcaseData;
}

/** Fakes billingModeOnboarding's `ask` seam, recording exactly what was asked. */
function makeModeAsk(
  mode: "api" | "subscription" | "mix",
  providerAnswers: Record<string, boolean>,
  budgetAnswer: number | null,
): {
  ask: { mode: () => Promise<"api" | "subscription" | "mix">; provider: (name: string) => Promise<boolean>; budget: () => Promise<number | null> };
  calls: { mode: number; provider: string[]; budget: number };
} {
  const calls = { mode: 0, provider: [] as string[], budget: 0 };
  const ask = {
    mode: async () => {
      calls.mode++;
      return mode;
    },
    provider: async (name: string) => {
      calls.provider.push(name);
      return providerAnswers[name] ?? false;
    },
    budget: async () => {
      calls.budget++;
      return budgetAnswer;
    },
  };
  return { ask, calls };
}

// ============================================================================================
// 1. TrackerState.billingMode / monthlyBudgetUsd — D20's enrollment-truth pattern
// ============================================================================================

test("TrackerState.billingMode: a fresh state carries no mode yet", () => {
  withTempHome(() => {
    const base = loadState();
    assert.equal(base.billingMode, undefined);
  });
});

test("TrackerState.billingMode: each of api/subscription/mix survives a save/load round trip", () => {
  withTempHome(() => {
    for (const mode of ["api", "subscription", "mix"] as const) {
      const base = loadState();
      saveState({ ...base, billingMode: mode } as TrackerState);
      assert.equal(loadState().billingMode, mode, `${mode} must round-trip verbatim`);
    }
  });
});

test("TrackerState.billingMode: an invalid or nonsense value on disk drops to undefined, never trusted", () => {
  withTempHome(() => {
    for (const garbage of ["yearly", "premium", "", "API", 123, true, null] as const) {
      const base = loadState();
      saveState({ ...base, billingMode: garbage } as unknown as TrackerState);
      assert.equal(loadState().billingMode, undefined, `garbage value ${JSON.stringify(garbage)} must sanitize to undefined`);
    }
  });
});

test("TrackerState.monthlyBudgetUsd: a valid positive finite number survives a save/load round trip", () => {
  withTempHome(() => {
    for (const budget of [150, 49.99, 0.01]) {
      const base = loadState();
      saveState({ ...base, monthlyBudgetUsd: budget } as TrackerState);
      assert.equal(loadState().monthlyBudgetUsd, budget, `${budget} must round-trip verbatim`);
    }
  });
});

test("TrackerState.monthlyBudgetUsd: zero, negative, or a non-number value on disk drops to undefined, never trusted", () => {
  withTempHome(() => {
    for (const garbage of [0, -10, "50", null, true] as const) {
      const base = loadState();
      saveState({ ...base, monthlyBudgetUsd: garbage } as unknown as TrackerState);
      assert.equal(loadState().monthlyBudgetUsd, undefined, `garbage value ${JSON.stringify(garbage)} must sanitize to undefined`);
    }
  });
});

test("TrackerState.billingMode + monthlyBudgetUsd: both survive a stale PARSER_EPOCH untouched (enrollment truth, not parse state — same rule as limitsProviders/redact)", () => {
  withTempHome(() => {
    const home = process.env.DF_HOME!;
    writeFileSync(
      join(home, "state.json"),
      JSON.stringify({
        apiBase: "http://127.0.0.1:1/api",
        deviceToken: null,
        uid: null,
        handle: null,
        repoHmacKey: "k".repeat(64),
        cursors: { "/some/stale/path": { byteOffset: 999 } },
        threadDigests: { stale_thread: "deadbeef" },
        parserEpoch: PARSER_EPOCH - 1, // stale on purpose
        gapMs: 5 * 60 * 1000,
        billingMode: "mix",
        monthlyBudgetUsd: 75,
      }),
    );
    const reloaded = loadState();
    assert.equal(reloaded.billingMode, "mix", "billingMode is enrollment truth -- it survives the epoch bump");
    assert.equal(reloaded.monthlyBudgetUsd, 75, "monthlyBudgetUsd is enrollment truth -- it survives the epoch bump too");
    // Proves this is actually exercising the real epoch-bump path, not a no-op:
    // real PARSE state must still reset on the mismatch.
    assert.deepEqual(reloaded.cursors, {}, "sanity: parse state (cursors) DOES reset on a stale epoch");
    assert.deepEqual(reloaded.threadDigests, {}, "sanity: parse state (threadDigests) DOES reset on a stale epoch");
  });
});

// ============================================================================================
// 2. billingModeOnboarding — D20's three-way onboarding question
// ============================================================================================

test("billingModeOnboarding: 'api' asks NO provider questions but DOES ask the budget question", async () => {
  const { ask, calls } = makeModeAsk("api", {}, 200);
  const result = await SS.billingModeOnboarding(ask);
  assert.equal(calls.mode, 1, "the mode question is asked exactly once");
  assert.deepEqual(calls.provider, [], "an API-only user is asked no per-provider question -- nothing is provisioned");
  assert.equal(calls.budget, 1, "D22: budget applies to api too");
  assert.deepEqual(result, { mode: "api", budget: 200 });
});

test("billingModeOnboarding: 'api' with a declined budget returns {mode:'api'} -- no budget key, nothing else degrades", async () => {
  const { ask } = makeModeAsk("api", {}, null);
  const result = await SS.billingModeOnboarding(ask);
  assert.deepEqual(result, { mode: "api" });
  assert.ok(!("budget" in result), "a decline must be an omitted key, never a null/0 placeholder");
  assert.ok(!("providers" in result), "api mode never carries a providers key at all");
});

test("billingModeOnboarding: 'subscription' asks per-provider consent for claude ONLY, and NEVER asks the budget question", async () => {
  const { ask, calls } = makeModeAsk("subscription", { claude: true }, 500); // budget answer primed but must be ignored
  const result = await SS.billingModeOnboarding(ask);
  assert.deepEqual(calls.provider, ["claude"], "only claude needs consent -- Codex is disk-read and always on, never asked");
  assert.equal(calls.budget, 0, "D22 scopes budget to api/mix only -- subscription must never ask it");
  assert.deepEqual(result, { mode: "subscription", providers: { claude: true } });
  assert.ok(!("budget" in result));
});

test("billingModeOnboarding: 'subscription' with a provider decline persists the explicit false, not an omission", async () => {
  const { ask } = makeModeAsk("subscription", { claude: false }, null);
  const result = await SS.billingModeOnboarding(ask);
  assert.deepEqual(result, { mode: "subscription", providers: { claude: false } }, "a decline is a real persisted no, not an omitted key");
});

test("billingModeOnboarding: 'mix' asks BOTH per-provider consent and the budget question, carrying all three fields", async () => {
  const { ask, calls } = makeModeAsk("mix", { claude: true }, 300);
  const result = await SS.billingModeOnboarding(ask);
  assert.deepEqual(calls.provider, ["claude"]);
  assert.equal(calls.budget, 1);
  assert.deepEqual(result, { mode: "mix", providers: { claude: true }, budget: 300 });
});

test("billingModeOnboarding: 'mix' with a declined budget keeps the provider answers -- a decline degrades nothing else", async () => {
  const { ask } = makeModeAsk("mix", { claude: true }, null);
  const result = await SS.billingModeOnboarding(ask);
  assert.deepEqual(result, { mode: "mix", providers: { claude: true } });
  assert.ok(!("budget" in result));
});

test("billingModeOnboarding: is PURE -- remembers nothing across calls, so a later call can answer differently", async () => {
  const first = await SS.billingModeOnboarding(makeModeAsk("subscription", { claude: false }, null).ask);
  const second = await SS.billingModeOnboarding(makeModeAsk("mix", { claude: true }, 100).ask);
  assert.deepEqual(first, { mode: "subscription", providers: { claude: false } });
  assert.deepEqual(second, { mode: "mix", providers: { claude: true }, budget: 100 }, "no hidden sticky state -- each call reflects only its own answers");
});

// ============================================================================================
// 3. budgetGaugeLines — D22's pure budget-vs-spend render
// ============================================================================================

function glyphCounts(line: string): { filled: number; empty: number } {
  return { filled: (line.match(/█/g) ?? []).length, empty: (line.match(/░/g) ?? []).length };
}

test("budgetGaugeLines: no budget set -> [] (nothing invented)", () => {
  assert.deepEqual(SS.budgetGaugeLines(30, undefined, 20), []);
});

test("budgetGaugeLines: a zero or negative budget also renders nothing (defensive, same as undefined)", () => {
  assert.deepEqual(SS.budgetGaugeLines(30, 0, 20), []);
  assert.deepEqual(SS.budgetGaugeLines(30, -50, 20), []);
});

test("budgetGaugeLines: well under budget (30%) renders the bar + exact '$X of $Y' text, no 'left'", () => {
  const lines = SS.budgetGaugeLines(30, 100, 20);
  assert.equal(lines.length, 1);
  const text = lines[0];
  assert.match(text, /BUDGET/);
  assert.ok(text.includes(`${formatCostUsd(30)} of ${formatCostUsd(100)}`), `expected the exact spend/budget text, got: ${text}`);
  assert.ok(!text.includes("left"), "under 80%, the remaining amount must not be called out at all");
  const { filled, empty } = glyphCounts(text);
  assert.equal(filled, Math.round(0.3 * 20), "filled cells match the real percentage");
  assert.equal(filled + empty, 20, "the bar is exactly `width` cells wide");
});

test("budgetGaugeLines: just under the 80% band (79.99%) still carries no 'left' text", () => {
  const text = SS.budgetGaugeLines(79.99, 100, 20)[0];
  assert.ok(!text.includes("left"), "79.99% is still below the >=80% band");
});

test("budgetGaugeLines: exactly at 80% -- the boundary is INCLUSIVE, 'left' renders", () => {
  const text = SS.budgetGaugeLines(80, 100, 20)[0];
  assert.ok(text.includes(`${formatCostUsd(20)} left`), `expected the exact remaining text at the 80% boundary, got: ${text}`);
});

test("budgetGaugeLines: 85% of budget -- the remaining amount is called out, computed exactly", () => {
  const text = SS.budgetGaugeLines(85, 100, 20)[0];
  assert.ok(text.includes(`${formatCostUsd(15)} left`), `expected the exact remaining text, got: ${text}`);
  const { filled, empty } = glyphCounts(text);
  assert.equal(filled, Math.round(0.85 * 20));
  assert.equal(filled + empty, 20);
});

test("budgetGaugeLines: exactly on budget (100%) shows $0 left, honestly -- not yet 'over'", () => {
  const text = SS.budgetGaugeLines(100, 100, 20)[0];
  assert.ok(text.includes(`${formatCostUsd(0)} left`), `expected $0 remaining, got: ${text}`);
  assert.ok(!text.includes(">"), "exactly on-budget is not OVER budget -- no honesty marker yet");
  const { filled, empty } = glyphCounts(text);
  assert.equal(filled, 20, "the bar reads full at exactly 100%");
  assert.equal(empty, 0);
});

test("budgetGaugeLines: over budget renders honestly -- the real spent figure, a '>' marked budget figure, a full bar, and no 'left' text", () => {
  const text = SS.budgetGaugeLines(120, 100, 20)[0];
  assert.ok(text.includes(formatCostUsd(120)), "the REAL spent figure must render, never clamped down to the budget");
  assert.ok(text.includes(`>${formatCostUsd(100)}`), `expected the honest '>$Y' marker, got: ${text}`);
  assert.ok(!text.includes("left"), "over budget is its own honest state -- nothing is 'remaining'");
  const { filled, empty } = glyphCounts(text);
  assert.equal(filled, 20, "the bar caps FULL once spend exceeds budget -- it never overflows past width");
  assert.equal(empty, 0);
});

test("budgetGaugeLines: the bar is always exactly `width` cells, at any spend/budget ratio", () => {
  for (const [spent, budget, width] of [[0, 100, 20], [50, 100, 40], [200, 100, 12]] as const) {
    const text = SS.budgetGaugeLines(spent, budget, width)[0];
    const { filled, empty } = glyphCounts(text);
    assert.equal(filled + empty, width, `spent=${spent} budget=${budget} width=${width}`);
  }
});

test("budgetGaugeLines: zero spend renders an all-empty bar and the plain $0 figure", () => {
  const text = SS.budgetGaugeLines(0, 100, 20)[0];
  const { filled, empty } = glyphCounts(text);
  assert.equal(filled, 0);
  assert.equal(empty, 20);
  assert.ok(text.includes(`${formatCostUsd(0)} of ${formatCostUsd(100)}`));
});

// ============================================================================================
// 4. limitsPanelLines — mode-routed composition (D20-D22)
// ============================================================================================

const CLAUDE_LANES = [{ kind: "session", percent: 41, resetsAt: null, scopeLabel: null }];
const CODEX_LIMITS = { primary: { usedPercent: 2, windowMinutes: 300, resetsInSeconds: 8671 * 60 }, secondary: null };
const PROVIDER_MARKERS = ["CLAUDE SESSION", "CLAUDE WEEKLY", "CLAUDE 5H", "CODEX 5H", "CODEX WEEKLY", "limits not reported"];

function anyProviderMarker(text: string): boolean {
  return PROVIDER_MARKERS.some((m) => text.includes(m));
}

test("limitsPanelLines: billingMode undefined -- REGRESSION, today's behavior unchanged: lanes render, budget gauge NEVER renders even if a budget opt is supplied", () => {
  const data = minimalData({ codexLimits: CODEX_LIMITS as ShowcaseData["codexLimits"] });
  const text = SS.limitsPanelLines(data, [], {
    height: 12,
    width: 110,
    claudeLanes: CLAUDE_LANES,
    budget: { spentUsd: 40, budgetUsd: 100 },
  }).join("\n");
  assert.ok(text.includes("CLAUDE SESSION"), "claude lanes still render exactly as before");
  assert.ok(text.includes("CODEX 5H"), "codex lines still render exactly as before");
  assert.ok(!text.includes("BUDGET"), "no billingMode -> the budget gauge must never appear, even if `budget` is passed by mistake");
});

test("limitsPanelLines: billingMode 'subscription' -- lanes render exactly as today, budget gauge NEVER renders even when `budget` is supplied", () => {
  const data = minimalData({ codexLimits: CODEX_LIMITS as ShowcaseData["codexLimits"] });
  const text = SS.limitsPanelLines(data, [], {
    height: 12,
    width: 110,
    billingMode: "subscription",
    claudeLanes: CLAUDE_LANES,
    budget: { spentUsd: 90, budgetUsd: 100 }, // deliberately >=80% -- must still never render
  }).join("\n");
  assert.ok(text.includes("CLAUDE SESSION"), "subscription users get their lanes");
  assert.ok(text.includes("CODEX 5H"));
  assert.ok(!text.includes("BUDGET"), "D22 scopes budget to api/mix only -- subscription must override any supplied budget");
});

test("limitsPanelLines: billingMode 'mix' -- lanes render AND the budget gauge renders when budget is supplied", () => {
  const data = minimalData({ codexLimits: CODEX_LIMITS as ShowcaseData["codexLimits"] });
  const text = SS.limitsPanelLines(data, [], {
    height: 12,
    width: 110,
    billingMode: "mix",
    claudeLanes: CLAUDE_LANES,
    budget: { spentUsd: 40, budgetUsd: 100 },
  }).join("\n");
  assert.ok(text.includes("CLAUDE SESSION"), "mix keeps the lanes");
  assert.ok(text.includes("CODEX 5H"));
  assert.ok(text.includes("BUDGET"), "mix ALSO gets the budget gauge");
  assert.ok(text.includes(`${formatCostUsd(40)} of ${formatCostUsd(100)}`));
});

test("limitsPanelLines: billingMode 'mix' with no budget supplied -- lanes still render, still no gauge (nothing invented)", () => {
  const data = minimalData({ codexLimits: CODEX_LIMITS as ShowcaseData["codexLimits"] });
  const text = SS.limitsPanelLines(data, [], { height: 12, width: 110, billingMode: "mix", claudeLanes: CLAUDE_LANES }).join("\n");
  assert.ok(text.includes("CLAUDE SESSION"));
  assert.ok(!text.includes("BUDGET"), "absent `budget` -> nothing invented, even in mix mode");
});

test("limitsPanelLines: billingMode 'api' -- NO provider lanes render at all, even though claudeLanes + codexLimits carry real data (the hard override)", () => {
  const data = minimalData({ codexLimits: CODEX_LIMITS as ShowcaseData["codexLimits"] });
  const text = SS.limitsPanelLines(data, [], {
    height: 12,
    width: 110,
    billingMode: "api",
    claudeLanes: CLAUDE_LANES, // simulates limitsProviders.claude = true -- must be ignored
    budget: { spentUsd: 40, budgetUsd: 100 },
  }).join("\n");
  assert.ok(!anyProviderMarker(text), `api mode must suppress every provider row, got: ${text}`);
  assert.ok(text.includes("BUDGET"), "api mode gets the budget gauge -- it IS the remaining-usage visual");
});

test("limitsPanelLines: billingMode 'api' also suppresses the default Claude 5h estimate and the Codex 'not reported' line (no lanes at all, not just no vendor lanes)", () => {
  const data = minimalData(); // codexLimits: null, claude5h: null -- the plain Tier-A-only case
  const text = SS.limitsPanelLines(data, [], { height: 12, width: 110, billingMode: "api" }).join("\n");
  assert.ok(!anyProviderMarker(text), `api mode must suppress the Tier-A estimate/placeholder rows too, got: ${text}`);
});

test("limitsPanelLines: billingMode 'api' with no budget supplied -- neither lanes nor gauge render (nothing invented for an unconfigured API user)", () => {
  const data = minimalData({ codexLimits: CODEX_LIMITS as ShowcaseData["codexLimits"] });
  const text = SS.limitsPanelLines(data, [], { height: 12, width: 110, billingMode: "api", claudeLanes: CLAUDE_LANES }).join("\n");
  assert.ok(!anyProviderMarker(text));
  assert.ok(!text.includes("BUDGET"));
});

test("limitsPanelLines: thread/context rows render identically across every billingMode -- mode-independent, per D22", () => {
  const data = minimalData();
  const liveSessions = [{ label: "claude-fable-5", tokens: 0, ctx: { pct: 90.7, inferred: true } }];
  const modes = [undefined, "api", "subscription", "mix"] as const;
  for (const billingMode of modes) {
    const text = SS.limitsPanelLines(data, liveSessions, { height: 12, width: 110, billingMode }).join("\n");
    assert.ok(text.includes("THREAD") && text.includes("fable-5"), `thread rows must render under billingMode=${billingMode}, got: ${text}`);
  }
});

test("limitsPanelLines: region height is held exactly regardless of billingMode (regression: never an over/under-filled frame)", () => {
  const data = minimalData({ codexLimits: CODEX_LIMITS as ShowcaseData["codexLimits"] });
  for (const billingMode of [undefined, "api", "subscription", "mix"] as const) {
    const lines = SS.limitsPanelLines(data, [], { height: 12, width: 110, billingMode, claudeLanes: CLAUDE_LANES, budget: { spentUsd: 10, budgetUsd: 100 } });
    assert.equal(lines.length, 12, `billingMode=${billingMode}`);
  }
});

// ============================================================================================
// 5. settingsRows / toggleSettingsRow — Billing cycling + the conditional Budget row (D20)
// ============================================================================================

test("settingsRows: Billing becomes toggleable (D20: 'editable in settings')", () => {
  const rows = SS.settingsRows(baseTrackerState());
  const billing = rows.find((r) => r.name === "Billing")!;
  assert.equal(billing.toggleable, true);
});

test("settingsRows: Billing shows the actual mode once billingMode is set -- api/subscription/mix read as distinct values", () => {
  const values = (["api", "subscription", "mix"] as const).map((mode) => SS.settingsRows(baseTrackerState({ billingMode: mode })).find((r) => r.name === "Billing")!.value);
  assert.equal(new Set(values).size, 3, "each mode must render a distinct, real value");
  for (const [i, mode] of (["api", "subscription", "mix"] as const).entries()) {
    assert.match(values[i], new RegExp(mode), `Billing's value must name the mode (${mode}), got: ${values[i]}`);
  }
});

test("settingsRows: Billing legacy text is preserved BYTE-FOR-BYTE when only the old limitsProviders signal is set (protects shell.test.ts's existing regression pin)", () => {
  const rows = SS.settingsRows(baseTrackerState({ limitsProviders: { claude: false } })); // no billingMode at all
  const billing = rows.find((r) => r.name === "Billing")!;
  assert.equal(billing.value, "subscription question answered", "the OLD text must survive unchanged for a device that only ever went through the D9 flow");
});

test("settingsRows: Billing legacy 'never asked' text is preserved BYTE-FOR-BYTE when neither signal is set", () => {
  const rows = SS.settingsRows(baseTrackerState({}));
  const billing = rows.find((r) => r.name === "Billing")!;
  assert.equal(billing.value, "not asked yet - answered during onboarding");
});

test("settingsRows: a NEW billingMode answer takes priority over a stale legacy limitsProviders signal (both set -> the mode wins)", () => {
  const rows = SS.settingsRows(baseTrackerState({ billingMode: "mix", limitsProviders: { claude: true } }));
  const billing = rows.find((r) => r.name === "Billing")!;
  assert.match(billing.value, /mix/, "billingMode is the newer, more specific truth -- it must win");
});

test("settingsRows: Budget row is ABSENT for billingMode 'subscription' and for undefined (unchanged 6-row shape, protects shell.test.ts's row-count pin)", () => {
  for (const billingMode of [undefined, "subscription"] as const) {
    const rows = SS.settingsRows(baseTrackerState({ billingMode, monthlyBudgetUsd: 50 }));
    assert.equal(rows.find((r) => r.name === "Budget"), undefined, `billingMode=${billingMode}`);
  }
});

test("settingsRows: Budget row is PRESENT, immediately after Billing, for 'api' and 'mix'", () => {
  for (const billingMode of ["api", "mix"] as const) {
    const rows = SS.settingsRows(baseTrackerState({ billingMode }));
    const billingIdx = rows.findIndex((r) => r.name === "Billing");
    const budgetIdx = rows.findIndex((r) => r.name === "Budget");
    assert.ok(budgetIdx >= 0, `billingMode=${billingMode} must show a Budget row`);
    assert.equal(budgetIdx, billingIdx + 1, "Budget sits immediately after Billing");
  }
});

test("settingsRows: Budget row's value -- '$N /mo' when set, 'not set' when absent", () => {
  const withBudget = SS.settingsRows(baseTrackerState({ billingMode: "api", monthlyBudgetUsd: 120 })).find((r) => r.name === "Budget")!;
  assert.equal(withBudget.value, "$120 /mo");
  const withoutBudget = SS.settingsRows(baseTrackerState({ billingMode: "mix" })).find((r) => r.name === "Budget")!;
  assert.equal(withoutBudget.value, "not set");
});

test("settingsRows: Budget row is not toggleable (v1 scope: presentation only, editing the number is a future seam)", () => {
  const budget = SS.settingsRows(baseTrackerState({ billingMode: "api", monthlyBudgetUsd: 50 })).find((r) => r.name === "Budget")!;
  assert.equal(budget.toggleable, false);
});

test("toggleSettingsRow: 'Billing' cycles api -> subscription -> mix -> api, immutably, starting from unset", () => {
  let state = baseTrackerState({});
  assert.equal(state.billingMode, undefined);
  state = SS.toggleSettingsRow(state, "Billing");
  assert.equal(state.billingMode, "api", "the first toggle from unset lands on api");
  state = SS.toggleSettingsRow(state, "Billing");
  assert.equal(state.billingMode, "subscription");
  state = SS.toggleSettingsRow(state, "Billing");
  assert.equal(state.billingMode, "mix");
  state = SS.toggleSettingsRow(state, "Billing");
  assert.equal(state.billingMode, "api", "the cycle wraps back around");
});

test("toggleSettingsRow: 'Billing' returns a NEW TrackerState (immutable), input untouched", () => {
  const before = baseTrackerState({ billingMode: "api" });
  const after = SS.toggleSettingsRow(before, "Billing");
  assert.equal(before.billingMode, "api", "input state must never be mutated in place");
  assert.equal(after.billingMode, "subscription");
  assert.notEqual(after, before);
});

test("toggleSettingsRow: cycling INTO 'subscription' leaves a previously-set monthlyBudgetUsd untouched -- settings edits are additive, mode routing simply ignores it elsewhere", () => {
  const before = baseTrackerState({ billingMode: "mix", monthlyBudgetUsd: 200 });
  const after = SS.toggleSettingsRow(before, "Billing"); // mix -> api
  assert.equal(after.billingMode, "api");
  assert.equal(after.monthlyBudgetUsd, 200, "the budget figure is not wiped by an api-mode landing");
  const toSubscription = SS.toggleSettingsRow(after, "Billing"); // api -> subscription
  assert.equal(toSubscription.billingMode, "subscription");
  assert.equal(toSubscription.monthlyBudgetUsd, 200, "the budget figure survives landing on subscription too, even though rendering ignores it there");
});

test("settingsStep: Enter on the Billing row calls the injected persist callback EXACTLY once with the cycled mode", () => {
  const trackerState = baseTrackerState({ billingMode: "api" });
  const rows = SS.settingsRows(trackerState);
  const billingIndex = rows.findIndex((r) => r.name === "Billing");
  assert.ok(billingIndex >= 0);
  const ui = { ...SS.initialShellState(), view: "settings", settingsIndex: billingIndex } as SS.ShellState;
  const persisted: TrackerState[] = [];
  const ctx = { trackerState, persist: (next: TrackerState) => void persisted.push(next) };
  const result = SS.settingsStep(ui, "enter", ctx);
  assert.equal(persisted.length, 1, "toggling Billing must persist EXACTLY once");
  assert.equal(persisted[0]!.billingMode, "subscription", "the persisted state carries the CYCLED value");
  assert.equal(result.trackerState.billingMode, "subscription", "the returned trackerState reflects the toggle too");
});
