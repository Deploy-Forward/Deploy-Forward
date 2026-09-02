/**
 * usage-core/pricing — THE canonical rate table, tier bands, and spend math.
 *
 * CANONICAL SOURCE (P1, docs/product-audit-2026-07.md §5). This module is open (MIT,
 * see ../LICENSE) and self-contained: no imports, no vendor SDKs, no I/O. Public
 * facts and estimation only — explicitly NO scoring math, ever. Each consumer
 * package carries a byte-identical copy under src/core/ produced by
 * `node usage-core/sync.mjs`; coreParity tests fail on any drift, and a parity
 * test on the closed side pins the service's bundled DATA to this table.
 * Edit HERE, run the sync, commit everything it touched. Never edit a copy.
 *
 * Spend is STATUS ONLY. Pricing must NEVER feed a rank numerator — nothing may gain
 * rank by spending. Where cost appears in any ranking at all, it only ever DIVIDES
 * (an efficiency denominator), so spending more can only lower a rank. The public
 * Build Score is pricing-free.
 *
 * Spend uses RAW counts × per-token price. Scoring-side token weighting (a closed,
 * separate concept) must never be reused here.
 *
 * Pure and deterministic — unit-tested via each consumer's pricing suites.
 */

/** Raw token counts by kind — the capture contract's count shape. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Per-model price, USD per 1,000,000 tokens, by token kind. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Data-quality label: "VERIFY" marks a rate typed from a feed snapshot / published
   * figure that has NOT been confirmed against the vendor's own pricing page. */
  note?: string;
}

export interface PricingTable {
  version: number;
  /** Currency of every rate below. */
  currency: "USD";
  /** The unit the rates are quoted in (tokens per price). */
  per: 1_000_000;
  models: Record<string, ModelPricing>;
}

/**
 * Anthropic rows: every current row below was verified VERBATIM against
 * platform.claude.com/docs/en/about-claude/pricing on 2026-08-29 (input, output,
 * cache-hit, and 5m cache-write columns). Multipliers per that page: 5m write 1.25x
 * input, cache read 0.1x input — EXCEPT Fable 5.1 / Mythos 5.1, where cache reads
 * are 0.025x ($0.25). The 1h-TTL write (2x) is NOT modeled anywhere in this table.
 * Rebase ledger: 2026-08-29 (Marco: "rebase the price-tracking"), prior 2026-08-14.
 */
export const PRICING: PricingTable = {
  version: 3,
  currency: "USD",
  per: 1_000_000,
  models: {
    // Fable 5.1 / Mythos 5.1 (Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-29): $10 / $50, 5m write $12.50, and a NEW cache-read
    // multiplier — 0.025x = $0.25 (all other models 0.1x). These rows MUST exist
    // explicitly: without them the suffix fallback resolved "claude-fable-5-1" to the
    // Fable 5 row and priced cache reads at $1.00 — a silent 4x overstatement on the
    // bucket that dominates agent sessions, shown as "priced" so nothing flagged it.
    "claude-fable-5-1": { input: 10.0, output: 50.0, cacheRead: 0.25, cacheCreation: 12.5, note: "Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-29; cache read 0.025x ($0.25), not the 0.1x family default" },
    "claude-mythos-5-1": { input: 10.0, output: 50.0, cacheRead: 0.25, cacheCreation: 12.5, note: "Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-29 (limited availability); cache read 0.025x ($0.25)" },
    // Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-29
    "claude-fable-5": { input: 10.0, output: 50.0, cacheRead: 1.0, cacheCreation: 12.5 },
    // Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-29
    "claude-mythos-5": { input: 10.0, output: 50.0, cacheRead: 1.0, cacheCreation: 12.5 },
    // Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-14:
    // $5 / $25, cache read $0.50, 5m cache write $6.25 — same row as Opus 4.8. Was the
    // largest unpriced id on real corpora (3.3B tokens excluded from usage --cost while
    // the Board priced it via its feed overlay — the spend-misalignment driver).
    "claude-opus-5": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheCreation: 6.25 },
    // Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-29
    "claude-opus-4-8": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheCreation: 6.25 },
    // Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-29
    "claude-opus-4-7": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheCreation: 6.25 },
    // Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-29
    "claude-opus-4-6": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheCreation: 6.25 },
    // Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-29
    "claude-opus-4-5": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheCreation: 6.25 },
    // Sonnet 5: $2/$10 ($0.20 cache read, $2.50 5m write) is now the PERMANENT rate —
    // platform.claude.com/docs pricing 2026-08-14, verbatim: "the previously scheduled
    // increase to $3/$15 per million input/output tokens on September 1, 2026 will not
    // occur." The Sept-1 reprice instruction that used to live here is CANCELLED; do
    // not execute it.
    "claude-sonnet-5": { input: 2.0, output: 10.0, cacheRead: 0.2, cacheCreation: 2.5 },
    // Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-29
    "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
    // Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-29
    "claude-sonnet-4-5": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
    // Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-29
    "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheRead: 0.1, cacheCreation: 1.25 },

    // Observed non-Anthropic models (router-served ids reach ~/.claude via
    // ANTHROPIC_BASE_URL / claude-code-router / OpenRouter). Rates typed from the
    // LiteLLM feed snapshot of 2026-07-01; the runtime meta/pricing feed supersedes
    // this table — these exist only as the offline/absent fallback. Vendors that
    // don't bill cache writes separately get cacheCreation = input rate (cache-write
    // tokens bill as ordinary input there), NOT an Anthropic-style 1.25x. VERIFY all
    // against the vendor's own pricing page before treating any number as authoritative.
    "kimi-k2": { input: 0.6, output: 2.5, cacheRead: 0.15, cacheCreation: 0.6, note: "VERIFY" },
    "glm-4.6": { input: 0.6, output: 2.2, cacheRead: 0.11, cacheCreation: 0.6, note: "VERIFY" },
    "gpt-5": { input: 1.25, output: 10.0, cacheRead: 0.125, cacheCreation: 1.25, note: "VERIFY" },
    "gpt-5.4": { input: 2.5, output: 15.0, cacheRead: 0.25, cacheCreation: 2.5, note: "developers.openai.com/api/docs/pricing 2026-08-15 (<272K context tier); no separate cache-write charge, cacheCreation = input" },
    "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheCreation: 0.75, note: "developers.openai.com/api/docs/pricing 2026-08-15; no separate cache-write charge, cacheCreation = input" },

    // OpenAI gpt-5.6 family: developers.openai.com/api/docs/pricing, first verified
    // 2026-08-15; sol repriced downward 2026-08-29 (per-row notes carry the ledger).
    // Rates are the SHORT-context tier (<272K prompt); long-context tiers are NOT
    // modeled — same policy as grok-4.6. Cache writes bill as ordinary input
    // (cacheCreation = input) EXCEPT cyber, which has a real cache-write charge.
    // Bare "gpt-5.6" is models.dev's alias at sol's rates, kept so a harness that
    // logs the bare id prices identically to sol.
    "gpt-5.6": { input: 4.0, output: 20.0, cacheRead: 0.4, cacheCreation: 4.0, note: "developers.openai.com/api/docs/pricing 2026-08-29; alias of gpt-5.6-sol per models.dev; repriced 5/30/0.5 -> 4/20/0.4 (LiteLLM first 2026-08-23, models.dev 2026-08-25, vendor-verified 2026-08-29); promotional floor: vendor says available at least through 2026-11-21 — a later reversion is a reprice to observe, never pre-entered; long-context (>=272K) tier 8/0.8/30 NOT modeled" },
    "gpt-5.6-sol": { input: 4.0, output: 20.0, cacheRead: 0.4, cacheCreation: 4.0, note: "developers.openai.com/api/docs/pricing 2026-08-29; repriced 5/30/0.5 -> 4/20/0.4 (LiteLLM first 2026-08-23, models.dev 2026-08-25, vendor-verified 2026-08-29); promotional floor: vendor says available at least through 2026-11-21 — a later reversion is a reprice to observe, never pre-entered; long-context (>=272K) tier 8/0.8/30 NOT modeled" },
    "gpt-5.6-terra": { input: 2.0, output: 12.0, cacheRead: 0.2, cacheCreation: 2.0, note: "developers.openai.com/api/docs/pricing 2026-08-15; long-context (>=272K) tier 4/0.4/18 NOT modeled" },
    "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheCreation: 0.2, note: "developers.openai.com/api/docs/pricing 2026-08-15; long-context (>=272K) tier 0.4/0.04/1.8 NOT modeled" },
    "gpt-5.6-cyber": { input: 12.5, output: 75.0, cacheRead: 1.25, cacheCreation: 15.625, note: "developers.openai.com/api/docs/pricing 2026-08-29; cache writes billed separately at 15.625 (1.25x input) — the one gpt-5.6 variant with a real cache-write charge" },
    "gemini-3-flash": { input: 0.5, output: 3.0, cacheRead: 0.05, cacheCreation: 0.5, note: "VERIFY" },
    "gemini-3-pro": { input: 2.0, output: 12.0, cacheRead: 0.2, cacheCreation: 2.0, note: "VERIFY" },

    // xAI Grok CLI models (G2, docs/grok-capture-plan.md): rates decoded from docs.x.ai's
    // live model registry 2026-07-10 (promptTextTokenPrice/10000 = $ per 1M), cross-checked
    // against the page's rendered figures. grok-code-fast-1 is xAI's own ALIAS of
    // grok-build-0.1 (same registry entry, same rates; prefix matching covers -1/-0825
    // variants). Bare "grok-build" (seen in older sessions) is NOT in the registry and
    // stays honestly unpriced — never assumed. These four lived only in web's table until
    // P1 unified the tables, so the server priced real grok spend at $0. cacheCreation
    // follows this table's stated convention (no separate cache-write billing ->
    // cacheCreation = input rate); web's original entries carried 0 there, inert in
    // practice because the grok adapter never emits cache-write tokens.
    "grok-4.6": { input: 2.0, output: 6.0, cacheRead: 0.5, cacheCreation: 2.0, note: "docs.x.ai 2026-08-12, re-verified unchanged 2026-08-29 (2/6/0.5; models.dev agrees); long-context (>=200K prompt) tier 4/1/12 NOT modeled" },
    "grok-4.5": { input: 2.0, output: 6.0, cacheRead: 0.3, cacheCreation: 2.0, note: "docs.x.ai 2026-08-14 (cacheRead corrected 0.5->0.3 - the drift watch's first catch); long-context (>=200K) tier is higher and NOT modeled" },
    "grok-4.3": { input: 1.25, output: 2.5, cacheRead: 0.2, cacheCreation: 1.25, note: "docs.x.ai 2026-07-10; long-context (>200K) tier is higher and NOT modeled" },
    "grok-build-0.1": { input: 1.0, output: 2.0, cacheRead: 0.2, cacheCreation: 1.0, note: "docs.x.ai 2026-07-10" },
    "grok-code-fast": { input: 1.0, output: 2.0, cacheRead: 0.2, cacheCreation: 1.0, note: "xAI alias of grok-build-0.1 (docs.x.ai 2026-07-10)" },
  },
};

/** Default model when a session doesn't specify one — matches scoring/ingest defaults. */
export const DEFAULT_MODEL = "claude-opus-4-8";

/** Note returned alongside a spend computation when the model isn't in the table. */
export const PRICING_UNKNOWN_NOTE = "pricing_unknown";

/**
 * OpenRouter vendor-prefix aliases: cases where the vendor/model slug OpenRouter
 * actually emits genuinely differs from this table's key, so a mechanical
 * strip-the-vendor-segment-and-match wouldn't find it. Keep this list SMALL and
 * evidence-based — add an entry only once a real corpus (spec §4, W1.0/W1.6) shows
 * OpenRouter emitting that exact slug; never pre-guess a vendor namespace. (E.g.
 * "x-ai/grok-code-fast-1" needs NO entry here: stripping "x-ai/" leaves
 * "grok-code-fast-1", which resolveBase's own suffix fallback already resolves to
 * the "grok-code-fast" key above — see that table's alias comment.)
 */
const OPENROUTER_ALIASES: Record<string, string> = {};

/** True if `id` is exactly a priced key or a suffix-variant of one (the same test
 * priceForModel applies below) — the one definition of "is this priced", shared by
 * normalizeModelId (to decide whether stripping a vendor segment is safe) and
 * priceForModel (the final lookup), so they can never disagree. */
/**
 * A prefix match is honest only when the remainder is a routing/deployment suffix.
 * A remainder that starts a NEW WORD names a DIFFERENT model whose pricing is unknown;
 * resolving it to the family row would present an estimate as fact. Such ids stay
 * unpriced until a real row lands. An exact-key row always wins above this test.
 *
 * This generalizes the D1 ruling (docs/canonical-plan.md §9), which drew exactly this
 * line for exactly one suffix, "-preview". The catalog says the rule was always broader:
 * measured against the LiteLLM catalog on 2026-07-31, 348 canonical ids have a shorter
 * id as a prefix with an alphabetic remainder, and 133 of them (38%) sit more than 2x
 * away from the family rate a prefix match would apply. The sharpest live case is
 * "gpt-5.6-luna" ($0.20/$1.20) against "gpt-5.6" ($5/$30) — a silent 25x overstatement
 * that both magnitude guards would pass, since a brand-new id has no bundled anchor and
 * $5/$30 is an unremarkable magnitude for a frontier model.
 *
 * A DIGIT-led remainder ("kimi-k2-0905", "grok-code-fast-1", "grok-build-0.1") is a
 * build or date pin of the same product and still resolves. So is a single trailing
 * letter, which reads as a revision marker; every real named variant in the catalog
 * (luna, nano, free, mini, preview, flash, turbo, thinking) is two letters or more.
 */
export function isNamedVariant(id: string, key: string): boolean {
  if (id === key || !id.startsWith(key)) return false;
  const rest = id.slice(key.length).replace(/^[-_. :]+/, "");
  return /^[a-z]{2}/i.test(rest);
}

function resolveBase(id: string, rates: RatesTable = PRICING.models): string | null {
  if (rates[id]) return id;
  let best: string | null = null;
  for (const key of Object.keys(rates)) {
    if (id.startsWith(key) && !isNamedVariant(id, key) && (best === null || key.length > best.length)) {
      best = key;
    }
  }
  return best;
}

/**
 * Normalize a raw model id the way it reaches this table when routed through
 * OpenRouter (spec §4). Two steps, in order:
 *   1. Strip a leading "openrouter/" route prefix ("openrouter/anthropic/
 *      claude-sonnet-5" -> "anthropic/claude-sonnet-5") — a routing artifact, not
 *      part of the model's identity.
 *   2. If what's left is "vendor/model", check whether the part after the first
 *      "/" (or its OPENROUTER_ALIASES translation) is already a priced id per
 *      resolveBase; if so, drop the vendor segment.
 * Anything that doesn't resolve passes through UNCHANGED (beyond the openrouter/
 * strip) and stays unpriced — never guess a price for an id we don't recognize.
 * Case-sensitive, matching priceForModel's existing lookup (OpenRouter ids and this
 * table's keys are both lowercase by convention; no case folding is done here).
 * Idempotent: normalizing an already-normalized id returns it unchanged.
 */
export function normalizeModelId(raw: string, rates: RatesTable = PRICING.models): string {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  let id = raw;
  const ROUTE_PREFIX = "openrouter/";
  // while, not if: a doubly-routed id (router-through-router) must normalize in ONE
  // application or the documented idempotence claim breaks — n applications of a
  // route prefix are all routing artifacts, none of them identity.
  while (id.startsWith(ROUTE_PREFIX)) id = id.slice(ROUTE_PREFIX.length);

  const slash = id.indexOf("/");
  if (slash <= 0) return id; // no vendor segment left to resolve

  const rest = id.slice(slash + 1);
  const candidate = OPENROUTER_ALIASES[rest] ?? rest;
  return resolveBase(candidate, rates) ? candidate : id;
}

/**
 * Resolve a price for a model id. Normalizes OpenRouter-routed ids first
 * (normalizeModelId), then tolerates deployment/routing suffixes the tracker may
 * emit (e.g. "claude-opus-4-8[1m]", "claude-opus-4-8-fast") by falling back to the
 * longest known base id that the given id starts with. Returns null if nothing
 * matches — callers must treat that as $0, never throw.
 */
export function priceForModel(model: string, rates: RatesTable = PRICING.models): ModelPricing | null {
  // Falsy/non-string guard, mirroring web's deliberate defensiveness (the type says
  // string; runtime records may still carry null/undefined — unpriced, never a throw).
  if (typeof model !== "string" || model.length === 0) return null;
  const base = resolveBase(normalizeModelId(model, rates), rates);
  return base ? rates[base] : null;
}

/**
 * Spend in USD for a set of RAW token counts under a model's price.
 *
 * Defensive by contract: an unknown model yields 0 (never a throw). Negative counts
 * are floored at 0 so a bad payload can't produce a negative or absurd spend.
 */
export function computeSpend(
  tokens: TokenCounts,
  model: string = DEFAULT_MODEL,
  rates: RatesTable = PRICING.models
): number {
  const p = priceForModel(model, rates);
  if (!p) return 0;
  const usd =
    (Math.max(0, tokens.input) * p.input +
      Math.max(0, tokens.output) * p.output +
      Math.max(0, tokens.cacheRead) * p.cacheRead +
      Math.max(0, tokens.cacheCreation) * p.cacheCreation) /
    PRICING.per;
  return usd;
}

/**
 * Same as computeSpend, but surfaces a 'pricing_unknown' note for the status board
 * so an unpriced model reads as "$0 — unknown pricing" rather than a real zero.
 */
export function computeSpendDetailed(
  tokens: TokenCounts,
  model: string = DEFAULT_MODEL,
  rates: RatesTable = PRICING.models
): { usd: number; note?: string } {
  if (!priceForModel(model, rates)) return { usd: 0, note: PRICING_UNKNOWN_NOTE };
  return { usd: computeSpend(tokens, model, rates) };
}

// ---------------------------------------------------------------------------
// Model tier bands — canonical, dated, append-only (docs/methodology-changelog.md).
// STATUS-ONLY like everything else in this file: tiers never feed rank.
// NOTE: the closed service also has a rating-tier TIER_BANDS — that is the RATING
// (leaderboard) tier config, entirely unrelated to these model PRICE bands.
// ---------------------------------------------------------------------------

/** One dated band definition: absolute output-rate cuts, USD per 1M OUTPUT tokens. */
export interface TierBands {
  /** YYYY-MM-DD the entry takes force. */
  from: string;
  /** Output $/MTok at or above = premium. */
  premiumMin: number;
  /** Output $/MTok strictly below = commodity. */
  commodityMax: number;
  note: string;
}

/**
 * Append a dated entry to re-baseline when the market moves; NEVER edit an old
 * entry — history is how a usage day keeps the bands it ran under (time-lock), and
 * docs/methodology-changelog.md records every entry's reasoning.
 */
export const TIER_BAND_HISTORY: TierBands[] = [
  {
    from: "2026-07-17",
    premiumMin: 10,
    commodityMax: 4,
    note: "initial absolute-band calibration (docs/mue-quadrant-valuemax-spec.md)",
  },
  {
    from: "2026-07-21",
    premiumMin: 20,
    commodityMax: 6,
    note: "premium = frontier flagships only (Fable/Mythos/Opus); Sonnet-class standard; Haiku-class commodity (Marco 2026-07-21)",
  },
];

export type ModelTier = "premium" | "standard" | "commodity";

/** Flat per-model rate map — the shape buildRates produces and meta/pricing stores. */
export type RatesTable = Record<string, ModelPricing>;

/**
 * Band definition in force on dayKey (YYYY-MM-DD). Before the first entry -> first;
 * missing/invalid dayKey -> latest. Time-lock: a usage day is always read with its
 * own bands, never today's.
 */
export function tierBandsAsOf(dayKey?: string | null): TierBands {
  const h = TIER_BAND_HISTORY;
  if (typeof dayKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return h[h.length - 1];
  let cur = h[0];
  for (const b of h) {
    if (b.from <= dayKey) cur = b;
    else break;
  }
  return cur;
}

/** Output rate for `id` in a FLAT rates table: exact key, normalized key, then the
 * longest base key the id starts with (the same suffix-variant tolerance
 * resolveBase applies to the bundled table, scoped to the given rates). */
function outputRateIn(id: string, rates: RatesTable): number | null {
  if (typeof id !== "string" || id.length === 0) return null;
  const direct = rates[id] ?? rates[normalizeModelId(id)];
  if (direct) return direct.output;
  let best: string | null = null;
  for (const key of Object.keys(rates)) {
    if (id.startsWith(key) && !isNamedVariant(id, key) && (best === null || key.length > best.length)) best = key;
  }
  return best ? rates[best].output : null;
}

/**
 * tierForModel(id, rates, dayKey) -> "premium" | "standard" | "commodity" | null
 * Absolute-dollar classification of the model's OUTPUT list rate against the bands
 * in force on dayKey (latest bands when omitted). Unpriced or non-positive rate ->
 * null: an unknown or local model is UNKNOWN, never silently a tier — callers
 * exclude it from tier shares and surface it as an unpriced share.
 */
export function tierForModel(
  id: string,
  rates: RatesTable = PRICING.models,
  dayKey?: string | null
): ModelTier | null {
  const output = outputRateIn(id, rates);
  if (typeof output !== "number" || !(output > 0)) return null;
  const bands = tierBandsAsOf(dayKey);
  if (output >= bands.premiumMin) return "premium";
  if (output < bands.commodityMax) return "commodity";
  return "standard";
}

/** One tier interval in the meta/tierTimeline doc. */
export interface TierInterval {
  from: string;
  tier: ModelTier;
}
export type TimelineModels = Record<string, TierInterval[]>;

/**
 * resolveTierAt(models, id, dayKey) -> tier | null
 * Interval lookup in the meta/tierTimeline doc: the tier in force for this model on
 * this usage day (last interval with from <= dayKey; a day before the model's first
 * interval uses that earliest-known interval). null on any miss or corrupt value —
 * the caller falls back to tierForModel(current rates, latest bands), the documented
 * behavior until timeline history accrues.
 */
export function resolveTierAt(
  models: TimelineModels | null | undefined,
  id: string,
  dayKey: string
): ModelTier | null {
  if (!models || typeof models !== "object") return null;
  const intervals = models[normalizeModelId(id)] ?? models[id];
  if (!Array.isArray(intervals) || intervals.length === 0) return null;
  let cur: TierInterval | null = null;
  for (const iv of intervals) {
    if (!iv || typeof iv.from !== "string") continue;
    if (iv.from <= dayKey) cur = iv;
    else break;
  }
  // NO BACKWARD EXTRAPOLATION (fixed 2026-07-28, A1) - mirrors the service's resolver.
  // Was `cur ?? intervals[0]`, so a day before a model's first interval inherited that
  // interval's tier. The live meta/tierTimeline's earliest entry for every one of its 21
  // models is 2026-07-21, the day the bands were recalibrated and the feed started, so
  // that fallback governed ALL history for ALL timelined models. A first interval records
  // when the FEED began observing, not when the model began existing.
  if (!cur) return null;
  return cur.tier === "premium" || cur.tier === "standard" || cur.tier === "commodity"
    ? cur.tier
    : null;
}
