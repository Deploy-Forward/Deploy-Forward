#!/usr/bin/env node
/**
 * steward-audit — the EXTERNAL leg of the Phase-0 gate (acceptance criterion 2).
 *
 * Runs a PINNED ccusage (npm ccusage@20.0.14) over every ccusage-compatible Claude
 * fixture and compares its grand totals, per token type, against BOTH the generator's
 * hand-computed truth and our pipeline (summarizeClaudeCorpus). The internal gate
 * (fixture truth == oracle == pipeline, tracker/test/reconcile.test.ts) is the product
 * standard; this audit is external corroboration only — ccusage is steward provenance,
 * never a production/runtime dependency.
 *
 * Provenance note: the Deploy Forward Atomic Capture Standard was verified against
 * ccusage/ccusage Rust source @ f3a8eaba (adapter/claude/daily.rs) on 2026-07-03. The
 * npm binary pinned here is compared EMPIRICALLY; any delta is reported per fixture and
 * per field, decomposed honestly — never silently absorbed.
 *
 * Isolation: each fixture gets its OWN temp CLAUDE_CONFIG_DIR. Fixtures intentionally
 * reuse message ids (m1/r1 across scenarios); a shared dir would cross-dedup between
 * fixtures and corrupt the comparison. CODEX_HOME points at an empty dir, and — because
 * ccusage 20.x is MULTI-AGENT by default (it also scans e.g. Gemini CLI logs on the
 * machine; measured residual 94,228 in / 3,457 out / 74,661 cacheRead here) — every run
 * is windowed to the fixtures' single UTC day (--since/--until 2026-06-01 --timezone
 * UTC), and an empty-corpus BASELINE for that same window must read ZERO or the audit
 * reports itself contaminated instead of silently comparing.
 *
 * Run: cd tracker && npm run eval:steward   (or: node eval/steward-audit.mjs)
 * Exit: 0 when every fixture reconciles within 0.5% per token type (target 0); 1 otherwise.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { register } from "tsx/esm/api";

register(); // lets this .mjs import the tracker's TypeScript sources directly

const { CLAUDE_FIXTURES } = await import(new URL("../test/fixtures.ts", import.meta.url).href);
const { summarizeClaudeCorpus } = await import(new URL("../src/sync.ts", import.meta.url).href);
const { PARSER_EPOCH } = await import(new URL("../src/config.ts", import.meta.url).href);

const CCUSAGE_PIN = "ccusage@20.0.14";
const FIELDS = ["input", "output", "cacheRead", "cacheCreation"];
const TOLERANCE = 0.005; // 0.5% acceptance ceiling; target is 0

function n(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function fmt(v) {
  return v.toLocaleString("en-US");
}

function testState() {
  return {
    apiBase: "http://x",
    deviceToken: "t",
    uid: null,
    handle: null,
    repoHmacKey: "k".repeat(64),
    cursors: {},
    threadDigests: {},
    parserEpoch: PARSER_EPOCH,
    gapMs: 5 * 60 * 1000,
  };
}

/** Write one fixture into its own isolated CLAUDE_CONFIG_DIR; return dirs + sources. */
function materialize(fx) {
  const cfg = mkdtempSync(join(tmpdir(), `df-steward-${fx.name}-`));
  const proj = join(cfg, "projects", `fx-${fx.name}`);
  mkdirSync(proj, { recursive: true });
  for (const f of fx.files) {
    const full = join(proj, ...f.relPath.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.lines.join("\n"));
  }
  const sources = fx.files
    .filter((f) => !f.relPath.includes("/"))
    .map((root) => ({
      path: join(proj, root.relPath),
      subagents: fx.files
        .filter((f) => f.relPath.startsWith(root.relPath.replace(/\.jsonl$/, "") + "/subagents/"))
        .map((f) => join(proj, ...f.relPath.split("/"))),
    }));
  return { cfg, sources };
}

/** All fixture entries live on this single UTC day; the window isolates them from any
 * real usage other agents logged on this machine. */
const FIXTURE_DAY = "2026-06-01";

function runCcusage(cfgDir, emptyDir) {
  const window = `--since ${FIXTURE_DAY} --until ${FIXTURE_DAY} --timezone UTC`;
  const attempts = [
    `npx -y ${CCUSAGE_PIN} daily --json --offline ${window}`,
    `npx -y ${CCUSAGE_PIN} daily --json ${window}`,
  ];
  for (const cmd of attempts) {
    const r = spawnSync(cmd, {
      encoding: "utf8",
      shell: true, // npx is npx.cmd on Windows
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir, CODEX_HOME: emptyDir },
    });
    if (r.status === 0 && r.stdout) {
      try {
        const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
        const t = j.totals ?? {};
        return {
          cmd,
          totals: {
            input: n(t.inputTokens),
            output: n(t.outputTokens),
            cacheRead: n(t.cacheReadTokens),
            cacheCreation: n(t.cacheCreationTokens),
          },
        };
      } catch {
        /* unparseable — try the next invocation */
      }
    }
  }
  return null;
}

function sum(tokensList) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const t of tokensList) for (const f of FIELDS) out[f] += t[f];
  return out;
}

const emptyDir = mkdtempSync(join(tmpdir(), "df-steward-empty-"));
mkdirSync(join(emptyDir, "projects"), { recursive: true });

console.log(`steward-audit — generator truth vs our pipeline vs pinned ${CCUSAGE_PIN}`);
console.log(`  internal standard verified against ccusage/ccusage Rust @ f3a8eab (2026-07-03)`);
console.log(`  window: ${FIXTURE_DAY} UTC (isolates fixtures from other agents' real usage)`);

// Contamination check: an empty corpus in the fixture window must read ZERO tokens.
// If it doesn't, some other agent logged usage on the fixture day — report, don't compare.
const baseline = runCcusage(emptyDir, emptyDir);
const baselineTotal = baseline ? FIELDS.reduce((a, f) => a + baseline.totals[f], 0) : null;
if (baseline && baselineTotal !== 0) {
  console.log(`  WARNING: empty-corpus baseline is NON-ZERO in the window (${fmt(baselineTotal)} tokens)`);
  console.log("  — another agent has real usage on the fixture day; external audit would be");
  console.log("  contaminated. Reporting internal gate only.");
}
console.log("");

let failures = 0;
let ccusageUnavailable = 0;

for (const fx of CLAUDE_FIXTURES) {
  const { cfg, sources } = materialize(fx);

  // Generator truth (hand-computed) and our pipeline, summed across threads.
  const expected = sum(Object.values(fx.expected.byModel));
  const summaries = summarizeClaudeCorpus(sources, testState());
  const ours = sum(summaries.map((s) => s.tokens));

  // Internal consistency first (the reconcile.test.ts gate re-checked here for the report).
  const internalOk = FIELDS.every((f) => ours[f] === expected[f]);

  const cc = baseline && baselineTotal === 0 ? runCcusage(cfg, emptyDir) : null;
  if (!cc) {
    ccusageUnavailable++;
    console.log(`  ${fx.name.padEnd(26)} ours==truth: ${internalOk ? "OK " : "FAIL"}  ccusage: n/a`);
    if (!internalOk) failures++;
    continue;
  }

  const deltas = FIELDS.map((f) => {
    const c = cc.totals[f];
    const o = ours[f];
    if (c === o) return { f, ok: true, text: `${f}=` };
    const pct = c === 0 ? Infinity : Math.abs(o - c) / c;
    return { f, ok: pct <= TOLERANCE, text: `${f}: ours ${fmt(o)} vs cc ${fmt(c)}` };
  });
  const auditOk = deltas.every((d) => d.ok);
  if (!internalOk || !auditOk) failures++;

  const detail = deltas.filter((d) => !d.text.endsWith("=")).map((d) => d.text).join(", ");
  console.log(
    `  ${fx.name.padEnd(26)} ours==truth: ${internalOk ? "OK " : "FAIL"}  ccusage: ${auditOk ? "MATCH" : "DELTA"}${detail ? "  (" + detail + ")" : ""}`,
  );
}

console.log("");
if (ccusageUnavailable === CLAUDE_FIXTURES.length) {
  console.log("  ccusage could not run on this machine (npx fetch failed or output unparseable).");
  console.log("  External audit NOT performed — internal gate results above are still authoritative.");
  process.exit(failures > 0 ? 1 : 0);
}
if (failures > 0) {
  console.log(`  RESULT: ${failures} fixture(s) breached the gate — investigate before claiming the standard.`);
  process.exit(1);
}
console.log(`  RESULT: every fixture reconciles (internal exact; external within ${TOLERANCE * 100}%, pinned ${CCUSAGE_PIN}).`);
