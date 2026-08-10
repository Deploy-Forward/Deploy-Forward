/**
 * Gemini CLI (Google) capture tests — Lane L14 (landscape Tier 1).
 *
 * RED by construction: these import tracker/src/gemini.ts, which the code-author has
 * not written yet, so the whole file fails at import until the adapter lands. Every
 * assertion below is the SPEC the adapter must satisfy.
 *
 * PROVENANCE: the fixture SHAPE is derived from a REAL on-disk Gemini CLI store found
 * on the dev machine (discovery 2026-07-23, models gemini-3-pro-preview /
 * gemini-3-flash-preview). Every fixture here is SYNTHESIZED and SANITIZED from that
 * shape — no real transcript bytes, no real paths, no thought text is copied in. The
 * real store confirmed the two LOCKED vendor semantics this suite pins:
 *   - tokens.total === input + output + thoughts + tool  (verified: 45242+3101+333+0=48676)
 *   - tokens.cached < tokens.input  (cached is a SUBSET of the prompt; verified every msg)
 *
 * On-disk layout (derived):
 *   <home>/tmp/<projectDir>/chats/session-<name>.json   — ONE JSON object = ONE session
 *   <home>/tmp/<projectDir>/.project_root               — the cwd (repoHash input)
 * Session JSON: { sessionId, projectHash, startTime, lastUpdated, messages: [...] }.
 * A "gemini"-type message carries { model, tokens:{input,output,cached,thoughts,tool,
 * total}, thoughts:[{subject,description}], toolCalls }. "user" messages are turns;
 * "info"/"error" are plumbing (no tokens).
 *
 * HERMETICITY: corpus-level tests point GEMINI_CLI_HOME/DF_GEMINI_HOME (and pass an
 * explicit home) at a mkdtemp fixture dir. The real ~/.gemini is NEVER read here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseGeminiSessionFile,
  isOfficialGeminiCli,
  geminiHome,
  geminiSessionFiles,
  scanGeminiCorpus,
  summarizeGeminiCorpus,
} from "../src/gemini.ts";
import type { TrackerState } from "../src/config.ts";

const STATE = { repoHmacKey: "test-key", gapMs: 5 * 60_000 } as unknown as TrackerState;

// ---------------------------------------------------------------------------
// Fixture builders — shape-faithful to the real store, fully synthetic content
// ---------------------------------------------------------------------------

interface Tok {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
}

/** A "gemini" (assistant) message. `total` defaults to the vendor identity
 *  input+output+thoughts+tool so fixtures stay honest to the real invariant. */
function geminiMsg(o: {
  id: string;
  ts: string;
  model?: string;
  tokens?: Tok;
  thoughtsList?: number; // how many {subject,description} entries to synthesize
  omitTokens?: boolean; // drop the whole `tokens` object (broken/partial write)
  renameTokens?: boolean; // write the counts under `usage` instead of `tokens` (drift)
}): Record<string, unknown> {
  const t = o.tokens ?? {};
  const input = t.input ?? 0;
  const output = t.output ?? 0;
  const cached = t.cached ?? 0;
  const thoughts = t.thoughts ?? 0;
  const tool = t.tool ?? 0;
  const tokensObj = { input, output, cached, thoughts, tool, total: input + output + thoughts + tool };
  const msg: Record<string, unknown> = { id: o.id, timestamp: o.ts, type: "gemini" };
  if (o.model !== undefined) msg.model = o.model;
  // The message-level `thoughts` LIST (summaries) is a DIFFERENT field from the numeric
  // tokens.thoughts — the adapter must never confuse the two. Synthesize a short list.
  if (o.thoughtsList) {
    msg.thoughts = Array.from({ length: o.thoughtsList }, (_, i) => ({
      subject: `synthetic-subject-${i}`,
      description: `synthetic reasoning summary ${i}`,
    }));
  }
  msg.toolCalls = [];
  if (o.renameTokens) msg.usage = tokensObj; // counts moved to a renamed field -> drift
  else if (!o.omitTokens) msg.tokens = tokensObj;
  return msg;
}

function userMsg(o: { id: string; ts: string }): Record<string, unknown> {
  return { id: o.id, timestamp: o.ts, type: "user", content: "synthetic user prompt" };
}

function infoMsg(o: { id: string; ts: string }): Record<string, unknown> {
  return { id: o.id, timestamp: o.ts, type: "info", content: "Authentication succeeded\n" };
}

function sessionJson(o: {
  sessionId: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  messages: Record<string, unknown>[];
}): string {
  return JSON.stringify({
    sessionId: o.sessionId,
    projectHash: o.projectHash ?? "a".repeat(64),
    startTime: o.startTime ?? o.messages[0]?.timestamp ?? "2026-02-22T03:20:00.000Z",
    lastUpdated: o.lastUpdated ?? o.messages[o.messages.length - 1]?.timestamp ?? "2026-02-22T03:21:00.000Z",
    messages: o.messages,
  });
}

/** Write a session file into <home>/tmp/<projectDir>/chats/, plus an optional
 *  sibling .project_root carrying the cwd. Returns the session file path. */
function writeSession(
  home: string,
  projectDir: string,
  fileName: string,
  json: string,
  projectRoot?: string,
): string {
  const chats = join(home, "tmp", projectDir, "chats");
  mkdirSync(chats, { recursive: true });
  const p = join(chats, fileName);
  writeFileSync(p, json);
  if (projectRoot !== undefined) {
    writeFileSync(join(home, "tmp", projectDir, ".project_root"), projectRoot);
  }
  return p;
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "gemini-fix-"));
}

// ===========================================================================
// parseGeminiSessionFile — pure, no filesystem
// ===========================================================================

test("cached is a SUBSET of input: fresh input = input - cached, conserving the prompt (LOCKED semantic 1)", () => {
  const content = sessionJson({
    sessionId: "sess-cached",
    messages: [
      userMsg({ id: "u1", ts: "2026-02-22T03:20:00.000Z" }),
      geminiMsg({
        id: "g1",
        ts: "2026-02-22T03:20:10.000Z",
        model: "gemini-3-pro-preview",
        tokens: { input: 1000, output: 51, cached: 800, thoughts: 120 },
      }),
    ],
  });
  const atoms = parseGeminiSessionFile(content);
  assert.equal(atoms.usage.length, 1);
  const tk = atoms.usage[0].tokens;
  assert.equal(tk.input, 200, "fresh input = prompt(1000) - cached(800)");
  assert.equal(tk.cacheRead, 800, "cached maps to cacheRead");
  assert.equal(tk.cacheCreation, 0, "Gemini logs no cache-write counter — absence stays absent");
  assert.equal(tk.input + tk.cacheRead, 1000, "fresh + cacheRead conserves the original prompt (never double-charged)");
});

test("cached > prompt clamps fresh input to 0 and never over-counts the prompt (LOCKED semantic 1, clamp)", () => {
  const content = sessionJson({
    sessionId: "sess-clamp",
    messages: [
      geminiMsg({
        id: "g1",
        ts: "2026-02-22T03:20:10.000Z",
        model: "gemini-3-flash-preview",
        tokens: { input: 200, output: 33, cached: 500 },
      }),
    ],
  });
  const atoms = parseGeminiSessionFile(content);
  const tk = atoms.usage[0].tokens;
  assert.equal(tk.input, 0, "fresh input clamps to >= 0 when cached exceeds the prompt");
  assert.ok(tk.cacheRead <= 200, "cacheRead never exceeds the prompt (cached is a subset of it)");
  assert.equal(tk.input + tk.cacheRead, 200, "the prompt total is conserved, never inflated past 200");
});

test("thoughts tokens are STATUS-ONLY: they go to thinkingTokens, never into output, never priced (LOCKED semantic 2)", () => {
  const content = sessionJson({
    sessionId: "sess-think",
    messages: [
      geminiMsg({
        id: "g1",
        ts: "2026-02-22T03:20:10.000Z",
        model: "gemini-3-pro-preview",
        // thoughtsList (the summary array) has length 2, but tokens.thoughts is 1654:
        // the adapter must read the NUMERIC count, not the list length.
        tokens: { input: 900, output: 51, cached: 100, thoughts: 1654 },
        thoughtsList: 2,
      }),
      geminiMsg({
        id: "g2",
        ts: "2026-02-22T03:20:20.000Z",
        model: "gemini-3-pro-preview",
        tokens: { input: 900, output: 38, cached: 100, thoughts: 230 },
      }),
    ],
  });
  const atoms = parseGeminiSessionFile(content);
  assert.equal(atoms.thinkingTokens, 1654 + 230, "tokens.thoughts sums into thinkingTokens (status-only)");
  assert.equal(atoms.usage[0].tokens.output, 51, "output is the raw vendor output — thoughts are NOT added to it");
  assert.equal(atoms.usage[1].tokens.output, 38, "output stays clean of thoughts on every message");
});

test("per-message series is model-resolved and TS-SORTED for sessionMue, regardless of file order", () => {
  // Deliberately write messages out of chronological order; the parser must sort the
  // usage series ascending by ts (the ordering sessionMue/occupancy depend on).
  const content = sessionJson({
    sessionId: "sess-order",
    messages: [
      geminiMsg({ id: "g2", ts: "2026-02-22T03:20:20.000Z", model: "gemini-3-pro-preview", tokens: { input: 100, output: 10 } }),
      geminiMsg({ id: "g1", ts: "2026-02-22T03:20:10.000Z", model: "gemini-3-pro-preview", tokens: { input: 100, output: 10 } }),
      geminiMsg({ id: "g3", ts: "2026-02-22T03:20:30.000Z", model: "gemini-3-pro-preview", tokens: { input: 100, output: 10 } }),
    ],
  });
  const atoms = parseGeminiSessionFile(content);
  const ts = atoms.usage.map((u) => u.ts);
  const sorted = [...ts].sort((a, b) => a - b);
  assert.deepEqual(ts, sorted, "usage atoms are sorted ascending by ts before they feed sessionMue");
  assert.ok(atoms.usage.every((u) => u.model === "gemini-3-pro-preview"), "each atom carries its own message.model verbatim");
});

test("model id is extracted verbatim per message (no normalization of the -preview suffix)", () => {
  const content = sessionJson({
    sessionId: "sess-models",
    messages: [
      geminiMsg({ id: "g1", ts: "2026-02-22T03:20:10.000Z", model: "gemini-3-pro-preview", tokens: { input: 100, output: 10 } }),
      geminiMsg({ id: "g2", ts: "2026-02-22T03:20:20.000Z", model: "gemini-3-flash-preview", tokens: { input: 100, output: 10 } }),
    ],
  });
  const atoms = parseGeminiSessionFile(content);
  assert.equal(atoms.usage[0].model, "gemini-3-pro-preview");
  assert.equal(atoms.usage[1].model, "gemini-3-flash-preview");
  assert.equal(atoms.sessionId, "sess-models", "top-level sessionId is captured as the session key");
});

test("REAL counters only: a gemini message whose tokens object was RENAMED counts as drift, credits nothing", () => {
  const content = sessionJson({
    sessionId: "sess-drift",
    messages: [
      geminiMsg({ id: "g1", ts: "2026-02-22T03:20:10.000Z", model: "gemini-3-pro-preview", tokens: { input: 100, output: 10 } }),
      // tokens moved under `usage` — the silent-zero failure mode the counter exists to catch.
      geminiMsg({ id: "g2", ts: "2026-02-22T03:20:20.000Z", model: "gemini-3-pro-preview", tokens: { input: 500, output: 50 }, renameTokens: true }),
      // a partial write with no counts at all — also drift, never estimated.
      geminiMsg({ id: "g3", ts: "2026-02-22T03:20:30.000Z", model: "gemini-3-pro-preview", omitTokens: true }),
    ],
  });
  const atoms = parseGeminiSessionFile(content);
  assert.equal(atoms.usage.length, 1, "only the well-formed gemini message is credited");
  assert.equal(atoms.unknownLines, 2, "the renamed-token and the token-less gemini messages both count as drift");
  assert.ok(atoms.totalLines >= 3, "every gemini-message candidate counts toward the drift denominator");
});

test("a corrupt (unparseable) session file is one drift unit, never throws", () => {
  const atoms = parseGeminiSessionFile("not valid json at all {{{");
  assert.equal(atoms.usage.length, 0);
  assert.equal(atoms.sessionId, null);
  assert.ok(atoms.unknownLines >= 1, "a whole-file parse failure registers as drift");
});

// ===========================================================================
// scanGeminiCorpus / discovery — hermetic (fixture home only)
// ===========================================================================

test("scanGeminiCorpus: cwd comes from .project_root and drives repoHash", () => {
  const home = freshHome();
  try {
    writeSession(
      home,
      "proj-a",
      "session-2026-02-22T03-20-abc.json",
      sessionJson({
        sessionId: "11111111-2222-3333-4444-555555555555",
        messages: [
          userMsg({ id: "u1", ts: "2026-02-22T03:20:00.000Z" }),
          geminiMsg({ id: "g1", ts: "2026-02-22T03:20:10.000Z", model: "gemini-3-pro-preview", tokens: { input: 1000, output: 51, cached: 800, thoughts: 120 } }),
        ],
      }),
      "/home/dev/proj-a",
    );
    const scan = scanGeminiCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    const s = scan.sessions[0];
    assert.equal(s.tool, "gemini");
    assert.equal(s.toolSessionId, "11111111-2222-3333-4444-555555555555");
    assert.equal(s.cwd, "/home/dev/proj-a", "cwd is read from the sibling .project_root");
    assert.ok(s.repoHash, "repoHash is derived from basename(cwd), non-null");
    assert.equal(s.model, "gemini-3-pro-preview");
    assert.equal(s.thinkingTokens, 120, "session thinkingTokens carries the status-only thought count");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanGeminiCorpus: a session dir with no .project_root has cwd undefined and repoHash null (honest absence)", () => {
  const home = freshHome();
  try {
    writeSession(
      home,
      "proj-noroot",
      "session-x.json",
      sessionJson({
        sessionId: "sess-noroot",
        messages: [geminiMsg({ id: "g1", ts: "2026-02-22T03:20:10.000Z", model: "gemini-3-pro-preview", tokens: { input: 100, output: 10 } })],
      }),
      // no projectRoot argument -> no .project_root written
    );
    const scan = scanGeminiCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.sessions[0].repoHash, null);
    assert.equal(scan.sessions[0].cwd, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanGeminiCorpus: per-model token buckets sum EXACTLY to the session total (identity)", () => {
  const home = freshHome();
  try {
    writeSession(
      home,
      "proj-mix",
      "session-mix.json",
      sessionJson({
        sessionId: "sess-mix",
        messages: [
          geminiMsg({ id: "g1", ts: "2026-02-22T03:20:10.000Z", model: "gemini-3-pro-preview", tokens: { input: 1000, output: 50, cached: 200 } }),
          geminiMsg({ id: "g2", ts: "2026-02-22T03:20:20.000Z", model: "gemini-3-flash-preview", tokens: { input: 800, output: 40, cached: 100 } }),
        ],
      }),
      "/home/dev/proj-mix",
    );
    const [s] = scanGeminiCorpus(STATE, home).sessions;
    assert.equal(s.models.length, 2, "two distinct model ids -> two buckets");
    const sum = s.models.reduce(
      (a, m) => ({
        input: a.input + m.input,
        output: a.output + m.output,
        cacheRead: a.cacheRead + m.cacheRead,
        cacheCreation: a.cacheCreation + m.cacheCreation,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    );
    assert.deepEqual(sum, s.tokens, "model buckets are the single source of truth for the session total");
    // fresh: (1000-200) + (800-100) = 1500; cacheRead: 200 + 100 = 300; output: 90
    assert.equal(s.tokens.input, 1500);
    assert.equal(s.tokens.cacheRead, 300);
    assert.equal(s.tokens.output, 90);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("session boundary + dedupe: the same sessionId in two files folds to ONE session (stable key)", () => {
  const home = freshHome();
  try {
    const msgs = [geminiMsg({ id: "g1", ts: "2026-02-22T03:20:10.000Z", model: "gemini-3-pro-preview", tokens: { input: 100, output: 10 } })];
    writeSession(home, "proj-a", "session-copy1.json", sessionJson({ sessionId: "dup-sess", messages: msgs }), "/home/dev/proj-a");
    // A copied tree: same sessionId under a different project dir/file.
    writeSession(home, "proj-a-copy", "session-copy2.json", sessionJson({ sessionId: "dup-sess", messages: msgs }), "/home/dev/proj-a");
    const scan = scanGeminiCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1, "one toolSessionId -> one uploaded session, never two racing digests");
    assert.equal(scan.sessions[0].toolSessionId, "dup-sess");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanGeminiCorpus: sessions with >= 8 output-bearing messages carry a MUE exponent (the sessionMue seam is wired)", () => {
  const home = freshHome();
  try {
    const messages: Record<string, unknown>[] = [];
    for (let i = 0; i < 9; i++) {
      messages.push(
        geminiMsg({
          id: `g${i}`,
          ts: `2026-02-22T03:${String(20 + i).padStart(2, "0")}:10.000Z`,
          model: "gemini-3-pro-preview",
          // growing context each turn so the log-log fit has real points
          tokens: { input: 1000 * (i + 1), output: 50, cached: 100 * i },
        }),
      );
    }
    writeSession(home, "proj-mue", "session-mue.json", sessionJson({ sessionId: "sess-mue", messages }), "/home/dev/proj-mue");
    const [s] = scanGeminiCorpus(STATE, home).sessions;
    assert.ok(s.mue, "a 9-message session is long enough for an MUE exponent (sessionMue was called on the series)");
    assert.equal(s.mue?.points, 9, "every output-bearing main-thread message is a fit point");
    assert.ok(s.context, "lastNonzeroOccupancy is wired: the session carries a context occupancy read");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("geminiSessionFiles discovers files under tmp/<dir>/chats and skips non-chat residents", () => {
  const home = freshHome();
  try {
    writeSession(home, "proj-a", "session-1.json", sessionJson({ sessionId: "a", messages: [] }), "/home/dev/proj-a");
    writeSession(home, "proj-b", "session-2.json", sessionJson({ sessionId: "b", messages: [] }), "/home/dev/proj-b");
    // a stray non-chat file at the tmp root must not be mistaken for a session
    mkdirSync(join(home, "tmp", "bin"), { recursive: true });
    writeFileSync(join(home, "tmp", "bin", "rg.exe"), "binary");
    const files = geminiSessionFiles(home);
    assert.equal(files.length, 2, "exactly the two chats/*.json files are discovered");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ===========================================================================
// Fingerprint — must refuse a non-gemini store
// ===========================================================================

test("isOfficialGeminiCli: true for a real-shaped gemini store", () => {
  const home = freshHome();
  try {
    writeSession(
      home,
      "proj-a",
      "session-1.json",
      sessionJson({
        sessionId: "fp-ok",
        messages: [geminiMsg({ id: "g1", ts: "2026-02-22T03:20:10.000Z", model: "gemini-3-pro-preview", tokens: { input: 100, output: 10 } })],
      }),
      "/home/dev/proj-a",
    );
    assert.equal(isOfficialGeminiCli(home), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("isOfficialGeminiCli: FALSE for a non-gemini store (fingerprint refusal)", () => {
  const home = freshHome();
  try {
    // A pi-style JSONL session header masquerading in a chats-like tree: NOT the
    // documented Gemini session-object shape (no sessionId + messages array), so the
    // gemini fingerprint must refuse it — we never guess which product wrote a file.
    const chats = join(home, "tmp", "--home-dev-proj--", "chats");
    mkdirSync(chats, { recursive: true });
    writeFileSync(join(chats, "notgemini.json"), JSON.stringify({ type: "session", version: 3, id: "x", cwd: "/p" }));
    assert.equal(isOfficialGeminiCli(home), false, "a store without the Gemini session shape is refused");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("isOfficialGeminiCli: FALSE for an empty / absent home", () => {
  const home = freshHome();
  try {
    assert.equal(isOfficialGeminiCli(home), false, "an empty home has no gemini session to fingerprint");
    assert.equal(isOfficialGeminiCli(join(home, "does-not-exist")), false, "a missing home never throws, returns false");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("summarizeGeminiCorpus is a thin wrapper returning just the sessions", () => {
  const home = freshHome();
  try {
    writeSession(
      home,
      "proj-a",
      "session-1.json",
      sessionJson({
        sessionId: "wrap-sess",
        messages: [geminiMsg({ id: "g1", ts: "2026-02-22T03:20:10.000Z", model: "gemini-3-pro-preview", tokens: { input: 100, output: 10 } })],
      }),
      "/home/dev/proj-a",
    );
    const sessions = summarizeGeminiCorpus(STATE, home);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].toolSessionId, "wrap-sess");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ===========================================================================
// Env override convention (DF_-prefixed primary, GEMINI_CLI_HOME accepted)
// ===========================================================================

test("geminiHome honors DF_GEMINI_HOME and GEMINI_CLI_HOME overrides (hermeticity idiom)", () => {
  const savedDf = process.env.DF_GEMINI_HOME;
  const savedCli = process.env.GEMINI_CLI_HOME;
  try {
    delete process.env.DF_GEMINI_HOME;
    process.env.GEMINI_CLI_HOME = "/tmp/fixture-cli-home";
    assert.equal(geminiHome(), "/tmp/fixture-cli-home", "GEMINI_CLI_HOME override (the named env var) is honored");
    process.env.DF_GEMINI_HOME = "/tmp/fixture-df-home";
    assert.equal(geminiHome(), "/tmp/fixture-df-home", "the DF_-prefixed override wins, matching DF_PI_HOME/DF_GROK_HOME convention");
  } finally {
    if (savedDf === undefined) delete process.env.DF_GEMINI_HOME;
    else process.env.DF_GEMINI_HOME = savedDf;
    if (savedCli === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = savedCli;
  }
});
