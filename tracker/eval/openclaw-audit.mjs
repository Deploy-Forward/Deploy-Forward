#!/usr/bin/env node
/**
 * openclaw-audit — the W2.4 release gate for the OpenClaw adapter (docs/harness-
 * adapters-implementation.md §2). Runs the REAL OpenClaw corpus on this machine
 * through the exact production scan (scanOpenClawCorpus) and prints everything a
 * human needs to reconcile against OpenClaw's own numbers.
 *
 * RE-BASED 2026-07-14: this eval is what CAUGHT the fact that the adapter's
 * SQLite/database-first premise was false against a real 2026.7.1 install (no
 * `transcript_events` table exists; the per-agent sqlite is auth/cache/memory only —
 * see src/openclaw.ts's header for the full finding). It now runs against the
 * VERIFIED JSONL transcript source (`agents/<agentId>/sessions/<uuid>.jsonl`) and has
 * no `node:sqlite` dependency of any kind — a plain filesystem/JSON reader.
 *
 * What it checks mechanically:
 *   - fingerprint: at least one session file must pass isOfficialOpenClawCli, or the
 *     audit stops and says so;
 *   - conservation: per session, the sum of days[] token slices must equal the
 *     session totals EXACTLY (identity, not tolerance) — a violation exits 1;
 *   - drift: unknown/total line counts + the isDriftSuspected verdict, per the same
 *     rule status/monitor use (spec §5.2) — bounds carry EXTRA weight for OpenClaw
 *     specifically because the vendor calls its own token counters "best-effort/
 *     provider-dependent";
 *   - read failures: any session file this pass could not open/read at all (locked,
 *     corrupt, or a directory sitting where the file should be) is printed by path —
 *     a scan that silently dropped a session's data is exactly the failure mode this
 *     counter exists to surface.
 * What it leaves to the human (print, never auto-pass): per-session tokens and
 * models to compare against OpenClaw's own UI/status view for the same sessions, if
 * one exists and is reachable. No known SEPARATE "rolling snapshot" competing token
 * source was found on the real corpus (the old per-agent sqlite carries no session or
 * token data at all, verified) — if a future audit finds OpenClaw's own UI sourcing
 * numbers from somewhere else, record the delta here, don't silently reconcile it.
 *
 * KNOWN CAPTURE LIMIT worth eyeballing against the real corpus (src/openclaw.ts's
 * header has the full finding): a tool-calling turn logs an all-zero `usage` object
 * on every INTERMEDIATE assistant entry and the real counts only on the turn's FINAL
 * assistant entry — this parser reports exactly what the vendor recorded, never a
 * fabricated split, so a tool-call-heavy session's token mass will look concentrated
 * on fewer timestamps than the true per-call cost. That is a disclosed bound, not a
 * bug this audit should flag.
 *
 * Also worth eyeballing, all recorded as open gaps in src/openclaw.ts's header:
 * whether a larger real corpus ever shows a `message.role` beyond user/assistant/
 * toolResult or an entry `type` beyond session/message (this machine's corpus is
 * only 3 sessions); whether `cwd` ever varies per-session on an install with
 * multiple workspaces (this corpus has exactly one, so repoHash diversity is
 * untested); whether OpenClaw ever replays entries across sibling session FILES the
 * way Claude's resume/fork does (not observed here, and this parser has no
 * cross-file dedup mechanism for it, the same disclosed gap pi.ts carries).
 *
 * Run where the corpus lives: cd tracker && node eval/openclaw-audit.mjs
 *   (DF_OPENCLAW_HOME overrides the default ~/.openclaw)
 * Exit: 0 = fingerprint ok + conservation holds (human still eyeballs totals);
 *       1 = conservation violation; 2 = no official OpenClaw install found.
 *
 * The state passed to the scan is SYNTHETIC (throwaway repoHmacKey, default gap):
 * this audit must run unpaired and must never read or touch the user's real
 * df-state. Repo hashes in the output are therefore not comparable across runs.
 */
import { randomBytes } from "node:crypto";
import { register } from "tsx/esm/api";

register(); // lets this .mjs import the tracker's TypeScript sources directly

const { scanOpenClawCorpus, isOfficialOpenClawCli, openclawHome, openclawSessionFiles } = await import(
  new URL("../src/openclaw.ts", import.meta.url).href
);
const { isDriftSuspected } = await import(new URL("../src/providers.ts", import.meta.url).href);

const home = openclawHome();

if (!isOfficialOpenClawCli(home)) {
  const files = openclawSessionFiles(home);
  console.error(`No official OpenClaw install at ${home} (set DF_OPENCLAW_HOME to point at one).`);
  console.error(`Discovered ${files.length} session file(s) that did not pass the {type:"session"} header fingerprint.`);
  console.error("The fingerprint is structural — if a real OpenClaw install fails it, that IS a finding: report it.");
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

const scan = scanOpenClawCorpus(state, home);
const sessions = scan.sessions ?? [];
const fmt = (n) => n.toLocaleString("en-US");
let conservationViolations = 0;

console.log(`openclaw-audit: ${home}`);
console.log(`sessions: ${sessions.length} · lines: ${fmt(scan.totalLines)} · unknown: ${fmt(scan.unknownLines)}`);
if (scan.readFailures.length > 0) {
  console.log(`READ FAILURES (${scan.readFailures.length}) — these session files contributed NOTHING this pass:`);
  for (const path of scan.readFailures) console.log(`  ${path}`);
}
const drift = isDriftSuspected({ unknownLines: scan.unknownLines, totalLines: scan.totalLines, at: 0 });
console.log(
  `drift verdict: ${drift ? "SUSPECTED — the on-disk shape has moved; diff a real session .jsonl against src/openclaw.ts's header" : "quiet"}`,
);
console.log("");

for (const s of sessions) {
  const total = s.tokens;
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
  console.log(`  cwd     ${s.cwd ?? "(none)"}`);
  console.log(`  entryPoint ${s.entryPoint} · messages ${s.messageCount} · turns ${s.turns}`);
  console.log(`  tokens  in ${fmt(total.input)} · out ${fmt(total.output)} · cacheRead ${fmt(total.cacheRead)} · cacheWrite ${fmt(total.cacheCreation)} · thinking ${fmt(s.thinkingTokens)}`);
  for (const m of s.models ?? []) {
    console.log(`  model   ${m.id}: in ${fmt(m.input)} · out ${fmt(m.output)}`);
  }
  for (const d of s.days ?? []) {
    console.log(`  day     ${d.day}: in ${fmt(d.tokens.input)} · out ${fmt(d.tokens.output)}`);
  }
  console.log("");
}

console.log("Compare the totals above against OpenClaw's own session/status view for the same sessions, if");
console.log("reachable. No separate competing token source was found on the verified real corpus (see");
console.log("src/openclaw.ts's header) -- if one turns up, record the delta here, don't silently reconcile it.");

if (conservationViolations > 0) {
  console.error(`\n${conservationViolations} conservation violation(s) — the day slicer disagrees with session totals. Exit 1.`);
  process.exit(1);
}
