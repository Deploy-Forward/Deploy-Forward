/**
 * Claude Code transcript JSONL parser.
 *
 * Reads ~/.claude/projects/<project>/<session>.jsonl and extracts, per session:
 * token usage (per-message atoms deduped to the Deploy Forward Atomic Capture Standard,
 * plus per-model buckets) and message timestamps (for the active/idle estimate). It
 * deliberately reads ONLY usage numbers, model names, timestamps, and observable token
 * COUNTS (thinking tokens are captured as a number only) — never the message content,
 * thinking text, or tool inputs.
 *
 * Two layers: extractClaudeAtoms() pulls RAW per-message usage entries from one file
 * (no dedup — sync.ts runs the GLOBAL cross-file dedup over all files' atoms), and
 * parseTranscript() composes extract + single-file dedup for standalone use.
 *
 * The transcript schema is internal to Claude Code and drifts across versions, so
 * every field access is defensive: an unrecognized line is skipped, never fatal.
 */
import type { EntryPoint, ModelTokens, SessionContext, SkillCount, TokenCounts } from "./types";

export interface ParsedTranscript {
  toolSessionId: string | null;
  model: string;
  tokens: TokenCounts;
  /** Per-model token buckets. Same dedup as `tokens`; model ids are transcript-verbatim. */
  models: ModelTokens[];
  /** Best-effort transcript/runtime entry point. Status only, never scored. */
  entryPoint: EntryPoint;
  /** Observable reasoning/thinking token count where present. Status only, never scored. */
  thinkingTokens: number;
  /**
   * Skill/command invocations: normalized NAMES + counts only, plumbing excluded.
   * Mirrors the model-mix pipeline (status + aggregate, never scored). Empty for sessions
   * with no skill use.
   */
  skills: SkillCount[];
  /**
   * Subagent dispatches (Task tool_use `subagent_type`): normalized NAMES + counts only —
   * never the prompt. A SEPARATE field from skills, permanently: the server's
   * skills-vs-turns plausibility gate and the practice display assume skills are skills.
   * Empty for sessions that never delegated.
   */
  agents: SkillCount[];
  /** ISO->epoch ms of every dated entry, ascending. Drives the activity estimate. */
  timestamps: number[];
  /** ISO->epoch ms of every human/user prompt, ascending. Drives turns + longestLoop. */
  humanPromptTimestamps: number[];
  messageCount: number;
  lastMessageUuid: string | null;
  /** Lines that failed to JSON-parse. (Parseable lines with no usage are normal --
   * user messages, progress events -- and are deliberately NOT counted here.) */
  skipped: number;
  /** Every non-blank line seen -- the W1.5 drift-rate denominator (skipped/totalLines).
   * See providers.ts for why parse failures are the ONLY unknown signal these two
   * undocumented formats can honestly count. */
  totalLines: number;
  /**
   * Codex-only: the `cwd` recorded in the rollout's session_meta line. Undefined for
   * Claude transcripts (which carry no such field -- the Claude project label instead
   * comes from the transcript's PARENT DIRECTORY name, see usageView.ts) and for Codex
   * rollouts whose session_meta line predates this field or omitted it.
   */
  cwd?: string;
  /**
   * Codex-only: per-event token DELTAS with the line's own timestamp -- the SAME per-turn
   * deltas already credited into `models` (see codex.ts header), just also kept as discrete
   * timestamped events so `usage --by-day` can bucket Codex usage by calendar date without
   * re-deriving the cumulative-snapshot math. Undefined/empty for Claude, whose day-fold
   * reads extractClaudeAtoms usage entries directly instead of this field.
   */
  usageEvents?: { ts: number; model: string; tokens: TokenCounts }[];
  /**
   * Codex-only (lane T3): the FINAL `token_count` event's own `last_token_usage` /
   * `model_context_window`, parsed independently of the cumulative `tokens` total above —
   * see codex.ts's header for the cache-inclusive-vs-netted split. Undefined when no
   * `token_count` event ever carried `last_token_usage` (fail-soft, never a guess) — and
   * always for Claude, which has no such registry field.
   */
  context?: SessionContext;
}

export const ZERO: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

export function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function addTokens(into: TokenCounts, u: TokenCounts): void {
  into.input += u.input;
  into.output += u.output;
  into.cacheRead += u.cacheRead;
  into.cacheCreation += u.cacheCreation;
}

/** Accumulate usage into a per-model bucket map. */
export function creditModel(byModel: Map<string, TokenCounts>, id: string, u: TokenCounts): void {
  const prev = byModel.get(id);
  if (prev) addTokens(prev, u);
  else byModel.set(id, { ...u });
}

/**
 * Fold the per-model accumulator into the wire array — VERBATIM (capture standard §2).
 * Every model id at full length, `<synthetic>` kept, no cap, no "other" fold, no
 * truncation. Display shortening/capping is the render layer's job; `<synthetic>`/alias
 * normalization is the pricing layer's; the fabricated-id abuse bound is trust's.
 */
export function foldModelBuckets(byModel: Map<string, TokenCounts>): ModelTokens[] {
  return [...byModel.entries()].map(([id, t]) => ({ id, ...t }));
}

export interface ClaudeUsageEntry {
  timestamp: string | null;
  uuid: string | null;
  sessionId: string | undefined;
  version: string | undefined;
  messageId: string | undefined;
  requestId: string | undefined;
  model: string | undefined;
  isSidechain: boolean | undefined;
  hasSpeed: boolean;
  cost: number;
  entryPoint: EntryPoint;
  thinkingTokens: number;
  tokens: TokenCounts;
}

function semverPrefix(value: string): boolean {
  return /^\d+\.\d+\.\d/.test(value);
}

export function isValidClaudeUsageEntry(entry: ClaudeUsageEntry): boolean {
  if (entry.version !== undefined && !semverPrefix(entry.version)) return false;
  if (entry.sessionId !== undefined && entry.sessionId === "") return false;
  if (entry.requestId !== undefined && entry.requestId === "") return false;
  if (entry.messageId !== undefined && entry.messageId === "") return false;
  if (entry.model !== undefined && entry.model === "") return false;
  return true;
}

function totalTokens(tokens: TokenCounts): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
}

function isSidechain(entry: ClaudeUsageEntry): boolean {
  return entry.isSidechain === true;
}

export function shouldReplaceDedupedClaudeUsageEntry(
  candidate: ClaudeUsageEntry,
  existing: ClaudeUsageEntry,
): boolean {
  const candidateSidechain = isSidechain(candidate);
  const existingSidechain = isSidechain(existing);
  if (candidateSidechain !== existingSidechain) return existingSidechain;

  const candidateTotal = totalTokens(candidate.tokens);
  const existingTotal = totalTokens(existing.tokens);
  if (candidateTotal !== existingTotal) return candidateTotal > existingTotal;
  if (candidate.cost !== existing.cost) return candidate.cost > existing.cost;
  return candidate.hasSpeed && !existing.hasSpeed;
}

/**
 * The capture standard's dedup fold, usable at BOTH grains: per-file (parseTranscript)
 * and globally across every file in the corpus (sync.ts — the reconciliation step).
 *
 * Semantics are exactly the steward reference's two-tier lookup (ccusage
 * push_deduped_daily_entry): the validity gate pre-filters every entry; an entry with no
 * messageId is kept as-is (never deduped); the exact (messageId, requestId) tier is tried
 * first; the msgid-only fallback fires ONLY when at least one side is a sidechain; a hit
 * replaces the WHOLE record via max-wins. The per-messageId index only accelerates the
 * reference's linear scan — both tiers require messageId equality, so scanning the
 * messageId's own insertion-ordered bucket visits the same candidates in the same order.
 *
 * `owner` is first-occurrence lineage (which thread a surviving message belongs to): a
 * replacement upgrades the record's CONTENT but never moves its owner, so thread
 * assignment can never change a total.
 */
export class ClaudeUsageDeduper<TOwner = undefined> {
  private records: { entry: ClaudeUsageEntry; owner: TOwner }[] = [];
  private byMessageId = new Map<string, number[]>();

  push(entry: ClaudeUsageEntry, owner: TOwner): void {
    if (!isValidClaudeUsageEntry(entry)) return;
    if (entry.messageId === undefined) {
      this.records.push({ entry, owner }); // counted as-is, never deduped
      return;
    }
    let bucket = this.byMessageId.get(entry.messageId);
    if (!bucket) {
      bucket = [];
      this.byMessageId.set(entry.messageId, bucket);
    }
    // Exact tier: (messageId, requestId) — absent requestId matches absent.
    for (const i of bucket) {
      if (this.records[i].entry.requestId === entry.requestId) {
        this.replaceIfWins(i, entry);
        return;
      }
    }
    // Fallback tier: messageId alone, ONLY when at least one side is a sidechain
    // (a parent message replayed inside a sidechain arrives with a NEW requestId).
    for (const i of bucket) {
      if (isSidechain(entry) || isSidechain(this.records[i].entry)) {
        this.replaceIfWins(i, entry);
        return;
      }
    }
    bucket.push(this.records.length);
    this.records.push({ entry, owner });
  }

  private replaceIfWins(index: number, entry: ClaudeUsageEntry): void {
    if (shouldReplaceDedupedClaudeUsageEntry(entry, this.records[index].entry)) {
      // Whole-record max-wins; the first-occurrence owner is lineage and never moves.
      this.records[index] = { entry, owner: this.records[index].owner };
    }
  }

  results(): readonly { entry: ClaudeUsageEntry; owner: TOwner }[] {
    return this.records;
  }
}

export function dedupeClaudeUsageEntries(entries: ClaudeUsageEntry[]): ClaudeUsageEntry[] {
  const deduper = new ClaudeUsageDeduper();
  for (const entry of entries) deduper.push(entry, undefined);
  return deduper.results().map((r) => r.entry);
}

// ---- Skills signal (0.4.0) -----------------------------------------------------------------
//
// MIRRORS the model-mix pipeline exactly (same three-layer boundary: scored stays skill-blind,
// status is skill-honest, aggregates are public). LOCKED guardrails:
//   - NAMES ONLY, permanently: never arguments, message content, or the skill markdown body.
//   - Leverage signal: status + aggregate, NEVER scored — the benefit already lands in the
//     efficiency axis (fewer tokens, more outcomes).
//   - Harness PLUMBING commands are excluded — only real workflow skills count.
//   - Public/known skills link to their public repo; private/unknown display by name, no link.
//     The opt-in "publish your skill" upload flow is DEFERRED to the Operating Manual increment
//     (spec note in docs/operating-manual.md) — not built here.

/** Client-side cap: top entries per session; the smallest overflow buckets fold into "other". */
const MAX_SKILL_BUCKETS = 16;

/** Normalized skill ids must match this AFTER normalization; non-conforming ids are DROPPED. */
const SKILL_ID_RE = /^[a-z0-9:_./-]{1,64}$/;

/**
 * Claude Code builtin/plumbing commands — harness mechanics, not workflow skills. Invoking
 * /compact or /model says nothing about how a builder ships, so these never enter the signal.
 */
// MIRROR NOTE: this list exists in THREE hand-maintained copies — here,
// the server's bounds gate and the web app's practice display (their PLUMBING lists).
// If you add a builtin, change ALL THREE (they had already drifted once: the web copy
// gained six ids the tracker/server lacked, letting /rewind etc. burn stored skill slots).
const PLUMBING_COMMANDS = new Set([
  "end", "model", "usage", "compact", "clear", "resume", "status", "context", "effort",
  "branch", "help", "login", "doctor", "cost", "init", "exit", "hooks", "memory", "mcp",
  "permissions", "agents", "export", "todos", "vim", "add-dir", "bashes", "ide", "bug",
  "release-notes", "privacy-settings", "upgrade", "terminal-setup", "install-github-app",
  "pr-comments", "review", "logout", "config", "output-style", "rewind", "statusline",
  "migrate-installer",
]);

/**
 * Normalize a raw skill/command marker to its canonical slug, or null to DROP it:
 * strip the leading '/', lowercase, collapse `ns:name` to `name` ONLY when ns === name
 * (e.g. `frontend-design:frontend-design` -> `frontend-design`; `superpowers:brainstorming`
 * keeps its namespace), then gate on charset/length and the plumbing exclude list.
 */
export function normalizeSkillId(raw: string): string | null {
  let id = raw.trim().toLowerCase();
  if (id.startsWith("/")) id = id.slice(1);
  const parts = id.split(":");
  if (parts.length === 2 && parts[0] === parts[1]) id = parts[0];
  if (!SKILL_ID_RE.test(id)) return null;
  if (PLUMBING_COMMANDS.has(id)) return null;
  return id;
}

/**
 * Normalize a Task subagent_type to its canonical slug, or null to DROP it. Shares the
 * skill charset/length gate but NOT the plumbing exclude list — every dispatch names a
 * real delegation — and never strips or collapses namespaces (agent names are flat).
 */
export function normalizeAgentId(raw: string): string | null {
  const id = raw.trim().toLowerCase();
  return SKILL_ID_RE.test(id) ? id : null;
}

/** Count one invocation of a raw skill marker (normalizes first; drops non-conforming). */
export function creditSkill(bySkill: Map<string, number>, raw: string): void {
  const id = normalizeSkillId(raw);
  if (!id) return;
  bySkill.set(id, (bySkill.get(id) ?? 0) + 1);
}

/**
 * Fold the per-skill counter into the wire array: sort by count desc, cap at 16 distinct
 * entries — the smallest overflow buckets fold into `"other"`. Output is ids + counts ONLY.
 */
export function foldSkillBuckets(bySkill: Map<string, number>): SkillCount[] {
  let entries = [...bySkill.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length > MAX_SKILL_BUCKETS) {
    const kept = new Map(entries.slice(0, MAX_SKILL_BUCKETS - 1));
    let other = kept.get("other") ?? 0;
    for (const [, c] of entries.slice(MAX_SKILL_BUCKETS - 1)) other += c;
    kept.set("other", other);
    entries = [...kept.entries()];
  }
  return entries.map(([id, count]) => ({ id, count }));
}

/**
 * One skill/command invocation OBSERVATION with its global identity. Skills are counted
 * from a fold over these events so the dedup grain matches usage: a resumed/forked file
 * replays the SAME user lines and assistant tool_use blocks verbatim, and counting the
 * replay would inflate the practice signal even while token math is exact.
 *  - Skill tool_use blocks key by their block id (`tool:<id>` — globally unique).
 *  - Command tags key by the carrying user line's uuid (`cmd:<uuid>:<skill>` — replays
 *    keep the original uuid; that is the same durable identity the parentUuid chain uses).
 *  - key === null (no id/uuid available) counts as-is, never deduped (defensive).
 */
export interface SkillEvent {
  /** Normalized skill id (normalizeSkillId output). */
  id: string;
  /** Global dedup key, or null to count as-is. */
  key: string | null;
}

/** Fold skill events into a counter, deduping by key against `seen` (shared across the
 * whole corpus for cross-file dedup; pass a fresh Set for single-file semantics). */
export function creditSkillEvents(
  into: Map<string, number>,
  events: SkillEvent[],
  seen: Set<string>,
): void {
  for (const ev of events) {
    if (ev.key !== null) {
      if (seen.has(ev.key)) continue;
      seen.add(ev.key);
    }
    into.set(ev.id, (into.get(ev.id) ?? 0) + 1);
  }
}

/**
 * Extract harness-injected `<command-name>/NAME</command-name>` markers from a user message.
 * Regex pulls ONLY the tag value — never <command-args>, surrounding text, or any other
 * content. The text is scanned and immediately discarded; nothing but the marker survives.
 */
const COMMAND_TAG_RE = /<command-name>([^<>]{1,80})<\/command-name>/g;

function collectCommandTagEvents(events: SkillEvent[], entry: any): void {
  if (entry?.type !== "user") return;
  const content = entry?.message?.content;
  const texts: string[] = [];
  if (typeof content === "string") texts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b && b.type === "text" && typeof b.text === "string") texts.push(b.text);
    }
  }
  const uuid = typeof entry?.uuid === "string" && entry.uuid ? entry.uuid : null;
  for (const text of texts) {
    for (const m of text.matchAll(COMMAND_TAG_RE)) {
      const id = normalizeSkillId(m[1]);
      if (id) events.push({ id, key: uuid ? `cmd:${uuid}:${id}` : null });
    }
  }
}

/**
 * Extract Skill tool calls from an assistant message: content blocks where
 * type === 'tool_use' && name === 'Skill' -> input.skill (a structured field — never the
 * args). Streamed re-logs AND cross-file replays of the same block dedup by its block id
 * at fold time (creditSkillEvents); blocks without an id count directly (defensive).
 */
function collectSkillToolUseEvents(events: SkillEvent[], entry: any): void {
  if (entry?.type !== "assistant") return;
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b || b.type !== "tool_use" || b.name !== "Skill") continue;
    const skill = b?.input?.skill;
    if (typeof skill !== "string" || !skill) continue;
    const id = normalizeSkillId(skill);
    if (!id) continue;
    events.push({ id, key: typeof b.id === "string" && b.id ? `tool:${b.id}` : null });
  }
}

/**
 * Extract subagent dispatches from an assistant message: tool_use blocks where
 * name === 'Agent' (current harness) OR 'Task' (pre-rename harness versions) ->
 * input.subagent_type (a structured field — never the prompt, never the description).
 * Matching the OLD name alone shipped a silent zero (caught live 2026-07-10: the real
 * corpus carried 114 'Agent' blocks and not one 'Task'). Same dedup identity as Skill
 * blocks (`tool:<block id>` — replays of the block can't inflate the delegation signal).
 */
function collectAgentTaskEvents(events: SkillEvent[], entry: any): void {
  if (entry?.type !== "assistant") return;
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b || b.type !== "tool_use" || (b.name !== "Agent" && b.name !== "Task")) continue;
    const t = b?.input?.subagent_type;
    if (typeof t !== "string" || !t) continue;
    const id = normalizeAgentId(t);
    if (!id) continue;
    events.push({ id, key: typeof b.id === "string" && b.id ? `tool:${b.id}` : null });
  }
}

/** Pull a usage block from any of the shapes Claude Code has used. */
function extractUsage(entry: any): TokenCounts | null {
  const u = entry?.message?.usage ?? entry?.usage;
  if (!u || typeof u !== "object") return null;
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheCreation: n(u.cache_creation_input_tokens),
  };
}

function rawUsage(entry: any): any | null {
  return entry?.message?.usage ?? entry?.usage ?? null;
}

function agentProgressMessage(entry: any): any | null {
  const message = entry?.data?.message;
  return message && typeof message === "object" && message?.message?.usage ? message : null;
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function optionalBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function normalizeEntryPoint(raw: unknown, isSidechainEntry = false): EntryPoint {
  if (isSidechainEntry) return "subagent";
  if (typeof raw !== "string") return "unknown";
  const id = raw.trim().toLowerCase();
  if (!id) return "unknown";
  if (id === "vs-code" || id === "vscode") return "vscode";
  if (id === "codex_vscode" || id === "codex-vscode") return "codex-vscode";
  if (id === "claude-desktop" || id === "desktop") return "desktop";
  if (id === "terminal" || id === "cli") return "cli";
  if (id.startsWith("opencode")) return id;
  return /^[a-z0-9._:-]{1,64}$/.test(id) ? id : "unknown";
}

function detectEntryPoint(entry: any, source: any, isSidechainEntry: boolean): EntryPoint {
  return normalizeEntryPoint(
    source?.entryPoint ?? source?.entrypoint ?? source?.client ?? source?.clientName ?? entry?.entryPoint ?? entry?.entrypoint,
    isSidechainEntry,
  );
}

function thinkingTokenCount(usage: any): number {
  if (!usage || typeof usage !== "object") return 0;
  return n(usage.reasoning_output_tokens ?? usage.thinking_tokens ?? usage.thinking_output_tokens);
}

function normalizeUsageEntry(entry: any): ClaudeUsageEntry | null {
  const agentProgress = agentProgressMessage(entry);
  const source = agentProgress ?? entry;
  const usageSource = agentProgress ? { message: agentProgress.message } : entry;
  const tokens = extractUsage(usageSource);
  if (!tokens) return null;
  const usage = rawUsage(usageSource);
  const message = source?.message;
  const isSidechainEntry = optionalBoolean(source?.isSidechain) === true;
  return {
    timestamp: optionalString(source?.timestamp) ?? null,
    uuid: agentProgress ? null : (optionalString(entry?.uuid) ?? null),
    sessionId: agentProgress ? undefined : optionalString(entry?.sessionId),
    version: agentProgress ? undefined : optionalString(entry?.version),
    messageId: optionalString(message?.id),
    requestId: optionalString(source?.requestId),
    model: optionalString(message?.model ?? source?.model),
    isSidechain: optionalBoolean(source?.isSidechain),
    hasSpeed: usage && typeof usage === "object" && usage.speed != null,
    cost: n(source?.costUSD),
    entryPoint: detectEntryPoint(entry, source, isSidechainEntry),
    thinkingTokens: thinkingTokenCount(usage),
    tokens,
  };
}

function timestampString(entry: any): string | null {
  return optionalString(entry?.timestamp) ?? optionalString(entry?.data?.message?.timestamp) ?? null;
}

/**
 * Is this entry a genuine human/user prompt (a "turn"), as opposed to a tool_result
 * echo or a synthetic/meta line? Defensive: anything ambiguous returns false so we
 * never over-count turns. Tool results arrive as `type: "user"` entries whose content
 * array carries tool_result blocks — those are agent plumbing, not human input.
 */
function isHumanPrompt(entry: any): boolean {
  if (!entry || entry.type !== "user") return false;
  if (entry.isMeta === true) return false;
  const content = entry?.message?.content;
  if (Array.isArray(content)) {
    if (content.some((b: any) => b && b.type === "tool_result")) return false;
  }
  return true;
}

/**
 * RAW per-file atoms: everything sync.ts needs to run the GLOBAL cross-file dedup.
 * usageEntries are in transcript order, validity-UNfiltered and UNdeduped — the fold
 * (ClaudeUsageDeduper) owns both, at whichever grain the caller chooses.
 */
export interface TranscriptAtoms {
  toolSessionId: string | null;
  /** Last valid model seen in the file (primary-model telemetry). */
  model: string;
  usageEntries: ClaudeUsageEntry[];
  /**
   * Best-effort file entry point: first non-unknown among NON-sidechain entries (the
   * session's own runtime), else first non-unknown overall. Status only, never scored.
   */
  entryPoint: EntryPoint;
  /** Raw skill observations with global identity — fold via creditSkillEvents (the
   * corpus shares one `seen` set so replayed files can't inflate the practice signal). */
  skillEvents: SkillEvent[];
  /** Raw subagent-dispatch observations (Task subagent_type) — same event shape and
   * fold machinery as skills, but a SEPARATE stream end to end. */
  agentEvents: SkillEvent[];
  timestamps: number[];
  humanPromptTimestamps: number[];
  lastMessageUuid: string | null;
  skipped: number;
  /** Every non-blank line seen -- the W1.5 drift-rate denominator (skipped/totalLines). */
  totalLines: number;
  /**
   * First-seen top-level `cwd` field across the file's entries — session METADATA only
   * (never message/prompt content; the extraction reads exactly this one key). Used by
   * sync to derive the org repo slug AFTER confirmed enrollment (P1.1); undefined when
   * no entry carries one.
   */
  cwd?: string;
}

export function extractClaudeAtoms(content: string): TranscriptAtoms {
  const out: TranscriptAtoms = {
    toolSessionId: null,
    model: "unknown",
    usageEntries: [],
    entryPoint: "unknown",
    skillEvents: [],
    agentEvents: [],
    timestamps: [],
    humanPromptTimestamps: [],
    lastMessageUuid: null,
    skipped: 0,
    totalLines: 0,
  };
  let sidechainEntryPoint: EntryPoint = "unknown";

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.totalLines++;
    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      out.skipped++;
      continue;
    }

    if (typeof entry?.sessionId === "string" && !out.toolSessionId) out.toolSessionId = entry.sessionId;
    // First-seen working directory — the ONE metadata key read for org repo attribution.
    if (out.cwd === undefined && typeof entry?.cwd === "string" && entry.cwd) out.cwd = entry.cwd;

    const tsRaw = timestampString(entry);
    const ts = tsRaw ? Date.parse(tsRaw) : NaN;
    if (Number.isFinite(ts)) {
      out.timestamps.push(ts);
      if (isHumanPrompt(entry)) out.humanPromptTimestamps.push(ts);
    }

    // Skills signal — two capture points, exact markers only (see the helpers above).
    collectCommandTagEvents(out.skillEvents, entry);
    collectSkillToolUseEvents(out.skillEvents, entry);
    // Agents signal — Task dispatches, separate stream (same guardrails as skills).
    collectAgentTaskEvents(out.agentEvents, entry);

    const usageEntry = normalizeUsageEntry(entry);
    if (usageEntry) {
      if (isValidClaudeUsageEntry(usageEntry)) {
        if (usageEntry.model) out.model = usageEntry.model;
        if (usageEntry.entryPoint !== "unknown") {
          if (usageEntry.isSidechain !== true && out.entryPoint === "unknown") out.entryPoint = usageEntry.entryPoint;
          else if (sidechainEntryPoint === "unknown") sidechainEntryPoint = usageEntry.entryPoint;
        }
      }
      if (usageEntry.uuid) out.lastMessageUuid = usageEntry.uuid;
      out.usageEntries.push(usageEntry);
    }
  }

  if (out.entryPoint === "unknown") out.entryPoint = sidechainEntryPoint;
  out.timestamps.sort((a, b) => a - b);
  out.humanPromptTimestamps.sort((a, b) => a - b);
  return out;
}

/**
 * Standalone single-file parse: extract + the capture standard's dedup at file grain.
 * The sync path does NOT use this for totals — it feeds extractClaudeAtoms() into the
 * GLOBAL cross-file fold instead (resume/fork replays live in sibling files).
 */
export function parseTranscript(content: string): ParsedTranscript {
  const atoms = extractClaudeAtoms(content);
  const bySkill = new Map<string, number>();
  creditSkillEvents(bySkill, atoms.skillEvents, new Set());
  const byAgent = new Map<string, number>();
  creditSkillEvents(byAgent, atoms.agentEvents, new Set());
  const out: ParsedTranscript = {
    toolSessionId: atoms.toolSessionId,
    model: atoms.model,
    tokens: { ...ZERO },
    models: [],
    entryPoint: atoms.entryPoint,
    thinkingTokens: 0,
    skills: foldSkillBuckets(bySkill),
    agents: foldSkillBuckets(byAgent),
    timestamps: atoms.timestamps,
    humanPromptTimestamps: atoms.humanPromptTimestamps,
    messageCount: 0,
    lastMessageUuid: atoms.lastMessageUuid,
    skipped: atoms.skipped,
    totalLines: atoms.totalLines,
  };

  const byModel = new Map<string, TokenCounts>();
  for (const { model, tokens, thinkingTokens } of dedupeClaudeUsageEntries(atoms.usageEntries)) {
    addTokens(out.tokens, tokens);
    out.thinkingTokens += thinkingTokens;
    out.messageCount++;
    creditModel(byModel, model ?? "unknown", tokens);
  }
  out.models = foldModelBuckets(byModel);
  return out;
}
