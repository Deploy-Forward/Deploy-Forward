/**
 * Thread identity — Marco's D10 ruling (2026-07-18): a thread on the live/limits
 * screens must show what it IS, not just what model is running it: the repo/folder
 * BASENAME it launched in (never a full path — this screen gets recorded, and folder
 * names can be client names), its launch timestamp, and active time. A `--redact`
 * mode collapses every label back to today's bare-model form.
 *
 * DISCOVERY (recorded here, not asserted as a contract): every one of the 8 harness
 * parsers already threads a real, absolute `cwd` onto `SessionSummary.cwd` — this is
 * NOT new plumbing, it is the existing repoHash/orgRepo attribution path (sync.ts's
 * "all three providers derive it from their cwd metadata" comment undersells it; grep
 * confirms cwd flows for pi/openclaw/opencode/hermes/copilot too). So `repoLabel` is
 * derived UNIFORMLY as `basename(cwd)` regardless of which harness produced the
 * session — never a harness-specific decode. See the accompanying report for the
 * full per-harness file:line evidence table.
 *
 * These tests are RED until the code author:
 *   1. adds `repoLabel?: string` + `startedAt: number` to ShowcaseSession, and wires
 *      readShowcaseData()'s session-mapping loop to set them from SessionSummary;
 *   2. adds `repoLabel?: string` + `startedAt?: number` to LiveSession, and carries
 *      them through liveSessionsFrom();
 *   3. teaches liveSessionChartLines/limitsPanelLines a `redact?: boolean` opt and
 *      the repoLabel-aware label formats documented inline below;
 *   4. adds an optional `threads?: { repoLabel: string; ms: number }[]` to
 *      DeploymentStats and a `redact?: boolean` second parameter to
 *      composeDeploymentCard.
 *
 * House rule: node:test + assert/strict, hand-computed, no emojis. The 480-test
 * baseline (pre-existing) must stay green; only tests in THIS file are expected red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLine } from "./fixtures.ts";
import {
  readShowcaseData,
  liveSessionChartLines,
  liveSessionsFrom,
  limitsPanelLines,
  composeDeploymentCard,
  shortModel,
  repoBasename,
  type ShowcaseData,
  type ShowcaseSession,
  type LiveSession,
  type DeploymentStats,
} from "../src/superStart.ts";

function sqliteMod(): any {
  return (process as unknown as { getBuiltinModule: (id: string) => any }).getBuiltinModule("node:sqlite");
}

// ---------------------------------------------------------------------------
// Hermetic env isolation — every DF_*_HOME pinned to a non-existent path by
// default (never touches this machine's real corpora), overridden per test with
// a real fixture home for the harness(es) under test. Mirrors superStart.test.ts's
// pinnedEnv/seedCorpus idiom.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "DF_HOME",
  "DF_CLAUDE_PROJECTS",
  "DF_CODEX_SESSIONS",
  "DF_GROK_HOME",
  "DF_PI_HOME",
  "DF_OPENCLAW_HOME",
  "DF_OPENCODE_HOME",
  "DF_HERMES_HOME",
  "DF_COPILOT_HOME",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];

function withIsolatedEnv<T>(overrides: Partial<Record<EnvKey, string>>, fn: () => T): T {
  const noop = mkdtempSync(join(tmpdir(), "df-thread-id-noop-"));
  const prev: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    prev[k] = process.env[k];
    process.env[k] = overrides[k] ?? join(noop, `unused-${k}`);
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-harness minimal fixture builders — one valid, token-bearing session each,
// with cwd threaded exactly the way the real parser reads it (verified against
// src/<harness>.ts and mirrored from each harness's own test/*.test.ts fixtures).
// ---------------------------------------------------------------------------

function buildClaudeProjects(cwd: string | null, sessionId: string, ts: string): string {
  const projects = mkdtempSync(join(tmpdir(), "df-thread-id-claude-"));
  const proj = join(projects, "proj1");
  mkdirSync(proj, { recursive: true });
  const line = JSON.parse(claudeLine({ sessionId, ts, msgId: "m1", reqId: "r1", model: "claude-opus-4-8", input: 100, output: 50 }));
  if (cwd !== null) line.cwd = cwd; // omitting the key entirely mirrors a transcript that never carried one
  writeFileSync(join(proj, `${sessionId}.jsonl`), JSON.stringify(line));
  return projects;
}

function buildCodexSessions(cwd: string, sessionId: string, ts: string): string {
  const root = mkdtempSync(join(tmpdir(), "df-thread-id-codex-"));
  const lines = [
    JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id: sessionId, cwd } }),
    JSON.stringify({ timestamp: ts, type: "turn_context", payload: { model: "gpt-5.5" } }),
    JSON.stringify({
      timestamp: ts,
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 150 } } },
    }),
  ];
  writeFileSync(join(root, `rollout-${sessionId}.jsonl`), lines.join("\n"));
  return root;
}

function buildGrokHome(cwd: string | null, sid: string, ts: string): string {
  const home = mkdtempSync(join(tmpdir(), "df-thread-id-grok-"));
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ base_url: "https://cli-chat-proxy.grok.com/v1" }));
  if (cwd !== null) {
    const dir = join(home, "sessions", encodeURIComponent(cwd), sid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: sid, cwd }, created_at: ts, current_model_id: "grok-4.5", num_chat_messages: 1 }));
    writeFileSync(join(dir, "events.jsonl"), [JSON.stringify({ ts, type: "turn_started", session_id: sid, turn_number: 0, model_id: "grok-4.5" })].join("\n"));
  }
  // The inference line is the ONLY source of real tokens — present whether or not a
  // session dir exists (mirrors grok.test.ts's "sid-bbb: no session dir -> cwd absent").
  writeFileSync(
    join(home, "logs", "unified.jsonl"),
    [
      JSON.stringify({
        ts,
        src: "shell",
        pid: 1,
        lvl: "info",
        sid,
        msg: "shell.turn.inference_done",
        ctx: { loop_index: 1, model_elapsed_ms: 100, prompt_tokens: 100, cached_prompt_tokens: 0, completion_tokens: 50, reasoning_tokens: 0, tokens_per_sec: 1 },
      }),
    ].join("\n"),
  );
  return home;
}

function buildPiHome(cwd: string | null, sid: string, ts: string): string {
  const home = mkdtempSync(join(tmpdir(), "df-thread-id-pi-"));
  const dir = join(home, "agent", "sessions", "--thread--");
  mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ type: "session", version: 3, id: sid, timestamp: ts, cwd });
  const assistant = JSON.stringify({
    type: "message",
    id: "a1",
    parentId: null,
    timestamp: ts,
    message: { role: "assistant", provider: "anthropic", model: "pi-model", timestamp: Date.parse(ts), usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 } },
  });
  writeFileSync(join(dir, `${sid}.jsonl`), [header, assistant].join("\n"));
  return home;
}

function buildOpenClawHome(cwd: string | null, sid: string, ts: string): string {
  const home = mkdtempSync(join(tmpdir(), "df-thread-id-openclaw-"));
  const dir = join(home, "agents", "coder", "sessions");
  mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ type: "session", version: 3, id: sid, parentId: null, timestamp: ts, cwd });
  const assistant = JSON.stringify({
    type: "message",
    id: "a1",
    parentId: null,
    timestamp: ts,
    message: { role: "assistant", provider: "anthropic", model: "oc-model", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 } },
  });
  writeFileSync(join(dir, `${sid}.jsonl`), [header, assistant].join("\n"));
  return home;
}

function buildOpencodeHome(cwd: string, sid: string, tMs: number): string {
  const home = mkdtempSync(join(tmpdir(), "df-thread-id-opencode-"));
  const db = new (sqliteMod().DatabaseSync)(join(home, "opencode.db"));
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, directory TEXT, title TEXT, model TEXT, cost REAL,
    tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
    tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER
  )`);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)`);
  db.prepare(
    `INSERT INTO session (id, directory, title, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(sid, cwd, null, JSON.stringify({ id: "oc-model", providerID: "anthropic" }), 0, 100, 50, 0, 0, 0, tMs, tMs + 60_000);
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`).run("m1", sid, tMs, tMs, JSON.stringify({ role: "assistant" }));
  db.close();
  return home;
}

function buildHermesHome(cwd: string, sid: string, startedAtSec: number): string {
  const home = mkdtempSync(join(tmpdir(), "df-thread-id-hermes-"));
  const db = new (sqliteMod().DatabaseSync)(join(home, "state.db"));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, model_config TEXT,
      system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL,
      end_reason TEXT, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0, cwd TEXT, title TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL, token_count INTEGER
    );
  `);
  db.prepare(
    `INSERT INTO sessions (id, source, model, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cwd, parent_session_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(sid, "cli", "hermes-model", startedAtSec, startedAtSec + 60, 100, 50, 0, 0, 0, cwd, null);
  db.close();
  return home;
}

function buildCopilotHome(cwd: string, sid: string, createdAtIso: string): string {
  const home = mkdtempSync(join(tmpdir(), "df-thread-id-copilot-"));
  const db = new (sqliteMod().DatabaseSync)(join(home, "session-store.db"));
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_index INTEGER, agent_id TEXT, parent_tool_call_id TEXT,
      model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER, total_nano_aiu INTEGER, request_multiplier REAL, duration_ms INTEGER,
      time_to_first_token_ms INTEGER, inter_token_latency_ms INTEGER, initiator TEXT, api_endpoint TEXT,
      reasoning_effort TEXT, finish_reason TEXT, content_filter_triggered INTEGER, token_details_json TEXT, created_at TEXT
    );
  `);
  db.prepare(`INSERT INTO sessions (id, cwd, summary, created_at, updated_at) VALUES (?,?,?,?,?)`).run(sid, cwd, null, createdAtIso, createdAtIso);
  db.prepare(
    `INSERT INTO assistant_usage_events (session_id, turn_index, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(sid, 0, "gpt-5-mini", 100, 50, 0, 0, 0, createdAtIso);
  db.close();
  return home;
}

// ---------------------------------------------------------------------------
// 1. repoLabel derivation — ALL 8 harnesses (discovery correction: every parser
//    already carries cwd; see file header). The label is the last path segment under
//    EITHER separator (superStart.ts's repoBasename) — expectations are written as
//    literals, never re-derived with node:path.basename, which is platform-specific.
// ---------------------------------------------------------------------------

test("readShowcaseData: repoLabel is cwd's last segment under either separator, uniformly across all 8 harnesses", () => {
  const claudeCwd = "C:\\Users\\m\\repos\\claude-thread-proj";
  const codexCwd = "C:\\Users\\m\\repos\\codex-thread-proj";
  const grokCwd = "C:\\Users\\m\\repos\\grok-thread-proj";
  const piCwd = "/home/m/repos/pi-thread-proj";
  const openclawCwd = "/home/m/repos/openclaw-thread-proj";
  const opencodeCwd = "/home/m/repos/opencode-thread-proj";
  const hermesCwd = "C:\\Users\\m\\repos\\hermes-thread-proj";
  const copilotCwd = "C:\\Users\\m\\repos\\copilot-thread-proj";
  const ts = "2026-07-10T10:00:00.000Z";
  const tMs = Date.parse(ts);

  const claudeProjects = buildClaudeProjects(claudeCwd, "clth1", ts);
  const codexRoot = buildCodexSessions(codexCwd, "cxth1", ts);
  const grokHome = buildGrokHome(grokCwd, "grth1", ts);
  const piHome = buildPiHome(piCwd, "pith1", ts);
  const openclawHome = buildOpenClawHome(openclawCwd, "ocawth1", ts);
  const opencodeHome = buildOpencodeHome(opencodeCwd, "ocdeth1", tMs);
  const hermesHome = buildHermesHome(hermesCwd, "hmth1", Math.floor(tMs / 1000));
  const copilotHome = buildCopilotHome(copilotCwd, "cpth1", ts);

  const data = withIsolatedEnv(
    {
      DF_CLAUDE_PROJECTS: claudeProjects,
      DF_CODEX_SESSIONS: codexRoot,
      DF_GROK_HOME: grokHome,
      DF_PI_HOME: piHome,
      DF_OPENCLAW_HOME: openclawHome,
      DF_OPENCODE_HOME: opencodeHome,
      DF_HERMES_HOME: hermesHome,
      DF_COPILOT_HOME: copilotHome,
    },
    () => readShowcaseData(Date.parse("2026-07-11T00:00:00.000Z")),
  );

  const byKey = new Map(data.sessions.map((s) => [s.key, s]));
  // LITERAL leaf names, never basename(cwd). Deriving the expectation with the same
  // platform-specific primitive the code used to use made this assertion tautological
  // on Windows and wrong on Linux: node:path.basename's posix build does not treat "\"
  // as a separator, so on CI these expectations became the whole Windows path and the
  // (correct) separator-agnostic label failed against them. An expectation must be
  // written down, not re-derived from the thing under test.
  const expectations: Array<[string, string]> = [
    ["claude_code_clth1", "claude-thread-proj"],
    ["codex_cxth1", "codex-thread-proj"],
    ["grok_grth1", "grok-thread-proj"],
    ["pi_pith1", "pi-thread-proj"],
    ["openclaw_ocawth1", "openclaw-thread-proj"],
    ["opencode_ocdeth1", "opencode-thread-proj"],
    ["hermes_hmth1", "hermes-thread-proj"],
    ["copilot_cpth1", "copilot-thread-proj"],
  ];
  // Presence check FIRST, separated from the repoLabel check, so a fixture/discovery
  // problem in one harness is never confused with the (expected, currently red)
  // repoLabel gap in another.
  for (const [key] of expectations) {
    assert.ok(byKey.get(key), `${key} missing from the showcase grain — fixture or discovery-scope problem, not a repoLabel bug. Keys present: ${[...byKey.keys()].join(", ")}`);
  }
  for (const [key, expectedLabel] of expectations) {
    const s = byKey.get(key);
    assert.equal(s!.repoLabel, expectedLabel, `${key}: repoLabel must be basename(cwd) = ${JSON.stringify(expectedLabel)}`);
  }
});

test("readShowcaseData: repoLabel is honestly ABSENT when the source carried no cwd at all", () => {
  const ts = "2026-07-10T10:00:00.000Z";
  // Claude: the transcript line never had a top-level "cwd" key at all.
  const claudeProjects = buildClaudeProjects(null, "clnocwd", ts);
  // Grok: the inference line's sid has NO matching sessions/<enc-cwd>/<sid> dir —
  // meta.cwd stays null (grok.test.ts's own documented "sid-bbb" case).
  const grokHome = buildGrokHome(null, "grnocwd", ts);

  const data = withIsolatedEnv(
    { DF_CLAUDE_PROJECTS: claudeProjects, DF_GROK_HOME: grokHome },
    () => readShowcaseData(Date.parse("2026-07-11T00:00:00.000Z")),
  );
  const byKey = new Map(data.sessions.map((s) => [s.key, s]));
  const claudeSession = byKey.get("claude_code_clnocwd");
  const grokSession = byKey.get("grok_grnocwd");
  assert.ok(claudeSession, "the cwd-less Claude session still appears");
  assert.ok(grokSession, "the cwd-less Grok session still appears");
  assert.equal(claudeSession!.repoLabel, undefined, "no cwd -> no repoLabel, never guessed");
  assert.equal(grokSession!.repoLabel, undefined, "no session dir -> no repoLabel, never guessed");
});

// The guard below (repoLabel is basename-only) is only as strong as the segment split,
// and node:path.basename is PLATFORM-SPECIFIC — its posix build does not treat "\" as a
// separator. The showcase test that follows uses a Windows fixture path, so for as long
// as it only ever ran on Windows it proved nothing about a POSIX runtime. The first CI
// run on ubuntu-latest failed it, with the ENTIRE path surviving as the label.
//
// `cwd` here is read out of a TRANSCRIPT, so it was written by whichever machine ran the
// agent — not necessarily the one reading it (a synced ~/.claude, a container mounting a
// Windows host dir, a restored backup, WSL). These cases pin BOTH separators on EVERY
// platform, which is the property the privacy claim actually needs.
test("repoBasename splits on both separators on every platform, so a foreign-OS cwd cannot leak", () => {
  assert.equal(repoBasename("C:\\Users\\m\\clients\\acme-bank"), "acme-bank");
  assert.equal(repoBasename("/home/m/clients/acme-bank"), "acme-bank");
  // Mixed separators are real: WSL and some shells hand back exactly this shape.
  assert.equal(repoBasename("C:/Users/m\\clients/acme-bank"), "acme-bank");
  // Trailing separators must not yield an empty label.
  assert.equal(repoBasename("/home/m/clients/acme-bank/"), "acme-bank");
  assert.equal(repoBasename("C:\\Users\\m\\clients\\acme-bank\\"), "acme-bank");
});

test("repoBasename never guesses: absent, blank, or a bare root yields undefined", () => {
  assert.equal(repoBasename(undefined), undefined);
  assert.equal(repoBasename(""), undefined);
  assert.equal(repoBasename("   "), undefined);
  assert.equal(repoBasename("/"), undefined, "a filesystem root names no repo");
  assert.equal(repoBasename("C:\\"), undefined, "nor does a bare drive root");
  assert.equal(repoBasename("C:"), undefined);
});

test("readShowcaseData: repoLabel is the BASENAME only — a client folder name never survives", () => {
  const ts = "2026-07-10T10:00:00.000Z";
  const cwd = "C:\\Users\\m\\clients\\acme-bank";
  const claudeProjects = buildClaudeProjects(cwd, "clclient1", ts);

  const data = withIsolatedEnv({ DF_CLAUDE_PROJECTS: claudeProjects }, () => readShowcaseData(Date.parse("2026-07-11T00:00:00.000Z")));
  const s = data.sessions.find((x) => x.key === "claude_code_clclient1");
  assert.ok(s, "the fixture session appears");
  assert.equal(s!.repoLabel, "acme-bank", "basename only");
  const serialized = JSON.stringify(data);
  assert.ok(!/clients/i.test(serialized), "the parent folder segment 'clients' must appear NOWHERE in the showcase data");
  assert.ok(!serialized.includes("Users\\\\m\\\\"), "no fragment of the full path either");
});

test("readShowcaseData: SessionSummary.startedAt passes through to ShowcaseSession verbatim", () => {
  const ts = "2026-07-10T14:05:30.000Z";
  const claudeProjects = buildClaudeProjects("C:\\Users\\m\\repos\\started-proj", "clstart1", ts);
  const data = withIsolatedEnv({ DF_CLAUDE_PROJECTS: claudeProjects }, () => readShowcaseData(Date.parse("2026-07-11T00:00:00.000Z")));
  const s = data.sessions.find((x) => x.key === "claude_code_clstart1");
  assert.ok(s, "the fixture session appears");
  assert.equal(s!.startedAt, Date.parse(ts), "startedAt is SessionSummary's own value, verbatim — not re-derived, not Date.now()");
});

// ---------------------------------------------------------------------------
// 2. liveSessionsFrom: repoLabel/startedAt carry through from ShowcaseSession to
//    LiveSession (the watch-loop's own mapping, extracted pure — same function the
//    existing "deltas vs baseline" tests already exercise).
// ---------------------------------------------------------------------------

function sess(o: { key: string; model: string; tokens: number; repoLabel?: string; startedAt?: number }): ShowcaseSession {
  return { key: o.key, tool: "Claude Code", model: o.model, tokens: o.tokens, repoLabel: o.repoLabel, startedAt: o.startedAt } as ShowcaseSession;
}

test("liveSessionsFrom: repoLabel and startedAt pass through to the LiveSession the chart renders", () => {
  const baseline = new Map([["claude_code_a", 100]]);
  const live = liveSessionsFrom(
    [sess({ key: "claude_code_a", model: "claude-opus-4-8", tokens: 500, repoLabel: "acme-bank", startedAt: Date.parse("2026-07-10T14:05:00.000Z") })],
    baseline,
  );
  assert.equal(live.length, 1);
  assert.equal((live[0] as LiveSession & { repoLabel?: string }).repoLabel, "acme-bank", "repoLabel is not dropped in the baseline-diff mapping");
  assert.equal((live[0] as LiveSession & { startedAt?: number }).startedAt, Date.parse("2026-07-10T14:05:00.000Z"), "startedAt is not dropped either");
});

test("liveSessionsFrom: a session with no repoLabel/startedAt yields none on the LiveSession — never invented", () => {
  const baseline = new Map([["claude_code_b", 100]]);
  const live = liveSessionsFrom([sess({ key: "claude_code_b", model: "claude-opus-4-8", tokens: 500 })], baseline);
  assert.equal((live[0] as LiveSession & { repoLabel?: string }).repoLabel, undefined);
});

// ---------------------------------------------------------------------------
// 3a. liveSessionChartLines: the label row gains "repoLabel · model[ pct]" when
//     repoLabel is present and the column is wide enough; redact suppresses it;
//     a too-narrow column drops the WHOLE repoLabel, never a truncated fragment.
// ---------------------------------------------------------------------------

test("liveSessionChartLines: label row shows 'repoLabel · model' when repoLabel is present", () => {
  const lines = liveSessionChartLines([{ label: "claude-opus-4-8", tokens: 900_000, repoLabel: "acme-bank" } as LiveSession], { height: 6, width: 60 });
  const text = lines.join("\n");
  assert.ok(text.includes("acme-bank · opus-4-8"), `expected 'repoLabel · model' glue, got: ${JSON.stringify(text)}`);
});

test("liveSessionChartLines: repoLabel and context pct coexist on the label row", () => {
  const lines = liveSessionChartLines(
    [{ label: "claude-fable-5", tokens: 0, ctx: { pct: 90.7, inferred: true }, repoLabel: "acme-bank" } as LiveSession],
    { height: 4, width: 60 },
  );
  const text = lines.join("\n");
  assert.ok(text.includes("acme-bank · fable-5"), "repoLabel-model glue holds even with a context pct");
  assert.ok(text.includes("~91%"), "context pct still renders, unmoved by repoLabel");
});

test("liveSessionChartLines: redact suppresses repoLabel everywhere, model-only stays", () => {
  const fixture = [{ label: "claude-opus-4-8", tokens: 900_000, repoLabel: "acme-bank" } as LiveSession];
  const shown = liveSessionChartLines(fixture, { height: 6, width: 60 }).join("\n");
  const redacted = liveSessionChartLines(fixture, { height: 6, width: 60, redact: true } as any).join("\n");
  assert.ok(shown.includes("acme-bank"), "sanity: repoLabel renders when not redacted");
  assert.ok(!redacted.includes("acme-bank"), "redact:true must never leak the repoLabel");
  assert.ok(redacted.includes("opus-4-8"), "the model label still renders under redact");
});

test("liveSessionChartLines: a column too narrow for 'repoLabel · model' drops repoLabel WHOLE, never truncates it into noise", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    label: `claude-model-${i}`,
    tokens: 1_000 + i,
    ctx: { pct: 68.9699, inferred: true },
    repoLabel: "acme-bank-repository",
  })) as LiveSession[];
  const lines = liveSessionChartLines(many, { height: 3, width: 46 });
  const labelRow = lines[lines.length - 2];
  assert.ok(!labelRow.includes("acme"), `repoLabel must be dropped WHOLE in a narrow column (no truncated fragment either), got: ${JSON.stringify(labelRow)}`);
});

// ---------------------------------------------------------------------------
// 3b. limitsPanelLines: THREAD rows show repoLabel over model when present, plus
//     "· started HH:MM" when startedAt is known; redact collapses back to model-only
//     and never leaks a repoLabel.
// ---------------------------------------------------------------------------

function hhmm(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

test("limitsPanelLines: THREAD row names the thread by repoLabel, not model, when repoLabel is known", () => {
  const startedAt = Date.parse("2026-07-18T14:05:00.000Z");
  const data = minimalLimitsData();
  const lines = limitsPanelLines(
    data,
    [{ label: "claude-fable-5", tokens: 0, ctx: { pct: 90.7, inferred: true }, repoLabel: "acme-bank", startedAt } as LiveSession],
    { height: 10, width: 110 },
  );
  const text = lines.join("\n");
  assert.ok(text.includes("THREAD acme-bank"), `expected THREAD row named by repoLabel, got: ${JSON.stringify(text)}`);
  assert.ok(text.includes(`started ${hhmm(startedAt)}`), `expected the launch clock time, got: ${JSON.stringify(text)}`);
});

test("limitsPanelLines: redact collapses the THREAD row back to model-only, never leaking repoLabel", () => {
  const startedAt = Date.parse("2026-07-18T14:05:00.000Z");
  const data = minimalLimitsData();
  const fixture: LiveSession[] = [{ label: "claude-fable-5", tokens: 0, ctx: { pct: 90.7, inferred: true }, repoLabel: "acme-bank", startedAt } as LiveSession];
  const text = limitsPanelLines(data, fixture, { height: 10, width: 110, redact: true } as any).join("\n");
  assert.ok(!text.includes("acme-bank"), "redact:true must never leak the repoLabel");
  assert.ok(text.includes("THREAD fable-5"), "the model-only THREAD label still renders under redact");
});

function minimalLimitsData(): ShowcaseData {
  return {
    harnesses: [{ name: "Claude Code", sessions: 1 }],
    totalSessions: 1,
    tokenTotal: 1_000_000,
    modelRows: [{ model: "claude-opus-4-8", input: 100, output: 50, cacheRead: 0, cacheCreation: 0, total: 150 }],
    sessions: [],
    spendTotalUsd: 1.23,
    spendIsPartial: false,
    activeHours: 10,
    days: [],
    spend30dUsd: null,
    codexLimits: null,
    claude5h: null,
  };
}

// ---------------------------------------------------------------------------
// 4. composeDeploymentCard: a new optional "threads" line, up to 2 entries,
//    formatted "repoLabel (duration)" using the SAME mins<60->"Xm" / else "Yh Zm"
//    convention the card's own top-line duration already uses. Redact removes the
//    whole line; mix/peak (already model-based) are unaffected either way.
// ---------------------------------------------------------------------------

function fmtDur(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function baseDeploymentStats(): DeploymentStats {
  return {
    startedAtMs: Date.parse("2026-07-18T04:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-18T05:05:00.000Z"),
    tokens: 12_400_000,
    spendUsd: 9.12,
    turns: 38,
    peakAgents: 4,
    harnesses: ["Claude Code", "Codex"],
    models: [
      { label: "claude-fable-5", tokens: 7_565_000 },
      { label: "claude-opus-4-8", tokens: 3_844_000 },
      { label: "gpt-5.5", tokens: 991_000 },
    ],
    burns: [100, 900, 400, 1200, 300],
    peakCtx: [{ label: "claude-fable-5", pct: 54.2, inferred: true }],
  };
}

test("composeDeploymentCard: a threads line lists up to 2 'repoLabel (duration)' entries", () => {
  const d: DeploymentStats = {
    ...baseDeploymentStats(),
    threads: [
      { repoLabel: "acme-bank", ms: 12 * 60_000 },
      { repoLabel: "codex-proj", ms: 65 * 60_000 },
      { repoLabel: "third-repo", ms: 3 * 60_000 },
    ],
  } as DeploymentStats;
  const text = composeDeploymentCard(d).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(text.includes(`acme-bank (${fmtDur(12 * 60_000)})`), `expected the first thread entry, got: ${JSON.stringify(text)}`);
  assert.ok(text.includes(`codex-proj (${fmtDur(65 * 60_000)})`), `expected the second thread entry, got: ${JSON.stringify(text)}`);
  assert.ok(!text.includes("third-repo"), "only up to 2 thread entries render");
  // mix/peak stay exactly as the existing (green) test already pins — unaffected by this feature.
  assert.ok(text.includes("fable-5 61%") && text.includes("opus-4-8 31%") && text.includes("gpt-5.5 8%"), "mix line unchanged");
  assert.ok(text.includes("~54% of context window"), "peak line unchanged");
});

test("composeDeploymentCard: redact removes the threads line entirely; mix/peak still render", () => {
  const d: DeploymentStats = {
    ...baseDeploymentStats(),
    threads: [
      { repoLabel: "acme-bank", ms: 12 * 60_000 },
      { repoLabel: "codex-proj", ms: 65 * 60_000 },
    ],
  } as DeploymentStats;
  const text = composeDeploymentCard(d, { redact: true } as any).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(!text.includes("acme-bank") && !text.includes("codex-proj"), "redact:true must never leak a repoLabel");
  assert.ok(text.includes("fable-5 61%"), "mix line still renders under redact");
  assert.ok(text.includes("~54% of context window"), "peak line still renders under redact");
});

test("composeDeploymentCard: no threads data -> no threads line, exactly today's card", () => {
  const text = composeDeploymentCard(baseDeploymentStats()).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(!/acme|codex-proj|third-repo/.test(text), "sanity: nothing thread-shaped appears with no threads field");
});
