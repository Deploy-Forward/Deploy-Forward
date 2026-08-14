/**
 * limitLanes — ONE limit-lane composition for every surface (Marco 2026-08-13:
 * "cross laterally, uniformly for CLI and localhost").
 *
 * composeLimitLanes() is the single place that decides what lanes exist, what
 * they say, and when the vendor-reported Claude lanes REPLACE the timestamp
 * estimate. The localhost dashboard renders these lanes as HTML bars; the CLI
 * `usage` footer renders the SAME array as terminal bars (limitLaneTextLines).
 * Neither surface composes lanes on its own, so they cannot drift apart.
 *
 * Honesty rules, enforced here once:
 *  - A lane with no vendor denominator (the Claude 5h reconstruction) gets
 *    percent: null — renderers must show text, never a bar. A bar with no
 *    denominator lies.
 *  - Vendor percents clamp into [0,100] for the FILL; the detail text keeps the
 *    verbatim number.
 *  - A failed opt-in fetch says WHY beside the estimate instead of silently
 *    downgrading (claudeLanesNote).
 */
import { fetchClaudeLimits, resolveLimitsConsent, claudeCredentialsPath, type ClaudeLimitLane, type ClaudeLimitsFailureReason } from "./limitsFetch.js";
import { loadState } from "./config.js";
import type { CodexRateLimits, Claude5hBlock } from "./usageView.js";
import type { GrokCredits } from "./grok.js";

export interface LimitLane {
  label: string;
  /** 0-100 bar fill, or null when there is no vendor denominator — text only then. */
  percent: number | null;
  detail: string;
  estimate: boolean;
}

export interface LimitLaneSource {
  codexLimits: CodexRateLimits | null;
  claudeLanes: ClaudeLimitLane[] | null;
  claudeLanesNote: string | null;
  claude5h: Claude5hBlock | null;
  grokCredits: GrokCredits | null;
}

function clamp(p: number): number {
  return Math.min(100, Math.max(0, p));
}

/** 1_234_567 -> "1.2M" — same magnitudes the CLI table prints (local copy: a runtime
 * import from usageView here would close an import cycle, since usageView renders
 * these lanes). */
function compactTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** "2026-08-13T05:00:00Z" -> local "05:00" (or null when unparseable — never guessed). */
function resetClock(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Name a Codex window by what it IS, never by vendor slot ("primary"/"secondary"):
 * Codex's snapshots currently report ONLY the weekly window (primary 10080m,
 * secondary null — corpus-verified 2026-08-14), so the moment a 5h window
 * reappears in the data it self-labels correctly with no code change. */
function codexWindowLabel(windowMinutes: number): string {
  if (windowMinutes === 300) return "Codex 5h";
  if (windowMinutes === 10_080) return "Codex weekly";
  return `Codex ${Math.round(windowMinutes / 60)}h`;
}

export function composeLimitLanes(src: LimitLaneSource): LimitLane[] {
  const lanes: LimitLane[] = [];
  const cx = src.codexLimits;
  for (const w of [cx?.primary, cx?.secondary]) {
    if (!w) continue;
    lanes.push({
      label: codexWindowLabel(w.windowMinutes),
      percent: clamp(w.usedPercent),
      detail: `${w.usedPercent}% of ${Math.round(w.windowMinutes / 60)}h window`,
      estimate: false,
    });
  }
  if (src.grokCredits && src.grokCredits.percent !== null) {
    lanes.push({
      label: "Grok credits",
      percent: clamp(src.grokCredits.percent),
      detail: `${src.grokCredits.percent}% used${src.grokCredits.periodType?.includes("WEEKLY") ? " · weekly" : ""}`,
      estimate: false,
    });
  }
  if (src.claudeLanes && src.claudeLanes.length > 0) {
    // Vendor-reported lanes: REAL percentages with a real denominator, so real
    // bars — and they REPLACE the timestamp estimate entirely (the CLI's rule).
    for (const l of src.claudeLanes) {
      const label =
        l.kind === "session" ? "Claude session" : l.scopeLabel ? `Claude · ${l.scopeLabel}` : "Claude weekly";
      const reset = resetClock(l.resetsAt);
      lanes.push({
        label,
        percent: clamp(l.percent),
        detail: `${l.percent}% used${reset ? ` · resets ${reset}` : ""}`,
        estimate: false,
      });
    }
  } else if (src.claude5h) {
    const note = src.claudeLanesNote ? ` · ${src.claudeLanesNote}` : "";
    lanes.push({
      label: "Claude 5h window",
      percent: null,
      detail: `${compactTokens(src.claude5h.tokensUsed)} tokens${src.claude5h.active ? " · window open" : ""} · estimate${note}`,
      estimate: true,
    });
  }
  return lanes;
}

/**
 * Terminal render of the shared lanes: `label  ███░░░  detail`. Estimate lanes
 * (percent null) carry no bar glyphs at all — same honesty rule as the HTML render.
 */
export function limitLaneTextLines(lanes: LimitLane[], opts: { barWidth?: number } = {}): string[] {
  const barWidth = opts.barWidth ?? 24;
  const labelWidth = Math.max(0, ...lanes.map((l) => l.label.length)) + 2;
  return lanes.map((l) => {
    const label = l.label.padEnd(labelWidth);
    if (l.percent === null) return `${label}${l.detail}`;
    const filled = Math.round((l.percent / 100) * barWidth);
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
    return `${label}${bar}  ${l.detail}`;
  });
}

// ---- consent-gated, TTL-cached vendor fetch (shared by serve and the usage footer) ------------

export interface ClaudeVendorLanes {
  lanes: ClaudeLimitLane[] | null;
  note: string | null;
}

const LANES_TTL_MS = 5 * 60_000; // superStart's own LANES_REFRESH_MS cadence
let lanesCache: { at: number; vendor: ClaudeVendorLanes } | null = null;

function laneFailureNote(reason: ClaudeLimitsFailureReason): string | null {
  switch (reason) {
    case "not-opted-in":
      return null; // consent absent is not an error — the estimate stands, unannotated
    case "no-credentials":
      return "vendor lanes: no Claude credentials found";
    case "token-expired":
      return "vendor lanes: token expired — run: claude login";
    case "network":
      return "vendor lanes: network error";
    case "http-error":
      return "vendor lanes: usage endpoint error";
    case "bad-shape":
      return "vendor lanes: unrecognized response shape";
  }
}

/**
 * Consent-gated, TTL-cached vendor lanes — the same opt-in flag, credentials path,
 * endpoint, and 5-minute cadence the super-start watch uses. Consent is re-read on
 * every call, so a settings toggle takes effect on the next read without a restart.
 */
export async function currentClaudeVendorLanes(
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<ClaudeVendorLanes> {
  if (!resolveLimitsConsent(undefined, loadState().limitsProviders?.claude)) {
    lanesCache = null;
    return { lanes: null, note: null };
  }
  if (lanesCache && now - lanesCache.at < LANES_TTL_MS) return lanesCache.vendor;
  const r = await fetchClaudeLimits({ optedIn: true, credPath: claudeCredentialsPath(), fetchImpl, nowMs: now });
  const vendor: ClaudeVendorLanes = r.ok
    ? { lanes: r.lanes, note: null }
    : { lanes: null, note: laneFailureNote(r.reason) };
  lanesCache = { at: now, vendor };
  return vendor;
}
