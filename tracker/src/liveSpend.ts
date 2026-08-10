/**
 * L19 — the tracker's throttled LIVE spend push builder (client-side seam).
 *
 * While an engineer's session is actively producing tokens AND the device is org-enrolled,
 * the interactive live monitor (bin/df.ts monitorLoop) pushes that session's running per-model
 * tokens to POST /api/device/live every ~45s. This module holds the PURE decision: given the
 * sessions the sync pass just parsed, the enrollment answer, the clock, and the last push, it
 * returns a COUNTS-ONLY payload or null (unenrolled / idle / throttled / nothing running).
 *
 * PRIVACY BOUNDARY (locked, mirrors orgRepoFor): the payload is counts-only — session id +
 * per-model integer counts + a timestamp. No cwd, repoHash, orgRepo, entryPoint, prompt, or
 * content ever rides along, and a non-enrolled device emits nothing. The network POST + the
 * monitor wiring live in bin/df.ts and are fail-silent; nothing here touches the network.
 */

/** The live push interval. A real throttle (>= 30s); ~45s so a running session's growth
 * surfaces near-real-time without hammering the endpoint. */
export const LIVE_PUSH_INTERVAL_MS = 45_000;

/** Values of the DF_LIVE_SPEND kill switch that disable the live push (privacy/off). */
const OFF_VALUES = new Set(["0", "off", "false"]);

/**
 * The counts-only payload put on the wire (identical shape to the server's LiveSpendPayload).
 * `tokensByModel` is keyed by model id; each value carries EXACTLY the four count fields.
 */
export interface LiveSpendPush {
  sessionId: string;
  tokensByModel: Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number }>;
  ts: number;
}

/** The marker persisted (in-process) after each accepted push, to drive idle + throttle. */
export interface LiveSpendLast {
  pushedAt: number;
  sessionId: string;
  signature: string;
}

/** The minimal running-session shape the builder needs (a superset of SessionSummary). */
interface RunningSessionLike {
  toolSessionId: string;
  endedAt: number;
  models: Array<{ id: string; input: number; output: number; cacheRead: number; cacheCreation: number }>;
}

/**
 * The DF_* off switch, read from an injected env so tests stay hermetic. On by default;
 * DF_LIVE_SPEND in {0, off, false} (case-insensitive) disables it. Any other value is on.
 */
export function liveSpendEnabled(env: Record<string, string | undefined>): boolean {
  const v = env.DF_LIVE_SPEND;
  if (typeof v !== "string") return true;
  return !OFF_VALUES.has(v.trim().toLowerCase());
}

/**
 * A stable "have the tokens moved since last push" digest over a tokensByModel map. Model ids
 * are sorted so key order can never change the signature; a changed count changes it.
 */
export function liveSpendSignatureOf(tokensByModel: LiveSpendPush["tokensByModel"]): string {
  return Object.keys(tokensByModel)
    .sort()
    .map((id) => {
      const c = tokensByModel[id];
      return `${id}:${c.input},${c.output},${c.cacheRead},${c.cacheCreation}`;
    })
    .join("|");
}

/** Counts-only projection of a session's per-model buckets — strips ids-to-noise and every
 * local-only field (cwd/repoHash/orgRepo/entryPoint), keeping exactly the four counts. */
function countsOnly(models: RunningSessionLike["models"]): LiveSpendPush["tokensByModel"] {
  const out: LiveSpendPush["tokensByModel"] = {};
  for (const m of models) {
    out[m.id] = {
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheCreation: m.cacheCreation,
    };
  }
  return out;
}

/**
 * Build the throttled live push, or null.
 *
 * Returns null when: the device is NOT enrolled; there is no running session; the push is
 * THROTTLED (inside LIVE_PUSH_INTERVAL_MS since the last push); or the session is IDLE (its
 * token signature is unchanged since the last push). Otherwise returns a counts-only payload
 * for the currently-running session (the one with the greatest endedAt), stamped with `now`.
 */
export function buildLiveSpendPush(args: {
  sessions: RunningSessionLike[];
  enrolled: boolean;
  now: number;
  last: LiveSpendLast | null;
}): LiveSpendPush | null {
  const { sessions, enrolled, now, last } = args;
  if (!enrolled) return null;
  if (!Array.isArray(sessions) || sessions.length === 0) return null;

  // The currently-running session is the most-recently-active one.
  const chosen = sessions.reduce((a, b) => (b.endedAt > a.endedAt ? b : a));

  const tokensByModel = countsOnly(chosen.models);
  const signature = liveSpendSignatureOf(tokensByModel);

  if (last) {
    // THROTTLED: a push inside the min interval is suppressed even if tokens moved.
    if (now - last.pushedAt < LIVE_PUSH_INTERVAL_MS) return null;
    // IDLE: same session, unchanged tokens since the last push — nothing new to report.
    if (last.sessionId === chosen.toolSessionId && last.signature === signature) return null;
  }

  return { sessionId: chosen.toolSessionId, tokensByModel, ts: now };
}
