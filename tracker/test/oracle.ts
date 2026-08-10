/**
 * Deploy Forward Atomic Capture Standard — the INDEPENDENT ORACLE (Phase 0).
 *
 * A deliberately naive, clarity-first transcription of the locked contract in
 * docs/atomic-capture-implementation-plan.md §1-§2, written FROM THE SPEC TEXT — not from
 * tracker/src. It is the independent leg of the Phase-0 gate:
 *
 *     fixture truth  ==  this oracle  ==  the tracker pipeline
 *
 * Do NOT import tracker/src here and do NOT optimize (linear scans on purpose, mirroring the
 * steward reference's shape: ccusage push_deduped_daily_entry / should_replace_deduped_daily_entry
 * / is_valid_daily_usage_entry, rust/crates/ccusage/src/adapter/claude/daily.rs @ f3a8eab).
 * If oracle and pipeline ever disagree, the SPEC decides which one is wrong.
 *
 * Contract encoded here:
 *  - Validity gate (pre-filter, both branches): reject present-but-EMPTY sessionId / requestId /
 *    messageId / model and a present non-semver version. ABSENT fields are fine.
 *  - An entry with NO messageId is counted as-is (never deduped).
 *  - Dedup key: exact (messageId, requestId); msgid-only fallback fires ONLY when at least one
 *    side is a sidechain. Two non-sidechain entries sharing a messageId but differing on
 *    requestId are NOT merged.
 *  - Replacement: order-independent WHOLE-RECORD max-wins — (1) sidechain differs -> keep the
 *    non-sidechain copy, (2) greater total tokens, (3) greater cost, (4) speed populated.
 *    Never combine fields across copies.
 *  - GLOBAL dedup across all files before any roll-up; each surviving message is assigned to
 *    its FIRST-OCCURRENCE thread (lineage only — assignment can never change a total).
 *  - Corpus order (determinism contract): roots sorted by earliest valid usage-entry timestamp,
 *    ties by threadId; within a root, the root's own lines first, then its subagent files
 *    sorted by path. Subagent entries attribute to the PARENT thread.
 *  - Capture is VERBATIM: model ids at full length, `<synthetic>` kept, no caps, no folds.
 *    An absent model buckets as "unknown" so Σ models == totals always holds.
 */

export interface OracleTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface OracleFile {
  /** Path relative to the project dir, "/"-separated. A root is "<base>.jsonl" (no "/"); a
   * subagent file lives under "<base>/subagents/...". */
  relPath: string;
  content: string;
}

export interface OracleResult {
  /** Global per-model verbatim totals over surviving entries. */
  byModel: Record<string, OracleTokens>;
  /** Global totals == Σ byModel (the derived-total invariant). */
  totals: OracleTokens;
  /** Per-thread totals after first-occurrence assignment (threads with >=1 valid entry). */
  perThread: Record<string, OracleTokens>;
  /** Threads whose every valid entry deduped away into another thread (zero survivors). */
  zeroedThreads: string[];
}

interface OracleEntry {
  timestamp: string | undefined;
  sessionId: string | undefined;
  version: string | undefined;
  messageId: string | undefined;
  requestId: string | undefined;
  model: string | undefined;
  isSidechain: boolean;
  hasSpeed: boolean;
  cost: number;
  tokens: OracleTokens;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function zero(): OracleTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

function add(into: OracleTokens, t: OracleTokens): void {
  into.input += t.input;
  into.output += t.output;
  into.cacheRead += t.cacheRead;
  into.cacheCreation += t.cacheCreation;
}

function total(t: OracleTokens): number {
  return t.input + t.output + t.cacheRead + t.cacheCreation;
}

/**
 * Minimal extraction of the two canonical transcript shapes:
 *  - DIRECT:         { timestamp, sessionId, version, requestId, isSidechain, message: { id, model, usage } }
 *  - AGENT-PROGRESS: { data: { message: { timestamp, requestId, isSidechain, message: { id, model, usage } } } }
 * The agent-progress shape is pinned by the steward reference test
 * `propagates_sidechain_metadata_from_agent_progress_lines` (daily.rs:570-578) — its
 * isSidechain drives the msgid-only fallback tier, so the oracle must see it too.
 * Agent-progress lines carry NO sessionId/version (absent, not empty — still valid).
 */
function extractEntries(content: string): OracleEntry[] {
  const out: OracleEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: any;
    try {
      e = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const progress = e?.data?.message?.message?.usage ? e.data.message : null;
    const src = progress ?? e;
    const msg = src?.message;
    const usage = msg?.usage;
    if (!usage || typeof usage !== "object") continue;
    out.push({
      timestamp: str(src?.timestamp),
      sessionId: progress ? undefined : str(e?.sessionId),
      version: progress ? undefined : str(e?.version),
      messageId: str(msg?.id),
      requestId: str(src?.requestId),
      model: str(msg?.model),
      isSidechain: src?.isSidechain === true,
      hasSpeed: usage.speed != null,
      cost: num(src?.costUSD),
      tokens: {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheCreation: num(usage.cache_creation_input_tokens),
      },
    });
  }
  return out;
}

/** §1 validity gate: present-but-empty ids/model and present non-semver version reject the
 * WHOLE entry; absent fields are fine. */
function isValid(e: OracleEntry): boolean {
  if (e.version !== undefined && !/^\d+\.\d+\.\d/.test(e.version)) return false;
  if (e.sessionId === "") return false;
  if (e.requestId === "") return false;
  if (e.messageId === "") return false;
  if (e.model === "") return false;
  return true;
}

/** §1 replacement: whole-record max-wins, order-independent. */
function shouldReplace(candidate: OracleEntry, existing: OracleEntry): boolean {
  if (candidate.isSidechain !== existing.isSidechain) return existing.isSidechain;
  const ct = total(candidate.tokens);
  const et = total(existing.tokens);
  if (ct !== et) return ct > et;
  if (candidate.cost !== existing.cost) return candidate.cost > existing.cost;
  return candidate.hasSpeed && !existing.hasSpeed;
}

export function runOracle(files: OracleFile[]): OracleResult {
  // ---- group files into threads (root + its subagent files) --------------------------------
  const rootBase = (relPath: string): string =>
    relPath.includes("/") ? relPath.split("/")[0] : relPath.replace(/\.jsonl$/i, "");

  interface Thread {
    base: string;
    rootEntries: OracleEntry[];
    subFiles: { relPath: string; entries: OracleEntry[] }[];
    threadId: string;
  }
  const threads = new Map<string, Thread>();
  for (const f of files) {
    const base = rootBase(f.relPath);
    let t = threads.get(base);
    if (!t) {
      t = { base, rootEntries: [], subFiles: [], threadId: base };
      threads.set(base, t);
    }
    const entries = extractEntries(f.content);
    if (f.relPath.includes("/")) t.subFiles.push({ relPath: f.relPath, entries });
    else {
      t.rootEntries = entries;
      // threadId = the root file's sessionId when present (first non-empty), else the base name.
      for (const line of f.content.split("\n")) {
        try {
          const e = JSON.parse(line.trim());
          if (typeof e?.sessionId === "string" && e.sessionId) {
            t.threadId = e.sessionId;
            break;
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  // ---- deterministic corpus order -----------------------------------------------------------
  // Roots by earliest VALID usage-entry timestamp (root's own entries first, then subagents,
  // which is also the within-thread entry order), ties by threadId.
  const ordered = [...threads.values()].map((t) => {
    t.subFiles.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    const all = [...t.rootEntries, ...t.subFiles.flatMap((s) => s.entries)];
    let first = Infinity;
    for (const e of all) {
      if (!isValid(e) || !e.timestamp) continue;
      const ts = Date.parse(e.timestamp);
      if (Number.isFinite(ts) && ts < first) first = ts;
    }
    return { t, first, all };
  });
  ordered.sort((a, b) => a.first - b.first || (a.t.threadId < b.t.threadId ? -1 : a.t.threadId > b.t.threadId ? 1 : 0));

  // ---- global flat dedup (naive linear scans, exactly the steward reference's shape) --------
  const survivors: { entry: OracleEntry; owner: string }[] = [];
  const pushedByThread = new Map<string, number>(); // valid entries offered per thread

  for (const { t, all } of ordered) {
    for (const entry of all) {
      if (!isValid(entry)) continue;
      pushedByThread.set(t.threadId, (pushedByThread.get(t.threadId) ?? 0) + 1);

      if (entry.messageId === undefined) {
        survivors.push({ entry, owner: t.threadId }); // counted as-is, never deduped
        continue;
      }
      // exact tier: (messageId, requestId)
      let hit = -1;
      for (let i = 0; i < survivors.length; i++) {
        const s = survivors[i].entry;
        if (s.messageId === entry.messageId && s.requestId === entry.requestId) {
          hit = i;
          break;
        }
      }
      // fallback tier: messageId alone, only when at least one side is a sidechain
      if (hit < 0) {
        for (let i = 0; i < survivors.length; i++) {
          const s = survivors[i].entry;
          if (s.messageId === entry.messageId && (entry.isSidechain || s.isSidechain)) {
            hit = i;
            break;
          }
        }
      }
      if (hit >= 0) {
        if (shouldReplace(entry, survivors[hit].entry)) {
          // whole-record replacement; the FIRST-OCCURRENCE owner is lineage and never moves.
          survivors[hit] = { entry, owner: survivors[hit].owner };
        }
        continue;
      }
      survivors.push({ entry, owner: t.threadId });
    }
  }

  // ---- roll-ups (pure reads over survivors) -------------------------------------------------
  const byModel: Record<string, OracleTokens> = {};
  const perThread: Record<string, OracleTokens> = {};
  const totals = zero();
  for (const id of pushedByThread.keys()) perThread[id] = zero();
  for (const { entry, owner } of survivors) {
    const model = entry.model ?? "unknown";
    byModel[model] ??= zero();
    add(byModel[model], entry.tokens);
    add(perThread[owner], entry.tokens);
    add(totals, entry.tokens);
  }
  const zeroedThreads = [...pushedByThread.keys()].filter((id) => total(perThread[id]) === 0).sort();

  return { byModel, totals, perThread, zeroedThreads };
}
