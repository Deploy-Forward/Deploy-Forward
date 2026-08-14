/**
 * Claude usage-limits fetch (lane T8) — opt-in, READ-ONLY, vendor-reported, fail-soft.
 *
 * Binding rulings (Marco, 2026-07-17), each enforced in code below, not just in prose:
 *
 *   - Opt-in is a hard gate. optedIn=false means the network is NEVER touched — not the
 *     credentials file, not fetch. Checked first, before any other work.
 *   - READ-ONLY tokens. We only ever READ Claude Code's own OAuth credentials file; we
 *     never refresh and never write back. An expired token returns "token-expired"
 *     WITHOUT attempting a call — refreshing is the user's own CLI's job, not ours, and a
 *     call made with a token we know is dead is a doomed request for nothing. The render
 *     layer is responsible for telling the user to `claude login` (or equivalent) again.
 *   - The token goes ONLY to api.anthropic.com. It is never logged, never interpolated
 *     into an error message or any other string that could end up in a typed result --
 *     every failure path returns a bare reason code, nothing captured from the token or
 *     from an underlying error's message.
 *   - Fail soft everywhere. Every failure -- missing file, malformed JSON, expired token,
 *     network error, non-2xx, unparseable or wrongly-shaped body -- returns a typed
 *     { ok: false, reason } result. This module never throws.
 *   - Malformed lanes inside limits[] are dropped individually; the well-formed lanes
 *     still survive. If NO lane survives (or limits[] is absent/empty), we fall back to
 *     synthesizing session/weekly_all lanes from five_hour/seven_day. If even that isn't
 *     there, or the body is garbage/wrong-shaped, the result is null -- never a guess.
 *   - The endpoint (GET /api/oauth/usage) is undocumented and may change shape at any
 *     time. The parser stays TOLERANT of unknown/extra fields (ignored) and STRICT only
 *     on the fields it actually needs.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- Consent + credentials location (moved from superStart so every surface — the
// watch, the CLI usage footer, the localhost dashboard — resolves them identically
// without importing the whole showcase module) ---------------------------------------

/** The extracted pure decision table for the Tier B lanes fetch: an explicit per-run
 * flag (true OR false) always wins; omitted falls back to the persisted opt-in; both
 * absent is false — today's default unchanged. `??` only falls through on undefined,
 * so an explicit per-run decline is never masked by a persisted true. */
export function resolveLimitsConsent(flag: boolean | undefined, statePersisted: boolean | undefined): boolean {
  return flag ?? statePersisted ?? false;
}

/** argv -> the per-run flag for resolveLimitsConsent: `--limits` present -> true,
 * absent -> undefined (defer to the persisted opt-in). NEVER false from mere
 * absence — bin once passed hasFlag("limits") here, and that synthetic false was
 * an explicit per-run decline masking every persisted opt-in (the 0.25.0 watch
 * showed the 5h estimate while `usage` and `serve` rendered real vendor lanes). */
export function limitsCliFlag(argv: readonly string[]): true | undefined {
  return argv.includes("--limits") ? true : undefined;
}

/** The env-overridable Claude Code credentials location — one source for every caller. */
export function claudeCredentialsPath(): string {
  return process.env.DF_CLAUDE_CREDENTIALS ?? join(homedir(), ".claude", ".credentials.json");
}

// ---- Types -----------------------------------------------------------------------------

/** One usage lane as rendered to the user -- vendor field names translated to camelCase,
 * nothing else changed. `scopeLabel` is the human-readable model/surface scope, or null
 * for an unscoped (all-models) lane. */
export interface ClaudeLimitLane {
  kind: string;
  group: string;
  percent: number;
  severity: string;
  resetsAt: string;
  scopeLabel: string | null;
}

export type ClaudeLimitsFailureReason =
  | "not-opted-in"
  | "no-credentials"
  | "token-expired"
  | "network"
  | "http-error"
  | "bad-shape";

export type ClaudeLimitsResult =
  | { ok: true; lanes: ClaudeLimitLane[]; fetchedAtMs: number }
  | { ok: false; reason: ClaudeLimitsFailureReason };

export interface ClaudeAccessToken {
  token: string;
  expiresAtMs: number | null;
}

// ---- readClaudeAccessToken --------------------------------------------------------------

/**
 * Reads Claude Code's own OAuth credentials file. READ-ONLY -- never writes, never
 * refreshes. Fails soft to null on anything short of a well-formed { claudeAiOauth:
 * { accessToken } } shape: missing file, unparseable JSON, missing claudeAiOauth, missing
 * accessToken. expiresAt is optional in the file (older CLI versions may omit it); its
 * absence yields expiresAtMs: null rather than a guessed expiry.
 */
export function readClaudeAccessToken(credPath: string): ClaudeAccessToken | null {
  let raw: string;
  try {
    raw = readFileSync(credPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) return null;
  const token = (oauth as Record<string, unknown>).accessToken;
  if (typeof token !== "string") return null;
  const expiresAt = (oauth as Record<string, unknown>).expiresAt;
  return { token, expiresAtMs: typeof expiresAt === "number" ? expiresAt : null };
}

// ---- parseClaudeLimits -------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** One entry of the vendor's limits[] array, translated + validated. Returns null (and is
 * dropped by the caller) if any REQUIRED field is missing or the wrong type -- kind,
 * group, a numeric percent, severity, and a string resets_at. scope is optional and only
 * ever contributes a display label; a malformed scope degrades to scopeLabel: null rather
 * than dropping an otherwise-good lane. */
function parseLane(entry: unknown): ClaudeLimitLane | null {
  if (!isRecord(entry)) return null;
  const { kind, group, percent, severity, resets_at } = entry;
  if (typeof kind !== "string") return null;
  if (typeof group !== "string") return null;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  if (typeof severity !== "string") return null;
  if (typeof resets_at !== "string") return null;

  let scopeLabel: string | null = null;
  const scope = entry.scope;
  if (isRecord(scope) && isRecord(scope.model)) {
    const displayName = scope.model.display_name;
    if (typeof displayName === "string") scopeLabel = displayName;
  }

  return { kind, group, percent, severity, resetsAt: resets_at, scopeLabel };
}

/** Synthesizes session/weekly_all lanes from the coarse five_hour/seven_day headline
 * utilizations -- the fallback shape used when limits[] is absent, empty, or entirely
 * malformed. Each of five_hour/seven_day is itself optional; only the ones with a valid
 * numeric utilization + string resets_at contribute a lane. Returns null (not []) if
 * neither source contributes anything, so callers can distinguish "fell back but got
 * nothing" from "here are zero lanes." */
function synthesizeFallback(body: Record<string, unknown>): ClaudeLimitLane[] | null {
  const lanes: ClaudeLimitLane[] = [];
  const fiveHour = body.five_hour;
  if (isRecord(fiveHour) && typeof fiveHour.utilization === "number" && Number.isFinite(fiveHour.utilization) && typeof fiveHour.resets_at === "string") {
    lanes.push({
      kind: "session",
      group: "session",
      percent: fiveHour.utilization,
      severity: "normal",
      resetsAt: fiveHour.resets_at,
      scopeLabel: null,
    });
  }
  const sevenDay = body.seven_day;
  if (isRecord(sevenDay) && typeof sevenDay.utilization === "number" && Number.isFinite(sevenDay.utilization) && typeof sevenDay.resets_at === "string") {
    lanes.push({
      kind: "weekly_all",
      group: "weekly",
      percent: sevenDay.utilization,
      severity: "normal",
      resetsAt: sevenDay.resets_at,
      scopeLabel: null,
    });
  }
  return lanes.length > 0 ? lanes : null;
}

/**
 * Translates a GET /api/oauth/usage response body into lanes. limits[] is preferred
 * whenever it yields at least one well-formed lane (individually-malformed entries are
 * dropped, the rest survive); an absent, empty, or fully-malformed limits[] falls back to
 * synthesizing session/weekly_all from five_hour/seven_day. Garbage input (wrong type,
 * no usable field anywhere) yields null -- never a guess, never a throw.
 */
export function parseClaudeLimits(body: unknown): ClaudeLimitLane[] | null {
  if (!isRecord(body)) return null;

  const rawLimits = body.limits;
  if (Array.isArray(rawLimits) && rawLimits.length > 0) {
    const lanes = rawLimits.map(parseLane).filter((l): l is ClaudeLimitLane => l !== null);
    if (lanes.length > 0) return lanes;
  }
  return synthesizeFallback(body);
}

// ---- fetchClaudeLimits --------------------------------------------------------------------

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface FetchClaudeLimitsOptions {
  optedIn: boolean;
  credPath: string;
  fetchImpl: typeof fetch;
  nowMs: number;
}

/**
 * Opt-in gated, read-only fetch of Claude's own vendor-reported usage limits. Every
 * failure is a typed reason; this function never throws. The token is used ONLY as the
 * Authorization header of the single request to USAGE_URL -- it is never captured into any
 * returned string, on any path (see the secrecy-pin tests).
 */
export async function fetchClaudeLimits(opts: FetchClaudeLimitsOptions): Promise<ClaudeLimitsResult> {
  const { optedIn, credPath, fetchImpl, nowMs } = opts;

  // Hard gate: consent is checked before anything else touches disk or network.
  if (!optedIn) return { ok: false, reason: "not-opted-in" };

  const cred = readClaudeAccessToken(credPath);
  if (cred === null) return { ok: false, reason: "no-credentials" };

  // Read-only: an expired token is REPORTED, never refreshed and never used for a doomed call.
  if (cred.expiresAtMs !== null && cred.expiresAtMs <= nowMs) {
    return { ok: false, reason: "token-expired" };
  }

  let response: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    response = await fetchImpl(USAGE_URL, {
      headers: {
        authorization: `Bearer ${cred.token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  if (!response.ok) return { ok: false, reason: "http-error" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A 200 whose body fails to JSON-parse is the same class as a well-formed-but-garbage
    // object: the shape we needed isn't there.
    return { ok: false, reason: "bad-shape" };
  }

  const lanes = parseClaudeLimits(body);
  if (lanes === null) return { ok: false, reason: "bad-shape" };

  return { ok: true, lanes, fetchedAtMs: nowMs };
}
