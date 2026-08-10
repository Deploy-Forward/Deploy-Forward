/** User-level repository grants. Local cwd is resolved here and never sent. */
import { createInterface } from "node:readline/promises";
import { loadState, localRepoId, saveState, type AttributionContext, type TrackerState } from "./config.js";
import { isOfficialGrokCli, summarizeGrokCorpus } from "./grok.js";
import { repoSlugForCwd } from "./orgContext.js";
import { findSources, summarizeClaudeCorpus, summarizeFile } from "./sync.js";
import type { SessionSummary } from "./types.js";
import * as ui from "./ui.js";

export interface RepoCandidate {
  slug: string;
  sessions: number;
  tokens: number;
  repoHashes: string[];
  localRepoIds: string[];
}

const total = (s: SessionSummary): number => s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheCreation;

export function foldRepoCandidates(summaries: SessionSummary[], state: Pick<TrackerState, "repoHmacKey">): RepoCandidate[] {
  const map = new Map<string, RepoCandidate>();
  for (const summary of summaries) {
    const slug = repoSlugForCwd(summary.cwd);
    if (!slug) continue;
    const row = map.get(slug) ?? { slug, sessions: 0, tokens: 0, repoHashes: [], localRepoIds: [] };
    row.sessions += 1;
    row.tokens += total(summary);
    if (summary.repoHash && !row.repoHashes.includes(summary.repoHash)) row.repoHashes.push(summary.repoHash);
    const local = localRepoId(state.repoHmacKey, summary.cwd, slug);
    if (local && !row.localRepoIds.includes(local)) row.localRepoIds.push(local);
    map.set(slug, row);
  }
  return [...map.values()].sort((a, b) => b.tokens - a.tokens || a.slug.localeCompare(b.slug));
}

export function discoverRepoCandidates(state: TrackerState = loadState()): RepoCandidate[] {
  const sources = findSources();
  const summaries: SessionSummary[] = [];
  const claude = sources.filter((s) => s.tool === "claude_code").map((s) => ({ path: s.path, subagents: s.subagents }));
  if (claude.length) summaries.push(...summarizeClaudeCorpus(claude, structuredClone(state)));
  for (const source of sources) {
    if (source.tool !== "codex") continue;
    const summary = summarizeFile(source.path, structuredClone(state), "codex", []);
    if (summary) summaries.push(summary);
  }
  if (isOfficialGrokCli()) {
    try {
      summaries.push(...summarizeGrokCorpus(structuredClone(state)));
    } catch {
      // Local discovery is best-effort; one provider never hides the others.
    }
  }
  return foldRepoCandidates(summaries, state);
}

async function context(state: TrackerState): Promise<AttributionContext> {
  if (!state.deviceToken) throw new Error("not_paired");
  const r = await fetch(`${state.apiBase}/attribution/context`, {
    headers: { authorization: `Bearer ${state.deviceToken}` },
  });
  if (r.status === 401) throw new Error("token_revoked");
  if (!r.ok) throw new Error(`attribution context -> ${r.status}`);
  return (await r.json()) as AttributionContext;
}

async function choose<T>(label: string, rows: T[], render: (row: T) => string): Promise<T> {
  if (rows.length === 0) throw new Error(`No ${label.toLowerCase()} available.`);
  if (rows.length === 1) return rows[0];
  if (!process.stdin.isTTY) throw new Error(`Choose ${label.toLowerCase()} with command flags in a non-interactive terminal.`);
  console.log(`  ${ui.c.bold(label)}`);
  rows.forEach((row, i) => console.log(`    ${ui.c.accent(`[${i + 1}]`)} ${render(row)}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = Number((await rl.question(`    Select 1-${rows.length}: `)).trim());
    if (!Number.isInteger(answer) || answer < 1 || answer > rows.length) throw new Error(`Invalid ${label.toLowerCase()} selection.`);
    return rows[answer - 1];
  } finally {
    rl.close();
  }
}

function byIdOrChoose<T>(rows: T[], id: string | undefined, getId: (row: T) => string): T[] {
  if (!id) return rows;
  const found = rows.filter((row) => getId(row) === id);
  if (!found.length) throw new Error(`Unknown selection: ${id}`);
  return found;
}

export async function listOrganizations(): Promise<void> {
  const state = loadState();
  const ctx = await context(state);
  ui.banner();
  console.log(`  ${ui.c.bold("Organizations")}`);
  if (!ctx.organizations.length) {
    ui.todo("No organization memberships yet.");
  } else {
    for (const org of ctx.organizations) {
      const linked = ctx.grants.filter((g) => g.orgId === org.orgId).length;
      console.log(`  ${ui.c.accent(org.orgId)}  ${org.label} ${ui.c.dim(`· ${org.role} · ${linked} linked repo(s)`)}`);
    }
  }
  ui.blank();
}

export async function showAttributionStatus(): Promise<void> {
  const state = loadState();
  if (!state.deviceToken) throw new Error("Run `npx --yes deploy-forward@latest` first.");
  const r = await fetch(`${state.apiBase}/attribution/status`, {
    headers: { authorization: `Bearer ${state.deviceToken}` },
  });
  const body = (await r.json().catch(() => ({}))) as {
    organizations?: Array<{
      orgId: string; label: string; role: string; activeGrants: number;
      windows: Record<string, { updatedAt: number | null; sessions: number; members: number; truncated: string[] }>;
    }>;
    error?: string;
  };
  if (!r.ok) throw new Error(body.error ?? `attribution status -> ${r.status}`);
  ui.banner();
  console.log(`  ${ui.c.bold("Organization attribution status")}`);
  for (const org of body.organizations ?? []) {
    console.log(`  ${ui.c.accent(org.label)} ${ui.c.dim(`(${org.role})`)} - ${org.activeGrants} active grant(s)`);
    for (const id of ["d7", "d30"]) {
      const w = org.windows[id];
      if (!w) continue;
      console.log(`    ${id === "d7" ? "7D " : "30D"}  ${w.sessions} session(s) - ${w.members} builder(s) - ${w.updatedAt ? "rollup present" : "not computed"}${w.truncated.length ? " - truncated: " + w.truncated.join(", ") : ""}`);
    }
  }
  if (!(body.organizations ?? []).length) ui.todo("No organization memberships yet.");
  ui.blank();
}

export async function listLinks(): Promise<void> {
  const ctx = await context(loadState());
  ui.banner();
  console.log(`  ${ui.c.bold("Repository links")}`);
  if (!ctx.grants.length) ui.todo("No repositories shared with an organization.");
  for (const grant of ctx.grants) {
    console.log(`  ${ui.c.accent(grant.slug)}  → ${grant.orgLabel} / ${grant.projectName} ${ui.c.dim(`(${grant.trust}, ${grant.grantId})`)}`);
  }
  if (ctx.grants.length) {
    ui.hint("Each link shares that repo's tokens, models, and activity with its org/project above — never code or prompts.");
    ui.hint("npx --yes deploy-forward@latest unlink --grant <id>  stops future sharing; history already shared stays on that org's ledger.");
  }
  ui.blank();
}

export interface LinkOptions { orgId?: string; projectId?: string; slug?: string }

/**
 * Cross-org disclosure (organization-buildout.md §6.4, LOCKED): when a repo is already
 * granted to a DIFFERENT organization, adding another must name every org that will see
 * it — never a silent addition. Pure + exported so the exact wording is unit-tested.
 * Grants to the SAME org/slug (e.g. re-linking after an unlink) are not "another org" and
 * return no disclosure lines here; linkRepository prints its own one-line note for that case.
 */
export function crossOrgDisclosure(
  targetOrgId: string,
  targetOrgLabel: string,
  existingGrantsForSlug: Array<{ orgId: string; orgLabel: string }>,
): { alreadyWith: string[]; adding: string } | null {
  const others = [...new Set(existingGrantsForSlug.filter((g) => g.orgId !== targetOrgId).map((g) => g.orgLabel))];
  return others.length ? { alreadyWith: others, adding: targetOrgLabel } : null;
}

export async function linkRepository(opts: LinkOptions): Promise<void> {
  const state = loadState();
  if (!state.deviceToken) throw new Error("Run `npx --yes deploy-forward@latest` first.");
  const [ctx, candidates] = await Promise.all([context(state), Promise.resolve(discoverRepoCandidates(state))]);
  const org = await choose("Organization", byIdOrChoose(ctx.organizations, opts.orgId, (o) => o.orgId), (o) => `${o.label} (${o.role})`);
  const project = await choose("Project", byIdOrChoose(org.projects, opts.projectId, (p) => p.projectId), (p) => p.name);
  const requestedSlug = opts.slug?.toLowerCase();
  const candidateRows = requestedSlug
    ? candidates.filter((c) => c.slug === requestedSlug)
    : candidates;
  const candidate = await choose("Repository", candidateRows, (r) => `${r.slug} ${ui.c.dim(`· ${r.sessions} session(s)`)}`);

  const already = ctx.grants.filter((g) => g.slug === candidate.slug);
  const disclosure = crossOrgDisclosure(org.orgId, org.label, already);
  if (disclosure) {
    console.log(`  ${ui.c.warn("deploy-forward is already shared with:")}`);
    for (const label of disclosure.alreadyWith) console.log(`    ${label}`);
    console.log(`  ${ui.c.warn("Adding:")}`);
    console.log(`    ${disclosure.adding}`);
    console.log(`  ${ui.c.dim("Both organizations will independently see your attributed usage for this repository.")}`);
  } else if (already.some((g) => g.orgId === org.orgId)) {
    console.log(`  ${ui.c.warn(`Already shared with ${org.label} — this creates a new grant period.`)}`);
  }
  console.log(`  Share ${ui.c.bold(candidate.slug)} with ${ui.c.bold(org.label)} / ${ui.c.bold(project.name)}.`);
  console.log(`  ${ui.c.dim("Shares this repo's tokens, models, and activity — never code, prompts, or file contents.")}`);
  console.log(`  ${ui.c.dim("Future sessions only. Historical backfill is separate, previewed, and confirm-gated. Unlinking later stops future sharing but keeps already-shared history on the org's ledger.")}`);
  if (!(await ui.confirm("Create this repository grant?", false))) {
    ui.todo("Canceled. Nothing changed.");
    return;
  }

  const r = await fetch(`${state.apiBase}/attribution/grants`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${state.deviceToken}` },
    body: JSON.stringify({
      orgId: org.orgId,
      projectId: project.projectId,
      slug: candidate.slug,
      repoHashes: candidate.repoHashes,
      localRepoIds: candidate.localRepoIds,
    }),
  });
  const body = (await r.json().catch(() => ({}))) as { grantId?: string; canonicalRepoId?: string; error?: string };
  if (!r.ok) throw new Error(body.error ?? `create grant -> ${r.status}`);
  if (state.org) state.org.checkedAt = 0; // next sync refreshes the grant fingerprint
  saveState(state);
  ui.done(`Linked ${candidate.slug} to ${org.label} / ${project.name}`);
  ui.hint(`Grant ${body.grantId} · canonical ${body.canonicalRepoId}`);
}

export async function backfillRepository(grantId?: string): Promise<void> {
  const state = loadState();
  const ctx = await context(state);
  const grant = await choose(
    "Repository link",
    byIdOrChoose(ctx.grants, grantId, (g) => g.grantId),
    (g) => `${g.slug} -> ${g.orgLabel} / ${g.projectName}`,
  );
  console.log(`  Preview existing stored sessions for ${ui.c.bold(grant.slug)} in ${ui.c.bold(grant.orgLabel)}.`);
  if (!(await ui.confirm("Generate the backfill preview?", false))) {
    ui.todo("Canceled. Nothing changed.");
    return;
  }
  const previewResponse = await fetch(`${state.apiBase}/attribution/grants/backfill/preview`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${state.deviceToken}` },
    body: JSON.stringify({ grantId: grant.grantId }),
  });
  const preview = (await previewResponse.json().catch(() => ({}))) as {
    matchedSessions?: number; matchedTokens?: number; repoHashesRecognized?: number;
    ambiguousMappings?: number; unrecoverableSessions?: number | null;
    confirmationToken?: string; error?: string;
  };
  if (!previewResponse.ok || !preview.confirmationToken) {
    throw new Error(preview.error ?? `backfill preview -> ${previewResponse.status}`);
  }
  console.log(`  Sessions     ${preview.matchedSessions ?? 0}`);
  console.log(`  Tokens       ${(preview.matchedTokens ?? 0).toLocaleString()}`);
  console.log(`  Repo hashes  ${preview.repoHashesRecognized ?? 0}`);
  console.log(`  Ambiguous    ${preview.ambiguousMappings ?? 0}`);
  console.log(`  Unrecoverable ${preview.unrecoverableSessions == null ? "unknown (server cannot infer null-repo history)" : preview.unrecoverableSessions}`);
  console.log(`  ${ui.c.dim("This permanently adds matched history to the organization's ledger. Unlinking later only stops future sharing.")}`);
  console.log(`  ${ui.c.dim("Safe to re-run: attributing the same sessions again never double-counts them.")}`);
  if (!(await ui.confirm("Permanently attribute this historical usage?", false))) {
    ui.todo("Canceled after preview. Nothing changed.");
    return;
  }
  const r = await fetch(`${state.apiBase}/attribution/grants/backfill`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${state.deviceToken}` },
    body: JSON.stringify({ grantId: grant.grantId, confirmationToken: preview.confirmationToken }),
  });
  const body = (await r.json().catch(() => ({}))) as { sessions?: number; error?: string };
  if (!r.ok) throw new Error(body.error ?? `backfill grant -> ${r.status}`);
  ui.done(`Backfilled ${body.sessions ?? 0} stored session(s) for ${grant.slug}`);
}

export async function unlinkRepository(grantId?: string): Promise<void> {
  const state = loadState();
  const ctx = await context(state);
  const grant = await choose("Repository link", byIdOrChoose(ctx.grants, grantId, (g) => g.grantId), (g) => `${g.slug} → ${g.orgLabel} / ${g.projectName}`);
  console.log(`  Future attribution to ${ui.c.bold(grant.orgLabel)} stops; closed history stays on its ledger.`);
  if (!(await ui.confirm("Revoke this grant?", false))) {
    ui.todo("Canceled. Nothing changed.");
    return;
  }
  const r = await fetch(`${state.apiBase}/attribution/grants/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${state.deviceToken}` },
    body: JSON.stringify({ grantId: grant.grantId }),
  });
  if (!r.ok) throw new Error(`revoke grant -> ${r.status}`);
  if (state.org) state.org.checkedAt = 0;
  saveState(state);
  ui.done(`Revoked ${grant.slug} → ${grant.orgLabel}`);
  ui.hint("Link it again anytime: npx --yes deploy-forward@latest link — a new link starts a fresh grant period; this one's shared history stays on the org's ledger.");
}
