#!/usr/bin/env node
/**
 * pi-audit — the W1.6 release gate for the pi adapter (docs/harness-adapters-
 * implementation.md). Runs the REAL pi corpus on this machine through the exact
 * production scan (scanPiCorpus) and prints everything a human needs to reconcile
 * against pi's own numbers, because the parser is docs-derived (pi-mono
 * session-format.md) and W1.0 exists precisely to catch where docs and disk disagree.
 *
 * What it checks mechanically:
 *   - fingerprint: the tree must pass isOfficialPiCli, or the audit stops and says so;
 *   - conservation: per session, the sum of days[] token slices must equal the
 *     session totals EXACTLY (identity, not tolerance) — a violation exits 1;
 *   - drift: unknown/total line counts + the isDriftSuspected verdict, per the same
 *     rule status uses.
 * What it leaves to the human (print, never auto-pass): per-session tokens and models
 * to compare against pi's own /session view (which shows tokens + cost), and the
 * pi.ts header's remaining docs-derived assumptions (branch/rewind non-duplication,
 * cli-only entrypoint). The reasoning-counter-absence assumption is CLOSED: the W1.0
 * corpus proved usage.reasoning exists (docs/pi-capture-notes.md F1, fixed epoch 13).
 *
 * Run where the corpus lives: cd tracker && npm run eval:pi
 *   (DF_PI_HOME overrides the default ~/.pi)
 * Exit: 0 = fingerprint ok + conservation holds (human still eyeballs totals);
 *       1 = conservation violation or scan failure; 2 = no official pi tree found.
 *
 * The state passed to the scan is SYNTHETIC (throwaway repoHmacKey, default gap):
 * this audit must run unpaired and must never read or touch the user's real
 * df-state. Repo hashes in the output are therefore not comparable across runs.
 */
import { randomBytes } from "node:crypto";
import { register } from "tsx/esm/api";

register(); // lets this .mjs import the tracker's TypeScript sources directly

const { scanPiCorpus, isOfficialPiCli, piHome } = await import(new URL("../src/pi.ts", import.meta.url).href);
const { isDriftSuspected } = await import(new URL("../src/providers.ts", import.meta.url).href);

const home = piHome();
if (!isOfficialPiCli(home)) {
  console.error(`No official pi tree at ${home} (set DF_PI_HOME to point at one).`);
  console.error("The fingerprint is structural — if a real pi install fails it, that IS a W1.0 finding: report it.");
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

const scan = scanPiCorpus(state, home);
const sessions = scan.sessions ?? [];
const fmt = (n) => n.toLocaleString("en-US");
let conservationViolations = 0;

console.log(`pi-audit: ${home}`);
console.log(`sessions: ${sessions.length} · lines: ${fmt(scan.totalLines)} · unknown: ${fmt(scan.unknownLines)}`);
const drift = isDriftSuspected({ unknownLines: scan.unknownLines, totalLines: scan.totalLines, at: 0 });
console.log(`drift verdict: ${drift ? "SUSPECTED — the on-disk format has moved; diff a raw session file against pi.ts's header" : "quiet"}`);
console.log("");

for (const s of sessions) {
  const total = s.tokens;
  // days[] exists ONLY on multi-day sessions (single-day stays byte-identical to the
  // pre-slice shape, by design) — conservation is only checkable where slices exist.
  const conserved =
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
  if (!conserved) conservationViolations++;

  console.log(`session ${s.toolSessionId}${conserved ? "" : "  !! CONSERVATION VIOLATION"}`);
  console.log(
    `  tokens  in ${fmt(total.input)} · out ${fmt(total.output)} · cacheRead ${fmt(total.cacheRead)} · cacheWrite ${fmt(total.cacheCreation)} · thinking ${fmt(s.thinkingTokens ?? 0)}`,
  );
  for (const m of s.models ?? []) {
    console.log(`  model   ${m.id}: in ${fmt(m.input)} · out ${fmt(m.output)}`);
  }
  for (const d of s.days ?? []) {
    console.log(`  day     ${d.day}: in ${fmt(d.tokens.input)} · out ${fmt(d.tokens.output)}`);
  }
  console.log("");
}

console.log("Compare the totals above against pi's own /session view (tokens + cost) for the same sessions.");
console.log("Any delta is a W1.0 finding: record it in docs/pi-capture-notes.md before the wave publishes.");

if (conservationViolations > 0) {
  console.error(`\n${conservationViolations} conservation violation(s) — the day slicer disagrees with session totals. Exit 1.`);
  process.exit(1);
}
