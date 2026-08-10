import assert from "node:assert/strict";
import { test } from "node:test";
import { crossOrgDisclosure, foldRepoCandidates } from "../src/repoAttribution";
import type { SessionSummary } from "../src/types";

const summary = (cwd: string, repoHash: string, input: number): SessionSummary => ({
  tool: "codex", toolSessionId: repoHash, model: "gpt-test",
  tokens: { input, output: 0, cacheRead: 0, cacheCreation: 0 },
  models: [], entryPoint: "cli", thinkingTokens: 0, wallMs: 1, activeMs: 1,
  idleMs: 0, startedAt: 1, endedAt: 2, repoHash, cwd, messageCount: 1,
  turns: 1, longestLoopMs: 1,
});

test("foldRepoCandidates groups checkouts by locally-resolved slug and conserves usage", () => {
  // repoSlugForCwd is git-backed; an invalid cwd is honestly not fabricated.
  assert.deepEqual(foldRepoCandidates([summary("Z:/missing", "a".repeat(32), 10)], { repoHmacKey: "k" }), []);
});

test("foldRepoCandidates is empty for sessions with no cwd", () => {
  const s = summary("", "b".repeat(32), 10);
  s.cwd = undefined;
  assert.deepEqual(foldRepoCandidates([s], { repoHmacKey: "k" }), []);
});

// ── crossOrgDisclosure: organization-buildout.md §6.4 — adding a repo already shared
// with another org must name every org that will independently see it. ──────────────

test("crossOrgDisclosure is null when the repo has no existing grants", () => {
  assert.equal(crossOrgDisclosure("org-a", "Org A", []), null);
});

test("crossOrgDisclosure is null when the only existing grant is the SAME org (re-link, not a new org)", () => {
  const existing = [{ orgId: "org-a", orgLabel: "Org A" }];
  assert.equal(crossOrgDisclosure("org-a", "Org A", existing), null);
});

test("crossOrgDisclosure names the other org(s) and the org being added", () => {
  const existing = [{ orgId: "org-a", orgLabel: "north-labs" }];
  assert.deepEqual(crossOrgDisclosure("org-b", "client-acme", existing), {
    alreadyWith: ["north-labs"],
    adding: "client-acme",
  });
});

test("crossOrgDisclosure dedupes multiple grants pointing at the same other org", () => {
  const existing = [
    { orgId: "org-a", orgLabel: "north-labs" },
    { orgId: "org-a", orgLabel: "north-labs" },
  ];
  assert.deepEqual(crossOrgDisclosure("org-b", "client-acme", existing), {
    alreadyWith: ["north-labs"],
    adding: "client-acme",
  });
});

test("crossOrgDisclosure lists every distinct other org when three orgs already share the repo", () => {
  const existing = [
    { orgId: "org-a", orgLabel: "north-labs" },
    { orgId: "org-c", orgLabel: "third-co" },
  ];
  assert.deepEqual(crossOrgDisclosure("org-b", "client-acme", existing), {
    alreadyWith: ["north-labs", "third-co"],
    adding: "client-acme",
  });
});
