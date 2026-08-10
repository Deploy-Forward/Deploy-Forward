/**
 * Candidate-outcome capture (per-session outcome ledger v1). THE vendor-neutral seam, mirroring
 * sessionMue (contextEfficiency.ts): one call returns the commit SHAs the local git user AUTHORED
 * within a session's [startedAt, endedAt] window in `cwd`, as metadata-only IngestOutcome[] — or
 * `undefined`, so a scanner assigns it straight to the optional SessionSummary.outcomes field
 * (dropped-when-undefined, exactly like mue/skills/agents/days).
 *
 * Metadata ONLY: commit SHAs + the non-invertible repoHash + timestamps. NEVER diff, code, or prompt
 * text. NEVER throws (fail-closed, like repoSlugForCwd). `git log --since/--until` over a FIXED window
 * is deterministic even when scanned days later, so it does not churn the upload digest.
 */
import { spawnSync } from "node:child_process";
import type { IngestOutcome } from "./types";

/** A git runner: the args after "git"; returns stdout on success, or null on ANY failure. Injected in tests. */
export type GitRunner = (args: string[]) => string | null;

const SHA_RE = /^[0-9a-f]{40}$/;
/** Bound the payload — a session almost never authors more than this many commits. */
const MAX_CANDIDATES = 200;

const realGit: GitRunner = (args) => {
  try {
    const r = spawnSync("git", args, { encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 1 << 20 });
    return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
  } catch {
    return null; // spawnSync reports failures in-result, but never let a throw escape
  }
};

/** cwd -> author email (one `git config` spawn per distinct cwd per run), or null. */
const emailCache = new Map<string, string | null>();
function authorEmail(cwd: string, run: GitRunner, cache: Map<string, string | null>): string | null {
  const hit = cache.get(cwd);
  if (hit !== undefined) return hit;
  const out = run(["-C", cwd, "config", "--get", "user.email"]);
  const email = out && out.trim() ? out.trim() : null;
  cache.set(cwd, email);
  return email;
}

export function candidateOutcomes(
  summary: { cwd?: string; startedAt: number; endedAt: number; repoHash: string | null },
  run: GitRunner = realGit,
  cache: Map<string, string | null> = emailCache,
): IngestOutcome[] | undefined {
  const { cwd, startedAt, endedAt, repoHash } = summary;
  if (!cwd) return undefined; // never spawn git without a real checkout
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return undefined;

  const args = [
    "-C", cwd, "log", "--no-merges", "--format=%H",
    `--since=${new Date(startedAt).toISOString()}`,
    `--until=${new Date(endedAt).toISOString()}`,
  ];
  const email = authorEmail(cwd, run, cache);
  // --fixed-strings so an email's regex-special chars (+ . ) are matched literally by --author.
  if (email) args.push("--fixed-strings", `--author=${email}`);

  const out = run(args);
  if (out === null) return undefined;

  const seen = new Set<string>();
  const outcomes: IngestOutcome[] = [];
  for (const line of out.split("\n")) {
    const sha = line.trim().toLowerCase();
    if (!SHA_RE.test(sha) || seen.has(sha)) continue;
    seen.add(sha);
    outcomes.push({ type: "commit", sha, repoHash: repoHash ?? null, observedAt: endedAt });
    if (outcomes.length >= MAX_CANDIDATES) break;
  }
  return outcomes.length ? outcomes : undefined;
}
