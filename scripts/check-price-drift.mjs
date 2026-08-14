/**
 * check-price-drift — does the canonical bundled table still match the world?
 *
 * Fetches LiteLLM's public model-price catalog (the same aggregator the closed
 * service's daily feed reads) and diffs every id usage-core PRICES against it.
 * Runs daily via .github/workflows/price-drift.yml; any drift fails the run and
 * opens/updates a GitHub issue, so a stale rate is a loud red X within a day —
 * not a silent misprice discovered weeks later (the claude-opus-5 lesson,
 * 2026-08-14: 3.3B tokens sat unpriced because nothing was watching).
 *
 * IMPORTANT: this NEVER edits the table. LiteLLM is an aggregator and is
 * sometimes wrong (grok-code-fast has disagreed with docs.x.ai before), so a
 * drift report means "verify against the VENDOR's own page, then update
 * usage-core/src via the documented procedure" — provenance stays human.
 *
 * Ids absent from the catalog are reported as unverifiable-info, never a
 * failure (mythos-class models simply aren't listed anywhere).
 *
 * Run with tsx so the canonical TS table imports directly:
 *   cd tracker && node --import tsx ../scripts/check-price-drift.mjs
 */
import { PRICING } from "../usage-core/src/pricing.ts";

const CATALOG_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** litellm keys worth trying for one of our ids, most-specific first. */
function candidateKeys(id) {
  return [id, `anthropic/${id}`, `openai/${id}`, `xai/${id}`, `gemini/${id}`, `x-ai/${id}`];
}

/** Exact key, else the id's own dated variants (id + "-" + digits), never a looser guess. */
export function lookupCatalog(catalog, id) {
  for (const k of candidateKeys(id)) {
    if (catalog[k]) return { key: k, entry: catalog[k] };
  }
  const dated = Object.keys(catalog).filter((k) => {
    const base = k.replace(/^[a-z-]+\//, "");
    return base.startsWith(`${id}-`) && /^\d/.test(base.slice(id.length + 1));
  });
  if (dated.length > 0) {
    const k = dated.sort().at(-1); // newest dated variant
    return { key: k, entry: catalog[k] };
  }
  return null;
}

/** Compare one of our rows against a catalog entry. Only fields the catalog
 * actually carries are compared — an absent field can't drift. */
export function driftFor(id, ours, key, entry) {
  const perM = (v) => (typeof v === "number" ? v * 1_000_000 : null);
  const checks = [
    ["input", ours.input, perM(entry.input_cost_per_token)],
    ["output", ours.output, perM(entry.output_cost_per_token)],
    ["cacheRead", ours.cacheRead, perM(entry.cache_read_input_token_cost)],
  ];
  const drifts = [];
  for (const [field, mine, theirs] of checks) {
    if (theirs === null) continue;
    if (Math.abs(mine - theirs) > 1e-9) drifts.push({ id, key, field, ours: mine, catalog: theirs });
  }
  return drifts;
}

async function main() {
  const res = await fetch(CATALOG_URL);
  if (!res.ok) {
    console.error(`catalog fetch failed: HTTP ${res.status} — cannot verify today, failing loud`);
    process.exit(2);
  }
  const catalog = await res.json();

  const drifts = [];
  const unverifiable = [];
  for (const [id, ours] of Object.entries(PRICING.models)) {
    const hit = lookupCatalog(catalog, id);
    if (!hit) {
      unverifiable.push(id);
      continue;
    }
    drifts.push(...driftFor(id, ours, hit.key, hit.entry));
  }

  if (unverifiable.length > 0) {
    console.log(`info: not in the catalog (verify by hand at the vendor page): ${unverifiable.join(", ")}`);
  }
  if (drifts.length === 0) {
    console.log(`OK: every catalog-listed rate matches usage-core (${Object.keys(PRICING.models).length} ids checked).`);
    return;
  }
  console.error(`PRICE DRIFT — verify at the VENDOR page, then update usage-core/src (never auto-edit):`);
  for (const d of drifts) {
    console.error(`  ${d.id} (${d.key}) ${d.field}: ours $${d.ours}/MTok vs catalog $${d.catalog}/MTok`);
  }
  process.exit(1);
}

// Only run as a script — the exports above stay importable for tests.
if (process.argv[1] && process.argv[1].endsWith("check-price-drift.mjs")) {
  await main();
}
