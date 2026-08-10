/**
 * TRACKER_VERSION must equal package.json's version.
 *
 * 0.12.0 shipped with TRACKER_VERSION still reading "0.11.8". Two things broke, and both were
 * silent: the update-check told every user to upgrade to the build they were already running,
 * and every session ingested was stamped `trackerVersion: "0.11.8"` — the exact field the
 * server keeps for schema-drift triage, so the one signal you'd use to debug a parser problem
 * was wrong.
 *
 * A comment saying "remember to bump both" is not a guard. This is.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { TRACKER_VERSION } from "../src/sync.js";

test("TRACKER_VERSION matches package.json — a release cannot misreport itself", () => {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  assert.equal(
    TRACKER_VERSION,
    pkg.version,
    `TRACKER_VERSION (${TRACKER_VERSION}) !== package.json version (${pkg.version}). ` +
      "Bump src/sync.ts:TRACKER_VERSION whenever you bump the package, or the release lies " +
      "about itself in the update-check AND in every session's trackerVersion.",
  );
});
