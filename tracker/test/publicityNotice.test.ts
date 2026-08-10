/**
 * L22 — the ceremony's publicity QUESTION becomes a NOTICE (canonical-plan §9.3,
 * ratified 2026-07-24). Accounts are created public server-side; the install ceremony
 * discloses instead of prompting: you are on the board, what is published, what never
 * is, and the one command that flips it. No "yes" to collect — the disclosure is the
 * consent. A user who is PRIVATE (their explicit choice, or a legacy private seed) is
 * never nagged: the notice is empty and the status surfaces carry the state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPublicityNotice } from "../src/publicity.js";

test("public state -> the disclosure: on the board, published/never-published, and the flip command", () => {
  const lines = buildPublicityNotice({ public: true, decided: false });
  const all = lines.join("\n");
  assert.ok(lines.length >= 3, "a real disclosure, not a one-liner");
  assert.ok(/public board/i.test(all), "says you are on the public board");
  assert.ok(/never published/i.test(all), "names what never leaves the machine");
  assert.ok(all.includes("npx --yes deploy-forward@latest private"), "the flip command, canonical form");
  assert.ok(!/\?/.test(all), "a notice asks nothing");
});

test("an already-decided public user gets the same honest notice (state, not interrogation)", () => {
  const lines = buildPublicityNotice({ public: true, decided: true });
  assert.ok(lines.join("\n").includes("npx --yes deploy-forward@latest private"));
});

test("a private user is never nagged - empty notice, status surfaces carry it", () => {
  assert.deepEqual(buildPublicityNotice({ public: false, decided: true }), []);
  assert.deepEqual(buildPublicityNotice({ public: false, decided: false }), []);
});
