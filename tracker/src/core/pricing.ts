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
 * Rebase ledger: 2026-11-01 (Marco: "rebase to the latest prices and models" — every
 * Anthropic row re-read verbatim on that page, all unchanged; OpenAI, Google, xAI and
 * Zhipu pages re-read the same day, see the per-vendor blocks), 2026-08-29 (Marco:
 * "rebase the price-tracking"), prior 2026-08-14.
 */
export const PRICING: PricingTable = {
  version: 4,
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
    // Opus 5.5 (Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-09-29): $4 / $20, 5m write $5, and its OWN cache-read multiplier — 0.05x =
    // $0.20 (Fable 5.1 is 0.025x, everything else 0.1x). Explicit row REQUIRED: the
    // suffix fallback resolved "claude-opus-5-5" to Opus 5's row (5/25, cache read 0.50)
    // — a 25% overstatement on input/output and 2.5x on cache reads, displayed as priced.
    "claude-opus-5-5": { input: 4.0, output: 20.0, cacheRead: 0.2, cacheCreation: 5.0, note: "Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-09-29; cache read 0.05x ($0.20); models.dev + LiteLLM agree; fast mode 8/40 and batch 2/10 are billing modes, NOT modeled" },
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
    // Sonnet 5.5 (Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-09-29): same row as Sonnet 5 — $2 / $10, cache read $0.20, 5m write $2.50.
    // Explicit anyway: the fallback happened to land on the right numbers today, and a
    // row that is right by accident is one Sonnet-5 reprice away from being wrong.
    "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheRead: 0.1, cacheCreation: 2.5, note: "Cache read 0.05x ($0.10): claude.com/pricing 2026-10-07 ('Read: $0.10 / MTok') and the platform.claude.com pricing page's prompt-caching section agree; that page's model table still shows $0.20; LiteLLM agrees at 0.1, models.dev still 0.2. Was 0.2 (verified 2026-09-29)" },
    "claude-sonnet-5": { input: 2.0, output: 10.0, cacheRead: 0.2, cacheCreation: 2.5 },
    // Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-29
    "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
    // Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-29
    "claude-sonnet-4-5": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
    // Haiku 5.5 (Verified verbatim at platform.claude.com/docs/en/about-claude/pricing
    // 2026-10-07): "Claude Haiku 5.5 (for prompts up to 100,000 tokens): $0.10 / MTok
    // input, $0.125 5m cache writes, $0.20 1h cache writes, $0.01 cache hits, $0.50
    // output." This <=100K-prompt tier is the row below -- the tier aggregators list
    // (models.dev/LiteLLM hint 0.1/0.5, cr=0.01, cw=0.125) and the one check-price-drift
    // and check-unpriced-ids compare against. Released 2026-10-07 and was the id the
    // public price-drift workflow's "Check for unpriced new models" step flagged the
    // same day (every token reading as $0) before this row existed.
    // Prompts OVER 100,000 tokens bill at $0.50 input / $0.625 5m write / $1 1h write /
    // $0.05 cache hits / $2.50 output (same page) -- NOT modeled, same "long-context
    // tier NOT modeled" policy this table already applies to gpt-5.6/grok above. Unlike
    // every other current Claude family, this split is NOT the "[1m]"-suffix beta: the
    // vendor page's own Long context pricing section singles it out — "Claude 4.6 and
    // later models (except Claude Haiku 5.5) ... include the full 1M token context
    // window at standard pricing ... Claude Haiku 5.5 is priced by prompt length" — so
    // the tiering is a property of the base model, not an opt-in. See contextWindows.ts
    // for the matching context-window entry and its own note.
    "claude-haiku-5-5": { input: 0.10, output: 0.50, cacheRead: 0.01, cacheCreation: 0.125, note: "Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-10-07; this is the <=100,000-prompt-token tier. Prompts over 100,000 tokens bill at input 0.50 / cacheCreation(5m) 0.625 / cacheRead 0.05 / output 2.50 (same page) -- NOT modeled, same policy as this table's other long-context tiers" },
    // Verified verbatim at platform.claude.com/docs/en/about-claude/pricing 2026-08-29
    "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheRead: 0.1, cacheCreation: 1.25 },

    // Observed non-Anthropic models (router-served ids reach ~/.claude via
    // ANTHROPIC_BASE_URL / claude-code-router / OpenRouter). Rates typed from the
    // LiteLLM feed snapshot of 2026-07-01; the runtime meta/pricing feed supersedes
    // this table — these exist only as the offline/absent fallback. Vendors that
    // don't bill cache writes separately get cacheCreation = input rate (cache-write
    // tokens bill as ordinary input there), NOT an Anthropic-style 1.25x. VERIFY all
    // against the vendor's own pricing page before treating any number as authoritative.
    // Moonshot (2026-11-01 rebase): platform.kimi.ai/docs/pricing/chat renders its price
    // tables client-side; the page fetched that day carried EMPTY tables, so no Kimi row
    // has a vendor citation yet and every one stays VERIFY (aggregator-typed from the
    // native moonshotai rows on models.dev, LiteLLM agreeing where it lists the id). What
    // the page does state verbatim: K3 series context 1,048,576; K2 series 262,144; "K2
    // series models will no longer be available to newly registered users from 2026-10-31"
    // and all K2 models retire by end of December 2026. The -highspeed variants are speed
    // tiers of the same models (billing modes, NOT modeled, same policy as fast mode).
    "kimi-k2": { input: 0.6, output: 2.5, cacheRead: 0.15, cacheCreation: 0.6, note: "VERIFY" },
    "kimi-k3.1-pro": { input: 2.0, output: 10.0, cacheRead: 0.2, cacheCreation: 2.0, note: "VERIFY" },
    // kimi-k3.1-pro-highspeed (models.dev moonshotai, released 2026-10-23, 4/20/0.2): caught
    // by the exported-tree unpriced check on 2026-11-01 -- WITHOUT this row the resolver
    // priced it at kimi-k3's 3/15, because "kimi-k3" + ".1-pro-highspeed" reads as a
    // version-pinned remainder (dot, then a digit). Its own row ends that; VERIFY until the
    // Moonshot pricing page renders.
    "kimi-k3.1-pro-highspeed": { input: 4.0, output: 20.0, cacheRead: 0.2, cacheCreation: 4.0, note: "VERIFY" },
    "kimi-k3": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.0, note: "VERIFY" },
    "kimi-k2.7-code": { input: 0.95, output: 4.0, cacheRead: 0.19, cacheCreation: 0.95, note: "VERIFY" },
    "kimi-k2.6": { input: 0.95, output: 4.0, cacheRead: 0.16, cacheCreation: 0.95, note: "VERIFY" },
    // Zhipu (docs.z.ai/guides/overview/pricing, read 2026-11-01): input / cached input /
    // output verbatim; "Cached Input Storage: Limited-time Free" with no end date, so no
    // per-token write charge -> cacheCreation = input. glm-4.6 graduates VERIFY on this read
    // (unchanged 0.6/2.2/0.11). GLM-5-turbo / 5v-turbo are not on the page and stay out.
    "glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheCreation: 1.4, note: "docs.z.ai/guides/overview/pricing 2026-11-01; cached storage 'Limited-time Free' -> cacheCreation = input" },
    "glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03, cacheCreation: 0.15, note: "docs.z.ai/guides/overview/pricing 2026-11-01; cached storage 'Limited-time Free' -> cacheCreation = input" },
    "glm-5.3-flashx": { input: 0.37, output: 1.25, cacheRead: 0.075, cacheCreation: 0.37, note: "docs.z.ai/guides/overview/pricing 2026-11-01; cached storage 'Limited-time Free' -> cacheCreation = input" },
    "glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheCreation: 1.4, note: "docs.z.ai/guides/overview/pricing 2026-11-01; cached storage 'Limited-time Free' -> cacheCreation = input" },
    "glm-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheCreation: 1.4, note: "docs.z.ai/guides/overview/pricing 2026-11-01; cached storage 'Limited-time Free' -> cacheCreation = input" },
    "glm-5": { input: 1.0, output: 3.2, cacheRead: 0.2, cacheCreation: 1.0, note: "docs.z.ai/guides/overview/pricing 2026-11-01; cached storage 'Limited-time Free' -> cacheCreation = input" },
    "glm-4.7": { input: 0.6, output: 2.2, cacheRead: 0.11, cacheCreation: 0.6, note: "docs.z.ai/guides/overview/pricing 2026-11-01; cached storage 'Limited-time Free' -> cacheCreation = input" },
    "glm-4.7-flashx": { input: 0.07, output: 0.4, cacheRead: 0.01, cacheCreation: 0.07, note: "docs.z.ai/guides/overview/pricing 2026-11-01; cached storage 'Limited-time Free' -> cacheCreation = input" },
    "glm-4.6": { input: 0.6, output: 2.2, cacheRead: 0.11, cacheCreation: 0.6, note: "docs.z.ai/guides/overview/pricing 2026-11-01 (graduated VERIFY, rates unchanged); cached storage 'Limited-time Free' -> cacheCreation = input" },
    // gpt-5 generation (developers.openai.com/api/docs/pricing, read 2026-11-01): the text-token
    // table verbatim. gpt-5 graduates VERIFY on this read (unchanged 1.25/10/0.125). No
    // cache-write price is shown for any of these -> cacheCreation = input. The -pro rows show
    // a dash for cached input (no caching): cacheRead = input, so a cache-read token can never
    // bill below input there. gpt-5.3-codex is the Codex-specialized row (same figures as
    // gpt-5.2); gpt-5.3-codex-spark, gpt-5.2-codex, gpt-5.1-codex(-mini), gpt-5-codex are NOT
    // on the page and stay unpriced rather than borrowed.
    "gpt-5": { input: 1.25, output: 10.0, cacheRead: 0.125, cacheCreation: 1.25, note: "developers.openai.com/api/docs/pricing 2026-11-01 (graduated VERIFY, rates unchanged); no separate cache-write charge, cacheCreation = input" },
    "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005, cacheCreation: 0.05, note: "developers.openai.com/api/docs/pricing 2026-11-01; no separate cache-write charge, cacheCreation = input" },
    "gpt-5-pro": { input: 15.0, output: 120.0, cacheRead: 15.0, cacheCreation: 15.0, note: "developers.openai.com/api/docs/pricing 2026-11-01; cached input shown as a dash (no caching) -> cacheRead = cacheCreation = input" },
    "gpt-5.1": { input: 1.25, output: 10.0, cacheRead: 0.125, cacheCreation: 1.25, note: "developers.openai.com/api/docs/pricing 2026-11-01; no separate cache-write charge, cacheCreation = input" },
    "gpt-5.2": { input: 1.75, output: 14.0, cacheRead: 0.175, cacheCreation: 1.75, note: "developers.openai.com/api/docs/pricing 2026-11-01; no separate cache-write charge, cacheCreation = input" },
    "gpt-5.3-codex": { input: 1.75, output: 14.0, cacheRead: 0.175, cacheCreation: 1.75, note: "developers.openai.com/api/docs/pricing 2026-11-01 (Specialized models: Codex); no separate cache-write charge, cacheCreation = input" },
    "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheCreation: 0.2, note: "developers.openai.com/api/docs/pricing 2026-11-01; no separate cache-write charge, cacheCreation = input" },
    "gpt-5.4-pro": { input: 30.0, output: 180.0, cacheRead: 30.0, cacheCreation: 30.0, note: "developers.openai.com/api/docs/pricing 2026-11-01 (<272K tier); cached input shown as a dash (no caching) -> cacheRead = cacheCreation = input; long-context (>=272K) tier 60/270 NOT modeled" },
    "gpt-5.5-pro": { input: 30.0, output: 180.0, cacheRead: 30.0, cacheCreation: 30.0, note: "developers.openai.com/api/docs/pricing 2026-11-01 (<272K tier); cached input shown as a dash (no caching) -> cacheRead = cacheCreation = input; long-context (>=272K) tier 60/270 NOT modeled" },
    // gpt-5.5 / gpt-5-mini (developers.openai.com/api/docs/pricing 2026-09-29; models.dev agrees): seen in local Codex corpora (12 records
    // of gpt-5.5; 32K tokens of gpt-5-mini) and unpriced until now. Vendor page shows a dash
    // for cache writes on both (no separate charge) -> cacheCreation = input. gpt-5.5's
    // long-context tier 10/1/45 NOT modeled; gpt-5.5-pro (30/180, no caching) not added --
    // never observed in any corpus.
    "gpt-5.5": { input: 5.0, output: 30.0, cacheRead: 0.5, cacheCreation: 5.0, note: "developers.openai.com/api/docs/pricing 2026-09-29; no separate cache-write charge, cacheCreation = input; long-context (>=272K) tier 10/1/45 NOT modeled" },
    // gpt-5.5-cyber (developers.openai.com/api/docs/pricing 2026-09-30, Cyber models table): 12.5/75, cached 1.25, cache writes shown
    // as a dash (no separate charge -> cacheCreation = input), no long-context tier.
    // NOT on models.dev, so the unpriced-id alarm structurally cannot see it -- found
    // only by the vendor-page visit; recorded on public issue #7 as the residual gap.
    "gpt-5.5-cyber": { input: 12.5, output: 75.0, cacheRead: 1.25, cacheCreation: 12.5, note: "developers.openai.com/api/docs/pricing 2026-09-30; no separate cache-write charge, cacheCreation = input; no long-context tier; absent from models.dev and LiteLLM at add time" },
    "gpt-5-mini": { input: 0.25, output: 2.0, cacheRead: 0.025, cacheCreation: 0.25, note: "developers.openai.com/api/docs/pricing 2026-09-29; no separate cache-write charge, cacheCreation = input" },
    "gpt-5.4": { input: 2.5, output: 15.0, cacheRead: 0.25, cacheCreation: 2.5, note: "developers.openai.com/api/docs/pricing 2026-08-15 (<272K context tier); no separate cache-write charge, cacheCreation = input" },
    "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheCreation: 0.75, note: "developers.openai.com/api/docs/pricing 2026-08-15; no separate cache-write charge, cacheCreation = input" },

    // OpenAI gpt-5.6 family: developers.openai.com/api/docs/pricing, first verified
    // 2026-08-15; sol repriced downward 2026-08-29 (per-row notes carry the ledger).
    // Rates are the SHORT-context tier (<272K prompt); long-context tiers are NOT
    // modeled — same policy as grok-4.6. Cache writes bill as ordinary input
    // (cacheCreation = input) EXCEPT cyber, which has a real cache-write charge.
    // Bare "gpt-5.6" is models.dev's alias at sol's rates, kept so a harness that
    // logs the bare id prices identically to sol.
    "gpt-5.6": { input: 4.0, output: 20.0, cacheRead: 0.4, cacheCreation: 5.0, note: "cache writes 5.00 (1.25x) like sol -- the cache-write drift compare caught this alias lagging sol on its first live run, 2026-09-29; developers.openai.com/api/docs/pricing 2026-08-29; alias of gpt-5.6-sol per models.dev; repriced 5/30/0.5 -> 4/20/0.4 (LiteLLM first 2026-08-23, models.dev 2026-08-25, vendor-verified 2026-08-29); promotional floor: vendor says available at least through 2026-11-21 — a later reversion is a reprice to observe, never pre-entered; long-context (>=272K) tier 8/0.8/30 NOT modeled" },
    "gpt-5.6-sol": { input: 4.0, output: 20.0, cacheRead: 0.4, cacheCreation: 5.0, note: "developers.openai.com/api/docs/pricing 2026-09-29: cache writes now billed separately at 5.00 (1.25x input; was cacheCreation=input) — a drift the checker cannot see, it never compares cache-write rates; developers.openai.com/api/docs/pricing 2026-08-29; repriced 5/30/0.5 -> 4/20/0.4 (LiteLLM first 2026-08-23, models.dev 2026-08-25, vendor-verified 2026-08-29); promotional floor: vendor says available at least through 2026-11-21 — a later reversion is a reprice to observe, never pre-entered; long-context (>=272K) tier 8/0.8/30 NOT modeled" },
    "gpt-5.6-terra": { input: 2.0, output: 12.0, cacheRead: 0.2, cacheCreation: 2.5, note: "developers.openai.com/api/docs/pricing 2026-09-29: cache writes billed separately at 2.50 (1.25x input; was cacheCreation=input); developers.openai.com/api/docs/pricing 2026-08-15; long-context (>=272K) tier 4/0.4/18 NOT modeled" },
    "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheCreation: 0.25, note: "developers.openai.com/api/docs/pricing 2026-09-29: cache writes billed separately at 0.25 (1.25x input; was cacheCreation=input); developers.openai.com/api/docs/pricing 2026-08-15; long-context (>=272K) tier 0.4/0.04/1.8 NOT modeled" },
    "gpt-5.6-cyber": { input: 12.5, output: 75.0, cacheRead: 1.25, cacheCreation: 15.625, note: "developers.openai.com/api/docs/pricing 2026-08-29; cache writes billed separately at 15.625 (1.25x input) — the one gpt-5.6 variant with a real cache-write charge" },

    // OpenAI gpt-6 family — gpt-6-astra is Codex's frontier model (Marco 2026-09-10) and
    // was ALREADY the dominant id in local Codex corpora (1,753 message records in 21
    // days) with zero rows here: every one of those tokens read as unpriced. Same lesson
    // as claude-fable-5-1 — a new generation needs explicit rows BEFORE its id appears.
    // Vendor page verified 2026-09-10; models.dev and LiteLLM (native openai row) agree
    // exactly. Unlike sol/terra/luna, Astra has a REAL cache-write charge (12.5 = 1.25x
    // input, same shape as cyber). Batch/Flex (50%) and Fast mode (2x) tiers are billing
    // modes, not models — NOT modeled, same policy as Anthropic batch/fast.
    // gpt-6-sol / gpt-6-luna (developers.openai.com/api/docs/pricing 2026-09-29; models.dev + LiteLLM agree exactly): the family filled
    // out below astra. Cache writes 1.25x on both. Long-context tiers (sol 4/0.4/5/15,
    // luna 0.2/0.02/0.25/0.75) NOT modeled, same policy as astra.
    "gpt-6-sol": { input: 2.0, output: 10.0, cacheRead: 0.2, cacheCreation: 2.5, note: "developers.openai.com/api/docs/pricing 2026-09-29; cache writes 2.50 (1.25x input); long-context tier NOT modeled" },
    "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheCreation: 0.125, note: "developers.openai.com/api/docs/pricing 2026-09-29; cache writes 0.125 (1.25x input); long-context tier NOT modeled" },
    // gpt-6.1-sol (developers.openai.com/api/docs/pricing 2026-09-29; released 2026-09-29 -- caught the same day by the unpriced-id alarm
    // on its first live run; models.dev agrees exactly). Cache read is 0.05x here (0.10),
    // not the family's 0.1x. Long-context tier 4/0.2/5/15 NOT modeled.
    "gpt-6.1-sol": { input: 2.0, output: 10.0, cacheRead: 0.1, cacheCreation: 2.5, note: "re-verified unchanged developers.openai.com/api/docs/pricing 2026-11-01; developers.openai.com/api/docs/pricing 2026-09-29; cache read 0.05x (0.10); cache writes 2.50 (1.25x input); long-context (>=272K) tier 4/0.2/5/15 NOT modeled" },
    // gpt-6.1-terra (released 2026-10-26; the unpriced-id alarm flagged it daily from
    // 2026-10-28, public issue #7): developers.openai.com/api/docs/pricing 2026-11-01 verbatim
    // $1.00 / $0.05 cached / $5.00, 30m cache write $1.25 (1.25x), 12h write $2.50 NOT modeled;
    // models.dev + LiteLLM agree on the rates. Cache read 0.05x like 6.1-sol.
    "gpt-6.1-terra": { input: 1.0, output: 5.0, cacheRead: 0.05, cacheCreation: 1.25, note: "developers.openai.com/api/docs/pricing 2026-11-01; cache read 0.05x (0.05); cache writes 1.25 (1.25x input, 30m TTL; 12h write 2.50 NOT modeled); long-context (>=272K) tier 2/0.1/2.5/7.5 NOT modeled" },
    "gpt-6-astra": { input: 10.0, output: 50.0, cacheRead: 1.0, cacheCreation: 12.5, note: "re-verified unchanged developers.openai.com/api/docs/pricing 2026-11-01 and 2026-09-29; developers.openai.com/api/docs/pricing 2026-09-10 (Codex's frontier model since 2026-09; models.dev + LiteLLM native agree); cache writes billed separately at 12.5 (1.25x input); long-context tier 20/2/25/75 NOT modeled; contextWindows 1,050,000 per models.dev (vendor page states no threshold; LiteLLM says 922,000 -- disagreement noted, models.dev used)" },
    // Vertical configurations of the gpt-6 family (developers.openai.com/api/docs/pricing
    // 2026-11-01, their own sections): gpt-6-astra-law (Legal model configurations, "promotional
    // pricing available at least through December 31, 2026", no cache-write price shown) and
    // gpt-6-rosalind (Life sciences models, trusted access only; 30m cache write $18.75 = 1.25x,
    // 12h $37.50 NOT modeled). gpt-rosalind-research / -discovery (5/25/0.5) are on the same
    // page but no catalog states a context window for them, so they stay out of this table
    // (a priced id without a window breaks the registry invariant) until one does.
    "gpt-6-astra-law": { input: 10.0, output: 50.0, cacheRead: 1.0, cacheCreation: 10.0, note: "developers.openai.com/api/docs/pricing 2026-11-01 (Legal model configurations); no cache-write price shown -> cacheCreation = input; promotional at least through 2026-12-31 -- a later change is a reprice to observe, never pre-entered" },
    "gpt-6-rosalind": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheCreation: 18.75, note: "developers.openai.com/api/docs/pricing 2026-11-01 (Life sciences models, trusted access only); cache writes 18.75 (1.25x input, 30m TTL; 12h write 37.50 NOT modeled); long-context tier 30/3/112.5 NOT modeled" },
    // Gemini (ai.google.dev/gemini-api/docs/pricing read 2026-09-29, re-read 2026-11-01; models.dev agrees on every
    // row it lists). Gemini CLI is a supported harness, so these ids reach real corpora. Google bills
    // context caching by storage time (per 1M tokens per hour), not per written token ->
    // cacheCreation = input. 3.6/3.8-flash and the flash-latest alias carry a PUBLISHED increase
    // on 2027-01-01 (0.75/3.75 -> 1.50/7.50): held as a dated interval on the server timeline,
    // never pre-applied in this table.
    // 2026-11-01 re-read: gemini-3.7-flash and gemini-3.5-flash are NO LONGER on the page (rows
    // kept at their last verified rate, noted per row); the flash-latest / flash-lite-latest
    // aliases are still not mentioned there (models.dev-sourced, as before); gemini-4-argon,
    // 3.1-pro-preview, 3.1-flash-lite, 3-flash-preview and the 2.5 family were added from that
    // read, and gemini-3-flash's VERIFY label retired against the -preview row. The >200k tier on
    // the Pro rows and the audio-input rates on the Flash rows are NOT modeled -- same policy as
    // every other long-context tier in this table.
    "gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheCreation: 0.75, note: "ai.google.dev/gemini-api/docs/pricing 2026-09-29, re-verified unchanged 2026-11-01; context caching is billed per token-hour of STORAGE, not per write token -> cacheCreation = input (no per-token write charge); PROMOTIONAL: vendor lists 0.75/3.75/0.075 through 2026-12-31 and 1.50/7.50/0.15 from 2027-01-01 -- the increase is entered as a dated interval in the server timeline (ANNOUNCED_REPRICES), never pre-applied here; re-verify before 2027-01-01" },
    "gemini-3.7-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheCreation: 0.75, note: "NOT on the vendor pricing page as of 2026-11-01 (3.6 and 3.8 remain; 3.7 and 3.5 were dropped from the page between 2026-09-29 and 2026-11-01) -- rate stands as last verified ai.google.dev/gemini-api/docs/pricing 2026-09-29, models.dev + LiteLLM still list it; context caching is billed per token-hour of STORAGE, not per write token -> cacheCreation = input (no per-token write charge); PROMOTIONAL: vendor listed 0.75/3.75/0.075 through 2026-12-31 and 1.50/7.50/0.15 from 2027-01-01 -- the increase is entered as a dated interval in the server timeline (ANNOUNCED_REPRICES), never pre-applied here; re-verify before 2027-01-01" },
    "gemini-3.6-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheCreation: 0.75, note: "ai.google.dev/gemini-api/docs/pricing 2026-09-29, re-verified unchanged 2026-11-01; context caching is billed per token-hour of STORAGE, not per write token -> cacheCreation = input (no per-token write charge); PROMOTIONAL: vendor lists 0.75/3.75/0.075 through 2026-12-31 and 1.50/7.50/0.15 from 2027-01-01 -- the increase is entered as a dated interval in the server timeline (ANNOUNCED_REPRICES), never pre-applied here; re-verify before 2027-01-01" },
    "gemini-flash-latest": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheCreation: 0.75, note: "alias of the current 3.x flash (models.dev 2026-09-29; vendor page lists no standalone row, re-checked 2026-11-01: still not mentioned); context caching is billed per token-hour of STORAGE, not per write token -> cacheCreation = input (no per-token write charge); PROMOTIONAL: vendor lists 0.75/3.75/0.075 through 2026-12-31 and 1.50/7.50/0.15 from 2027-01-01 -- the increase is entered as a dated interval in the server timeline (ANNOUNCED_REPRICES), never pre-applied here; re-verify before 2027-01-01" },
    "gemini-3.5-flash": { input: 1.5, output: 9.0, cacheRead: 0.15, cacheCreation: 1.5, note: "NOT on the vendor pricing page as of 2026-11-01 (dropped between 2026-09-29 and 2026-11-01, as was 3.7-flash) -- rate stands as last verified ai.google.dev/gemini-api/docs/pricing 2026-09-29; models.dev still lists 1.5/9/0.15; context caching is billed per token-hour of STORAGE, not per write token -> cacheCreation = input (no per-token write charge)" },
    "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheCreation: 0.3, note: "ai.google.dev/gemini-api/docs/pricing 2026-09-29, re-verified unchanged 2026-11-01 (0.30/2.50/0.03); context caching is billed per token-hour of STORAGE, not per write token -> cacheCreation = input (no per-token write charge)" },
    "gemini-flash-lite-latest": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheCreation: 0.3, note: "alias of 3.5-flash-lite (models.dev 2026-09-29; vendor page lists no standalone row, re-checked 2026-11-01: still not mentioned); context caching is billed per token-hour of STORAGE, not per write token -> cacheCreation = input (no per-token write charge)" },
    "gemini-4-argon": { input: 2.0, output: 10.0, cacheRead: 0.1, cacheCreation: 2.0, note: "ai.google.dev/gemini-api/docs/pricing 2026-11-01 ('$2.00 through November 30, 2026; $4.00 starting December 1, 2026' input; 10.00 -> 20.00 output; 0.10 -> 0.20 caching); implicit caching only -> cacheCreation = input; PROMOTIONAL through 2026-11-30 -- the 2026-12-01 increase is entered as a dated interval in the server timeline (ANNOUNCED_REPRICES), never pre-applied here; re-verify before 2026-12-01; not on the Free tier; models.dev agrees (2/10/0.1)" },
    "gemini-3.1-pro-preview": { input: 2.0, output: 12.0, cacheRead: 0.2, cacheCreation: 2.0, note: "ai.google.dev/gemini-api/docs/pricing 2026-11-01 (<=200k-token tier 2.00/12.00/0.20); >200k tier 4.00/18.00/0.40 NOT modeled; cache storage (4.50 per 1M token-hour) not modeled -> cacheCreation = input; the vendor's own id carries -preview (D1: exact key, never borrows the gemini-3-pro row)" },
    "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cacheRead: 0.025, cacheCreation: 0.25, note: "ai.google.dev/gemini-api/docs/pricing 2026-11-01 (text/image/video 0.25/1.50/0.025; audio input 0.50 / caching 0.05 NOT modeled); cache storage billed per token-hour -> cacheCreation = input" },
    "gemini-3-flash-preview": { input: 0.5, output: 3.0, cacheRead: 0.05, cacheCreation: 0.5, note: "ai.google.dev/gemini-api/docs/pricing 2026-11-01 (text/image/video 0.50/3.00/0.05; audio input 1.00 / caching 0.10 NOT modeled); cache storage billed per token-hour -> cacheCreation = input; the vendor's own id (D1: exact key wins over the bare gemini-3-flash row)" },
    "gemini-2.5-pro": { input: 1.25, output: 10.0, cacheRead: 0.125, cacheCreation: 1.25, note: "ai.google.dev/gemini-api/docs/pricing 2026-11-01 (<=200k-token tier 1.25/10.00/0.125); >200k tier 2.50/15.00/0.25 NOT modeled; cache storage billed per token-hour -> cacheCreation = input" },
    "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheCreation: 0.3, note: "ai.google.dev/gemini-api/docs/pricing 2026-11-01 (text/image/video 0.30/2.50/0.03; audio input 1.00 / caching 0.10 NOT modeled); cache storage billed per token-hour -> cacheCreation = input" },
    "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.01, cacheCreation: 0.1, note: "ai.google.dev/gemini-api/docs/pricing 2026-11-01 (text/image/video 0.10/0.40/0.01; audio input 0.30 / caching 0.03 NOT modeled); cache storage billed per token-hour -> cacheCreation = input" },
    "gemini-3-flash": { input: 0.5, output: 3.0, cacheRead: 0.05, cacheCreation: 0.5, note: "ai.google.dev/gemini-api/docs/pricing 2026-11-01 lists this family only as gemini-3-flash-preview, at 0.50/3.00/0.05 -- identical to this row, so the VERIFY label is retired; the bare id is kept for sessions that report it without the -preview suffix" },
    // gemini-3-pro stays VERIFY: the 2026-11-01 page has no standalone text entry for it. The
    // only pointer is Gemini 3 Pro Image's note that its text tokens are "priced the same as
    // Gemini 3.1 Pro" (2.00/12.00/0.20 -- the figures this row already carries). A VERIFY label
    // graduates only on a row of its own; an inference from an image model's footnote is not one.
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
    // grok-4.7 (docs.x.ai 2026-09-29): same row as 4.6 — 2/6, cached 0.5, 500k context; long-context
    // (>=200K) tier 4/1/12 NOT modeled. models.dev agrees; LiteLLM has no row yet.
    // Explicit so the id never falls through the suffix rule.
    // 2026-11-01 re-read of docs.x.ai/developers/models: every grok-4.x row below is
    // unchanged. The grok-4.20-0309 trio (reasoning / non-reasoning / multi-agent) is on
    // the same page at 1.25/0.20/2.50 under 200K prompt tokens with a 1M context;
    // long-context (>=200K) tier 2.50/0.40/5.00 NOT modeled. models.dev xai agrees on all
    // three. grok-code-fast is no longer listed on the models page; its source row
    // grok-build-0.1 still is, at the same rates, so the alias row stands (noted).
    "grok-4.7": { input: 2.0, output: 6.0, cacheRead: 0.5, cacheCreation: 2.0, note: "docs.x.ai 2026-09-29, re-verified unchanged 2026-11-01; long-context (>=200K prompt) tier 4/1/12 NOT modeled; models.dev agrees, LiteLLM absent at add time" },
    "grok-4.6": { input: 2.0, output: 6.0, cacheRead: 0.5, cacheCreation: 2.0, note: "docs.x.ai 2026-08-12, re-verified unchanged 2026-08-29, 2026-09-29 and 2026-11-01 (2/6/0.5; models.dev agrees); long-context (>=200K prompt) tier 4/1/12 NOT modeled" },
    "grok-4.5": { input: 2.0, output: 6.0, cacheRead: 0.3, cacheCreation: 2.0, note: "docs.x.ai 2026-08-14 (cacheRead corrected 0.5->0.3 - the drift watch's first catch), re-verified unchanged 2026-11-01; long-context (>=200K) tier 4/0.6/12 NOT modeled" },
    "grok-4.3": { input: 1.25, output: 2.5, cacheRead: 0.2, cacheCreation: 1.25, note: "docs.x.ai 2026-07-10, re-verified unchanged 2026-11-01; long-context (>=200K) tier 2.5/0.4/5 NOT modeled" },
    "grok-4.20-0309-reasoning": { input: 1.25, output: 2.5, cacheRead: 0.2, cacheCreation: 1.25, note: "docs.x.ai 2026-11-01 (1.25/0.20/2.50 under 200K prompt tokens, 1M context); no cache-write charge -> cacheCreation = input; long-context (>=200K) tier 2.5/0.4/5 NOT modeled; models.dev agrees" },
    "grok-4.20-0309-non-reasoning": { input: 1.25, output: 2.5, cacheRead: 0.2, cacheCreation: 1.25, note: "docs.x.ai 2026-11-01 (1.25/0.20/2.50 under 200K prompt tokens, 1M context); no cache-write charge -> cacheCreation = input; long-context (>=200K) tier 2.5/0.4/5 NOT modeled; models.dev agrees" },
    "grok-4.20-multi-agent-0309": { input: 1.25, output: 2.5, cacheRead: 0.2, cacheCreation: 1.25, note: "docs.x.ai 2026-11-01 (1.25/0.20/2.50 under 200K prompt tokens, 1M context); no cache-write charge -> cacheCreation = input; long-context (>=200K) tier 2.5/0.4/5 NOT modeled; models.dev agrees" },
    "grok-build-0.1": { input: 1.0, output: 2.0, cacheRead: 0.2, cacheCreation: 1.0, note: "docs.x.ai 2026-07-10, re-verified unchanged 2026-11-01 (256k context); long-context (>=200K) tier 2/0.4/4 NOT modeled" },
    "grok-code-fast": { input: 1.0, output: 2.0, cacheRead: 0.2, cacheCreation: 1.0, note: "xAI alias of grok-build-0.1 (docs.x.ai 2026-07-10); NOT on the docs.x.ai models page as of 2026-11-01 -- grok-build-0.1 still is, at the same rates, so the alias row stands" },
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
