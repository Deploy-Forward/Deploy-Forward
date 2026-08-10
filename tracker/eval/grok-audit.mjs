#!/usr/bin/env node
/**
 * grok-audit — the committed live-corpus gate the providers.ts registry owed
 * (its Grok row carried `evalScript: null`: the 2026-07-10 audit ran ad hoc on
 * the capture machine and was never committed — a recorded gap against the
 * maintenance contract, spec §5.3). Grok is the highest silent-drift risk of the
 * seven providers: it reads an UNDOCUMENTED internal log (~/.grok/logs/
 * unified.jsonl), and its own drift counter is structurally blind to the two
 * failure modes this script exists to catch (recorded in providers.ts + grok.ts):
 *
 *   1. MARKER VANISH — the counter's denominator is candidate lines matching
 *      "shell.turn.inference_done"; a vendor rename of that marker empties the
 *      candidate set and the counter reads a clean 0/0 while capture silently
 *      stops. Mechanical check here: a log with raw lines but zero candidates
 *      on a fingerprint-passing tree exits 1.
 *   2. RENAME INSIDE CANDIDATES — prompt_tokens et al renamed inside matching
 *      lines DOES count as drift, but only a human diff against Grok's own
 *      numbers proves the parse is still SEMANTICALLY right. Printed, never
 *      auto-passed.
 *
 * Also checked mechanically:
 *   - fingerprint: the tree must pass isOfficialGrokCli, or the audit stops
 *     (exit 2) and says so — if a REAL official install fails it, that is
 *     itself a finding: report it;
 *   - models identity: per session, the sum of models[] token buckets must
 *     equal the session totals EXACTLY (grok.ts folds totals FROM the model
 *     buckets today, so a violation means that construction regressed);
 *   - days identity: grok sessions carry no days[] today (multi-day slicing is
 *     a recorded gap, unlike Claude/pi) — the check is vacuous until slices
 *     appear, at which point it is already armed;
 *   - drift: unknown/total candidate counts + the isDriftSuspected verdict,
 *     the same rule status uses. KNOWN CAVEAT (grok.ts header): pre-token-
 *     logging builds (< ~0.2.8x) emit candidate lines without token fields and
 *     land in unknown — an old corpus tail can read as drift here.
 * What it leaves to the human: per-session tokens/models/turns to reconcile
 * against Grok's own session view, and the join coverage lines (sessions whose
 * per-session summary dir vanished lose cwd/model-window attribution — a high
 * miss rate is a layout-drift signal even when tokens still parse).
 *
 * Run where the corpus lives: cd tracker && npm run eval:grok
 *   (DF_GROK_HOME overrides the default ~/.grok)
 * Exit: 0 = fingerprint ok + identities hold (human still eyeballs totals);
 *       1 = identity violation or marker vanish; 2 = no official grok tree.
 *
 * The state passed to the scan is SYNTHETIC (throwaway repoHmacKey, default
 * gap): this audit must run unpaired and must never read or touch the user's
 * real df-state. Repo hashes in the output are not comparable across runs.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "tsx/esm/api";

register(); // lets this .mjs import the tracker's TypeScript sources directly

const { scanGrokCorpus, isOfficialGrokCli, grokHome, grokUnifiedLogPath } = await import(
  new URL("../src/grok.ts", import.meta.url).href
);
const { isDriftSuspected } = await import(new URL("../src/providers.ts", import.meta.url).href);

const home = grokHome();
if (!isOfficialGrokCli(home)) {
  console.error(`No official Grok CLI tree at ${home} (set DF_GROK_HOME to point at one).`);
  console.error(
    "The fingerprint is content-based (models_cache.json xAI proxy / config.toml xai-org marketplace) — if a real official install fails it, that IS a finding: report it.",
  );
  process.exit(2);
}

const state = {
  apiBase: "unused://",
  deviceToken: null,
  uid: null,
  handle: null,
  repoHmacKey: randomBytes(32).toString("hex"),
  cursors: {},
  threadDigests: {},
  orgStamp: "none",
  parserEpoch: 0,
  lastSyncAt: 0,
  gapMs: 5 * 60 * 1000,
};

const scan = scanGrokCorpus(state, home);
const sessions = scan.sessions ?? [];
const fmt = (n) => n.toLocaleString("en-US");

// Raw line count for the marker-vanish check — read once, count non-empty lines.
// (scanGrokCorpus already read the same file; this is an eval script, cheap re-read
// beats widening the production scan's return shape for a gate-only number.)
let rawLines = 0;
try {
  rawLines = readFileSync(grokUnifiedLogPath(home), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
} catch {
  /* unreadable log — rawLines stays 0 and the vanish check below can't fire */
}

console.log(`grok-audit: ${home}`);
console.log(
  `sessions: ${sessions.length} · raw log lines: ${fmt(rawLines)} · candidate lines: ${fmt(scan.totalLines)} · unknown: ${fmt(scan.unknownLines)}`,
);
const drift = isDriftSuspected({ unknownLines: scan.unknownLines, totalLines: scan.totalLines });
console.log(
  `drift verdict: ${drift ? "SUSPECTED — token fields inside candidate lines stopped parsing; diff a raw inference_done line against grok.ts's extractor" : "quiet"}`,
);
console.log("");

// THE Grok blind spot (providers.ts): a marker rename empties the candidate set and
// the drift counter reads clean. A fingerprint-passing tree whose log has real lines
// but ZERO candidates means the "shell.turn.inference_done" marker moved.
if (rawLines > 0 && scan.totalLines === 0) {
  console.error("MARKER VANISH: the log has lines but not one matched \"shell.turn.inference_done\".");
  console.error("The vendor renamed the inference marker — grok.ts's pre-filter (and every downstream counter) is now blind. Exit 1.");
  process.exit(1);
}

let modelsIdentityViolations = 0;
let daysIdentityViolations = 0;
let unknownModelSessions = 0;
let noRepoSessions = 0;

for (const s of sessions) {
  const total = s.tokens;

  // models[] -> totals identity (grok.ts constructs totals from the buckets).
  const mSum = (s.models ?? []).reduce(
    (acc, m) => ({
      input: acc.input + m.input,
      output: acc.output + m.output,
      cacheRead: acc.cacheRead + m.cacheRead,
      cacheCreation: acc.cacheCreation + m.cacheCreation,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  );
  const modelsConserved =
    mSum.input === total.input &&
    mSum.output === total.output &&
    mSum.cacheRead === total.cacheRead &&
    mSum.cacheCreation === total.cacheCreation;
  if (!modelsConserved) modelsIdentityViolations++;

  // days[] identity — vacuous today (grok sessions carry no slices), armed for when
  // they do. Same guard shape as pi-audit.
  const daysConserved =
    s.days === undefined ||
    (() => {
      const daySum = s.days.reduce(
        (acc, d) => ({
          input: acc.input + d.tokens.input,
          output: acc.output + d.tokens.output,
          cacheRead: acc.cacheRead + d.tokens.cacheRead,
          cacheCreation: acc.cacheCreation + d.tokens.cacheCreation,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      );
      return (
        daySum.input === total.input &&
        daySum.output === total.output &&
        daySum.cacheRead === total.cacheRead &&
        daySum.cacheCreation === total.cacheCreation
      );
    })();
  if (!daysConserved) daysIdentityViolations++;

  const modelUnknown = (s.models ?? []).some((m) => m.id === "unknown") || s.model === "unknown";
  if (modelUnknown) unknownModelSessions++;
  if (s.repoHash === null) noRepoSessions++;

  const flags = [
    modelsConserved ? "" : "  !! MODELS IDENTITY VIOLATION",
    daysConserved ? "" : "  !! DAYS IDENTITY VIOLATION",
  ].join("");
  console.log(`session ${s.toolSessionId}${flags}`);
  console.log(
    `  tokens  in ${fmt(total.input)} · out ${fmt(total.output)} · cacheRead ${fmt(total.cacheRead)} · cacheWrite ${fmt(total.cacheCreation)} · thinking ${fmt(s.thinkingTokens ?? 0)}`,
  );
  for (const m of s.models ?? []) {
    console.log(`  model   ${m.id}: in ${fmt(m.input)} · out ${fmt(m.output)}`);
  }
  console.log(`  turns   ${fmt(s.turns)} · messages ${fmt(s.messageCount)} · cwd ${s.cwd ?? "— (session dir gone: no repo/model-window join)"}`);
  console.log("");
}

// Join coverage: the two-source join (unified.jsonl x per-session summary dirs) is
// where layout drift shows up FIRST — tokens keep parsing while attribution decays.
console.log(
  `join coverage: ${sessions.length - noRepoSessions}/${sessions.length} sessions carry a repo pseudonym (a cwd like a drive root has no basename to hash) · ${unknownModelSessions} with an "unknown" model bucket`,
);
console.log("Compare the totals above against Grok's own session view for the same sessions.");
console.log("Any delta is a finding: record it in docs/grok-capture-notes.md before the next tracker publish.");

if (modelsIdentityViolations > 0 || daysIdentityViolations > 0) {
  console.error(
    `\n${modelsIdentityViolations} models-identity + ${daysIdentityViolations} days-identity violation(s) — token bucketing disagrees with session totals. Exit 1.`,
  );
  process.exit(1);
}
