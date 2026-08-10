/**
 * Local tracker state: the device token, API base, per-file parse cursors, and the
 * per-device repo-checkout HMAC key. Lives in ~/.config/df/state.json (override with $DF_HOME).
 *
 * The key is generated locally and never leaves the machine; it lets us count distinct
 * local CHECKOUTS (repoCheckouts — a diagnostic) without ever sending a repo name, path,
 * or URL. It is NOT a git-remote hash and confers no canonical/cross-user repo identity
 * (that is canonicalRepoId, minted server-side).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import type { ToolName, UserRate } from "./types.js";
import type { BillingSource } from "./billingSource.js";

export const DEFAULT_API_BASE =
  process.env.DF_API_BASE ?? "https://deployforward-leaderboard.web.app/api";

/** The web app base (pairing page, board links). ONE definition -- auth.ts and bin/df.ts
 * both render user-facing URLs from it; two copies once meant a custom-domain move could
 * update the pairing URL but keep printing a stale board URL after onboarding. */
// The BRANDED domain (leaderboard.deployforward.dev, live CNAME since 2026-07-07) — every
// URL the CLI prints is a link someone forwards; the web.app fallback host stays reachable
// but is never the address we hand out.
export const APP_BASE = process.env.DF_APP_BASE ?? "https://leaderboard.deployforward.dev";

/**
 * Public GitHub OAuth App client_id for device-flow (verified) login. Public BY DESIGN —
 * the device flow uses only the client_id, never a secret (so it's safe to ship in the npx
 * package). Override with $DF_GITHUB_CLIENT_ID.
 */
export const GITHUB_CLIENT_ID = process.env.DF_GITHUB_CLIENT_ID ?? "Ov23liATbjeG1sVMCH5F";

/**
 * Bumped whenever the transcript PARSE semantics change (e.g. the message-id token dedup). On a
 * bump, loadState() invalidates every per-file cursor so all transcripts are re-parsed once with
 * the new logic and the corrected cumulative totals are re-upserted. Without this, syncOnce skips
 * any file whose byte size is unchanged, so dormant sessions would keep their old (inflated)
 * counts forever and the fix would never reach already-ingested data.
 *   1 = original summing parser · 2 = per-(message.id,requestId) keep-max dedup ·
 *   3 = per-model buckets + codex per-turn deltas (0.2.0) ·
 *   4 = recursive subagent merge into the parent session + density-adjusted (per-event floor)
 *       activity reconstruction so sparse/collapsed Codex streams stop under-reporting
 *       active/wall time (0.3.0). The parsing surface changed (new nested transcripts +
 *       reconstructed active/wall/endedAt), so every cursor must re-parse once. ·
 *   5 = skills signal: skill/command NAMES + counts per session (command tags + Skill
 *       tool_use, plumbing excluded, capped 16) (0.4.0). Historical sessions carry skill
 *       use too, so every cursor must re-parse once to backfill the field.
 *   6 = atomic-capture metadata: ccusage-style Claude dedup, verbatim model buckets,
 *       entryPoint, and thinkingTokens.
 *   7 = GLOBAL cross-file Claude dedup (the Deploy Forward Atomic Capture Standard):
 *       resume/fork replays dedup across sibling files before any roll-up, surviving
 *       messages assign to their first-occurrence thread, fully-deduped forks re-upload
 *       once as ZEROED threads to overwrite stale inflated records. Every cursor must
 *       re-parse once so the corrected globally-deduped totals reach the server.
 *   8 = provider-aware local ledgers: Codex sessions now write `codex_<sessionId>`
 *       digests just like Claude writes `claude_code_<sessionId>` digests, so status and
 *       live monitor can prove Claude+Codex coverage without re-scanning transcripts.
 *   9 = agents capture (0.11.0): Task subagent_type folds into a new per-session
 *       `agents` field. Cursors short-circuit byte-unchanged files, so without this
 *       bump the historical corpus would never carry the field — every cursor must
 *       re-parse once so delegating sessions re-upload with their agents tally.
 *  10 = agents matcher fix: the harness renamed the dispatch tool Task -> Agent; epoch 9
 *       matched only the old name and parsed a silent zero from the real corpus. Every
 *       cursor must re-parse once with the both-names matcher.
 *  11 = Codex org attribution (0.11.5): enrolled devices now derive orgRepo from a
 *       rollout's session_meta cwd, same as Claude/Grok. Rollouts are dead files that
 *       never change, so only a one-time re-parse can attribute the historical Codex
 *       corpus (the /org "unattributed usage" bucket was mostly this).
 *  12 = day-attribution slices (0.13.0, Fix A): sessions whose atoms span UTC midnights
 *       gain per-day `days[]` slices, so calendars and streaks credit the days work
 *       actually happened on (clock ruling 2026-07-13). Single-day sessions keep
 *       byte-identical digests — the re-parse re-uploads ONLY the midnight spanners.
 *  13 = pi reasoning tokens (0.16.0, W1.0 corpus finding): real pi sessions carry
 *       usage.reasoning, which the docs never mention; it now maps to thinkingTokens.
 *       Cursors short-circuit byte-unchanged files, so without this bump the existing
 *       pi corpus would keep thinkingTokens=0 forever. Only pi sessions with real
 *       reasoning counts change digests, so only those re-upload.
 *  14 = candidate outcomes (per-session outcome ledger v1): sessions now carry the commit SHAs
 *       they authored in-window (metadata only). A one-time re-scan backfills them from local git
 *       history; only sessions that shipped commits change their digest and re-upload.
 *  15 = capture back-ports (L5b, landscape S4): a NEW capture SURFACE per store —
 *       opencode's 1.1+ file-based `storage/` tree (read alongside SQLite; file store wins on a
 *       shared session id, deduped never double-counted) and Copilot's OTel `agent-traces.db`
 *       (preferred over the session-store mirror when present). An upgraded opencode user whose
 *       SQLite `session` table stopped being written was going dark; these sessions now surface.
 *       Cursors short-circuit unchanged sources, so a one-time re-parse is required to pick the
 *       new surfaces up. (Both store SHAPES are CORPUS-UNVERIFIED on the dev host — see the
 *       reader headers; the epoch bump stands regardless, since it only forces a re-scan.)
 *  16 = Gemini CLI capture (L14): the Gemini adapter (gemini.ts) begins summarizing
 *       ~/.gemini session objects into `gemini` SessionSummary records. Cursors
 *       short-circuit byte-unchanged files, so a bump forces the one-time first parse of
 *       the existing Gemini corpus; sessions from every other provider re-parse
 *       byte-identically and re-upload nothing (the per-thread digest gate absorbs them).
 *       (Renumbered from 15 at merge: L5b landed first and owns that epoch.)
 */
export const PARSER_EPOCH = 16;

/**
 * Cached GET /api/device/context answer (the P1.1 enrollment bridge). The server owns
 * the truth; this is a 6h-TTL cache of its last confirmed answer. Sync FAILS CLOSED:
 * when it cannot confirm enrollment (no fresh cache, no server answer) the device is
 * treated as NOT enrolled and no repo name goes on the wire.
 */
export interface OrgContext {
  enrolled: boolean;
  orgId?: string | null;
  teamId?: string | null;
  /** Non-secret display label (the org's human name) — status surface only. */
  orgLabel?: string | null;
  /** User-level multi-org attribution context. Applies across every paired device. */
  attribution?: AttributionContext;
  /**
   * D14 C9: this account's live join requests across every org (device-token
   * /device/context projection of the server's S11 pendingJoinRequests, plural — a
   * device can have up to 3 pending at once). Present ONLY when the server answer
   * actually included the field — omitted (never a fabricated empty array) when the
   * server hasn't confirmed this pass, so a stale/absent cache is never confused with
   * "confirmed zero pending requests."
   */
  pendingRequests?: OrgPendingRequest[];
  /** Epoch ms of the confirming server answer (drives the freshness gate). */
  checkedAt: number;
}

/** D14 C9: one entry of OrgContext.pendingRequests — the requester-side mirror shape
 * (S11's pendingJoinRequests), never the admin-only fields (message, decidedBy, ...). */
export interface OrgPendingRequest {
  orgId: string;
  orgLabel: string;
  slug: string;
  status: string;
  /** Epoch ms; the request's fixed 7-day TTL from createdAt, so ordering by this
   * value descending is equivalent to ordering by createdAt descending. */
  expiresAt: number;
}

export interface AttributionContextOrg {
  orgId: string;
  label: string;
  role: string;
  teamId: string | null;
  projects: Array<{ projectId: string; name: string }>;
}

export interface AttributionContextGrant {
  grantId: string;
  orgId: string;
  orgLabel: string;
  projectId: string;
  projectName: string;
  canonicalRepoId: string;
  slug: string;
  trust: string;
  routeVersion: number;
}

export interface AttributionContext {
  organizations: AttributionContextOrg[];
  grants: AttributionContextGrant[];
  fingerprint: string;
}

function sanitizeAttribution(v: unknown): AttributionContext | undefined {
  if (!v || typeof v !== "object") return undefined;
  const a = v as Partial<AttributionContext>;
  if (!Array.isArray(a.organizations) || !Array.isArray(a.grants) || typeof a.fingerprint !== "string") return undefined;
  return {
    organizations: a.organizations.filter((o): o is AttributionContextOrg =>
      !!o && typeof o.orgId === "string" && typeof o.label === "string" && Array.isArray(o.projects)),
    grants: a.grants.filter((g): g is AttributionContextGrant =>
      !!g && typeof g.grantId === "string" && typeof g.canonicalRepoId === "string" && typeof g.slug === "string"),
    fingerprint: a.fingerprint,
  };
}

/** Only well-shaped entries survive — a corrupt/stray entry in a stale state.json is
 * dropped rather than trusted, same defensive posture as sanitizeAttribution. Returns
 * undefined (not []) when the raw value isn't an array at all, so "never confirmed"
 * stays distinguishable from "confirmed zero" through the loadState() key-presence check. */
function sanitizeOrgPendingRequests(v: unknown): OrgPendingRequest[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((p): p is OrgPendingRequest => {
    const r = p as Partial<OrgPendingRequest> | null;
    return (
      !!r &&
      typeof r.orgId === "string" &&
      typeof r.orgLabel === "string" &&
      typeof r.slug === "string" &&
      typeof r.status === "string" &&
      typeof r.expiresAt === "number"
    );
  });
}

function sanitizeOrg(v: unknown): OrgContext | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Partial<OrgContext>;
  if (typeof o.enrolled !== "boolean" || typeof o.checkedAt !== "number") return undefined;
  const pendingRequests = sanitizeOrgPendingRequests(o.pendingRequests);
  return {
    enrolled: o.enrolled,
    orgId: typeof o.orgId === "string" ? o.orgId : null,
    teamId: typeof o.teamId === "string" ? o.teamId : null,
    orgLabel: typeof o.orgLabel === "string" ? o.orgLabel : null,
    attribution: sanitizeAttribution(o.attribution),
    ...(pendingRequests !== undefined ? { pendingRequests } : {}),
    checkedAt: o.checkedAt,
  };
}

export interface FileCursor {
  /** Byte size last seen (root + nested subagents). The ONLY change-detection input --
   * there is deliberately no uuid-based incremental resume; a changed file re-parses whole. */
  byteOffset: number;
}

export interface TrackerState {
  apiBase: string;
  deviceToken: string | null;
  uid: string | null;
  handle: string | null;
  repoHmacKey: string;
  /** keyed by absolute transcript path */
  cursors: Record<string, FileCursor>;
  /**
   * Last successfully-uploaded summary digest per thread (`${tool}_${toolSessionId}` ->
   * sha256 of the ingest payload). Because the Claude corpus is globally deduped, a change
   * in ONE file can move ANOTHER thread's totals (a fork's replay can upgrade a record the
   * original thread owns) — so uploads are gated by summary digest, not by which file
   * changed. Cleared with cursors on a PARSER_EPOCH bump.
   */
  threadDigests: Record<string, string>;
  /** Cached org enrollment context (see OrgContext). Absent until first confirmed answer. */
  org?: OrgContext;
  /**
   * Attribution-mode fingerprint the persisted threadDigests were last written under
   * ("enrolled" | "none"). A CONFIRMED flip vs the current context forces one corpus
   * re-fold even when no transcript byte changed, so a newly-enrolled device re-uploads
   * its sessions WITH orgRepo (and a revoked one without it) instead of being skipped
   * as unchanged. Updated only alongside the digests (i.e. after a successful pass).
   */
  orgStamp: string;
  /** the PARSER_EPOCH the cursors were written under; a mismatch forces a one-time re-parse. */
  parserEpoch: number;
  /** Epoch ms of the last COMPLETED sync pass (including no-op passes). Drives the
   * hook-beat debounce: `beat` spawns a detached sync only when this is stale, so the
   * Claude Code hooks act as the daemon and no resident process is needed. */
  lastSyncAt: number;
  gapMs: number;
  /** Passive update-nudge throttle: when we last asked the npm registry, and what it
   * said. `latest: null` records a failed/unreachable check (still throttled — a dead
   * network must not add a 1.5s stall to every interactive run). */
  updateCheck?: { at: number; latest: string | null };
  /**
   * Most recent scan's drift counters per provider (W1.5, spec §5.2), keyed by
   * ToolName ("claude_code" | "codex" | "grok" | "pi"): unknown/total line counts +
   * the scan's epoch ms. Written by syncOnce only for providers that actually
   * re-scanned that pass (a cursor-skipped provider keeps its last real numbers);
   * read by `status` and the monitor through providers.ts's isDriftSuspected().
   * LOCAL-ONLY — never part of any ingest payload. Dropped with cursors on a
   * PARSER_EPOCH bump: a new parser must re-measure drift, not inherit a stale alarm.
   */
  scanHealth?: Record<string, { unknownLines: number; totalLines: number; at: number }>;
  /**
   * W3 SQLite-adapter change-detection watermark (opencode, Hermes, Copilot): a
   * monotonic recency marker returned by each adapter's own scan (opencode: max
   * time_created/time_updated across every row read; Hermes: max started_at; Copilot:
   * max assistant_usage_events.created_at), used ALONGSIDE the per-db-file byte-size
   * cursor already in `cursors` -- never IN PLACE
   * of `FileCursor.byteOffset`, because a watermark is not a byte offset and reusing
   * that field would mislabel what it holds. Keyed by the adapter's home path (each
   * adapter currently resolves to one scan root, so one entry apiece). Only ever
   * advances (the sync-wiring side takes the max against the stored value) -- a
   * partial or failed pass never regresses it. Cleared with cursors/threadDigests on
   * a PARSER_EPOCH bump (parse state, not enrollment truth). OpenClaw has no entry
   * here: its adapter returns no watermark at all, so its own per-db byte-size cursor
   * IS its whole change-detection signal, same as Codex/pi.
   */
  watermarks: Record<string, number>;
  /**
   * W3 soft-skip signal (SQLite adapters only, docs/harness-adapters-implementation.md
   * wiring task item 2): true for a provider whose on-disk data was FOUND (at least
   * one db file exists) but this Node's `node:sqlite` support is missing or too old to
   * open it -- "the tool is installed, this Node can't read it," a distinct state from
   * "not installed" (which must stay silent, never a false "we looked and found
   * nothing"). Recomputed FRESH every sync pass from a cheap fs-existence check (no
   * parse, no TTL) and REPLACED wholesale each pass -- unlike scanHealth's per-provider
   * merge -- so a Node upgrade mid-install clears the notice on the very next sync
   * instead of lingering. LOCAL-ONLY, never on the wire. `bin/df.ts`'s status() prints
   * one dim line per provider present here.
   */
  softSkip?: Partial<Record<ToolName, true>>;
  /**
   * Persisted per-provider limits opt-in (D9 ruling, docs/context-capacity-plan.md
   * Phase 6): the "are you on a monthly-based subscription plan?" onboarding question
   * offers Claude's opt-in Tier B lanes fetch and remembers the answer so the watch
   * fetches vendor-reported lanes WITHOUT needing --limits every run (the flag stays a
   * per-run override). Codex needs no entry here (disk-read, always on). Grok/Cursor
   * are future research -- the type stays open via optional keys, but only claude is
   * wired today. A decline persists as an explicit `false`, never an omitted key.
   */
  limitsProviders?: { claude?: boolean };
  /**
   * Persisted display-privacy toggle (D17 Privacy row): when true, thread/repo labels
   * are redacted in the super-start views by default — the --redact flag remains a
   * per-run additive override. Enrollment truth like limitsProviders: survives a
   * PARSER_EPOCH bump, and only an explicit boolean is ever trusted from disk.
   */
  redact?: boolean;
  /**
   * D20 ruling (docs/context-capacity-plan.md Phase 8): three-way plan-type enrollment
   * truth, declared at onboarding and editable in settings. Replaces the old boolean
   * subscription gate as the routing key for usage-view composition (the existing
   * per-provider consent in limitsProviders remains nested under it, unchanged). The
   * ledger (layer 1) is never gated by any of this. Enrollment truth like
   * limitsProviders/redact: survives a PARSER_EPOCH bump, and only one of the three
   * known values is ever trusted from disk -- anything else drops to undefined.
   */
  billingMode?: "api" | "subscription" | "mix";
  /**
   * D22 ruling: optional explicit monthly $ budget (api-equivalent), scoped to the
   * "api" and "mix" billing modes. Enrollment truth like billingMode -- survives a
   * PARSER_EPOCH bump, and only a finite, strictly-positive number is ever trusted
   * from disk (zero, negative, or a non-number drops to undefined, same defensive
   * posture as sanitizeWatermarks).
   */
  monthlyBudgetUsd?: number;
  /**
   * Onboarding enrollment truth (sim-report.md Finding 3, "returning run" re-asks a
   * declined device forever): epoch ms of when opts.askOnboarding was last run for this
   * device, set ONCE regardless of the answer (asked != accepted, but both must be
   * recorded so the question is never repeated). NOT epoch-gated (no re-ask-after-N-days
   * logic) -- presence alone means "already asked"; a returning user changes billingMode
   * via Settings, never by being re-asked. Enrollment truth like billingMode/redact:
   * survives a PARSER_EPOCH bump, and only a finite, strictly-positive number is ever
   * trusted from disk.
   */
  onboardedAt?: number;
  /**
   * D14 C3: the org-join onboarding question's ask-once marker — epoch ms of when it
   * was last presented on this device, set ONCE regardless of the answer (asked !=
   * joined, but both facts must be recorded so a decline, a redeem, or a skip are
   * never re-asked). Shared across BOTH live onboarding paths (super-start's post-pair
   * question and the firstRun ceremony) via the SAME persister (bin/df.ts's
   * askSuperStartOrgJoin) — whichever ceremony runs first sets this, and the other
   * checks it and skips. Same defensive posture as onboardedAt: enrollment truth,
   * survives a PARSER_EPOCH bump, and only a finite, strictly-positive number is ever
   * trusted from disk.
   */
  orgAskedAt?: number;
  /**
   * L17 bring-your-own model rates: user-typed USD-per-MTok prices, keyed by model id,
   * that let `usage --cost` price a model the bundled PRICES table doesn't know. LOCAL
   * DISPLAY CONVENIENCE ONLY — this map is NEVER part of any ingest payload (the hard
   * invariant in byoInvariant.test.ts). Enrollment/config truth like billingMode: survives
   * a PARSER_EPOCH bump, and only well-shaped entries are ever trusted from disk (a corrupt
   * or out-of-band value is dropped, same defensive posture as sanitizeWatermarks).
   */
  userRates?: Record<string, UserRate>;
  /**
   * L17 consented unknown-model share (`df config share-unknown-models on|off`, default
   * OFF). When true — and ONLY then — a sync MAY attach a minimal `unknownModels` list of
   * { id, tool, count } occurrence tallies (ids the bundled table can't price) so the
   * project can learn what to price next. NO rates are ever part of that share. Config
   * truth like redact: epoch-proof, boolean-only, and only an explicit boolean is trusted.
   */
  shareUnknownModels?: boolean;
  /**
   * L18: the last-seen Claude Code billing SOURCE (presence-only, never a credential
   * value) — the baseline detectFlip() compares against so a silent subscription ->
   * api_key switch can be warned about on the next local run. PRESENCE-DERIVED
   * diagnostic, LOCAL-ONLY (never on any ingest payload). Survives a PARSER_EPOCH bump
   * like other enrollment truth, and only one of the five known BillingSource values is
   * ever trusted from disk — anything else drops to undefined (no false baseline).
   */
  lastBillingSource?: BillingSource;
}

/** Only well-shaped { input, output, cacheRead?, cacheWrite?, source? } entries survive —
 * a corrupt or stray value in state.json is dropped, never trusted. Rates must be finite
 * numbers; optional cache rates keep only finite numbers; a non-string source is dropped.
 * Returns undefined when nothing valid survives, so an absent map stays absent. */
function sanitizeUserRates(v: unknown): TrackerState["userRates"] {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, UserRate> = {};
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<UserRate>;
    if (typeof r.input !== "number" || !Number.isFinite(r.input)) continue;
    if (typeof r.output !== "number" || !Number.isFinite(r.output)) continue;
    const rate: UserRate = { input: r.input, output: r.output };
    if (typeof r.cacheRead === "number" && Number.isFinite(r.cacheRead)) rate.cacheRead = r.cacheRead;
    if (typeof r.cacheWrite === "number" && Number.isFinite(r.cacheWrite)) rate.cacheWrite = r.cacheWrite;
    if (typeof r.source === "string") rate.source = r.source;
    out[id] = rate;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Only a boolean `claude` key survives -- a corrupt or stray value in state.json is
 * dropped, never trusted, same defensive posture as sanitizeScanHealth/sanitizeSoftSkip. */
function sanitizeLimitsProviders(v: unknown): TrackerState["limitsProviders"] {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as Record<string, unknown>;
  const out: { claude?: boolean } = {};
  if (typeof obj.claude === "boolean") out.claude = obj.claude;
  return out;
}

/** Only one of the three known plan-type strings survives -- a corrupt or stray value
 * in state.json (a stale label, a wrong type) is dropped, never trusted, same defensive
 * posture as sanitizeLimitsProviders. */
function sanitizeBillingMode(v: unknown): TrackerState["billingMode"] {
  return v === "api" || v === "subscription" || v === "mix" ? v : undefined;
}

/** Only a finite, strictly-positive number survives -- zero, negative, NaN/Infinity, or
 * a non-number value in state.json is dropped, never trusted (a budget of $0 or less is
 * not a real budget). */
function sanitizeMonthlyBudgetUsd(v: unknown): TrackerState["monthlyBudgetUsd"] {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Only a finite, strictly-positive epoch-ms number survives -- zero, negative,
 * NaN/Infinity, or a non-number value in state.json is dropped, never trusted, same
 * defensive posture as sanitizeMonthlyBudgetUsd. */
function sanitizeOnboardedAt(v: unknown): TrackerState["onboardedAt"] {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Only a finite, strictly-positive epoch-ms number survives — same defensive posture
 * as sanitizeOnboardedAt (a stray zero/negative/NaN/string in state.json is dropped). */
function sanitizeOrgAskedAt(v: unknown): TrackerState["orgAskedAt"] {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

const KNOWN_BILLING_SOURCES = new Set<BillingSource>(["subscription", "api_key", "bearer", "cloud", "unknown"]);

/** Only one of the five known BillingSource strings survives — a stale label or wrong
 * type in state.json is dropped, never trusted (a bad baseline would fire, or suppress,
 * a spurious flip warning). Same defensive posture as sanitizeBillingMode. */
function sanitizeLastBillingSource(v: unknown): TrackerState["lastBillingSource"] {
  return typeof v === "string" && KNOWN_BILLING_SOURCES.has(v as BillingSource) ? (v as BillingSource) : undefined;
}

/** Every watermark value must be a finite number; anything else (corrupt state.json,
 * a stray string) is dropped rather than trusted -- same defensive posture as
 * sanitizeScanHealth below. */
function sanitizeWatermarks(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

const KNOWN_TOOL_NAMES = new Set<ToolName>(["claude_code", "codex", "grok", "pi", "openclaw", "opencode", "hermes", "copilot"]);

/** Only a `true` value under a recognized ToolName key survives -- a stray string or
 * an unrecognized/renamed provider id in a stale state.json is dropped, never trusted. */
function sanitizeSoftSkip(v: unknown): TrackerState["softSkip"] {
  if (!v || typeof v !== "object") return undefined;
  const out: Partial<Record<ToolName, true>> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === true && KNOWN_TOOL_NAMES.has(k as ToolName)) out[k as ToolName] = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeScanHealth(v: unknown): TrackerState["scanHealth"] {
  if (!v || typeof v !== "object") return undefined;
  const out: NonNullable<TrackerState["scanHealth"]> = {};
  for (const [k, e] of Object.entries(v as Record<string, Partial<{ unknownLines: number; totalLines: number; at: number }>>)) {
    if (e && typeof e.unknownLines === "number" && typeof e.totalLines === "number" && typeof e.at === "number") {
      out[k] = { unknownLines: e.unknownLines, totalLines: e.totalLines, at: e.at };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function dfHome(): string {
  return process.env.DF_HOME ?? join(homedir(), ".config", "df");
}
function statePath(): string {
  return join(dfHome(), "state.json");
}

export function loadState(): TrackerState {
  const p = statePath();
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<TrackerState>;
      // On a parser-semantics change, drop the cursors so every transcript is re-parsed once
      // with the new logic (see PARSER_EPOCH). Legacy state (no parserEpoch) counts as epoch 0.
      const storedEpoch = typeof parsed.parserEpoch === "number" ? parsed.parserEpoch : 0;
      // Scan health is parse state like the cursors: an epoch bump re-measures it.
      const scanHealth = storedEpoch === PARSER_EPOCH ? sanitizeScanHealth(parsed.scanHealth) : undefined;
      return {
        apiBase: parsed.apiBase ?? DEFAULT_API_BASE,
        deviceToken: parsed.deviceToken ?? null,
        uid: parsed.uid ?? null,
        handle: parsed.handle ?? null,
        repoHmacKey: parsed.repoHmacKey ?? randomBytes(32).toString("hex"),
        cursors: storedEpoch === PARSER_EPOCH ? (parsed.cursors ?? {}) : {},
        threadDigests: storedEpoch === PARSER_EPOCH ? (parsed.threadDigests ?? {}) : {},
        // Watermarks are change-detection parse state, same epoch rule as cursors.
        watermarks: storedEpoch === PARSER_EPOCH ? sanitizeWatermarks(parsed.watermarks) : {},
        // Org state survives a parser-epoch bump: it is enrollment truth, not parse state.
        org: sanitizeOrg(parsed.org),
        orgStamp: typeof parsed.orgStamp === "string" ? parsed.orgStamp : "none",
        parserEpoch: PARSER_EPOCH,
        lastSyncAt: parsed.lastSyncAt ?? 0,
        gapMs: parsed.gapMs ?? 5 * 60 * 1000,
        ...(parsed.updateCheck && typeof parsed.updateCheck.at === "number"
          ? { updateCheck: { at: parsed.updateCheck.at, latest: typeof parsed.updateCheck.latest === "string" ? parsed.updateCheck.latest : null } }
          : {}),
        ...(scanHealth ? { scanHealth } : {}),
        // Soft-skip is NOT epoch-gated (recomputed fresh every pass regardless, and
        // reading it once between passes -- e.g. `status` -- is harmless even if stale).
        ...(sanitizeSoftSkip(parsed.softSkip) ? { softSkip: sanitizeSoftSkip(parsed.softSkip) } : {}),
        // limitsProviders is enrollment truth like org, NOT parse state -- it survives a
        // PARSER_EPOCH bump untouched. A decline (`claude: false`) must persist as the map
        // itself, not collapse to absent, so the key check is on the RAW parsed value.
        ...(parsed.limitsProviders !== undefined ? { limitsProviders: sanitizeLimitsProviders(parsed.limitsProviders) } : {}),
        // redact is enrollment truth like limitsProviders — epoch-proof, boolean-only.
        ...(typeof parsed.redact === "boolean" ? { redact: parsed.redact } : {}),
        // billingMode/monthlyBudgetUsd are enrollment truth like limitsProviders/redact —
        // epoch-proof, sanitized on every load, never trusted raw.
        ...(sanitizeBillingMode(parsed.billingMode) !== undefined ? { billingMode: sanitizeBillingMode(parsed.billingMode) } : {}),
        ...(sanitizeMonthlyBudgetUsd(parsed.monthlyBudgetUsd) !== undefined ? { monthlyBudgetUsd: sanitizeMonthlyBudgetUsd(parsed.monthlyBudgetUsd) } : {}),
        // onboardedAt is enrollment truth like billingMode/monthlyBudgetUsd -- epoch-proof,
        // sanitized on every load, never trusted raw.
        ...(sanitizeOnboardedAt(parsed.onboardedAt) !== undefined ? { onboardedAt: sanitizeOnboardedAt(parsed.onboardedAt) } : {}),
        // orgAskedAt is enrollment truth like onboardedAt -- epoch-proof, sanitized on
        // every load, never trusted raw.
        ...(sanitizeOrgAskedAt(parsed.orgAskedAt) !== undefined ? { orgAskedAt: sanitizeOrgAskedAt(parsed.orgAskedAt) } : {}),
        // userRates (L17) is LOCAL config truth like billingMode -- epoch-proof, sanitized
        // on every load, never trusted raw, and NEVER part of any ingest payload.
        ...(sanitizeUserRates(parsed.userRates) !== undefined ? { userRates: sanitizeUserRates(parsed.userRates) } : {}),
        // shareUnknownModels (L17) is config truth like redact -- epoch-proof, boolean-only.
        ...(typeof parsed.shareUnknownModels === "boolean" ? { shareUnknownModels: parsed.shareUnknownModels } : {}),
        // lastBillingSource (L18) is a local diagnostic baseline -- epoch-proof (a flip
        // must still be detectable across a parser bump), sanitized on every load.
        ...(sanitizeLastBillingSource(parsed.lastBillingSource) !== undefined ? { lastBillingSource: sanitizeLastBillingSource(parsed.lastBillingSource) } : {}),
      };
    } catch {
      /* fall through to a fresh state */
    }
  }
  return {
    apiBase: DEFAULT_API_BASE,
    deviceToken: null,
    uid: null,
    handle: null,
    repoHmacKey: randomBytes(32).toString("hex"),
    cursors: {},
    threadDigests: {},
    watermarks: {},
    orgStamp: "none",
    parserEpoch: PARSER_EPOCH,
    lastSyncAt: 0,
    gapMs: 5 * 60 * 1000,
  };
}

export function saveState(state: TrackerState): void {
  mkdirSync(dfHome(), { recursive: true });
  // Atomic write: temp file + rename. Hooks spawn concurrent syncs, and a reader that
  // catches a half-written state.json parse-fails into an EMPTY ledger (the "files
  // Claude 0 / Codex 0" header bug) — and can then SAVE that emptiness, wiping the
  // cursors. rename() replaces in one step on both POSIX and Windows (MOVEFILE_REPLACE_EXISTING).
  const tmp = statePath() + `.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, statePath());
}

/**
 * The ask-once ruling's ONLY write (sim-report.md Finding 3): record that onboarding
 * was asked on this device, touching nothing else. Deliberately NOT loadState() ->
 * saveState(): that round-trip would normalize the whole file (injecting defaults like
 * lastSyncAt/orgStamp/watermarks into a state that never carried them), and a decline
 * must write exactly one fact — the raw stored fields are patched in place, verbatim.
 * A missing or corrupt state.json falls back to the full normalized default state
 * (there is nothing on disk worth preserving), same recovery posture as loadState().
 * Same atomic temp-file + rename discipline as saveState.
 */
export function markOnboarded(at: number): void {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(statePath(), "utf8")) as Record<string, unknown>;
  } catch {
    raw = loadState() as unknown as Record<string, unknown>;
  }
  raw.onboardedAt = at;
  mkdirSync(dfHome(), { recursive: true });
  const tmp = statePath() + `.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 });
  renameSync(tmp, statePath());
}

/**
 * D14 C3's ask-once write, same raw-patch discipline as markOnboarded: record that the
 * org-join question was asked on this device, touching nothing else. A decline (or a
 * skip) must write exactly one fact — the raw stored fields are patched in place,
 * verbatim, never round-tripped through loadState()/saveState() (which would normalize
 * the whole file). Same missing/corrupt-state.json fallback and atomic temp-file +
 * rename discipline as markOnboarded.
 */
export function markOrgAsked(at: number): void {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(statePath(), "utf8")) as Record<string, unknown>;
  } catch {
    raw = loadState() as unknown as Record<string, unknown>;
  }
  raw.orgAskedAt = at;
  mkdirSync(dfHome(), { recursive: true });
  const tmp = statePath() + `.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 });
  renameSync(tmp, statePath());
}

/**
 * L18: persist the last-seen billing source, same raw-patch discipline as
 * markOnboarded/markOrgAsked — record exactly one diagnostic fact (the presence-derived
 * source enum, NEVER a credential value), touching nothing else, without round-tripping
 * through loadState()/saveState() (which would normalize the whole file). Same
 * missing/corrupt-state.json fallback and atomic temp-file + rename discipline.
 */
export function markBillingSource(source: BillingSource): void {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(statePath(), "utf8")) as Record<string, unknown>;
  } catch {
    raw = loadState() as unknown as Record<string, unknown>;
  }
  raw.lastBillingSource = source;
  mkdirSync(dfHome(), { recursive: true });
  const tmp = statePath() + `.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 });
  renameSync(tmp, statePath());
}

/**
 * repoCheckouts pseudonym: a stable, device-LOCAL id for caller-supplied local project
 * material. The input is the sanitized project-directory LABEL — every call site passes
 * basename(cwd), NEVER a git remote (despite older phrasing that implied one). Because it
 * is HMAC'd with a per-device local key, the server cannot invert it to a slug and it is
 * not comparable across devices or users. Canonical, cross-user repo identity is
 * canonicalRepoId (server-side), not this; a raw checkout count is a
 * diagnostic, never a rank input.
 */
export function repoHash(key: string, localPathLabel: string | null): string | null {
  if (!localPathLabel) return null;
  return createHmac("sha256", key).update(localPathLabel.trim().toLowerCase()).digest("hex").slice(0, 32);
}

/** Opaque checkout identity. Raw cwd stays local; a remote change at the same path
 * produces a new id instead of silently relabeling prior observations. */
export function localRepoId(key: string, cwd: string | undefined, slug: string | null): string | null {
  if (!cwd || !slug) return null;
  return createHmac("sha256", key)
    .update(`local\0${cwd.trim().toLowerCase()}\0${slug}`)
    .digest("hex")
    .slice(0, 32);
}
