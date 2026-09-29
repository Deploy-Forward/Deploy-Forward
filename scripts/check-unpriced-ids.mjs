/**
 * check-unpriced-ids — the alarm the drift check structurally cannot raise.
 *
 * check-price-drift.mjs compares ids ALREADY in the canonical table against the
 * catalogs. A brand-new model generation therefore never trips it: it is not
 * drifting, it is simply absent, and every token it serves prices as $0 with a
 * quiet "+" on the total. Worse, the resolver's suffix fallback can silently
 * price the new id at a SIBLING's rates (claude-opus-5-5 at Opus 5's row, a 25%
 * overstatement shown as "priced"). This happened four times in two months —
 * claude-opus-5, claude-fable-5-1, gpt-6-astra, claude-opus-5-5 — each found by
 * a human, each after days of unpriced usage.
 *
 * What this does: reads models.dev's NATIVE vendor rows (never resellers), keeps
 * priced text-output models released within RECENT_DAYS, and flags any id that is
 * not an EXACT key in the canonical table. For each flag it also reports whether
 * the resolver would currently price it through a fallback row — that is the trap,
 * and it is called out by name. Exit 1 on any flag so the workflow files an issue.
 *
 * What this never does: edit the table. Aggregator rates are printed as a HINT
 * only; the vendor page decides, a human enters the row (rates/README.md).
 *
 * Run (public layout, from tracker/): node --import tsx ../scripts/check-unpriced-ids.mjs
 */
import { PRICING, priceForModel } from "../usage-core/src/pricing.ts";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const NATIVE_PROVIDERS = ["anthropic", "openai", "xai", "google"];
export const RECENT_DAYS = 120;

/** Non-text products the table never prices: image/video/audio/embedding/live. */
const NON_TEXT = /(embedding|imagine|image|video|audio|realtime|live|tts|transcribe|whisper|moderation|lyria|veo|dall)/i;

/** A dated pin of a known key (claude-haiku-4-5-20251001 of claude-haiku-4-5) is the
 * same product; the resolver treats it as such on purpose. Not a gap. */
function isDatedPinOfKnown(id, known) {
  const m = /^(.*)-(\d{8})$/.exec(id);
  return !!m && known.has(m[1]);
}

/**
 * findUnpricedIds(catalog, rates, today) — pure: the list of native-vendor,
 * priced, text-output, recently released ids absent from `rates` as exact keys.
 * Each entry says whether a fallback row would price it (the sibling-rate trap).
 */
export function findUnpricedIds(catalog, rates = PRICING.models, today = new Date()) {
  const known = new Set(Object.keys(rates));
  const cutoff = new Date(today.getTime() - RECENT_DAYS * 86_400_000);
  const flags = [];
  for (const provider of NATIVE_PROVIDERS) {
    const models = catalog?.[provider]?.models ?? {};
    for (const [id, m] of Object.entries(models)) {
      const cost = m?.cost;
      if (!cost || typeof cost.input !== "number") continue; // unpriced upstream: nothing to enter
      if (NON_TEXT.test(id)) continue;
      const outs = m?.modalities?.output ?? ["text"];
      if (!outs.includes("text")) continue;
      const rd = m?.release_date ? new Date(m.release_date) : null;
      if (!rd || Number.isNaN(rd.getTime()) || rd < cutoff) continue;
      if (known.has(id) || isDatedPinOfKnown(id, known)) continue;
      const fallback = priceForModel(id, rates);
      flags.push({
        provider,
        id,
        releaseDate: m.release_date,
        hint: { input: cost.input, output: cost.output ?? null, cacheRead: cost.cache_read ?? null, cacheWrite: cost.cache_write ?? null },
        // The trap: a fallback row means this id is ALREADY being priced — at someone else's rates.
        pricedViaFallback: fallback ? { input: fallback.input, output: fallback.output, cacheRead: fallback.cacheRead } : null,
      });
    }
  }
  return flags.sort((a, b) => (a.releaseDate < b.releaseDate ? 1 : -1));
}

export function formatFlags(flags) {
  const lines = [];
  for (const f of flags) {
    const h = f.hint;
    const trap = f.pricedViaFallback
      ? `  <- CURRENTLY PRICED VIA FALLBACK at ${f.pricedViaFallback.input}/${f.pricedViaFallback.output} (cache read ${f.pricedViaFallback.cacheRead}) — a sibling's rates shown as "priced"`
      : "  (unpriced: every token reads as $0)";
    lines.push(`  ${f.provider}/${f.id} released ${f.releaseDate} — aggregator hint ${h.input}/${h.output} cr=${h.cacheRead} cw=${h.cacheWrite}${trap}`);
  }
  return lines.join("\n");
}

async function main() {
  const res = await fetch(MODELS_DEV_URL, { headers: { "user-agent": "deploy-forward-unpriced-check" } });
  if (!res.ok) {
    console.error(`models.dev fetch failed: HTTP ${res.status} — cannot check today, failing loud`);
    process.exit(2);
  }
  const flags = findUnpricedIds(await res.json());
  if (flags.length === 0) {
    console.log(`OK: every native-vendor text model released in the last ${RECENT_DAYS} days has an exact canonical row.`);
    return;
  }
  console.error(`UNPRICED NEW MODELS — verify at the VENDOR page, then add explicit rows to usage-core/src (never auto-edit):`);
  console.error(formatFlags(flags));
  process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith("check-unpriced-ids.mjs")) {
  await main();
}
