/**
 * `deploy-forward update` (alias `--update`) — self-update to the latest published version.
 *
 * Zero-dep by invariant: the registry check uses Node's built-in fetch, the install is a
 * spawned `npm install -g deploy-forward@latest` with inherited stdio so the user watches
 * npm's own output (including any permission errors) verbatim — this command never
 * paraphrases npm's result into a claim it didn't verify.
 */
import { spawnSync } from "node:child_process";
import { TRACKER_VERSION } from "./sync.js";
import { loadState, saveState } from "./config.js";
import * as ui from "./ui.js";

export const REGISTRY_LATEST_URL = "https://registry.npmjs.org/deploy-forward/latest";

/** Parse "x.y.z" (ignoring any -prerelease suffix) into a comparable triple; null if not semver. */
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 | 0 | 1 for a<b | a==b | a>b. Unparseable versions compare equal (never a false "update!"). */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** The `version` field of the registry's /latest doc, or null on any network/shape failure. */
export function versionFromRegistryDoc(doc: unknown): string | null {
  if (!doc || typeof doc !== "object") return null;
  const v = (doc as Record<string, unknown>).version;
  return typeof v === "string" && parseSemver(v) !== null ? v : null;
}

async function fetchLatestVersion(timeoutMs?: number): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_LATEST_URL, {
      headers: { accept: "application/json" },
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    if (!res.ok) return null;
    return versionFromRegistryDoc(await res.json());
  } catch {
    return null;
  }
}

/** Passive-nudge throttle: one registry question per day, success or failure alike. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Hard cap on how long a passive check may stall an interactive command. */
const PASSIVE_CHECK_TIMEOUT_MS = 1500;

/**
 * Pure decision: given the running version and the registry's answer (possibly cached,
 * possibly null), the version to nudge about — or null. Unparseable/absent answers and
 * ahead-of-registry dev builds nudge nothing.
 */
export function newerVersionFrom(current: string, latest: string | null): string | null {
  return latest && compareSemver(current, latest) < 0 ? latest : null;
}

/**
 * The field bug (root-caused 2026-07-20): a user's npx cache served a STALE 0.22.2 while
 * the registry had 0.22.3, so working code never ran and they saw an old estimate-only
 * render for days — quietly. A stale version must never be silent again.
 *
 * Pure composer: given the running version and the registry's latest (possibly null —
 * unreachable/unparseable), returns a LOUD one-line banner naming both versions and the
 * exact remedy, or "" when there is nothing to say. Never nags on uncertainty: an unknown
 * latest, or running already at/ahead of latest, both compose empty.
 */
export function staleVersionBanner({ running, latest }: { running: string; latest: string | null }): string {
  if (!latest || compareSemver(running, latest) >= 0) return "";
  return `deploy-forward v${running} is behind v${latest} - run: npx --yes deploy-forward@latest`;
}

/**
 * The passive "you're on an older deploy-forward" check (Marco 2026-07-10): called by
 * INTERACTIVE commands only (bare run, start, status) — hooks/beat/sync never pay for
 * it. Throttled through state.updateCheck to one registry request per day (failures
 * throttle too), capped at 1.5s, and fail-SILENT: a dead network can never break or
 * meaningfully delay onboarding. Returns the newer version string, or null.
 */
export async function checkForNewerVersion(now: number = Date.now()): Promise<string | null> {
  const state = loadState();
  const cached = state.updateCheck;
  if (cached && now - cached.at < UPDATE_CHECK_INTERVAL_MS) {
    return newerVersionFrom(TRACKER_VERSION, cached.latest);
  }
  const latest = await fetchLatestVersion(PASSIVE_CHECK_TIMEOUT_MS);
  // Re-load before save: a concurrent hook sync may have advanced cursors/digests while
  // we awaited the registry — losing THOSE is real damage; losing this stamp is one
  // extra registry hit tomorrow.
  saveState({ ...loadState(), updateCheck: { at: now, latest } });
  return newerVersionFrom(TRACKER_VERSION, latest);
}

export async function update(): Promise<void> {
  ui.banner();
  console.log(`  ${ui.c.dim("Installed")} v${TRACKER_VERSION}`);

  const latest = await fetchLatestVersion();
  if (!latest) {
    console.log(`  ${ui.sym.err} Could not reach the npm registry to check the latest version.`);
    console.log(`    Update manually: npm install -g deploy-forward@latest`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ${ui.c.dim("Latest")}    v${latest}`);

  const cmp = compareSemver(TRACKER_VERSION, latest);
  if (cmp > 0) {
    // Installed AHEAD of the registry's /latest: either a fresh publish is still
    // propagating through npm's CDN (minutes), or this is a local dev build. Say
    // that, not "up to date" -- the registry doc we just read was the stale one.
    console.log(`  ${ui.sym.ok} Installed version is ahead of the registry (a fresh publish may still be propagating).`);
    return;
  }
  if (cmp === 0) {
    console.log(`  ${ui.sym.ok} Already up to date.`);
    return;
  }

  console.log("");
  console.log(`  Updating via npm install -g deploy-forward@latest ...`);
  console.log("");
  // shell:true on Windows so npm.cmd resolves; stdio inherited so npm's real output (and any
  // EACCES/permission failure) is what the user sees — we only relay its exit code.
  const r = spawnSync("npm", ["install", "-g", "deploy-forward@latest"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  console.log("");
  if (r.status === 0) {
    console.log(`  ${ui.sym.ok} Updated to v${latest}. A running \`deploy-forward start\` monitor keeps its old`);
    console.log(`    version until restarted; \`npx --yes deploy-forward@latest\` always runs the newest without installing.`);
  } else {
    console.log(`  ${ui.sym.err} npm exited with ${r.status ?? "an error"} — see its output above.`);
    console.log(`    Fallback that never needs a global install: npx --yes deploy-forward@latest`);
    process.exitCode = 1;
  }
}
