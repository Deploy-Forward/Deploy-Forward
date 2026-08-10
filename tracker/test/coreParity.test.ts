/**
 * CORE PARITY GATE — the CLI's copy of usage-core must be byte-identical to the
 * canonical source, forever.
 *
 * P1 of the open-source plan (docs/product-audit-2026-07.md §5): pricing, tier bands
 * and context windows live canonically in /usage-core (open, MIT). tracker carries a
 * synced copy under src/core/ — inside the MIT tarball, which is correct: usage-core
 * IS open content. See functions/test/coreParity.test.ts for why copies (no root
 * package machinery exists to share a module three ways without touching how every
 * package builds and deploys).
 *
 * This file REPLACES pricingSync.test.ts and contextWindowSync.test.ts, the two F4
 * drift guards that had to reach across the open/closed boundary into closed code
 * (each was an enumerated exception in openBoundary.test.ts). Reading the OPEN
 * canonical source instead needs no exception: the allowlist is empty again, which
 * openBoundary.test.ts itself enforces stays the goal.
 *
 * To change pricing, tiers or windows: edit usage-core/src/*, run
 * `node usage-core/sync.mjs`, commit everything it touched. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TRACKER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CANONICAL_DIR = join(TRACKER_ROOT, "..", "usage-core", "src");
const COPY_DIR = join(TRACKER_ROOT, "src", "core");
const CORE_FILES = ["pricing.ts", "contextWindows.ts"];

test("the usage-core canonical sources exist", () => {
  for (const file of CORE_FILES) {
    assert.ok(
      existsSync(join(CANONICAL_DIR, file)),
      `usage-core/src/${file} is missing — the canonical open module every copy syncs from`,
    );
  }
});

test("tracker/src/core is a byte-identical copy of usage-core", () => {
  for (const file of CORE_FILES) {
    const copyPath = join(COPY_DIR, file);
    assert.ok(
      existsSync(copyPath),
      `tracker/src/core/${file} is missing — run \`node usage-core/sync.mjs\``,
    );
    assert.equal(
      readFileSync(copyPath, "utf8"),
      readFileSync(join(CANONICAL_DIR, file), "utf8"),
      `tracker/src/core/${file} drifted from usage-core/src/${file}. Never edit the ` +
        `copy: edit usage-core/src/${file}, then run \`node usage-core/sync.mjs\``,
    );
  }
});
