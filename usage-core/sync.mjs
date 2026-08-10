#!/usr/bin/env node
/**
 * usage-core/sync.mjs — copy the canonical sources into every consumer.
 *
 * usage-core/src/* is the single source of truth for pricing, tier bands and context
 * windows. Each consumer package carries a byte-identical copy under src/core/
 * because the packages deliberately share no build-time machinery. The copies are
 * CHECKED IN so every build, test, publish and deploy works exactly as before — this
 * script just writes them, and each package's coreParity test fails CI if a copy
 * drifts or someone edits a copy directly.
 *
 * Targets are discovered, not hardcoded: any sibling package with a src/core/ dir
 * (or a src/ dir at all) can opt in below; missing siblings are skipped, so the
 * script works unchanged in trees that carry only some consumers.
 *
 * Usage: node usage-core/sync.mjs   (from the repo root, or anywhere)
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = dirname(fileURLToPath(import.meta.url));
const SRC = join(CORE, "src");
const REPO = join(CORE, "..");
const CANDIDATES = ["tracker", "functions"].map((p) => join(REPO, p, "src", "core"));
const TARGETS = CANDIDATES.filter((t) => existsSync(dirname(t)));

const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
for (const target of TARGETS) {
  mkdirSync(target, { recursive: true });
  for (const file of files) {
    copyFileSync(join(SRC, file), join(target, file));
    console.log(`synced ${file} -> ${target}`);
  }
}
