/**
 * L18 (OPEN half) — Claude Code billing-source detection + silent-flip warning.
 *
 * WHY (verified at code.claude.com/docs/en/authentication.md): Claude Code's auth
 * precedence puts ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN ABOVE the subscription
 * OAuth login. A stray API key therefore silently converts subscription work into
 * metered API billing (a founder was billed $2,200 in 12 days). We detect the source
 * so a silent flip to the metered path can be warned about, LOCALLY.
 *
 * THE PRIVACY INVARIANT (load-bearing — the deliberate inverse of the CCgather
 * anti-pattern): this module reads PRESENCE and TYPE ONLY. It NEVER reads, parses,
 * logs, hashes, uploads, or stores the CONTENTS of ~/.claude/.credentials.json or the
 * VALUE of any API-key env var. Exactly three things are observed:
 *   (1) whether ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN
 *       are PRESENT (a non-empty string), never their value;
 *   (2) whether ~/.claude/.credentials.json EXISTS (existsSync only — NEVER opening the
 *       credential to inspect its bytes);
 *   (3) the cloud-provider flags CLAUDE_CODE_USE_BEDROCK / VERTEX / FOUNDRY (presence).
 *
 * The stat-only discipline is asserted structurally by test/billingSource.test.ts's
 * static source guard: this file may use existsSync/statSync but must contain NONE of the
 * file-contents-opening APIs — any of which would open the credential. Keep it that way.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the billing source lands. `subscription` is the OAuth/login path (billed to
 * the plan); `api_key` and `bearer` are the metered paths; `cloud` is a customer's own
 * Bedrock/Vertex/Foundry account; `unknown` is "no signal at all" (never a false
 * `subscription`).
 */
export type BillingSource = "subscription" | "api_key" | "bearer" | "cloud" | "unknown";

/** The six presence booleans the pure core consumes — no fs, no env, so it is
 * hermetically testable in isolation. */
export interface BillingEnvFlags {
  apiKey: boolean;
  authToken: boolean;
  oauthToken: boolean;
  useBedrock: boolean;
  useVertex: boolean;
  useFoundry: boolean;
}

/**
 * The PURE core. Precedence MIRRORS the Claude Code auth doc, rung by rung:
 *   cloud (any use* flag) > bearer (authToken) > api_key (apiKey)
 *   > (oauthToken OR hasSubscriptionLogin ? subscription : unknown).
 * The oauth token IS a subscription token per the doc, so it maps to `subscription`.
 * The costly case — a present ANTHROPIC_API_KEY WITH a subscription login — resolves to
 * `api_key`: the key silently wins and the work is billed metered, not to the plan.
 */
export function resolveBillingSource(env: BillingEnvFlags, hasSubscriptionLogin: boolean): BillingSource {
  if (env.useBedrock || env.useVertex || env.useFoundry) return "cloud";
  if (env.authToken) return "bearer";
  if (env.apiKey) return "api_key";
  if (env.oauthToken || hasSubscriptionLogin) return "subscription";
  return "unknown";
}

/** The result of classifying a source transition. */
export interface FlipResult {
  flipped: boolean;
  kind: "to_api_key" | "other_change" | "none";
}

/**
 * Classify a transition from the last-seen source to the current one. `flipped` is true
 * iff there was a prior baseline (prev != null) and it changed. `kind` is `to_api_key`
 * ONLY for the costly subscription -> api_key case (the loud-warning trigger); every
 * other real change is `other_change`; an unchanged or first-seen (prev === null)
 * transition is `none`.
 */
export function detectFlip(prev: BillingSource | null, current: BillingSource): FlipResult {
  if (prev === null || prev === current) return { flipped: false, kind: "none" };
  const kind: FlipResult["kind"] = current === "api_key" && prev === "subscription" ? "to_api_key" : "other_change";
  return { flipped: true, kind };
}

/** The flat result of the impure collector: the six presence booleans plus the
 * credential-file presence signal, ready to feed resolveBillingSource. */
export interface CollectedBillingEnv extends BillingEnvFlags {
  hasSubscriptionLogin: boolean;
}

/** Presence = a non-empty string. An empty-string env var counts as ABSENT (merely
 * being defined is not presence); an absent key is absent. The VALUE is never inspected
 * beyond its length. */
function present(v: string | undefined): boolean {
  return typeof v === "string" && v.length > 0;
}

/**
 * The ONLY impure seam. Hermetic by construction — homeDir and env are injected, so it
 * never touches the real process.env or the real home. Reads env PRESENCE (never a
 * value) and whether ~/.claude/.credentials.json EXISTS (existsSync only — the file
 * existing is the whole signal; its contents are never opened). A zero-byte file, or
 * even a directory, at that path is handled without throwing precisely because we only
 * stat it — opening a directory's bytes would EISDIR.
 */
export function collectBillingEnv(homeDir: string, env: Record<string, string | undefined>): CollectedBillingEnv {
  return {
    apiKey: present(env.ANTHROPIC_API_KEY),
    authToken: present(env.ANTHROPIC_AUTH_TOKEN),
    oauthToken: present(env.CLAUDE_CODE_OAUTH_TOKEN),
    useBedrock: present(env.CLAUDE_CODE_USE_BEDROCK),
    useVertex: present(env.CLAUDE_CODE_USE_VERTEX),
    useFoundry: present(env.CLAUDE_CODE_USE_FOUNDRY),
    hasSubscriptionLogin: existsSync(join(homeDir, ".claude", ".credentials.json")),
  };
}

/** Human-facing one-word label for a source (status line + warning copy). */
export function billingSourceLabel(s: BillingSource): string {
  switch (s) {
    case "subscription":
      return "subscription";
    case "api_key":
      return "API key (metered)";
    case "bearer":
      return "auth token (metered)";
    case "cloud":
      return "cloud provider";
    case "unknown":
      return "unknown";
  }
}
