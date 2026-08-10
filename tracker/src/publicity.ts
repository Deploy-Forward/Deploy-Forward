import { loadState } from "./config.js";

export interface PublicityState {
  public: boolean;
  decided: boolean;
}

async function request(method: "GET" | "POST", value?: boolean): Promise<PublicityState> {
  const state = loadState();
  if (!state.deviceToken) throw new Error("not_paired");
  const response = await fetch(`${state.apiBase}/profile/publicity`, {
    method,
    headers: {
      authorization: `Bearer ${state.deviceToken}`,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify({ public: value }) } : {}),
    // A publicity check must never hang a command: `status` reads this on every run,
    // and a black-holed connection would otherwise stall the whole health check.
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => null)) as (PublicityState & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? `publicity_${response.status}`);
  return body as PublicityState;
}

export const getPublicity = (): Promise<PublicityState> => request("GET");
export const setPublicity = (value: boolean): Promise<PublicityState> => request("POST", value);

/**
 * L22 (canonical-plan §9.3): the ceremony's publicity question is a NOTICE, not a
 * prompt. Accounts are created public server-side; this builds the disclosure lines —
 * you are on the board, what is published, what never is, and the one command that
 * flips it. No "yes" to collect: the disclosure is the consent. A PRIVATE user
 * (explicit choice or legacy private seed) gets an empty notice — never a nag; the
 * status surfaces already carry their state. Pure so the contract is unit-testable
 * (publicityNotice.test.ts); the caller owns styling and printing.
 */
export function buildPublicityNotice(state: PublicityState): string[] {
  if (!state.public) return [];
  return [
    "You're on the public board.",
    "Published: @handle, tokens, models, Build Score, activity",
    "Never published: prompts, code, file contents, repository names",
    "Prefer privacy: npx --yes deploy-forward@latest private takes you off the board any time.",
  ];
}
