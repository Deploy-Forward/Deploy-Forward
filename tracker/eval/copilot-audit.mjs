#!/usr/bin/env node
/**
 * copilot-audit — the pre-publish eval for the GitHub Copilot CLI adapter (8th harness).
 * Runs the REAL Copilot corpus on this machine through the exact production scan
 * (scanCopilotCorpus) and prints everything a human needs to reconcile against Copilot's
 * own reporting. Unlike hermes-audit.mjs/opencode-audit.mjs, this schema was CONFIRMED
 * against a real `~/.copilot/session-store.db` before the parser was written (see
 * src/copilot.ts's header) — this audit is the re-verification pass, not the first look.
 *
 * What it checks mechanically:
 *   - fingerprint: the home must pass isOfficialCopilotCli, or the audit stops and says so;
 *   - skipReason: a soft-skip (node_sqlite_missing / file_missing / open_failed /
 *     schema_mismatch) is reported and the audit stops — the SAME scan result a sync
 *     pass would see this pass;
 *   - drift: unknownLines/totalLines (assistant_usage_events ROW grain — see
 *     src/copilot.ts's header) + the isDriftSuspected verdict, the same threshold rule
 *     status/monitor use elsewhere;
 *   - days[] conservation: for every multi-day session, asserts the day slices' tokens/
 *     activeMs/idleMs sum EXACTLY to the session totals (identity, not tolerance — same
 *     rule test/daySlices.test.ts enforces) and FAILS LOUDLY if they don't;
 *   - a raw, read-only peek at ONE real event's token_details_json (never selected by the
 *     production scan — see the GAP note in src/copilot.ts's header) to document whether
 *     input_tokens reads as inclusive of cache_read_tokens or a parallel billing bucket.
 * What it leaves to the human (print, never auto-pass): per-session tokens/model to
 * compare against Copilot CLI's own reporting, if any exists.
 *
 * Run where the corpus lives:
 *   cd tracker && node eval/copilot-audit.mjs
 *   (DF_COPILOT_HOME overrides the default ~/.copilot.)
 * Exit: 0 = fingerprint ok + corpus read + days[] conservation held (human still eyeballs
 *           totals);
 *       1 = a days[] conservation check failed (a real correctness bug, not a data gap);
 *       2 = fingerprint failed or the scan was skipped this pass.
 */
import { randomBytes } from "node:crypto";
import { register } from "tsx/esm/api";

register(); // lets this .mjs import the tracker's TypeScript sources directly

const { scanCopilotCorpus, isOfficialCopilotCli, copilotHome, copilotDbPath } = await import(
  new URL("../src/copilot.ts", import.meta.url).href
);
const { isDriftSuspected } = await import(new URL("../src/providers.ts", import.meta.url).href);
const { openSqliteReadOnly } = await import(new URL("../src/sqlite.ts", import.meta.url).href);

const home = copilotHome();
if (!isOfficialCopilotCli(home)) {
  console.error(`No official Copilot CLI tree at ${home} (set DF_COPILOT_HOME to point at one).`);
  console.error("The fingerprint is structural — if a real Copilot CLI install fails it, that IS a finding: report it.");
  process.exit(2);
}

// SYNTHETIC state: throwaway repoHmacKey, default gap. This audit must run unpaired and
// must never read or touch the user's real df-state (same rule as hermes-audit.mjs).
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

const scan = scanCopilotCorpus(state, home);
const fmt = (n) => n.toLocaleString("en-US");

if (scan.skipReason) {
  console.error(`copilot-audit: scan skipped this pass — skipReason=${scan.skipReason}`);
  console.error("This is the SAME soft-skip a future sync pass would see; nothing was read.");
  process.exit(2);
}

console.log(`copilot-audit: ${home}`);
console.log(`sessions: ${scan.sessions.length} · rows: ${fmt(scan.totalLines)} · unknown: ${fmt(scan.unknownLines)}`);
const drift = isDriftSuspected({ unknownLines: scan.unknownLines, totalLines: scan.totalLines });
console.log(`drift verdict: ${drift ? "SUSPECTED — assistant_usage_events has moved; diff against copilot.ts's header" : "quiet"}`);
console.log(`watermark (max event created_at, ms): ${scan.watermark ?? "none"}`);
console.log("");

let conservationFailures = 0;
for (const s of scan.sessions) {
  const total = s.tokens;
  console.log(`session ${s.toolSessionId}`);
  console.log(`  model      ${s.model}`);
  console.log(
    `  tokens     in ${fmt(total.input)} · out ${fmt(total.output)} · cacheRead ${fmt(total.cacheRead)} · cacheWrite ${fmt(total.cacheCreation)} · reasoning ${fmt(s.thinkingTokens)}`,
  );
  console.log(`  entryPoint ${s.entryPoint} · turns ${s.turns} (always 0 -- see header) · messageCount ${s.messageCount}`);
  console.log(`  models[]   ${s.models.map((m) => `${m.id}(in ${fmt(m.input)}/out ${fmt(m.output)})`).join(", ") || "(none)"}`);

  if (s.days === undefined) {
    console.log(`  days[]     absent (single-day session)`);
  } else {
    console.log(`  days[]     ${s.days.length} day(s): ${s.days.map((d) => d.day).join(", ")}`);
    let sumActive = 0, sumIdle = 0;
    const sumTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const d of s.days) {
      sumActive += d.activeMs;
      sumIdle += d.idleMs;
      sumTokens.input += d.tokens.input;
      sumTokens.output += d.tokens.output;
      sumTokens.cacheRead += d.tokens.cacheRead;
      sumTokens.cacheCreation += d.tokens.cacheCreation;
    }
    const tokensMatch =
      sumTokens.input === total.input &&
      sumTokens.output === total.output &&
      sumTokens.cacheRead === total.cacheRead &&
      sumTokens.cacheCreation === total.cacheCreation;
    const activityMatches = sumActive === s.activeMs && sumIdle === s.idleMs;
    if (!tokensMatch || !activityMatches) {
      conservationFailures++;
      console.error(`  !! CONSERVATION FAILURE: day slices do not sum exactly to the session total`);
      console.error(`     day-sum tokens ${JSON.stringify(sumTokens)} vs session ${JSON.stringify(total)}`);
      console.error(`     day-sum active/idle ${sumActive}/${sumIdle} vs session ${s.activeMs}/${s.idleMs}`);
    } else {
      console.log(`  conservation OK (day slices sum exactly to session totals)`);
    }
  }
  console.log("");
}

// Diagnostic-only peek at token_details_json / total_nano_aiu -- NEVER read by the
// production scan (copilot.ts's header). Read-only, printed for the GAP note in the
// header (is input_tokens inclusive of cache_read_tokens?), never folded into tokens.
{
  const db = openSqliteReadOnly(copilotDbPath(home));
  if (db.available) {
    try {
      const rows = db.query(
        "SELECT session_id, model, input_tokens, cache_read_tokens, output_tokens, reasoning_tokens, total_nano_aiu, token_details_json FROM assistant_usage_events LIMIT 5",
      );
      if (rows.length > 0) {
        console.log("Diagnostic peek at billing columns (never folded into tokens; informs the input/cacheRead-inclusivity GAP):");
        for (const r of rows) {
          console.log(`  ${r.session_id} model=${r.model} input=${r.input_tokens} cacheRead=${r.cache_read_tokens} output=${r.output_tokens} reasoning=${r.reasoning_tokens}`);
          console.log(`    total_nano_aiu=${r.total_nano_aiu} token_details_json=${r.token_details_json}`);
        }
      }
    } catch {
      // Diagnostic only -- a failure here must not affect the audit's pass/fail verdict.
    } finally {
      db.close();
    }
  }
}

console.log("\nCompare the totals above against Copilot CLI's own reporting for the same sessions, if any exists.");
if (conservationFailures > 0) {
  console.error(`\n${conservationFailures} session(s) FAILED days[] conservation -- this is a correctness bug, not a data gap.`);
  process.exit(1);
}
