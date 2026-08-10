/**
 * Grok CLI (xAI official, "Grok Build TUI") capture — Lane G1 of
 * docs/grok-capture-plan.md (forensics-verified on-disk format, 2026-07-10).
 *
 * Unlike Claude/Codex, Grok splits its record across TWO sources that join on
 * session id:
 *   - ~/.grok/logs/unified.jsonl (global, default-on): the ONLY local source of real
 *     token counts — `shell.turn.inference_done` lines carry ctx.prompt_tokens /
 *     cached_prompt_tokens / completion_tokens / reasoning_tokens + ISO ts + sid.
 *   - ~/.grok/sessions/<urlencoded-cwd>/<sid>/: summary.json (cwd, git context,
 *     current_model_id, num_chat_messages) and events.jsonl (per-turn turn_started
 *     with ts + model_id — the deterministic model-attribution key).
 *
 * Capture standard rails (non-negotiable):
 *   - REAL counters only. An inference line without token fields is SKIPPED — token
 *     logging shipped in a ~0.2.8x build (~2026-06-12); earlier history is "no data",
 *     never reconstructed or estimated from text.
 *   - unified.jsonl is an UNDOCUMENTED internal log (the documented --output-format
 *     json carries no usage object). Parse defensively; anything unrecognized -> skip.
 *   - Fingerprint the OFFICIAL CLI first: the MIT community `grok-cli` shares the
 *     ~/.grok home with a completely different format. No fingerprint -> capture
 *     NOTHING (never guess which product wrote a file).
 *
 * Token mapping (xAI/OpenAI convention -> our TokenCounts): prompt_tokens INCLUDES
 * the cached portion, so input = prompt - cached (clamped >= 0), cacheRead = cached,
 * output = completion (which already includes reasoning; reasoning_tokens accumulate
 * separately as thinkingTokens, mirroring Claude's thinking treatment),
 * cacheCreation = 0 (Grok logs no cache-write counter — absence stays absent).
 */
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { creditModel, foldModelBuckets, addTokens, ZERO } from "./jsonl.js";
import { sessionMue, lastNonzeroOccupancy, type OccupancySeriesEntry } from "./contextEfficiency.js";
import { computeActivity, computeLoops } from "./activity.js";
import { repoHash, type TrackerState } from "./config.js";
import type { SessionSummary, TokenCounts } from "./types.js";

export function grokHome(): string {
  return process.env.DF_GROK_HOME ?? join(homedir(), ".grok");
}

export function grokUnifiedLogPath(home: string = grokHome()): string {
  return join(home, "logs", "unified.jsonl");
}

/**
 * Is the ~/.grok on this machine the OFFICIAL xAI CLI? Content fingerprint, never
 * path: models_cache.json routes chat through xAI's proxy, and config.toml pins the
 * xai-org plugin marketplace. Either mark suffices; no mark (or no token log at all)
 * means we capture nothing from this tree.
 */
export function isOfficialGrokCli(home: string = grokHome()): boolean {
  if (!existsSync(grokUnifiedLogPath(home))) return false;
  const marks: Array<{ file: string; re: RegExp }> = [
    { file: join(home, "models_cache.json"), re: /cli-chat-proxy\.grok\.com|api\.x\.ai/ },
    { file: join(home, "config.toml"), re: /xai-org\/plugin-marketplace/ },
  ];
  for (const m of marks) {
    try {
      if (m.re.test(readFileSync(m.file, "utf8"))) return true;
    } catch {
      /* missing/unreadable mark file — try the next */
    }
  }
  return false;
}

/** One real token-accounted inference call from unified.jsonl. */
export interface GrokInference {
  ts: number;
  sid: string;
  prompt: number;
  cached: number;
  completion: number;
  reasoning: number;
}

/** `scanGrokInferences`'s full result — inferences plus the W1.5 drift counters. */
export interface GrokInferenceScan {
  inferences: GrokInference[];
  /** Candidate inference lines that failed extraction — drift input (W1.5). */
  unknownLines: number;
  /** Every candidate inference line seen — the drift-rate denominator. */
  totalLines: number;
}

/**
 * Extract every token-accounted inference from unified.jsonl content, counting the
 * candidate lines that failed (the W1.5 drift input). Lines that are not
 * inference_done, carry no numeric prompt_tokens (pre-logging builds), or fail to
 * parse are skipped — one corrupt line never sinks the pass.
 *
 * DRIFT DENOMINATOR (deliberate scope): unified.jsonl is a firehose of event types we
 * deliberately ignore — counting THOSE as unknown would read near-100% drift on every
 * healthy corpus. The counters therefore cover only the lines we CLAIM to understand:
 * candidates matching the inference_done pre-filter. Counted as unknown: JSON-parse
 * failures, a non-string sid, non-numeric token fields (a rename of prompt_tokens et
 * al lands here — the Task->Agent lesson), and unparseable timestamps. KNOWN CAVEAT:
 * pre-token-logging builds (< ~0.2.8x, see file header) emit inference lines without
 * token fields, indistinguishable from a rename — a corpus that is MOSTLY pre-logging
 * tail can trip the threshold; the >5% AND >20-line rule in providers.ts bounds the
 * noise on any actively-used install. A rename of the "shell.turn.inference_done"
 * marker ITSELF empties the candidate set and stays invisible here — that failure
 * mode is the live-corpus eval's to catch, not this counter's (recorded in
 * providers.ts).
 */
export function scanGrokInferences(content: string): GrokInferenceScan {
  const out: GrokInference[] = [];
  let unknownLines = 0;
  let totalLines = 0;
  for (const line of content.split("\n")) {
    if (!line.includes('"shell.turn.inference_done"')) continue; // cheap pre-filter
    let obj: {
      ts?: string;
      sid?: string;
      msg?: string;
      ctx?: { prompt_tokens?: unknown; cached_prompt_tokens?: unknown; completion_tokens?: unknown; reasoning_tokens?: unknown };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      totalLines++;
      unknownLines++; // a corrupt candidate line is drift/damage
      continue;
    }
    // Marker matched inside some OTHER field: not one of our records — neither counter
    // moves (it was never a line we claimed to understand).
    if (obj.msg !== "shell.turn.inference_done") continue;
    totalLines++;
    if (typeof obj.sid !== "string") {
      unknownLines++; // an inference record without its session key — shape drift
      continue;
    }
    const ctx = obj.ctx;
    if (!ctx || typeof ctx.prompt_tokens !== "number" || typeof ctx.completion_tokens !== "number") {
      unknownLines++; // renamed token fields OR a pre-token-logging build line (see above)
      continue; // no data, never estimated
    }
    const ts = obj.ts ? Date.parse(obj.ts) : NaN;
    if (!Number.isFinite(ts)) {
      unknownLines++;
      continue;
    }
    out.push({
      ts,
      sid: obj.sid,
      prompt: Math.max(0, ctx.prompt_tokens),
      cached: Math.max(0, typeof ctx.cached_prompt_tokens === "number" ? ctx.cached_prompt_tokens : 0),
      completion: Math.max(0, ctx.completion_tokens),
      reasoning: Math.max(0, typeof ctx.reasoning_tokens === "number" ? ctx.reasoning_tokens : 0),
    });
  }
  return { inferences: out, unknownLines, totalLines };
}

/** Thin wrapper for call sites that only need the inferences. Extraction behavior is
 * identical to the pre-W1.5 function — the scan merely also counts what it skipped. */
export function extractGrokInferences(content: string): GrokInference[] {
  return scanGrokInferences(content).inferences;
}

/** Per-session metadata joined from summary.json + events.jsonl. */
export interface GrokSessionMeta {
  cwd: string | null;
  currentModelId: string | null;
  numMessages: number | null;
  /** turn_started events: [ts, modelId] sorted ascending — the model-attribution key. */
  turnStarts: Array<{ ts: number; modelId: string | null }>;
  /** Every turn boundary ts (started + ended) — extra activity-stream signal. */
  turnTs: number[];
}

/**
 * sid -> session directory map. Layout: ~/.grok/sessions/<urlencoded-cwd>/<sid>/ —
 * two-level walk, skipping the non-directory residents of sessions/ (the FTS sqlite
 * index lives there too). One unreadable dir never aborts the scan.
 */
export function grokSessionDirs(home: string = grokHome()): Map<string, string> {
  const out = new Map<string, string>();
  const root = join(home, "sessions");
  let cwdDirs: import("node:fs").Dirent[];
  try {
    cwdDirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const cw of cwdDirs) {
    if (!cw.isDirectory()) continue;
    const cwFull = join(root, cw.name);
    let sids: import("node:fs").Dirent[];
    try {
      sids = readdirSync(cwFull, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sids) {
      if (s.isDirectory()) out.set(s.name, join(cwFull, s.name));
    }
  }
  return out;
}

export function readGrokSessionMeta(dir: string): GrokSessionMeta {
  const meta: GrokSessionMeta = { cwd: null, currentModelId: null, numMessages: null, turnStarts: [], turnTs: [] };
  try {
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as {
      info?: { cwd?: unknown };
      cwd?: unknown;
      current_model_id?: unknown;
      num_chat_messages?: unknown;
    };
    const cwd = summary.info?.cwd ?? summary.cwd;
    if (typeof cwd === "string" && cwd) meta.cwd = cwd;
    if (typeof summary.current_model_id === "string") meta.currentModelId = summary.current_model_id;
    if (typeof summary.num_chat_messages === "number") meta.numMessages = summary.num_chat_messages;
  } catch {
    /* summary is enrichment — its absence only degrades attribution, never capture */
  }
  try {
    for (const line of readFileSync(join(dir, "events.jsonl"), "utf8").split("\n")) {
      if (!line.includes('"turn_')) continue;
      let obj: { ts?: string; type?: string; model_id?: unknown };
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = obj.ts ? Date.parse(obj.ts) : NaN;
      if (!Number.isFinite(ts)) continue;
      if (obj.type === "turn_started") {
        meta.turnStarts.push({ ts, modelId: typeof obj.model_id === "string" ? obj.model_id : null });
        meta.turnTs.push(ts);
      } else if (obj.type === "turn_ended") {
        meta.turnTs.push(ts);
      }
    }
    meta.turnStarts.sort((a, b) => a.ts - b.ts);
  } catch {
    /* no events.jsonl — model falls back to current_model_id */
  }
  return meta;
}

/**
 * Deterministic model attribution: the latest turn_started at-or-before the inference
 * timestamp owns it (inference happens inside its turn). Small clock skew tolerance:
 * an inference logged up to 2s before its turn_started still matches the next turn.
 * No turn matches -> current_model_id -> "unknown" (verbatim honesty, never guessed).
 */
export function modelForInference(
  turnStarts: Array<{ ts: number; modelId: string | null }>,
  ts: number,
  fallback: string | null,
): string {
  let model: string | null = null;
  for (const t of turnStarts) {
    // Strict bound: a turn starting EXACTLY at ts+2000 belongs to the future, not to
    // this inference — the skew window only rescues an inference logged (0, 2000)ms
    // before its own turn's start event.
    if (t.ts < ts + 2000) model = t.modelId ?? model;
    else break;
  }
  return model ?? fallback ?? "unknown";
}

/** `scanGrokCorpus`'s full result — sessions plus the W1.5 drift counters (same shape
 * as pi.ts's PiCorpusScan; sync threads the counters into local scan health). */
export interface GrokCorpusScan {
  sessions: SessionSummary[];
  unknownLines: number;
  totalLines: number;
}

/**
 * Summarize the whole Grok corpus into SessionSummary records (one per sid with at
 * least one token-accounted inference) plus drift counters. Cumulative + deterministic
 * — a re-parse of an unchanged log yields byte-identical records, so sync's digest
 * gate uploads nothing.
 */
export function scanGrokCorpus(state: TrackerState, home: string = grokHome()): GrokCorpusScan {
  let content: string;
  try {
    content = readFileSync(grokUnifiedLogPath(home), "utf8");
  } catch {
    return { sessions: [], unknownLines: 0, totalLines: 0 };
  }
  const { inferences, unknownLines, totalLines } = scanGrokInferences(content);
  if (inferences.length === 0) return { sessions: [], unknownLines, totalLines };

  const bySid = new Map<string, GrokInference[]>();
  for (const inf of inferences) {
    const arr = bySid.get(inf.sid);
    if (arr) arr.push(inf);
    else bySid.set(inf.sid, [inf]);
  }

  const dirs = grokSessionDirs(home);
  const out: SessionSummary[] = [];
  for (const [sid, infs] of bySid) {
    infs.sort((a, b) => a.ts - b.ts);
    const dir = dirs.get(sid);
    const meta = dir ? readGrokSessionMeta(dir) : { cwd: null, currentModelId: null, numMessages: null, turnStarts: [], turnTs: [] };

    const byModel = new Map<string, TokenCounts>();
    let thinkingTokens = 0;
    // Per-inference MUE + context-occupancy series (grok records per-turn token usage): reuse
    // the EXACT token mapping the model fold uses, so MUE's cActual reconciles with the session
    // total. infs is already ts-sorted (above); sessionMue/lastNonzeroOccupancy re-sort defensively
    // anyway. Each entry also carries its own turn-window model (modelForInference) for
    // context.model -- never the session-level current_model_id fallback.
    const mueSeries: OccupancySeriesEntry[] = [];
    for (const inf of infs) {
      const model = modelForInference(meta.turnStarts, inf.ts, meta.currentModelId);
      const tk = {
        input: Math.max(0, inf.prompt - inf.cached),
        output: inf.completion,
        cacheRead: inf.cached,
        cacheCreation: 0,
      };
      creditModel(byModel, model, tk);
      mueSeries.push({ tokens: tk, ts: inf.ts, model });
      thinkingTokens += inf.reasoning;
    }
    const models = foldModelBuckets(byModel);
    const tokens: TokenCounts = { ...ZERO };
    for (const m of models) addTokens(tokens, m);

    // Activity stream: inference timestamps + turn boundaries. Human turns = each
    // turn_started (a Grok turn begins from a user prompt); loops derive from real
    // recorded boundaries, never wall clock.
    const timestamps = [...infs.map((i) => i.ts), ...meta.turnTs].sort((a, b) => a - b);
    const humanTs = meta.turnStarts.map((t) => t.ts);
    const activity = computeActivity(timestamps, state.gapMs);
    const loops = computeLoops(timestamps, humanTs, state.gapMs);
    const startedAt = timestamps[0] ?? 0; // deterministic, never Date.now()

    out.push({
      tool: "grok",
      toolSessionId: sid,
      model: meta.currentModelId ?? models[0]?.id ?? "unknown",
      tokens,
      models,
      entryPoint: "unknown",
      thinkingTokens,
      // MUE (docs/model-use-efficiency.md): computable from grok's per-inference series via the
      // SAME vendor-neutral seam Claude/pi/openclaw use. Absent for short sessions.
      mue: sessionMue(mueSeries),
      // Context occupancy (lane T3): LOCAL-ONLY, last inference's own cost + turn-window model.
      context: lastNonzeroOccupancy(mueSeries),
      skills: undefined, // Grok skills capture is a future lane; absent, never faked
      agents: undefined, // no Task/subagent concept in Grok's logs
      wallMs: activity.wallMs,
      activeMs: activity.activeMs,
      idleMs: activity.idleMs,
      startedAt,
      endedAt: startedAt + activity.wallMs,
      // Repo identity: HMAC of the cwd's basename (same local-only pseudonym scheme as
      // Claude's project dir); null when the session dir/summary is gone.
      repoHash: meta.cwd ? repoHash(state.repoHmacKey, basename(meta.cwd)) : null,
      messageCount: meta.numMessages ?? infs.length,
      turns: loops.turns,
      longestLoopMs: loops.longestLoopMs,
      // Local-only cwd metadata -> orgRepo derivation in syncOnce (enrolled devices).
      cwd: meta.cwd ?? undefined,
    });
  }
  return { sessions: out, unknownLines, totalLines };
}

/** Thin wrapper matching the pre-W1.5 signature, for call sites that only need the
 * sessions (repoAttribution's local discovery). Use `scanGrokCorpus` directly where
 * the drift counters are also needed (sync.ts). */
export function summarizeGrokCorpus(state: TrackerState, home: string = grokHome()): SessionSummary[] {
  return scanGrokCorpus(state, home).sessions;
}

// ---- Grok weekly credits ("billing: fetched credits config") -----------------------------------
//
// Marco's 2026-07-19 research: the official Grok CLI logs its own billing polls (its
// internal GetGrokCreditsConfig calls) into the SAME unified.jsonl the token-capture
// above already reads. This is an UNDOCUMENTED, MUTABLE internal log — no committed spec
// file for it exists yet (no real captured sample line was found on this session's disk
// either; the fixtures this seam is pinned against are constructed from the researched
// shape, not lifted from a verified sample — flagged, not silently upgraded). Parse it
// exactly as defensively as scanGrokInferences: one bad/unrecognized line never aborts
// the scan, and any field the vendor might drop degrades to a documented null rather
// than a guess.

/** One "billing: fetched credits config" reading, parsed from ctx.config. */
export interface GrokCredits {
  /** ctx.config.creditUsagePercent, verbatim 0-100 -- null when the line omitted it
   * (SOMETIMES ABSENT per the research) or it wasn't a finite number. */
  percent: number | null;
  /** ctx.config.currentPeriod.type, verbatim (e.g. "USAGE_PERIOD_TYPE_WEEKLY"). */
  periodType: string | null;
  /** ctx.config.currentPeriod.start, verbatim ISO. */
  periodStart: string | null;
  /** ctx.config.currentPeriod.end, verbatim ISO -- the reset instant. */
  periodEnd: string | null;
  /** ctx.subscriptionTier, verbatim (e.g. "SuperGrok") -- corpus-verified 2026-07-19:
   * in every real line the tier sits at ctx level, a SIBLING of ctx.config, not inside
   * it as the original research spec claimed. ctx.config.subscriptionTier is accepted
   * as a defensive fallback only (undocumented shape -- the field may move again).
   * Null when absent everywhere; NEVER a validity gate. */
  tier: string | null;
  /** The line's own `ts`, parsed to epoch ms. Reported honestly however old -- staleness
   * judgment belongs to the RENDERER (limitsPanelLines), never to this parser. */
  observedAt: number;
}

/**
 * Parse the latest well-formed "billing: fetched credits config" line out of raw
 * unified.jsonl content. PURE: a string in, a GrokCredits (or null) out -- by
 * construction it can make no network call and can open no file, auth.json included.
 *
 * A line counts as well-formed only when periodType + periodStart + periodEnd are ALL
 * present as strings and `ts` parses to a finite epoch; creditUsagePercent AND tier are
 * BOTH allowed to degrade to null (missing, or malformed) without dropping the whole
 * line -- tier is NEVER a validity gate (corpus-corrected 2026-07-19: a percent-carrying
 * line with no tier anywhere still returns, tier: null). tier reads ctx.subscriptionTier
 * first (the real, corpus-verified location -- a sibling of ctx.config), with
 * ctx.config.subscriptionTier as the defensive fallback (the falsified original research
 * shape, kept as defense since this undocumented field may move again); ctx level wins
 * when both are present. The LAST well-formed line in file order wins -- same
 * "cumulative log, last wins" reading as parseLatestCodexRateLimits in usageView.ts. No
 * well-formed line anywhere (including an empty/no-billing-lines file) -> null, never a
 * guess. One malformed/corrupt line is skipped fail-soft, same discipline as
 * scanGrokInferences.
 */
export function parseLatestGrokCredits(content: string): GrokCredits | null {
  let latest: GrokCredits | null = null;
  for (const line of content.split("\n")) {
    if (!line.includes('"billing: fetched credits config"')) continue; // cheap pre-filter
    let obj: { ts?: unknown; msg?: unknown; ctx?: { config?: unknown; subscriptionTier?: unknown } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // corrupt candidate line -- never aborts the scan
    }
    // Marker matched inside some OTHER field: not one of our records.
    if (obj.msg !== "billing: fetched credits config") continue;
    const config = obj.ctx?.config;
    if (!config || typeof config !== "object") continue;
    const c = config as Record<string, unknown>;
    const period = c.currentPeriod;
    if (!period || typeof period !== "object") continue;
    const p = period as Record<string, unknown>;
    const periodType = typeof p.type === "string" ? p.type : null;
    const periodStart = typeof p.start === "string" ? p.start : null;
    const periodEnd = typeof p.end === "string" ? p.end : null;
    if (periodType === null || periodStart === null || periodEnd === null) continue;
    const observedAt = typeof obj.ts === "string" ? Date.parse(obj.ts) : NaN;
    if (!Number.isFinite(observedAt)) continue; // an unparseable ts degrades the WHOLE line
    // Tier: ctx level primarily (the corpus-verified location), config level as the
    // defensive fallback; null when absent everywhere -- never drops the line.
    const ctxTier = obj.ctx?.subscriptionTier;
    const tier =
      typeof ctxTier === "string" ? ctxTier : typeof c.subscriptionTier === "string" ? c.subscriptionTier : null;
    const rawPercent = c.creditUsagePercent;
    const percent = typeof rawPercent === "number" && Number.isFinite(rawPercent) ? rawPercent : null;
    latest = { percent, periodType, periodStart, periodEnd, tier, observedAt };
  }
  return latest;
}

/**
 * Thin disk wrapper: reads grokUnifiedLogPath(home) -- the ONE path it ever touches,
 * never auth.json, never any other file under home -- and delegates to
 * parseLatestGrokCredits. Missing/unreadable file -> null, fail soft, same as
 * readLatestCodexRateLimits.
 */
export function readLatestGrokCredits(home: string = grokHome()): GrokCredits | null {
  try {
    return parseLatestGrokCredits(readFileSync(grokUnifiedLogPath(home), "utf8"));
  } catch {
    return null;
  }
}
