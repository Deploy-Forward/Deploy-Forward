/**
 * Gemini CLI (Google) capture — Lane L14 (landscape Tier 1; committed by Marco).
 *
 * PROVENANCE / CONFIDENCE: a REAL `~/.gemini` store WAS found on the dev machine
 * (discovery 2026-07-23), so the on-disk SHAPE below is derived from disk, not from
 * docs — models seen verbatim: gemini-3-pro-preview, gemini-3-flash-preview. But ONE
 * machine's store is a single data point: the two LOCKED vendor semantics this parser
 * enforces were confirmed against that store, yet nothing here is "published" until the
 * committed eval (eval/gemini-audit.mjs) runs against a real corpus and closes the
 * W-gate. Until then this adapter is fingerprint-gated + eval-scripted, exactly the
 * pi/openclaw pre-publish posture.
 *
 * On-disk layout (derived):
 *   <home>/tmp/<projectDir>/chats/session-<name>.json  — ONE JSON OBJECT = ONE session
 *     (NOT jsonl — unlike pi/grok/codex, the whole file is a single parse).
 *   <home>/tmp/<projectDir>/.project_root              — the cwd (the repoHash input),
 *     a sibling of the chats/ dir. Absent -> honest cwd/repoHash absence, never guessed.
 * Session JSON: { sessionId, projectHash, startTime, lastUpdated, messages: [...] }.
 *   A "gemini"-type message carries { model, tokens:{input,output,cached,thoughts,tool,
 *   total}, thoughts:[{subject,description}], toolCalls }. "user" messages are turns;
 *   "info"/"error" are plumbing (no tokens).
 *
 * TWO LOCKED vendor semantics (verified against the real store, and pinned by tests):
 *   1. `cached` is a SUBSET of the input/prompt count (cache is part of the prompt, not
 *      extra) — so FRESH input = prompt - cached (clamped >= 0), and cacheRead is
 *      clamped to the prompt so input + cacheRead conserves the ORIGINAL prompt exactly,
 *      never double-charged. cacheCreation = 0 (Gemini logs no cache-WRITE counter —
 *      absence stays absent). This is the SAME xAI/OpenAI "prompt inclusive of cache"
 *      convention grok.ts already handles; the vendor field is `cached` (NOT codeburn's
 *      `cachedContentTokenCount` — a rename trap pinned by the drift test).
 *   2. `thoughts` tokens are STATUS-ONLY. The NUMERIC `tokens.thoughts` accumulates into
 *      the session's `thinkingTokens` field (exactly like grok's reasoning_tokens / pi's
 *      usage.reasoning), NEVER added to output and NEVER priced. The message ALSO carries
 *      a separate `thoughts` LIST ({subject,description} summaries) — a DIFFERENT field;
 *      the adapter reads the number, never the list length.
 *
 * Capture rails (non-negotiable, same as every sibling adapter):
 *   - REAL counters only. A "gemini" message without a numeric `tokens.input` AND
 *     `tokens.output` is SKIPPED and COUNTED as drift (a renamed/absent tokens object is
 *     the silent-zero failure the counter exists to surface) — never estimated.
 *   - Fingerprint the OFFICIAL store first (isOfficialGeminiCli): a chats-like tree that
 *     is NOT the documented { sessionId, messages:[] } object shape contributes NOTHING
 *     (we never guess which product wrote a file).
 *   - Pure parse (parseGeminiSessionFile) makes no filesystem/network call; the cwd
 *     (from the sibling .project_root) is resolved only in the disk-walking scan.
 *
 * Pricing: NOT invented here. gemini-3-pro / gemini-3-flash rows may exist (marked
 * VERIFY) in the pricing tables, but the real `-preview` ids stay honestly UNPRICED
 * rather than aliased — no rate is guessed from a model name.
 *
 * The fingerprint gate is exported SEPARATELY and is the CALLER's responsibility (the
 * sync provider block), mirroring grok.ts/pi.ts — summarizeGeminiCorpus never gates
 * itself.
 */
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { creditModel, foldModelBuckets, addTokens, ZERO } from "./jsonl.js";
import { sessionMue, lastNonzeroOccupancy, type OccupancySeriesEntry } from "./contextEfficiency.js";
import { computeActivity, computeLoops } from "./activity.js";
import { repoHash, type TrackerState } from "./config.js";
import type { SessionSummary, TokenCounts } from "./types.js";

/**
 * Home resolution: the DF_-prefixed override wins (the hermeticity idiom every adapter
 * follows — DF_PI_HOME / DF_GROK_HOME), then the tool's OWN documented env var
 * (GEMINI_CLI_HOME), then the default ~/.gemini. A test pins that DF_GEMINI_HOME beats
 * GEMINI_CLI_HOME.
 */
export function geminiHome(): string {
  return process.env.DF_GEMINI_HOME ?? process.env.GEMINI_CLI_HOME ?? join(homedir(), ".gemini");
}

/** The chats-tree root: <home>/tmp. Each immediate child is one project dir holding a
 *  chats/ subdir (session-*.json) and a sibling .project_root. */
export function geminiTmpRoot(home: string = geminiHome()): string {
  return join(home, "tmp");
}

/**
 * Is `home` an official Gemini CLI store? Structural fingerprint (no proprietary content
 * string exists, same as pi/openclaw): at least one `tmp/<projectDir>/chats/*.json` whose
 * content parses as the documented session OBJECT — a string `sessionId` AND an array
 * `messages`. A pi-style `{type:"session",version,id,cwd}` header (no sessionId+messages)
 * is refused; an empty/absent home returns false and never throws.
 */
export function isOfficialGeminiCli(home: string = geminiHome()): boolean {
  for (const f of geminiSessionFiles(home)) {
    let content: string;
    try {
      content = readFileSync(f.path, "utf8");
    } catch {
      continue;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(content);
    } catch {
      continue;
    }
    const o = obj as Record<string, unknown> | null;
    if (o && typeof o.sessionId === "string" && Array.isArray(o.messages)) return true;
  }
  return false;
}

/** One session file discovered under tmp/<projectDir>/chats/, with the sibling
 *  .project_root path so the scan can resolve the cwd without re-deriving the layout. */
export interface GeminiSessionFile {
  path: string;
  /** <home>/tmp/<projectDir>/.project_root — read (best-effort) for the cwd. */
  projectRootFile: string;
}

/**
 * All `tmp/<projectDir>/chats/*.json` session files. A looser walk than the fingerprint
 * (no shape check here — parsing owns that), mirroring grok's/pi's split between the
 * strict fingerprint and the loose discovery. Non-chat residents at the tmp root (a
 * `bin/` dir, a stray file) never match, and one unreadable directory never aborts the
 * scan.
 */
export function geminiSessionFiles(home: string = geminiHome()): GeminiSessionFile[] {
  const root = geminiTmpRoot(home);
  const out: GeminiSessionFile[] = [];
  let projectDirs: Dirent[];
  try {
    projectDirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const projectDir = join(root, d.name);
    const chats = join(projectDir, "chats");
    let files: string[];
    try {
      files = readdirSync(chats);
    } catch {
      continue; // no chats/ subdir (e.g. a bin/ resident) -> not a session dir
    }
    const projectRootFile = join(projectDir, ".project_root");
    for (const f of files) {
      if (f.endsWith(".json")) out.push({ path: join(chats, f), projectRootFile });
    }
  }
  return out;
}

/** One real, token-accounted, model-resolved gemini (assistant) message. `ts` is Unix
 *  ms (parsed from the message's ISO `timestamp`). */
interface ResolvedUsage {
  ts: number;
  model: string;
  tokens: TokenCounts;
}

/** Everything extracted from one session file's raw content. */
export interface GeminiFileAtoms {
  /** Top-level `sessionId` (the session key), or null when the file didn't carry one. */
  sessionId: string | null;
  /** Real, token-accounted usage atoms, sorted by ts ascending (the order sessionMue /
   *  lastNonzeroOccupancy depend on). */
  usage: ResolvedUsage[];
  /** Every message timestamp seen (gemini/user/info) — the activity stream. */
  timestamps: number[];
  /** `type === "user"` message timestamps — turns. */
  humanPromptTimestamps: number[];
  /** Every "gemini" (assistant) message OBSERVED, whether or not it carried usable token
   *  data (a token-less gemini message is still a real assistant turn). */
  messageCount: number;
  /** Sum of the NUMERIC `tokens.thoughts` across token-accounted gemini messages —
   *  STATUS-ONLY (LOCKED semantic 2), never summed into output, never priced. */
  thinkingTokens: number;
  /** "gemini" messages we could NOT credit (renamed/absent tokens object) PLUS a
   *  whole-file parse/shape failure — the drift numerator. */
  unknownLines: number;
  /** Every "gemini"-message candidate we CLAIM to understand (the drift denominator);
   *  a whole-file failure counts as one candidate too. user/info plumbing is excluded so
   *  a healthy corpus doesn't read as near-100% drift (the same scoping grok.ts uses). */
  totalLines: number;
}

/**
 * Parse ONE session file's content (the whole file is a single JSON object — NOT jsonl).
 * Pure: no filesystem, no network. Defensive: a whole-file parse/shape failure is one
 * drift unit and never throws; a single malformed message never sinks the rest.
 */
export function parseGeminiSessionFile(content: string): GeminiFileAtoms {
  const out: GeminiFileAtoms = {
    sessionId: null,
    usage: [],
    timestamps: [],
    humanPromptTimestamps: [],
    messageCount: 0,
    thinkingTokens: 0,
    unknownLines: 0,
    totalLines: 0,
  };

  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    out.totalLines++;
    out.unknownLines++; // a whole-file parse failure registers as one drift unit
    return out;
  }
  const root = obj as Record<string, unknown> | null;
  if (typeof root?.sessionId === "string" && root.sessionId) out.sessionId = root.sessionId;
  if (!root || !Array.isArray(root.messages)) {
    out.totalLines++;
    out.unknownLines++; // parsed, but not the documented { messages: [...] } shape — drift
    return out;
  }

  const rawUsage: ResolvedUsage[] = [];
  for (const m of root.messages) {
    const msg = m as Record<string, unknown> | null;
    if (!msg || typeof msg.type !== "string") continue; // not a message shape — plumbing noise
    const ts = typeof msg.timestamp === "string" ? Date.parse(msg.timestamp) : NaN;
    if (Number.isFinite(ts)) out.timestamps.push(ts);

    if (msg.type === "user") {
      if (Number.isFinite(ts)) out.humanPromptTimestamps.push(ts);
      continue;
    }
    if (msg.type !== "gemini") continue; // "info" / "error" and any future plumbing type — no tokens

    // A "gemini" message is a candidate we claim to understand: it counts toward both the
    // drift denominator and the observed-assistant tally, regardless of whether it credits.
    out.messageCount++;
    out.totalLines++;

    const tokens = msg.tokens as Record<string, unknown> | undefined;
    const input = tokens?.input;
    const output = tokens?.output;
    if (!tokens || typeof input !== "number" || typeof output !== "number") {
      // REAL counters only — a renamed (counts moved under `usage`) or absent tokens
      // object is the silent-zero failure this counter exists to surface, never estimated.
      out.unknownLines++;
      continue;
    }
    if (!Number.isFinite(ts)) continue; // no usable timestamp -> can't order it for MUE/activity

    // LOCKED semantic 1: `cached` is a SUBSET of the prompt. fresh = prompt - cached
    // (clamped >= 0); cacheRead is clamped to the prompt so fresh + cacheRead conserves
    // the ORIGINAL prompt exactly, even when a corrupt line logs cached > prompt.
    const prompt = Math.max(0, input);
    const cached = Math.max(0, typeof tokens.cached === "number" ? tokens.cached : 0);
    const cacheRead = Math.min(cached, prompt);
    const tk: TokenCounts = {
      input: Math.max(0, prompt - cached),
      output: Math.max(0, output),
      cacheRead,
      cacheCreation: 0, // Gemini logs no cache-write counter — absence stays absent
    };
    rawUsage.push({
      ts,
      model: typeof msg.model === "string" && msg.model ? msg.model : "unknown",
      tokens: tk,
    });

    // LOCKED semantic 2: the NUMERIC tokens.thoughts is status-only -> thinkingTokens.
    // NEVER the message-level `thoughts` LIST length (a different field entirely).
    if (typeof tokens.thoughts === "number" && Number.isFinite(tokens.thoughts)) {
      out.thinkingTokens += Math.max(0, tokens.thoughts);
    }
  }

  rawUsage.sort((a, b) => a.ts - b.ts);
  out.usage = rawUsage;
  out.timestamps.sort((a, b) => a - b);
  out.humanPromptTimestamps.sort((a, b) => a - b);
  return out;
}

/** Best-effort cwd from a session's sibling `.project_root` file. Missing/unreadable ->
 *  null (honest absence): raw cwd never leaves this function, only its basename's HMAC. */
function readProjectRoot(projectRootFile: string): string | null {
  try {
    const cwd = readFileSync(projectRootFile, "utf8").trim();
    return cwd || null;
  } catch {
    return null;
  }
}

/** `scanGeminiCorpus`'s full result — sessions plus the drift-plumbing counters and the
 *  read-failure list (same shape as pi's PiCorpusScan; sync threads them identically). */
export interface GeminiCorpusScan {
  sessions: SessionSummary[];
  unknownLines: number;
  totalLines: number;
  /** Files statSync could see but readFileSync/parse could not deliver. The caller must
   *  NOT advance a byte cursor for these — one gemini file is one whole session that
   *  never grows after completion, so a cursor written for an unread file would skip that
   *  session forever (the pi read-failure rule). */
  readFailures: string[];
}

/**
 * Summarize the whole Gemini corpus into SessionSummary records (one per session file
 * with at least one real, token-accounted gemini message) plus drift counters.
 * Cumulative + deterministic: a re-parse of an unchanged file yields a byte-identical
 * record, so sync's digest gate uploads nothing for it. Does NOT check
 * isOfficialGeminiCli itself — that gate is the CALLER's responsibility (mirrors
 * grok.ts's/pi.ts's summarize, gated externally in sync.ts).
 */
export function scanGeminiCorpus(state: TrackerState, home: string = geminiHome()): GeminiCorpusScan {
  // Keyed by toolSessionId: a ~/.gemini tree copied across project dirs (or machines) can
  // present the same sessionId twice, and two summaries under one digest key would race.
  // Deterministic winner: later endedAt, then larger token total — the more complete record.
  const bySession = new Map<string, SessionSummary>();
  let unknownLines = 0;
  let totalLines = 0;
  const readFailures: string[] = [];

  for (const file of geminiSessionFiles(home)) {
    let content: string;
    try {
      content = readFileSync(file.path, "utf8");
    } catch {
      readFailures.push(file.path); // one unreadable file never aborts the scan
      continue;
    }
    const atoms = parseGeminiSessionFile(content);
    unknownLines += atoms.unknownLines;
    totalLines += atoms.totalLines;
    if (atoms.usage.length === 0) continue; // no real-token-accounted messages -- nothing to report

    const byModel = new Map<string, TokenCounts>();
    const mueSeries: OccupancySeriesEntry[] = [];
    for (const u of atoms.usage) {
      creditModel(byModel, u.model, u.tokens);
      mueSeries.push({ tokens: u.tokens, ts: u.ts, model: u.model });
    }
    const models = foldModelBuckets(byModel);
    const tokens: TokenCounts = { ...ZERO };
    for (const m of models) addTokens(tokens, m);

    const cwd = readProjectRoot(file.projectRootFile);
    const tsPool = atoms.timestamps.length > 0 ? atoms.timestamps : atoms.usage.map((u) => u.ts);
    const activity = computeActivity(tsPool, state.gapMs);
    const loops = computeLoops(tsPool, atoms.humanPromptTimestamps, state.gapMs);
    const startedAt = tsPool[0] ?? 0; // deterministic, never Date.now()

    const summary: SessionSummary = {
      tool: "gemini",
      toolSessionId: atoms.sessionId ?? basename(file.path).replace(/\.json$/, ""),
      model: atoms.usage[atoms.usage.length - 1]?.model ?? models[0]?.id ?? "unknown",
      tokens,
      models,
      entryPoint: "cli", // Gemini CLI ships as a terminal agent — no alternate entry point signal
      thinkingTokens: atoms.thinkingTokens, // NUMERIC tokens.thoughts, summed — status-only
      // MUE (docs/model-use-efficiency.md): Gemini records per-message token usage, so the
      // exponent is computable via the SAME vendor-neutral seam Claude/pi/grok use. Absent
      // for short sessions.
      mue: sessionMue(atoms.usage),
      // Context occupancy (lane T3): LOCAL-ONLY, last message's own cost + its model.
      context: lastNonzeroOccupancy(mueSeries),
      skills: undefined, // no documented skill-invocation signal in Gemini's session format
      agents: undefined, // no subagent-dispatch concept in Gemini's session format
      wallMs: activity.wallMs,
      activeMs: activity.activeMs,
      idleMs: activity.idleMs,
      startedAt,
      endedAt: startedAt + activity.wallMs,
      // Repo identity: HMAC of the cwd's basename (the same local-only pseudonym scheme
      // grok/pi/Claude use); null when no sibling .project_root carried a cwd.
      repoHash: cwd ? repoHash(state.repoHmacKey, basename(cwd)) : null,
      messageCount: atoms.messageCount,
      turns: loops.turns,
      longestLoopMs: loops.longestLoopMs,
      // Local-only cwd metadata -> orgRepo derivation in syncOnce (enrolled devices).
      cwd: cwd ?? undefined,
    };
    const prior = bySession.get(summary.toolSessionId);
    const total = (s: SessionSummary) => s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheCreation;
    if (!prior || summary.endedAt > prior.endedAt || (summary.endedAt === prior.endedAt && total(summary) > total(prior))) {
      bySession.set(summary.toolSessionId, summary);
    }
  }
  return { sessions: [...bySession.values()], unknownLines, totalLines, readFailures };
}

/** Thin wrapper matching grok.ts's/pi.ts's `summarize*(state, home)` signature, for call
 *  sites that only need the sessions. Sync itself calls `scanGeminiCorpus` directly so the
 *  drift counters ride the same single scan instead of being discarded. */
export function summarizeGeminiCorpus(state: TrackerState, home: string = geminiHome()): SessionSummary[] {
  return scanGeminiCorpus(state, home).sessions;
}
