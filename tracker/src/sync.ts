/**
 * Scan Claude Code transcripts, summarize each thread (tokens + active/idle), and
 * push cumulative session totals to /api/ingest. Cumulative (not delta) totals make
 * the endpoint idempotent: re-syncing the same corpus just upserts the same docs.
 *
 * CLAUDE IS SUMMARIZED AS A CORPUS, NOT PER FILE (the Deploy Forward Atomic Capture
 * Standard): resume/fork replays the same (messageId, requestId) across SIBLING files,
 * so messages are globally deduped across every Claude file BEFORE any roll-up, and
 * each surviving message is assigned to its first-occurrence thread (lineage only —
 * assignment can never change a total). Because one file's change can move another
 * thread's totals (a fork's complete replay upgrades a record the original owns),
 * uploads are gated per-thread by summary DIGEST; the per-file byte cursor only answers
 * "did anything change since the last pass". Codex rollouts never replay across files,
 * so they keep the cheap per-file path.
 */
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  extractClaudeAtoms,
  ClaudeUsageDeduper,
  isValidClaudeUsageEntry,
  creditModel,
  creditSkillEvents,
  foldModelBuckets,
  foldSkillBuckets,
  addTokens,
  ZERO,
  type TranscriptAtoms,
} from "./jsonl.js";
import { sessionMue, lastNonzeroOccupancy, type OccupancySeriesEntry } from "./contextEfficiency.js";
import { candidateOutcomes } from "./sessionOutcomes.js";
import { parseCodexRollout } from "./codex.js";
import { isOfficialGrokCli, grokUnifiedLogPath, scanGrokCorpus } from "./grok.js";
import { isOfficialPiCli, piSessionFiles, scanPiCorpus } from "./pi.js";
import { isOfficialGeminiCli, geminiSessionFiles, scanGeminiCorpus } from "./gemini.js";
import { isOfficialOpenClawCli, scanOpenClawCorpus, openclawSessionFiles } from "./openclaw.js";
import { isOfficialOpencodeHome, scanOpencodeCorpus, opencodeHome, opencodeDbPaths } from "./opencode.js";
import { isOfficialHermesCli, scanHermesCorpus, hermesHome, hermesDbPath } from "./hermes.js";
import { isOfficialCopilotCli, scanCopilotCorpus, copilotHome, copilotDbPath } from "./copilot.js";
import { sqliteSupported } from "./sqlite.js";
import { computeActivity, computeLoops, sliceActivityByDay, utcDayKey, type ActivityDaySlice } from "./activity.js";
import { loadState, saveState, repoHash, localRepoId, type OrgContext, type TrackerState } from "./config.js";
import { buildUnknownModelShare } from "./unknownModels.js";
import { refreshOrgContext, repoSlugForCwd, orgRepoFor } from "./orgContext.js";
import type { SessionDaySlice, SessionSummary, ToolName, TokenCounts } from "./types.js";

/** MUST equal package.json's version — version.test.ts fails the build if it drifts.
 * 0.12.0 shipped reporting "0.11.8": the update-check nagged every user to upgrade to the
 * build they were already running, and every session it ingested was stamped with the wrong
 * trackerVersion — the one field that exists for schema-drift triage. */
export const TRACKER_VERSION = "0.26.1";

/**
 * Every Claude Code "projects" root we've seen across install layouts. An explicit
 * DF_CLAUDE_PROJECTS override wins outright; otherwise we scan Claude Code's own
 * CLAUDE_CONFIG_DIR, the XDG config home (~/.config/claude), the Windows roaming AppData
 * (%APPDATA%\claude), and the legacy ~/.claude. Only existing dirs are returned, de-duplicated
 * (two env vars can resolve to the same path). Reading just one of these silently under-counts a
 * builder whose transcripts live under XDG / APPDATA / a WSL home.
 * Exported for eval/reconcile-ccusage.mjs (corpus census); sync itself uses findTranscripts.
 */
export function claudeProjectRoots(): string[] {
  if (process.env.DF_CLAUDE_PROJECTS) return [process.env.DF_CLAUDE_PROJECTS].filter(existsSync);
  const roots: string[] = [];
  // CLAUDE_CONFIG_DIR may be a comma-separated LIST (the standard multi-profile form) — split it,
  // mirroring ccusage. A single "/a,/b" joined naively would become the nonsense path "/a,/b/projects".
  if (process.env.CLAUDE_CONFIG_DIR) {
    for (const d of process.env.CLAUDE_CONFIG_DIR.split(",")) {
      const t = d.trim();
      if (t) roots.push(join(t, "projects"));
    }
  }
  roots.push(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "claude", "projects"));
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "claude", "projects"));
  roots.push(join(homedir(), ".claude", "projects"));
  return [...new Set(roots)].filter(existsSync);
}
function codexSessionsDir(): string {
  return process.env.DF_CODEX_SESSIONS ?? join(homedir(), ".codex", "sessions");
}

/** One local transcript + the tool that produced it, plus any nested transcripts merged into it. */
export interface Source {
  path: string;
  tool: ToolName;
  /** Nested subagent transcripts folded into THIS session (Claude Code only; empty for Codex). */
  subagents: string[];
}

/** Recursively collect matching files under a directory -- ONE walker for both transcript
 * trees (its per-dir try/catch hardening exists once, so a robustness fix lands once).
 * One unreadable dir is skipped, never fatal. */
function walkFiles(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (match(ent.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** All Codex rollout files under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (recursive). */
export function findCodexTranscripts(root = codexSessionsDir()): string[] {
  if (!existsSync(root)) return [];
  return walkFiles(root, (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"));
}

/** Recursively collect every *.jsonl under a directory. */
function walkJsonl(dir: string): string[] {
  return walkFiles(dir, (name) => name.endsWith(".jsonl"));
}

/**
 * Nested subagent transcripts for one root Claude Code session (RC-D, 0.3.0).
 *
 * A session at <proj>/<sessionId>.jsonl spawns Task subagents whose transcripts live under
 * the SIBLING dir <proj>/<sessionId>/subagents/** (agent-*.jsonl, plus a workflows/** tree).
 * findTranscripts scans only root-level *.jsonl, so it misses these — ~10.5% of Claude tokens
 * (762M) in the reference corpus. Every such file carries the PARENT's sessionId, so their
 * usage belongs to this session; they are returned here so summarizeFile can MERGE them into
 * the parent (see SESSION-IDENTITY note on summarizeFile) rather than emit them as thousands of
 * separate sessions.
 */
export function findSubagentTranscripts(rootTranscriptPath: string): string[] {
  // <proj>/<sessionId>.jsonl -> <proj>/<sessionId>/subagents
  const subagents = join(rootTranscriptPath.replace(/\.jsonl$/i, ""), "subagents");
  if (!existsSync(subagents)) return [];
  return walkJsonl(subagents);
}

/** Every local source (Claude Code transcripts + Codex rollouts) tagged with its tool. */
export function findSources(): Source[] {
  return [
    ...findTranscripts().map((path) => ({
      path,
      tool: "claude_code" as const,
      subagents: findSubagentTranscripts(path),
    })),
    ...findCodexTranscripts().map((path) => ({ path, tool: "codex" as const, subagents: [] })),
  ];
}

/**
 * Every Claude Code transcript across all project roots. The SAME session file can appear under
 * more than one root (a session copied between WSL/XDG/legacy homes); files are named by session
 * id, so we dedup by filename. When a session has multiple copies we keep the LARGEST (most
 * complete transcript) — a stale, touched-but-truncated copy must never shadow the full session,
 * and a smaller copy would report fewer cumulative tokens and get flagged as a non-monotonic
 * resync server-side. We only stat() when a collision actually exists, so the common single-copy
 * case pays no extra syscall.
 */
export function findTranscripts(roots: string | string[] = claudeProjectRoots()): string[] {
  const list = Array.isArray(roots) ? roots : [roots];
  const byName = new Map<string, string[]>(); // session filename -> every copy found
  for (const root of list) {
    let projects: import("node:fs").Dirent[];
    try {
      projects = readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // missing / unreadable root — skip, never throw
    }
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const dir = join(root, proj.name);
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue; // one unreadable project dir must not abort the rest
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const full = join(dir, f);
        const arr = byName.get(f);
        if (arr) arr.push(full);
        else byName.set(f, [full]);
      }
    }
  }
  const out: string[] = [];
  for (const paths of byName.values()) {
    if (paths.length === 1) {
      out.push(paths[0]);
      continue;
    }
    // Copied session — keep the largest (most complete) copy. Stat only here (on collision).
    let best = paths[0];
    let bestSize = -1;
    for (const p of paths) {
      let size = -1;
      try {
        size = statSync(p).size;
      } catch {
        continue; // vanished between readdir and stat
      }
      if (size > bestSize) {
        bestSize = size;
        best = p;
      }
    }
    out.push(best);
  }
  return out;
}

/** One Claude thread's raw material: the root transcript's atoms + its subagents' atoms. */
interface ThreadAtoms {
  path: string;
  threadId: string;
  root: TranscriptAtoms;
  subs: TranscriptAtoms[];
  /** Earliest VALID usage-entry timestamp across root + subs (the corpus ordering key). */
  firstUsageTs: number;
  /** Valid usage entries this thread OFFERS the global fold (pre-dedup). */
  validCount: number;
}

/**
 * Summarize the whole Claude corpus with GLOBAL cross-file message dedup — the Deploy
 * Forward Atomic Capture Standard's reconciliation step (plan §1-§2).
 *
 * 1. Extract raw atoms per file (root + nested subagent transcripts; a subagent's usage
 *    attributes to the PARENT thread — its dispatch "user" line is not a human turn).
 * 2. Order threads deterministically: earliest valid usage timestamp, ties by threadId.
 *    Totals are order-independent (max-wins); the order only fixes which thread is the
 *    "first occurrence" — lineage, never a number.
 * 3. ONE global dedup fold across every file at message grain (exact msgid+reqid key,
 *    sidechain-guarded msgid fallback, whole-record max-wins), BEFORE any roll-up.
 * 4. Roll up each thread from the surviving messages it owns. The thread token total is
 *    DERIVED as Σ per-model buckets — never an independently stored number.
 * 5. A thread whose every message deduped away into a sibling (a fork that only replays)
 *    is emitted as a ZEROED record — uploading it overwrites the older inflated doc a
 *    per-file pass would have left behind. A thread with no valid usage at all is null.
 */
export function summarizeClaudeCorpus(
  sources: { path: string; subagents: string[] }[],
  state: TrackerState,
  // W1.5 drift counters, ACCUMULATED into the caller's object (optional so
  // repoAttribution/summarizeFile callers stay untouched). Kept out of the return
  // type on purpose: SessionSummary is session data and must never carry scan health.
  health?: { unknownLines: number; totalLines: number },
): SessionSummary[] {
  const threads: ThreadAtoms[] = [];
  for (const src of sources) {
    let root: TranscriptAtoms;
    try {
      root = extractClaudeAtoms(readFileSync(src.path, "utf8"));
    } catch {
      continue; // one unreadable root must not abort the corpus pass
    }
    const subs: TranscriptAtoms[] = [];
    for (const sp of [...src.subagents].sort()) {
      try {
        subs.push(extractClaudeAtoms(readFileSync(sp, "utf8")));
      } catch {
        /* a vanished/locked subagent must not sink the parent */
      }
    }
    let firstUsageTs = Infinity;
    let validCount = 0;
    for (const atoms of [root, ...subs]) {
      if (health) {
        health.unknownLines += atoms.skipped;
        health.totalLines += atoms.totalLines;
      }
      for (const e of atoms.usageEntries) {
        if (!isValidClaudeUsageEntry(e)) continue;
        validCount++;
        const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
        if (Number.isFinite(ts) && ts < firstUsageTs) firstUsageTs = ts;
      }
    }
    threads.push({
      path: src.path,
      threadId: root.toolSessionId ?? basename(src.path).replace(/\.jsonl$/, ""),
      root,
      subs,
      firstUsageTs,
      validCount,
    });
  }

  threads.sort(
    (a, b) => a.firstUsageTs - b.firstUsageTs || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0),
  );

  // THE reconciliation step: one flat fold across every file, message grain, before any
  // roll-up. Owner = first-occurrence thread index (lineage only).
  const deduper = new ClaudeUsageDeduper<number>();
  threads.forEach((t, i) => {
    for (const e of t.root.usageEntries) deduper.push(e, i);
    for (const sub of t.subs) for (const e of sub.usageEntries) deduper.push(e, i);
  });

  const folds = threads.map(() => ({
    byModel: new Map<string, TokenCounts>(),
    // day -> model -> counts, from each SURVIVING entry's own timestamp (day-attribution
    // Fix A). Post-dedup on purpose: a deduped replay must not mint day mass anywhere.
    // "" collects entries with unparseable timestamps; the assembly anchors them to the
    // session's last touched day rather than inventing a date.
    byDay: new Map<string, Map<string, TokenCounts>>(),
    thinkingTokens: 0,
    messageCount: 0,
  }));
  // Per-thread usage series for the MUE fold AND the context-occupancy fold (lane T3): collect
  // every OWNED entry from the SAME globally-deduped results the totals use (sidechains
  // included — sessionMue()/lastNonzeroOccupancy() both filter them), mapped to the
  // vendor-neutral OccupancySeriesEntry (a superset of MueSeriesEntry) so Claude uses the
  // identical seam as every other harness for both folds. Never a parallel per-file read that
  // could disagree with the token totals.
  const perThreadSeries: OccupancySeriesEntry[][] = threads.map(() => []);
  for (const { entry, owner } of deduper.results()) {
    const f = folds[owner];
    perThreadSeries[owner].push({
      tokens: entry.tokens,
      isSidechain: entry.isSidechain,
      ts: entry.timestamp,
      model: entry.model ?? "unknown",
    });
    creditModel(f.byModel, entry.model ?? "unknown", entry.tokens);
    const entryTs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    const dk = Number.isFinite(entryTs) ? utcDayKey(entryTs) : "";
    const dayMap = f.byDay.get(dk) ?? new Map<string, TokenCounts>();
    creditModel(dayMap, entry.model ?? "unknown", entry.tokens);
    f.byDay.set(dk, dayMap);
    f.thinkingTokens += entry.thinkingTokens;
    f.messageCount++;
  }

  const out: SessionSummary[] = [];
  // Skill dedup is GLOBAL like usage dedup: one seen-set across the corpus, threads in
  // the same deterministic order, so a resumed/forked file replaying the same tool_use
  // blocks / command lines cannot inflate the practice signal. First occurrence owns the
  // count (status-only attribution, same rule as usage lineage).
  const seenSkillEvents = new Set<string>();
  const seenAgentEvents = new Set<string>();
  threads.forEach((t, i) => {
    if (t.validCount === 0) return; // nothing observable — nothing to upsert
    const f = folds[i];
    const tombstone = f.messageCount === 0;

    // A thread whose EVERY message deduped away into a sibling owns no work at all: it
    // uploads as a TOMBSTONE — every aggregate-visible atom zeroed (not just tokens), so
    // a replay-only fork can't mint sessions, active time, turns, streak days, practice
    // counts, or entrypoint signals. Its timestamps are verbatim copies of the original
    // thread's, so crediting activity from them would double-count the same wall-clock.
    // The record exists solely to overwrite a previously-uploaded inflated doc; dayFold
    // skips messageCount === 0 records on the read side.
    if (tombstone) {
      const startedAt = t.root.timestamps[0] ?? 0; // keep the day bucket stable for the overwrite
      out.push({
        tool: "claude_code",
        toolSessionId: t.threadId,
        model: t.root.model,
        tokens: { ...ZERO },
        models: [],
        entryPoint: "unknown",
        thinkingTokens: 0,
        skills: undefined,
        agents: undefined,
        wallMs: 0,
        activeMs: 0,
        idleMs: 0,
        startedAt,
        endedAt: startedAt,
        repoHash: repoHash(state.repoHmacKey, basename(join(t.path, ".."))),
        messageCount: 0,
        turns: 0,
        longestLoopMs: 0,
        cwd: t.root.cwd, // first-seen cwd metadata (local-only; org slug derivation)
      });
      return;
    }

    const models = foldModelBuckets(f.byModel);
    // The stored total IS the sum of the per-model atoms (§2: derived, cannot diverge) --
    // summed with the SAME shared addTokens the parser folds with, on purpose.
    const tokens: TokenCounts = { ...ZERO };
    for (const m of models) addTokens(tokens, m);

    // Activity streams merge root + subagents; human turns are the ROOT's only (a
    // subagent's opening "user" line is the Task dispatch, not a human prompt).
    const timestamps = [...t.root.timestamps];
    for (const sub of t.subs) timestamps.push(...sub.timestamps);
    timestamps.sort((a, b) => a - b);
    const activity = computeActivity(timestamps, state.gapMs);
    const loops = computeLoops(timestamps, t.root.humanPromptTimestamps, state.gapMs);

    // Skills: fold root + subagent events through the corpus-global seen-set (replays
    // dedup by tool_use block id / carrying-line uuid). Tombstones never consume keys,
    // so ordering between an original and its replay can't erase a real count.
    const bySkill = new Map<string, number>();
    creditSkillEvents(bySkill, t.root.skillEvents, seenSkillEvents);
    for (const sub of t.subs) creditSkillEvents(bySkill, sub.skillEvents, seenSkillEvents);
    const skills = foldSkillBuckets(bySkill);

    // Agents: same fold machinery, separate stream + separate corpus-global seen-set
    // (a Task block id can never collide with a Skill block id, but sharing the set
    // would make the two signals order-dependent for no benefit).
    const byAgent = new Map<string, number>();
    creditSkillEvents(byAgent, t.root.agentEvents, seenAgentEvents);
    for (const sub of t.subs) creditSkillEvents(byAgent, sub.agentEvents, seenAgentEvents);
    const agents = foldSkillBuckets(byAgent);

    // endedAt is derived from the RECONSTRUCTED wall (startedAt + wallMs), not the last raw
    // timestamp, so endedAt-startedAt stays consistent with the recovered active/wall and the
    // server's wall_exceeds_span guard doesn't clamp the reconstruction. The no-timestamp
    // fallback is 0 (deterministic), NEVER Date.now(): capture must be a pure function of the
    // transcript, and a clock-dependent value would churn the thread's digest on every
    // corpus rebuild (permanent re-upload of a byte-identical thread).
    const startedAt = timestamps[0] ?? 0;
    const endedAt = startedAt + activity.wallMs;

    const days = buildDaySlices(
      sliceActivityByDay(timestamps, state.gapMs),
      f.byDay,
    );

    // MUE (docs/model-use-efficiency.md): the context-economy exponent over THIS thread's owned,
    // globally-deduped series. Its OWN component, STATUS ONLY, never in rank. sessionMue() sorts
    // by ts, drops sidechains, and returns undefined (→ field omitted) below MIN_POINTS. A
    // tombstone owns no entries and never reaches this branch — it carries no MUE.
    const mue = sessionMue(perThreadSeries[i]);
    // Context occupancy (lane T3, docs/... SessionContext): LOCAL-ONLY, never part of
    // toIngest()'s wire payload (see types.ts's SessionContext doc comment).
    const context = lastNonzeroOccupancy(perThreadSeries[i]);

    out.push({
      tool: "claude_code",
      toolSessionId: t.threadId,
      model: t.root.model,
      tokens,
      models,
      entryPoint: t.root.entryPoint,
      thinkingTokens: f.thinkingTokens,
      mue,
      context,
      days,
      // Omitted (not []) when no skills were observed — the wire payload carries the field
      // only when there is signal.
      skills: skills.length > 0 ? skills : undefined,
      agents: agents.length > 0 ? agents : undefined,
      wallMs: activity.wallMs,
      activeMs: activity.activeMs,
      idleMs: activity.idleMs,
      startedAt,
      endedAt,
      // Repo identity = the Claude project directory path, HMAC'd locally (no name leaves host).
      repoHash: repoHash(state.repoHmacKey, basename(join(t.path, ".."))),
      messageCount: f.messageCount,
      turns: loops.turns,
      longestLoopMs: loops.longestLoopMs,
      // Root transcript's first-seen cwd — session METADATA, local-only (never uploaded
      // verbatim); syncOnce derives orgRepo from it AFTER confirmed enrollment (P1.1).
      cwd: t.root.cwd,
    });
  });
  return out;
}

/**
 * Assemble the wire day-slices (day-attribution Fix A) from the two per-day streams:
 * activity quanta clipped at midnights, and post-dedup usage entries bucketed by their
 * own timestamps. Entries whose timestamp would not parse (the "" bucket) anchor to the
 * session's LAST touched day — a fact we hold — rather than an invented date.
 *
 * Returns undefined for single-day sessions: no slices on the wire means the record
 * stays byte-identical to its pre-slice digest, so the 0.13.0 re-parse only re-uploads
 * sessions that genuinely span midnights.
 */
export function buildDaySlices(
  activityDays: Map<string, ActivityDaySlice>,
  tokensByDay: Map<string, Map<string, TokenCounts>>,
): SessionDaySlice[] | undefined {
  const dayKeys = new Set<string>([...activityDays.keys()]);
  for (const k of tokensByDay.keys()) if (k !== "") dayKeys.add(k);
  if (dayKeys.size < 2) return undefined;

  const sorted = [...dayKeys].sort();
  const anchor = sorted[sorted.length - 1];
  // Merge the unparseable-timestamp bucket into the anchor day's model map.
  const merged = new Map(tokensByDay);
  const orphan = merged.get("");
  if (orphan) {
    merged.delete("");
    const anchorMap = merged.get(anchor) ?? new Map<string, TokenCounts>();
    for (const [id, counts] of orphan) creditModel(anchorMap, id, counts);
    merged.set(anchor, anchorMap);
  }

  return sorted.map((day) => {
    const a = activityDays.get(day) ?? { activeMs: 0, idleMs: 0 };
    const dayModels = merged.get(day) ? foldModelBuckets(merged.get(day)!) : [];
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

/**
 * Summarize ONE source. Claude delegates to the corpus summarizer with a corpus of one —
 * same code path as sync, minus cross-file competition (identical to the old per-file
 * behavior for a standalone file). Codex keeps its own cumulative-snapshot path; rollouts
 * never replay across files. subagentPaths default to [] so Codex callers are unchanged.
 */
export function summarizeFile(
  path: string,
  state: TrackerState,
  tool: ToolName = "claude_code",
  subagentPaths: string[] = [],
  // W1.5 drift counters, ACCUMULATED into the caller's object across calls (the codex
  // sync block calls this once per changed rollout). Optional so existing callers
  // (repoAttribution, tests) stay untouched.
  health?: { unknownLines: number; totalLines: number },
): SessionSummary | null {
  if (tool === "codex") {
    const parsed = parseCodexRollout(readFileSync(path, "utf8"));
    // Counters accumulate even for a summary-less file — a rollout whose every line
    // stopped parsing is EXACTLY the drift signal, not a file to ignore.
    if (health) {
      health.unknownLines += parsed.skipped;
      health.totalLines += parsed.totalLines;
    }
    if (parsed.messageCount === 0) return null;
    const activity = computeActivity(parsed.timestamps, state.gapMs);
    const loops = computeLoops(parsed.timestamps, parsed.humanPromptTimestamps, state.gapMs);
    // Deterministic no-timestamp fallback (never Date.now()) — capture is a pure
    // function of the transcript, and re-syncs of an unchanged file must be idempotent.
    const startedAt = parsed.timestamps[0] ?? 0;
    // Codex day-slices: activity clips by day like Claude, but the rollout parser does
    // not expose per-entry usage timestamps, so ALL tokens/models anchor to the last
    // touched day rather than pretending we know their distribution. Honest partial:
    // hours land on their true days; token mass stays end-anchored until the parser
    // grows per-entry timestamps. Mostly moot — rollouts flush in one burst.
    const activityDays = sliceActivityByDay(parsed.timestamps, state.gapMs);
    let days: SessionDaySlice[] | undefined;
    if (activityDays.size >= 2) {
      const sortedDays = [...activityDays.keys()].sort();
      const anchor = sortedDays[sortedDays.length - 1];
      days = sortedDays.map((day) => {
        const a = activityDays.get(day)!;
        return {
          day,
          activeMs: a.activeMs,
          idleMs: a.idleMs,
          tokens: day === anchor ? parsed.tokens : { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          ...(day === anchor && parsed.models.length ? { models: parsed.models } : {}),
        };
      });
    }
    return {
      tool,
      toolSessionId: parsed.toolSessionId ?? basename(path).replace(/\.jsonl$/, ""),
      model: parsed.model,
      tokens: parsed.tokens,
      models: parsed.models,
      entryPoint: parsed.entryPoint,
      thinkingTokens: parsed.thinkingTokens,
      // Context occupancy (lane T3): parsed straight off info.last_token_usage /
      // model_context_window; LOCAL-ONLY, absent (never guessed) when the rollout never
      // carried those fields.
      context: parsed.context,
      days,
      skills: undefined, // Codex has no skills concept (v1)
      agents: undefined, // ...and no Task/subagent concept either
      wallMs: activity.wallMs,
      activeMs: activity.activeMs,
      idleMs: activity.idleMs,
      startedAt,
      endedAt: startedAt + activity.wallMs,
      repoHash: null, // Codex rollouts live under date dirs (not a repo)
      messageCount: parsed.messageCount,
      turns: loops.turns,
      longestLoopMs: loops.longestLoopMs,
      cwd: parsed.cwd, // local-only project attribution label (usage --by-project); never uploaded
    };
  }
  const [summary] = summarizeClaudeCorpus([{ path, subagents: subagentPaths }], state, health);
  return summary ?? null;
}

/** Stable per-thread digest of exactly what would be uploaded (the ingest payload). */
function summaryDigest(s: SessionSummary): string {
  return createHash("sha256").update(JSON.stringify(toIngest(s))).digest("hex");
}

/** Apply the fresh server-confirmed repository policy without ever uploading cwd.
 * Legacy enrolled-device naming stays during migration; user-level grants work on
 * every paired device and are independently revalidated by ingest. */
export function applyRepositoryAttribution(
  summary: SessionSummary,
  state: Pick<TrackerState, "repoHmacKey">,
  context: OrgContext,
): void {
  // Candidate outcomes: the commit SHAs this session authored in its window (metadata-only, from
  // local git log). Captured for EVERY session — it needs only cwd + window, not org enrollment —
  // so it runs BEFORE the enrollment/grant early-return. Undefined (and dropped) when git is
  // unavailable or no commits fall in the window; deterministic, so it never churns the digest.
  const candidates = candidateOutcomes(summary);
  if (candidates) summary.outcomes = candidates; // absent (not undefined) when none — like mue/skills/agents

  const hasGrants = (context.attribution?.grants.length ?? 0) > 0;
  if (!context.enrolled && !hasGrants) return;
  const slug = repoSlugForCwd(summary.cwd);
  if (!slug) return;
  if (context.enrolled) summary.orgRepo = orgRepoFor(true, slug);
  const grants = (context.attribution?.grants ?? []).filter((g) => g.slug === slug);
  if (grants.length === 0) return;
  const canonicalIds = [...new Set(grants.map((g) => g.canonicalRepoId))];
  if (canonicalIds.length !== 1) return; // ambiguous identity: fail closed
  summary.attribution = {
    canonicalRepoId: canonicalIds[0],
    grantIds: grants.map((g) => g.grantId),
    localRepoId: localRepoId(state.repoHmacKey, summary.cwd, slug),
  };
}

/** Server ingest caps a request at 500 sessions; stay comfortably below it. */
const INGEST_CHUNK = 100;

/**
 * PURE 403-classifier for the account-deletion gate (plan Task 11, user-deletion-gdpr):
 * matches the server's `res.status(403).json({ error: "account_deleted",
 * restoreBy })` contract exactly. Takes the already-parsed status + body — never a live
 * fetch Response — so syncOnce is the only caller that ever has to await one; every
 * branch here is directly unit-testable with plain objects (accountDeleted.test.ts).
 */
export interface AccountDeletedOutcome {
  deleted: boolean;
  /** Epoch ms the grace window ends (identity.deletedUntil server-side). Present only
   * when the response actually carried a valid number — a malformed/legacy response
   * still classifies as deleted, just without a date to show. */
  restoreBy?: number;
}

export function classifyAccountDeleted(status: number, body: unknown): AccountDeletedOutcome {
  if (status !== 403) return { deleted: false };
  const b = body as { error?: unknown; restoreBy?: unknown } | null | undefined;
  if (b?.error !== "account_deleted") return { deleted: false };
  return { deleted: true, restoreBy: typeof b.restoreBy === "number" ? b.restoreBy : undefined };
}

/**
 * The user-facing message syncOnce prints when classifyAccountDeleted reports
 * `deleted: true`. PURE — `now` is passed in explicitly rather than read from Date.now()
 * internally, so the "the grace window already lapsed" branch is deterministically
 * unit-testable (accountDeleted.test.ts).
 */
export function formatAccountDeletedMessage(restoreBy: number | undefined, now: number): string {
  if (restoreBy === undefined) {
    return "This account is scheduled for deletion. Run `npx --yes deploy-forward@latest restore` to cancel.";
  }
  const date = new Date(restoreBy).toISOString().slice(0, 10); // YYYY-MM-DD, UTC -- unambiguous
  if (now > restoreBy) {
    return `This account's deletion is being finalized (was scheduled for ${date}) — restore may no longer be possible. Run \`npx --yes deploy-forward@latest restore\` to try.`;
  }
  return `This account is scheduled for deletion on ${date}. Run \`npx --yes deploy-forward@latest restore\` to cancel.`;
}

export async function syncOnce(opts: {
  verbose?: boolean;
  /**
   * L19 live-spend seam: the interactive monitor passes this to reuse the sessions THIS pass
   * already parsed (zero extra scan) for the throttled live push. Fired ONLY after a fully
   * successful upload, with the changed sessions of this pass (a running session that just
   * grew is exactly the one present; an idle pass returns early and never fires this). Any
   * other caller omits it — only the live listener pushes. Awaited but fail-silent: a throwing
   * callback must never break capture (the monitor wraps it in its own try/catch too).
   */
  onSessions?: (sessions: SessionSummary[]) => void | Promise<void>;
} = {}): Promise<number> {
  const state = loadState();
  if (!state.deviceToken) {
    throw new Error("not_paired");
  }

  // P1.1 enrollment bridge: confirm/refresh org context BEFORE building any payload.
  // FAIL CLOSED — without a fresh cache or a confirmed answer, this pass is not
  // enrolled and attaches no repo slug (spec ruling 2.1 #3).
  const org = await refreshOrgContext(state);
  const enrolled = org.ctx.enrolled;
  // Fingerprint of the attribution mode the persisted digests were computed under.
  // A CONFIRMED flip (enroll or revoke) forces one corpus re-fold below even when no
  // transcript byte changed, so a newly-enrolled device re-uploads its sessions WITH
  // orgRepo (and a revoked one without it) instead of being skipped as unchanged.
  const orgFingerprint = `${enrolled ? "enrolled" : "none"}:${org.ctx.attribution?.fingerprint ?? "no-grants"}`;
  const orgTransition = org.confirmed && state.orgStamp !== orgFingerprint;

  const sources = findSources();
  const sessions: SessionSummary[] = [];
  const pendingDigests = new Map<string, string>();
  let skipped = 0;
  // W1.5 drift plumbing (providers.ts): unknown/total line counters, recorded ONLY for
  // providers that actually re-scanned this pass — a cursor-skipped provider keeps its
  // last real numbers in state rather than being overwritten with a fake healthy zero.
  // Merged into state.scanHealth alongside the cursors (both save paths below).
  // LOCAL-ONLY: status/monitor read it via isDriftSuspected(); never on the wire.
  const scanHealth: NonNullable<TrackerState["scanHealth"]> = {};
  const scannedAt = Date.now();

  // ---- Codex: per-file (rollouts never replay across files) --------------------------------
  const codexHealth = { unknownLines: 0, totalLines: 0 };
  let codexScanned = false;
  for (const { path, tool } of sources) {
    if (tool !== "codex") continue;
    // One bad file (delete race -> ENOENT, Windows lock -> EBUSY/EACCES, or a
    // >~512MB transcript -> ERR_STRING_TOO_LONG) must never abort the whole pass and
    // wedge the 60s retry loop. Isolate each file; skip failures, keep the rest.
    try {
      const size = statSync(path).size;
      const cursor = state.cursors[path];
      // An enrollment flip re-folds byte-identical rollouts too (orgTransition) — dead
      // rollout files never change, so without this Codex could never gain/lose orgRepo.
      if (cursor && cursor.byteOffset === size && !orgTransition) continue;
      const summary = summarizeFile(path, state, tool, [], codexHealth);
      codexScanned = true; // counters cover exactly the files re-parsed this pass
      if (summary) {
        // Repo attribution for Codex (0.11.5 — closes the permanent-unattributed gap):
        // rollouts DO carry a cwd (session_meta.payload.cwd); same confirmed-enrollment
        // client-side gate as Claude/Grok, same "before the digest" requirement.
        applyRepositoryAttribution(summary, state, org.ctx);
        const key = `${summary.tool}_${summary.toolSessionId}`;
        const digest = summaryDigest(summary);
        if (state.threadDigests[key] !== digest) {
          sessions.push(summary);
          pendingDigests.set(key, digest);
        }
        state.cursors[path] = { byteOffset: size };
      }
    } catch {
      skipped++;
    }
  }
  if (codexScanned) scanHealth.codex = { ...codexHealth, at: scannedAt };

  // ---- Claude: global corpus (cross-file dedup) ---------------------------------------------
  // Cheap change detection first: per-file byte cursor (root + every nested subagent, so a
  // session re-syncs when a nested transcript grows even if the root is byte-unchanged). The
  // cursor only answers "did ANYTHING change" — when it did, the WHOLE corpus is re-folded,
  // because global dedup means one file's change can move another thread's totals. Uploads
  // are then gated per-thread by digest, so an unchanged thread costs no network.
  const claude = sources.filter((s) => s.tool === "claude_code");
  const sizes = new Map<string, number>();
  let claudeChanged = orgTransition; // an enrollment flip re-folds even byte-identical files
  for (const src of claude) {
    try {
      let size = statSync(src.path).size;
      for (const sp of src.subagents) {
        try {
          size += statSync(sp).size;
        } catch {
          /* a vanished/locked subagent must not skip the parent — just omit its bytes */
        }
      }
      sizes.set(src.path, size);
      const cursor = state.cursors[src.path];
      if (!cursor || cursor.byteOffset !== size) claudeChanged = true;
    } catch {
      skipped++;
    }
  }

  if (claudeChanged) {
    const claudeHealth = { unknownLines: 0, totalLines: 0 };
    const summaries = summarizeClaudeCorpus(
      claude.filter((s) => sizes.has(s.path)),
      state,
      claudeHealth,
    );
    scanHealth.claude_code = { ...claudeHealth, at: scannedAt };
    for (const s of summaries) {
      // Repo attribution (all three providers derive it from their cwd metadata):
      // confirmed-enrolled devices derive cwd -> git remote -> normalized slug. The
      // enrolled gate is CLIENT-side and fail-closed; non-enrolled passes never even run
      // git. Must happen BEFORE the digest — orgRepo is part of the hashed payload.
      applyRepositoryAttribution(s, state, org.ctx);
      const key = `${s.tool}_${s.toolSessionId}`;
      const digest = summaryDigest(s);
      if (state.threadDigests[key] === digest) continue; // this thread's record is already up
      sessions.push(s);
      pendingDigests.set(key, digest);
    }
    for (const src of claude) {
      const size = sizes.get(src.path);
      if (size !== undefined) state.cursors[src.path] = { byteOffset: size };
    }
  }

  // ---- Grok (G1, docs/grok-capture-plan.md): global unified.jsonl + per-session join.
  // Fingerprint-gated to the OFFICIAL xAI CLI; a community-fork ~/.grok contributes
  // nothing. Change detection is the log file's byte size (the codex cursor idiom —
  // rotation/truncation shows as a size mismatch and reparses); an enrollment flip
  // re-folds like Claude so grok sessions gain/lose orgRepo with everything else.
  // Per-thread digests still gate uploads, so a reparse of an unchanged corpus is free.
  if (isOfficialGrokCli()) {
    try {
      const logPath = grokUnifiedLogPath();
      const size = statSync(logPath).size;
      const cursor = state.cursors[logPath];
      if (!cursor || cursor.byteOffset !== size || orgTransition) {
        const scan = scanGrokCorpus(state);
        scanHealth.grok = { unknownLines: scan.unknownLines, totalLines: scan.totalLines, at: scannedAt };
        for (const s of scan.sessions) {
          // Same client-side privacy gate as Claude: orgRepo only after CONFIRMED
          // enrollment, derived from the session's local cwd metadata.
          applyRepositoryAttribution(s, state, org.ctx);
          const key = `${s.tool}_${s.toolSessionId}`;
          const digest = summaryDigest(s);
          if (state.threadDigests[key] === digest) continue;
          sessions.push(s);
          pendingDigests.set(key, digest);
        }
        state.cursors[logPath] = { byteOffset: size };
      }
    } catch {
      skipped++; // a locked/vanished log must never abort the Claude/Codex pass
    }
  }

  // ---- pi (docs/harness-adapters-spec.md §2, W1.2/W1.3): one JSONL file per session --
  // architecturally the Codex shape (pi.ts's file header: one file IS one session, no
  // cross-file resume/fork story), so change detection COULD be real per-file byte
  // cursors like Codex's. But W1.2 exposes only a WHOLE-CORPUS summarizer
  // (summarizePiCorpus/scanPiCorpus) -- there is no per-file summarizeFile the way Codex
  // has one -- so genuinely re-folding one file at a time would mean duplicating
  // scanPiCorpus's atoms -> SessionSummary assembly (model folds, activity, loops,
  // day-slicing) here in sync.ts. Composing with LESS new code: borrow the CLAUDE idiom
  // instead of Grok's single-file one -- real per-file byte cursors drive change
  // DETECTION ONLY (so monitorStats keeps an honest per-file count, same as every other
  // provider, instead of a fake single aggregate cursor), while the actual re-parse is
  // always the WHOLE corpus, exactly the same "cheap per-file check, one corpus-wide
  // summarize call" split the Claude block above already needs for its cross-file dedup.
  // pi doesn't need cross-file dedup (each file already is one session) -- only the
  // exposed API shape forces the whole-corpus call. Candidate for W1.7: exporting a
  // per-file summarize entry point from pi.ts (mirroring Codex's summarizeFile) would
  // let this become a true per-file re-fold, cheaper on corpora with many session files.
  if (isOfficialPiCli()) {
    const piFiles = piSessionFiles();
    const piSizes = new Map<string, number>();
    let piChanged = orgTransition; // enrollment flip re-folds byte-identical files too
    for (const f of piFiles) {
      try {
        const size = statSync(f.path).size;
        piSizes.set(f.path, size);
        const cursor = state.cursors[f.path];
        if (!cursor || cursor.byteOffset !== size) piChanged = true;
      } catch {
        skipped++; // a vanished/locked session file must not abort the pass
      }
    }

    if (piChanged) {
      // The W1.3 commit deferred this seam to W1.5: scanPiCorpus IS the summarize call
      // plus the drift counters — ONE scan, counters threaded out instead of discarded.
      const scan = scanPiCorpus(state);
      scanHealth.pi = { unknownLines: scan.unknownLines, totalLines: scan.totalLines, at: scannedAt };
      for (const s of scan.sessions) {
        // Same client-side privacy gate as every other provider, applied BEFORE the
        // digest -- orgRepo is part of the hashed payload.
        applyRepositoryAttribution(s, state, org.ctx);
        const key = `${s.tool}_${s.toolSessionId}`;
        const digest = summaryDigest(s);
        if (state.threadDigests[key] === digest) continue; // this thread's record is already up
        sessions.push(s);
        pendingDigests.set(key, digest);
      }
      // Advance cursors ONLY for files the scan actually read: statSync can succeed
      // while readFileSync fails (Windows lock, delete race), and one pi file is one
      // whole session that never grows after completion — a cursor written for an
      // unread file would mark that session synced forever without ever parsing it.
      const unread = new Set(scan.readFailures);
      for (const f of piFiles) {
        const size = piSizes.get(f.path);
        if (size !== undefined && !unread.has(f.path)) state.cursors[f.path] = { byteOffset: size };
      }
      skipped += scan.readFailures.length;
    }
  }

  // ---- Gemini CLI (L14): ONE JSON object per session under tmp/<projectDir>/chats/*.json
  // -- architecturally the SAME "one file IS one session" shape as pi/openclaw (no
  // cross-file resume/fork story), so this block borrows pi's exact idiom: real per-file
  // byte-size cursors drive change DETECTION ONLY (geminiSessionFiles owns discovery,
  // gemini.ts owns parsing), while the re-parse is always the WHOLE corpus, because
  // scanGeminiCorpus's exposed API is whole-corpus only. Fingerprint-gated to the OFFICIAL
  // Gemini store (a non-gemini chats-like tree contributes nothing). A file that failed to
  // read this pass keeps its OLD cursor (the pi read-failure rule) so the next pass retries
  // it instead of marking an unread session synced forever.
  if (isOfficialGeminiCli()) {
    const geminiFiles = geminiSessionFiles();
    const geminiSizes = new Map<string, number>();
    let geminiChanged = orgTransition; // enrollment flip re-folds byte-identical files too
    for (const f of geminiFiles) {
      try {
        const size = statSync(f.path).size;
        geminiSizes.set(f.path, size);
        const cursor = state.cursors[f.path];
        if (!cursor || cursor.byteOffset !== size) geminiChanged = true;
      } catch {
        skipped++; // a vanished/locked session file must not abort the pass
      }
    }

    if (geminiChanged) {
      const scan = scanGeminiCorpus(state);
      scanHealth.gemini = { unknownLines: scan.unknownLines, totalLines: scan.totalLines, at: scannedAt };
      for (const s of scan.sessions) {
        // Same client-side privacy gate as every other provider, applied BEFORE the
        // digest -- orgRepo is part of the hashed payload.
        applyRepositoryAttribution(s, state, org.ctx);
        const key = `${s.tool}_${s.toolSessionId}`;
        const digest = summaryDigest(s);
        if (state.threadDigests[key] === digest) continue; // this thread's record is already up
        sessions.push(s);
        pendingDigests.set(key, digest);
      }
      // Advance cursors ONLY for files the scan actually read (the pi read-failure rule).
      const unread = new Set(scan.readFailures);
      for (const f of geminiFiles) {
        const size = geminiSizes.get(f.path);
        if (size !== undefined && !unread.has(f.path)) state.cursors[f.path] = { byteOffset: size };
      }
      skipped += scan.readFailures.length;
    }
  }

  // ---- SQLite soft-skip probe (wiring task item 2): "installed, this Node can't read
  // it" vs "not installed" (silence). isOfficialXCli()/isOfficialXHome() cannot tell
  // the two apart on their own: when node:sqlite itself is missing (Node < 22.5),
  // EVERY SQLite fingerprint gate below returns false via the exact same underlying
  // sqliteSupported() check, so the normal scan path never even sees the tool's data.
  // This is a SEPARATE, cheap (fs existence only, never a parse, never opens a db)
  // check run every pass regardless of whether any SQLite provider's gate fired.
  // Wholesale-replaced each pass -- unlike scanHealth's per-provider merge -- so a
  // Node upgrade mid-install clears the notice on the very next sync instead of
  // lingering. df.ts's status() reads this to print one honest line per affected tool.
  // OpenClaw is NOT part of this probe: it moved off SQLite entirely (2026-07-14,
  // real-corpus finding -- see src/openclaw.ts's header) onto a plain JSONL reader,
  // which has no node:sqlite dependency to soft-skip on.
  const softSkip: NonNullable<TrackerState["softSkip"]> = {};
  if (!sqliteSupported()) {
    if (opencodeDbPaths(opencodeHome()).length > 0) softSkip.opencode = true;
    if (existsSync(hermesDbPath())) softSkip.hermes = true;
    if (existsSync(copilotDbPath())) softSkip.copilot = true;
  }
  state.softSkip = softSkip;

  // ---- OpenClaw (W2, docs/harness-adapters-implementation.md §2; re-based onto JSONL
  // 2026-07-14 after the SQLite/database-first premise was disproved against a real
  // corpus -- see src/openclaw.ts's header): one JSONL file per session under
  // agents/<agentId>/sessions/*.jsonl. Architecturally now the SAME shape pi.ts
  // documents (one file IS one session, no cross-file resume/fork story), so this
  // block borrows pi's exact idiom: real per-file byte-size cursors drive change
  // DETECTION ONLY (openclawSessionFiles owns discovery; openclaw.ts owns parsing),
  // while the actual re-parse is always the WHOLE corpus, because scanOpenClawCorpus's
  // exposed API is whole-corpus only (the same "cheap per-file check, one corpus-wide
  // summarize call" split pi's block above needs). agentId is never part of session
  // identity (openclaw.ts's multi-agent dedupe rule), so a session id repeated across
  // two agentId directories still uploads once. No watermark: a JSONL transcript
  // carries no cursor-friendly recency column distinct from the file's own bytes, so
  // nothing rides in state.watermarks for this provider -- same conclusion as the
  // pre-migration SQLite design, for a different (now verified) reason. A file that
  // failed to read this pass (locked, corrupt, or a directory sitting where the file
  // should be) must not advance ITS cursor, so the next pass retries it instead of
  // silently marking it synced over unread data (the pi read-failure rule).
  if (isOfficialOpenClawCli()) {
    const openclawFiles = openclawSessionFiles();
    const openclawSizes = new Map<string, number>();
    let openclawChanged = orgTransition; // enrollment flip re-folds byte-identical files too
    for (const f of openclawFiles) {
      try {
        const size = statSync(f.path).size;
        openclawSizes.set(f.path, size);
        const cursor = state.cursors[f.path];
        if (!cursor || cursor.byteOffset !== size) openclawChanged = true;
      } catch {
        skipped++; // a vanished/locked session file must not abort the pass
      }
    }

    if (openclawChanged) {
      const scan = scanOpenClawCorpus(state);
      scanHealth.openclaw = { unknownLines: scan.unknownLines, totalLines: scan.totalLines, at: scannedAt };
      for (const s of scan.sessions) {
        // Same client-side privacy gate as every other provider, applied BEFORE the
        // digest -- orgRepo is part of the hashed payload.
        applyRepositoryAttribution(s, state, org.ctx);
        const key = `${s.tool}_${s.toolSessionId}`;
        const digest = summaryDigest(s);
        if (state.threadDigests[key] === digest) continue; // this thread's record is already up
        sessions.push(s);
        pendingDigests.set(key, digest);
      }
      // Advance cursors ONLY for files the scan actually read (the pi read-failure
      // rule): a locked/corrupt file keeps its OLD cursor so the next pass retries it
      // instead of treating an unread session as synced forever.
      const unread = new Set(scan.readFailures);
      for (const f of openclawFiles) {
        const size = openclawSizes.get(f.path);
        if (size !== undefined && !unread.has(f.path)) state.cursors[f.path] = { byteOffset: size };
      }
      skipped += scan.readFailures.length;
    }
  }

  // ---- opencode (Wave 3, docs/harness-adapters-implementation.md §3): SQLite,
  // session-grain cumulative totals only --------------------------------------------
  // Multiple db files can legitimately coexist (a builder switching install channels);
  // opencodeDbPaths() is the discovery surface, scanOpencodeCorpus() the whole-corpus
  // scan (opencode.ts owns both; this block only persists). Change detection: a real
  // per-db-file byte-size cursor (the cheap pre-check) decides whether the pass is
  // even worth a rescan -- the SAME idiom as OpenClaw/Codex/pi above. AFTER a scan,
  // the adapter's own returned `watermark` (max time_created/time_updated across every
  // row read this pass) is compared against the LAST PERSISTED one and only ever
  // advances: it is NOT a byte count, so it lives in its own `state.watermarks` map
  // rather than borrowing FileCursor.byteOffset -- a field whose very name would then
  // lie about what it holds. A db file in `scan.readFailures` keeps its OLD cursor
  // (the pi read-failure rule) so a locked/corrupt file retries next pass instead of
  // being marked synced over data that was never actually read.
  if (isOfficialOpencodeHome()) {
    const home = opencodeHome();
    const dbPaths = opencodeDbPaths(home);
    const dbSizes = new Map<string, number>();
    let opencodeChanged = orgTransition; // enrollment flip re-folds byte-identical dbs too
    for (const p of dbPaths) {
      try {
        const size = statSync(p).size;
        dbSizes.set(p, size);
        const cursor = state.cursors[p];
        if (!cursor || cursor.byteOffset !== size) opencodeChanged = true;
      } catch {
        skipped++; // a vanished/locked db file must not abort the pass
      }
    }

    if (opencodeChanged) {
      const scan = scanOpencodeCorpus(state, home);
      scanHealth.opencode = { unknownLines: scan.unknownLines, totalLines: scan.totalLines, at: scannedAt };
      for (const s of scan.sessions) {
        applyRepositoryAttribution(s, state, org.ctx);
        const key = `${s.tool}_${s.toolSessionId}`;
        const digest = summaryDigest(s);
        if (state.threadDigests[key] === digest) continue;
        sessions.push(s);
        pendingDigests.set(key, digest);
      }
      const unread = new Set(scan.readFailures);
      for (const p of dbPaths) {
        const size = dbSizes.get(p);
        if (size !== undefined && !unread.has(p)) state.cursors[p] = { byteOffset: size };
      }
      skipped += scan.readFailures.length;
      // Watermark only ever advances -- a partial/failed pass (some db files unread)
      // must never regress the recency marker the next pass's pre-check could rely on.
      if (scan.watermark > (state.watermarks[home] ?? 0)) state.watermarks[home] = scan.watermark;
    }
  }

  // ---- Hermes (Wave 3 SQLite pair): one state.db, session-grain cumulative totals,
  // REAL per-message activity ---------------------------------------------------------
  // Single db file -- change detection is its byte size, the same cheap pre-check
  // idiom as opencode's above. The adapter's own `watermark` (max started_at across
  // scanned rows, or null when the pass read nothing) persists in `state.watermarks`,
  // monotonically -- never regressed -- for the same "not a byte offset, don't borrow
  // FileCursor" reason documented on the opencode block above. A `skipReason` (locked,
  // corrupt, or schema mismatch) means `sessions` is always [] and `watermark` always
  // null: no cursor advance, no watermark update, no scanHealth entry written this
  // pass -- this pass genuinely read nothing, so there is nothing honest to record
  // beyond the skipped-file count (and the merge below keeps whatever scanHealth this
  // provider last had, exactly like a cursor-skipped provider elsewhere in this file).
  if (isOfficialHermesCli()) {
    const home = hermesHome();
    const dbPath = hermesDbPath(home);
    let hermesChanged = orgTransition; // enrollment flip re-folds a byte-identical db too
    let dbSize: number | undefined;
    try {
      dbSize = statSync(dbPath).size;
      const cursor = state.cursors[dbPath];
      if (!cursor || cursor.byteOffset !== dbSize) hermesChanged = true;
    } catch {
      skipped++; // a vanished/locked db must not abort the pass
    }

    if (hermesChanged) {
      const scan = scanHermesCorpus(state, home);
      if (scan.skipReason) {
        skipped++; // this pass read nothing for Hermes -- retry next time, no cursor advance
      } else {
        scanHealth.hermes = { unknownLines: scan.unknownLines, totalLines: scan.totalLines, at: scannedAt };
        for (const s of scan.sessions) {
          applyRepositoryAttribution(s, state, org.ctx);
          const key = `${s.tool}_${s.toolSessionId}`;
          const digest = summaryDigest(s);
          if (state.threadDigests[key] === digest) continue;
          sessions.push(s);
          pendingDigests.set(key, digest);
        }
        if (dbSize !== undefined) state.cursors[dbPath] = { byteOffset: dbSize };
        if (scan.watermark !== null && scan.watermark > (state.watermarks[home] ?? 0)) {
          state.watermarks[home] = scan.watermark;
        }
      }
    }
  }

  // ---- GitHub Copilot CLI (8th harness adapter): one session-store.db, EVENT-grain
  // (assistant_usage_events) tokens+timestamps, real days[] ------------------------------
  // Single db file -- change detection is its byte size, the same cheap pre-check idiom
  // as opencode/Hermes above. The adapter's own `watermark` (max event created_at across
  // scanned rows, or null when the pass read nothing) persists in `state.watermarks`,
  // monotonically -- never regressed -- same "not a byte offset, don't borrow
  // FileCursor" reason as opencode/Hermes. A `skipReason` (locked, corrupt, or schema
  // mismatch) means `sessions` is always [] and `watermark` always null: no cursor
  // advance, no watermark update, no scanHealth entry written this pass -- mirrors
  // Hermes's block exactly.
  if (isOfficialCopilotCli()) {
    const home = copilotHome();
    const dbPath = copilotDbPath(home);
    let copilotChanged = orgTransition; // enrollment flip re-folds a byte-identical db too
    let dbSize: number | undefined;
    try {
      dbSize = statSync(dbPath).size;
      const cursor = state.cursors[dbPath];
      if (!cursor || cursor.byteOffset !== dbSize) copilotChanged = true;
    } catch {
      skipped++; // a vanished/locked db must not abort the pass
    }

    if (copilotChanged) {
      const scan = scanCopilotCorpus(state, home);
      if (scan.skipReason) {
        skipped++; // this pass read nothing for Copilot -- retry next time, no cursor advance
      } else {
        scanHealth.copilot = { unknownLines: scan.unknownLines, totalLines: scan.totalLines, at: scannedAt };
        for (const s of scan.sessions) {
          applyRepositoryAttribution(s, state, org.ctx);
          const key = `${s.tool}_${s.toolSessionId}`;
          const digest = summaryDigest(s);
          if (state.threadDigests[key] === digest) continue;
          sessions.push(s);
          pendingDigests.set(key, digest);
        }
        if (dbSize !== undefined) state.cursors[dbPath] = { byteOffset: dbSize };
        if (scan.watermark !== null && scan.watermark > (state.watermarks[home] ?? 0)) {
          state.watermarks[home] = scan.watermark;
        }
      }
    }
  }

  if (skipped > 0 && opts.verbose) console.log(`  skipped ${skipped} unreadable transcript(s)`);

  // Merge (never replace) this pass's drift counters: providers that didn't re-scan
  // keep their last real numbers. Persists with whichever saveState path runs below —
  // a thrown pass persists nothing, same rule as the cursors it rides with.
  if (Object.keys(scanHealth).length > 0) state.scanHealth = { ...state.scanHealth, ...scanHealth };

  if (sessions.length === 0) {
    // Persist the advanced cursors even with nothing to upload (every thread's digest
    // already matched) so the next pass skips the corpus re-fold, and stamp the pass
    // completion so the hook-beat debounce doesn't respawn no-op syncs.
    if (org.confirmed) state.orgStamp = orgFingerprint; // digests now reflect this mode
    state.lastSyncAt = Date.now();
    saveState(state);
    if (opts.verbose) console.log("  Nothing new to sync.");
    return 0;
  }

  let accepted = 0;
  let flagged = 0;
  // L17 consented unknown-model share: ONLY when share-unknown-models is on does the payload
  // carry occurrence tallies of ids the bundled table can't price (never a rate, never a
  // spend). Built once from the whole pass and sent on the FIRST chunk only so the server's
  // increment isn't multiplied across chunks. undefined (consent off, or nothing unpriced)
  // is dropped by JSON.stringify, so an off device's payload is byte-identical to before.
  const unknownModels = buildUnknownModelShare(sessions, { consent: state.shareUnknownModels === true });
  for (let i = 0; i < sessions.length; i += INGEST_CHUNK) {
    const chunk = sessions.slice(i, i + INGEST_CHUNK);
    const r = await fetch(`${state.apiBase}/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${state.deviceToken}`,
      },
      body: JSON.stringify({
        trackerVersion: TRACKER_VERSION,
        sessions: chunk.map(toIngest),
        ...(i === 0 && unknownModels ? { unknownModels } : {}),
      }),
    });
    // 401 = this device's token was revoked (or never valid) — a permanent condition the
    // caller must surface as "re-pair", never retry-loop as a generic network error.
    // The cached org context is bound to that token: drop it so the next (re-paired)
    // sync re-confirms enrollment before attributing anything. The write goes through a
    // PRISTINE reload — this pass's in-memory state carries advanced cursors that must
    // never persist on a failed pass.
    if (r.status === 401) {
      try {
        const pristine = loadState();
        if (pristine.org) {
          delete pristine.org;
          saveState(pristine);
        }
      } catch {
        /* best-effort — re-pairing rewrites state anyway */
      }
      throw new Error("token_revoked");
    }
    // 403 account_deleted (the server's ingest contract): a soft-deleted
    // account's device token still resolves an identity, but ingest refuses to write
    // anything for it. This is a STOP, never a generic failure to retry-loop on: tell
    // the user exactly how to undo it and return cleanly. Deliberately does NOT reach
    // the cursor/digest persistence below (that only runs after a fully-successful
    // pass), so nothing is marked synced over data the server actually refused — the
    // next pass (post-restore, or the next periodic beat) re-offers the same corpus.
    if (r.status === 403) {
      const body = await r.json().catch(() => ({}));
      const outcome = classifyAccountDeleted(r.status, body);
      if (outcome.deleted) {
        // Mirror token_revoked: THROW (carrying restoreBy) instead of printing + returning
        // 0. A print+return-0 is indistinguishable from "nothing new to sync" to every
        // caller, so the persistent monitorLoop treats it as a normal empty pass and loops
        // again forever, re-printing this line every cycle. Callers print the message now
        // (bin/df.ts), exactly as they already do for token_revoked.
        throw Object.assign(new Error("account_deleted"), { restoreBy: outcome.restoreBy });
      }
      throw new Error(`ingest -> ${r.status}`); // a 403 for any OTHER reason stays generic
    }
    if (!r.ok) throw new Error(`ingest -> ${r.status}`);
    const j = (await r.json()) as { accepted?: number; flagged?: number };
    accepted += j.accepted ?? 0;
    flagged += j.flagged ?? 0;
  }

  // Only persist cursors + digests after a fully-successful sync (a failed pass retries;
  // a partially-uploaded pass re-upserts the same idempotent docs next time).
  for (const [key, digest] of pendingDigests) state.threadDigests[key] = digest;
  // orgStamp moves ONLY with the digests, and only under a CONFIRMED context — so a
  // failed or fail-closed pass leaves the transition pending and it re-fires next time.
  if (org.confirmed) state.orgStamp = orgFingerprint;
  state.lastSyncAt = Date.now();
  saveState(state);
  if (opts.verbose) {
    console.log(`  Synced ${sessions.length} session(s) (accepted ${accepted}, flagged ${flagged}).`);
  }
  // L19: hand the just-parsed sessions to the live-spend push (fail-silent — never let a
  // live-channel hiccup disrupt the completed capture).
  if (opts.onSessions) {
    try {
      await opts.onSessions(sessions);
    } catch {
      /* fail-silent: the live channel is additive status, never load-bearing for capture */
    }
  }
  return sessions.length;
}

export function toIngest(s: SessionSummary) {
  return {
    tool: s.tool,
    toolSessionId: s.toolSessionId,
    model: s.model,
    tokens: s.tokens,
    models: s.models,
    entryPoint: s.entryPoint,
    thinkingTokens: s.thinkingTokens,
    // MUE (docs/model-use-efficiency.md): its OWN component, status only, never in rank. Optional
    // exactly like skills/agents/days — undefined is dropped by JSON.stringify, so only sessions
    // that carry it change their digest, and the server IGNORES it until its own ingest increment
    // (bounds.ts gate + SessionRecord) learns it. Codex sessions never carry it.
    mue: s.mue,
    // skills is optional: undefined is dropped by JSON.stringify, so sessions without skill
    // use (and all Codex sessions) never carry the field. NOTE: the server ingest (bounds.ts
    // gate + SessionRecord) must learn `skills` in its own functions increment — until then
    // the endpoint ignores it, which is safe (additive detail, like models).
    skills: s.skills,
    // agents mirrors skills exactly (optional, dropped when undefined): sessions that
    // delegated to subagents carry Task subagent_type names + counts, nothing else.
    // NOTE: like skills before it, this changes the digest ONLY for sessions that
    // actually carry the field — the upgrade re-uploads exactly the delegating sessions.
    agents: s.agents,
    // days mirrors the same optional contract: only multi-day sessions carry slices, so
    // the 0.13.0 digest changes exactly for sessions spanning UTC midnights.
    days: s.days,
    wallMs: s.wallMs,
    activeMs: s.activeMs,
    idleMs: s.idleMs,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    repoHash: s.repoHash,
    // Org-enrolled devices only (client-side privacy gate, spec 2.1 #3): the normalized
    // owner/name slug, or ABSENT. undefined is dropped by JSON.stringify, so a
    // non-enrolled payload — and its digest — is byte-identical to pre-0.9.0, meaning
    // the 0.9.0 upgrade alone re-uploads nothing. Because the digest hashes this exact
    // payload, an enrollment flip changes digests and re-uploads exactly the sessions
    // whose attribution changed (see orgStamp in syncOnce).
    orgRepo: s.orgRepo,
    attribution: s.attribution,
    turns: s.turns,
    longestLoopMs: s.longestLoopMs,
    // Count of surviving deduped messages this thread OWNS after global dedup. 0 marks a
    // TOMBSTONE (a replay-only fork overwriting its stale inflated doc) — the server's
    // day fold skips those records so they can't mint sessions/active days.
    messageCount: s.messageCount,
    // Candidate shipped outcomes (commit SHAs authored in-window; metadata only). Optional/dropped
    // when undefined exactly like mue/skills/agents — only sessions that shipped commits carry it,
    // so the digest changes for exactly those; the server ignores it until its ingest increment.
    outcomes: s.outcomes,
  };
}
