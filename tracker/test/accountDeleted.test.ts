/**
 * Account-deletion 403 handling in sync.ts (plan Task 11, tracker half): the pure
 * classifier for the server's `res.status(403).json({ error:
 * "account_deleted", restoreBy })` contract, and the pure message formatter it feeds.
 * Both take already-parsed inputs (status/body, or restoreBy/now) — no fetch mock and
 * no Date.now() dependency, so every branch is directly unit-testable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAccountDeleted, formatAccountDeletedMessage } from "../src/sync.ts";

test("classifyAccountDeleted: 403 + account_deleted + a future restoreBy -> deleted, carrying restoreBy", () => {
  const restoreBy = Date.now() + 10 * 86_400_000;
  const outcome = classifyAccountDeleted(403, { error: "account_deleted", restoreBy });
  assert.deepEqual(outcome, { deleted: true, restoreBy });
});

test("classifyAccountDeleted: a normal 200 is never classified as deleted", () => {
  assert.deepEqual(classifyAccountDeleted(200, { accepted: 1, flagged: 0 }), { deleted: false });
});

test("classifyAccountDeleted: a 500 stays a generic error upstream, never account_deleted", () => {
  assert.deepEqual(classifyAccountDeleted(500, { error: "internal" }), { deleted: false });
});

test("classifyAccountDeleted: a 403 for some OTHER reason is not account_deleted", () => {
  assert.deepEqual(classifyAccountDeleted(403, { error: "forbidden" }), { deleted: false });
});

test("classifyAccountDeleted: malformed/missing restoreBy still reports deleted, without inventing a number", () => {
  assert.deepEqual(classifyAccountDeleted(403, { error: "account_deleted" }), { deleted: true, restoreBy: undefined });
  assert.deepEqual(
    classifyAccountDeleted(403, { error: "account_deleted", restoreBy: "not-a-number" }),
    { deleted: true, restoreBy: undefined },
  );
});

test("classifyAccountDeleted: a malformed body (null/undefined/non-object) never throws", () => {
  assert.deepEqual(classifyAccountDeleted(403, null), { deleted: false });
  assert.deepEqual(classifyAccountDeleted(403, undefined), { deleted: false });
  assert.deepEqual(classifyAccountDeleted(403, "not json"), { deleted: false });
});

test("formatAccountDeletedMessage: a future restoreBy names the date and points at restore", () => {
  const restoreBy = Date.UTC(2026, 6, 26); // 2026-07-26
  const now = Date.UTC(2026, 6, 16); // 2026-07-16
  const msg = formatAccountDeletedMessage(restoreBy, now);
  assert.match(msg, /2026-07-26/);
  assert.match(msg, /deploy-forward@latest restore/);
  assert.doesNotMatch(msg, /financ|finaliz/i);
});

test("formatAccountDeletedMessage: a restoreBy already in the past says deletion is being finalized", () => {
  const restoreBy = Date.UTC(2026, 6, 10); // 2026-07-10
  const now = Date.UTC(2026, 6, 16); // 2026-07-16 -- after restoreBy
  const msg = formatAccountDeletedMessage(restoreBy, now);
  assert.match(msg, /final/i);
  assert.match(msg, /no longer be possible/i);
});

test("formatAccountDeletedMessage: restoreBy exactly equal to now is NOT treated as already expired", () => {
  const t = Date.UTC(2026, 6, 16);
  const msg = formatAccountDeletedMessage(t, t);
  assert.doesNotMatch(msg, /final/i);
});

test("formatAccountDeletedMessage: an undefined restoreBy (malformed server response) still gives usable instructions", () => {
  const msg = formatAccountDeletedMessage(undefined, Date.now());
  assert.match(msg, /deploy-forward@latest restore/);
});
