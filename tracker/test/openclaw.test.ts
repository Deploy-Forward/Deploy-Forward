/**
 * OpenClaw capture tests (W2.2, docs/harness-adapters-implementation.md §2; re-based
 * onto JSONL 2026-07-14 after the SQLite/database-first premise was disproved against
 * a real 2026.7.1 corpus -- see src/openclaw.ts's header for the verified finding).
 *
 * Every fixture is a SYNTHESIZED JSONL file, matching the verbatim on-disk shape
 * documented in src/openclaw.ts's header (session header + message entries) -- no
 * real `~/.openclaw` install is read here. Every corpus-level test sets
 * DF_OPENCLAW_HOME to a temp fixture dir (hermeticity); the pure-function tests
 * (normalizeOpenClawUsage, parseOpenClawSessionEvents, parseOpenClawSessionFile) take
 * data/content directly and touch no filesystem at all (parseOpenClawSessionFile takes
 * an explicit mtime fallback argument instead of statting a real file).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeOpenClawUsage,
  parseOpenClawSessionEvents,
  parseOpenClawSessionFile,
  isOfficialOpenClawCli,
  scanOpenClawCorpus,
  summarizeOpenClawCorpus,
  openclawSessionFiles,
  openclawHome,
  type OpenClawEventRow,
} from "../src/openclaw.ts";
import { computeActivity, sliceActivityByDay } from "../src/activity.ts";
import type { TrackerState } from "../src/config.ts";

const STATE = { repoHmacKey: "test-key", gapMs: 5 * 60_000 } as unknown as TrackerState;

// ---------------------------------------------------------------------------
// Fixture line builders -- pure JSON-line shapes, transport-agnostic (they never
// touched SQLite even before this migration; only the file-writing plumbing below is
// new).
// ---------------------------------------------------------------------------

function sessionEvent(o: { id: string; ts: string; cwd?: string | null }): string {
  return JSON.stringify({ type: "session", version: 3, id: o.id, parentId: null, timestamp: o.ts, cwd: o.cwd ?? null });
}

function userEvent(o: { id: string; parentId?: string; ts: string }): string {
  return JSON.stringify({
    type: "message",
    id: o.id,
    parentId: o.parentId ?? null,
    timestamp: o.ts,
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  });
}

function assistantEvent(o: {
  id: string;
  parentId?: string;
  ts: string;
  provider?: string;
  model?: string;
  usage?: Record<string, unknown>;
  omitUsage?: boolean;
}): string {
  const message: Record<string, unknown> = { role: "assistant" };
  if (o.provider !== undefined) message.provider = o.provider;
  if (o.model !== undefined) message.model = o.model;
  if (!o.omitUsage) message.usage = o.usage ?? {};
  return JSON.stringify({ type: "message", id: o.id, parentId: o.parentId ?? null, timestamp: o.ts, message });
}

function toolResultEvent(o: { id: string; parentId?: string; ts: string; toolCallId?: string }): string {
  return JSON.stringify({
    type: "message",
    id: o.id,
    parentId: o.parentId ?? null,
    timestamp: o.ts,
    message: { role: "toolResult", toolCallId: o.toolCallId ?? "call-1", toolName: "bash", isError: false, content: [{ type: "toolResult", text: "ok" }] },
  });
}

function usageObj(o: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoningTokens?: number;
}): Record<string, unknown> {
  return {
    input: o.input ?? 0,
    output: o.output ?? 0,
    cacheRead: o.cacheRead ?? 0,
    cacheWrite: o.cacheWrite ?? 0,
    totalTokens: (o.input ?? 0) + (o.output ?? 0),
    ...(o.reasoningTokens !== undefined ? { reasoningTokens: o.reasoningTokens } : {}),
  };
}

/** Write one session file under agents/<agentId>/sessions/<sessionId>.jsonl -- the
 * real on-disk layout (src/openclaw.ts's header). Returns the file path. */
function writeSessionFile(home: string, agentId: string, sessionId: string, lines: string[]): string {
  const dir = join(home, "agents", agentId, "sessions");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(filePath, lines.join("\n"));
  return filePath;
}

// ---------------------------------------------------------------------------
// normalizeOpenClawUsage -- pure alias-resolution, no filesystem. UNCHANGED by the
// JSONL migration (this logic never touched SQLite); ported verbatim.
// ---------------------------------------------------------------------------

test("normalizeOpenClawUsage: Anthropic-native shape (input/output/cacheRead/cacheWrite)", () => {
  const u = normalizeOpenClawUsage({ input: 100, output: 50, cacheRead: 20, cacheWrite: 5 });
  assert.deepEqual(u, { input: 100, output: 50, cacheRead: 20, cacheWrite: 5, reasoningTokens: undefined, total: undefined });
});

test("normalizeOpenClawUsage: OpenAI-native shape subtracts cached tokens from prompt total", () => {
  // prompt_tokens INCLUDES the cached portion (OpenAI convention) -- input must be
  // net of cache, mirroring grok.ts's identical prompt/cached-tokens convention.
  const u = normalizeOpenClawUsage({
    prompt_tokens: 120,
    completion_tokens: 40,
    prompt_tokens_details: { cached_tokens: 20 },
  });
  assert.equal(u?.input, 100, "120 prompt_tokens - 20 cached = 100 net input");
  assert.equal(u?.output, 40);
  assert.equal(u?.cacheRead, 20);
});

test("normalizeOpenClawUsage: reasoning-token aliases resolve (completion_tokens_details.reasoning_tokens)", () => {
  const u = normalizeOpenClawUsage({
    input: 10,
    output: 20,
    completion_tokens_details: { reasoning_tokens: 7 },
  });
  assert.equal(u?.reasoningTokens, 7);
});

test("normalizeOpenClawUsage: totalTokens-only record resolves total but leaves input/output undefined", () => {
  const u = normalizeOpenClawUsage({ totalTokens: 500 });
  assert.equal(u?.total, 500);
  assert.equal(u?.input, undefined);
  assert.equal(u?.output, undefined);
});

test("normalizeOpenClawUsage: empty/non-object usage -> undefined", () => {
  assert.equal(normalizeOpenClawUsage(null), undefined);
  assert.equal(normalizeOpenClawUsage({}), undefined);
  assert.equal(normalizeOpenClawUsage([1, 2]), undefined);
});

// ---------------------------------------------------------------------------
// parseOpenClawSessionEvents -- pure, no filesystem. UNCHANGED by the JSONL
// migration (identical logic whether rows come from a DB or a file); ported verbatim
// -- these tests build OpenClawEventRow[] literals directly, exactly as before.
// ---------------------------------------------------------------------------

test("parseOpenClawSessionEvents: header/user/assistant tree, real tokens, reasoning tokens, drift rails", () => {
  const rows: OpenClawEventRow[] = [
    { seq: 0, eventJson: sessionEvent({ id: "hdr", ts: "2026-07-01T10:00:00.000Z" }), createdAt: 0 },
    { seq: 1, eventJson: userEvent({ id: "u1", parentId: "hdr", ts: "2026-07-01T10:00:01.000Z" }), createdAt: 0 },
    {
      seq: 2,
      eventJson: assistantEvent({
        id: "a1",
        parentId: "u1",
        ts: "2026-07-01T10:00:10.000Z",
        provider: "anthropic",
        model: "model-a",
        usage: usageObj({ input: 100, output: 50, cacheRead: 20, cacheWrite: 5, reasoningTokens: 3 }),
      }),
      createdAt: 0,
    },
    // Known type, no tokens -- must NOT be counted as unknown.
    { seq: 3, eventJson: JSON.stringify({ type: "compaction", id: "c1", parentId: "a1", timestamp: "2026-07-01T10:00:11.000Z", firstKeptEntryId: "a1", tokensBefore: 500 }), createdAt: 0 },
    // Unrecognized top-level type -- counted, skipped.
    { seq: 4, eventJson: JSON.stringify({ type: "some_future_entry", id: "z1", timestamp: "2026-07-01T10:00:12.000Z" }), createdAt: 0 },
    // Malformed JSON -- counted, skipped, never aborts the session.
    { seq: 5, eventJson: "not json at all {{{", createdAt: 0 },
    // Assistant message with NO usage object at all -- skipped, never estimated.
    { seq: 6, eventJson: assistantEvent({ id: "a2", ts: "2026-07-01T10:00:20.000Z", model: "model-a", omitUsage: true }), createdAt: 0 },
    // Delivery-mirror synthetic entry -- excluded from messageCount, never credited,
    // even though it structurally looks like an assistant message.
    {
      seq: 7,
      eventJson: assistantEvent({
        id: "dm1",
        ts: "2026-07-01T10:00:25.000Z",
        provider: "openclaw",
        model: "delivery-mirror",
        usage: usageObj({ input: 999, output: 999 }),
      }),
      createdAt: 0,
    },
    // A trailing valid entry proves the malformed line didn't abort the parse.
    {
      seq: 8,
      eventJson: assistantEvent({
        id: "a3",
        ts: "2026-07-01T10:00:30.000Z",
        provider: "anthropic",
        model: "model-a",
        usage: usageObj({ input: 10, output: 5 }),
      }),
      createdAt: 0,
    },
  ];

  const atoms = parseOpenClawSessionEvents(rows);
  assert.equal(atoms.totalLines, 9);
  // Drift: one unrecognized type + one malformed line + one usage-less assistant message.
  assert.equal(atoms.unknownLines, 3);
  assert.equal(atoms.humanPromptTimestamps.length, 1);
  // messageCount: a1, a2, a3 -- NOT the delivery-mirror entry.
  assert.equal(atoms.messageCount, 3);
  assert.equal(atoms.usage.length, 2, "only a1 and a3 resolved real input+output pairs");
  assert.deepEqual(atoms.usage[0].tokens, { input: 100, output: 50, cacheRead: 20, cacheCreation: 5 });
  assert.equal(atoms.usage[0].model, "model-a");
  assert.equal(atoms.usage[0].reasoningTokens, 3);
  assert.deepEqual(atoms.usage[1].tokens, { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 });
  assert.equal(atoms.usage[1].reasoningTokens, 0);
});

test("parseOpenClawSessionEvents: totalTokens-only assistant usage is skipped and counted as drift", () => {
  const rows: OpenClawEventRow[] = [
    { seq: 0, eventJson: assistantEvent({ id: "a1", ts: "2026-07-01T10:00:00.000Z", model: "model-a", usage: { totalTokens: 5000 } }), createdAt: 0 },
    { seq: 1, eventJson: assistantEvent({ id: "a2", ts: "2026-07-01T10:00:05.000Z", model: "model-a", usage: usageObj({ input: 1, output: 1 }) }), createdAt: 0 },
  ];
  const atoms = parseOpenClawSessionEvents(rows);
  assert.equal(atoms.usage.length, 1, "the totalTokens-only record never contributes a fabricated split");
  assert.equal(atoms.unknownLines, 1);
  assert.equal(atoms.messageCount, 2, "both assistant messages were OBSERVED even though one had no usable usage");
});

test("parseOpenClawSessionEvents: falls back to the row's created_at when the JSON timestamp is unparseable", () => {
  const rows: OpenClawEventRow[] = [
    {
      seq: 0,
      eventJson: JSON.stringify({ type: "message", id: "a1", parentId: null, timestamp: "not-a-date", message: { role: "assistant", model: "m", usage: usageObj({ input: 1, output: 1 }) } }),
      createdAt: 1720000000000,
    },
  ];
  const atoms = parseOpenClawSessionEvents(rows);
  assert.equal(atoms.usage[0].ts, 1720000000000);
  assert.equal(atoms.timestamps[0], 1720000000000);
});

test("parseOpenClawSessionEvents: toolResult role is known plumbing -- no tokens, never counted as drift", () => {
  const rows: OpenClawEventRow[] = [
    { seq: 0, eventJson: userEvent({ id: "u1", ts: "2026-07-14T10:00:00.000Z" }), createdAt: 0 },
    {
      seq: 1,
      eventJson: assistantEvent({ id: "tc1", ts: "2026-07-14T10:00:01.000Z", provider: "openai", model: "gpt-5.6-sol", usage: usageObj({ input: 0, output: 0 }) }),
      createdAt: 0,
    },
    { seq: 2, eventJson: toolResultEvent({ id: "tr1", ts: "2026-07-14T10:00:02.000Z" }), createdAt: 0 },
    {
      seq: 3,
      eventJson: assistantEvent({ id: "af1", ts: "2026-07-14T10:00:03.000Z", provider: "openai", model: "gpt-5.6-sol", usage: usageObj({ input: 50, output: 10 }) }),
      createdAt: 0,
    },
  ];
  const atoms = parseOpenClawSessionEvents(rows);
  assert.equal(atoms.unknownLines, 0, "toolResult is known plumbing, not drift");
  assert.equal(atoms.messageCount, 2, "toolResult is not counted as an assistant message");
  assert.equal(atoms.usage.length, 2, "the all-zero tool-call turn still resolves a real (zero) usage atom -- see the known capture limit");
});

// ---------------------------------------------------------------------------
// parseOpenClawSessionFile -- pure, no filesystem. NEW: builds OpenClawEventRow[]
// from file CONTENT (line splitting + the mtime fallback) and extracts session
// id/cwd from the header line -- the two things that used to come from the SQL
// `sessions`/`session_entries` tables and now come from the transcript itself.
// ---------------------------------------------------------------------------

test("parseOpenClawSessionFile: header id/cwd extraction, blank lines never counted, delegates token parsing unchanged", () => {
  const content = [
    "", // a blank line -- must never be counted
    sessionEvent({ id: "sess-1", ts: "2026-07-01T10:00:00.000Z", cwd: "/home/m/proj" }),
    "   ", // whitespace-only -- also skipped
    userEvent({ id: "u1", ts: "2026-07-01T10:00:01.000Z" }),
    assistantEvent({ id: "a1", ts: "2026-07-01T10:00:10.000Z", provider: "anthropic", model: "model-a", usage: usageObj({ input: 100, output: 50 }) }),
  ].join("\n");
  const atoms = parseOpenClawSessionFile(content, 0);
  assert.equal(atoms.sessionId, "sess-1");
  assert.equal(atoms.cwd, "/home/m/proj");
  assert.equal(atoms.totalLines, 3, "blank/whitespace-only lines are never counted");
  assert.equal(atoms.usage.length, 1);
  assert.deepEqual(atoms.usage[0].tokens, { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 });
});

test("parseOpenClawSessionFile: no header line -> sessionId/cwd are null, never guessed", () => {
  const content = [assistantEvent({ id: "a1", ts: "2026-07-01T10:00:00.000Z", model: "m", usage: usageObj({ input: 1, output: 1 }) })].join("\n");
  const atoms = parseOpenClawSessionFile(content, 0);
  assert.equal(atoms.sessionId, null);
  assert.equal(atoms.cwd, null);
});

test("parseOpenClawSessionFile: header with cwd:null -> cwd stays null (present header, absent cwd)", () => {
  const content = [sessionEvent({ id: "sess-nocwd", ts: "2026-07-01T10:00:00.000Z", cwd: null })].join("\n");
  const atoms = parseOpenClawSessionFile(content, 0);
  assert.equal(atoms.sessionId, "sess-nocwd");
  assert.equal(atoms.cwd, null);
});

test("parseOpenClawSessionFile: an entry with an unparseable timestamp falls back to the mtime argument", () => {
  const mtimeMs = 1720000000000;
  const content = [
    JSON.stringify({ type: "message", id: "a1", parentId: null, timestamp: "not-a-date", message: { role: "assistant", model: "m", usage: usageObj({ input: 1, output: 1 }) } }),
  ].join("\n");
  const atoms = parseOpenClawSessionFile(content, mtimeMs);
  assert.equal(atoms.usage[0].ts, mtimeMs);
  assert.equal(atoms.timestamps[0], mtimeMs);
});

// ---------------------------------------------------------------------------
// isOfficialOpenClawCli -- structural fingerprint against the real JSONL tree.
// Re-based off the SQLite schema_meta/role check (moot: those tables don't exist).
// ---------------------------------------------------------------------------

test("isOfficialOpenClawCli: requires a session-file tree whose first line is a real {type:'session'} header with an id; no mark -> refuse", () => {
  const home = mkdtempSync(join(tmpdir(), "df-openclaw-"));
  try {
    writeSessionFile(home, "main", "sess-a", [sessionEvent({ id: "sess-a", ts: "2026-07-14T10:00:00.000Z", cwd: "/home/m/proj" })]);
    assert.equal(isOfficialOpenClawCli(home), true);

    // No agents/ dir at all -> refuse.
    const noAgents = mkdtempSync(join(tmpdir(), "df-openclaw-none-"));
    try {
      assert.equal(isOfficialOpenClawCli(noAgents), false);
    } finally {
      rmSync(noAgents, { recursive: true, force: true });
    }

    // agents/<id>/ exists but there is no sessions/ subdirectory at all -> refuse.
    const noSessions = mkdtempSync(join(tmpdir(), "df-openclaw-nosessions-"));
    try {
      mkdirSync(join(noSessions, "agents", "main"), { recursive: true });
      assert.equal(isOfficialOpenClawCli(noSessions), false);
    } finally {
      rmSync(noSessions, { recursive: true, force: true });
    }

    // sessions/ exists but the ONLY file present is a trajectory SIDECAR -- excluded
    // from discovery outright, so it can never anchor the fingerprint either.
    const onlyTrajectory = mkdtempSync(join(tmpdir(), "df-openclaw-onlytraj-"));
    try {
      const dir = join(onlyTrajectory, "agents", "main", "sessions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "sess-a.trajectory.jsonl"), sessionEvent({ id: "sess-a", ts: "2026-07-14T10:00:00.000Z" }));
      assert.equal(isOfficialOpenClawCli(onlyTrajectory), false);
    } finally {
      rmSync(onlyTrajectory, { recursive: true, force: true });
    }

    // A .jsonl file exists but its first line isn't a valid session header -> refuse.
    const badHeader = mkdtempSync(join(tmpdir(), "df-openclaw-badheader-"));
    try {
      writeSessionFile(badHeader, "main", "sess-b", [userEvent({ id: "u1", ts: "2026-07-14T10:00:00.000Z" })]);
      assert.equal(isOfficialOpenClawCli(badHeader), false);
    } finally {
      rmSync(badHeader, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("openclawHome: DF override wins, then the vendor's OPENCLAW_STATE_DIR, then ~/.openclaw", () => {
  const prevDf = process.env.DF_OPENCLAW_HOME;
  const prevVendor = process.env.OPENCLAW_STATE_DIR;
  try {
    process.env.DF_OPENCLAW_HOME = join(tmpdir(), "df-wins");
    process.env.OPENCLAW_STATE_DIR = join(tmpdir(), "vendor-loses");
    assert.equal(openclawHome(), join(tmpdir(), "df-wins"));

    // Without DF_OPENCLAW_HOME, the vendor's documented relocation env is honored —
    // official installs moved via OPENCLAW_STATE_DIR write THERE, not ~/.openclaw
    // (was a confirmed false negative before 2026-07-14).
    delete process.env.DF_OPENCLAW_HOME;
    assert.equal(openclawHome(), join(tmpdir(), "vendor-loses"));

    delete process.env.OPENCLAW_STATE_DIR;
    assert.ok(openclawHome().endsWith(".openclaw"));
  } finally {
    if (prevDf === undefined) delete process.env.DF_OPENCLAW_HOME;
    else process.env.DF_OPENCLAW_HOME = prevDf;
    if (prevVendor === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = prevVendor;
  }
});

// ---------------------------------------------------------------------------
// openclawSessionFiles -- discovery: excludes trajectory sidecars, the trajectory-path
// sidecar, the legacy sessions.json index, and subdirectories; sorts deterministically.
// ---------------------------------------------------------------------------

test("openclawSessionFiles: discovers per-agent session files, excludes trajectory sidecars and non-jsonl entries, sorts deterministically", () => {
  const home = mkdtempSync(join(tmpdir(), "df-openclaw-discovery-"));
  try {
    const dir = join(home, "agents", "main", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "b-sess.jsonl"), sessionEvent({ id: "b-sess", ts: "2026-07-14T10:00:00.000Z" }));
    writeFileSync(join(dir, "a-sess.jsonl"), sessionEvent({ id: "a-sess", ts: "2026-07-14T10:00:00.000Z" }));
    writeFileSync(join(dir, "a-sess.trajectory.jsonl"), "a different document, never parsed");
    writeFileSync(join(dir, "a-sess.trajectory-path.json"), "{}");
    writeFileSync(join(dir, "sessions.json"), "{}"); // legacy pointer index -- never a transcript
    mkdirSync(join(dir, "skills-prompts")); // a real-corpus subdirectory, never a session file

    const files = openclawSessionFiles(home);
    assert.deepEqual(
      files.map((f) => f.path.slice(dir.length + 1)),
      ["a-sess.jsonl", "b-sess.jsonl"],
      "trajectory sidecars, the legacy JSON index, and the subdirectory are all excluded; result is sorted",
    );
    assert.equal(files[0].agentId, "main");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scanOpenClawCorpus / summarizeOpenClawCorpus -- full fixture join
// ---------------------------------------------------------------------------

function buildFixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "df-openclaw-corpus-"));

  // Session A (agent "coder"): single-day, one model, cwd carried on the session header.
  writeSessionFile(home, "coder", "sess-aaa", [
    sessionEvent({ id: "sess-aaa", ts: "2026-07-01T10:00:00.000Z", cwd: "/home/m/proj" }),
    userEvent({ id: "u1", ts: "2026-07-01T10:00:01.000Z" }),
    assistantEvent({ id: "a1", ts: "2026-07-01T10:00:10.000Z", provider: "anthropic", model: "model-a", usage: usageObj({ input: 100, output: 50, cacheRead: 20, cacheWrite: 5 }) }),
    assistantEvent({ id: "a2", ts: "2026-07-01T10:01:00.000Z", provider: "anthropic", model: "model-a", usage: usageObj({ input: 10, output: 5 }) }),
  ]);

  // Session B (agent "coder" too, different session): header present but cwd:null,
  // spans a UTC midnight, switches model, carries drift (unknown type + malformed
  // line + one totalTokens-only assistant message).
  writeSessionFile(home, "coder", "sess-bbb", [
    sessionEvent({ id: "sess-bbb", ts: "2026-07-12T23:00:00.000Z", cwd: null }),
    userEvent({ id: "u2", ts: "2026-07-12T23:00:02.000Z" }),
    assistantEvent({ id: "b1", ts: "2026-07-12T23:00:10.000Z", provider: "anthropic", model: "model-a", usage: usageObj({ input: 1000, output: 200, cacheRead: 300, cacheWrite: 50 }) }),
    JSON.stringify({ type: "some_future_entry", id: "z1", timestamp: "2026-07-12T23:00:12.000Z" }),
    "not json at all {{{",
    assistantEvent({ id: "b2", ts: "2026-07-13T00:00:10.000Z", provider: "openai", model: "model-b", usage: usageObj({ input: 500, output: 100 }) }),
    assistantEvent({ id: "b3", ts: "2026-07-13T00:05:00.000Z", provider: "openai", model: "model-b", usage: { totalTokens: 999 } }),
  ]);

  return home;
}

test("scanOpenClawCorpus: absent/empty home -> no sessions", () => {
  const home = mkdtempSync(join(tmpdir(), "df-openclaw-empty-"));
  try {
    assert.deepEqual(scanOpenClawCorpus(STATE, home).sessions, []);
    assert.deepEqual(scanOpenClawCorpus(STATE, join(home, "does-not-exist")).sessions, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpenClawCorpus: token fold, cwd/repoHash from the session header, entryPoint always 'unknown', drift counting, multi-day conservation", () => {
  const home = buildFixtureHome();
  try {
    assert.equal(openclawSessionFiles(home).length, 2);
    const scan = scanOpenClawCorpus(STATE, home);
    assert.equal(scan.sessions.length, 2);
    assert.equal(scan.readFailures.length, 0);
    // Drift: unknown-type + malformed line + totalTokens-only assistant message from session B.
    assert.equal(scan.unknownLines, 3);
    assert.ok(scan.totalLines > 0);

    const a = scan.sessions.find((s) => s.toolSessionId === "sess-aaa")!;
    assert.equal(a.tool, "openclaw");
    assert.deepEqual(a.tokens, { input: 110, output: 55, cacheRead: 20, cacheCreation: 5 });
    assert.equal(a.models.length, 1);
    assert.equal(a.models[0].id, "model-a");
    assert.equal(a.cwd, "/home/m/proj");
    assert.ok(a.repoHash, "repoHash derives from the session header's cwd basename");
    assert.equal(a.entryPoint, "unknown", "no documented entry-point/channel field survives in the JSONL transcript");
    assert.equal(a.days, undefined, "single-day session carries no day slices");
    assert.equal(a.thinkingTokens, 0, "no reasoningTokens alias present in this fixture");
    assert.equal(a.skills, undefined);
    assert.equal(a.agents, undefined);
    assert.equal(a.messageCount, 2);
    assert.ok(a.turns >= 1);

    const b = scan.sessions.find((s) => s.toolSessionId === "sess-bbb")!;
    assert.equal(b.cwd, undefined, "header cwd:null -> no cwd, ever guessed");
    assert.equal(b.repoHash, null);
    assert.equal(b.entryPoint, "unknown");
    assert.equal(b.messageCount, 3, "b1, b2 observed AND b3 (usage-less) is still an observed message");
    assert.deepEqual(b.tokens, { input: 1500, output: 300, cacheRead: 300, cacheCreation: 50 });
    const byId = Object.fromEntries(b.models.map((m) => [m.id, m]));
    assert.deepEqual(byId["model-a"], { id: "model-a", input: 1000, output: 200, cacheRead: 300, cacheCreation: 50 });
    assert.deepEqual(byId["model-b"], { id: "model-b", input: 500, output: 100, cacheRead: 0, cacheCreation: 0 });

    // Multi-day conservation: days[] must sum EXACTLY to the session totals (identity,
    // not tolerance -- same rule pi.test.ts asserts for pi.ts).
    assert.ok(b.days && b.days.length === 2, "session B spans a UTC midnight");
    const days = b.days!;
    assert.deepEqual(days.map((d) => d.day), ["2026-07-12", "2026-07-13"]);

    let sumActive = 0;
    let sumIdle = 0;
    const sumTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const d of days) {
      sumActive += d.activeMs;
      sumIdle += d.idleMs;
      sumTokens.input += d.tokens.input;
      sumTokens.output += d.tokens.output;
      sumTokens.cacheRead += d.tokens.cacheRead;
      sumTokens.cacheCreation += d.tokens.cacheCreation;
    }
    assert.deepEqual(sumTokens, b.tokens, "day-slice tokens conserve exactly to the session total");
    assert.equal(sumActive, b.activeMs, "day-slice activeMs conserves exactly");
    assert.equal(sumIdle, b.idleMs, "day-slice idleMs conserves exactly");
    assert.equal(days[0].models?.[0]?.id, "model-a");
    assert.equal(days[1].models?.[0]?.id, "model-b");

    // Determinism: identical re-scan -> identical records (the digest gate relies on this).
    assert.deepEqual(scanOpenClawCorpus(STATE, home), scan);
    assert.deepEqual(summarizeOpenClawCorpus(STATE, home), scan.sessions);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpenClawCorpus: toolSessionId falls back to the filename when the header is missing", () => {
  const home = mkdtempSync(join(tmpdir(), "df-openclaw-noheader-"));
  try {
    // No session-type header line at all -- straight to a message with real usage.
    writeSessionFile(home, "agent-a", "sess-fallback-id", [
      assistantEvent({ id: "a1", ts: "2026-07-01T10:00:00.000Z", model: "model-a", usage: usageObj({ input: 5, output: 5 }) }),
    ]);
    const scan = scanOpenClawCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.sessions[0].toolSessionId, "sess-fallback-id");
    assert.equal(scan.sessions[0].cwd, undefined, "no header -> no cwd -> no repoHash");
    assert.equal(scan.sessions[0].repoHash, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpenClawCorpus: hermetic via DF_OPENCLAW_HOME -- never reads the real machine's ~/.openclaw", () => {
  const home = buildFixtureHome();
  const prev = process.env.DF_OPENCLAW_HOME;
  process.env.DF_OPENCLAW_HOME = home;
  try {
    const scan = scanOpenClawCorpus(STATE); // no explicit home -- must resolve via the env var
    assert.equal(scan.sessions.length, 2);
  } finally {
    if (prev === undefined) delete process.env.DF_OPENCLAW_HOME;
    else process.env.DF_OPENCLAW_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Multi-agentId dedupe (the pi.ts rule): same session id across two agentId dirs.
// ---------------------------------------------------------------------------

test("scanOpenClawCorpus: same session id across two agentId directories dedupes to one summary -- later endedAt, then larger totals, wins", () => {
  const home = mkdtempSync(join(tmpdir(), "df-openclaw-dupe-"));
  try {
    const early = "2026-07-12T10:00:00.000Z";
    const late = "2026-07-12T11:00:00.000Z";

    writeSessionFile(home, "agent-x", "sess-dupe", [
      sessionEvent({ id: "sess-dupe", ts: early }),
      assistantEvent({ id: "a1", ts: early, model: "m", usage: usageObj({ input: 10, output: 5 }) }),
    ]);

    writeSessionFile(home, "agent-y", "sess-dupe", [
      sessionEvent({ id: "sess-dupe", ts: early }),
      assistantEvent({ id: "a1", ts: early, model: "m", usage: usageObj({ input: 10, output: 5 }) }),
      assistantEvent({ id: "a2", ts: late, model: "m", usage: usageObj({ input: 100, output: 50 }) }),
    ]);

    const scan = scanOpenClawCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1, "the same session id across two agentId directories must never upload twice");
    assert.equal(scan.sessions[0].tokens.input, 110, "the more complete (later-ending) record wins, agentId never part of identity");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readFailures via a directory sitting where a session file should be.
// ---------------------------------------------------------------------------

test("scanOpenClawCorpus: a directory named like a session file lands in readFailures; other sessions still scan", () => {
  const home = mkdtempSync(join(tmpdir(), "df-openclaw-readfail-"));
  try {
    writeSessionFile(home, "agent-ok", "s-ok", [
      assistantEvent({ id: "a1", ts: "2026-07-12T10:00:01.000Z", model: "m", usage: usageObj({ input: 1, output: 1 }) }),
    ]);

    // A DIRECTORY named like a session file: statSync/readFileSync throw (EISDIR) --
    // the same detect-but-cannot-read split as a Windows lock/delete race.
    mkdirSync(join(home, "agents", "agent-broken", "sessions", "broken.jsonl"), { recursive: true });

    const scan = scanOpenClawCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1, "the readable session still parses");
    assert.equal(scan.readFailures.length, 1);
    assert.ok(scan.readFailures[0].endsWith("broken.jsonl"), "the unread file is reported so a future cursor never skips over it silently");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Independent cross-check: computeActivity/sliceActivityByDay agree with scanOpenClawCorpus.
// ---------------------------------------------------------------------------

test("scanOpenClawCorpus activity numbers match computeActivity/sliceActivityByDay on the same atoms", () => {
  const home = buildFixtureHome();
  try {
    const scan = scanOpenClawCorpus(STATE, home);
    const b = scan.sessions.find((s) => s.toolSessionId === "sess-bbb")!;
    const content = [
      sessionEvent({ id: "sess-bbb", ts: "2026-07-12T23:00:00.000Z", cwd: null }),
      userEvent({ id: "u2", ts: "2026-07-12T23:00:02.000Z" }),
      assistantEvent({ id: "b1", ts: "2026-07-12T23:00:10.000Z", provider: "anthropic", model: "model-a", usage: usageObj({ input: 1000, output: 200, cacheRead: 300, cacheWrite: 50 }) }),
      JSON.stringify({ type: "some_future_entry", id: "z1", timestamp: "2026-07-12T23:00:12.000Z" }),
      "not json at all {{{",
      assistantEvent({ id: "b2", ts: "2026-07-13T00:00:10.000Z", provider: "openai", model: "model-b", usage: usageObj({ input: 500, output: 100 }) }),
      assistantEvent({ id: "b3", ts: "2026-07-13T00:05:00.000Z", provider: "openai", model: "model-b", usage: { totalTokens: 999 } }),
    ].join("\n");
    const atoms = parseOpenClawSessionFile(content, 0);
    const activity = computeActivity(atoms.timestamps, STATE.gapMs);
    assert.equal(b.activeMs, activity.activeMs);
    assert.equal(b.idleMs, activity.idleMs);
    assert.equal(b.wallMs, activity.wallMs);
    const slices = sliceActivityByDay(atoms.timestamps, STATE.gapMs);
    assert.deepEqual([...slices.keys()].sort(), ["2026-07-12", "2026-07-13"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanOpenClawCorpus: a session with only its usage atoms' timestamps is dated by the file's mtime, never epoch 0", () => {
  const home = mkdtempSync(join(tmpdir(), "df-openclaw-msgts-"));
  try {
    const filePath = writeSessionFile(home, "agent-a", "sess-msgts", [
      // Entry-level timestamps deliberately malformed -- dating must fall back to the
      // FILE's mtimeMs (the per-file analog of the old SQL created_at column), never 0.
      JSON.stringify({ type: "message", id: "a1", parentId: null, timestamp: "also-bad", message: { role: "assistant", model: "m", usage: usageObj({ input: 10, output: 5 }) } }),
      JSON.stringify({ type: "message", id: "a2", parentId: null, timestamp: "also-bad", message: { role: "assistant", model: "m", usage: usageObj({ input: 20, output: 10 }) } }),
    ]);
    // Pin the file's mtime to a known, deterministic value so the fallback is asserted exactly.
    const t1 = Date.UTC(2026, 6, 12, 10, 0, 0);
    utimesSync(filePath, new Date(t1), new Date(t1));

    const scan = scanOpenClawCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.sessions[0].startedAt, t1, "startedAt = the file's mtimeMs fallback, never 0");
    assert.equal(scan.sessions[0].tokens.input, 30);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Real-corpus shape pin (2026-07-14, OpenClaw 2026.7.1) -- the exact ground truth
// this migration was built and verified against. See src/openclaw.ts's header for
// the verified on-disk facts this test encodes (session `6756fe9b-...`).
// ---------------------------------------------------------------------------

test("real-corpus shape pin: session header + assistant usage + toolResult role + trajectory-sidecar exclusion", () => {
  const home = mkdtempSync(join(tmpdir(), "df-openclaw-realshape-"));
  try {
    const dir = join(home, "agents", "main", "sessions");
    mkdirSync(dir, { recursive: true });
    const id = "6756fe9b-38d0-4358-aff6-dae38205be7a";
    const cwd = "C:\\Users\\m\\.openclaw\\workspace";

    // Verbatim field shapes from the real 2026-07-14 corpus (ticket ground truth):
    // header line, a user message, an assistant tool-call turn with ALL-ZERO usage
    // (the known capture limit), a toolResult role entry, and the final assistant
    // message of the turn carrying the turn's real usage.
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-07-14T16:21:55.247Z", cwd }),
        JSON.stringify({
          type: "message", id: "u1", parentId: null, timestamp: "2026-07-14T16:21:55.246Z",
          message: { role: "user", timestamp: 1784046107097, content: "read the file greeting.txt" },
        }),
        JSON.stringify({
          type: "message", id: "tc1", parentId: "u1", timestamp: "2026-07-14T16:22:15.647Z",
          message: {
            role: "assistant", api: "openai-chatgpt-responses", provider: "openai", model: "gpt-5.6-sol",
            content: [{ type: "toolCall", id: "exec-1", name: "bash", arguments: { command: "ls" } }],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse", timestamp: 1784046123963,
          },
        }),
        JSON.stringify({
          type: "message", id: "tr1", parentId: "tc1", timestamp: "2026-07-14T16:22:15.650Z",
          message: { role: "toolResult", toolCallId: "exec-1", toolName: "bash", isError: false, content: [{ type: "toolResult", text: "ok" }], timestamp: 1784046124195 },
        }),
        JSON.stringify({
          type: "message", id: "af1", parentId: "tr1", timestamp: "2026-07-14T16:22:15.761Z",
          message: {
            role: "assistant", api: "openai-chatgpt-responses", provider: "openai", model: "gpt-5.6-sol",
            content: [{ type: "text", text: "missing" }],
            usage: { input: 868, output: 5, cacheRead: 18176, cacheWrite: 0, totalTokens: 19049, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop", timestamp: 1784046135644,
          },
        }),
      ].join("\n"),
    );

    // A trajectory sidecar sitting right next to the real transcript, with a
    // DELIBERATELY DIFFERENT/bogus shape -- proving it is excluded by name alone,
    // never by successfully failing to parse.
    writeFileSync(join(dir, `${id}.trajectory.jsonl`), JSON.stringify({ anything: "a different document, never parsed" }));
    writeFileSync(join(dir, `${id}.trajectory-path.json`), JSON.stringify({ path: "irrelevant" }));

    assert.equal(openclawSessionFiles(home).length, 1, "only the real transcript is discovered, never its sidecars");

    const scan = scanOpenClawCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    const s = scan.sessions[0];
    assert.equal(s.toolSessionId, id);
    assert.equal(s.cwd, cwd);
    assert.equal(s.model, "gpt-5.6-sol");
    assert.equal(s.messageCount, 2, "both assistant messages observed -- the all-zero tool-call turn AND the final reply");
    // The known capture limit, pinned exactly: the tool-call turn's all-zero usage is
    // a REAL recorded zero (not drift), so the session total is exactly the final
    // message's own counts, unmoved by the zero.
    assert.deepEqual(s.tokens, { input: 868, output: 5, cacheRead: 18176, cacheCreation: 0 });
    assert.equal(scan.unknownLines, 0, "toolResult role and all-zero usage are both known, non-drift shapes");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
