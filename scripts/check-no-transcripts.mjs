#!/usr/bin/env node
/**
 * The transcript tripwire — no real usage data may ever enter this repository.
 *
 * Every test fixture in this tree is synthesized in code, deliberately: a checked-in
 * session transcript or harness database would carry someone's real usage metadata
 * into public history, where deletion is impossible. This script fails CI if any
 * tracked file looks like one.
 *
 * Two checks:
 *   1. EXTENSIONS: no .jsonl / .db / .sqlite / .sqlite3 file may be tracked, period.
 *      (Transcripts are JSONL; harness stores are SQLite. There is no legitimate
 *      reason for either shape in this repo — fixtures are built in test code.)
 *   2. SHAPE: no tracked .json file may contain a transcript-shaped record — an
 *      object carrying BOTH a NUMERIC per-kind token count AND a STRING session/message id
 *      field. Catches a transcript renamed to .json.
 *
 * Runs from the repo root: node scripts/check-no-transcripts.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);

const problems = [];

const BANNED_EXT = /\.(jsonl|db|sqlite|sqlite3)$/i;
for (const f of tracked) {
  if (BANNED_EXT.test(f)) problems.push(`${f}: banned extension (transcript/store shape)`);
}

const USAGE_KEYS = /"(cacheRead|cache_read_input_tokens|cached_content_token_count|input_tokens)"\s*:\s*[0-9]/;
const ID_KEYS = /"(sessionId|toolSessionId|session_id|messageId|message_id)"\s*:\s*"/;
for (const f of tracked.filter((f) => f.endsWith(".json"))) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (USAGE_KEYS.test(text) && ID_KEYS.test(text)) {
    problems.push(`${f}: transcript-shaped JSON (usage counters + session/message ids)`);
  }
}

if (problems.length) {
  console.error("Transcript tripwire FAILED:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  console.error("\nReal usage data must never enter this repository. Synthesize fixtures in code.");
  process.exit(1);
}
console.log(`Transcript tripwire clean: ${tracked.length} tracked files checked.`);
