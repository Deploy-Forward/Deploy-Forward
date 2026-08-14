/**
 * profileStats (client) — the account-aggregate figures behind the Settings
 * "Profile" scope toggle (Marco 2026-08-14). GET /api/profile/stats with the
 * device token; the server folds users/{uid}/daily across EVERY paired device.
 *
 * Fail-soft everywhere: no token, network error, non-2xx, or a wrong-shaped body
 * all return null — the watch then keeps its device-scoped hero with the device
 * note, never a blank or a guessed figure. TTL-cached at the same 5-minute
 * cadence as the vendor limit lanes.
 */
import { APP_BASE, loadState } from "./config.js";

export interface AccountStats {
  totalTokens: number;
  spendUsd: number;
  spendIsPartial: boolean;
  sessions: number;
  activeHours: number;
}

const STATS_TTL_MS = 5 * 60_000;
let statsCache: { at: number; stats: AccountStats | null } | null = null;

/** Consent-free (it is the user's OWN account read, gated by their own toggle),
 * token-gated, TTL-cached. `now`/`fetchImpl` injectable for tests. */
export async function fetchAccountStats(
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<AccountStats | null> {
  const token = loadState().deviceToken;
  if (!token) return null;
  if (statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.stats;
  let stats: AccountStats | null = null;
  try {
    const res = await fetchImpl(`${APP_BASE}/api/profile/stats`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const body = (await res.json()) as Record<string, unknown>;
      if (
        typeof body.totalTokens === "number" &&
        typeof body.spendUsd === "number" &&
        typeof body.sessions === "number" &&
        typeof body.activeHours === "number"
      ) {
        stats = {
          totalTokens: body.totalTokens,
          spendUsd: body.spendUsd,
          spendIsPartial: body.spendIsPartial === true,
          sessions: body.sessions,
          activeHours: body.activeHours,
        };
      }
    }
  } catch {
    stats = null;
  }
  statsCache = { at: now, stats };
  return stats;
}
