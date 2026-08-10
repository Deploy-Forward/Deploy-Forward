#!/usr/bin/env node
/**
 * hermes-audit — the pre-publish eval for the Hermes adapter (docs/harness-adapters-
 * implementation.md §3, Wave 3 SQLite pair). Mirrors tracker/eval/pi-audit.mjs's shape:
 * runs the REAL Hermes corpus on this machine through the exact production scan
 * (scanHermesCorpus) and prints everything a human needs to reconcile against Hermes's
 * own reporting, because the parser is SOURCE-derived (hermes_state.py's schema, not
 * just its docs) but still UNVALIDATED against any real ~/.hermes install (none exists
 * on the dev machine that wrote src/hermes.ts — see that file's header).
 *
 * Unlike pi-audit.mjs, there is NO days[] conservation check here: tracker/src/hermes.ts
 * never emits days[] at all (see its file header) — Hermes's session-grain token
 * counters cannot be honestly split across the days a multi-day session's messages
 * touch (messages.token_count exists but its per-role meaning is undocumented, so using
 * it would be inventing a convention no source states). Instead, this audit surfaces,
 * per session, whether the message timestamps actually DO span multiple UTC days — a
 * corpus fact worth observing even though the parser deliberately does not act on it.
 * That is exactly the signal that would justify building day-slicing for Hermes later.
 *
 * What it checks mechanically:
 *   - fingerprint: the tree must pass isOfficialHermesCli, or the audit stops and says so;
 *   - skipReason: a soft-skip (node_sqlite_missing / file_missing / open_failed /
 *     schema_mismatch) is reported and the audit stops — this is the SAME scan result
 *     the (separate, not-yet-built) sync wiring would see this pass;
 *   - drift: unknownLines/totalLines (session ROWS here, not text lines — see
 *     hermes.ts's header) + the isDriftSuspected verdict, the same threshold rule
 *     status/monitor use elsewhere;
 *   - legacyJsonlWithoutDb: the pre-migration drift-era signal.
 * What it leaves to the human (print, never auto-pass): per-session tokens/model to
 * compare against Hermes's own reporting (`hermes insights`, per the CLI reference, if
 * installed), and hermes.ts's header assumptions (token_count-per-role undocumented,
 * cwd/entryPoint mapping, the structural-only fingerprint's collision risk).
 *
 * Run where the corpus lives:
 *   cd tracker && node eval/hermes-audit.mjs
 *   (DF_HERMES_HOME overrides the default ~/.hermes; no package.json script is wired
 *   yet — adding "eval:hermes" alongside "eval:pi" is sync-wiring-adjacent housekeeping
 *   out of this task's file scope, left for that task.)
 * Exit: 0 = fingerprint ok + corpus read (human still eyeballs totals);
 *       2 = fingerprint failed or the scan was skipped this pass.
 */
import { randomBytes } from "node:crypto";
import { register } from "tsx/esm/api";

register(); // lets this .mjs import the tracker's TypeScript sources directly

const { scanHermesCorpus, isOfficialHermesCli, hermesHome } = await import(new URL("../src/hermes.ts", import.meta.url).href);
const { isDriftSuspected } = await import(new URL("../src/providers.ts", import.meta.url).href);

const home = hermesHome();
if (!isOfficialHermesCli(home)) {
  console.error(`No official Hermes tree at ${home} (set DF_HERMES_HOME to point at one).`);
  console.error("The fingerprint is structural — if a real Hermes install fails it, that IS a finding: report it.");
  process.exit(2);
}

// SYNTHETIC state: throwaway repoHmacKey, default gap. This audit must run unpaired and
// must never read or touch the user's real df-state (same rule as pi-audit.mjs).
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

const scan = scanHermesCorpus(state, home);
const fmt = (n) => n.toLocaleString("en-US");

if (scan.skipReason) {
  console.error(`hermes-audit: scan skipped this pass — skipReason=${scan.skipReason}`);
  console.error("This is the SAME soft-skip a future sync pass would see; nothing was read.");
  process.exit(2);
}

console.log(`hermes-audit: ${home}`);
console.log(`sessions: ${scan.sessions.length} · rows: ${fmt(scan.totalLines)} · unknown: ${fmt(scan.unknownLines)}`);
const drift = isDriftSuspected({ unknownLines: scan.unknownLines, totalLines: scan.totalLines });
console.log(`drift verdict: ${drift ? "SUSPECTED — the sessions table has moved; diff against hermes.ts's header" : "quiet"}`);
if (scan.legacyJsonlWithoutDb) {
  console.log("NOTE: legacy ~/.hermes/sessions/*.jsonl transcripts exist without state.db — a pre-migration install signal.");
}
console.log(`watermark (max started_at, ms): ${scan.watermark ?? "none"}`);
console.log("");

let multiDayCount = 0;
for (const s of scan.sessions) {
  const total = s.tokens;
  console.log(`session ${s.toolSessionId}`);
  console.log(`  model      ${s.model}`);
  console.log(
    `  tokens     in ${fmt(total.input)} · out ${fmt(total.output)} · cacheRead ${fmt(total.cacheRead)} · cacheWrite ${fmt(total.cacheCreation)} · reasoning ${fmt(s.thinkingTokens)}`,
  );
  console.log(`  entryPoint ${s.entryPoint} · turns ${s.turns} · messageCount(assistant) ${s.messageCount}`);
  console.log(`  days[]     ${s.days === undefined ? "absent (by design — see hermes.ts header)" : "UNEXPECTED: present"}`);
  const startDay = new Date(s.startedAt).toISOString().slice(0, 10);
  const endDay = new Date(s.endedAt).toISOString().slice(0, 10);
  if (startDay !== endDay) {
    multiDayCount++;
    console.log(`  !! spans a UTC midnight (${startDay} -> ${endDay}) — tokens NOT split by day (days[] gap made concrete)`);
  }
  console.log("");
}

console.log("Compare the totals above against Hermes's own reporting (`hermes insights`, if available) for the same sessions.");
console.log("Any delta, or any UNEXPECTED days[] presence, is a finding: record it before this adapter is trusted.");
if (multiDayCount > 0) {
  console.log(`\n${multiDayCount} session(s) genuinely span a UTC midnight without a day-token split — informational, not a failure.`);
  console.log("This is the concrete evidence that would justify building Hermes day-slicing in a future wave.");
}
