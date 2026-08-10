/**
 * pi.dev coding agent ("pi") capture — Wave 1 of docs/harness-adapters-implementation.md
 * (task W1.2). PARSER ONLY: sync wiring (cursors, dedupe key, digest gate) is a
 * separate task (W1.3) and does not live here.
 *
 * PROVENANCE / CONFIDENCE (read before trusting a field below): no `~/.pi` install
 * exists on this dev machine (per the implementation plan) — every shape here is
 * DOCS-DERIVED, PENDING W1.0 REAL-CORPUS VALIDATION. Sources, both fetched 2026-07-13:
 *   - https://pi.dev/docs/latest/sessions and its linked
 *     https://pi.dev/docs/latest/session-format (pi's official docs site).
 *   - github.com/badlogic/pi-mono, packages/coding-agent/docs/session-format.md — the
 *     open-source project's own reference doc (pi is `earendil-works/pi`, published as
 *     `@mariozechner/pi-coding-agent`). This is the file the docs site itself is
 *     generated from, and is treated as the stronger source of the two: it is the
 *     literal schema description in the repo, not a marketing page. Field names below
 *     were cross-checked across two independent fetches of this file and agreed.
 * Any field NOT corroborated by the second (source-repo) fetch is called out inline as
 * an open gap rather than asserted. NEVER treat anything here as confirmed until W1.0's
 * real corpus (docs/pi-capture-notes.md) is captured and W1.6's eval runs against it.
 *
 * On-disk format (docs-derived):
 *   - `~/.pi/agent/sessions/--<cwd, "/" -> "-">--/<timestamp>_<uuid>.jsonl` — ONE JSONL
 *     file per session, organized by working directory. Unlike Grok's two-source split
 *     (grok.ts), this is architecturally closer to Codex (codex.ts): one file IS one
 *     session, so there is no cross-file resume/fork dedup to run here.
 *   - First line is a header with NO id/parentId:
 *     `{"type":"session","version":<n>,"id":"<uuid>","timestamp":"<ISO>","cwd":"<path>"}`.
 *     `id` is the session id (our `toolSessionId`); `cwd` is the working directory (the
 *     `repoHash` input — raw cwd never leaves this function, let alone the machine).
 *   - Every subsequent entry extends `{type,id,parentId,timestamp}` and is one of the
 *     documented types: message | model_change | thinking_level_change | label |
 *     compaction | branch_summary | custom | custom_message | session_info. Entries
 *     form a TREE (id/parentId) for pi's own branching/"rewind" UI. We deliberately do
 *     NOT walk the tree: every `message` entry in the file is, per docs, a genuinely
 *     distinct API call — branching appends a NEW sibling entry with its own `id`, not
 *     a byte-identical replay of an existing one — so a flat linear scan sums real,
 *     non-duplicated token atoms exactly once each.
 *     GAP (pending W1.0): if a real corpus shows `/rewind` or session-resume ever
 *     duplicating an entry's tokens under a new `id` (the way Claude's resume/fork
 *     replays a message across sibling FILES), this assumption breaks and needs a
 *     dedup pass like jsonl.ts's `ClaudeUsageDeduper`. Nothing here builds one
 *     preemptively — that would be inventing semantics no doc describes.
 *   - `message.role` is one of `"user" | "assistant" | "toolResult" | "bashExecution" |
 *     "custom" | "branchSummary" | "compactionSummary"`. Only `"assistant"` messages
 *     carry a `usage` object; the others are turn/tool plumbing with no token data.
 *   - Assistant message fields (docs-derived): `content` (array of text/thinking/
 *     tool-call blocks — never read here), `api`, `provider`, `model` (string — the
 *     model that PRODUCED this specific message), `usage: {input, output, cacheRead,
 *     cacheWrite, totalTokens, cost:{...}}`, `stopReason`, and its OWN `timestamp`
 *     (Unix ms — distinct from the entry's own ISO `timestamp` string one level up).
 *   - `model_change` entries `{provider, modelId}` mark the active model going
 *     forward — the SAME "turn_started" idiom grok.ts uses for attribution windows.
 *     Each assistant usage entry is credited to the latest `model_change` at-or-before
 *     its own timestamp (2s skew tolerance, identical constant to grok.ts's
 *     `modelForInference`), falling back to the entry's OWN `message.model` when no
 *     window covers it (a fallback Grok's transcript never offers — pi stamps the
 *     producing model on every assistant message per docs), then to `"unknown"`.
 *
 * Token mapping (pi's `usage` object -> our `TokenCounts`): `input` -> input, `output`
 * -> output, `cacheRead` -> cacheRead, `cacheWrite` -> cacheCreation (name-for-name; no
 * clamping/subtraction arithmetic needed here — unlike Grok/Codex, pi's docs describe
 * `input`/`output` as already net of cache, not a "prompt_tokens inclusive of cache"
 * convention). REAL COUNTERS ONLY: an assistant entry without NUMERIC `input` AND
 * `output` is SKIPPED, never estimated (covers pre-instrumentation builds, partial
 * writes, and any provider that fails to report usage). `totalTokens` is a documented
 * redundant total; it is never read here, not even to cross-check the per-field sum —
 * there is no documented guarantee it equals input+output+cache*.
 *
 * thinkingTokens: the docs describe no reasoning counter, but the REAL corpus does —
 * W1.0 finding (2026-07-14, pi 0.80.6, openai-codex provider): assistant `usage`
 * carries a numeric `reasoning` field, and raw arithmetic shows it sits OUTSIDE
 * input/output/totalTokens (a separate meter, so summing it into thinkingTokens
 * double-counts nothing). Mapped `usage.reasoning` -> thinkingTokens, numeric-only,
 * never estimated from `thinking` content blocks (text, not a token count). The
 * docs-vs-disk delta is recorded in docs/pi-capture-notes.md.
 *
 * entryPoint: no alternate entry point (vscode/desktop/etc.) is documented anywhere in
 * the fetched sources — pi ships as a terminal coding agent. GAP (pending W1.0/further
 * docs research if pi grows an IDE integration): entryPoint is hardcoded `"cli"`,
 * mirroring codex.ts's default before any override signal is known to exist.
 *
 * skills / agents: no documented skill-invocation or subagent-dispatch signal exists
 * in pi's session format (v1) — both fields are always `undefined` on the emitted
 * `SessionSummary`, the same "omitted, never faked" contract grok.ts uses.
 *
 * Fingerprint (`isOfficialPiCli`): pi's docs expose no unique proprietary CONTENT
 * string comparable to Grok's xAI-proxy-domain mark (no equivalent of
 * `models_cache.json` pinning `api.x.ai`). The chosen mark is therefore STRUCTURAL,
 * not content-based: `agent/sessions/` must contain at least one directory matching
 * the documented `--...--`-wrapped cwd encoding, containing at least one `.jsonl` file
 * whose FIRST LINE parses as the documented session header shape (`type:"session"`,
 * numeric `version`, non-empty `id`, a parseable `timestamp`, string `cwd`).
 * WEAKNESS — now a PROVEN collision, not a possibility (fork research 2026-07-14,
 * findings in the maintenance runbook §6): upstream white-labels its home dir by
 * design (package.json `piConfig.configDir`), and one DISTRIBUTED fork,
 * `@caupulican/pi-adaptative` (~18.5k npm dl/mo vs official's ~6.8M), keeps
 * `configDir: ".pi"` AND installs a bin named `pi` — its sessions are structurally
 * indistinguishable from official here. "oh-my-pi" (the larger fork, ~238k dl/mo) is
 * confirmed SAFE: its dirs.ts hardcodes `.omp`. The session bytes carry no producer
 * mark (header `version` is the FORMAT version), so this gate cannot be hardened from
 * session content; the recorded mitigations are the W1.5 drift tripwire (a
 * semantics-drifted fork trips unknownLines; a byte-compatible fork has, by
 * definition, un-drifted token semantics) and a possible future device-level
 * provenance probe (resolve the installed `pi` bin's package name — identifies the
 * install, not each historical session's author). Also recorded: upstream honors
 * PI_CODING_AGENT_DIR / --session-dir relocations we do not follow — a relocated
 * official install is under-captured, never mis-captured.
 *
 * Model attribution, day-slicing, and the fingerprint gate are exported separately
 * from `summarizePiCorpus` and are NOT invoked by it internally — exactly grok.ts's
 * split. The gate is the CALLER's responsibility (the sync provider block, W1.3),
 * mirroring how sync.ts calls `isOfficialGrokCli()` before `summarizeGrokCorpus()`.
 */
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { creditModel, foldModelBuckets, addTokens, ZERO } from "./jsonl.js";
import { sessionMue, lastNonzeroOccupancy } from "./contextEfficiency.js";
import { computeActivity, computeLoops, sliceActivityByDay, utcDayKey, type ActivityDaySlice } from "./activity.js";
import { repoHash, type TrackerState } from "./config.js";
import type { SessionSummary, SessionDaySlice, TokenCounts } from "./types.js";

export function piHome(): string {
  return process.env.DF_PI_HOME ?? join(homedir(), ".pi");
}

export function piSessionsRoot(home: string = piHome()): string {
  return join(home, "agent", "sessions");
}

/** Documented dir-naming convention: cwd with "/" -> "-", wrapped in a leading/trailing "--". */
const CWD_DIR_RE = /^--.*--$/;

/** Known top-level `type` values per the session-format doc. Anything else (or a line
 * that fails to parse at all) is drift/damage and is counted, never silently dropped. */
const KNOWN_ENTRY_TYPES = new Set([
  "session",
  "message",
  "model_change",
  "thinking_level_change",
  "label",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "session_info",
]);

interface SessionHeader {
  id: string;
  cwd: string | null;
  version: number;
}

/** Parse (and validate the shape of) a session file's first line. Returns null for
 * anything that doesn't match the documented header — never guessed, never partial. */
function parseHeaderLine(line: string): SessionHeader | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const o = obj as Record<string, unknown>;
  if (o?.type !== "session") return null;
  if (typeof o.id !== "string" || !o.id) return null;
  if (typeof o.version !== "number") return null;
  if (typeof o.timestamp !== "string" || !Number.isFinite(Date.parse(o.timestamp))) return null;
  return { id: o.id, cwd: typeof o.cwd === "string" ? o.cwd : null, version: o.version };
}

/**
 * Is `home` an official pi CLI home? Structural fingerprint (see file header for why
 * this is weaker than Grok's content mark, and its recorded weakness): at least one
 * `--cwd--`-named directory under `agent/sessions/` must contain at least one `.jsonl`
 * file whose first line matches the documented session header shape. No mark -> we
 * capture NOTHING from this tree (never guess which product wrote a file).
 */
export function isOfficialPiCli(home: string = piHome()): boolean {
  const root = piSessionsRoot(home);
  let cwdDirs: Dirent[];
  try {
    cwdDirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const d of cwdDirs) {
    if (!d.isDirectory() || !CWD_DIR_RE.test(d.name)) continue;
    const full = join(root, d.name);
    let files: string[];
    try {
      files = readdirSync(full).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      let firstLine: string;
      try {
        firstLine = readFileSync(join(full, f), "utf8").split("\n", 1)[0] ?? "";
      } catch {
        continue;
      }
      if (parseHeaderLine(firstLine)) return true;
    }
  }
  return false;
}

/** One session file discovered under `agent/sessions/`. */
export interface PiSessionFile {
  path: string;
}

/**
 * All session `.jsonl` files under `agent/sessions/`, one level of cwd-subdirectories
 * deep (per docs) — a looser walk than the fingerprint (no name-shape requirement),
 * mirroring grok.ts's split between `isOfficialGrokCli` (strict marks) and
 * `grokSessionDirs` (loose, walks whatever is actually there). One unreadable
 * directory never aborts the scan.
 */
export function piSessionFiles(home: string = piHome()): PiSessionFile[] {
  const root = piSessionsRoot(home);
  const out: PiSessionFile[] = [];
  let cwdDirs: Dirent[];
  try {
    cwdDirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of cwdDirs) {
    if (!d.isDirectory()) continue;
    const full = join(root, d.name);
    let files: string[];
    try {
      files = readdirSync(full);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith(".jsonl")) out.push({ path: join(full, f) });
    }
  }
  return out;
}

/** A `model_change` entry: {ts, provider, modelId} — the attribution-window marker. */
export interface PiModelChange {
  ts: number;
  provider: string | null;
  modelId: string | null;
}

/**
 * Deterministic model attribution: the latest `model_change` at-or-before the usage
 * entry's timestamp owns it (same 2s clock-skew tolerance idiom as grok.ts's
 * `modelForInference` — an entry logged up to 2s before its own model_change's start
 * still matches). No window covers it -> the entry's OWN `message.model` (pi always
 * stamps the producing model, a fallback Grok's transcript doesn't offer) -> else
 * "unknown" (verbatim honesty, never guessed).
 */
export function modelForPiEntry(
  modelChanges: PiModelChange[],
  ts: number,
  ownModel: string | null,
): string {
  let model: string | null = null;
  for (const c of modelChanges) {
    if (c.ts < ts + 2000) model = c.modelId ?? model;
    else break;
  }
  return model ?? ownModel ?? "unknown";
}

/** One real, token-accounted, model-resolved assistant message. */
interface ResolvedUsage {
  ts: number;
  model: string;
  tokens: TokenCounts;
}

/** Raw per-entry usage atom before model-window resolution. */
interface RawUsage {
  ts: number;
  tokens: TokenCounts;
  ownModel: string | null;
}

/** Everything extracted from one session file's raw content. */
export interface PiFileAtoms {
  sessionId: string | null;
  cwd: string | null;
  /** Real, token-accounted, model-resolved assistant usage, sorted by ts ascending. */
  usage: ResolvedUsage[];
  /** Every dated entry (session header + all typed entries) — the activity stream. */
  timestamps: number[];
  /** `message.role === "user"` entries — turns. */
  humanPromptTimestamps: number[];
  /** Every assistant message OBSERVED, whether or not it carried usable token data
   * (a message that skipped token crediting for missing usage still represents a
   * real assistant turn — matches the SessionSummary field's own doc comment). */
  messageCount: number;
  /** Lines that failed to JSON.parse OR carried an unrecognized top-level `type` —
   * drift input for W1.5 (the drift-plumbing task), exposed here so nothing silently
   * vanishes. One combined counter, same as the W1.5 spec's `unknownLines` contract. */
  unknownLines: number;
  /** Every non-blank line seen, for computing the W1.5 drift RATE (unknownLines / totalLines). */
  totalLines: number;
  /** Sum of `usage.reasoning` across token-accounted assistant messages. The docs never
   * mention this field; the REAL corpus does (W1.0 finding, 2026-07-14) — see the
   * thinkingTokens note in the file header. */
  thinkingTokens: number;
}

/**
 * Parse one session file's content. Defensive line-by-line: a corrupt line or an
 * unrecognized entry type is counted and skipped, never fatal to the rest of the file.
 */
export function parsePiSessionFile(content: string): PiFileAtoms {
  const out: PiFileAtoms = {
    sessionId: null,
    cwd: null,
    usage: [],
    timestamps: [],
    humanPromptTimestamps: [],
    messageCount: 0,
    unknownLines: 0,
    totalLines: 0,
    thinkingTokens: 0,
  };
  const modelChanges: PiModelChange[] = [];
  const rawUsage: RawUsage[] = [];
  let sawHeader = false;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.totalLines++;

    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      out.unknownLines++; // a corrupt line is drift/damage — same bucket as an unrecognized type
      continue;
    }
    const type = entry?.type;
    if (typeof type !== "string" || !KNOWN_ENTRY_TYPES.has(type)) {
      out.unknownLines++;
      continue;
    }

    const entryTs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;

    if (type === "session") {
      if (!sawHeader) {
        sawHeader = true;
        if (typeof entry.id === "string" && entry.id) out.sessionId = entry.id;
        if (typeof entry.cwd === "string" && entry.cwd) out.cwd = entry.cwd;
      }
      if (Number.isFinite(entryTs)) out.timestamps.push(entryTs);
      continue;
    }

    if (Number.isFinite(entryTs)) out.timestamps.push(entryTs);

    if (type === "model_change") {
      if (Number.isFinite(entryTs)) {
        modelChanges.push({
          ts: entryTs,
          provider: typeof entry.provider === "string" ? entry.provider : null,
          modelId: typeof entry.modelId === "string" ? entry.modelId : null,
        });
      }
      continue;
    }

    if (type !== "message") continue; // thinking_level_change/label/compaction/branch_summary/
    // custom/custom_message/session_info: known, no tokens -- skip.

    const message = entry.message;
    const role = message?.role;
    if (role === "user") {
      if (Number.isFinite(entryTs)) out.humanPromptTimestamps.push(entryTs);
      continue;
    }
    if (role !== "assistant") continue; // toolResult/bashExecution/custom/branchSummary/compactionSummary

    out.messageCount++;
    const usage = message?.usage;
    const input = usage?.input;
    const output = usage?.output;
    if (typeof input !== "number" || typeof output !== "number") {
      // REAL counters only — and their ABSENCE on an assistant message is itself a
      // drift signal, not background noise: pi's format documents usage on every
      // assistant message, so a renamed token field (usage.input -> anything) or a
      // vanished usage object would otherwise zero this provider silently, which is
      // exactly the failure mode the counter exists to surface (a partial write
      // lands in the same bucket; it is rare enough to stay under the threshold).
      out.unknownLines++;
      continue;
    }

    // message.timestamp is documented as Unix ms -- distinct from the entry's own ISO
    // `timestamp` string one level up. Prefer it (the actual generation moment); fall
    // back to the entry timestamp when absent/non-numeric.
    const msgTs = typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? message.timestamp
      : entryTs;
    if (!Number.isFinite(msgTs)) continue; // no usable timestamp -- can't attribute a window or a day

    rawUsage.push({
      ts: msgTs,
      tokens: {
        input: Math.max(0, input),
        output: Math.max(0, output),
        cacheRead: Math.max(0, typeof usage.cacheRead === "number" ? usage.cacheRead : 0),
        cacheCreation: Math.max(0, typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0),
      },
      ownModel: typeof message.model === "string" && message.model ? message.model : null,
    });
    // W1.0 corpus finding (2026-07-14): real v3 sessions carry `usage.reasoning` — a
    // vendor token COUNT the docs never mention, sitting OUTSIDE input/output/totalTokens
    // (verified against raw arithmetic: totalTokens never includes it). Same real-counter
    // rule as every field above: numeric or nothing, never estimated.
    if (typeof usage.reasoning === "number" && Number.isFinite(usage.reasoning)) {
      out.thinkingTokens += Math.max(0, usage.reasoning);
    }
  }

  modelChanges.sort((a, b) => a.ts - b.ts);
  rawUsage.sort((a, b) => a.ts - b.ts);
  for (const r of rawUsage) {
    out.usage.push({ ts: r.ts, model: modelForPiEntry(modelChanges, r.ts, r.ownModel), tokens: r.tokens });
  }
  out.timestamps.sort((a, b) => a - b);
  out.humanPromptTimestamps.sort((a, b) => a - b);
  return out;
}

/**
 * Assemble wire day-slices (day-attribution Fix A) from the SAME crediting walk
 * sync.ts's `buildDaySlices` uses for Claude: activity quanta clipped at midnights
 * (`sliceActivityByDay`), and real per-entry usage bucketed by ITS OWN timestamp's UTC
 * day. Unlike Claude, pi's usage atoms never carry an unparseable timestamp by the
 * time they reach here (parsePiSessionFile already drops anything without one before
 * pushing to `usage`), so there is no "" orphan bucket to merge — every atom already
 * has a real day. Returns undefined for single-day sessions (byte-identity with the
 * pre-slice digest, same rule as every other provider).
 */
function buildPiDaySlices(
  activityDays: Map<string, ActivityDaySlice>,
  usage: ResolvedUsage[],
): SessionDaySlice[] | undefined {
  const tokensByDay = new Map<string, Map<string, TokenCounts>>();
  for (const u of usage) {
    const day = utcDayKey(u.ts);
    let dayModels = tokensByDay.get(day);
    if (!dayModels) {
      dayModels = new Map();
      tokensByDay.set(day, dayModels);
    }
    creditModel(dayModels, u.model, u.tokens);
  }

  const dayKeys = new Set<string>([...activityDays.keys(), ...tokensByDay.keys()]);
  if (dayKeys.size < 2) return undefined;

  return [...dayKeys].sort().map((day) => {
    const a = activityDays.get(day) ?? { activeMs: 0, idleMs: 0 };
    const dayModels = tokensByDay.get(day) ? foldModelBuckets(tokensByDay.get(day)!) : [];
    const tokens: TokenCounts = { ...ZERO };
    for (const m of dayModels) addTokens(tokens, m);
    return {
      day,
      activeMs: a.activeMs,
      idleMs: a.idleMs,
      tokens,
      ...(dayModels.length ? { models: dayModels } : {}),
    };
  });
}

/** `scanPiCorpus`'s full result — sessions plus the W1.5 drift-plumbing counters,
 * summed across every file in the corpus (parallel export per the W1.2 accept
 * criteria; W1.5 wires the threshold/warning logic on top of this). */
export interface PiCorpusScan {
  sessions: SessionSummary[];
  unknownLines: number;
  totalLines: number;
  /** Files statSync could see but readFileSync could not deliver (Windows lock,
   * delete race). The caller must NOT advance a byte cursor for these — one pi file
   * is one whole session that never grows after completion, so a cursor written
   * for an unread file would skip that session forever. */
  readFailures: string[];
}

/**
 * Summarize the whole pi corpus into SessionSummary records (one per session file with
 * at least one real, token-accounted assistant message) plus drift-plumbing counters.
 * Cumulative + deterministic: a re-parse of an unchanged file yields a byte-identical
 * record, so sync's digest gate (W1.3) uploads nothing for it. Does NOT check
 * `isOfficialPiCli` itself -- that gate is the CALLER's responsibility (mirrors
 * grok.ts's `summarizeGrokCorpus`, which sync.ts gates externally).
 */
export function scanPiCorpus(state: TrackerState, home: string = piHome()): PiCorpusScan {
  // Keyed by toolSessionId: a ~/.pi tree copied across machines (or a session file
  // duplicated across --cwd-- dirs) can present the same session id twice, and two
  // summaries under one digest key would race nondeterministically. Deterministic
  // winner: later endedAt, then larger token total — the more complete record.
  const bySession = new Map<string, SessionSummary>();
  let unknownLines = 0;
  let totalLines = 0;
  const readFailures: string[] = [];

  for (const file of piSessionFiles(home)) {
    let content: string;
    try {
      content = readFileSync(file.path, "utf8");
    } catch {
      readFailures.push(file.path); // one unreadable file never aborts the scan — but its cursor must not advance
      continue;
    }
    const atoms = parsePiSessionFile(content);
    unknownLines += atoms.unknownLines;
    totalLines += atoms.totalLines;
    if (atoms.usage.length === 0) continue; // no real-token-accounted entries -- nothing to report

    const byModel = new Map<string, TokenCounts>();
    for (const u of atoms.usage) creditModel(byModel, u.model, u.tokens);
    const models = foldModelBuckets(byModel);
    const tokens: TokenCounts = { ...ZERO };
    for (const m of models) addTokens(tokens, m);

    // Timestamp pool for activity/dating: entry-level timestamps when present; when
    // every entry-level ISO string is absent/malformed but usage atoms carried the
    // documented message-level Unix-ms timestamp, THOSE date the session — a record
    // with real tokens must never report startedAt=0 (epoch 1970 misdates the day
    // attribution and trips zero-active-time-with-tokens plausibility gates).
    const tsPool = atoms.timestamps.length > 0 ? atoms.timestamps : atoms.usage.map((u) => u.ts).sort((a, b) => a - b);
    const activity = computeActivity(tsPool, state.gapMs);
    const loops = computeLoops(tsPool, atoms.humanPromptTimestamps, state.gapMs);
    // Deterministic no-timestamp fallback (never Date.now()): capture is a pure
    // function of the transcript so an unchanged file re-parses byte-identical.
    const startedAt = tsPool[0] ?? 0;
    const activityDays = sliceActivityByDay(tsPool, state.gapMs);
    const days = buildPiDaySlices(activityDays, atoms.usage);

    const summary: SessionSummary = {
      tool: "pi",
      toolSessionId: atoms.sessionId ?? basename(file.path).replace(/\.jsonl$/, ""),
      model: atoms.usage[atoms.usage.length - 1]?.model ?? models[0]?.id ?? "unknown",
      tokens,
      models,
      entryPoint: "cli", // no alternate entry point documented for pi -- see file header
      thinkingTokens: atoms.thinkingTokens, // usage.reasoning, summed — W1.0 corpus finding (see header)
      // MUE (docs/model-use-efficiency.md): pi records per-message token usage, so the exponent
      // is computable — the SAME vendor-neutral seam Claude uses. Absent for short sessions.
      mue: sessionMue(atoms.usage),
      // Context occupancy (lane T3): LOCAL-ONLY, last message's own cost + model_change window.
      context: lastNonzeroOccupancy(atoms.usage),
      days,
      skills: undefined, // no documented skill-invocation signal in pi's session format (v1)
      agents: undefined, // no documented subagent-dispatch concept in pi's session format (v1)
      wallMs: activity.wallMs,
      activeMs: activity.activeMs,
      idleMs: activity.idleMs,
      startedAt,
      endedAt: startedAt + activity.wallMs,
      // Repo identity: HMAC of the cwd's basename -- the same local-only pseudonym
      // scheme grok.ts/Claude use. null when the header never carried a cwd.
      repoHash: atoms.cwd ? repoHash(state.repoHmacKey, basename(atoms.cwd)) : null,
      messageCount: atoms.messageCount,
      turns: loops.turns,
      longestLoopMs: loops.longestLoopMs,
      // Local-only cwd metadata -> orgRepo derivation in syncOnce (enrolled devices).
      cwd: atoms.cwd ?? undefined,
    };
    const prior = bySession.get(summary.toolSessionId);
    const total = (s: SessionSummary) => s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheCreation;
    if (!prior || summary.endedAt > prior.endedAt || (summary.endedAt === prior.endedAt && total(summary) > total(prior))) {
      bySession.set(summary.toolSessionId, summary);
    }
  }
  return { sessions: [...bySession.values()], unknownLines, totalLines, readFailures };
}

/** Thin wrapper matching grok.ts's `summarizeGrokCorpus(state, home)` signature, for
 * call sites that only need the sessions. Sync itself calls `scanPiCorpus` directly
 * (W1.5): the drift counters ride the same single scan instead of being discarded. */
export function summarizePiCorpus(state: TrackerState, home: string = piHome()): SessionSummary[] {
  return scanPiCorpus(state, home).sessions;
}
