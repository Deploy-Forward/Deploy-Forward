#!/usr/bin/env node
/**
 * deploy-forward - the Deploy Forward tracker (run via `npx --yes deploy-forward@latest`).
 *
 *   deploy-forward                  first run: guided setup — create an account or link this
 *                                   machine to your existing one; every run after: account
 *                                   dashboard + live monitor (interactive terminals only; Ctrl-C any time)
 *   deploy-forward pair             pair a SECOND machine to your account (typed code; also org enrollment)
 *   deploy-forward start            the same live monitor, skipping the ceremony (hooks already sync)
 *   deploy-forward super-start      full-screen animated showcase of this machine's real usage (--light for a light terminal; --static for plain text; --redact to hide thread/repo names)
 *   deploy-forward sync             sync once and exit
 *   deploy-forward status           auth, hooks, last sync - the health check
 *   deploy-forward usage             local per-model usage + session windows (no account needed)
 *   deploy-forward usage --by-project   per-project token attribution
 *   deploy-forward usage --by-day       per-day totals, last 30 days
 *   deploy-forward usage --json         any usage view as a JSON array
 *   deploy-forward usage --cost         adds an EST COST column (public list prices only)
 *   deploy-forward update           update to the latest published version (alias: --update)
 *   deploy-forward beat             (internal) called by Claude Code hooks
 *   deploy-forward restore          cancel a pending account deletion (during the 30-day grace period)
 *   deploy-forward logout           sign this device out (removes the device token)
 *   deploy-forward uninstall        remove the Claude Code hooks
 *   deploy-forward org join <code>              redeem an org invite code
 *   deploy-forward org request <slug-or-url>    ask to join an org by its workspace URL
 *   deploy-forward org request --cancel [slug]  cancel a pending join request
 *   deploy-forward org leave                    leave your organization
 *
 * GitHub is the canonical identity: bare `npx --yes deploy-forward@latest` authenticates via the GitHub
 * device flow (proven by OAuth, never a typed username) and needs no prior npm install.
 * `login` remains as a compatibility alias for the bare command.
 *
 * Privacy: only reads token counts, timestamps, model names and a local repo hash from your
 * transcripts. It never reads or transmits your code or prompts.
 */
import { hostname, homedir } from "node:os";
import { pair, githubOnboard, logout } from "../src/auth.js";
import { syncOnce, TRACKER_VERSION, formatAccountDeletedMessage } from "../src/sync.js";
import { restore } from "../src/restore.js";
import { backfillRepository, linkRepository, listLinks, listOrganizations, showAttributionStatus, unlinkRepository } from "../src/repoAttribution.js";
import { installHooks, uninstallHooks, hooksInstalled, healHooks, beat } from "../src/hooks.js";
import { loadState, saveState, markOrgAsked, markBillingSource, APP_BASE, type TrackerState } from "../src/config.js";
import { collectBillingEnv, resolveBillingSource, detectFlip, billingSourceLabel } from "../src/billingSource.js";
import {
  refreshOrgContext,
  redeemInviteCode,
  requestToJoinOrg,
  cancelJoinRequest,
  leaveOrgDevice,
  renderOrgErrorLine,
  type OrgJoinError,
} from "../src/orgContext.js";
import { formatProviderCounts, monitorStats } from "../src/monitorStats.js";
import {
  buildLiveSpendPush,
  liveSpendEnabled,
  liveSpendSignatureOf,
  type LiveSpendLast,
} from "../src/liveSpend.js";
import type { SessionSummary } from "../src/types.js";
import { PROVIDERS, isDriftSuspected, DRIFT_HEALTH_TTL_MS, type ProviderManifest } from "../src/providers.js";
import { printUsage, type UsageOptions } from "../src/usageView.js";
import { setUserRate, listUserRates, unsetUserRate, type UserRate } from "../src/userRates.js";
import { runSuperStart, billingModeOnboarding, orgJoinOnboarding, NON_TTY_NOTE, openInBrowser } from "../src/superStart.js";
import { update, checkForNewerVersion, staleVersionBanner } from "../src/update.js";
import { getPublicity, setPublicity, buildPublicityNotice, type PublicityState } from "../src/publicity.js";
import * as ui from "../src/ui.js";

/**
 * Bare-command dispatch: a device with no token gets the first-run ceremony; a
 * registered device gets the returning-run dashboard. The walkthrough is onboarding,
 * not a toll — nobody re-lives five steps to reach the monitor (docs/cli-onboarding-ux.md).
 */
async function setup(): Promise<void> {
  // D8 (Marco 2026-07-18): super-start IS the default. Any interactive bare run —
  // new or returning — lands in the showcase, whose own onboarding covers the
  // first-run ceremony (board -> pairing -> billing). Non-TTY keeps the legacy
  // paths: a script that ran `deploy-forward` yesterday must see the same shape.
  if (process.stdout.isTTY && process.stdin.isTTY) {
    await runShowcase();
    return;
  }
  if (loadState().deviceToken) {
    await returningRun();
    return;
  }
  await firstRun();
}

/** connectDeviceCeremony()'s outcome: "declined" is [3] Not now (no error, nothing
 * minted); "connected"/"failed" both ran a real auth attempt, differing only in
 * whether it succeeded. Callers decide their own exit code per outcome. */
type ConnectResult = { status: "declined" } | { status: "connected" | "failed"; viaPair: boolean };

/**
 * The connect-menu ceremony: create account / link existing / not now, then the
 * matching flow (src/auth.ts's githubOnboard()/pair()). Extracted so super-start's
 * onboarding hook (Marco 2026-07-17 ruling) can REUSE this exact ceremony instead of
 * reimplementing it — firstRun's step 1 is this function plus its own TTY guard and
 * exit-code handling, unchanged. Decision A — may this DEVICE capture? — IS this menu:
 * choosing to create or link consents, [3] declines, and nothing is minted or recorded
 * on decline. The multi-device tie is [2]: the browser session proves the uid for ANY
 * auth method (GitHub, Google, email), so an existing user's new machine — private
 * users included — attaches to the same account instead of minting a second human
 * (never a password in the terminal, SPEC §6.2).
 */
async function connectDeviceCeremony(): Promise<ConnectResult> {
  console.log(`        This machine isn't linked to a Deploy Forward account yet.`);
  const choice = await ui.choose([
    { label: "Create a new account", hint: "GitHub sign-in — board-ready identity" },
    { label: "Link to my existing account", hint: "second machine, or you signed up on the web" },
    { label: "Not now" },
  ]);
  if (choice === 3) return { status: "declined" };
  const viaPair = choice === 2;
  if (viaPair) {
    console.log(`        The browser proves who you are — GitHub, Google, or email all work, and`);
    console.log(`        ${ui.c.dim("your @handle, board choice, organizations and history stay: this only")}`);
    console.log(`        ${ui.c.dim("adds a device to that same account. Never a password in the terminal.")}`);
    let paired = false;
    try {
      paired = await pair({ ceremony: true });
    } catch (e) {
      ui.fail(`Could not reach the pairing service: ${(e as Error).message}`);
      ui.hint("Check your connection and run `npx --yes deploy-forward@latest` again.");
    }
    return { status: paired ? "connected" : "failed", viaPair: true };
  }
  console.log(`        Your GitHub identity is your board identity — proven by OAuth,`);
  console.log(`        ${ui.c.dim("never a typed username. Pulls merged PRs, reviews, issues and commits")}`);
  console.log(`        ${ui.c.dim("(365 days, server-side) to light up your Build Score. Signed up with")}`);
  console.log(`        ${ui.c.dim("this GitHub before? It resolves to that same account — no duplicate.")}`);
  const onboarded = await githubOnboard();
  return { status: onboarded ? "connected" : "failed", viaPair: false };
}

/**
 * super-start's onboarding question for an unpaired, interactive device (Marco
 * 2026-07-17 ruling): pairing links THIS device to a profile (multiple devices can
 * share one account); declining keeps the watch running with everything local.
 * Called by runSuperStart before the full-screen takeover — never inside it.
 *
 * D14 (docs/d14-two-way-join-spec.md, fix: D10): the billing-mode question this used to
 * ask internally, unconditionally, right here — BEFORE pairing had even run — is now
 * sequenced explicitly by runSuperStart itself (opts.askBillingMode), AFTER the org-join
 * question (opts.askOrgJoin, C1), which in turn needs the device token a successful pair
 * mints. Extracting it lets the three questions run in the correct order — board, then
 * (if paired) org, then billing — instead of org having to reach INTO this function.
 */
async function askSuperStartOnboarding(): Promise<boolean> {
  console.log(`        ${ui.c.bold("Put this device's usage on the board?")}`);
  console.log(`        ${ui.c.dim("Pairs this device to your profile, or creates one — other devices can")}`);
  console.log(`        ${ui.c.dim("share the same account. Decline and everything here stays local.")}`);
  return ui.confirmRequired("Pair this device?");
}

/** Free-text budget prompt: a positive USD figure, or Enter to skip (D22 — budget is
 * optional). Not a yes/no, so it uses raw readline rather than ui.confirmRequired. */
async function askBudgetUsd(): Promise<number | null> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const ans = (await rl.question(`        Monthly budget in USD (Enter to skip) `)).trim();
      if (ans === "") return null;
      const n = Number(ans);
      if (Number.isFinite(n) && n > 0) return n;
      console.log(`        ${ui.c.dim("Enter a positive number, or press Enter to skip.")}`);
    }
  } finally {
    rl.close();
  }
}

/**
 * D20's three-way plan-type question (Marco's ruling, 2026-07-19, docs/context-capacity-
 * plan.md Phase 8), asked immediately after the board question above — same gate:
 * runSuperStart calls askOnboarding (and therefore this) only for an unpaired,
 * interactive run, never for a paired or non-interactive device. Supersedes the legacy
 * D9 boolean-gate flow (billingOnboarding stays exported from superStart.ts, untouched,
 * for the devices its own end-to-end test still pins — this is just no longer the
 * production onboarding path). billingModeOnboarding itself is pure (reads no state,
 * remembers nothing across calls); this wires the real prompts and is the ONLY place
 * that persists the answer, the same division of labor connectDeviceCeremony has with
 * pair()/githubOnboard(). Not sticky-forever: running super-start again re-asks and can
 * flip it (Billing is also now editable in Settings, D20's other ruling).
 */
async function askSuperStartBillingMode(): Promise<void> {
  const result = await billingModeOnboarding({
    mode: async () => {
      console.log(`        ${ui.c.bold("Which plan are you on?")}`);
      const n = await ui.choose([{ label: "usage-based API" }, { label: "subscription" }, { label: "mix" }]);
      return (["api", "subscription", "mix"] as const)[n - 1]!;
    },
    provider: async (name) => {
      const label = name === "claude" ? "Claude" : name;
      console.log(`        ${ui.c.bold(`Fetch ${label}'s own usage limits?`)}`);
      console.log(`        ${ui.c.dim("Read-only, your own stored login token, never sent anywhere but its own")}`);
      console.log(`        ${ui.c.dim("vendor — full detail: docs/usage-limits-explained.md")}`);
      return ui.confirmRequired(`Fetch ${label} limits?`);
    },
    budget: askBudgetUsd,
  });
  const state = loadState();
  saveState({
    ...state,
    billingMode: result.mode,
    ...(result.providers ? { limitsProviders: { ...state.limitsProviders, ...result.providers } } : {}),
    ...(result.budget !== undefined ? { monthlyBudgetUsd: result.budget } : {}),
  });
}

// ==========================================================================================
// D14 two-way org join (docs/d14-two-way-join-spec.md) — CLI onboarding + settings + commands.
//
// The SERVER routes these call are a separate, human-gated build lane and
// are NOT implemented anywhere yet. Every path below is written against the spec's documented
// contract (src/orgContext.ts's redeem/request/cancel/leave + response mappers, already unit-
// tested against a fake fetchImpl) and fails HONESTLY — never a silent success — when the
// route does not yet exist (a 404, or a connection refusal, both fall through orgContext.ts's
// "network"/"unknown" fallback and render as an honest error line here, never a false "Joined").
// ==========================================================================================

/** C11: renders any OrgJoinError as one honest line. account_deleted carries a restoreBy
 * epoch the generic renderOrgErrorLine (src/orgContext.ts) deliberately does NOT format —
 * it has no dependency on sync.ts (avoiding a circular import) — so that ONE case is handled
 * here, where formatAccountDeletedMessage is already imported for every other command. */
function renderOrgErrorMessage(err: OrgJoinError): string {
  if (err.code === "account_deleted") return formatAccountDeletedMessage(err.restoreBy, Date.now());
  return renderOrgErrorLine(err.code, { origin: APP_BASE });
}

/** The D27 consent sentence (PR #61's verbatim template), printed on EVERY join surface
 * per spec C4/C8/D16 — before the success line of a redeem, and at submission of a
 * request. Shared by the onboarding question frame and the standalone subcommands. */
function printOrgConsentLine(): void {
  console.log(`        ${ui.c.dim("Note: your organization sees your work in full once you connect a device -")}`);
  console.log(`        ${ui.c.dim("a private public-board choice never hides anything from them.")}`);
}

/**
 * Redeem an invite code (spec S5/C5/C8). Shared verbatim by BOTH the onboarding question
 * (askSuperStartOrgJoin) and the standalone `df org join <code>` subcommand — one code
 * path, never a reimplementation. `printConsent: false` is passed ONLY from onboarding,
 * whose own C4 question frame already showed the D27 sentence once, before the choice was
 * even made — the standalone subcommand shows it here instead, since it has no such frame.
 */
async function runOrgJoinByCode(code: string, opts: { printConsent?: boolean } = {}): Promise<void> {
  const trimmed = code.trim();
  if (!trimmed) {
    ui.fail("Usage: npx --yes deploy-forward@latest org join <code>");
    process.exitCode = 1;
    return;
  }
  const r = await redeemInviteCode(loadState(), trimmed);
  if (!r.ok) {
    ui.fail(renderOrgErrorMessage(r));
    process.exitCode = 1;
    return;
  }
  if (opts.printConsent !== false) printOrgConsentLine();
  ui.done(`Joined ${r.orgLabel} as ${r.role}.`);
  // THE CRITICAL UX FIX (workflow's #1 gap): a bare "Joined." leaves the user guessing
  // whether their machine's SESSIONS actually attribute to the org now. They do — the
  // device-token join route (redeemInviteCode) IS the device's own membership door, so
  // no separate enrollment step exists or is needed. Say so explicitly, every time.
  console.log(`        ${ui.c.dim(`This device's sessions now attribute to ${r.orgLabel} - no separate step needed.`)}`);
  console.log(`        ${ui.c.dim(`Workspace: ${APP_BASE}/org`)}`);
  // Force the next org-context read (sync, status, settings) to re-confirm rather than
  // trust a pre-join cache — same idiom repoAttribution.ts uses after link/unlink.
  const fresh = loadState();
  if (fresh.org) fresh.org.checkedAt = 0;
  saveState(fresh);
}

/**
 * Request to join an org by slug or URL (spec S10/C5/C8). Shared verbatim by onboarding
 * and the standalone `df org request <slug-or-url>` subcommand, same discipline as
 * runOrgJoinByCode above.
 */
async function runOrgRequestBySlug(slugOrUrl: string, message: string | undefined, opts: { printConsent?: boolean } = {}): Promise<void> {
  const trimmed = slugOrUrl.trim();
  if (!trimmed) {
    ui.fail("Usage: npx --yes deploy-forward@latest org request <slug-or-url>");
    process.exitCode = 1;
    return;
  }
  // D27/D16: consent is captured AT SUBMISSION, before the network call — approval can
  // land up to 7 days later and relies on having been shown here, not after the fact.
  if (opts.printConsent !== false) printOrgConsentLine();
  const r = await requestToJoinOrg(loadState(), trimmed, message);
  if (!r.ok) {
    ui.fail(renderOrgErrorMessage(r));
    process.exitCode = 1;
    return;
  }
  if (r.alreadyPending) {
    ui.done(`Already pending: request to ${r.orgLabel}.`);
  } else {
    ui.done(`Request sent to ${r.orgLabel}. An admin decides; check npx --yes deploy-forward@latest status.`);
  }
}

/** Parses the positional slug/orgId argument out of `org request <slug-or-url>` OR
 * `org request --cancel [slug-or-url]`, skipping `--cancel` itself and a `--message
 * <value>` pair if present — zero-dep argv scanning, same minimalism as flag()/hasFlag(). */
function orgRequestPositionalArg(): string | undefined {
  const args = process.argv.slice(4); // argv: [node, df.js, "org", "request", ...]
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cancel") continue;
    if (args[i] === "--message") {
      i++; // also skip its value
      continue;
    }
    out.push(args[i]);
  }
  return out[0];
}

/** `df org request --cancel [slug-or-url]` (spec S11/C8's D7 selection rule): with
 * exactly one pending request the argument is optional; with more than one it is
 * required, and omitting it exits nonzero listing the pending slugs. */
async function runOrgRequestCancel(slugArg: string | undefined): Promise<void> {
  const state = loadState();
  const { ctx } = await refreshOrgContext(state);
  saveState(state); // refreshOrgContext mutates state.org in place -- persist the fresh cache
  const pending = ctx.pendingRequests ?? [];
  if (pending.length === 0) {
    ui.todo("No pending join requests.");
    return;
  }
  let target = pending[0];
  if (pending.length > 1) {
    if (!slugArg) {
      ui.fail("Multiple pending requests - specify one:");
      for (const p of pending) console.log(`    ${p.slug}`);
      process.exitCode = 1;
      return;
    }
    const match = pending.find((p) => p.slug === slugArg.trim().toLowerCase() || p.orgId === slugArg.trim());
    if (!match) {
      ui.fail(`No pending request for "${slugArg}".`);
      process.exitCode = 1;
      return;
    }
    target = match;
  } else if (slugArg) {
    target = pending.find((p) => p.slug === slugArg.trim().toLowerCase() || p.orgId === slugArg.trim()) ?? target;
  }
  const r = await cancelJoinRequest(state, target.orgId);
  if (!r.ok) {
    ui.fail(renderOrgErrorMessage(r));
    process.exitCode = 1;
    return;
  }
  ui.done(`Canceled the pending request to ${target.orgLabel}.`);
}

/** `df org leave` (spec S17/C8): confirms interactively on TTY; requires --yes non-TTY —
 * same discipline as every other irreversible-ish action in this file. */
async function runOrgLeave(): Promise<void> {
  if (process.stdin.isTTY) {
    const ok = await ui.confirmRequired("Leave your organization?");
    if (!ok) {
      ui.todo("Canceled.");
      return;
    }
  } else if (!hasFlag("yes")) {
    console.error("  Non-interactive: pass --yes to confirm leaving the organization.");
    process.exitCode = 1;
    return;
  }
  const r = await leaveOrgDevice(loadState());
  if (!r.ok) {
    ui.fail(renderOrgErrorMessage(r));
    process.exitCode = 1;
    return;
  }
  ui.done("Left the organization.");
  const fresh = loadState();
  if (fresh.org) fresh.org.checkedAt = 0;
  saveState(fresh);
}

/**
 * D14 C1/C2/C4: the org-join onboarding question, asked at MOST ONCE per device
 * (orgAskedAt) and reused VERBATIM by both live onboarding paths — runShowcase's
 * opts.askOrgJoin (called by runSuperStart only after a successful pair) and firstRun's
 * ceremony (called directly after connectDeviceCeremony succeeds). Whichever ceremony
 * runs first asks and sets orgAskedAt; the other sees it set here and skips — the guard
 * lives in THIS function so both call sites can invoke it unconditionally after a
 * successful pair.
 */
async function askSuperStartOrgJoin(): Promise<void> {
  if (loadState().orgAskedAt) return;
  console.log(`        ${ui.c.bold("Join an organization?")} ${ui.c.dim("(optional - your local ledger is never gated)")}`);
  console.log(`          ${ui.c.accent("[1]")} I have an invite code`);
  console.log(`          ${ui.c.accent("[2]")} Request to join by org URL`);
  console.log(`          ${ui.c.accent("[3]")} Not now ${ui.c.dim("(default; Enter skips)")}`);
  printOrgConsentLine();
  const readLine = async (prompt: string): Promise<string> => {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(prompt)).trim();
    } finally {
      rl.close();
    }
  };
  const result = await orgJoinOnboarding({
    choice: async () => {
      while (true) {
        const ans = await readLine(`        Choose ${ui.c.dim("[1-3, Enter = 3]")} `);
        if (ans === "" || ans === "3") return "skip";
        if (ans === "1") return "code";
        if (ans === "2") return "request";
        console.log(`        ${ui.c.dim("Type 1, 2, or 3 (or press Enter to skip).")}`);
      }
    },
    code: () => readLine(`        Invite code: `),
    slug: () => readLine(`        Org URL or slug: `),
  });
  // Set ONCE regardless of the answer -- asked != joined, same discipline as onboardedAt.
  markOrgAsked(Date.now());
  // Blank input on the code/slug follow-up (Enter with nothing typed) is treated as a
  // quiet skip, never a hard failure -- this is an OPTIONAL onboarding sub-flow, and
  // setting process.exitCode here would fail the whole onboarding run (super-start or
  // firstRun) over an empty answer to a question the user could have declined outright.
  // The standalone `df org join`/`df org request` subcommands (C8) keep the real
  // usage-error + nonzero-exit behavior for a genuinely malformed direct invocation.
  if (result.action === "skip") return;
  if (result.action === "code" && !result.code.trim()) return;
  if (result.action === "request" && !result.slug.trim()) return;
  // The question frame above already printed the D27 sentence once, before the choice
  // was made -- printConsent: false avoids showing it twice for this path.
  if (result.action === "code") {
    await runOrgJoinByCode(result.code, { printConsent: false });
    return;
  }
  await runOrgRequestBySlug(result.slug, undefined, { printConsent: false });
}

/**
 * The first-run ceremony (P0.6/P0.7 + docs/cli-onboarding-ux.md). Step 1 is
 * connectDeviceCeremony() (see its own doc comment for Decision A). Decision B — the
 * public board — stays its own required question (step 4).
 */
async function firstRun(): Promise<void> {
  ui.banner(TRACKER_VERSION);
  ui.howItWorks();
  const TOTAL = 5;

  ui.step(1, TOTAL, "Connect this machine");
  if (!process.stdin.isTTY) {
    ui.fail("No interactive terminal — run `npx --yes deploy-forward@latest` in a terminal to authenticate.");
    ui.hint("Local-only usage view (no account needed): npx --yes deploy-forward@latest usage");
    process.exitCode = 1;
    return;
  }
  const result = await connectDeviceCeremony();
  if (result.status === "declined") {
    ui.todo("Skipped. Local usage works without an account: npx --yes deploy-forward@latest usage");
    ui.hint("Connect any time: npx --yes deploy-forward@latest — you cannot submit or rank without an account.");
    ui.blank();
    return;
  }
  if (result.status === "failed") {
    process.exitCode = 1;
    return;
  }
  const viaPair = result.viaPair;
  let state = loadState();
  ui.blank();

  // D14 C1(b): the org-join question, immediately after pairing succeeds — the SAME
  // persister the super-start onboarding path uses (C2), guarded by orgAskedAt (C3) so
  // whichever ceremony a device goes through first asks, and the other skips.
  await askSuperStartOrgJoin();
  state = loadState();
  ui.blank();

  ui.step(2, TOTAL, "Scan and submit your build history");
  let submitted = 0;
  const sp = ui.spinner("Scanning local agent sessions (7 CLIs — see `status` for the list)...");
  try {
    submitted = await syncOnce();
    sp.done(submitted > 0 ? `${submitted} session(s) submitted — metadata only, never code or prompts` : "Everything already up to date");
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "account_deleted") {
      // A deliberate, reversible soft-delete is a CLEAN stop, not a failure — sp.fail's
      // red ✗ would be the wrong surface here. sp.done is the only spinner-safe helper
      // that both avoids that error surface AND stops the animation cleanly (it clears
      // the spinner's own interval); a bare console.log would leave that interval
      // repainting over this line forever.
      const restoreBy = (e as Error & { restoreBy?: number }).restoreBy;
      sp.done(formatAccountDeletedMessage(restoreBy, Date.now()));
      return;
    }
    if (msg === "token_revoked") {
      sp.fail("This device's token was revoked. Run `npx --yes deploy-forward@latest logout`, then `npx --yes deploy-forward@latest` to re-authenticate.");
      process.exitCode = 1;
      return;
    }
    sp.fail(`Sync failed: ${msg} — nothing is lost; run \`npx --yes deploy-forward@latest sync\` to retry.`);
  }
  ui.blank();

  ui.step(3, TOTAL, "Automatic sync");
  if (!hooksInstalled()) installHooks();
  ui.done("Claude Code hooks active — syncs on session events, no terminal needed");
  // Consent includes the exit (Marco 2026-07-10): name removal in the same breath as
  // the install, and point at the verbatim hooks doc — a user (or their own AI
  // assistant) re-encountering the hooks cold should land on OUR precise explanation.
  ui.hint("Remove any time: npx --yes deploy-forward@latest uninstall - what the hooks do: " + APP_BASE + "/how#hooks");
  ui.blank();

  // "On the board" is only claimed when something has actually been submitted from
  // this machine — a fresh user with no transcripts gets the honest empty-state line.
  state = loadState();
  const everSynced = submitted > 0 || Object.keys(state.threadDigests).length > 0;
  ui.step(4, TOTAL, "Public profile");
  const publicity = await getPublicity();
  // L22 (canonical-plan §9.3): accounts are created PUBLIC and the ceremony DISCLOSES
  // instead of prompting — the install notice is the consent, nothing to collect. A
  // private user (their explicit choice, or a legacy private seed) gets no nag; the
  // opt-in command rides the hint below.
  printPublicityNotice(publicity);
  if (!publicity.public) {
    ui.done("Private usage profile");
    ui.hint("Change anytime: npx --yes deploy-forward@latest public");
  }
  ui.blank();

  ui.step(5, TOTAL, publicity.public && everSynced ? "You're on the board" : "Your usage");
  if (state.handle) {
    console.log(`        ${ui.c.dim("Profile")}  ${ui.c.accent(`${APP_BASE}/u/${state.handle}`)}`);
  }
  if (publicity.public) console.log(`        ${ui.c.dim("Board")}    ${ui.c.accent(APP_BASE + "/leaderboard")}`);
  // The account has TWO boards, and the closing panel names both: the public board is
  // the optional publicity choice above; the org workspace is where an enrolled device's
  // work lands regardless of it. A private builder on an enrolled machine is not
  // invisible — they are exactly where their organization looks.
  if (state.org?.enrolled) {
    console.log(`        ${ui.c.dim("Org")}      ${ui.c.accent(APP_BASE + "/org")} ${ui.c.dim(`(${state.org.orgLabel ?? state.org.orgId ?? "your organization"} — org workspace)`)}`);
  }
  // "with GitHub" is the anti-duplicate reassurance for a GitHub-created account; a
  // pair-linked account may have no GitHub at all, so its copy stays provider-neutral.
  if (viaPair) {
    console.log(`        ${ui.c.dim("Manage")}   sign in at ${ui.c.accent(APP_BASE)} the same way you signed up —`);
    console.log(`        ${ui.c.dim("         it resolves to this same account (no duplicate).")}`);
  } else {
    console.log(`        ${ui.c.dim("Manage")}   sign in at ${ui.c.accent(APP_BASE)} with GitHub — it resolves to`);
    console.log(`        ${ui.c.dim("         this same account (no duplicate).")}`);
  }
  if (!everSynced) {
    ui.hint("Your row appears once a session syncs — build something with Claude Code or Codex.");
  }
  if (!publicity.public) ui.hint("Private hides you from the public board only — your organization, if you join one, still sees your work in full.");
  // L2 is a pointer, never a step (docs/cli-onboarding-ux.md §2, amended by D14 C6): the
  // org-join question above already ran once; this closing hint just names the standing
  // commands (invite code / request-by-URL), replacing the old static /join pointer.
  if (!state.org?.enrolled) {
    const pending = state.org?.pendingRequests ?? [];
    if (pending.length > 0) {
      for (const p of pending) {
        const days = Math.max(0, Math.ceil((p.expiresAt - Date.now()) / 86_400_000));
        ui.hint(`Request pending: ${p.orgLabel} (expires ${days}d) — cancel: npx --yes deploy-forward@latest org request --cancel ${p.slug}`);
      }
    } else {
      ui.hint("Have an invite code? npx --yes deploy-forward@latest org join <code> — know the org URL? npx --yes deploy-forward@latest org request <slug>");
    }
  }
  ui.blank();

  // Passive update nudge (throttled daily, 1.5s cap, fail-silent — update.ts).
  const newer = await checkForNewerVersion();
  if (newer) {
    console.log(`  ${ui.c.warn("▲")} Update available: ${ui.c.bold("v" + newer)} ${ui.c.dim(`(running v${TRACKER_VERSION}) — npx --yes deploy-forward@latest update`)}`);
    ui.blank();
  }

  // Default run = ceremony, then STAY as the live listener (Marco 2026-07-10) — but
  // only on an interactive terminal: a scripted/CI `npx --yes deploy-forward@latest` must keep the
  // exit-clean contract (a resident process in a pipeline is a hang, not a feature).
  if (process.stdout.isTTY && process.stdin.isTTY) {
    console.log(`  ${ui.c.dim("Now watching for new sessions. Cancel any time (Ctrl-C) — hooks keep syncing")}`);
    console.log(`  ${ui.c.dim("without it. One-time upload later: npx --yes deploy-forward@latest sync")}`);
    ui.rule();
    await monitorLoop();
  }
}

/**
 * The two interactive publicity-consent branches, shared by first-run step 4 and the
 * returning-run ask. Callers guarantee an interactive stdin and an UNDECIDED state —
 * non-interactive runs record NOTHING (a default is not a decision; see returningRun()).
 */
/** L22: print the publicity disclosure (buildPublicityNotice owns the words — pure,
 * unit-tested). First line bold, the rest dim; a private user prints nothing. */
function printPublicityNotice(publicity: PublicityState): void {
  const lines = buildPublicityNotice(publicity);
  lines.forEach((line, i) => {
    console.log(`        ${i === 0 ? ui.c.bold(line) : ui.c.dim(line)}`);
  });
}

/**
 * A registered device's bare run. L22 (canonical-plan §9.3): publicity is DISCLOSED,
 * never asked — accounts are created public (the server's GitHub device flow,
 * NEW_ACCOUNT_PRIVACY), the notice tells you you're on the board and how to flip, and
 * the flip commands (`private` / `public`) are the only writers. Scripted runs still
 * write NOTHING: a script printing a notice is harmless, a script recording a choice
 * would stamp publicConsentAt for a decision no human made. `publicity.public` is the
 * EFFECTIVE board state (the server derives it with the board's own expression,
 * aggregate.ts) — the notice never contradicts the board.
 */
async function returningRun(): Promise<void> {
  if (!hooksInstalled()) installHooks();
  else healHooks(); // collapse any duplicate beat entries that accumulated since setup (Claude + Grok's frozen import)

  if (!(process.stdout.isTTY && process.stdin.isTTY)) {
    ui.banner(TRACKER_VERSION);
    // D19: the bare run without a TTY keeps this legacy shape, and says why.
    console.log(`  ${ui.c.dim(NON_TTY_NOTE)}`);
    // The field bug (root-caused 2026-07-20): a stale npx cache silently ran an old
    // build for days — this legacy non-TTY path had NO update check at all before this
    // fix. Loud, one line, naming both versions and the exact remedy (update.ts).
    const staleBanner = staleVersionBanner({ running: TRACKER_VERSION, latest: await checkForNewerVersion() });
    if (staleBanner) console.log(`  ${ui.c.warn(staleBanner)}`);
    try {
      const n = await syncOnce();
      console.log(`  ${n > 0 ? `synced ${n} session(s)` : "everything already up to date"} — metadata only, never code or prompts`);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "account_deleted") {
        const restoreBy = (e as Error & { restoreBy?: number }).restoreBy;
        console.log("  " + formatAccountDeletedMessage(restoreBy, Date.now()));
        return;
      }
      if (msg === "token_revoked") {
        console.error("  x This device's token was revoked. Run `npx --yes deploy-forward@latest logout`, then `npx --yes deploy-forward@latest` to re-authenticate.");
        process.exitCode = 1;
        return;
      }
      console.error(`  x Sync failed: ${msg} — nothing is lost; run \`npx --yes deploy-forward@latest sync\` to retry.`);
    }
    try {
      const p = await getPublicity();
      if (!p.decided) {
        console.log(
          p.public
            ? "  publicity: on the public board (pre-choice default) — no choice recorded; run in a terminal to choose"
            : "  publicity: not set — no choice recorded; run `npx --yes deploy-forward@latest` in a terminal to choose",
        );
      }
    } catch {
      /* offline — the sync line above already told the story; never guess a state we could not read */
    }
    const s = loadState();
    if (s.handle) console.log(`  profile: ${APP_BASE}/u/${s.handle}`);
    return;
  }

  ui.banner(TRACKER_VERSION);
  let publicity: PublicityState | null = null;
  try {
    publicity = await getPublicity();
  } catch {
    /* offline or unreachable — the dashboard row says "unavailable" rather than guessing */
  }
  if (publicity && !publicity.decided) {
    // L22: no question — the same disclosure the install ceremony prints, once per run
    // while no explicit choice is recorded. The dashboard row below carries the state.
    printPublicityNotice(publicity);
    ui.blank();
  }
  const publicityLabel = !publicity
    ? ui.c.dim("unavailable (offline?)")
    : publicity.public
      ? `${ui.sym.ok} public — on the board ${ui.c.dim("— npx --yes deploy-forward@latest private to leave")}`
      : `private ${ui.c.dim("— npx --yes deploy-forward@latest public to opt in")}`;
  await dashboardAndMonitor({ banner: false, publicityLabel });
}

const SYNC_INTERVAL_MS = 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Parse `usage` flags out of an arbitrary argv -- no arg-parsing dependency (the
 * tracker ships with zero runtime deps), just a few known boolean switches. Split from
 * usageOptions() so super-start's launcher can build options from ITS chosen argv and
 * reach the exact same view a typed command would. */
function usageOptionsFrom(args: readonly string[]): UsageOptions {
  const opts: UsageOptions = {};
  if (args.includes("--by-project")) opts.by = "project";
  else if (args.includes("--by-day")) opts.by = "day";
  if (args.includes("--json")) opts.json = true;
  if (args.includes("--cost")) opts.cost = true;
  return opts;
}

function usageOptions(): UsageOptions {
  return usageOptionsFrom(process.argv);
}

/** Providers whose most recent scan tripped the drift rule (W1.5, providers.ts). Both
 * honest surfaces — the status health line and the monitor's one-time warning — render
 * from THIS one read, so they can never disagree about what "suspected" means. */
function driftedProviders(state: TrackerState): ProviderManifest[] {
  return PROVIDERS.filter((p) => {
    const h = state.scanHealth?.[p.id];
    // Age cut (DRIFT_HEALTH_TTL_MS): a provider that stopped re-scanning entirely
    // (uninstalled tool, fingerprint now refusing) must not nag forever off its
    // last stored counters — stale drift is unactionable noise, not a signal.
    return h !== undefined && Date.now() - h.at < DRIFT_HEALTH_TTL_MS && isDriftSuspected(h);
  });
}

/**
 * L19 per-engineer LIVE spend push — fail-silent, interactive-monitor-only.
 *
 * Reuses the sessions the sync pass just parsed (no extra scan) to POST the running
 * session's counts-only tokensByModel to /api/device/live, gated by: the DF_LIVE_SPEND off
 * switch, the persisted redact toggle (honored as an off switch — a redacting user does not
 * feed the live share surface), confirmed org enrollment (the same fail-closed cache sync
 * uses), and the pure buildLiveSpendPush gate (idle/throttle/unenrolled → no-op). Every
 * failure path is swallowed: a live-channel error must never disturb capture or the monitor.
 * `last` is a per-process marker so the throttle/idle gate survives across cycles.
 */
async function pushLiveSpend(sessions: SessionSummary[], last: { value: LiveSpendLast | null }): Promise<void> {
  try {
    if (!liveSpendEnabled(process.env)) return;
    const state = loadState();
    if (!state.deviceToken) return;
    // Privacy: honor the redact toggle as an off switch for the live share surface.
    if (state.redact === true) return;
    // Confirmed enrollment only (fail-closed): a non-enrolled device pushes nothing. Reuses
    // the 5-minute org-context cache, so this is a cheap in-memory hit right after sync.
    const org = await refreshOrgContext(state);
    if (!org.ctx.enrolled) return;

    const push = buildLiveSpendPush({ sessions, enrolled: true, now: Date.now(), last: last.value });
    if (!push) return;

    const r = await fetch(`${state.apiBase}/device/live`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${state.deviceToken}` },
      body: JSON.stringify(push),
    });
    // 200 (written) or 204 (accepted-but-no-op: throttled/not-enrolled server-side) both mean
    // "the channel heard us" — advance the local marker so we don't re-push unchanged tokens.
    if (r.ok || r.status === 204) {
      last.value = {
        pushedAt: push.ts,
        sessionId: push.sessionId,
        signature: liveSpendSignatureOf(push.tokensByModel),
      };
    }
  } catch {
    /* fail-silent: the live channel is additive status, never load-bearing */
  }
}

/**
 * The shared live listener: one rewriting status line, sync every minute, Ctrl-C exits
 * only the monitor (hooks keep syncing). Callers print their own header first — the
 * bare-command ceremony prints its transition line, `start` prints the dashboard.
 */
async function monitorLoop(): Promise<void> {
  const started = Date.now();
  let lastSynced = 0;
  let lastError = "";
  let lastStatus = "Starting live monitor";
  let liveLineLength = 0;
  const driftWarnedIds = new Set<string>(); // once per PROVIDER per process — a provider that starts drifting hours in must still surface
  const liveSpendLast: { value: LiveSpendLast | null } = { value: null }; // L19 per-process push marker (throttle/idle)

  const ago = (t: number): string => {
    if (!t) return "never";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
  };
  const uptime = (): string => {
    const s = Math.max(0, Math.round((Date.now() - started) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  const writeLiveLine = (status: string): void => {
    const s = loadState();
    // Segment-priority line (ui.renderLive): drops whole trailing segments when the
    // terminal is tight — never mid-word truncation — and keeps a hard margin because
    // reported columns can exceed the real render width (the 10-minute wrap bug).
    // Order = display order; the tail is the first to go under pressure.
    const line = ui.renderLive([
      { t: uptime(), c: ui.c.dim },
      { t: status },
      ...(lastError ? [{ t: lastError, c: ui.c.err }] : []),
      ...(lastSynced > 0 ? [{ t: `+${lastSynced} session(s)`, c: ui.c.ok }] : []),
      { t: formatProviderCounts(monitorStats(s)), c: ui.c.dim },
      { t: `last ${ago(s.lastSyncAt)}`, c: ui.c.dim },
      { t: `@${s.handle ?? s.uid ?? "unknown"}`, c: ui.c.dim },
    ]);
    // Erase-line repaint: no residue, no padding math. Non-TTY writes the plain line
    // (the loop below adds exactly one newline per cycle in that mode).
    process.stdout.write(process.stdout.isTTY ? `\r[2K${line}` : line);
    // PLAIN length (ANSI stripped): row math on resize must count CELLS, not bytes —
    // counting escape codes would climb past the live line and eat the header rule.
    liveLineLength = line.replace(/\[[0-9;]*m/g, "").length;
  };
  const finishLiveLine = (): void => {
    if (liveLineLength > 0) {
      process.stdout.write("\n");
      liveLineLength = 0;
    }
  };
  // Resize-rewrap repair (Marco 2026-07-10: shrinking full -> half screen duplicated
  // the live line). When the window NARROWS, the already-painted line re-wraps onto
  // multiple physical rows; \r returns to the LAST of them, so a plain [2K leaves the
  // earlier rows behind as stale copies. On resize: climb to the first wrapped row,
  // erase from there DOWN ([0J]), repaint at the new width (renderLive re-clamps).
  const onResize = (): void => {
    if (!process.stdout.isTTY || liveLineLength === 0) return;
    const cols = Math.max(1, process.stdout.columns ?? 80);
    const wrappedRows = Math.max(1, Math.ceil(liveLineLength / cols));
    if (wrappedRows > 1) process.stdout.write(`[${wrappedRows - 1}A`);
    process.stdout.write("\r[0J");
    writeLiveLine(lastStatus);
  };
  process.stdout.on("resize", onResize);
  process.once("SIGINT", () => {
    process.stdout.removeListener("resize", onResize);
    finishLiveLine();
    console.log("  Monitor closed. Hooks keep syncing after it closes.");
    process.exit(130);
  });

  // Presence is driven by hooks; this monitor catches token/time totals and refreshes in-place.
  // The live surface is ONE rewritten line: no per-second newline growth in PowerShell/log buffers.
  // Transient failures stay visible on that line. Auth failures exit because user action is required.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      lastStatus = "Syncing local transcripts...";
      // The transient pre-sync status is a TTY-only repaint; piped logs get exactly
      // one settled line per cycle (below), never \r fragments.
      if (process.stdout.isTTY) writeLiveLine(lastStatus);
      const n = await syncOnce({
        verbose: false,
        // L19: the interactive monitor is the ONLY live-push origin — fail-silent inside.
        onSessions: (sessions) => pushLiveSpend(sessions, liveSpendLast),
      });
      lastSynced = n;
      lastError = "";
      lastStatus = n > 0 ? `Synced ${n} session(s). Watching for new sessions...` : "Watching for new sessions...";
      // W1.5 drift warning — a SETTLED line, once per process, when a scan first trips
      // the threshold (never a silent zero, never per-cycle spam). Surface choice: the
      // width-constrained live line would truncate the message under pressure, so this
      // uses the SIGINT handler's own discipline — finishLiveLine() to close the live
      // region, one plain console.log above it, and the loop repaints below as usual.
      const drifted = driftedProviders(loadState()).filter((p) => !driftWarnedIds.has(p.id));
      if (drifted.length > 0) {
        finishLiveLine();
        for (const p of drifted) {
          driftWarnedIds.add(p.id);
          console.log(`  ${ui.c.warn("!")} ${p.display}: transcripts changed shape — update the tracker: npx --yes deploy-forward@latest update`);
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "account_deleted") {
        // A deliberate, reversible soft-delete is a CLEAN stop (unlike token_revoked, no
        // exitCode=1) — but it must still actually STOP: `return` here exits the
        // while(true) loop, which is the whole point of this fix (decision 4). Close the
        // live line first, same discipline as the SIGINT/drift handling above.
        const restoreBy = (e as Error & { restoreBy?: number }).restoreBy;
        finishLiveLine();
        console.log(`  ${formatAccountDeletedMessage(restoreBy, Date.now())}`);
        return;
      }
      if (msg === "token_revoked" || msg === "not_paired") {
        console.error(`  ${ui.sym.err} This device is no longer authorized (${msg === "token_revoked" ? "its token was revoked" : "not signed in"}).`);
        console.error("    Run `npx --yes deploy-forward@latest` to re-authenticate, then start again.");
        process.exitCode = 1;
        return;
      }
      lastError = `${msg} - retrying; nothing is lost, transcripts re-sync in full.`;
      lastStatus = "Waiting to retry...";
    }

    const until = Date.now() + SYNC_INTERVAL_MS;
    if (!process.stdout.isTTY) {
      // Piped/redirected stdout: \r does not rewrite, it accumulates. One line per
      // sync cycle is the whole story — never a per-second countdown in a log file.
      writeLiveLine(lastStatus);
      process.stdout.write("\n");
      liveLineLength = 0;
      await sleep(Math.max(0, until - Date.now()));
      continue;
    }
    while (Date.now() < until) {
      const next = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      writeLiveLine(`${lastStatus} next sync in ${next}s`);
      await sleep(1000);
    }
  }
}

/** `start` = the dashboard entry to the same listener: auth if needed, hooks, then the
 * shared header + monitorLoop(). Deliberately asks NOTHING (scripting muscle memory) —
 * the bare command owns the publicity ask (returningRun()). */
/** THE default experience (D8, Marco 2026-07-18: the fold is total). Everything
 * `start` provided lives here now: onboarding (board question -> pairing ceremony ->
 * billing question, all inside the watch's own gates), the hook install (the passive
 * backbone — installed on successful pairing, self-healed for an already-paired
 * interactive run), the live watch, and the deployment card on quit. */
async function runShowcase(initialView?: "watch" | "settings"): Promise<void> {
  if (hasFlag("light")) ui.setTheme("light");
  // Paired + interactive: the backbone must not silently rot — reinstall lost hooks.
  if (process.stdout.isTTY && loadState().deviceToken && !hooksInstalled()) installHooks();
  // D16: launcher commands run IN-APP now — runSuperStart no longer hands a command
  // back (the v1 exit-and-launch is retired), so there is nothing to dispatch here.
  await runSuperStart({
    static: hasFlag("static"),
    limits: hasFlag("limits"),
    // D17 Privacy row: the persisted redact toggle is the default; --redact stays a
    // per-run additive override.
    redact: hasFlag("redact") || loadState().redact === true,
    initialView: initialView ?? (hasFlag("settings") ? "settings" : undefined),
    askOnboarding: askSuperStartOnboarding,
    pairOnboarding: async () => {
      const ok = (await connectDeviceCeremony()).status === "connected";
      // D8: pairing success folds the hook install in — start's old duty, kept.
      if (ok && !hooksInstalled()) installHooks();
      return ok;
    },
    // D14 C1a: org-join fires only after a successful pair (runSuperStart's own gate);
    // billing mode always fires once, after it (extracted out of askSuperStartOnboarding).
    askOrgJoin: askSuperStartOrgJoin,
    askBillingMode: askSuperStartBillingMode,
    // The field bug (root-caused 2026-07-20): a stale npx cache silently ran an old
    // build for days. The showcase gets the SAME passive check every interactive
    // command already pays for (update.ts, throttled + capped + fail-silent).
    checkUpdate: checkForNewerVersion,
  });
}

async function start(): Promise<void> {
  const state = loadState();
  if (!state.deviceToken) {
    if (!process.stdin.isTTY) {
      console.error("  Not signed in — run `npx --yes deploy-forward@latest` in a terminal first.");
      process.exitCode = 1;
      return;
    }
    if (!(await githubOnboard())) {
      process.exitCode = 1;
      return;
    }
  }

  if (!hooksInstalled()) installHooks();
  // D8 (Marco 2026-07-18): `start` is folded into super-start. Interactive runs get
  // the watch; a headless/scripted start KEEPS the plain monitor — a fold must never
  // turn a long-lived tracker into a TUI that exits on a redirected stdout.
  if (process.stdout.isTTY) {
    await runShowcase();
  } else {
    // D19: keeping the plain monitor is deliberate, but it must SAY so.
    console.log(`  ${ui.c.dim(NON_TTY_NOTE)}`);
    await dashboardAndMonitor();
  }
}

/** Dashboard header + live listener shared by `start` and the returning bare run
 * (Marco 2026-07-10): lockup banner + aligned key/value rows + a rule; below the rule
 * lives the ONE rewriting live line. Reads like a product, costs nothing — deliberately
 * not a raw-mode TUI (zero-dep audit-ability wins). */
async function dashboardAndMonitor(opts: { banner?: boolean; publicityLabel?: string } = {}): Promise<void> {
  const initial = loadState();
  if (opts.banner !== false) ui.banner(TRACKER_VERSION);
  const row = (k: string, v: string) => console.log(`  ${ui.c.dim(k.padEnd(9))} ${v}`);
  row("Account", `${ui.c.bold("@" + (initial.handle ?? initial.uid ?? "unknown"))} ${ui.c.dim(`on ${hostname()}`)}`);
  row("Tracking", formatProviderCounts(monitorStats(initial)));
  row("Hooks", `${ui.sym.ok} active — sync on session events; this monitor is optional`);
  if (opts.publicityLabel) row("Publicity", opts.publicityLabel);
  if (initial.org?.enrolled) row("Org", `${initial.org.orgLabel ?? initial.org.orgId} ${ui.c.dim("(sessions attribute to org repos)")}`);
  if (initial.handle) row("Profile", ui.c.accent(`${APP_BASE}/u/${initial.handle}`));
  row("Board", ui.c.accent(`${APP_BASE}/leaderboard`));
  // The field bug (root-caused 2026-07-20): a stale npx cache silently ran an old build
  // for days. This dashboard is what start()'s legacy non-TTY path shows too — the same
  // loud one-liner (update.ts) everywhere, never a quiet row someone can miss.
  const staleBanner = staleVersionBanner({ running: TRACKER_VERSION, latest: await checkForNewerVersion() });
  if (staleBanner) row("Update", ui.c.warn(staleBanner));
  console.log(`  ${ui.c.dim("Ctrl-C closes only this monitor · one-time upload: npx --yes deploy-forward@latest sync")}`);
  ui.rule();

  await monitorLoop();
}

/**
 * L18: detect the current Claude Code billing source (presence-only — see
 * src/billingSource.ts's privacy invariant), print it as one local line, and on a silent
 * subscription -> api_key flip print a LOUD, unmissable warning. Persists the current
 * source as the baseline for the next run's flip check. Reads the REAL home + env in
 * production (the collector is hermetic by injection, so tests never touch either); this
 * is purely local display, never on any ingest payload. Never blocks, never exits
 * non-zero.
 */
function reportBillingSource(prev: TrackerState["lastBillingSource"]): void {
  const collected = collectBillingEnv(homedir(), process.env);
  const current = resolveBillingSource(collected, collected.hasSubscriptionLogin);
  const flip = detectFlip(prev ?? null, current);
  console.log(`  ${ui.c.dim("Billing")}   ${billingSourceLabel(current)} ${ui.c.dim("(Claude Code — detected by presence, never read)")}`);
  if (flip.kind === "to_api_key") {
    ui.blank();
    console.log(`  ${ui.c.warn("!")} ${ui.c.bold("Billing source changed: subscription -> API key.")}`);
    console.log(`    ${ui.c.warn("Claude Code is now billing your ANTHROPIC_API_KEY (metered), not your subscription.")}`);
    console.log(`    ${ui.c.dim("Run /status in Claude Code to confirm; unset ANTHROPIC_API_KEY to revert.")}`);
  }
  // Persist the new baseline only when it actually moved, so the flip is a one-time
  // warning (the next run compares against `current`, not the stale `prev`).
  if (current !== prev) markBillingSource(current);
}

async function status(): Promise<void> {
  const s = loadState();
  const ago = (t: number): string => {
    if (!t) return "never";
    const m = Math.round((Date.now() - t) / 60_000);
    return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
  };
  ui.banner();
  const newer = await checkForNewerVersion();
  console.log(`  ${ui.c.dim("Tracker")}   v${TRACKER_VERSION}${newer ? ` ${ui.c.warn(`— v${newer} available:`)} ${ui.c.dim("npx --yes deploy-forward@latest update")}` : ""}`);
  console.log(`  ${ui.c.dim("API")}       ${s.apiBase}`);
  console.log(`  ${ui.c.dim("Paired")}    ${s.deviceToken ? `${ui.sym.ok} @${s.handle ?? s.uid} ${ui.c.dim(`(this device: ${hostname()})`)}` : `${ui.sym.err} no - run \`npx --yes deploy-forward@latest\``}`);
  console.log(`  ${ui.c.dim("Hooks")}     ${hooksInstalled() ? `${ui.sym.ok} active - syncs automatically on Claude Code session events` : `${ui.sym.err} not installed - run \`npx --yes deploy-forward@latest\``}`);
  // The account has TWO boards, and status mirrors both. Public board membership is the
  // publicity choice (server-held, never inferred from local state); the org workspace is
  // where an enrolled device's work lands regardless of that choice.
  if (s.deviceToken) {
    try {
      const p = await getPublicity();
      const label = !p.decided
        ? `not chosen yet ${ui.c.dim("- npx --yes deploy-forward@latest public (or private)")}`
        : p.public
          ? `${ui.sym.ok} public - on the board ${ui.c.dim("- npx --yes deploy-forward@latest private to leave")}`
          : `private ${ui.c.dim("- npx --yes deploy-forward@latest public to opt in")}`;
      console.log(`  ${ui.c.dim("Publicity")} ${label}`);
    } catch {
      // Offline or the API is unreachable: the health check still renders. Say
      // "unavailable" rather than guessing a state we could not read.
      console.log(`  ${ui.c.dim("Publicity")} ${ui.c.dim("unavailable (offline?)")}`);
    }
  }
  // Org enrollment (P1.1): shown ONLY when the cached /device/context answer says enrolled.
  if (s.org?.enrolled) {
    console.log(`  ${ui.c.dim("Org")}       ${s.org.orgLabel ?? s.org.orgId ?? "enrolled"} ${ui.c.dim("(sessions attribute to org repos)")}`);
    console.log(`  ${ui.c.dim("Workspace")} ${APP_BASE}/org`);
  } else {
    // D14 C10: `df status` lists ALL pending join requests, one line each (spec's D7
    // fix — a device can have up to 3 at once, never just the singular the old copy
    // implied).
    for (const p of s.org?.pendingRequests ?? []) {
      const days = Math.max(0, Math.ceil((p.expiresAt - Date.now()) / 86_400_000));
      console.log(`  ${ui.c.dim("Org")}       request pending - ${p.orgLabel} (expires ${days}d) ${ui.c.dim(`- cancel: npx --yes deploy-forward@latest org request --cancel ${p.slug}`)}`);
    }
  }
  console.log(`  ${ui.c.dim("Last sync")} ${ago(s.lastSyncAt)}`);
  console.log(`  ${ui.c.dim("Tracked")}   ${formatProviderCounts(monitorStats(s))}`);
  // L18: local billing-source line + silent-flip warning (presence-only detection).
  reportBillingSource(s.lastBillingSource);
  // W1.5 per-provider drift health: one line per provider, ONLY when the most recent
  // scan tripped the threshold (a healthy provider earns silence, not a green badge —
  // an always-on "ok" row would train eyes to skip the one time it matters).
  for (const p of driftedProviders(s)) {
    console.log(`  ${ui.c.warn("Drift")}     ${ui.c.dim(`${p.display}: transcripts changed shape — update the tracker: npx --yes deploy-forward@latest update`)}`);
  }
  // W3 soft-skip (providers.ts item 2): a SQLite-backed tool's data was FOUND on disk
  // but this Node's node:sqlite support is missing/too old to read it — a distinct,
  // actionable state from "not installed" (which stays silent). Never printed for a
  // tool that simply isn't present.
  for (const p of PROVIDERS) {
    if (s.softSkip?.[p.id]) {
      console.log(`  ${ui.c.dim(`${p.display}: sessions found — needs Node 22.5+ to read them`)}`);
    }
  }
  if (s.handle) console.log(`  ${ui.c.dim("Profile")}   ${APP_BASE}/u/${s.handle}`);
  console.log(`  ${ui.c.dim("Board")}     ${APP_BASE}/leaderboard`);
  ui.blank();
}

function printHelp(): void {
  console.log(
    [
      `deploy-forward v${TRACKER_VERSION} - Deploy Forward tracker`,
      "",
      "  npx --yes deploy-forward@latest",
      "      first run: create or link your account; after: dashboard + live monitor",
      "  npx --yes deploy-forward@latest pair",
      "      pair a second machine to this same user",
      "  npx --yes deploy-forward@latest start",
      "      the live monitor, no questions asked (hooks already sync)",
      "  npx --yes deploy-forward@latest super-start",
      "      full-screen animated showcase of this machine's usage",
      "      --light   brand colors for a light-background terminal ($DF_THEME=light)",
      "      --static  plain settled text, no takeover",
      "  npx --yes deploy-forward@latest sync",
      "      sync once and exit",
      "  npx --yes deploy-forward@latest settings",
      "      in-app settings (board, billing, limits, privacy)",
      "  npx --yes deploy-forward@latest board",
      "      open your board in the browser",
      "  npx --yes deploy-forward@latest status",
      "      auth, hooks, last sync - the health check",
      "  npx --yes deploy-forward@latest usage",
      "      local per-model usage + session windows (no account needed)",
      "  npx --yes deploy-forward@latest usage --by-project",
      "      per-project token attribution",
      "  npx --yes deploy-forward@latest usage --by-day",
      "      per-day totals, last 30 days",
      "  npx --yes deploy-forward@latest usage --json",
      "      any usage view as a JSON array",
      "  npx --yes deploy-forward@latest usage --cost",
      "      adds an EST COST column (public list prices only)",
      "  npx --yes deploy-forward@latest pricing set <model>",
      "      --input <usd> --output <usd>: price a model usage --cost can't",
      "      (LOCAL only, never uploaded)",
      "  npx --yes deploy-forward@latest pricing list",
      "      list your local model rates",
      "  npx --yes deploy-forward@latest pricing unset <model>",
      "      remove a local model rate",
      "  npx --yes deploy-forward@latest config share-unknown-models on|off",
      "      opt in/out of sharing unpriced model IDs (default off)",
      "  npx --yes deploy-forward@latest org list",
      "      list every organization membership",
      "  npx --yes deploy-forward@latest org status",
      "      attribution freshness without device details",
      "  npx --yes deploy-forward@latest org join <code>",
      "      redeem an org invite code",
      "  npx --yes deploy-forward@latest org request <slug-or-url>",
      "      ask to join an org by its workspace URL",
      "      --message <text>  optional note to the admins (280 chars)",
      "  npx --yes deploy-forward@latest org request --cancel [slug]",
      "      cancel a pending join request",
      "  npx --yes deploy-forward@latest org leave",
      "      leave your organization",
      "      --yes  confirm non-interactively",
      "  npx --yes deploy-forward@latest link",
      "      share one local repository with an org project",
      "      --org <id> --project <id> --repo <owner/name>  non-interactive selection",
      "  npx --yes deploy-forward@latest links",
      "      list active repository grants",
      "  npx --yes deploy-forward@latest backfill [--grant <id>]",
      "      preview, then confirm, attaching stored history (permanent)",
      "  npx --yes deploy-forward@latest unlink [--grant <id>]",
      "      stop future attribution (already-shared history stays on the org's ledger)",
      "  npx --yes deploy-forward@latest public",
      "      publish your profile on the public board",
      "  npx --yes deploy-forward@latest private",
      "      remove your profile from the public board",
      "  npx --yes deploy-forward@latest update",
      "      update to the latest published version",
      "  npx --yes deploy-forward@latest version",
      "      print the tracker version",
      "  npx --yes deploy-forward@latest logout",
      "      sign this device out (removes the device token)",
      "  npx --yes deploy-forward@latest restore",
      "      cancel a pending account deletion (30-day grace period)",
      "  npx --yes deploy-forward@latest uninstall",
      "      remove the Claude Code hooks",
      "",
      "  No prior npm install needed - npx fetches and runs the latest version.",
      "  Tracks usage metadata only - never your code or prompts.",
    ].join("\n"),
  );
}

/**
 * `df pricing set|list|unset` (L17) — bring-your-own per-model rates, USD per MTok. LOCAL
 * ONLY: rates live in this machine's state and NEVER reach the wire (the ingest payload
 * carries tokens/models exactly as always, never a rate or a user-rate-derived spend). They
 * only let `usage --cost` price a model the bundled table doesn't know; a canonical rate
 * always wins over a user rate for a known id.
 */
function runPricing(): void {
  const sub = process.argv[3] ?? "list";
  if (sub === "list") {
    const rates = listUserRates();
    const ids = Object.keys(rates).sort();
    if (ids.length === 0) {
      console.log(`  ${ui.c.dim("No local model rates set. Add one: df pricing set <model> --input <usd> --output <usd>")}`);
      return;
    }
    console.log(`  ${ui.c.bold("Local model rates")} ${ui.c.dim("(USD per MTok - LOCAL only, never uploaded)")}`);
    for (const id of ids) {
      const r = rates[id];
      const extra = [
        r.cacheRead !== undefined ? `cache-read ${r.cacheRead}` : null,
        r.cacheWrite !== undefined ? `cache-write ${r.cacheWrite}` : null,
        r.source ? `src ${r.source}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      console.log(`    ${id}  input ${r.input}  output ${r.output}${extra ? "  " + ui.c.dim(extra) : ""}`);
    }
    return;
  }
  if (sub === "set") {
    const id = process.argv[4];
    if (!id || id.startsWith("--")) {
      console.error("  Usage: df pricing set <model> --input <usd> --output <usd> [--cache-read <usd>] [--cache-write <usd>] [--source <url>]");
      process.exitCode = 1;
      return;
    }
    const rate: UserRate = { input: Number(flag("input")), output: Number(flag("output")) };
    const cacheRead = flag("cache-read");
    const cacheWrite = flag("cache-write");
    const source = flag("source");
    if (cacheRead !== undefined) rate.cacheRead = Number(cacheRead);
    if (cacheWrite !== undefined) rate.cacheWrite = Number(cacheWrite);
    if (source !== undefined) rate.source = source;
    try {
      setUserRate(id, rate);
    } catch (e) {
      console.error(`  ${ui.c.dim("x")} ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ${ui.sym.ok} Set local rate for ${id}: input $${rate.input}/MTok, output $${rate.output}/MTok. LOCAL only - never uploaded.`);
    return;
  }
  if (sub === "unset") {
    const id = process.argv[4];
    if (!id || id.startsWith("--")) {
      console.error("  Usage: df pricing unset <model>");
      process.exitCode = 1;
      return;
    }
    console.log(unsetUserRate(id) ? `  ${ui.sym.ok} Removed local rate for ${id}.` : `  ${ui.c.dim(`No local rate for ${id}.`)}`);
    return;
  }
  console.error("  Supported pricing commands: df pricing list, df pricing set <model> --input <usd> --output <usd>, df pricing unset <model>");
  process.exitCode = 1;
}

/**
 * `df config share-unknown-models on|off` (L17) — the ONLY config toggle here (default OFF).
 * When ON, a sync may attach occurrence tallies of model IDS the bundled table can't price so
 * the project can learn what to price next - never rates, spend, code, or prompts.
 */
function runConfig(): void {
  const key = process.argv[3];
  if (key === "share-unknown-models") {
    const val = process.argv[4];
    if (val !== "on" && val !== "off") {
      console.log(`  share-unknown-models is ${loadState().shareUnknownModels ? "on" : "off"}`);
      console.log(`  ${ui.c.dim("Usage: df config share-unknown-models on|off")}`);
      return;
    }
    const state = loadState();
    state.shareUnknownModels = val === "on";
    saveState(state);
    console.log(`  ${ui.sym.ok} share-unknown-models is now ${val}.`);
    if (val === "on") console.log(`    ${ui.c.dim("Only unpriced model IDs + occurrence counts are shared - never rates, spend, code, or prompts.")}`);
    return;
  }
  console.error("  Supported config commands: df config share-unknown-models on|off");
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "pair":
      await pair();
      break;
    case "login":
      // Compatibility alias (0.7.x muscle memory, with or without --github): auth-first
      // means login IS the bare happy path — auth, scan, hooks, profile URL. Typed-code
      // pairing lives under `pair`.
      await setup();
      break;
    case "logout":
      await logout();
      break;
    case "restore":
      await restore();
      break;
    case "start":
      await start();
      break;
    case "super-start": {
      await runShowcase();
      break;
    }
    case "settings":
      // D17: the in-app settings page, reachable directly. Non-TTY has no page to draw.
      if (process.stdout.isTTY && process.stdin.isTTY) await runShowcase("settings");
      else console.log(`  ${NON_TTY_NOTE}`);
      break;
    case "board": {
      // D16's external action as a real command: open the board, print the URL either way.
      const url = `${APP_BASE}/leaderboard`;
      if (process.stdout.isTTY) openInBrowser(url);
      console.log(`  ${url}`);
      break;
    }
    case "sync":
      await syncOnce({ verbose: true }).catch((e) => {
        const msg = (e as Error).message;
        if (msg === "account_deleted") {
          // A deliberate, reversible soft-delete is a CLEAN stop — special-cased FIRST so
          // it never falls into the ternary below and never sets exitCode 1 (unlike
          // token_revoked, which keeps its exit 1).
          const restoreBy = (e as Error & { restoreBy?: number }).restoreBy;
          console.error("  " + formatAccountDeletedMessage(restoreBy, Date.now()));
          return;
        }
        console.error(
          msg === "not_paired"
            ? "  x Not signed in yet - run `npx --yes deploy-forward@latest` first (one time)."
            : msg === "token_revoked"
              ? "  x This device's token was revoked - run `npx --yes deploy-forward@latest` to re-authenticate. Nothing is lost: transcripts re-sync in full."
              : `  x ${msg}`,
        );
        process.exitCode = 1;
      });
      break;
    case "beat":
      await beat(flag("event") ?? "beat");
      break;
    case "status":
      await status();
      break;
    case "usage":
      printUsage(usageOptions());
      break;
    case "pricing":
      runPricing();
      break;
    case "config":
      runConfig();
      break;
    case "org": {
      const orgSub = process.argv[3] ?? "list";
      if (orgSub === "status") await showAttributionStatus();
      else if (orgSub === "list") await listOrganizations();
      else if (orgSub === "join") {
        const code = process.argv[4];
        if (!code) {
          console.error("  Usage: npx --yes deploy-forward@latest org join <code>");
          process.exitCode = 1;
          break;
        }
        await runOrgJoinByCode(code);
      } else if (orgSub === "request") {
        if (hasFlag("cancel")) await runOrgRequestCancel(orgRequestPositionalArg());
        else {
          const slug = orgRequestPositionalArg();
          if (!slug) {
            console.error("  Usage: npx --yes deploy-forward@latest org request <slug-or-url>");
            process.exitCode = 1;
            break;
          }
          await runOrgRequestBySlug(slug, flag("message"));
        }
      } else if (orgSub === "leave") {
        await runOrgLeave();
      } else {
        throw new Error(
          "Supported organization commands: org list, org status, org join <code>, org request <slug-or-url>, org request --cancel [slug], org leave",
        );
      }
      break;
    }
    case "link":
      await linkRepository({ orgId: flag("org"), projectId: flag("project"), slug: flag("repo") });
      break;
    case "links":
      await listLinks();
      break;
    case "backfill":
      await backfillRepository(flag("grant"));
      break;
    case "unlink":
      await unlinkRepository(flag("grant"));
      break;
    case "public":
    case "private": {
      const visible = cmd === "public";
      const result = await setPublicity(visible);
      console.log(`  ${ui.sym.ok} Public board profile is now ${result.public ? "on" : "off"}.`);
      console.log(`    This only changes the public board. Your organization, if you join one, still sees your work.`);
      // Close the loop: the person who just flipped their visibility gets the URL
      // where the flip is observable, not just an assertion that it happened.
      const s = loadState();
      if (result.public) {
        console.log(`    See it: ${APP_BASE}/leaderboard${s.handle ? ` - your page: ${APP_BASE}/u/${s.handle}` : ""}`);
      } else if (s.handle) {
        console.log(`    Your page stays yours (signed-in view): ${APP_BASE}/u/${s.handle}`);
      }
      break;
    }
    case "update":
    case "--update":
      await update();
      break;
    case "uninstall":
      uninstallHooks();
      break;
    case "help":
    case "--help":
    case "-help": // single-hyphen tolerance: npm passes it through with a warning
    case "-h":
      printHelp();
      break;
    case "version":
    case "--version":
    case "-version":
    case "-v":
      console.log(`deploy-forward v${TRACKER_VERSION}`);
      break;
    default:
      // A typo'd subcommand or unknown flag must NEVER fall through to the full
      // onboarding ceremony (auth prompts from a mistyped `-hlep` reads as hostile).
      // Only the BARE command earns the ceremony; anything else gets help + exit 1.
      if (cmd !== undefined) {
        console.error(`  x Unknown command or flag: ${cmd}\n`);
        printHelp();
        process.exitCode = 1;
        break;
      }
      await setup();
  }
}

main().catch((e) => {
  console.error(`\n  x ${(e as Error).message}\n`);
  process.exitCode = 1;
});
