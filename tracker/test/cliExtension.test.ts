/**
 * bin/df.ts's optional-extension hook (alignment decision D3): a closed, product-specific
 * CLI surface can graft a help block and a subcommand table onto the open tracker's CLI at
 * RUNTIME, through a path TypeScript cannot resolve statically (`new URL(str, base)` plus a
 * dynamic `import()` on a non-literal expression, so `tsc --noEmit` passes whether or not
 * any extension module exists on disk) and through a directory-discovery convention
 * (bin/df.ts's resolveExtensionUrl()) rather than a hardcoded filename — so this file itself
 * never has to name which closed surface, if any, is actually installed.
 *
 * This file pins the GENERIC MECHANISM ONLY, with a fixture extension
 * (test/fixtures/cliExtensionFixture.ts) that is deliberately unrelated to any real closed
 * extension — on purpose, so both this file and the fixture stay in the public export,
 * never mentioning what a real extension's own name or commands might be. Real, closed
 * extension-specific wiring (its own help text, its own subcommand dispatch) is pinned in
 * that extension's own test file under tracker/test, which does not ship publicly.
 *
 * bin/df.ts runs `main()` at import time (real CLI dispatch, network, prompts) — unsafe
 * to `import` directly in a test (see test/shell.test.ts's NON_TTY_NOTE test for the same
 * discipline). The commands exercised here (`--help`, an unknown command, and the fixture's
 * own `fixture-cmd`) are all argv-driven and never reach the bare-command ceremony, so
 * spawning the real CLI as a child process is safe and is the only way to observe the
 * hook actually wired into df.ts's own help/dispatch, rather than re-testing the fixture
 * module in isolation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const TRACKER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DF_BIN = join(TRACKER_ROOT, "bin", "df.ts");
const FIXTURE_EXTENSION = join(TRACKER_ROOT, "test", "fixtures", "cliExtensionFixture.ts");
// Definitely absent: simulates the public export, where no extension file exists at any
// candidate path (neither the .ts source nor a compiled .js sibling).
const MISSING_EXTENSION = join(TRACKER_ROOT, "__no_such_cli_extension__.js");

/** Spawns the real CLI via tsx (same loader the `npm test`/`npm run dev` scripts use),
 * with an explicit, deterministic DF_EXTENSION_PATH — never inheriting whatever the
 * outer test process happens to have set. */
function runDf(args: string[], extensionPath: string): { stdout: string; stderr: string; status: number | null } {
  const env = { ...process.env, DF_EXTENSION_PATH: extensionPath };
  const result = spawnSync(process.execPath, ["--import", "tsx", DF_BIN, ...args], {
    cwd: TRACKER_ROOT,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

test("df --help: with an extension present, its help lines are appended to the built-in list", () => {
  const r = runDf(["--help"], FIXTURE_EXTENSION);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /fixture-cmd/, `expected the fixture's help line in --help output:\n${r.stdout}`);
  assert.match(r.stdout, /a fixture-only command/);
});

test("df <extension command>: dispatches through the hook to the extension's own handler, argv forwarded verbatim", () => {
  const r = runDf(["fixture-cmd", "foo", "bar"], FIXTURE_EXTENSION);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /fixture-cmd ran with argv=\["foo","bar"\]/, `expected the fixture command's own output:\n${r.stdout}`);
});

test("df --help: with NO extension present, the output carries no trace of any extension", () => {
  const r = runDf(["--help"], MISSING_EXTENSION);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /fixture-cmd/, `--help must not mention an absent extension's command:\n${r.stdout}`);
});

test("df <extension command>: with NO extension present, the command is unrecognized -- the same honest 'unknown command' path as any other typo, never a crash", () => {
  const r = runDf(["fixture-cmd", "foo"], MISSING_EXTENSION);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown command or flag: fixture-cmd/, `expected the generic unknown-command error:\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /fixture-cmd ran with argv/, "an absent extension's handler must never run");
});

test("df --help: a nonexistent command's absence is silent -- help text generically omits it, it never hardcodes which commands are 'extensions'", () => {
  const present = runDf(["--help"], FIXTURE_EXTENSION).stdout;
  const absent = runDf(["--help"], MISSING_EXTENSION).stdout;
  assert.notEqual(present, absent, "the two runs must visibly differ by exactly the extension's own help block");
  // Every line absent carries over into present verbatim (the extension only APPENDS).
  const absentLines = absent.trim().split("\n");
  const presentLines = present.trim().split("\n");
  for (const line of absentLines) {
    assert.ok(presentLines.includes(line), `a built-in help line went missing when an extension was added: ${JSON.stringify(line)}`);
  }
});
