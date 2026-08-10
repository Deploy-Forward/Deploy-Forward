/**
 * Codex CLI rollout parser.
 *
 * Reads ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl and extracts, per session:
 * cumulative token usage and message timestamps (for the active/idle estimate) — the same
 * metadata-only contract as the Claude Code parser. It reads ONLY usage numbers, the model
 * name and timestamps; never message content, reasoning, or tool inputs.
 *
 * Format (verified against real rollouts, re-verified 2026-07-01): every line is
 * `{ timestamp, type, payload }`.
 *   - session_meta.payload.id        -> the session id
 *   - turn_context.payload.model     -> the model (e.g. "gpt-5.5"); precedes its turn's counts
 *   - event_msg{type:"user_message"} -> a human turn
 *   - event_msg{type:"token_count"}  -> payload.info.{total_token_usage,last_token_usage}:
 *       { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens }
 *     where total_tokens == input_tokens + output_tokens (output already includes reasoning),
 *     and input_tokens is INCLUSIVE of cached_input_tokens. total_token_usage is CUMULATIVE,
 *     so the SESSION total is the LAST snapshot, not a sum across events.
 *
 * Per-model attribution (0.2.0): rollouts RE-EMIT the previous snapshot verbatim at each turn
 * start (verified: total == the sum of unique `last` values, so summing last_token_usage raw
 * would double-count). We therefore accumulate per-turn deltas as consecutive
 * total_token_usage DIFFS — duplicate re-emits diff to zero — credited to the model from the
 * most recent turn_context. Session totals stay the last-cumulative-snapshot math, unchanged.
 *
 * Out-of-order guard (L5, mirrors tokscale codex.rs:182-188): snapshots are CUMULATIVE, so
 * total_tokens must never regress. A snapshot whose total dips below the running watermark
 * but stays within 98% of it is a STALE out-of-order re-emit: it is ignored entirely (no
 * credit, no baseline advance, no session-total overwrite) so the recovery diffs against the
 * held watermark instead of double-counting the dip. A regression below 98% is a genuine
 * reset/new-rollout baseline: adopted with zero credit, exactly as the pre-guard clamp-at-0
 * math already behaved. See codexDelta().
 *
 * Defensive by design: an unrecognized/garbage line is skipped, never fatal.
 *
 * session_meta also carries `payload.cwd` (the session's working directory) on Codex
 * versions that emit it -- captured verbatim as `out.cwd` for LOCAL project attribution
 * only (`usage --by-project`); never uploaded (toIngest() in sync.ts doesn't carry it).
 *
 * Context occupancy (lane T3, SessionContext, also LOCAL-ONLY): each `token_count` event's
 * `info` sibling fields `last_token_usage` and `model_context_window` (verified real shape,
 * usageView.ts:504-513) are read independently of the cumulative `total_token_usage` math
 * above. `last_token_usage.input_tokens` is taken RAW -- deliberately NOT netted against
 * `cached_input_tokens` the way the session `tokens.input` total is (line ~136 below): it is
 * the full prompt as actually fed to the model, a conscious semantic split from the session
 * total, not a bug. Only the FINAL token_count event's own info wins (never summed/maxed);
 * an event with no `last_token_usage` yields no context, even if an earlier event had one.
 */
import { creditModel, foldModelBuckets, n, ZERO, type ParsedTranscript } from "./jsonl.js";
import type { TokenCounts } from "./types.js";

/**
 * Watermark guard for CUMULATIVE token_count snapshots (mirrors tokscale codex.rs:182-188).
 * Pure — exported for tests.
 *   - snapshotTotal >= prevWatermark: normal forward progress -> delta = the increment,
 *     watermark advances to snapshotTotal (an equal re-emit diffs to zero and holds).
 *   - prevWatermark*0.98 <= snapshotTotal < prevWatermark: STALE out-of-order snapshot ->
 *     delta = 0, watermark HELD at prevWatermark (never reset by a transient dip).
 *   - snapshotTotal < prevWatermark*0.98: genuine reset / new-rollout baseline ->
 *     delta = 0, watermark adopts snapshotTotal.
 */
export function codexDelta(
  prevWatermark: number,
  snapshotTotal: number,
): { delta: number; watermark: number } {
  if (snapshotTotal >= prevWatermark) {
    return { delta: snapshotTotal - prevWatermark, watermark: snapshotTotal };
  }
  if (snapshotTotal >= prevWatermark * 0.98) {
    return { delta: 0, watermark: prevWatermark };
  }
  return { delta: 0, watermark: snapshotTotal };
}

export function parseCodexRollout(content: string): ParsedTranscript {
  const out: ParsedTranscript = {
    toolSessionId: null,
    model: "unknown",
    tokens: { ...ZERO },
    models: [],
    entryPoint: "cli",
    thinkingTokens: 0,
    skills: [], // Codex has no skills concept (v1) — always empty, omitted at ingest
    agents: [], // ...and no Task/subagent concept either
    timestamps: [],
    humanPromptTimestamps: [],
    messageCount: 0,
    lastMessageUuid: null,
    skipped: 0,
    totalLines: 0,
    usageEvents: [],
  };

  // token_count events are CUMULATIVE — keep only the latest snapshot as the session total.
  // A stale out-of-order dip never overwrites it (see codexDelta), so session totals can't
  // momentarily regress either.
  let lastTotal: Record<string, unknown> | null = null;
  // Running watermark over total_tokens: gates whether a snapshot's field deltas are
  // credited AND whether the prev* baselines advance (see codexDelta above).
  let watermark = 0;
  // Per-turn delta attribution: previous cumulative raw fields (see header). Duplicate
  // re-emits of the same snapshot diff to zero, so they can never double-credit a model.
  let prevInput = 0;
  let prevCached = 0;
  let prevOutput = 0;
  let prevReasoning = 0;
  const byModel = new Map<string, TokenCounts>();
  // Context occupancy (lane T3): the FINAL token_count event's own `info` object, its
  // timestamp string (passed through verbatim, never reparsed), and the model in force at
  // that moment -- each overwritten unconditionally on every token_count event, so only the
  // LAST one in the file survives to the derivation after the loop.
  let finalInfo: Record<string, unknown> | null = null;
  let finalAt: string | null = null;
  let finalContextModel = "unknown";

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

    const p = entry?.payload ?? {};
    const ts = typeof entry?.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (Number.isFinite(ts)) out.timestamps.push(ts);

    switch (entry?.type) {
      case "session_meta":
        if (!out.toolSessionId && typeof p.id === "string") out.toolSessionId = p.id;
        if (out.cwd === undefined && typeof p.cwd === "string" && p.cwd) out.cwd = p.cwd;
        break;
      case "turn_context":
        if (typeof p.model === "string" && p.model) out.model = p.model;
        if (typeof p.entryPoint === "string" && p.entryPoint) {
          out.entryPoint = p.entryPoint === "vscode" ? "codex-vscode" : p.entryPoint;
        }
        break;
      case "event_msg":
        if (p.type === "user_message") {
          if (Number.isFinite(ts)) out.humanPromptTimestamps.push(ts);
        } else if (p.type === "token_count") {
          const info = p?.info;
          if (info && typeof info === "object") {
            finalInfo = info;
            finalAt = typeof entry.timestamp === "string" ? entry.timestamp : null;
            finalContextModel = out.model;
          }
          const total = p?.info?.total_token_usage;
          if (total && typeof total === "object") {
            out.messageCount++; // proxy for assistant activity; keeps summarizeFile from bailing
            // Out-of-order guard: a stale dip (total regresses but stays within 98% of the
            // watermark) is ignored wholesale -- no credit, no baseline advance, no session-
            // total overwrite -- so the recovery diffs against the HELD watermark and the dip
            // can never double-count. (A missing/garbage total_tokens reads as 0 via n(), so
            // the watermark stays 0 and this guard degrades to the pre-guard behavior.)
            const snapshotTotal = n(total.total_tokens);
            const next = codexDelta(watermark, snapshotTotal);
            const staleOutOfOrder = snapshotTotal < watermark && next.watermark === watermark;
            watermark = next.watermark;
            if (staleOutOfOrder) break;
            lastTotal = total;
            // input_tokens is INCLUSIVE of cached_input_tokens -- a malformed snapshot with
            // cached > input clamps to the inclusive bound rather than crediting phantom reads.
            const snapInput = n(total.input_tokens);
            const snapCached = Math.min(n(total.cached_input_tokens), snapInput);
            // Credit this snapshot's cumulative DELTA to the current turn's model. Clamp at 0:
            // a snapshot must never decrease, but a malformed one must not produce negatives.
            const dInput = Math.max(0, snapInput - prevInput);
            const dCached = Math.max(0, snapCached - prevCached);
            const dOutput = Math.max(0, n(total.output_tokens) - prevOutput);
            const dReasoning = Math.max(0, n(total.reasoning_output_tokens) - prevReasoning);
            out.thinkingTokens += dReasoning;
            if (dInput || dCached || dOutput) {
              const delta: TokenCounts = {
                input: Math.max(0, dInput - dCached), // fresh input excludes the cache-read delta
                output: dOutput,
                cacheRead: dCached,
                cacheCreation: 0,
              };
              creditModel(byModel, out.model, delta);
              // Same delta, also kept as a discrete timestamped event for the per-day fold
              // (usage --by-day) -- duplicate re-emits never reach here (they diff to zero
              // above), so this can't double-count a day's usage either.
              if (Number.isFinite(ts)) out.usageEvents!.push({ ts, model: out.model, tokens: delta });
            }
            prevInput = snapInput;
            prevCached = snapCached;
            prevOutput = n(total.output_tokens);
            prevReasoning = n(total.reasoning_output_tokens);
          }
        }
        break;
      default:
        break;
    }
  }

  if (lastTotal) {
    const input = n(lastTotal.input_tokens);
    // input_tokens is inclusive of cached_input_tokens -- clamp a malformed cached > input.
    const cached = Math.min(n(lastTotal.cached_input_tokens), input);
    out.tokens = {
      // input_tokens is inclusive of the cache-read portion; fresh input excludes it.
      input: Math.max(0, input - cached),
      // output_tokens already includes reasoning_output_tokens — do not add it again.
      output: n(lastTotal.output_tokens),
      cacheRead: cached,
      cacheCreation: 0, // Codex doesn't distinguish cache creation
    };
    out.thinkingTokens = n(lastTotal.reasoning_output_tokens);
  }
  out.models = foldModelBuckets(byModel);

  // Context occupancy (lane T3): derived ONLY from the FINAL token_count event's own info --
  // fail-soft when it never carried a real last_token_usage.input_tokens (no guess, no fallback
  // to an earlier event's value).
  if (finalInfo) {
    const ltu = finalInfo.last_token_usage;
    if (ltu && typeof ltu === "object" && typeof (ltu as Record<string, unknown>).input_tokens === "number") {
      const mcw = finalInfo.model_context_window;
      out.context = {
        occupancyTokens: (ltu as Record<string, unknown>).input_tokens as number,
        model: finalContextModel,
        windowTokens: typeof mcw === "number" ? mcw : undefined,
        at: finalAt ?? undefined,
      };
    }
  }

  out.timestamps.sort((a, b) => a - b);
  out.humanPromptTimestamps.sort((a, b) => a - b);
  return out;
}
