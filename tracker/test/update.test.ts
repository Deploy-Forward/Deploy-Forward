/**
 * Unit tests for `deploy-forward update`'s PURE parts: semver parsing/comparison and the
 * registry-doc shape guard. The network fetch and the spawned npm install are exercised
 * manually (they inherit stdio by design), not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSemver, compareSemver, versionFromRegistryDoc } from "../src/update.ts";

test("parseSemver reads x.y.z, tolerates a v prefix and prerelease suffix, rejects garbage", () => {
  assert.deepEqual(parseSemver("0.6.0"), [0, 6, 0]);
  assert.deepEqual(parseSemver("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseSemver("1.2.3-beta.1"), [1, 2, 3]);
  assert.equal(parseSemver("latest"), null);
  assert.equal(parseSemver(""), null);
  assert.equal(parseSemver("1.2"), null);
});

test("compareSemver orders numerically (not lexically), and unparseable compares equal", () => {
  assert.equal(compareSemver("0.5.6", "0.6.0"), -1);
  assert.equal(compareSemver("0.6.0", "0.6.0"), 0);
  assert.equal(compareSemver("0.10.0", "0.9.9"), 1, "10 > 9 numerically -- a lexical compare would get this wrong");
  assert.equal(compareSemver("1.0.0", "0.99.99"), 1);
  // Unparseable NEVER reports "update available" on garbage input.
  assert.equal(compareSemver("garbage", "0.6.0"), 0);
  assert.equal(compareSemver("0.6.0", "garbage"), 0);
});

test("versionFromRegistryDoc accepts only a well-formed semver version field", () => {
  assert.equal(versionFromRegistryDoc({ version: "0.6.0" }), "0.6.0");
  assert.equal(versionFromRegistryDoc({ version: "not-semver" }), null);
  assert.equal(versionFromRegistryDoc({}), null);
  assert.equal(versionFromRegistryDoc(null), null);
  assert.equal(versionFromRegistryDoc("0.6.0"), null, "a bare string is not the registry doc shape");
});
