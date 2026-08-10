/**
 * L17 bring-your-own model rates — LOCAL-ONLY per-model pricing (`df pricing set/list/unset`).
 *
 * A user types a USD-per-MILLION-token rate for a model the bundled PRICES table has never
 * heard of, so `usage --cost` can price it. The rates are persisted to the local tracker
 * state under the `userRates` key and NOTHING here ever reaches the wire — the ingest payload
 * carries tokens and per-model buckets exactly as always and never a rate or a user-rate-
 * derived spend (the hard invariant pinned by byoInvariant.test.ts). Canonical rates always
 * win over a user rate for a known id (see resolveModelPricing in usageView.ts): a user rate
 * on a canonically-priced id is stored but inert.
 */
import { loadState, saveState } from "./config.js";
import type { UserRate } from "./types.js";

export type { UserRate } from "./types.js";

/** Sane upper band for a user-typed rate, USD per MILLION tokens. A rate above this is a
 * fat-finger (e.g. dollars-per-token instead of per-MTok), not a real price — rejected. */
export const MAX_USER_RATE_PER_MTOK = 10000;

/** Legal model-id charset + length: word chars plus dot/dash/slash/colon/at, 1..128 chars.
 * Same permissive-but-bounded shape a router-served id needs (`vendor/model:tag@rev`), with
 * no whitespace or path-injection characters. */
const MODEL_ID_RE = /^[\w.\-/:@]{1,128}$/;

/** A primary (input/output) rate: strictly positive and within the sane band. */
function validPrimaryRate(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= MAX_USER_RATE_PER_MTOK;
}

/** A cache rate (read/write): non-negative and within the band — a free cache read ($0) is
 * legitimate, so cache rates allow zero where the primary rates do not. */
function validCacheRate(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_USER_RATE_PER_MTOK;
}

export interface UserRateVerdict {
  ok: boolean;
  errors: string[];
}

/**
 * Pure set-time validation (no I/O): reports every reason a rate or model id would be
 * rejected. `setUserRate` throws when this is not ok; nothing invalid is ever persisted.
 */
export function validateUserRate(id: string, rate: UserRate): UserRateVerdict {
  const errors: string[] = [];
  if (typeof id !== "string" || !MODEL_ID_RE.test(id)) {
    errors.push("model id must be 1-128 characters of [\\w.-/:@] (no spaces)");
  }
  if (!validPrimaryRate(rate?.input)) {
    errors.push(`input rate must be a number in (0, ${MAX_USER_RATE_PER_MTOK}] USD per MTok`);
  }
  if (!validPrimaryRate(rate?.output)) {
    errors.push(`output rate must be a number in (0, ${MAX_USER_RATE_PER_MTOK}] USD per MTok`);
  }
  if (rate?.cacheRead !== undefined && !validCacheRate(rate.cacheRead)) {
    errors.push(`cache-read rate must be a number in [0, ${MAX_USER_RATE_PER_MTOK}] USD per MTok`);
  }
  if (rate?.cacheWrite !== undefined && !validCacheRate(rate.cacheWrite)) {
    errors.push(`cache-write rate must be a number in [0, ${MAX_USER_RATE_PER_MTOK}] USD per MTok`);
  }
  if (rate?.source !== undefined && typeof rate.source !== "string") {
    errors.push("source must be a string (a pricing-page URL)");
  }
  return { ok: errors.length === 0, errors };
}

/** Every user rate currently stored on this machine, keyed by model id. */
export function listUserRates(): Record<string, UserRate> {
  return loadState().userRates ?? {};
}

/**
 * Persist a user rate for `id`, throwing on any invalid rate/id (nothing invalid is ever
 * written). Only the whitelisted rate fields are stored — an unexpected property on the
 * caller's object is dropped, never round-tripped to disk.
 */
export function setUserRate(id: string, rate: UserRate): void {
  const verdict = validateUserRate(id, rate);
  if (!verdict.ok) throw new Error(`invalid user rate for "${id}": ${verdict.errors.join("; ")}`);
  const clean: UserRate = { input: rate.input, output: rate.output };
  if (rate.cacheRead !== undefined) clean.cacheRead = rate.cacheRead;
  if (rate.cacheWrite !== undefined) clean.cacheWrite = rate.cacheWrite;
  if (rate.source !== undefined) clean.source = rate.source;
  const state = loadState();
  state.userRates = { ...(state.userRates ?? {}), [id]: clean };
  saveState(state);
}

/** Remove a stored rate; returns true when one was removed, false when the id had none. */
export function unsetUserRate(id: string): boolean {
  const state = loadState();
  if (!state.userRates || !(id in state.userRates)) return false;
  const next = { ...state.userRates };
  delete next[id];
  state.userRates = Object.keys(next).length > 0 ? next : undefined;
  saveState(state);
  return true;
}
