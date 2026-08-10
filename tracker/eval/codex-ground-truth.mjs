#!/usr/bin/env node
/**
 * codex-ground-truth — metadata-only reconciliation of the REAL local corpus on this machine.
 *
 * Reuses the SHIPPED tracker parsers (src/jsonl.ts parseTranscript, src/codex.ts
 * parseCodexRollout) plus the shipped walkers (src/sync.ts findTranscripts /
 * findCodexTranscripts / claudeProjectRoots) to compute, over ALL of:
 *   - ~/.claude/projects  (Claude Code)  + XDG/APPDATA roots if present
 *   - ~/.codex/sessions   (Codex rollouts)
 * the TRUE per-model + per-harness token totals, weighted shares, session counts,
 * active time, and the subagent-nesting gap that findTranscripts misses.
 *
 * METADATA ONLY: the parsers read usage numbers, model ids and timestamps — never
 * message/prompt/tool content.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { register } from "tsx/esm/api";
register();

const { parseTranscript } = await import(new URL("../src/jsonl.ts", import.meta.url).href);
const { parseCodexRollout } = await import(new URL("../src/codex.ts", import.meta.url).href);
const { findTranscripts, findCodexTranscripts, claudeProjectRoots } = await import(
  new URL("../src/sync.ts", import.meta.url).href
);
const { computeActivity, DEFAULT_GAP_MS } = await import(new URL("../src/activity.ts", import.meta.url).href);

const CACHE_W = 0.02; // efficiency.js / scoring weighting: cache reads discounted 50x
const raw = (t) => (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheCreation || 0);
const weighted = (t) => (t.input || 0) + (t.output || 0) + (t.cacheCreation || 0) + CACHE_W * (t.cacheRead || 0);
const fmt = (v) => Math.round(v).toLocaleString("en-US");

// ---- corpus census -------------------------------------------------------------------------
const roots = claudeProjectRoots();

// Recursive walk of EVERY .jsonl under the Claude roots (incl. <session>/subagents/**).
function walkAll(dirs) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl")) out.push(full);
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

const visibleCC = findTranscripts();            // what the tracker actually syncs
const allCC = walkAll(roots);                   // + nested subagent transcripts
const visibleSet = new Set(visibleCC);
const hiddenCC = allCC.filter((f) => !visibleSet.has(f)); // the gap findTranscripts misses
const codexFiles = findCodexTranscripts();

// ---- aggregate ------------------------------------------------------------------------------
const perModel = new Map();   // model id -> raw TokenCounts
const perHarness = {          // harness -> { raw TokenCounts, sessions, activeMs, files }
  claude_code: { tok: z(), sessions: 0, activeMs: 0, files: 0, bytes: 0 },
  codex: { tok: z(), sessions: 0, activeMs: 0, files: 0, bytes: 0 },
};
function z() { return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }; }
function add(into, t) {
  into.input += t.input || 0; into.output += t.output || 0;
  into.cacheRead += t.cacheRead || 0; into.cacheCreation += t.cacheCreation || 0;
}
function creditModel(id, t) {
  const cur = perModel.get(id) ?? z();
  add(cur, t); perModel.set(id, cur);
}

let ccUnreadable = 0, ccEmpty = 0, codexUnreadable = 0, codexEmpty = 0;

function ingestClaude(files, isSubagentGap) {
  for (const f of files) {
    let parsed;
    try { parsed = parseTranscript(readFileSync(f, "utf8")); }
    catch { ccUnreadable++; continue; }
    if (parsed.messageCount === 0) { ccEmpty++; continue; }
    const h = perHarness.claude_code;
    add(h.tok, parsed.tokens);
    h.sessions++; h.files++;
    try { h.bytes += statSync(f).size; } catch {}
    h.activeMs += computeActivity(parsed.timestamps, DEFAULT_GAP_MS).activeMs;
    // per-model buckets: models[] excludes <synthetic>; fall back to session model if empty
    if (parsed.models.length) {
      for (const m of parsed.models) creditModel(m.id, m);
    } else {
      creditModel(parsed.model || "unknown", parsed.tokens);
    }
  }
}

// Tracker-visible + hidden subagent transcripts, so we can report the gap AND a true corpus total.
ingestClaude(visibleCC, false);
const ccVisibleTok = { ...perHarness.claude_code.tok };
const ccVisibleSessions = perHarness.claude_code.sessions;
const perModelAfterVisible = new Map([...perModel].map(([k, v]) => [k, { ...v }]));
ingestClaude(hiddenCC, true);

// Codex rollouts
for (const f of codexFiles) {
  let parsed;
  try { parsed = parseCodexRollout(readFileSync(f, "utf8")); }
  catch { codexUnreadable++; continue; }
  if (parsed.messageCount === 0) { codexEmpty++; continue; }
  const h = perHarness.codex;
  add(h.tok, parsed.tokens);
  h.sessions++; h.files++;
  try { h.bytes += statSync(f).size; } catch {}
  h.activeMs += computeActivity(parsed.timestamps, DEFAULT_GAP_MS).activeMs;
  if (parsed.models.length) {
    for (const m of parsed.models) creditModel(m.id, m);
  } else {
    creditModel(parsed.model || "unknown", parsed.tokens);
  }
}

// ---- report ---------------------------------------------------------------------------------
const out = {};
out.corpus = {
  roots,
  claudeVisibleFiles: visibleCC.length,
  claudeTotalFilesRecursive: allCC.length,
  claudeHiddenSubagentFiles: hiddenCC.length,
  hiddenPct: allCC.length ? +(100 * hiddenCC.length / allCC.length).toFixed(2) : 0,
  codexFiles: codexFiles.length,
  ccUnreadable, ccEmpty, codexUnreadable, codexEmpty,
};

// harness totals (full recursive corpus)
const ccT = perHarness.claude_code.tok, cxT = perHarness.codex.tok;
const ccRaw = raw(ccT), cxRaw = raw(cxT), totRaw = ccRaw + cxRaw;
const ccW = weighted(ccT), cxW = weighted(cxT), totW = ccW + cxW;
out.harness = {
  claude_code: {
    rawTokens: Math.round(ccRaw), rawSharePct: +(100 * ccRaw / totRaw).toFixed(2),
    weightedTokens: Math.round(ccW), weightedSharePct: +(100 * ccW / totW).toFixed(2),
    sessions: perHarness.claude_code.sessions,
    activeHours: +(perHarness.claude_code.activeMs / 3.6e6).toFixed(1),
    tokenBreakdown: ccT,
  },
  codex: {
    rawTokens: Math.round(cxRaw), rawSharePct: +(100 * cxRaw / totRaw).toFixed(2),
    weightedTokens: Math.round(cxW), weightedSharePct: +(100 * cxW / totW).toFixed(2),
    sessions: perHarness.codex.sessions,
    activeHours: +(perHarness.codex.activeMs / 3.6e6).toFixed(1),
    tokenBreakdown: cxT,
  },
};
const totSess = perHarness.claude_code.sessions + perHarness.codex.sessions;
out.harness.sessionSplitPct = {
  claude_code: +(100 * perHarness.claude_code.sessions / totSess).toFixed(2),
  codex: +(100 * perHarness.codex.sessions / totSess).toFixed(2),
};
const totActive = perHarness.claude_code.activeMs + perHarness.codex.activeMs;
out.harness.activeTimeSplitPct = {
  claude_code: +(100 * perHarness.claude_code.activeMs / totActive).toFixed(2),
  codex: +(100 * perHarness.codex.activeMs / totActive).toFixed(2),
};

// per-model raw + weighted shares
const models = [...perModel.entries()].map(([id, t]) => ({ id, raw: raw(t), w: weighted(t), t }))
  .sort((a, b) => b.raw - a.raw);
const totModelRaw = models.reduce((s, m) => s + m.raw, 0);
const totModelW = models.reduce((s, m) => s + m.w, 0);
out.perModel = models.map((m) => ({
  id: m.id,
  rawTokens: Math.round(m.raw), rawSharePct: +(100 * m.raw / totModelRaw).toFixed(2),
  weightedTokens: Math.round(m.w), weightedSharePct: +(100 * m.w / totModelW).toFixed(2),
}));

// aggregate the model buckets into families for the headline
function family(id) {
  const s = String(id).toLowerCase();
  if (s.includes("opus")) return "Claude Opus";
  if (s.includes("sonnet")) return "Claude Sonnet";
  if (s.includes("haiku")) return "Claude Haiku";
  if (s.includes("fable") || s.includes("mythos")) return "Claude (other)";
  if (s.includes("codex") || s.startsWith("gpt")) return "GPT/Codex";
  if (s.includes("claude")) return "Claude (other)";
  return "other: " + id;
}
const fam = new Map();
for (const m of models) {
  const k = family(m.id);
  const cur = fam.get(k) ?? { raw: 0, w: 0 };
  cur.raw += m.raw; cur.w += m.w; fam.set(k, cur);
}
out.perFamily = [...fam.entries()].map(([id, v]) => ({
  family: id,
  rawTokens: Math.round(v.raw), rawSharePct: +(100 * v.raw / totModelRaw).toFixed(2),
  weightedTokens: Math.round(v.w), weightedSharePct: +(100 * v.w / totModelW).toFixed(2),
})).sort((a, b) => b.rawTokens - a.rawTokens);

out.totals = {
  rawTokensAll: Math.round(totRaw),
  weightedTokensAll: Math.round(totW),
  sessionsAll: totSess,
  activeHoursAll: +(totActive / 3.6e6).toFixed(1),
};

// subagent gap: tokens visible-only vs full recursive
// ---- SYNCED VIEW: exactly what the tracker pushes (findSources) + the profile's weighted
// tool-share and effective-$ math, to reconstruct the rendered "98% Codex / $ / effective $". ----
// Inlined verbatim from the web app's pricing module (PRICING table + priceForModel + spendForModels)
// — importing the module directly pulls in SvelteKit's $app via firebase.js.
const PRICING = {
  "claude-fable-5":{input:10,output:50,cacheRead:1,cacheCreation:12.5},
  "claude-mythos-5":{input:10,output:50,cacheRead:1,cacheCreation:12.5},
  "claude-opus-4-8":{input:5,output:25,cacheRead:.5,cacheCreation:6.25},
  "claude-opus-4-7":{input:5,output:25,cacheRead:.5,cacheCreation:6.25},
  "claude-opus-4-6":{input:5,output:25,cacheRead:.5,cacheCreation:6.25},
  "claude-opus-4-5":{input:5,output:25,cacheRead:.5,cacheCreation:6.25},
  "claude-sonnet-4-6":{input:3,output:15,cacheRead:.3,cacheCreation:3.75},
  "claude-sonnet-4-5":{input:3,output:15,cacheRead:.3,cacheCreation:3.75},
  "claude-haiku-4-5":{input:1,output:5,cacheRead:.1,cacheCreation:1.25},
  "kimi-k2":{input:.6,output:2.5,cacheRead:.15,cacheCreation:.6},
  "glm-4.6":{input:.6,output:2.2,cacheRead:.11,cacheCreation:.6},
  "gpt-5":{input:1.25,output:10,cacheRead:.125,cacheCreation:1.25},
  "gpt-5.4":{input:2.5,output:15,cacheRead:.25,cacheCreation:2.5},
  "gpt-5.4-mini":{input:.75,output:4.5,cacheRead:.075,cacheCreation:.75},
  "gemini-3-flash":{input:.5,output:3,cacheRead:.05,cacheCreation:.5},
  "gemini-3-pro":{input:2,output:12,cacheRead:.2,cacheCreation:2},
};
function priceForModel(model, rates = PRICING) {
  if (rates[model]) return rates[model];
  let best = null;
  for (const id of Object.keys(rates)) if (model && model.startsWith(id) && (best === null || id.length > best.length)) best = id;
  return best ? rates[best] : null;
}
function spendForModels(models, rates = PRICING) {
  let usd = 0, pricedTokens = 0, unpricedTokens = 0; const unpriced = [];
  for (const m of models) {
    const id = typeof m?.id === "string" ? m.id : "";
    const total = raw(m);
    if (total <= 0) continue;
    const p = id ? priceForModel(id, rates) : null;
    if (!p) { unpricedTokens += total; if (id) unpriced.push(id); continue; }
    usd += (Math.max(0,m.input||0)/1e6)*p.input + (Math.max(0,m.output||0)/1e6)*p.output +
           (Math.max(0,m.cacheRead||0)/1e6)*p.cacheRead + (Math.max(0,m.cacheCreation||0)/1e6)*p.cacheCreation;
    pricedTokens += total;
  }
  return { usd, pricedTokens, unpricedTokens, unpriced };
}
// Re-parse the tracker-visible Claude set (findTranscripts) + codex, isolated, so the synced
// tool split is on the SAME corpus the tracker actually syncs (no nested subagent transcripts).
function harnessTok(files, parser) {
  const tok = z(); const perM = new Map(); let sessions = 0;
  for (const f of files) {
    let p; try { p = parser(readFileSync(f, "utf8")); } catch { continue; }
    if (p.messageCount === 0) continue;
    add(tok, p.tokens); sessions++;
    const list = p.models.length ? p.models : [{ id: p.model || "unknown", ...p.tokens }];
    for (const m of list) { const c = perM.get(m.id) ?? z(); add(c, m); perM.set(m.id, c); }
  }
  return { tok, perM, sessions };
}
const syncedCC = harnessTok(visibleCC, parseTranscript);
const syncedCX = harnessTok(codexFiles, parseCodexRollout);
const ccWv = weighted(syncedCC.tok), cxWv = weighted(syncedCX.tok), totWv = ccWv + cxWv;
const ccRv = raw(syncedCC.tok), cxRv = raw(syncedCX.tok), totRv = ccRv + cxRv;
// effective $/M over the synced model mix (priced raw tokens only), mirroring BuilderPanel.effRate
const syncedModels = [];
for (const src of [syncedCC.perM, syncedCX.perM]) for (const [id, t] of src) syncedModels.push({ id, ...t });
const spend = spendForModels(syncedModels, PRICING);
out.syncedView = {
  note: "findSources() corpus = tracker-visible Claude (no nested subagents) + codex; the pipeline that feeds the profile",
  claude_code: { rawTokens: Math.round(ccRv), weightedTokens: Math.round(ccWv), sessions: syncedCC.sessions },
  codex: { rawTokens: Math.round(cxRv), weightedTokens: Math.round(cxWv), sessions: syncedCX.sessions },
  toolShare_byWeightedTokens_pct: { claude_code: +(100 * ccWv / totWv).toFixed(2), codex: +(100 * cxWv / totWv).toFixed(2) },
  toolShare_byRawTokens_pct: { claude_code: +(100 * ccRv / totRv).toFixed(2), codex: +(100 * cxRv / totRv).toFixed(2) },
  totalRawTokens: Math.round(totRv),
  totalWeightedTokens: Math.round(totWv),
  spendUsd: +spend.usd.toFixed(2),
  pricedTokens: Math.round(spend.pricedTokens),
  unpricedTokens: Math.round(spend.unpricedTokens),
  effectiveUsdPerMTok: spend.pricedTokens > 0 ? +(spend.usd / (spend.pricedTokens / 1e6)).toFixed(4) : null,
};

// Per-harness spend + effective $/M (to test the "inverted label / codex-only render" hypothesis).
function harnessSpend(perM) {
  const arr = [...perM].map(([id, t]) => ({ id, ...t }));
  const s = spendForModels(arr, PRICING);
  return { usd: +s.usd.toFixed(2), pricedTokens: Math.round(s.pricedTokens),
    effUsdPerM: s.pricedTokens > 0 ? +(s.usd / (s.pricedTokens / 1e6)).toFixed(4) : null };
}
out.perHarnessSpend = {
  claude_code: harnessSpend(syncedCC.perM),
  codex: harnessSpend(syncedCX.perM),
};

out.subagentGap = {
  visibleRawTokens: Math.round(raw(ccVisibleTok)),
  recursiveRawTokens: Math.round(ccRaw),
  hiddenRawTokens: Math.round(ccRaw - raw(ccVisibleTok)),
  hiddenTokenPct: ccRaw > 0 ? +(100 * (ccRaw - raw(ccVisibleTok)) / ccRaw).toFixed(2) : 0,
  visibleSessions: ccVisibleSessions,
  recursiveSessions: perHarness.claude_code.sessions,
};

console.log(JSON.stringify(out, null, 2));
