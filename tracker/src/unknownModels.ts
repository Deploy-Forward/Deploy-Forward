/**
 * L17 consented unknown-model share (CLIENT side).
 *
 * When — and ONLY when — the local `share-unknown-models` consent is ON, a sync MAY attach a
 * minimal list of { id, tool, count } for models the bundled PRICES table can't price, so the
 * project can learn what to price next. It carries NO rates and NO spend — only occurrence
 * tallies of model ids. Ids are charset/length gated here and a bad id is DROPPED WHOLE (never
 * mangled onto the wire); the list is sorted by occurrence desc and capped. Default consent is
 * OFF, so by default this shares NOTHING.
 */
import { priceForModel } from "./usageView.js";

export interface UnknownModelShare {
  /** The raw (unpriced) model id, already charset/length gated. */
  id: string;
  /** The tool the id was first seen under. */
  tool: string;
  /** Number of sessions the id appeared in. */
  count: number;
}

/** Cap on distinct ids in one share — the most-frequent survive, the overflow is dropped. */
export const MAX_UNKNOWN_MODELS_SHARE = 20;

/** Same legal id shape as a user rate: word chars plus dot/dash/slash/colon/at, 1..128 chars,
 * no whitespace. An id that fails this is dropped from the share, never cleaned onto the wire. */
const SHARE_ID_RE = /^[\w.\-/:@]{1,128}$/;

/** The only fields the builder reads off a session summary. */
interface SummaryLike {
  tool: string;
  models: { id?: unknown }[];
}

/**
 * Build the consented unknown-model share, or undefined when there is nothing to share.
 *
 * Returns undefined when consent is OFF (the default) OR when every model in the corpus is
 * canonically priced. Otherwise: one entry per unpriced id, counted by the number of sessions
 * it appeared in (deduped within a session), sorted most-frequent first, ids failing the
 * charset/length gate dropped, then capped at MAX_UNKNOWN_MODELS_SHARE.
 */
export function buildUnknownModelShare(
  summaries: SummaryLike[],
  opts: { consent: boolean },
): UnknownModelShare[] | undefined {
  if (!opts?.consent) return undefined;

  const byId = new Map<string, { tool: string; count: number }>();
  for (const s of summaries) {
    if (!s || !Array.isArray(s.models)) continue;
    const seen = new Set<string>(); // count each id at most once per session
    for (const m of s.models) {
      const id = m?.id;
      if (typeof id !== "string" || id.length === 0) continue;
      if (priceForModel(id) !== null) continue; // canonically priced -> not "unknown"
      if (seen.has(id)) continue;
      seen.add(id);
      const prev = byId.get(id);
      if (prev) prev.count += 1;
      else byId.set(id, { tool: s.tool, count: 1 });
    }
  }

  const list = [...byId.entries()]
    .filter(([id]) => SHARE_ID_RE.test(id)) // bad ids DROPPED whole, never mangled
    .map(([id, v]) => ({ id, tool: v.tool, count: v.count }))
    .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_UNKNOWN_MODELS_SHARE);

  return list.length > 0 ? list : undefined;
}
