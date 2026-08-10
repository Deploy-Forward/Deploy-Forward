/**
 * Auth clients for the two entry paths (spine: GitHub is the canonical identity).
 *
 *   githubOnboard()  the DEFAULT: GitHub device-flow ceremony — authenticate in the
 *                    browser, server introspects the token (GET /user), account is
 *                    created/resolved by GitHub id, device token returned. Bare
 *                    `npx --yes deploy-forward@latest` runs this first.
 *   pair()           the SECONDARY path: typed-code pairing against /pair, for linking
 *                    a second machine to an existing account or Teams org enrollment.
 *                    Never the free-board entry.
 */
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { loadState, saveState, APP_BASE, GITHUB_CLIENT_ID, type TrackerState } from "./config.js";
import { requestDeviceCode, pollForToken } from "./github-device.js";
import { installHooks } from "./hooks.js";
import * as ui from "./ui.js";

/**
 * Best-effort browser open (no deps, never throws). The URL deliberately carries NO
 * pairing code — /pair refuses to prefill from the URL by design (a crafted
 * /pair?code=ATTACKER link would make pairing an attacker's device one click); typing
 * the code from YOUR terminal is the phishing defense.
 */
function openBrowser(url: string): void {
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" });
    // Spawn failure surfaces as an ASYNC 'error' event, not a throw — unhandled, it
    // crashes the process mid-ceremony. Swallow it: the printed URL is the fallback.
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the printed URL is the fallback */
  }
}

interface StartResp {
  code: string;
  pollSecret: string;
  expiresInMs: number;
}
interface ClaimResp {
  status: string;
  deviceToken?: string;
  uid?: string;
  handle?: string | null;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    // Surface the server's error code (e.g. github_already_linked) instead of a bare status.
    const detail = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ? `${detail.error} (${r.status})` : `${url} -> ${r.status}`);
  }
  return (await r.json()) as T;
}

// Friendly text for known server error codes surfaced during login.
function friendlyLoginError(message: string): string {
  if (message.startsWith("github_already_linked"))
    return "That GitHub account is already verified on another Deploy Forward account. Sign out there first, or contact support to merge them.";
  return message;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Typed-code pairing — the universal existing-account bridge (second machine, web-first
 * sign-up, Teams org enrollment). The browser session proves the uid, so this works for
 * EVERY auth method — GitHub, Google, email — never a password in the terminal (SPEC §6.2).
 * The device label sent to the server is this machine's hostname, so the account's
 * device list reads like an inventory across machines.
 *
 * `ceremony: true` runs it as a step INSIDE the first-run walkthrough: no second banner,
 * no standalone preamble, and hooks/final copy are left to the ceremony's own steps.
 * Returns success so the ceremony can branch; the standalone subcommand ignores it.
 */
export async function pair(opts: { ceremony?: boolean } = {}): Promise<boolean> {
  const state = loadState();
  const start = await postJson<StartResp>(`${state.apiBase}/pair`, { label: hostname() });

  if (!opts.ceremony) {
    ui.banner();
    console.log(`        Pairs this machine to an EXISTING account (second machine / org device).`);
    console.log(`        ${ui.c.dim("First machine? Just run `npx --yes deploy-forward@latest` — GitHub sign-in is the default.")}`);
    ui.blank();
  }
  console.log(`        Sign in at ${ui.c.accent(`${APP_BASE}/pair`)} ${ui.c.dim("(opening your browser…)")}`);
  console.log(`        then type this code there — never a code someone sent you:`);
  ui.bigCode(start.code);
  openBrowser(`${APP_BASE}/pair`);
  const wait = ui.spinner("Waiting for approval in the browser…");

  const deadline = Date.now() + start.expiresInMs;
  while (Date.now() < deadline) {
    await sleep(2500);
    let claim: ClaimResp;
    try {
      claim = await postJson<ClaimResp>(`${state.apiBase}/pair/claim`, {
        code: start.code,
        pollSecret: start.pollSecret,
      });
    } catch {
      continue; // transient network blip — keep polling until the code expires
    }
    if (claim.status === "approved" && claim.deviceToken) {
      // Pairing to a DIFFERENT account must reset the sync ledgers: cursors/threadDigests
      // describe what reached the OLD uid's docs, and the server keys docs by uid — kept
      // stale, the digest gate would skip uploads and the new account would stay empty
      // while the CLI claims everything re-syncs. A fresh ledger forces the full re-upload.
      const accountChanged = state.uid !== null && state.uid !== (claim.uid ?? null);
      const next: TrackerState = {
        ...state,
        deviceToken: claim.deviceToken,
        uid: claim.uid ?? null,
        handle: claim.handle ?? null,
        ...(accountChanged ? { cursors: {}, threadDigests: {} } : {}),
      };
      saveState(next);
      wait.done(`Paired as ${ui.c.bold("@" + (claim.handle ?? claim.uid))} ${ui.c.dim(`(this device: ${hostname()})`)}`);
      if (!opts.ceremony) {
        // Hooks ARE the daemon: Claude Code now triggers debounced syncs on session
        // lifecycle events — no resident process needed after this command exits.
        // (In the ceremony, the walkthrough's own hooks step installs and explains them.)
        installHooks();
        ui.hint("Syncing automatically from now on — no terminal needed.");
        ui.blank();
      }
      return true;
    }
  }
  wait.fail(`Pairing code expired. Run \`npx --yes deploy-forward@latest${opts.ceremony ? "" : " pair"}\` again.`);
  process.exitCode = 1;
  return false;
}

/**
 * The GitHub-auth-first ceremony (the ccgather-quality bar, P0.6): device-flow codes,
 * browser open + fallback URL, live waiting-for-authorization countdown, then the server
 * introspects the access token (GET /user), creates/resolves the account by GitHub id,
 * sets github_verified, collapses the handle to @login, and returns a device token.
 *
 * All failure copy prints in place; returns false instead of throwing so the wizard can
 * set the exit code without double-printing. Never prompts — the caller owns the
 * "Authenticate now?" question and the non-TTY guard.
 */
export async function githubOnboard(): Promise<boolean> {
  const state = loadState();

  let dc;
  try {
    dc = await requestDeviceCode(GITHUB_CLIENT_ID);
  } catch (e) {
    ui.fail(`Could not reach GitHub: ${(e as Error).message}`);
    ui.hint("Check your connection and run `npx --yes deploy-forward@latest` again.");
    return false;
  }

  // GitHub's verification_uri carries NO code (the user types it there), so opening it
  // directly is safe — unlike our /pair page, which must never be opened with a code.
  console.log(`        Opening ${ui.c.accent(dc.verification_uri)} in your browser...`);
  console.log(`        ${ui.c.dim("If nothing opens, visit that URL and enter this code:")}`);
  ui.bigCode(dc.user_code);
  openBrowser(dc.verification_uri);

  const wait = ui.countdownSpinner("Waiting for authorization...", Date.now() + dc.expires_in * 1000);
  let token: string;
  try {
    token = await pollForToken(GITHUB_CLIENT_ID, dc);
  } catch (e) {
    // pollForToken's messages are already honest copy: cancelled in browser, code
    // expired, timed out. Each ends the ceremony; rerunning mints a fresh code.
    wait.fail(`${(e as Error).message} Run \`npx --yes deploy-forward@latest\` to try again.`);
    return false;
  }
  wait.done("Authorized in the browser");

  const sp = ui.spinner("Verifying with Deploy Forward...");
  let resp: { deviceToken?: string; uid?: string; handle?: string | null; login?: string; accountCreated?: boolean };
  try {
    resp = await postJson(`${state.apiBase}/github/device`, {
      accessToken: token,
      // if already paired, link GitHub to THIS account instead of creating a new one
      ...(state.deviceToken ? { deviceToken: state.deviceToken } : {}),
    });
  } catch (e) {
    sp.fail(friendlyLoginError((e as Error).message));
    return false;
  }
  if (!resp.deviceToken) {
    sp.fail("Server did not return a device token.");
    return false;
  }

  // Pairing to a DIFFERENT account resets the sync ledgers — see pair() for why.
  const accountChanged = state.uid !== null && state.uid !== (resp.uid ?? null);
  saveState({
    ...state,
    deviceToken: resp.deviceToken,
    uid: resp.uid ?? null,
    handle: resp.handle ?? resp.login ?? null,
    ...(accountChanged ? { cursors: {}, threadDigests: {} } : {}),
  });
  // Say WHICH happened (Marco 2026-07-10): a first-time GitHub identity gets a brand-new
  // account minted server-side; an existing one (web-first sign-up, a prior pairing)
  // links with no duplicate. Older servers omit the flag — then we claim neither.
  const who = ui.c.bold("@" + (resp.handle ?? resp.login));
  const device = ui.c.dim(`(this device: ${hostname()})`);
  if (resp.accountCreated === true) {
    sp.done(`New account created for ${who} ${device}`);
    ui.hint("Your GitHub identity is the account — nothing else to set up.");
  } else if (resp.accountCreated === false) {
    sp.done(`Linked to your existing account ${who} ${device} — no duplicate`);
  } else {
    sp.done(`Authenticated as ${who} ${device}`);
  }
  return true;
}

export async function logout(): Promise<void> {
  const state = loadState();
  // Invalidate the token SERVER-SIDE first so a leaked/old copy can't keep syncing after
  // logout (deviceIndex/{deviceId}.revoked=true → verifyDeviceToken rejects it). Best-effort:
  // still clear locally even if the network call fails.
  if (state.deviceToken) {
    try {
      await fetch(`${state.apiBase}/device/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${state.deviceToken}` },
      });
    } catch {
      /* offline — the local clear below still removes the token from this machine */
    }
  }
  saveState({ ...state, deviceToken: null, uid: null, handle: null });
  console.log("  ✓ Signed out on this device.");
}
