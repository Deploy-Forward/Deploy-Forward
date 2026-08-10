/**
 * CONTEXT WINDOW REGISTRY -- the CLI surface over the canonical open module.
 *
 * The model-id -> window table and its resolution live in ./core/contextWindows.ts:
 * the synced copy of usage-core/src/contextWindows.ts (P1,
 * docs/product-audit-2026-07.md §5). test/coreParity.test.ts pins the bytes; edit
 * usage-core/src/contextWindows.ts and run `node usage-core/sync.mjs` -- never the
 * copy. The full VERIFY provenance and THE [1m] RULE rationale live in the canonical
 * module's header.
 *
 * What stays HERE is the CLI-only window-provenance model: `usage` renders a % of
 * window, so it must say HOW it knows the window (stated > registry > inferred) and
 * refuse to invent a denominator. That policy is a consumer concern, deliberately not
 * part of usage-core.
 */
import { normalizeModelId } from "./core/pricing.js";
import { contextWindowForModel } from "./core/contextWindows.js";

export { CONTEXT_WINDOWS, contextWindowForModel } from "./core/contextWindows.js";

/** How a rendered window figure was obtained -- every % on screen carries one of these.
 * "stated": the vendor reported it for the session (Codex model_context_window).
 * "registry": CONTEXT_WINDOWS resolved the id.
 * "inferred": observed occupancy exceeded the resolved window and a KNOWN elevated
 * tier covers it -- render marked (e.g. "~69%"), never dressed as stated. */
export type WindowProvenance = "stated" | "registry" | "inferred";

export interface ResolvedWindow {
  tokens: number;
  provenance: WindowProvenance;
}

/** The one elevated tier we can name: Anthropic's 1M-context beta. The field finding
 * that forced inference (2026-07-17, verified against the raw transcript): 1M-tier
 * Claude sessions carry BARE ids -- a 689,699-token prompt attributed to plain
 * "claude-opus-4-8", no [1m] suffix, main thread, 99.8% cacheRead of the session's
 * own prefix. Id resolution alone would render that as 344% of 200K. */
const CLAUDE_ELEVATED_TIER = 1_000_000;

/**
 * The window a session's occupancy should be judged against, with provenance --
 * or null when no window we can NAME covers the observed occupancy (render no %,
 * never a made-up denominator). Precedence: stated > registry > inferred.
 */
export function windowForSession(ctx: { occupancyTokens: number; model: string; windowTokens?: number }): ResolvedWindow | null {
  if (typeof ctx.windowTokens === "number" && ctx.windowTokens > 0) {
    return { tokens: ctx.windowTokens, provenance: "stated" };
  }
  const base = contextWindowForModel(ctx.model);
  if (base === null) return null;
  if (ctx.occupancyTokens <= base) return { tokens: base, provenance: "registry" };
  // Over the resolved window: only a tier we can NAME may be inferred. Anything past
  // every known tier returns null -- a session at 1.2M on a Claude id is a shape we
  // don't understand yet, and a wrong denominator is worse than none.
  if (normalizeModelId(ctx.model).startsWith("claude") && ctx.occupancyTokens <= CLAUDE_ELEVATED_TIER) {
    return { tokens: CLAUDE_ELEVATED_TIER, provenance: "inferred" };
  }
  return null;
}
