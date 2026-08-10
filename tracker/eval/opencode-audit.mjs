#!/usr/bin/env node
/**
 * opencode-audit — the release gate for the opencode adapter (docs/harness-adapters-
 * implementation.md, Wave 3). Runs the REAL opencode SQLite corpus on this machine through
 * the exact production scan (scanOpencodeCorpus) and prints everything a human needs to
 * reconcile against opencode's own numbers. The parser is SOURCE-derived (read directly from
 * github.com/anomalyco/opencode, formerly sst/opencode) but has never been run against a real
 * install — this audit is precisely what catches where the source and a live db disagree.
 *
 * What it checks mechanically:
 *   - fingerprint: the home must pass isOfficialOpencodeHome, or the audit stops and says so;
 *   - node:sqlite availability: prints the soft-skip reason plainly if the adapter can't read
 *     anything this pass (old Node, every db file locked/corrupt/schema-mismatched);
 *   - drift: unknownLines/totalLines (session-row scope — see src/opencode.ts's header) +
 *     the isDriftSuspected verdict, per the same rule status/monitor would use;
 *   - legacy format: counts (never parses) pre-migration file-JSON artifacts, so a stuck
 *     install is a loud finding instead of a quiet "0 sessions".
 * What it leaves to the human (print, never auto-pass): per-session tokens/model/message
 * count to compare against opencode's own `session` view or `opencode db` introspection, and
 * the deliberate gaps recorded in src/opencode.ts's header (no days[], turns always 0, no
 * per-model split within a session, model id composed as `providerID/id`).
 *
 * Run where the corpus lives: cd tracker && node eval/opencode-audit.mjs
 *   (DF_OPENCODE_HOME overrides the default ~/.local/share/opencode; XDG_DATA_HOME is honored
 *   the same way opencode itself resolves it — see src/opencode.ts's header for why this is
 *   the SAME path on Windows as Linux/macOS, not %LOCALAPPDATA%.)
 * Exit: 0 = fingerprint ok (human still eyeballs totals and the disclosed gaps);
 *       1 = scan reported `unavailable` (nothing could be read this pass);
 *       2 = no official opencode tree found.
 *
 * The state passed to the scan is SYNTHETIC (throwaway repoHmacKey, default gap): this audit
 * must run unpaired and must never read or touch the user's real df-state. Repo hashes in the
 * output are therefore not comparable across runs.
 */
import { randomBytes } from "node:crypto";
import { register } from "tsx/esm/api";

register(); // lets this .mjs import the tracker's TypeScript sources directly

const { scanOpencodeCorpus, isOfficialOpencodeHome, opencodeHome, opencodeDbPaths } = await import(
  new URL("../src/opencode.ts", import.meta.url).href
);
const { isDriftSuspected } = await import(new URL("../src/providers.ts", import.meta.url).href);

const home = opencodeHome();
if (!isOfficialOpencodeHome(home)) {
  console.error(`No official opencode tree at ${home} (set DF_OPENCODE_HOME to point at one).`);
  console.error("The fingerprint is structural (a db whose session table carries every expected column) --");
  console.error("if a real opencode install fails it, that IS a finding: report it against src/opencode.ts's header.");
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

const scan = scanOpencodeCorpus(state, home);
const sessions = scan.sessions ?? [];
const fmt = (n) => n.toLocaleString("en-US");

console.log(`opencode-audit: ${home}`);
console.log(`db files: ${opencodeDbPaths(home).join(", ") || "(none)"}`);
console.log(`sessions: ${sessions.length} · rows: ${fmt(scan.totalLines)} · unknown: ${fmt(scan.unknownLines)}`);
if (scan.legacyFilesDetected > 0) {
  console.log(`LEGACY FORMAT: ${scan.legacyFilesDetected} pre-migration file-JSON artifact(s) detected and SKIPPED (never parsed) -- see src/opencode.ts's header.`);
}
const drift = isDriftSuspected({ unknownLines: scan.unknownLines, totalLines: scan.totalLines, at: 0 });
console.log(`drift verdict: ${drift ? "SUSPECTED — the on-disk schema has moved; diff `PRAGMA table_info(session)` against src/opencode.ts's header" : "quiet"}`);
console.log(`watermark: ${fmt(scan.watermark)}`);
if (scan.unavailable) {
  console.error(`\nunavailable: ${scan.unavailable} — nothing could be read this pass.`);
  if (scan.readFailures.length) console.error(`read failures: ${scan.readFailures.join(", ")}`);
  process.exit(1);
}
console.log("");

for (const s of sessions) {
  const t = s.tokens;
  console.log(`session ${s.toolSessionId}`);
  console.log(`  model   ${s.model}`);
  console.log(`  tokens  in ${fmt(t.input)} · out ${fmt(t.output)} · reasoning ${fmt(s.thinkingTokens)} · cacheRead ${fmt(t.cacheRead)} · cacheWrite ${fmt(t.cacheCreation)}`);
  console.log(`  messages ${s.messageCount} · active ${fmt(Math.round(s.activeMs / 1000))}s · idle ${fmt(Math.round(s.idleMs / 1000))}s`);
  console.log(`  days[]  ${s.days === undefined ? "(none — see header: aggregate schema can't be split without smearing)" : s.days.length}`);
  console.log("");
}

console.log("Compare the totals above against opencode's own session view / `opencode db` tooling for the same sessions.");
console.log("Any delta is a finding: record it before this adapter's wave publishes (docs/harness-adapters-implementation.md).");
if (scan.readFailures.length) {
  console.error(`\n${scan.readFailures.length} db file(s) could not be fully read: ${scan.readFailures.join(", ")} — their watermark contribution is correctly withheld.`);
}
