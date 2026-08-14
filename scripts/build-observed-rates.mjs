/**
 * build-observed-rates — the fully-automated, daily-updated rates artifact.
 *
 * Composes data/observed-rates.json from TWO independent public sources
 * (LiteLLM's catalog and models.dev) for every id the canonical table prices,
 * with per-source values, per-row agreement labels, and fetch timestamps.
 * The daily price-drift workflow rebuilds and commits it, so GitHub always
 * carries a fresh, multi-source view of the market (Marco 2026-08-14: "the
 * table should consistently update ... posted to GitHub").
 *
 * PROVENANCE RECONCILIATION (the invariant this deliberately does NOT break):
 * the canonical usage-core table ships inside the npm package and the server's
 * synced copies — it stays HAND-verified against vendor pages, because
 * aggregators disagree with vendors sometimes (grok-code-fast: LiteLLM said
 * $0.20/$1.50 while docs.x.ai said $1/$2). This artifact is the automated,
 * always-fresh layer ON TOP: every row is source-attributed and dated, and an
 * "agreement" label says exactly how much to trust it. Nothing here is ever
 * silently promoted into the canonical table.
 *
 * Run with tsx (the canonical table is TypeScript):
 *   cd tracker && node --import tsx ../scripts/build-observed-rates.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { PRICING } from "../usage-core/src/pricing.ts";
import { lookupCatalog } from "./check-price-drift.mjs";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MODELS_DEV_URL = "https://models.dev/api.json";

/** The model's NATIVE vendor on models.dev — resellers list the same ids at
 * marked-up rates (a 1.1x claude-opus-5 exists under a non-Anthropic provider),
 * so provider order must never decide which row we read. */
function nativeProviderFor(id) {
  if (id.startsWith("claude-")) return ["anthropic"];
  if (id.startsWith("gpt-")) return ["openai"];
  if (id.startsWith("grok-")) return ["xai"];
  if (id.startsWith("gemini-")) return ["google", "google-ai-studio", "gemini"];
  if (id.startsWith("kimi-")) return ["moonshotai", "moonshot"];
  if (id.startsWith("glm-")) return ["zai", "z-ai", "zhipuai"];
  return [];
}

/** models.dev: providers -> models[id].cost, already USD/MTok. Native vendor
 * first; anything else is deliberately ignored rather than silently marked up. */
function lookupModelsDev(catalog, id) {
  for (const key of nativeProviderFor(id)) {
    const m = catalog[key]?.models?.[id];
    if (m?.cost && typeof m.cost.input === "number") {
      return {
        provider: key,
        input: m.cost.input,
        output: m.cost.output ?? null,
        cacheRead: m.cost.cache_read ?? null,
        cacheCreation: m.cost.cache_write ?? null,
      };
    }
  }
  return null;
}

const near = (a, b) => a !== null && b !== null && Math.abs(a - b) < 1e-9;

/** One row's agreement label — the honesty core of the artifact. */
export function agreementFor(canonical, litellm, modelsDev) {
  const sources = [litellm, modelsDev].filter(Boolean);
  if (sources.length === 0) return "unobserved";
  const vsCanonical = sources.every(
    (s) =>
      (s.input === null || near(s.input, canonical.input)) &&
      (s.output === null || near(s.output, canonical.output)) &&
      (s.cacheRead == null || near(s.cacheRead, canonical.cacheRead)),
  );
  if (litellm && modelsDev) {
    const crossAgree =
      near(litellm.input, modelsDev.input) &&
      near(litellm.output, modelsDev.output) &&
      (litellm.cacheRead == null || modelsDev.cacheRead == null || near(litellm.cacheRead, modelsDev.cacheRead));
    if (!crossAgree) return "sources-disagree";
  }
  return vsCanonical ? "all-agree" : "drifts-from-canonical";
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const [litellmCat, modelsDevCat] = await Promise.all([fetchJson(LITELLM_URL), fetchJson(MODELS_DEV_URL)]);
  const now = new Date().toISOString();

  const models = {};
  for (const id of Object.keys(PRICING.models).sort()) {
    const canonical = PRICING.models[id];
    const ll = lookupCatalog(litellmCat, id);
    const litellm = ll
      ? {
          key: ll.key,
          input: typeof ll.entry.input_cost_per_token === "number" ? ll.entry.input_cost_per_token * 1e6 : null,
          output: typeof ll.entry.output_cost_per_token === "number" ? ll.entry.output_cost_per_token * 1e6 : null,
          cacheRead:
            typeof ll.entry.cache_read_input_token_cost === "number" ? ll.entry.cache_read_input_token_cost * 1e6 : null,
        }
      : null;
    const modelsDev = lookupModelsDev(modelsDevCat, id);
    models[id] = {
      canonical: {
        input: canonical.input,
        output: canonical.output,
        cacheRead: canonical.cacheRead,
        cacheCreation: canonical.cacheCreation,
        note: canonical.note ?? null,
      },
      litellm,
      modelsDev,
      agreement: agreementFor(canonical, litellm, modelsDev),
    };
  }

  const artifact = {
    generatedAt: now,
    note: "Automated multi-source observation. The canonical table remains hand-verified against vendor pages; per-row `agreement` states how the sources relate. Never treat an aggregator value as vendor truth.",
    canonicalTableVersion: PRICING.version,
    sources: {
      litellm: { url: LITELLM_URL, fetchedAt: now },
      modelsDev: { url: MODELS_DEV_URL, fetchedAt: now },
    },
    models,
  };
  mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../data/observed-rates.json", import.meta.url), JSON.stringify(artifact, null, 2) + "\n");
  const counts = {};
  for (const m of Object.values(models)) counts[m.agreement] = (counts[m.agreement] || 0) + 1;
  console.log(
    `observed-rates.json: ${Object.keys(models).length} ids — ` +
      Object.entries(counts)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", "),
  );
}

if (process.argv[1] && process.argv[1].endsWith("build-observed-rates.mjs")) {
  await main();
}
