/** Tracker-side mirrors of the ingest contract. Metadata only. */

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Agent tools the tracker can parse locally. Must be a subset of the server's VALID_TOOLS. */
export type ToolName = "claude_code" | "codex" | "grok" | "pi" | "openclaw" | "opencode" | "hermes" | "copilot" | "gemini";

/**
 * A bring-your-own model rate (L17), USD per MILLION tokens, typed by the user with
 * `df pricing set`. LOCAL-ONLY: it prices a model the bundled PRICES table has never heard
 * of when `usage --cost` renders, and it NEVER leaves the machine — no ingest payload ever
 * carries a user rate or a user-rate-derived spend (pinned by byoInvariant.test.ts).
 * `cacheWrite` maps to a model's cache-CREATE rate; `cacheRead`/`cacheWrite` default to 0
 * when omitted. `source` is an optional free-form provenance note (a pricing-page URL).
 */
export interface UserRate {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  source?: string;
}

/**
 * Per-model token bucket within one session. `id` is the RAW model id from the transcript
 * (arbitrary — router-served models write their real ids), client-side sanitized only
 * (trimmed, length-capped); canonicalization happens server-side at fold time.
 */
export interface ModelTokens extends TokenCounts {
  id: string;
}

/**
 * One skill/command invocation bucket within a session. `id` is the normalized skill NAME
 * only (leading '/' stripped, lowercased, ns:name collapsed when ns===name) — NEVER
 * arguments, message content, or the skill body. Metadata-only guardrail is permanent.
 */
export interface SkillCount {
  id: string;
  count: number;
}

export type EntryPoint =
  | "cli"
  | "vscode"
  | "codex-vscode"
  | "desktop"
  | "subagent"
  | "unknown"
  | (string & {});

/**
 * Model-Use Efficiency (MUE) — the context-economy fold for ONE session
 * (docs/model-use-efficiency.md). STATUS ONLY: its own component, orthogonal to Build Score,
 * NEVER in rank and never buys it. Computed by contextEfficiency() over the session's deduped
 * MAIN-THREAD usage series; omitted (field absent) when a session is too short to say honestly.
 */
export interface ModelUseEfficiency {
  /** Context-scaling exponent (log-log OLS slope of ΣK on ΣO). ~1 = disciplined, ~2 = quadratic bloat. */
  alpha: number;
  /** Actual cumulative main-thread context cost: Σ (input + cacheRead + cacheCreation). */
  cActual: number;
  /** Optimal baseline: c_floor × points, where c_floor is the leanest context actually run
   *  (self-relative "if you had stayed as lean as you already proved you can"). */
  cIdeal: number;
  /** Fraction of optimal, cIdeal/cActual ∈ (0,1]. 1.0 = on the ideal line; lower = sloppier. */
  ratio: number;
  /** Context tokens paid per output token — the plainest magnitude. */
  costPerOutput: number;
  /** Count of large context drops (>50% fall from a substantial window) — compaction events. */
  compactions: number;
  /** Main-thread messages used. */
  points: number;
}

/**
 * Per-session context-window occupancy (lane T3, context capacity) — the LAST turn's own
 * cost, LOCAL-ONLY. Ruled (Marco): this never flows to the board — it is never part of
 * `toIngest()`'s wire payload (mirrors `cwd`'s local-only precedent), never scored, never
 * uploaded. Present only for harnesses exposing PER-TURN usage; absent (never a
 * smeared/estimated/fabricated value) for session-cumulative-only harnesses (opencode, Hermes)
 * and for a session whose every turn recorded zero usage.
 */
export interface SessionContext {
  /** The LAST turn's own `input + cacheRead + cacheCreation` (contextEfficiency.ts's per-turn
   *  cost formula) — post-compaction reality, the LATEST turn wins, never the max over the
   *  session. "Last" skips a trailing all-zero snapshot (a known capture shape): it is the
   *  last entry with NONZERO occupancy. */
  occupancyTokens: number;
  /** The model id attributed to that SAME last turn (per-turn resolution where the harness
   *  has it), never a copy of the session-level `model` field, which can legitimately differ. */
  model: string;
  /** Context-window size, ONLY when the harness states it in the raw payload (Codex's
   *  `model_context_window`). Never resolved from a model-name registry here — that is a
   *  render-time concern. */
  windowTokens?: number;
  /** That same last turn's own timestamp, ISO-8601, passed through verbatim (not
   *  reparsed/reserialized when the source already carried a string). */
  at?: string;
}

/** One UTC day's share of a multi-day session — real observed atoms, never a smear. */
export interface SessionDaySlice {
  /** UTC day key, YYYY-MM-DD. */
  day: string;
  activeMs: number;
  idleMs: number;
  tokens: TokenCounts;
  /** Per-model split of THIS day's tokens; omitted when nothing bucketed here. */
  models?: ModelTokens[];
}

export interface SessionSummary {
  tool: ToolName;
  toolSessionId: string;
  model: string;
  tokens: TokenCounts;
  /** Per-model token buckets (additive detail; sums to `tokens` minus filtered pseudo-models). */
  models: ModelTokens[];
  /** Best-effort transcript/runtime entry point. Status only, never scored. */
  entryPoint: EntryPoint;
  /** Observable reasoning/thinking token count where present. Status only, never scored. */
  thinkingTokens: number;
  /**
   * Model-Use Efficiency for this session (docs/model-use-efficiency.md) — its OWN component,
   * STATUS ONLY, never in rank. Absent when the session is too short (< MIN_POINTS output-bearing
   * main-thread messages) to estimate an exponent honestly, and always for Codex (no per-turn
   * context series). Optional/dropped-when-undefined like skills/agents/days: the digest changes
   * only for sessions that actually carry it, and the server ignores it until its ingest increment.
   */
  mue?: ModelUseEfficiency;
  /**
   * Per-session context-window occupancy (lane T3) — see `SessionContext`'s own doc comment.
   * LOCAL-ONLY: never part of `toIngest()`'s wire payload, never uploaded, never scored.
   */
  context?: SessionContext;
  /**
   * Skill/command invocations observed in-session (names + counts ONLY — a leverage/status
   * signal, never scored). Omitted when none observed (and always for Codex, no skills v1).
   */
  skills?: SkillCount[];
  /**
   * Subagent dispatches (Task tool_use subagent_type; names + counts ONLY). A SEPARATE
   * field from skills, permanently — the server's skills plausibility gate and the
   * practice display assume skills are skills. Omitted when none observed (and always
   * for Codex/Grok, which have no Task concept in their transcripts).
   */
  agents?: SkillCount[];
  wallMs: number;
  activeMs: number;
  idleMs: number;
  startedAt: number;
  endedAt: number;
  /**
   * Per-UTC-day slices (day-attribution Fix A) — present ONLY when the session's atoms
   * touch more than one UTC day, so single-day sessions stay byte-identical to their
   * pre-slice digests and never re-upload. activeMs/idleMs come from the credited
   * activity quanta clipped at midnights; tokens/models from bucketing each surviving
   * (post-dedup) usage entry by its own timestamp. Slices sum exactly to the session
   * totals — the server drops the whole array (legacy end-day fallback) if they don't.
   */
  days?: SessionDaySlice[];
  repoHash: string | null;
  /**
   * The session's working directory, NEVER uploaded (toIngest() does not carry this
   * field). Codex: the `cwd` from the rollout's session_meta line, used locally as the
   * `usage --by-project` label. Claude (0.9.0): the transcript's first-seen top-level
   * `cwd` metadata field, used ONLY to derive `orgRepo` after confirmed enrollment —
   * the Claude --by-project label remains the transcript's parent directory name.
   * Undefined when no entry carried one.
   */
  cwd?: string;
  /**
   * Org-enrolled devices only (gap-closing-spec P1.1 / ruling 2.1 #3): the session's
   * normalized lowercase `owner/name` git slug. Set in syncOnce ONLY after CONFIRMED
   * enrollment AND a resolved slug — a non-enrolled device never puts a repo name on
   * the wire (client-side privacy gate; "send and let the server drop it" is rejected).
   * Part of the ingest payload and therefore of the upload digest, so an enrollment
   * flip re-uploads exactly the sessions whose attribution changed.
   */
  orgRepo?: string;
  /** Explicit user-level telemetry grants for this locally-resolved repo. Raw cwd is
   * never uploaded; the server re-validates every grant against the authenticated uid. */
  attribution?: {
    canonicalRepoId: string;
    grantIds: string[];
    localRepoId: string | null;
  };
  /** Count of assistant messages seen, for dedupe/debug. */
  messageCount: number;
  /** Count of human->agent turns (number of human/user prompts). Cumulative per session. */
  turns: number;
  /** Longest continuous span (ms) of agent work with no human input. */
  longestLoopMs: number;
  /** Candidate shipped outcomes observed in-session (self-attested; metadata only). */
  outcomes?: IngestOutcome[];
}

/** Kind of shipped outcome. Outcome-gated, weighted merged_pr >> opened_pr > commit. */
export type OutcomeType = "merged_pr" | "opened_pr" | "commit";

/**
 * Tracker-side candidate outcome — metadata ONLY (type, repoHash, sha/PR number).
 * NEVER diff, code, or prompt text. The server re-derives the verified weight.
 */
export interface IngestOutcome {
  type: OutcomeType;
  nodeId?: string | null;
  repoHash?: string | null;
  prNumber?: number;
  sha?: string;
  addDel?: number;
  observedAt: number;
}

/** npx identity mode: github = verified-by-construction; provisional = unverified. */
export type IdentityMode = "github" | "provisional";
