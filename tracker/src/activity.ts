/**
 * Active vs idle estimate — the Steam-playtime heuristic.
 *
 * Claude Code has no local "active time" signal outside OpenTelemetry, so we
 * reconstruct it from message timestamps: walk consecutive events and credit each
 * gap as active up to a threshold; anything beyond the threshold is idle (you walked
 * away). A final "tail" credit accounts for the last event having no successor.
 *
 * This is explicitly an ESTIMATE; the UI labels it as such and OTel is the precise
 * upgrade path (the verified tier).
 *
 * DENSITY FLOOR (RC-I, 0.3.0). The pure gap model assumes consecutive timestamps
 * BOUND real elapsed work — true for Claude, whose events are logged as they happen.
 * Codex rollouts are NOT logged that way: many streams are flushed in one write (whole
 * sessions land within a ~200ms span) or log bursts of same-instant events, so the
 * between-event gaps under-represent the true active time. That shrinks the denominator
 * and makes an honest ~200 tok/s session read as tens-of-thousands tok/s — a FALSE
 * `token_rate_implausible` / `turns_implausible` exclusion (verified on the real corpus:
 * 3 of 56 Codex sessions false-flagged; 0 after this fix).
 *
 * The fix is a per-event FLOOR, not a tool string (which is spoofable): every consecutive
 * step is credited AT LEAST `minEventMs` of active time, because each logged event is a
 * real model/tool round-trip that took at least that long. It is applied as
 * `active += clamp(gap, minEventMs, gapMs)`, so:
 *   - dense/real streams are UNCHANGED — their gaps already exceed the floor (the floor
 *     only ever lifts sub-`minEventMs` gaps), so a genuine session is untouched;
 *   - collapsed/sparse streams recover a defensible LOWER-BOUND active time;
 *   - the rate ceiling still bites genuine fabrication — a huge token count with FEW
 *     events floors to only a few seconds of active time, so its rate stays superhuman.
 * Because the floor can push summed active past the raw timestamp span, wallMs is now
 * derived as active + idle (it was span + tail, which equals active + idle whenever the
 * floor is inert — so normal sessions are unchanged). activeMs feeds NO Build Score axis,
 * so this reconstruction can only move a STATUS lens, never rank.
 */

export interface Activity {
  wallMs: number;
  activeMs: number;
  idleMs: number;
}

export const DEFAULT_GAP_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Minimum active time credited per logged event (the density floor above). One second is a
 * conservative lower bound on a single model/tool round-trip and is deliberately global
 * (never keyed on the client-controlled tool string). Calibrated on the real corpus: it
 * clears every false Codex rate-flag with margin while lifting dense Claude active time by
 * <3% (its gaps already exceed 1s, so the floor is inert there).
 */
export const MIN_EVENT_ACTIVE_MS = 1000;

/** One UTC day's share of a session's reconstructed activity. */
export interface ActivityDaySlice {
  activeMs: number;
  idleMs: number;
}

const DAY_MS = 86_400_000;
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Distribute `amountMs` starting at `fromMs` across UTC days, clipping at midnights. */
function clipIntoDays(
  into: Map<string, ActivityDaySlice>,
  fromMs: number,
  amountMs: number,
  field: keyof ActivityDaySlice,
): void {
  let t = fromMs;
  let left = amountMs;
  while (left > 0) {
    const nextMidnight = (Math.floor(t / DAY_MS) + 1) * DAY_MS;
    const take = Math.min(left, nextMidnight - t);
    const slice = into.get(utcDayKey(t)) ?? { activeMs: 0, idleMs: 0 };
    slice[field] += take;
    into.set(utcDayKey(t), slice);
    t += take;
    left -= take;
  }
}

/**
 * The SAME crediting walk as computeActivity below, with every credited quantum clipped
 * at UTC midnight boundaries — per-day activeMs/idleMs sum EXACTLY to computeActivity's
 * totals (asserted by test, not hoped). Day membership is the clock ruling (2026-07-13):
 * a day appears here iff some credited quantum genuinely overlaps it. No smearing: each
 * step's credit occupies the interval starting at its own real timestamp, so nothing is
 * attributed to a day the stream never touched.
 */
export function sliceActivityByDay(
  timestamps: number[],
  gapMs: number = DEFAULT_GAP_MS,
  minEventMs: number = MIN_EVENT_ACTIVE_MS,
): Map<string, ActivityDaySlice> {
  const out = new Map<string, ActivityDaySlice>();
  const ts = [...timestamps].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (ts.length === 0) return out;
  const tail = Math.min(gapMs, 30 * 1000);
  if (ts.length === 1) {
    clipIntoDays(out, ts[0], tail, "activeMs");
    return out;
  }
  const floor = Math.min(Math.max(0, minEventMs), gapMs);
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    clipIntoDays(out, ts[i - 1], Math.min(Math.max(gap, floor), gapMs), "activeMs");
    if (gap > gapMs) clipIntoDays(out, ts[i - 1] + gapMs, gap - gapMs, "idleMs");
  }
  clipIntoDays(out, ts[ts.length - 1], tail, "activeMs");
  return out;
}

export function computeActivity(
  timestamps: number[],
  gapMs: number = DEFAULT_GAP_MS,
  minEventMs: number = MIN_EVENT_ACTIVE_MS,
): Activity {
  const ts = [...timestamps].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (ts.length === 0) return { wallMs: 0, activeMs: 0, idleMs: 0 };
  const tail = Math.min(gapMs, 30 * 1000);
  if (ts.length === 1) {
    // A single event: credit a short tail of active time, no idle.
    return { wallMs: tail, activeMs: tail, idleMs: 0 };
  }
  // A floor above the gap ceiling would be nonsensical; keep it within [0, gapMs].
  const floor = Math.min(Math.max(0, minEventMs), gapMs);

  let active = 0;
  let idle = 0;
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    // Credit each step in [floor, gapMs]: the floor recovers collapsed/sparse streams,
    // the gapMs ceiling still sheds genuine walk-away idle beyond it.
    active += Math.min(Math.max(gap, floor), gapMs);
    if (gap > gapMs) idle += gap - gapMs;
  }
  active += tail; // final event has no successor

  // wall = active + idle. Equals (span + tail) whenever the floor is inert (every gap >=
  // floor), so dense sessions are unchanged; when the floor lifts sub-floor gaps, wall
  // grows past the raw span to stay consistent with the recovered active time.
  return { wallMs: active + idle, activeMs: active, idleMs: idle };
}

export interface Loops {
  /** Count of human->agent turns (number of human/user prompts) in the session. */
  turns: number;
  /** Longest continuous span (ms) of agent work with no human input. */
  longestLoopMs: number;
}

/**
 * Turns + longest autonomous loop.
 *
 * A "turn" is one human prompt. The "longest loop" is the longest stretch the agent ran
 * ACTIVELY between two human prompts — i.e. the longest active span (consecutive events
 * with gaps <= gapMs) bounded by human prompts. Idle is excluded: if a builder fires a
 * prompt then walks away for hours before the next, that idle gap is NOT an autonomous
 * loop (it would otherwise inflate "Longest Loop" to wall-time). Same gap model as
 * computeActivity, so loop time can never exceed the session's active time.
 *
 * Needs the full event stream (not just human prompts) to separate active work from idle.
 * Defensive: missing/garbage data yields zeros, never a throw.
 */
export function computeLoops(
  allTimestamps: number[],
  humanTimestamps: number[],
  gapMs: number = DEFAULT_GAP_MS,
): Loops {
  const ts = (Array.isArray(allTimestamps) ? allTimestamps : [])
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  const hs = (Array.isArray(humanTimestamps) ? humanTimestamps : []).filter((t) =>
    Number.isFinite(t)
  );
  const turns = hs.length;
  if (turns === 0 || ts.length === 0) return { turns, longestLoopMs: 0 };

  const humanSet = new Set(hs);
  let longest = 0;
  let cur = 0;
  let started = false; // only accrue once the first human prompt has opened a span
  let prev = NaN;
  for (const t of ts) {
    if (humanSet.has(t)) {
      // a human prompt closes the current autonomous span (its incoming gap, which may be
      // a long "walked away" idle, is deliberately not credited to the loop).
      if (cur > longest) longest = cur;
      cur = 0;
      started = true;
      prev = t;
      continue;
    }
    if (started && Number.isFinite(prev)) {
      const gap = t - prev;
      if (gap > 0) cur += Math.min(gap, gapMs); // active portion only
    }
    prev = t;
  }
  if (cur > longest) longest = cur;
  return { turns, longestLoopMs: Math.max(0, longest) };
}
