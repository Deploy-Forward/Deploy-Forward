#!/usr/bin/env node
/**
 * reconcile-ccusage — the committed, repeatable spend-accuracy eval (model-use spec §7.5).
 *
 * Runs OUR parser (src/jsonl.ts — exactly what the tracker ships) over the local Claude Code
 * corpus, then runs ccusage (an independent implementation) over the same machine, and reports
 * the per-field totals delta, decomposed into its causes.
 *
 * What the first run of this eval established (2026-07-01, this machine):
 *   1. On an IDENTICAL single-file corpus, ccusage and our parser agree EXACTLY, per field —
 *      the 0.2.0 keep-max (message.id, requestId) dedup matches their independent dedup.
 *   2. ccusage@latest `daily` also ingests ~/.codex (Codex rollouts) plus other non-Claude
 *      sources by default. For a Claude-only comparison we point CODEX_HOME at an empty dir
 *      and measure the remaining non-Claude residual with an empty-corpus baseline run.
 *   3. Claude Code nests SUBAGENT transcripts under <project>/<session>/subagents/ (recursively
 *      for workflows). ccusage walks them; the tracker's findTranscripts does NOT (top-level
 *      sessions only) — that walker gap, not parser semantics, dominates the tracker-visible
 *      delta. Reported separately below; fixing sync is a design decision, not an eval concern.
 *   4. After removing 1-3, ours >= theirs remains, as expected: ccusage dedups
 *      (message.id, requestId) GLOBALLY across files, while the tracker dedups within-file —
 *      cross-file resume/fork dedup is a documented backend follow-up
 *      (competitive-integration.md). That remaining delta is the measure.
 *
 * Metadata only: parseTranscript reads usage numbers, model ids and timestamps — never message
 * content. Degrades gracefully: if ccusage cannot run (no npx cache while offline, etc.) the
 * script says so honestly and still prints our side.
 *
 * Run: cd tracker && npm run eval:ccusage   (or: node eval/reconcile-ccusage.mjs)
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { register } from "tsx/esm/api";

register(); // lets this .mjs import the tracker's TypeScript sources directly (no build step)

const { parseTranscript } = await import(new URL("../src/jsonl.ts", import.meta.url).href);
const { findTranscripts, claudeProjectRoots, TRACKER_VERSION } = await import(new URL("../src/sync.ts", import.meta.url).href);
const { PARSER_EPOCH } = await import(new URL("../src/config.ts", import.meta.url).href);

const FIELDS = ["input", "output", "cacheRead", "cacheCreation"];

function n(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function fmt(v) {
  return v.toLocaleString("en-US");
}
function sumFields(t) {
  return FIELDS.reduce((acc, f) => acc + t[f], 0);
}

// ---- our side: the tracker's own parser -----------------------------------------------------

/** Parse every file with the shipping parser; one unreadable file never aborts the pass. */
function ourTotals(files) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, files: 0, unreadable: 0 };
  for (const f of files) {
    try {
      const p = parseTranscript(readFileSync(f, "utf8"));
      for (const field of FIELDS) t[field] += p.tokens[field];
      t.files++;
    } catch {
      t.unreadable++;
    }
  }
  return t;
}

/** Census walk: EVERY .jsonl under the roots, including nested subagent transcripts. */
function walkAll(roots) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl")) out.push(full);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

const roots = claudeProjectRoots();
const visible = ourTotals(findTranscripts()); // what the tracker actually syncs today
const recursive = ourTotals(walkAll(roots)); // + nested subagent transcripts (census)

// ---- their side: ccusage, an independent implementation -------------------------------------

function runCcusage(extraEnv) {
  // --offline first (cached pricing, no network needed for rates); plain as a fallback for
  // versions without the flag. npx itself may still need the network once to fetch the package.
  const attempts = [
    "npx -y ccusage@latest daily --json --offline",
    "npx -y ccusage@latest daily --json",
  ];
  for (const cmd of attempts) {
    const r = spawnSync(cmd, {
      encoding: "utf8",
      shell: true, // npx is npx.cmd on Windows; a single command string avoids DEP0190
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...extraEnv },
    });
    if (r.status === 0 && r.stdout) {
      try {
        // --json output is pure JSON; slice from the first brace in case a banner sneaks in.
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

// Claude-only isolation: an empty CODEX_HOME removes ~/.codex from ccusage's scan. The empty
// CLAUDE_CONFIG_DIR baseline measures whatever residual non-Claude sources remain, so the
// comparison can be labeled honestly instead of silently contaminated. ccusage requires the
// config dir to contain a projects/ subdirectory, so the baseline dir carries an empty one.
const emptyDir = mkdtempSync(join(tmpdir(), "df-ccusage-empty-"));
mkdirSync(join(emptyDir, "projects"));
const theirs = runCcusage({ CODEX_HOME: emptyDir });
const baseline = theirs ? runCcusage({ CODEX_HOME: emptyDir, CLAUDE_CONFIG_DIR: emptyDir }) : null;

// ---- the delta report ------------------------------------------------------------------------

console.log("reconcile-ccusage — tracker parser vs ccusage (independent implementation)");
console.log(`  tracker ${TRACKER_VERSION}, PARSER_EPOCH ${PARSER_EPOCH}`);
console.log(`  roots: ${roots.join(", ")}`);
console.log(`  corpus: ${visible.files} tracker-visible transcript(s) (${visible.unreadable} unreadable), ` +
  `${recursive.files} total incl. nested subagent transcripts (${recursive.unreadable} unreadable)`);
console.log("");
const pad = (s) => String(s).padStart(16);
console.log(`  ${"field".padEnd(14)}${pad("tracker-visible")}${pad("ours-recursive")}${pad(theirs ? "ccusage" : "ccusage (n/a)")}${pad("recur delta %")}`);
for (const field of [...FIELDS, "TOTAL"]) {
  const vis = field === "TOTAL" ? sumFields(visible) : visible[field];
  const rec = field === "TOTAL" ? sumFields(recursive) : recursive[field];
  if (!theirs) {
    console.log(`  ${field.padEnd(14)}${pad(fmt(vis))}${pad(fmt(rec))}${pad("-")}${pad("-")}`);
    continue;
  }
  const cc = field === "TOTAL" ? sumFields(theirs.totals) : theirs.totals[field];
  const pct = cc === 0 ? (rec === 0 ? "0.00%" : "n/a") : (((rec - cc) / cc) * 100).toFixed(2) + "%";
  console.log(`  ${field.padEnd(14)}${pad(fmt(vis))}${pad(fmt(rec))}${pad(fmt(cc))}${pad(pct)}`);
}
console.log("");
if (theirs) {
  console.log(`  ccusage invocation: ${theirs.cmd} (CODEX_HOME isolated to an empty dir)`);
  if (baseline) {
    console.log(`  ccusage non-Claude residual (empty-corpus baseline, NOT subtracted): ${fmt(sumFields(baseline.totals))} tokens`);
  } else {
    console.log("  ccusage non-Claude residual: baseline run failed — residual unmeasured this pass.");
  }
  console.log("  reading the deltas:");
  console.log("    ours-recursive vs ccusage  = cross-file resume/fork dedup gap (documented backend");
  console.log("                                 follow-up; ours >= theirs expected) + the residual above.");
  console.log("    tracker-visible vs recursive = nested subagent transcripts findTranscripts does not");
  console.log("                                 walk today (sync design decision, tracked separately).");
} else {
  console.log("  ccusage could not run on this machine (npx fetch failed or output unparseable).");
  console.log("  No comparison performed — the numbers above are OUR parser only. Re-run with network.");
}
