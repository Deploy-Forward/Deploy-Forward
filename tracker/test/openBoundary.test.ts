/**
 * THE OPEN-BOUNDARY TEST — the MIT tarball must never carry closed code.
 *
 * The boundary rule (docs/canonical-plan.md §1): "If it runs on the user's machine and
 * captures or labels usage, it is open. If it ranks, folds, attributes, alerts, or serves
 * an org surface, it is closed." `tracker/` is the open half: MIT, its own LICENSE, and
 * published to npm as `deploy-forward`. `functions/` and `web/` are UNLICENSED and private.
 *
 * Rule R1 of the open-source plan (docs/product-audit-2026-07.md §5) is directional:
 * closed code may import open code, never the reverse. Until now nothing checked it, so
 * the rule was prose. This is the check.
 *
 * Three assertions, in order of severity:
 *
 *   1. SHIPPED CODE IS CLEAN. Nothing under tracker/src or tracker/bin may import from
 *      outside tracker/. This is the one that must never have an exception: those files
 *      compile into dist/ and dist/ is what npm publishes under an MIT licence.
 *
 *   2. TEST EXCEPTIONS ARE ENUMERATED. tracker/test may reach outside tracker/, but
 *      only the files named in ALLOWED_TEST_IMPORTERS below, and every one of them must
 *      justify itself here. The list is deliberately hard to grow: adding a file to it is
 *      a visible decision in review, not a quiet import. See "Why the exception exists".
 *
 *   3. THE PACKAGING THAT MAKES (2) SAFE IS PINNED. The test-only exception is harmless
 *      today for exactly two mechanical reasons: package.json `files` allows only dist
 *      and HOOKS.md, and tsconfig excludes test from the build. If either changes, closed
 *      source would be compiled and published under MIT. So both are asserted here, next
 *      to the exception they protect, rather than left as folklore.
 *
 * HISTORY OF THE EXCEPTION LIST (why it exists at all): it was born with two entries,
 * the F4 drift guards pricingSync.test.ts and contextWindowSync.test.ts, which imported
 * the server's tables and asserted equality — the guard that kept the July 2026
 * "$15,949+ vs $10,740.65" pricing drift from shipping twice. P1 (the usage-core
 * extraction, docs/product-audit-2026-07.md §5) retired both: the tables live
 * canonically in /usage-core (open, MIT), each consumer carries a byte-checked copy
 * (coreParity tests), and no tracker test needs to touch closed code. The list is
 * empty again and should stay that way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TRACKER_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * tracker/test files permitted to import from outside tracker/, each with the reason.
 * Adding an entry is a deliberate, reviewable act. Keep it empty if you ever can.
 */
const ALLOWED_TEST_IMPORTERS: Record<string, string> = {
  // EMPTY since P1 (the usage-core extraction). The two entries this list was born
  // with — pricingSync.test.ts and contextWindowSync.test.ts, the F4 drift guards
  // that had to import closed code — are retired: the tables they pinned now live
  // canonically in /usage-core (open, MIT) and every consumer's copy is byte-checked
  // by its own coreParity test, which READS the open source instead of importing
  // closed code. Keep this list empty.
};

/** Matches `from "..."` and `import("...")` specifiers, ignoring comments' prose. */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|mts|js|mjs)$/.test(entry)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Relative specifiers that climb out of tracker/. Resolved against the importing file's
 * directory, so this catches `../../functions/...`, `../../../web/...` and any future
 * spelling, rather than pattern-matching two known strings.
 */
function escapingImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const fromDir = join(file, "..");
  const escaping: string[] = [];
  for (const match of source.matchAll(SPECIFIER_RE)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue; // bare specifier: a package, not our tree
    const resolved = join(fromDir, specifier);
    const rel = relative(TRACKER_ROOT, resolved);
    if (rel.startsWith("..")) escaping.push(specifier);
  }
  return escaping;
}

test("shipped tracker code imports nothing from outside tracker/", () => {
  const offenders: string[] = [];
  // eval/ is not in the npm tarball, but it IS in the public repo export — a script
  // there that imports closed code would publish closed source the moment the tree
  // is exported (the waterfall.mjs lesson: it ran closed scoring math from eval/ and
  // no test noticed, because this loop scanned src and bin only). Closed diagnostics
  // belong in the repo-root tools/, outside tracker/ entirely.
  for (const dir of ["src", "bin", "eval"]) {
    for (const file of sourceFilesUnder(join(TRACKER_ROOT, dir))) {
      for (const specifier of escapingImports(file)) {
        offenders.push(`${relative(TRACKER_ROOT, file).replace(/\\/g, "/")} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "tracker/src and tracker/bin compile into the MIT-published dist/. An import that " +
      "escapes tracker/ would publish closed source under MIT. Move what you need into " +
      "tracker/, or extract it into the shared open usage-core (see P1).",
  );
});

test("only the enumerated test files reach into closed code", () => {
  const found: Record<string, string[]> = {};
  for (const file of sourceFilesUnder(join(TRACKER_ROOT, "test"))) {
    const escaping = escapingImports(file);
    if (escaping.length) found[relative(TRACKER_ROOT, file).replace(/\\/g, "/")] = escaping;
  }

  const actual = Object.keys(found).sort();
  const allowed = Object.keys(ALLOWED_TEST_IMPORTERS).sort();

  const undeclared = actual.filter((f) => !allowed.includes(f));
  assert.deepEqual(
    undeclared,
    [],
    "A tracker test imported closed code without declaring why. Either drop the import, " +
      "or add the file to ALLOWED_TEST_IMPORTERS with the reason it must exist.",
  );

  const stale = allowed.filter((f) => !actual.includes(f));
  assert.deepEqual(
    stale,
    [],
    "ALLOWED_TEST_IMPORTERS lists a file that no longer imports closed code. Delete the " +
      "entry: a shrinking exception list is the goal.",
  );
});

test("packaging keeps the test-only exception out of the published tarball", () => {
  const pkg = JSON.parse(readFileSync(join(TRACKER_ROOT, "package.json"), "utf8"));
  assert.deepEqual(
    pkg.files,
    ["dist", "HOOKS.md"],
    "package.json `files` is the allowlist that keeps test/ (and its closed-code imports) " +
      "out of the npm tarball. Widening it can publish closed source under MIT.",
  );

  const tsconfig = JSON.parse(readFileSync(join(TRACKER_ROOT, "tsconfig.json"), "utf8"));
  assert.ok(
    Array.isArray(tsconfig.exclude) && tsconfig.exclude.includes("test"),
    "tsconfig must exclude `test` from the build, or the drift guards would compile into " +
      "dist/ and drag closed code with them.",
  );
  assert.deepEqual(
    tsconfig.include,
    ["bin", "src"],
    "tsconfig `include` scopes what becomes dist/. Keep it to bin and src.",
  );
});
