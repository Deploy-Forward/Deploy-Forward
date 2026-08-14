/**
 * The first-run privacy contract — the honest screen shown at the moment of decision,
 * BEFORE any device flow starts (adversarial-review remediation, Marco 2026-08-14:
 * "Surface the privacy contract during the first run, not only in docs"). The Board
 * remains an explicit ask: this screen informs the question, it never replaces it.
 *
 * These tests pin the CONTENT, because the whole point is what the words say: the
 * can-leave list must match contract/PRIVACY.md's one-line version, the never-leaves
 * list must name the sensitive categories, and withdrawal must be stated. A copy edit
 * that drops one of these is a real regression, not a cosmetic change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { privacyContractLines } from "../src/privacyContract.ts";

const text = () => privacyContractLines().join("\n");

test("names everything that CAN leave the machine, per contract/PRIVACY.md", () => {
  const t = text().toLowerCase();
  for (const item of ["token counts", "timestamps", "model names", "durations", "repo hash"]) {
    assert.ok(t.includes(item), `can-leave list must name "${item}"`);
  }
});

test("names what can NEVER leave: prompts, code, file names, working directories, credentials", () => {
  const t = text().toLowerCase();
  for (const item of ["prompts", "code", "file names", "working directories", "credentials"]) {
    assert.ok(t.includes(item), `never-leaves list must name "${item}"`);
  }
});

test("states that nothing ships before opting in, and how consent is withdrawn", () => {
  const t = text().toLowerCase();
  assert.ok(t.includes("until you opt in"), "must state nothing leaves before the opt-in");
  assert.ok(t.includes("logout") && t.includes("uninstall"), "must name the withdrawal commands");
});

test("points at the verifiable source, not just an assertion", () => {
  assert.ok(text().includes("contract/PRIVACY.md"), "must cite the pinned contract");
});

test("stays a screen, not a wall: at most 10 lines, none wider than 86 chars", () => {
  const lines = privacyContractLines();
  assert.ok(lines.length <= 10, `got ${lines.length} lines`);
  for (const l of lines) assert.ok(l.length <= 86, `line too wide (${l.length}): ${l}`);
});
