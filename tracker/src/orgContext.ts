/**
 * Org enrollment bridge — tracker side of gap-closing-spec P1.1 (ruling 2.1 #3).
 *
 * The tracker learns "this device is org-enrolled" from GET /api/device/context
 * (device bearer, metadata-only answer) BEFORE it ever puts a plain `owner/name`
 * repo slug on the wire, and caches the confirmed answer locally for 6 hours.
 *
 * PRIVACY BOUNDARY (locked): a non-enrolled device never sends a repo NAME anywhere.
 * "Always send orgRepo and let the server drop it" is explicitly REJECTED — the gate
 * lives HERE, client-side, in orgRepoFor(). FAIL CLOSED: with no fresh cache and no
 * confirmed server answer, the device is NOT enrolled for this pass. An authoritative
 * not-enrolled / revoked answer overwrites a stale enrolled cache.
 */
import { spawnSync } from "node:child_process";
import { APP_BASE, type OrgContext, type OrgPendingRequest, type TrackerState } from "./config.js";

/** How long a confirmed /device/context answer stays authoritative without a re-check. */
export const ORG_CONTEXT_TTL_MS = 5 * 60 * 1000;

/** Mirror of the server's ingest validation (ORG_REPO_RE). */
const ORG_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Normalize a git remote URL to a lowercase `owner/name` slug, host-agnostically, or
 * null when nothing slug-shaped can be derived. PURE (exported for tests). Handles:
 *   git@host:owner/name.git          (scp-like — the ':' is a path separator)
 *   https://host/owner/name(.git)(/) (any scheme; trailing slashes stripped)
 *   ssh://git@host(:port)/owner/name
 * Rule: take the LAST TWO path segments, strip a trailing `.git`, lowercase. Deeper
 * paths (GitLab groups) intentionally keep only the last two segments.
 */
export function normalizeRepoSlug(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  let s = url.trim();
  if (!s) return null;
  const scheme = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//);
  if (scheme) {
    s = s.slice(scheme[0].length);
  } else {
    // scp-like form: the first ':' separates host from path (git@host:owner/name.git).
    const colon = s.indexOf(":");
    if (colon !== -1) s = s.slice(0, colon) + "/" + s.slice(colon + 1);
  }
  s = s.replace(/\/+$/, "");
  const segments = s.split("/").filter((p) => p.length > 0);
  if (segments.length < 2) return null;
  const owner = segments[segments.length - 2];
  const name = segments[segments.length - 1].replace(/\.git$/i, "");
  const slug = `${owner}/${name}`.toLowerCase();
  return ORG_REPO_RE.test(slug) ? slug : null;
}

/**
 * THE payload gating decision, as a pure function (exported for hermetic tests):
 * a session carries `orgRepo` ONLY when the device is confirmed-enrolled AND a valid
 * slug resolved. Everything else — not enrolled (even with a slug in hand), enrolled
 * with no/invalid slug — returns undefined, and undefined never reaches the wire
 * (JSON.stringify drops it).
 */
export function orgRepoFor(enrolled: boolean, slug: string | null | undefined): string | undefined {
  if (!enrolled || !slug) return undefined;
  const s = slug.trim().toLowerCase();
  return ORG_REPO_RE.test(s) ? s : undefined;
}

/** Process-lifetime cwd -> slug cache (one `git config` spawn per distinct cwd per run). */
const slugByCwd = new Map<string, string | null>();

/**
 * Resolve a session's working directory to its normalized origin slug via
 * `git -C <cwd> config --get remote.origin.url`. NEVER throws: missing git binary,
 * missing directory, no remote, or a hung git (3s timeout) all resolve to null.
 */
export function repoSlugForCwd(
  cwd: string | undefined,
  cache: Map<string, string | null> = slugByCwd,
): string | null {
  if (!cwd) return null;
  const hit = cache.get(cwd);
  if (hit !== undefined) return hit;
  let slug: string | null = null;
  try {
    const r = spawnSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    if (r.status === 0 && typeof r.stdout === "string") slug = normalizeRepoSlug(r.stdout.trim());
  } catch {
    /* defensive — spawnSync reports errors in-result, but never let one thread a throw */
  }
  cache.set(cwd, slug);
  return slug;
}

export interface OrgContextAnswer {
  /** The context EFFECTIVE for this pass (fail-closed: enrolled=false when unconfirmed). */
  ctx: OrgContext;
  /** True when authoritative (fresh cache, 200, or a 401-revoked answer); false = fail-closed fallback. */
  confirmed: boolean;
}

/**
 * Confirm/refresh the device's org context. Uses the cached answer when younger than
 * ORG_CONTEXT_TTL_MS; otherwise asks GET {apiBase}/device/context with the device
 * bearer. Mutates state.org ONLY on an authoritative answer (200 or 401) — a transient
 * network failure keeps the stale cache on disk (never wipes it) but does NOT use it:
 * the returned context fails closed to not-enrolled. The caller persists state.
 */
export async function refreshOrgContext(state: TrackerState, now: number = Date.now()): Promise<OrgContextAnswer> {
  const cached = state.org;
  if (cached && cached.checkedAt <= now && now - cached.checkedAt < ORG_CONTEXT_TTL_MS) {
    return { ctx: cached, confirmed: true };
  }
  try {
    const r = await fetch(`${state.apiBase}/device/context`, {
      headers: { authorization: `Bearer ${state.deviceToken}` },
    });
    if (r.status === 401) {
      // Authoritative "revoked" — MUST overwrite a stale enrolled cache (spec 2.1 #3).
      state.org = { enrolled: false, checkedAt: now };
      return { ctx: state.org, confirmed: true };
    }
    if (r.ok) {
      const j = (await r.json()) as {
        enrolled?: boolean;
        orgId?: string;
        teamId?: string | null;
        orgLabel?: string;
        attribution?: OrgContext["attribution"];
        // D14 S11's CLI extension: GET /device/context gains pendingJoinRequests
        // (plural — up to the S15 cap of 3). Only well-shaped entries survive; the key
        // is included ONLY when the server actually sent the field (an omitted key
        // means "unknown," never "confirmed zero" — same discipline as `attribution`).
        pendingJoinRequests?: unknown;
      };
      const pendingRequests = Array.isArray(j.pendingJoinRequests)
        ? j.pendingJoinRequests.filter((p): p is OrgPendingRequest => {
            const r2 = p as Partial<OrgPendingRequest> | null;
            return (
              !!r2 &&
              typeof r2.orgId === "string" &&
              typeof r2.orgLabel === "string" &&
              typeof r2.slug === "string" &&
              typeof r2.status === "string" &&
              typeof r2.expiresAt === "number"
            );
          })
        : undefined;
      // A not_enrolled answer overwrites a stale enrolled cache — same rule as 401.
      state.org =
        j.enrolled === true
          ? {
              enrolled: true,
              orgId: typeof j.orgId === "string" ? j.orgId : null,
              teamId: typeof j.teamId === "string" ? j.teamId : null,
              orgLabel: typeof j.orgLabel === "string" ? j.orgLabel : null,
              ...(j.attribution ? { attribution: j.attribution } : {}),
              ...(pendingRequests !== undefined ? { pendingRequests } : {}),
              checkedAt: now,
            }
          : {
              enrolled: false,
              ...(j.attribution ? { attribution: j.attribution } : {}),
              ...(pendingRequests !== undefined ? { pendingRequests } : {}),
              checkedAt: now,
            };
      return { ctx: state.org, confirmed: true };
    }
  } catch {
    /* network error -> fail closed below */
  }
  // FAIL CLOSED: no fresh cache, no confirmed answer -> NOT enrolled for this pass.
  return { ctx: { enrolled: false, checkedAt: 0 }, confirmed: false };
}

// =====================================================================================
// D14 two-way org join (docs/d14-two-way-join-spec.md) — CLI lane (C5, C8, C11).
//
// The SERVER routes these call (POST /api/org/invite/redeem, POST /api/org/request,
// POST /api/org/request/cancel, POST /api/org/leave — spec S5/S10/S11/S17) are a
// SEPARATE, human-gated server lane and are NOT implemented by this
// branch. Every function below is written against the spec's documented contract and
// is fully unit-testable against a fake fetchImpl (mocked HTTP) — nothing here has been
// exercised against a live route, and every network call fails honestly (never a throw
// out of these functions) when the endpoint does not yet exist (404/ECONNREFUSED alike
// resolve through the same "network"/unmapped-status fallback below).
// =====================================================================================

// ---- C5/C8: org slug extraction (accepts a bare slug OR a full org URL) -------------

/**
 * PURE: turn a pasted org identifier into a slug. Accepts a bare slug ("acme") or a URL
 * whose path ends in `/org/<slug>` (any scheme/host, trailing slash or query/hash
 * tolerated) — matches the CLI's own copy ("accepts acme or a full .../org/acme URL",
 * spec C5). Anything else (empty/whitespace-only, or a URL with no /org/ segment)
 * returns null so the caller renders an honest error instead of guessing a slug.
 */
export function extractOrgSlug(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const orgPath = s.match(/\/org\/([^/?#]+)/i);
  if (orgPath) return orgPath[1].toLowerCase();
  // A bare token with no whitespace or slash at all is treated as a slug directly.
  if (!/[\s/]/.test(s)) return s.toLowerCase();
  return null;
}

// ---- C11: the exception matrix, rendered honestly (one line per documented code) ----

/** Every device-route error `error` code this CLI lane can receive (spec's exception
 * matrix, E1-E22, restricted to the routes the CLI calls) — kept as a plain string
 * (not a closed union) because the server is free to introduce new reason codes; an
 * unrecognized code still renders an honest, non-crashing fallback (the `default` arm
 * below), never a blank line or a thrown error. */
export function renderOrgErrorLine(code: string, opts: { origin?: string } = {}): string {
  const origin = opts.origin ?? APP_BASE;
  switch (code) {
    case "invalid_device_token":
      return "This device's token was revoked. Run `npx --yes deploy-forward@latest logout`, then `npx --yes deploy-forward@latest` to re-authenticate.";
    case "malformed_token":
      return "That code does not look right. Codes look like org-slug:secret.";
    case "invite_not_found":
      return "Invite not found. Ask your admin to reissue it.";
    case "invite_expired":
      return "That invite expired (7-day limit). Ask your admin for a new one.";
    case "invite_revoked":
    case "invite_accepted":
    case "invite_exhausted":
      return "That invite was already used or revoked. Ask your admin for a new one.";
    case "invite_login_mismatch":
      return "This invite is bound to a different account. Sign in as that account or ask for a new invite.";
    case "invite_unbound":
      return `This invite can only be redeemed on the web: ${origin}/join. Ask your admin for an invite issued to your GitHub login or email to redeem it here.`;
    case "identity_gate":
      return "Org membership needs a verified identity: verify GitHub (df github) or a verified email on the web account.";
    case "already_member":
      return "You are already a member of this organization.";
    case "org_not_found":
      return "No organization at that URL. Check the slug with your admin.";
    case "request_cap_user":
    case "request_cap_org":
      return "Too many pending requests. Cancel one or wait for a decision.";
    case "request_denied_cooldown":
      return "This organization declined your request recently. You can ask again later.";
    case "last_admin":
      return "You are the last admin. Transfer the admin role or delete the org on the web before leaving.";
    case "not_a_member":
      return "You are not a member of an organization.";
    case "network":
      return "Could not reach the server. Check your connection and try again.";
    default:
      return `Something went wrong (${code}).`;
  }
}

// ---- pure response mappers (status + parsed JSON body -> a typed outcome) -----------
// Same discipline as restore.ts's mapRestoreResponse: no network involved, so every
// branch is directly unit-testable, and every unmapped status/body shape falls through
// to an honest "unknown" error rather than a guessed success.

export interface OrgJoinError {
  ok: false;
  /** A spec E-matrix reason code (see renderOrgErrorLine), or "network"/"unknown". */
  code: string;
  status: number;
  /** Present only for a 403 account_deleted body (the server's shape) —
   * callers format it with sync.ts's formatAccountDeletedMessage, mirrored elsewhere
   * in the tracker; kept out of this module to avoid a circular import with sync.ts. */
  restoreBy?: number;
}

function orgErrorFrom(status: number, body: unknown): OrgJoinError {
  const b = body as { error?: unknown; restoreBy?: unknown; details?: { reason?: unknown } } | null | undefined;
  const code =
    (typeof b?.error === "string" ? b.error : undefined) ?? (typeof b?.details?.reason === "string" ? b.details.reason : undefined) ?? "unknown";
  return { ok: false, code, status, restoreBy: typeof b?.restoreBy === "number" ? b.restoreBy : undefined };
}

export type InviteRedeemResult = { ok: true; orgId: string; orgLabel: string; role: string; teamId: string | null } | OrgJoinError;

/** PURE (spec S5's response shape: `{ ok: true, orgId, orgLabel, role, teamId }`). */
export function mapInviteRedeemResponse(status: number, body: unknown): InviteRedeemResult {
  if (status >= 200 && status < 300) {
    const b = body as { ok?: unknown; orgId?: unknown; orgLabel?: unknown; role?: unknown; teamId?: unknown };
    if (b.ok === true && typeof b.orgId === "string" && typeof b.orgLabel === "string" && typeof b.role === "string") {
      return { ok: true, orgId: b.orgId, orgLabel: b.orgLabel, role: b.role, teamId: typeof b.teamId === "string" ? b.teamId : null };
    }
  }
  return orgErrorFrom(status, body);
}

export type JoinRequestResult = { ok: true; orgId: string; orgLabel: string; alreadyPending: boolean; expiresAt?: number } | OrgJoinError;

/** PURE (spec S10/E10: a duplicate pending request is an idempotent SUCCESS carrying
 * `alreadyPending: true`, never an error). */
export function mapJoinRequestResponse(status: number, body: unknown): JoinRequestResult {
  if (status >= 200 && status < 300) {
    const b = body as { orgId?: unknown; orgLabel?: unknown; alreadyPending?: unknown; expiresAt?: unknown };
    if (typeof b.orgId === "string" && typeof b.orgLabel === "string") {
      return {
        ok: true,
        orgId: b.orgId,
        orgLabel: b.orgLabel,
        alreadyPending: b.alreadyPending === true,
        expiresAt: typeof b.expiresAt === "number" ? b.expiresAt : undefined,
      };
    }
  }
  return orgErrorFrom(status, body);
}

export type CancelRequestResult = { ok: true } | OrgJoinError;

/** PURE (spec S11/E16: an already-canceled request is idempotent `ok`). */
export function mapCancelRequestResponse(status: number, body: unknown): CancelRequestResult {
  if (status >= 200 && status < 300) return { ok: true };
  return orgErrorFrom(status, body);
}

export type LeaveOrgResult = { ok: true } | OrgJoinError;

/** PURE (spec S17: leave wraps the existing leaveOrg guards; E19 last_admin, 409
 * not_a_member). */
export function mapLeaveOrgResponse(status: number, body: unknown): LeaveOrgResult {
  if (status >= 200 && status < 300) return { ok: true };
  return orgErrorFrom(status, body);
}

// ---- C5/C8: device-token network calls (fetchImpl injected — production omits it and
// falls back to the real global fetch; tests fake it, same seam as limitsFetch.ts) ----

/** No device token on this machine — every route below returns this without touching
 * the network (mirrors restore.ts's "Run `npx --yes deploy-forward@latest` first." precondition,
 * but as a typed result instead of a throw, so callers render it through the same
 * renderOrgErrorLine path as every other honest exception). */
const NOT_PAIRED: OrgJoinError = { ok: false, code: "invalid_device_token", status: 401 };

/** POST {apiBase}/org/invite/redeem (spec S5), device-token auth, body `{ token }`. */
export async function redeemInviteCode(
  state: Pick<TrackerState, "apiBase" | "deviceToken">,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InviteRedeemResult> {
  if (!state.deviceToken) return NOT_PAIRED;
  try {
    const r = await fetchImpl(`${state.apiBase}/org/invite/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${state.deviceToken}` },
      body: JSON.stringify({ token: code }),
    });
    const body = await r.json().catch(() => ({}));
    return mapInviteRedeemResponse(r.status, body);
  } catch {
    return { ok: false, code: "network", status: 0 };
  }
}

/** POST {apiBase}/org/request (spec S10), device-token auth, body `{ slug, message? }`.
 * `slugOrUrl` is resolved through extractOrgSlug FIRST — an unparseable identifier
 * returns the same org_not_found shape the server would (spec E9), with zero network
 * calls, so a mistyped URL fails exactly like a nonexistent org rather than crashing on
 * a malformed request body. */
export async function requestToJoinOrg(
  state: Pick<TrackerState, "apiBase" | "deviceToken">,
  slugOrUrl: string,
  message?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JoinRequestResult> {
  if (!state.deviceToken) return NOT_PAIRED;
  const slug = extractOrgSlug(slugOrUrl);
  if (!slug) return { ok: false, code: "org_not_found", status: 404 };
  try {
    const r = await fetchImpl(`${state.apiBase}/org/request`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${state.deviceToken}` },
      body: JSON.stringify({ slug, ...(message ? { message } : {}) }),
    });
    const body = await r.json().catch(() => ({}));
    return mapJoinRequestResponse(r.status, body);
  } catch {
    return { ok: false, code: "network", status: 0 };
  }
}

/** POST {apiBase}/org/request/cancel (spec S11), device-token auth, body `{ orgId }`. */
export async function cancelJoinRequest(
  state: Pick<TrackerState, "apiBase" | "deviceToken">,
  orgId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CancelRequestResult> {
  if (!state.deviceToken) return NOT_PAIRED;
  try {
    const r = await fetchImpl(`${state.apiBase}/org/request/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${state.deviceToken}` },
      body: JSON.stringify({ orgId }),
    });
    const body = await r.json().catch(() => ({}));
    return mapCancelRequestResponse(r.status, body);
  } catch {
    return { ok: false, code: "network", status: 0 };
  }
}

/** POST {apiBase}/org/leave (spec S17), device-token auth, no body. */
export async function leaveOrgDevice(
  state: Pick<TrackerState, "apiBase" | "deviceToken">,
  fetchImpl: typeof fetch = fetch,
): Promise<LeaveOrgResult> {
  if (!state.deviceToken) return NOT_PAIRED;
  try {
    const r = await fetchImpl(`${state.apiBase}/org/leave`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${state.deviceToken}` },
      body: JSON.stringify({}),
    });
    const body = await r.json().catch(() => ({}));
    return mapLeaveOrgResponse(r.status, body);
  } catch {
    return { ok: false, code: "network", status: 0 };
  }
}
