/**
 * usage-core/contextWindows — THE canonical model-id -> input-context-window registry.
 *
 * CANONICAL SOURCE (P1, docs/product-audit-2026-07.md §5). Open (MIT), synced into
 * each consumer package's src/core/ by `node usage-core/sync.mjs`; the
 * coreParity tests fail on any drift. Edit HERE, sync, commit. Never edit a copy.
 *
 * `usage --cost` prices a model but has no notion of how much of that model's window
 * is actually in play; this module is that map, resolved with the SAME semantics
 * priceForModel uses (normalizeModelId, then longest-prefix match over families).
 *
 * PRECEDENCE, stated once: a vendor-STATED window for a session (e.g. Codex's own
 * reported model_context_window) ALWAYS beats this registry. This table is the
 * FALLBACK for when no such live number is available -- never the override. A caller
 * that already knows the real window from the vendor must use that, not this map.
 * (tracker's windowForSession implements that precedence, plus its inference tier —
 * consumer-side policy, deliberately NOT in this module.)
 *
 * VERIFY discipline: every value below is either (a) copied from a model's
 * max_input_tokens entry in the LiteLLM catalog (BerriAI/litellm, the same feed
 * source the closed service fetches at runtime and the PRICING table
 * already trusts for dollar rates), fetched 2026-07-17, or (b) typed from the
 * family's known/published window because the catalog has no exact entry for that id,
 * or because the catalog's entry conflicts with this module's own design (see THE
 * [1m] RULE note below) -- marked "VERIFY-family" per entry. Neither kind is confirmed
 * against the vendor's own pricing/docs page. Correctness against the vendor is NOT
 * claimed.
 *
 * THE [1m] RULE: Anthropic's 1M-context beta is a distinct, opt-in capability, not a
 * bigger family default -- it must be keyed off the literal "[1m]" routing suffix a
 * session id can carry, never baked into a family's base entry (see
 * contextWindowForModel step 2). The LiteLLM catalog itself bakes a flat
 * max_input_tokens: 1_000_000 into several native Claude family keys as of the
 * 2026-07-17 fetch (claude-opus-4-8, claude-opus-4-7, claude-opus-4-6,
 * claude-sonnet-4-6, claude-sonnet-5) -- this registry deliberately does NOT copy that
 * figure for those families' base entries. Every native Claude family below is kept at
 * its documented 200,000-token base window instead, and 1,000,000 is reserved
 * exclusively for ids carrying "[1m]". This is a considered divergence from the raw
 * catalog number (flagged per-entry below), not an oversight: tracker's
 * contextWindows.test.ts pins claude-opus-4-8's base window at 200_000 and its own
 * comments describe "the opus family's default window" as 200_000 generally, matching
 * Anthropic's documented base/non-beta context size.
 */
import { normalizeModelId } from "./pricing.js";

export const CONTEXT_WINDOWS: Record<string, number> = {
  // --- Native Anthropic families: base (non-"[1m]") window, kept at 200,000 across
  // the whole family -- see THE [1m] RULE above for why several of these disagree
  // with the LiteLLM catalog's raw max_input_tokens figure. ---

  // VERIFY-family: catalog lists max_input_tokens 1,000,000 for the plain
  // "claude-fable-5" key (2026-07-17 fetch); kept at the documented 200,000 base --
  // see THE [1m] RULE above.
  "claude-fable-5": 200_000,
  // VERIFY-family: absent from the LiteLLM catalog entirely (2026-07-17 fetch) -- no
  // vendor entry exists to check against. Typed from the family's known base window.
  "claude-mythos-5": 200_000,
  // VERIFY-family: catalog lists max_input_tokens 1,000,000 for the plain
  // "claude-opus-4-8" key (2026-07-17 fetch); kept at 200,000 -- the value
  // tracker's contextWindows.test.ts pins directly. See THE [1m] RULE above.
  "claude-opus-4-8": 200_000,
  // VERIFY-family: catalog lists 1,000,000 for this key (2026-07-17 fetch); kept at
  // 200,000 for the same reason as claude-opus-4-8 above.
  "claude-opus-4-7": 200_000,
  // VERIFY-family: catalog lists 1,000,000 for this key (2026-07-17 fetch); kept at
  // 200,000 for the same reason as claude-opus-4-8 above.
  "claude-opus-4-6": 200_000,
  // Catalog-sourced: max_input_tokens 200,000 (2026-07-17 fetch) -- agrees with the
  // family base already, no divergence to flag.
  "claude-opus-4-5": 200_000,
  // VERIFY-family: catalog lists 1,000,000 for this key (2026-07-17 fetch); kept at
  // 200,000 for the same reason as claude-opus-4-8 above.
  "claude-sonnet-5": 200_000,
  // VERIFY-family: catalog lists 1,000,000 for this key (2026-07-17 fetch); kept at
  // 200,000 for the same reason as claude-opus-4-8 above.
  "claude-sonnet-4-6": 200_000,
  // Catalog-sourced: max_input_tokens 200,000 (2026-07-17 fetch) -- agrees with the
  // family base already, no divergence to flag.
  "claude-sonnet-4-5": 200_000,
  // Catalog-sourced: max_input_tokens 200,000 (2026-07-17 fetch) -- agrees with the
  // family base already, no divergence to flag.
  "claude-haiku-4-5": 200_000,

  // --- Non-Anthropic families: no "[1m]"-style suffix mechanism for these vendors,
  // so the catalog value (or best available family match) is used directly. ---

  // VERIFY-family: no exact "kimi-k2" key in the catalog (2026-07-17 fetch); the
  // current "-0905" / "-thinking" / "-k2.5" suffix variants agree at 262,144, used
  // as the family value.
  "kimi-k2": 262_144,
  // VERIFY-family: no exact "glm-4.6" key in the catalog (2026-07-17 fetch); the
  // "zai/glm-4.6" and "vercel_ai_gateway/zai/glm-4.6" entries agree at 200,000.
  "glm-4.6": 200_000,
  // Catalog-sourced: max_input_tokens 272,000 (2026-07-17 fetch).
  "gpt-5": 272_000,
  // Catalog-sourced: max_input_tokens 1,050,000 (2026-07-17 fetch).
  "gpt-5.4": 1_050_000,
  // Catalog-sourced: max_input_tokens 1,050,000 (2026-07-17 fetch).
  "gpt-5.4-mini": 1_050_000,
  // VERIFY-family: no exact "gemini-3-flash" key in the catalog (2026-07-17 fetch);
  // the "gemini-3-flash-preview" chat variant (1,048,576) is used as the family value.
  "gemini-3-flash": 1_048_576,
  // VERIFY-family: no exact "gemini-3-pro" key in the catalog (2026-07-17 fetch); the
  // "gemini-3-pro-preview" CHAT variant (1,048,576) is used -- NOT the separate
  // "-image" / "-image-preview" image-generation variants, which the catalog lists
  // at a much smaller 65,536.
  "gemini-3-pro": 1_048_576,

  // --- xAI Grok CLI families (priced since P1; a priced id must have a window --
  // tracker/test/contextWindows.test.ts enforces that invariant). ---

  // Vendor-sourced: docs.x.ai models page lists grok-4.6 context 500k (2026-08-12
  // fetch, same read that sourced its price row). Same one-window-tiered-pricing
  // shape as grok-4.5: >=200K prompts bill higher, which this registry does not model.
  "grok-4.6": 500_000,
  // Catalog-sourced: "xai/grok-4.5" max_input_tokens 500,000 (2026-08-07 fetch).
  // Consistent with the rate note's ">200K long-context tier": one 500K window with
  // tiered pricing above 200K, which this registry does not model.
  "grok-4.5": 500_000,
  // Catalog-sourced: "xai/grok-4.3" max_input_tokens 1,000,000 (2026-08-07 fetch).
  "grok-4.3": 1_000_000,
  // VERIFY-family: no "grok-build" key in the catalog (2026-08-07 fetch). xAI's own
  // registry aliases it as grok-code-fast-1 (docs.x.ai 2026-07-10, see the pricing
  // table's note), whose catalog window is 256,000 -- used as the family value.
  "grok-build-0.1": 256_000,
  // Catalog-sourced: "xai/grok-code-fast" max_input_tokens 256,000 (2026-08-07 fetch).
  "grok-code-fast": 256_000,
};

/** Longest CONTEXT_WINDOWS key `id` starts with, or null. Own copy of resolveBase's
 * "longest, not first-match" semantics (not the shared function in ./pricing, because
 * this one closes over CONTEXT_WINDOWS instead of the rate table). */
function resolveContextBase(id: string): string | null {
  if (CONTEXT_WINDOWS[id] !== undefined) return id;
  let best: string | null = null;
  for (const key of Object.keys(CONTEXT_WINDOWS)) {
    if (id.startsWith(key) && (best === null || key.length > best.length)) best = key;
  }
  return best;
}

/** The literal routing suffix Anthropic's 1M-context beta is keyed off. Checked
 * BEFORE normalization/resolution so a suffixed id can never fall through to its
 * base family's (smaller) default -- see THE [1m] RULE in the module header. */
const ONE_MILLION_SUFFIX = "[1m]";

/**
 * Resolve a model id to its input-context window in tokens, or null when unknown --
 * never a guess. Resolution order:
 *   1. non-string or empty id -> null.
 *   2. id contains the literal "[1m]" suffix -> 1,000,000 (beats every family
 *      default, including the id's own base family's window).
 *   3. normalizeModelId (from ./pricing, reused verbatim -- OpenRouter route
 *      prefixes and vendor/model segments).
 *   4. longest-prefix match against CONTEXT_WINDOWS (mirrors resolveBase).
 *   5. null.
 */
export function contextWindowForModel(modelId: string): number | null {
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  if (modelId.includes(ONE_MILLION_SUFFIX)) return 1_000_000;
  const base = resolveContextBase(normalizeModelId(modelId));
  return base ? CONTEXT_WINDOWS[base] : null;
}
