/**
 * Unit tests for the local usage view's PURE parts: per-model row folding/sorting,
 * Codex rate_limits extraction (real shape, verified against ~/.codex/sessions on the
 * dev machine, 2026-07-06), and the 5h-block boundary math. No disk I/O — the read-only
 * corpus/rollout scan (readLocalModelRows / readLatestCodexRateLimits /
 * collectRecentClaudeEntries) is exercised manually against real transcripts, not here.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foldModelRows,
  formatCompact,
  parseLatestCodexRateLimits,
  formatCodexLimitsLine,
  computeCurrent5hBlock,
  formatClaude5hLine,
  foldProjectRows,
  foldUsageDayRows,
  localDayKey,
  priceForModel,
  estimateCostUsd,
  estimateGroupCostUsd,
  hasUnpricedUsage,
  formatCostUsd,
  usageRowsToJson,
  projectRowsToJson,
  dayRowsToJson,
  PRICES,
} from "../src/usageView.ts";
import { dedupeClaudeUsageEntries, type ClaudeUsageEntry } from "../src/jsonl.ts";

/**
 * A model id that is genuinely absent from PRICES — the fixture for "unpriced".
 *
 * Deliberately NOT "gpt-5.5": since the 0.21.0 pricing-sync fix, priceForModel resolves
 * by LONGEST-PREFIX (mirroring the server's resolveBase), so "gpt-5.5" now resolves
 * through the "gpt-5" key and IS priced — on the server and the board too. That is the
 * intended parity, but it makes gpt-5.5 useless as an unpriced fixture. These tests are
 * about the unpriced BEHAVIOR, so they need an id no prefix can claim.
 */
const UNPRICED = "mistral-large-3";

// ---- foldModelRows ---------------------------------------------------------------------------

test("foldModelRows aggregates per-model buckets across sessions, sorted by total desc", () => {
  const summaries = [
    { models: [{ id: "claude-opus-4-8", input: 100, output: 50, cacheRead: 0, cacheCreation: 0 }] },
    { models: [{ id: "gpt-5.5", input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }] },
    { models: [{ id: "claude-opus-4-8", input: 20, output: 10, cacheRead: 5, cacheCreation: 1 }] },
  ];
  const { rows, total } = foldModelRows(summaries);
  assert.deepEqual(rows, [
    { model: "claude-opus-4-8", input: 120, output: 60, cacheRead: 5, cacheCreation: 1, total: 186 },
    { model: "gpt-5.5", input: 10, output: 5, cacheRead: 0, cacheCreation: 0, total: 15 },
  ]);
  assert.deepEqual(total, { model: "TOTAL", input: 130, output: 65, cacheRead: 5, cacheCreation: 1, total: 201 });
});

test("foldModelRows on an empty corpus yields no rows and a zeroed TOTAL", () => {
  const { rows, total } = foldModelRows([]);
  assert.deepEqual(rows, []);
  assert.deepEqual(total, { model: "TOTAL", input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 });
});

test("foldModelRows tombstones (models: []) contribute nothing", () => {
  const { rows, total } = foldModelRows([{ models: [] }, { models: [{ id: "gpt-5.5", input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }] }]);
  assert.equal(rows.length, 1);
  assert.equal(total.total, 2);
});

// ---- formatCompact ----------------------------------------------------------------------------

test("formatCompact renders human-compact magnitudes", () => {
  assert.equal(formatCompact(999), "999");
  assert.equal(formatCompact(12345), "12.3K");
  assert.equal(formatCompact(12_345_678), "12.3M");
  assert.equal(formatCompact(1_234_000_000), "1.2B");
});

// ---- Codex rate_limits extraction (REAL shape verified on this machine, 2026-07-06) -----------

/** Verbatim shape captured from ~/.codex/sessions/2026/07/05/rollout-...jsonl on this machine:
 *   rate_limits sits ALONGSIDE payload.info (not nested inside it), and each window carries
 *   `resets_at` — an ABSOLUTE unix epoch in SECONDS — not a relative `resets_in_seconds`. */
function tokenCountLine(rateLimits: unknown, ts = "2026-07-05T18:16:21.044Z"): string {
  return JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 762974, cached_input_tokens: 492416, output_tokens: 11144, reasoning_output_tokens: 6089, total_tokens: 774118 }, model_context_window: 258400 },
      rate_limits: rateLimits,
    },
  });
}

const REAL_RATE_LIMITS = {
  limit_id: "codex",
  limit_name: null,
  primary: { used_percent: 32.0, window_minutes: 300, resets_at: 1783291932 },
  secondary: { used_percent: 16.0, window_minutes: 10080, resets_at: 1783716480 },
  credits: null,
  individual_limit: null,
  plan_type: "team",
  rate_limit_reached_type: null,
};

test("parseLatestCodexRateLimits extracts the real primary/secondary shape", () => {
  const now = 1783291932_000 - 5 * 60_000; // 5 minutes before primary's resets_at
  const rl = parseLatestCodexRateLimits(tokenCountLine(REAL_RATE_LIMITS), now);
  assert.ok(rl);
  assert.equal(rl!.primary?.usedPercent, 32);
  assert.equal(rl!.primary?.windowMinutes, 300);
  assert.equal(rl!.primary?.resetsInSeconds, 300); // 5 minutes out
  assert.equal(rl!.secondary?.usedPercent, 16);
  assert.equal(rl!.secondary?.windowMinutes, 10080);
});

test("parseLatestCodexRateLimits keeps the LAST snapshot when a rollout has several", () => {
  const content = [
    tokenCountLine({ ...REAL_RATE_LIMITS, primary: { used_percent: 1, window_minutes: 300, resets_at: 1783291926 } }, "2026-07-05T18:00:00.000Z"),
    tokenCountLine({ ...REAL_RATE_LIMITS, primary: { used_percent: 3, window_minutes: 300, resets_at: 1783291933 } }, "2026-07-05T18:05:00.000Z"),
    tokenCountLine(REAL_RATE_LIMITS, "2026-07-05T18:16:21.044Z"),
  ].join("\n");
  const rl = parseLatestCodexRateLimits(content, 1783291932_000);
  assert.equal(rl!.primary?.usedPercent, 32, "latest (last in file), not first or a max");
});

test("parseLatestCodexRateLimits: malformed lines skipped, never fatal", () => {
  const content = ["not json", "{bad", tokenCountLine(REAL_RATE_LIMITS)].join("\n");
  const rl = parseLatestCodexRateLimits(content, 1783291932_000);
  assert.ok(rl);
  assert.equal(rl!.primary?.usedPercent, 32);
});

test("parseLatestCodexRateLimits returns null when no rate_limits are present (older Codex)", () => {
  const content = JSON.stringify({ timestamp: "2026-07-05T18:00:00.000Z", type: "event_msg", payload: { type: "token_count", info: {} } });
  assert.equal(parseLatestCodexRateLimits(content), null);
});

test("formatCodexLimitsLine renders both windows, and the honest fallback when absent", () => {
  const rl = parseLatestCodexRateLimits(tokenCountLine(REAL_RATE_LIMITS), 1783291932_000 - 6 * 60_000);
  assert.equal(formatCodexLimitsLine(rl), "Codex limits: primary 32% used (resets in 6m) | weekly 16% used");
  assert.equal(formatCodexLimitsLine(null), "Codex limits: not reported by this Codex version");
});

// ---- computeCurrent5hBlock ----------------------------------------------------------------------

const H = 60 * 60 * 1000;

test("computeCurrent5hBlock: a single contiguous run is one block", () => {
  const t0 = Date.parse("2026-07-05T10:00:00.000Z");
  const entries = [
    { ts: t0, total: 100 },
    { ts: t0 + 1 * H, total: 200 },
    { ts: t0 + 2 * H, total: 50 },
  ];
  const block = computeCurrent5hBlock(entries, t0 + 2 * H + 30 * 60_000);
  assert.equal(block!.blockStartMs, t0);
  assert.equal(block!.tokensUsed, 350);
  assert.equal(block!.active, true);
  assert.equal(block!.resetMs, t0 + 5 * H);
});

test("computeCurrent5hBlock: a gap >= 5h starts a NEW block; only its entries count", () => {
  const t0 = Date.parse("2026-07-05T00:00:00.000Z");
  const entries = [
    { ts: t0, total: 1000 }, // old block
    { ts: t0 + 1 * H, total: 500 }, // old block
    { ts: t0 + 6 * H, total: 40 }, // gap of 5h from previous entry -> new block starts here
    { ts: t0 + 6 * H + 10 * 60_000, total: 60 },
  ];
  const block = computeCurrent5hBlock(entries, t0 + 6 * H + 20 * 60_000);
  assert.equal(block!.blockStartMs, t0 + 6 * H);
  assert.equal(block!.tokensUsed, 100, "only the new block's entries count, old ones excluded");
});

test("computeCurrent5hBlock: exactly 5h gap counts as a new block (>= boundary)", () => {
  const t0 = 0;
  const entries = [
    { ts: t0, total: 10 },
    { ts: t0 + 5 * H, total: 20 }, // exactly the threshold
  ];
  const block = computeCurrent5hBlock(entries, t0 + 5 * H);
  assert.equal(block!.blockStartMs, t0 + 5 * H);
  assert.equal(block!.tokensUsed, 20);
});

test("computeCurrent5hBlock: window closed once now is past blockStart + 5h with no new activity", () => {
  const t0 = 0;
  const entries = [{ ts: t0, total: 10 }];
  const block = computeCurrent5hBlock(entries, t0 + 6 * H);
  assert.equal(block!.active, false);
});

test("computeCurrent5hBlock: empty input yields null", () => {
  assert.equal(computeCurrent5hBlock([], Date.now()), null);
});

test("formatClaude5hLine renders the estimate, honestly labeled, with no fabricated percentage", () => {
  const t0 = Date.parse("2026-07-05T10:00:00.000Z");
  const block = computeCurrent5hBlock([{ ts: t0, total: 12_345 }], t0 + 30 * 60_000);
  const line = formatClaude5hLine(block);
  assert.match(line, /^Claude session \(5h window, est\., whole-corpus\): 12\.3K tokens used, window opened \d{2}:\d{2}, resets ~\d{2}:\d{2}$/);
  assert.equal(formatClaude5hLine(null), "Claude session (5h window, est., whole-corpus): no recent activity");
});

// ---- foldProjectRows (usage --by-project) ------------------------------------------------------

test("foldProjectRows groups per-project summaries, sorted by total desc, with topModel + cost", () => {
  const groups = [
    {
      project: "sanitized-repo-a",
      summaries: [{ models: [{ id: "claude-opus-4-8", input: 1_000_000, output: 200_000, cacheRead: 0, cacheCreation: 0 }] }],
    },
    {
      project: "sanitized-repo-b",
      summaries: [{ models: [{ id: UNPRICED, input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }] }],
    },
  ];
  const rows = foldProjectRows(groups);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].project, "sanitized-repo-a", "bigger total sorts first");
  assert.equal(rows[0].topModel, "claude-opus-4-8");
  assert.equal(rows[0].total, 1_200_000);
  assert.equal(rows[1].project, "sanitized-repo-b");
  assert.equal(rows[1].estCostUsd, null, `${UNPRICED} has no public list price -- never guessed`);
});

test("foldProjectRows: topModel is the largest-total model within the project, not just the first seen", () => {
  const groups = [
    {
      project: "proj",
      summaries: [
        { models: [{ id: "claude-haiku-4-5", input: 5, output: 5, cacheRead: 0, cacheCreation: 0 }] },
        { models: [{ id: "claude-opus-4-8", input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0 }] },
      ],
    },
  ];
  const [row] = foldProjectRows(groups);
  assert.equal(row.topModel, "claude-opus-4-8");
});

test("foldProjectRows: an empty group list yields no rows", () => {
  assert.deepEqual(foldProjectRows([]), []);
});

// ---- foldUsageDayRows (usage --by-day) ---------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

test("foldUsageDayRows buckets entries by LOCAL calendar date, most recent first", () => {
  const now = new Date(2026, 6, 7, 12, 0, 0).getTime(); // local noon, 2026-07-07
  const today = new Date(2026, 6, 7, 9, 0, 0).getTime();
  const yesterday = new Date(2026, 6, 6, 23, 0, 0).getTime();
  const entries = [
    { ts: today, model: "claude-opus-4-8", tokens: { input: 100, output: 0, cacheRead: 0, cacheCreation: 0 } },
    { ts: yesterday, model: "claude-opus-4-8", tokens: { input: 50, output: 0, cacheRead: 0, cacheCreation: 0 } },
  ];
  const rows = foldUsageDayRows(entries, now);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].day, localDayKey(today), "most recent day first");
  assert.equal(rows[0].total, 100);
  assert.equal(rows[1].day, localDayKey(yesterday));
  assert.equal(rows[1].total, 50);
});

test("foldUsageDayRows drops entries outside the trailing window -- never fabricates a day", () => {
  const now = new Date(2026, 6, 7, 12, 0, 0).getTime();
  const tooOld = now - 40 * DAY_MS;
  const rows = foldUsageDayRows(
    [{ ts: tooOld, model: "claude-opus-4-8", tokens: { input: 100, output: 0, cacheRead: 0, cacheCreation: 0 } }],
    now,
    30,
  );
  assert.deepEqual(rows, []);
});

test("foldUsageDayRows: topModel is the day's largest model, and cost sums only the priced portion", () => {
  const now = new Date(2026, 6, 7, 12, 0, 0).getTime();
  const rows = foldUsageDayRows(
    [
      { ts: now, model: UNPRICED, tokens: { input: 5, output: 0, cacheRead: 0, cacheCreation: 0 } }, // unpriced, excluded from cost
      { ts: now, model: "claude-opus-4-8", tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 } },
    ],
    now,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].topModel, "claude-opus-4-8");
  assert.equal(rows[0].estCostUsd, 5); // only the priced opus input counts: 1M tokens * $5/M (the server's rate)
});

test("foldUsageDayRows composes with dedupeClaudeUsageEntries -- a replayed/duplicate entry counts once", () => {
  const ts = "2026-07-07T10:00:00.000Z";
  const baseEntry: ClaudeUsageEntry = {
    timestamp: ts,
    uuid: "u1",
    sessionId: "sess-1",
    version: "2.1.0",
    messageId: "msg-1",
    requestId: "req-1",
    model: "claude-opus-4-8",
    isSidechain: false,
    hasSpeed: false,
    cost: 0,
    entryPoint: "cli",
    thinkingTokens: 0,
    tokens: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
  };
  // The SAME (messageId, requestId) arriving twice -- e.g. a resumed transcript replaying the
  // same message -- must dedupe to ONE entry before the day-fold ever sees it.
  const deduped = dedupeClaudeUsageEntries([baseEntry, { ...baseEntry }]);
  assert.equal(deduped.length, 1, "sanity: dedupe collapses the replay");

  const now = Date.parse(ts);
  const entries = deduped.map((e) => ({ ts: Date.parse(e.timestamp!), model: e.model!, tokens: e.tokens }));
  const rows = foldUsageDayRows(entries, now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 150, "one message's tokens, not two");
});

// ---- Cost estimation (usage --cost) --------------------------------------------------------

test("priceForModel prices the server's families, and only ids that resolve to one", () => {
  assert.ok(priceForModel("claude-opus-4-8"));
  assert.ok(priceForModel("claude-opus-4-8-20260315"), "a dated pin resolves to its base");
  assert.ok(priceForModel("claude-sonnet-4-6"));
  assert.ok(priceForModel("claude-haiku-4-5"));
  assert.ok(priceForModel("claude-haiku-4-5-20260101"));
  assert.ok(priceForModel("claude-sonnet-5"), "sonnet-5 IS priced now — the server has always priced it");
  assert.ok(priceForModel("claude-fable-5"), "fable-5 too — its absence is what produced the phantom '+' floor mark");
  // Haiku families OTHER than 4-5 stay unpriced: no key to resolve to.
  assert.equal(priceForModel("claude-haiku-4-0"), null);
  assert.equal(priceForModel("claude-haiku-3-5"), null);
  assert.equal(priceForModel(UNPRICED), null, "an id no key claims stays unpriced — never a guessed rate");
});

test("estimateCostUsd computes from PRICES per-million rates; unpriced models return null, never a guess", () => {
  const t = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreation: 1_000_000 };
  const opus = PRICES["claude-opus-4-8"];
  assert.equal(estimateCostUsd(t, "claude-opus-4-8"), opus.input + opus.output + opus.cacheRead + opus.cacheCreation);
  assert.equal(estimateCostUsd(t, "totally-unknown-model"), null);
});

test("-preview variants never borrow the family row (D1 ruling, 2026-07-23)", () => {
  // The real Gemini CLI emits gemini-3-pro-preview / gemini-3-flash-preview (the
  // discovery corpus) — a different model with unknown pricing, not a routing suffix.
  // It stays unpriced until a real row lands; a family-row dollar would be an
  // estimate presented as fact.
  assert.equal(priceForModel("gemini-3-pro-preview"), null);
  assert.equal(priceForModel("gemini-3-flash-preview"), null);
  assert.equal(priceForModel("gemini-3-pro-preview-0611"), null, "dated preview builds too");
  const t = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 };
  assert.equal(estimateCostUsd(t, "gemini-3-pro-preview"), null, "spend refuses, never a guessed dollar");
  // Non-preview suffix tolerance is untouched.
  assert.ok(priceForModel("gemini-3-pro"), "the exact family row itself still prices");
});

test("priceForModel resolves suffixes, OpenRouter prefixes, and the LONGEST base", () => {
  assert.equal(priceForModel("claude-opus-4-8[1m]"), PRICES["claude-opus-4-8"], "a routing suffix still prices");
  assert.equal(priceForModel("openrouter/anthropic/claude-sonnet-5"), PRICES["claude-sonnet-5"], "route + vendor prefix stripped");
  assert.equal(priceForModel("anthropic/claude-opus-4-8"), PRICES["claude-opus-4-8"], "vendor prefix stripped");
  // Longest-base, not first-match: "claude-sonnet-5" must NOT resolve through a
  // shorter "claude-sonnet-4-5" style key, and a real family must win over a prefix.
  assert.equal(priceForModel("claude-sonnet-5"), PRICES["claude-sonnet-5"]);
  assert.equal(priceForModel("gpt-5.4-mini"), PRICES["gpt-5.4-mini"], "the LONGEST key wins over gpt-5 / gpt-5.4");
  assert.equal(priceForModel("totally-unknown-model"), null, "unknown stays unpriced — never a guessed rate");
  assert.equal(priceForModel(""), null);
});

test("estimateGroupCostUsd sums only priced models; null when none of the group is priced", () => {
  const models = [
    { id: "claude-opus-4-8", input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }, // $5 (server rate)
    { id: "totally-unknown-model", input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }, // unpriced, excluded
  ];
  assert.equal(estimateGroupCostUsd(models), 5);
  assert.equal(estimateGroupCostUsd([{ id: "totally-unknown-model", input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }]), null);
  assert.equal(estimateGroupCostUsd([]), null);
});

test("formatCostUsd: unpriced text (never a guess), $0.00, and extra precision for sub-cent estimates", () => {
  assert.equal(formatCostUsd(null), "unpriced");
  assert.equal(formatCostUsd(0), "$0.00");
  assert.equal(formatCostUsd(0.0003), "$0.0003");
  assert.equal(formatCostUsd(1.5), "$1.50");
});

// ---- JSON row shapes (usage --json) --------------------------------------------------------

test("usageRowsToJson mirrors the table columns, and omits estCostUsd unless --cost", () => {
  const rows = foldModelRows([{ models: [{ id: "claude-opus-4-8", input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }] }]).rows;
  const plain = usageRowsToJson(rows);
  assert.deepEqual(plain, [{ model: "claude-opus-4-8", input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0, total: 1_000_000 }]);
  const withCost = usageRowsToJson(rows, { cost: true });
  assert.equal(withCost[0].estCostUsd, 5, "1M opus input at the server's $5/M");
});

test("projectRowsToJson / dayRowsToJson: same estCostUsd gating, topModel included by default", () => {
  const projectRows = foldProjectRows([{ project: "proj", summaries: [{ models: [{ id: UNPRICED, input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }] }] }]);
  const plainProject = projectRowsToJson(projectRows);
  assert.deepEqual(plainProject, [{ project: "proj", input: 10, output: 5, cacheRead: 0, cacheCreation: 0, total: 15, topModel: UNPRICED }]);
  assert.equal(projectRowsToJson(projectRows, { cost: true })[0].estCostUsd, null);

  const dayRows = foldUsageDayRows([{ ts: 0, model: UNPRICED, tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 } }], 0, 1);
  const plainDay = dayRowsToJson(dayRows);
  assert.deepEqual(plainDay, [{ day: localDayKey(0), input: 10, output: 5, cacheRead: 0, cacheCreation: 0, total: 15, topModel: UNPRICED }]);
});

// ---- Partial-cost marker (a priced sum sitting next to unpriced usage is a FLOOR) -----------

test("hasUnpricedUsage: true only when an unpriced model carries REAL tokens", () => {
  assert.equal(hasUnpricedUsage([{ id: UNPRICED, input: 1, output: 0, cacheRead: 0, cacheCreation: 0 }]), true);
  assert.equal(hasUnpricedUsage([{ id: UNPRICED, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }]), false, "zero-token unpriced model marks nothing");
  assert.equal(hasUnpricedUsage([{ id: "claude-opus-4-8", input: 1, output: 0, cacheRead: 0, cacheCreation: 0 }]), false);
  // fable-5 was THE cause of the phantom "+" on Marco's screen: real usage on a model
  // the CLI didn't price, while the server priced it all along.
  assert.equal(hasUnpricedUsage([{ id: "claude-fable-5", input: 1, output: 0, cacheRead: 0, cacheCreation: 0 }]), false, "fable-5 is priced now — it must no longer mark a floor");
  assert.equal(hasUnpricedUsage([]), false);
});

test("formatCostUsd appends + when the group also holds unpriced usage; unpriced never gets one", () => {
  assert.equal(formatCostUsd(1.5, true), "$1.50+");
  assert.equal(formatCostUsd(1.5, false), "$1.50");
  assert.equal(formatCostUsd(null, true), "unpriced");
});

test("projectRowsToJson flags a mixed priced/unpriced group as estCostIsPartial", () => {
  const mixed = foldProjectRows([{ project: "proj", summaries: [{ models: [
    { id: "claude-opus-4-8", input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
    { id: UNPRICED, input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
  ] }] }]);
  const [row] = projectRowsToJson(mixed, { cost: true });
  assert.equal(row.estCostUsd, 5, "only the priced opus slice is summed, at the server's $5/M");
  assert.equal(row.estCostIsPartial, true);
  const pure = foldProjectRows([{ project: "proj", summaries: [{ models: [
    { id: "claude-opus-4-8", input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
  ] }] }]);
  assert.equal(projectRowsToJson(pure, { cost: true })[0].estCostIsPartial, false);
});
