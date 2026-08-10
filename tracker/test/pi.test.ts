/**
 * pi.dev CLI capture tests (W1.2, docs/harness-adapters-implementation.md).
 *
 * Every fixture is SYNTHESIZED from the docs-derived schema in src/pi.ts's header --
 * no real ~/.pi transcript exists on this machine (or in this repo) and none is read
 * here. Every corpus-level test sets DF_PI_HOME to a temp fixture dir (hermeticity);
 * the pure-function tests (parsePiSessionFile, modelForPiEntry) take content/data
 * directly and touch no filesystem at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parsePiSessionFile,
  modelForPiEntry,
  isOfficialPiCli,
  scanPiCorpus,
  summarizePiCorpus,
  piSessionFiles,
  type PiModelChange,
} from "../src/pi.ts";
import { computeActivity, sliceActivityByDay } from "../src/activity.ts";
import type { TrackerState } from "../src/config.ts";

const STATE = { repoHmacKey: "test-key", gapMs: 5 * 60_000 } as unknown as TrackerState;

// ---------------------------------------------------------------------------
// Fixture line builders
// ---------------------------------------------------------------------------

function headerLine(o: { id: string; ts: string; cwd: string; version?: number }): string {
  return JSON.stringify({ type: "session", version: o.version ?? 3, id: o.id, timestamp: o.ts, cwd: o.cwd });
}

function modelChangeLine(o: { id: string; ts: string; provider?: string; modelId: string }): string {
  return JSON.stringify({
    type: "model_change",
    id: o.id,
    parentId: null,
    timestamp: o.ts,
    provider: o.provider ?? "anthropic",
    modelId: o.modelId,
  });
}

function userLine(o: { id: string; ts: string }): string {
  return JSON.stringify({
    type: "message",
    id: o.id,
    parentId: null,
    timestamp: o.ts,
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  });
}

function assistantLine(o: {
  id: string;
  ts: string;
  msgTs?: number;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  omitUsage?: boolean;
}): string {
  const message: Record<string, unknown> = { role: "assistant", provider: "anthropic" };
  if (o.model !== undefined) message.model = o.model;
  if (o.msgTs !== undefined) message.timestamp = o.msgTs;
  if (!o.omitUsage) {
    message.usage = {
      input: o.input ?? 0,
      output: o.output ?? 0,
      cacheRead: o.cacheRead ?? 0,
      cacheWrite: o.cacheWrite ?? 0,
      // Faithful to the real corpus (W1.0): reasoning sits OUTSIDE totalTokens.
      ...(o.reasoning !== undefined ? { reasoning: o.reasoning } : {}),
      totalTokens: (o.input ?? 0) + (o.output ?? 0),
    };
  }
  // omitUsage: true -- no `usage` key at all (a broken/partial write); parsePiSessionFile
  // must skip this entry for tokens (never estimate) while still counting the turn.
  return JSON.stringify({ type: "message", id: o.id, parentId: null, timestamp: o.ts, message });
}

function knownTokenlessLine(type: string, id: string, ts: string): string {
  const base: Record<string, unknown> = { type, id, parentId: null, timestamp: ts };
  if (type === "thinking_level_change") base.thinkingLevel = "high";
  if (type === "label") { base.targetId = "x"; base.label = "checkpoint"; }
  if (type === "compaction") { base.summary = "..."; base.firstKeptEntryId = "x"; base.tokensBefore = 5000; }
  if (type === "branch_summary") { base.fromId = "x"; base.summary = "..."; }
  if (type === "custom") { base.customType = "ext"; base.data = {}; }
  if (type === "custom_message") { base.customType = "ext"; base.content = "note"; base.display = true; }
  if (type === "session_info") base.name = "renamed";
  return JSON.stringify(base);
}

// ---------------------------------------------------------------------------
// parsePiSessionFile — pure, no filesystem
// ---------------------------------------------------------------------------

test("parsePiSessionFile: header, real tokens (cacheWrite -> cacheCreation), skip rails", () => {
  const content = [
    headerLine({ id: "sess-1", ts: "2026-07-01T10:00:00.000Z", cwd: "/home/m/proj" }),
    userLine({ id: "u1", ts: "2026-07-01T10:00:01.000Z" }),
    modelChangeLine({ id: "mc1", ts: "2026-07-01T10:00:02.000Z", modelId: "model-a" }),
    assistantLine({ id: "a1", ts: "2026-07-01T10:00:10.000Z", model: "model-a", input: 100, output: 50, cacheRead: 20, cacheWrite: 5, reasoning: 38 }),
    // Known type, no tokens -- must NOT be counted as unknown.
    knownTokenlessLine("thinking_level_change", "tl1", "2026-07-01T10:00:11.000Z"),
    // Unrecognized top-level type -- counted, skipped.
    JSON.stringify({ type: "some_future_entry", id: "z1", timestamp: "2026-07-01T10:00:12.000Z" }),
    // Malformed JSON -- counted, skipped, never aborts the file.
    "not json at all {{{",
    // Assistant message with NO numeric usage fields -- skipped, never estimated.
    assistantLine({ id: "a2", ts: "2026-07-01T10:00:20.000Z", model: "model-a", omitUsage: true }),
    // A trailing valid entry proves the malformed line didn't abort the parse.
    assistantLine({ id: "a3", ts: "2026-07-01T10:00:30.000Z", model: "model-a", input: 10, output: 5, reasoning: 4 }),
  ].join("\n");

  const atoms = parsePiSessionFile(content);
  assert.equal(atoms.sessionId, "sess-1");
  assert.equal(atoms.cwd, "/home/m/proj");
  assert.equal(atoms.thinkingTokens, 42, "usage.reasoning sums across token-accounted messages (W1.0 corpus finding)");
  // The usage-less assistant message counts as drift since the PR-5 review fix: pi
  // documents usage on EVERY assistant message, so its absence (or a renamed token
  // field) is the format moving — the exact silent-zero the counter exists to catch.
  assert.equal(atoms.unknownLines, 3, "one unrecognized type + one malformed line + one assistant message without numeric usage");
  assert.equal(atoms.totalLines, 9);
  assert.equal(atoms.humanPromptTimestamps.length, 1);
  assert.equal(atoms.messageCount, 3, "three assistant messages observed, incl. the one with no usable usage");
  assert.equal(atoms.usage.length, 2, "only entries with numeric input+output produce a usage atom");
  assert.deepEqual(atoms.usage[0].tokens, { input: 100, output: 50, cacheRead: 20, cacheCreation: 5 });
  assert.equal(atoms.usage[0].model, "model-a");
  assert.deepEqual(atoms.usage[1].tokens, { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 });
});

test("parsePiSessionFile: message.timestamp (Unix ms) wins over the entry's own ISO timestamp", () => {
  const entryIso = "2026-07-01T10:00:00.000Z"; // entry-level timestamp
  const msgMs = Date.parse("2026-07-01T10:05:00.000Z"); // message.timestamp -- 5 min later
  const content = [
    headerLine({ id: "sess-ts", ts: entryIso, cwd: "/home/m/proj" }),
    assistantLine({ id: "a1", ts: entryIso, msgTs: msgMs, model: "model-a", input: 1, output: 1 }),
  ].join("\n");
  const atoms = parsePiSessionFile(content);
  assert.equal(atoms.usage.length, 1);
  assert.equal(atoms.usage[0].ts, msgMs, "the assistant message's own Unix-ms timestamp is used, not the entry's ISO one");
});

test("parsePiSessionFile: every documented known-tokenless type is recognized (never counted as drift)", () => {
  const types = [
    "thinking_level_change", "label", "compaction", "branch_summary",
    "custom", "custom_message", "session_info",
  ];
  const content = [
    headerLine({ id: "sess-known", ts: "2026-07-01T10:00:00.000Z", cwd: "/home/m/proj" }),
    ...types.map((t, i) => knownTokenlessLine(t, `k${i}`, `2026-07-01T10:0${i}:00.000Z`)),
  ].join("\n");
  const atoms = parsePiSessionFile(content);
  assert.equal(atoms.unknownLines, 0);
  assert.equal(atoms.totalLines, 1 + types.length);
});

// ---------------------------------------------------------------------------
// modelForPiEntry — deterministic model-change window attribution
// ---------------------------------------------------------------------------

test("modelForPiEntry: latest model_change at-or-before the entry owns it; ownModel/unknown fallbacks", () => {
  const changes: PiModelChange[] = [
    { ts: 1000, provider: "anthropic", modelId: "model-a" },
    { ts: 5000, provider: "openai", modelId: "model-b" },
  ];
  assert.equal(modelForPiEntry(changes, 3000, null), "model-a");
  assert.equal(modelForPiEntry(changes, 6000, null), "model-b");
  assert.equal(modelForPiEntry(changes, 4500, null), "model-b", "2s skew tolerance");
  assert.equal(modelForPiEntry([], 6000, "message-own-model"), "message-own-model", "no window -> the entry's own model");
  assert.equal(modelForPiEntry([], 6000, null), "unknown", "verbatim honesty, never guessed");
});

// ---------------------------------------------------------------------------
// isOfficialPiCli — structural fingerprint
// ---------------------------------------------------------------------------

function writeSessionFile(sessionsRoot: string, dirName: string, fileName: string, lines: string[]): void {
  const dir = join(sessionsRoot, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), lines.join("\n"));
}

test("isOfficialPiCli: requires the --cwd-- dir shape AND a valid session header; no mark -> refuse", () => {
  const home = mkdtempSync(join(tmpdir(), "df-pi-"));
  try {
    const sessionsRoot = join(home, "agent", "sessions");
    writeSessionFile(sessionsRoot, "--home-m-proj--", "20260701_abc.jsonl", [
      headerLine({ id: "sess-1", ts: "2026-07-01T10:00:00.000Z", cwd: "/home/m/proj" }),
    ]);
    assert.equal(isOfficialPiCli(home), true);

    // No sessions dir at all -> refuse.
    const noSessions = mkdtempSync(join(tmpdir(), "df-pi-none-"));
    try {
      assert.equal(isOfficialPiCli(noSessions), false);
    } finally {
      rmSync(noSessions, { recursive: true, force: true });
    }

    // sessions/ exists but the dir name doesn't match the documented --cwd-- shape.
    const wrongShape = mkdtempSync(join(tmpdir(), "df-pi-wrongshape-"));
    try {
      writeSessionFile(join(wrongShape, "agent", "sessions"), "home-m-proj", "s.jsonl", [
        headerLine({ id: "sess-2", ts: "2026-07-01T10:00:00.000Z", cwd: "/home/m/proj" }),
      ]);
      assert.equal(isOfficialPiCli(wrongShape), false);
    } finally {
      rmSync(wrongShape, { recursive: true, force: true });
    }

    // Correct dir shape but the first line isn't a valid session header -> refuse.
    const badHeader = mkdtempSync(join(tmpdir(), "df-pi-badheader-"));
    try {
      writeSessionFile(join(badHeader, "agent", "sessions"), "--home-m-proj--", "s.jsonl", [
        JSON.stringify({ type: "message", id: "a1" }),
      ]);
      assert.equal(isOfficialPiCli(badHeader), false);
    } finally {
      rmSync(badHeader, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scanPiCorpus / summarizePiCorpus — full fixture join
// ---------------------------------------------------------------------------

function buildFixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "df-pi-corpus-"));
  const sessionsRoot = join(home, "agent", "sessions");

  // Session A: single-day, one model, no midnight crossing.
  writeSessionFile(sessionsRoot, "--home-m-proj--", "20260701_aaa.jsonl", [
    headerLine({ id: "sess-aaa", ts: "2026-07-01T10:00:00.000Z", cwd: "/home/m/proj" }),
    modelChangeLine({ id: "mc1", ts: "2026-07-01T10:00:01.000Z", modelId: "model-a" }),
    userLine({ id: "u1", ts: "2026-07-01T10:00:02.000Z" }),
    assistantLine({ id: "a1", ts: "2026-07-01T10:00:10.000Z", model: "model-a", input: 100, output: 50, cacheRead: 20, cacheWrite: 5, reasoning: 38 }),
    assistantLine({ id: "a2", ts: "2026-07-01T10:01:00.000Z", model: "model-a", input: 10, output: 5 }),
  ]);

  // Session B: spans a UTC midnight, switches model, carries drift (unknown type +
  // malformed line) and one assistant message with no usable usage.
  writeSessionFile(sessionsRoot, "--home-m-proj--", "20260712_bbb.jsonl", [
    headerLine({ id: "sess-bbb", ts: "2026-07-12T23:00:00.000Z", cwd: "/home/m/proj" }),
    modelChangeLine({ id: "mc2", ts: "2026-07-12T23:00:01.000Z", modelId: "model-a" }),
    userLine({ id: "u2", ts: "2026-07-12T23:00:02.000Z" }),
    assistantLine({ id: "b1", ts: "2026-07-12T23:00:10.000Z", model: "model-a", input: 1000, output: 200, cacheRead: 300, cacheWrite: 50 }),
    JSON.stringify({ type: "some_future_entry", id: "z1", timestamp: "2026-07-12T23:00:12.000Z" }),
    "not json at all {{{",
    modelChangeLine({ id: "mc3", ts: "2026-07-13T00:00:05.000Z", modelId: "model-b" }),
    assistantLine({ id: "b2", ts: "2026-07-13T00:00:10.000Z", model: "model-b", input: 500, output: 100 }),
    assistantLine({ id: "b3", ts: "2026-07-13T00:05:00.000Z", model: "model-b", omitUsage: true }),
  ]);

  return home;
}

test("scanPiCorpus: a disciplined multi-message session carries MUE — the shared seam works for a NON-Claude harness", () => {
  // Proves harness-neutral MUE end-to-end: a real pi corpus (not the Claude path) yields a
  // SessionSummary.mue via the same sessionMue() seam. Flat per-message context ⟹ alpha = 1.
  const home = mkdtempSync(join(tmpdir(), "df-pi-mue-"));
  try {
    const lines = [
      headerLine({ id: "sess-mue", ts: "2026-07-01T10:00:00.000Z", cwd: "/home/m/proj" }),
      modelChangeLine({ id: "mc", ts: "2026-07-01T10:00:01.000Z", modelId: "model-a" }),
    ];
    for (let i = 0; i < 10; i++) {
      lines.push(userLine({ id: `u${i}`, ts: `2026-07-01T10:${String(i * 2 + 2).padStart(2, "0")}:00.000Z` }));
      lines.push(assistantLine({ id: `a${i}`, ts: `2026-07-01T10:${String(i * 2 + 3).padStart(2, "0")}:00.000Z`, model: "model-a", input: 30_000, output: 1_000 }));
    }
    writeSessionFile(join(home, "agent", "sessions"), "--home-m-proj--", "20260701_mue.jsonl", lines);
    const [s] = scanPiCorpus(STATE, home).sessions;
    assert.ok(s.mue, "pi session carries MUE (per-message usage series present)");
    assert.equal(s.mue!.points, 10);
    assert.ok(Math.abs(s.mue!.alpha - 1) < 1e-9, `flat context -> alpha ~1, got ${s.mue!.alpha}`);
    assert.equal(s.mue!.cActual, 300_000);
    assert.equal(s.mue!.ratio, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanPiCorpus: absent/empty home -> no sessions", () => {
  const home = mkdtempSync(join(tmpdir(), "df-pi-empty-"));
  try {
    assert.deepEqual(scanPiCorpus(STATE, home).sessions, []);
    assert.deepEqual(scanPiCorpus(STATE, join(home, "does-not-exist")).sessions, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanPiCorpus: token fold, model windows, cwd/repoHash, drift counting", () => {
  const home = buildFixtureHome();
  try {
    assert.equal(piSessionFiles(home).length, 2);
    const scan = scanPiCorpus(STATE, home);
    assert.equal(scan.sessions.length, 2);
    // Drift: the unknown-type + malformed lines from session B, plus its usage-less
    // assistant message (counts as drift since the PR-5 review fix — pi documents
    // usage on every assistant message, so absence = the format moving).
    assert.equal(scan.unknownLines, 3);
    assert.ok(scan.totalLines > 0);

    const a = scan.sessions.find((s) => s.toolSessionId === "sess-aaa")!;
    assert.equal(a.tool, "pi");
    assert.deepEqual(a.tokens, { input: 110, output: 55, cacheRead: 20, cacheCreation: 5 });
    assert.equal(a.models.length, 1);
    assert.equal(a.models[0].id, "model-a");
    assert.equal(a.cwd, "/home/m/proj");
    assert.ok(a.repoHash, "repoHash derives from the cwd basename");
    assert.equal(a.days, undefined, "single-day session carries no day slices");
    assert.equal(a.thinkingTokens, 38, "usage.reasoning -> thinkingTokens (W1.0: the docs omit it, the corpus carries it)");
    assert.equal(a.skills, undefined);
    assert.equal(a.agents, undefined);
    assert.equal(a.entryPoint, "cli");
    assert.equal(a.messageCount, 2);
    assert.ok(a.turns >= 1);

    const b = scan.sessions.find((s) => s.toolSessionId === "sess-bbb")!;
    // messageCount counts EVERY assistant message observed, incl. the unusable one.
    assert.equal(b.messageCount, 3);
    assert.equal(b.thinkingTokens, 0, "no reasoning fields in this session -> 0, never invented");
    assert.deepEqual(b.tokens, { input: 1500, output: 300, cacheRead: 300, cacheCreation: 50 });
    const byId = Object.fromEntries(b.models.map((m) => [m.id, m]));
    assert.deepEqual(byId["model-a"], { id: "model-a", input: 1000, output: 200, cacheRead: 300, cacheCreation: 50 });
    assert.deepEqual(byId["model-b"], { id: "model-b", input: 500, output: 100, cacheRead: 0, cacheCreation: 0 });

    // Multi-day conservation: derive independent ground truth from the SAME content via
    // the exported parser + shared activity helpers, and assert the SessionSummary's
    // days[] sum to it EXACTLY (identity, not tolerance -- same rule as daySlices.test.ts).
    assert.ok(b.days && b.days.length === 2, "session B spans a UTC midnight");
    const days = b.days!;
    assert.deepEqual(days.map((d) => d.day), ["2026-07-12", "2026-07-13"]);

    let sumActive = 0, sumIdle = 0;
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

    // Per-day model attribution: day 1 is entirely model-a, day 2 entirely model-b.
    assert.equal(days[0].models?.length, 1);
    assert.equal(days[0].models?.[0]?.id, "model-a");
    assert.deepEqual(days[0].tokens, { input: 1000, output: 200, cacheRead: 300, cacheCreation: 50 });
    assert.equal(days[1].models?.length, 1);
    assert.equal(days[1].models?.[0]?.id, "model-b");
    assert.deepEqual(days[1].tokens, { input: 500, output: 100, cacheRead: 0, cacheCreation: 0 });

    // Determinism: identical re-scan -> identical records (the digest gate relies on this).
    assert.deepEqual(scanPiCorpus(STATE, home), scan);
    // summarizePiCorpus is a thin wrapper -- same sessions array.
    assert.deepEqual(summarizePiCorpus(STATE, home), scan.sessions);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanPiCorpus: toolSessionId falls back to the filename when the header is missing/invalid", () => {
  const home = mkdtempSync(join(tmpdir(), "df-pi-noheader-"));
  try {
    const sessionsRoot = join(home, "agent", "sessions");
    // No session-type header line at all -- straight to a message with real usage.
    writeSessionFile(sessionsRoot, "--home-m-proj--", "20260701_fallback-id.jsonl", [
      assistantLine({ id: "a1", ts: "2026-07-01T10:00:00.000Z", model: "model-a", input: 5, output: 5 }),
    ]);
    const scan = scanPiCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.sessions[0].toolSessionId, "20260701_fallback-id");
    assert.equal(scan.sessions[0].cwd, undefined, "no header -> no cwd -> no repoHash");
    assert.equal(scan.sessions[0].repoHash, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanPiCorpus: hermetic via DF_PI_HOME -- never reads the real machine's ~/.pi", () => {
  const home = buildFixtureHome();
  const prev = process.env.DF_PI_HOME;
  process.env.DF_PI_HOME = home;
  try {
    const scan = scanPiCorpus(STATE); // no explicit home -- must resolve via the env var
    assert.equal(scan.sessions.length, 2);
  } finally {
    if (prev === undefined) delete process.env.DF_PI_HOME;
    else process.env.DF_PI_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Independent cross-check: computeActivity/sliceActivityByDay agree with scanPiCorpus
// on the exact same raw content (belt-and-suspenders on top of the conservation test).
// ---------------------------------------------------------------------------

test("scanPiCorpus activity numbers match computeActivity/sliceActivityByDay on the same atoms", () => {
  const home = buildFixtureHome();
  try {
    const scan = scanPiCorpus(STATE, home);
    const b = scan.sessions.find((s) => s.toolSessionId === "sess-bbb")!;
    const bAtoms = parsePiSessionFile(
      [
        headerLine({ id: "sess-bbb", ts: "2026-07-12T23:00:00.000Z", cwd: "/home/m/proj" }),
        modelChangeLine({ id: "mc2", ts: "2026-07-12T23:00:01.000Z", modelId: "model-a" }),
        userLine({ id: "u2", ts: "2026-07-12T23:00:02.000Z" }),
        assistantLine({ id: "b1", ts: "2026-07-12T23:00:10.000Z", model: "model-a", input: 1000, output: 200, cacheRead: 300, cacheWrite: 50 }),
        JSON.stringify({ type: "some_future_entry", id: "z1", timestamp: "2026-07-12T23:00:12.000Z" }),
        "not json at all {{{",
        modelChangeLine({ id: "mc3", ts: "2026-07-13T00:00:05.000Z", modelId: "model-b" }),
        assistantLine({ id: "b2", ts: "2026-07-13T00:00:10.000Z", model: "model-b", input: 500, output: 100 }),
        assistantLine({ id: "b3", ts: "2026-07-13T00:05:00.000Z", model: "model-b", omitUsage: true }),
      ].join("\n"),
    );
    const activity = computeActivity(bAtoms.timestamps, STATE.gapMs);
    assert.equal(b.activeMs, activity.activeMs);
    assert.equal(b.idleMs, activity.idleMs);
    assert.equal(b.wallMs, activity.wallMs);
    const slices = sliceActivityByDay(bAtoms.timestamps, STATE.gapMs);
    assert.deepEqual([...slices.keys()].sort(), ["2026-07-12", "2026-07-13"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PR-5 review-fix regression pins
// ---------------------------------------------------------------------------

test("scanPiCorpus: a session with only message-level Unix-ms timestamps is dated by them, never epoch 0", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-msgts-"));
  try {
    const dir = join(home, "agent", "sessions", "--home-m-proj--");
    mkdirSync(dir, { recursive: true });
    const t1 = Date.UTC(2026, 6, 12, 10, 0, 0);
    const t2 = Date.UTC(2026, 6, 12, 10, 5, 0);
    writeFileSync(
      join(dir, "s.jsonl"),
      [
        // Entry-level timestamps deliberately malformed/absent: dating must fall back
        // to the usage atoms' own message.timestamp, not to 0 (a token-bearing session
        // at 1970-01-01 misdates day attribution and trips zero-active-time gates).
        JSON.stringify({ type: "session", version: 3, id: "sess-msgts", timestamp: "not-a-date", cwd: "/home/m/proj" }),
        assistantLine({ id: "a1", ts: "also-bad", msgTs: t1, model: "m", input: 10, output: 5 }),
        assistantLine({ id: "a2", ts: "also-bad", msgTs: t2, model: "m", input: 20, output: 10 }),
      ].join("\n"),
    );
    const scan = scanPiCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.sessions[0].startedAt, t1, "startedAt = earliest usage timestamp, not 0");
    assert.equal(scan.sessions[0].tokens.input, 30);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanPiCorpus: two files with the same session id dedupe to one summary — later endedAt, then larger totals, wins", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dupe-"));
  try {
    const dir = join(home, "agent", "sessions", "--home-m-proj--");
    mkdirSync(dir, { recursive: true });
    const early = "2026-07-12T10:00:00.000Z";
    const late = "2026-07-12T11:00:00.000Z";
    writeFileSync(
      join(dir, "a-copy.jsonl"),
      [
        headerLine({ id: "sess-dupe", ts: early, cwd: "/home/m/proj" }),
        assistantLine({ id: "a1", ts: early, model: "m", input: 10, output: 5 }),
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "b-complete.jsonl"),
      [
        headerLine({ id: "sess-dupe", ts: early, cwd: "/home/m/proj" }),
        assistantLine({ id: "a1", ts: early, model: "m", input: 10, output: 5 }),
        assistantLine({ id: "a2", ts: late, model: "m", input: 100, output: 50 }),
      ].join("\n"),
    );
    const scan = scanPiCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1, "same toolSessionId must never upload twice under one digest key");
    assert.equal(scan.sessions[0].tokens.input, 110, "the more complete record wins");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanPiCorpus: an unreadable session file lands in readFailures so its cursor never advances", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-readfail-"));
  try {
    const dir = join(home, "agent", "sessions", "--home-m-proj--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ok.jsonl"),
      [headerLine({ id: "s-ok", ts: "2026-07-12T10:00:00.000Z", cwd: "/home/m/proj" }), assistantLine({ id: "a1", ts: "2026-07-12T10:00:01.000Z", model: "m", input: 1, output: 1 })].join("\n"),
    );
    // A DIRECTORY named like a session file: statSync succeeds, readFileSync throws
    // (EISDIR) — the same detect-but-cannot-read split as a Windows lock/delete race.
    mkdirSync(join(dir, "locked.jsonl"));
    const scan = scanPiCorpus(STATE, home);
    assert.equal(scan.sessions.length, 1, "the readable session still parses");
    assert.equal(scan.readFailures.length, 1);
    assert.ok(scan.readFailures[0].endsWith("locked.jsonl"), "the unread file is reported so sync skips its cursor");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
