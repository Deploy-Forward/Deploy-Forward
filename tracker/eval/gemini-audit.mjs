#!/usr/bin/env node
/**
 * gemini-audit — the release gate for the Gemini CLI adapter (Lane L14). Runs the REAL
 * ~/.gemini corpus on this machine through the exact production scan (scanGeminiCorpus)
 * and prints everything a human needs to reconcile against Gemini's own numbers. The
 * shape was derived from a single dev-machine store (gemini.ts header); this script is
 * the tool the maintainer runs on a real corpus to CLOSE that W-gate — committed-but-unrun means
 * disk-verified on one machine, not published.
 *
 * Checked mechanically:
 *   - fingerprint: the tree must pass isOfficialGeminiCli, or the audit stops (exit 2)
 *     and says so — if a REAL Gemini install fails the structural fingerprint, that IS a
 *     finding: report it;
 *   - models identity: per session, the sum of models[] token buckets must equal the
 *     session totals EXACTLY (gemini.ts folds totals FROM the buckets, so a violation
 *     means that construction regressed) — exits 1;
 *   - prompt conservation (LOCKED semantic 1): fresh input is never negative and cacheRead
 *     never exceeds what the fold credited — a structural check that the cached-subset
 *     clamp held (cached is part of the prompt, never double-charged) — exits 1;
 *   - drift: unknown/total candidate counts + the isDriftSuspected verdict, the same rule
 *     status uses. The gemini denominator is "gemini"-type messages only; a vendor rename
 *     of the `tokens` object (e.g. codeburn's `cachedContentTokenCount`, or counts moved
 *     under `usage`) lands in unknown here.
 * What it leaves to the human (print, never auto-pass): per-session tokens/models/thinking
 * to compare against Gemini's own /stats view, and whether the `-preview` model ids are
 * still UNPRICED (honest, per gemini.ts's pricing note) rather than silently aliased.
 *
 * Run where the corpus lives: cd tracker && npm run eval:gemini
 *   (DF_GEMINI_HOME or GEMINI_CLI_HOME overrides the default ~/.gemini)
 * Exit: 0 = fingerprint ok + identities hold (human still eyeballs totals);
 *       1 = identity/conservation violation or scan failure; 2 = no official Gemini tree.
 *
 * The state passed to the scan is SYNTHETIC (throwaway repoHmacKey, default gap): this
 * audit must run unpaired and must never read or touch the user's real df-state. Repo
 * hashes in the output are therefore not comparable across runs.
 */
import { randomBytes } from "node:crypto";
import { register } from "tsx/esm/api";

register(); // lets this .mjs import the tracker's TypeScript sources directly

const { scanGeminiCorpus, isOfficialGeminiCli, geminiHome } = await import(
  new URL("../src/gemini.ts", import.meta.url).href
);
const { isDriftSuspected } = await import(new URL("../src/providers.ts", import.meta.url).href);

const home = geminiHome();
if (!isOfficialGeminiCli(home)) {
  console.error(`No official Gemini CLI tree at ${home} (set DF_GEMINI_HOME or GEMINI_CLI_HOME to point at one).`);
  console.error(
    "The fingerprint is structural (a tmp/<projectDir>/chats/*.json parsing to { sessionId, messages:[] }) — if a real install fails it, that IS a finding: report it.",
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

const scan = scanGeminiCorpus(state, home);
const sessions = scan.sessions ?? [];
const fmt = (n) => n.toLocaleString("en-US");

console.log(`gemini-audit: ${home}`);
console.log(
  `sessions: ${sessions.length} · candidate messages: ${fmt(scan.totalLines)} · unknown: ${fmt(scan.unknownLines)}`,
);
const drift = isDriftSuspected({ unknownLines: scan.unknownLines, totalLines: scan.totalLines });
console.log(
  `drift verdict: ${drift ? "SUSPECTED — the `tokens` object stopped parsing inside gemini messages; diff a raw session-*.json against gemini.ts's parser (watch for a cachedContentTokenCount-style rename)" : "quiet"}`,
);
console.log("");

let modelsIdentityViolations = 0;
let conservationViolations = 0;
let unknownModelSessions = 0;
let noRepoSessions = 0;

for (const s of sessions) {
  const total = s.tokens;

  // models[] -> totals identity (gemini.ts constructs totals from the buckets).
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

  // LOCKED semantic 1: the cached-subset clamp must never produce a negative fresh input,
  // and Gemini logs NO cache-write counter so cacheCreation must be 0. A violation means
  // the subtraction/clamp regressed.
  const conserved =
    total.input >= 0 &&
    total.cacheRead >= 0 &&
    total.cacheCreation === 0 &&
    (s.models ?? []).every((m) => m.input >= 0 && m.cacheRead >= 0 && m.cacheCreation === 0);
  if (!conserved) conservationViolations++;

  const modelUnknown = (s.models ?? []).some((m) => m.id === "unknown") || s.model === "unknown";
  if (modelUnknown) unknownModelSessions++;
  if (s.repoHash === null) noRepoSessions++;

  const flags = [
    modelsConserved ? "" : "  !! MODELS IDENTITY VIOLATION",
    conserved ? "" : "  !! CACHED-SUBSET CONSERVATION VIOLATION",
  ].join("");
  console.log(`session ${s.toolSessionId}${flags}`);
  console.log(
    `  tokens  in ${fmt(total.input)} · out ${fmt(total.output)} · cacheRead ${fmt(total.cacheRead)} · cacheWrite ${fmt(total.cacheCreation)} · thinking ${fmt(s.thinkingTokens ?? 0)}`,
  );
  for (const m of s.models ?? []) {
    console.log(`  model   ${m.id}: in ${fmt(m.input)} · out ${fmt(m.output)} · cacheRead ${fmt(m.cacheRead)}`);
  }
  console.log(
    `  turns   ${fmt(s.turns)} · messages ${fmt(s.messageCount)} · cwd ${s.cwd ?? "— (no .project_root: no repo/orgRepo join)"}`,
  );
  console.log("");
}

console.log(
  `join coverage: ${sessions.length - noRepoSessions}/${sessions.length} sessions carry a repo pseudonym · ${unknownModelSessions} with an "unknown" model bucket`,
);
console.log("Compare the totals above against Gemini's own /stats view for the same sessions.");
console.log("Confirm the `-preview` model ids are still UNPRICED (gemini.ts's pricing note) rather than aliased to a guessed rate.");
console.log("Any delta is a finding: record it before the adapter publishes.");

if (modelsIdentityViolations > 0 || conservationViolations > 0) {
  console.error(
    `\n${modelsIdentityViolations} models-identity + ${conservationViolations} cached-subset conservation violation(s) — token bucketing disagrees with session totals. Exit 1.`,
  );
  process.exit(1);
}
