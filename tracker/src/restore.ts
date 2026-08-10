/**
 * `deploy-forward restore` (plan Task 11) — POSTs the stored device bearer token to the
 * device-token-authed POST /api/restore (the server's account-lifecycle
 * handleRestore, built in 11a) to cancel a pending account deletion. The tracker has no
 * Firebase Auth session, so it cannot call the web-only restoreMyAccount callable
 * directly — 11a built this endpoint specifically so the CLI has a path in. Same client +
 * auth shape as sync.ts's /ingest POST: same apiBase, same `Authorization: Bearer
 * <deviceToken>` header; no request body content is needed since the endpoint identifies
 * the account purely from the token.
 */
import { loadState } from "./config.js";
import * as ui from "./ui.js";

/** Outcomes the server's restore handler can produce: a fresh
 * restore, a no-op against an already-live account, this device's token no longer being
 * valid (401 — the account may be past its grace window and already hard-deleted), or
 * anything else (malformed response, unexpected status). */
export type RestoreOutcome =
  | { kind: "restored" }
  | { kind: "already_live" }
  | { kind: "not_paired" }
  | { kind: "error"; status: number; detail?: string };

/**
 * PURE response-mapper: HTTP status + parsed JSON body -> outcome. No network involved,
 * so every branch is directly unit-testable — mirrors sync.ts's classifyAccountDeleted.
 */
export function mapRestoreResponse(status: number, body: unknown): RestoreOutcome {
  if (status === 401) return { kind: "not_paired" };
  if (status >= 200 && status < 300) {
    const b = body as { restored?: unknown; alreadyLive?: unknown } | null | undefined;
    if (b?.restored === true) return { kind: "restored" };
    if (b?.restored === false && b?.alreadyLive === true) return { kind: "already_live" };
    // A 2xx matching neither documented shape falls through to the generic error below
    // rather than silently claiming success for a response we don't recognize.
  }
  const detail = (body as { error?: unknown } | null | undefined)?.error;
  return { kind: "error", status, detail: typeof detail === "string" ? detail : undefined };
}

export async function restore(): Promise<void> {
  const state = loadState();
  if (!state.deviceToken) throw new Error("Run `npx --yes deploy-forward@latest` first.");

  const r = await fetch(`${state.apiBase}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${state.deviceToken}` },
    body: JSON.stringify({}),
  });
  const body = await r.json().catch(() => ({}));
  const outcome = mapRestoreResponse(r.status, body);

  switch (outcome.kind) {
    case "restored":
      ui.done("Account restored.");
      return;
    case "already_live":
      ui.todo("Account is already active.");
      return;
    case "not_paired":
      ui.fail("This device is no longer paired.");
      ui.hint("The account may already be permanently deleted. Re-run onboarding: npx --yes deploy-forward@latest");
      process.exitCode = 1;
      return;
    case "error":
      // The tracker's standard error path: propagate and let the caller's top-level
      // catch print it uniformly (main()'s `\n  x <message>\n`, same as every other
      // subcommand's unexpected-failure path in bin/df.ts).
      throw new Error(outcome.detail ?? `restore -> ${outcome.status}`);
  }
}
