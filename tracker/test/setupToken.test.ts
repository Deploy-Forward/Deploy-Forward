/**
 * L22 PART B — `deploy-forward setup-token`: mint a fresh device token FOR ANOTHER box,
 * via the EXISTING pair browser flow, but PRINT-DON'T-SAVE (test-first; a different agent
 * implements). A laptop-with-browser mints a revocable token for a headless target box
 * (EC2/CI/container), which then authenticates with DF_DEVICE_TOKEN (see PART A).
 *
 * THE SEAM (does not exist yet — this is the intentional red): src/auth.ts must factor a
 * mint-only path out of pair() and export it as `setupToken`. It runs the SAME
 * /api/pair (start) + /api/pair/claim (poll) flow pair() uses, but instead of saving the
 * token to state + resetting ledgers, it RETURNS and PRINTS the token with copy-paste
 * instructions. It NEVER touches this machine's own auth state.
 *
 * Contract this suite pins (a namespace import makes a missing export resolve to
 * undefined, so calling it fails as a clean red rather than an import-time crash):
 *
 *   setupToken(opts?: { label?: string; pollMs?: number }): Promise<string | null>
 *     - label   → sent as the /api/pair start `label` (default hostname()) so the minted
 *                 token is identifiable in the account's device list for later revocation.
 *     - pollMs  → the claim poll interval; defaults to the production cadence, overridable
 *                 so a test need not wait real seconds.
 *     - resolves to the minted deviceToken string on approval (also printed), or null on a
 *       non-approved / expired poll (a clear retry printed).
 *     - MUST NOT saveState, MUST NOT reset ledgers, MUST NOT install hooks, MUST NOT
 *       persist the minted token locally (this machine is not the target box).
 *     - MUST NOT open a browser on a non-TTY run (a headless Cloud Shell prints the URL +
 *       code and polls) — these tests run non-TTY, so a browser is never spawned.
 *
 * Hermetic: DF_HOME/DF_CLAUDE_SETTINGS pinned to temp dirs; the pair HTTP is mocked on
 * globalThis.fetch — no real API, no real home is touched.
 *
 * Run: npx tsx --test test/setupToken.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARSER_EPOCH } from "../src/config.ts";
// Namespace import: a missing `setupToken` export resolves to undefined and the call
// throws a clean "not a function" red, rather than an unresolved-import crash.
import * as auth from "../src/auth.ts";
import { hooksInstalled } from "../src/hooks.ts";

const validToken = (tail: string): string => "df_" + tail.padEnd(43, "0").slice(0, 43);
const LOCAL_TOKEN = validToken("locallocallocallocallocallocallocalAAAA");
const MINTED_TOKEN = validToken("mintedmintedmintedmintedmintedmintedBBBB");

/** This machine's OWN state: already paired to account A, with real ledgers. setup-token
 * mints a token for a DIFFERENT box and must leave every byte of this untouched. */
function writeLocalState(home: string): void {
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://mock.invalid/api",
      deviceToken: LOCAL_TOKEN,
      uid: "u-local",
      handle: "localuser",
      repoHmacKey: "k".repeat(64),
      cursors: { "/some/transcript.jsonl": { byteOffset: 42 } },
      threadDigests: { claude_code_s1: "digest-abc" },
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
    }),
  );
}

function pinEnv(home: string): Record<string, string | undefined> {
  const prev: Record<string, string | undefined> = {};
  const set = (k: string, v: string | undefined): void => {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  set("DF_HOME", home);
  set("DF_CLAUDE_SETTINGS", join(home, "no-settings.json")); // absent -> hooksInstalled() is false
  // setup-token runs on the browser machine and uses its OWN on-disk auth — DF_DEVICE_TOKEN
  // must be unset so it never leaks into loadState() here.
  set("DF_DEVICE_TOKEN", undefined);
  return prev;
}

function restoreEnv(prev: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Capture everything printed (console.log + raw stdout) so the token + instructions can
 * be asserted without depending on which sink the impl chose. */
function captureOutput(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      console.log = origLog;
      process.stdout.write = origWrite;
    },
  };
}

test("setup-token: mint-only — returns + prints the token, carries --label, and never touches this machine's state or hooks", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-setuptoken-ok-"));
  writeLocalState(home);
  const before = readFileSync(join(home, "state.json"), "utf8");
  const prev = pinEnv(home);

  const startBodies: any[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: any) => {
    const u = String(url);
    if (u.endsWith("/pair/claim")) {
      return { ok: true, json: async () => ({ status: "approved", deviceToken: MINTED_TOKEN, uid: "u-other", handle: "boxuser" }) };
    }
    if (u.endsWith("/pair")) {
      startBodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ code: "WXYZ", pollSecret: "ps-1", expiresInMs: 60000 }) };
    }
    throw new Error(`unexpected fetch to ${u}`);
  }) as unknown as typeof fetch;

  const cap = captureOutput();
  t.after(() => {
    cap.restore();
    globalThis.fetch = origFetch;
    restoreEnv(prev);
  });

  const minted = await (auth as any).setupToken({ label: "ec2-prod", pollMs: 5 });

  assert.equal(minted, MINTED_TOKEN, "setup-token resolves to the freshly-minted device token");
  assert.equal(startBodies.length, 1, "exactly one /api/pair start");
  assert.equal(startBodies[0].label, "ec2-prod", "the --label rides the start request so the token is identifiable for revocation");

  const printed = cap.lines.join("\n");
  assert.ok(printed.includes(MINTED_TOKEN), "the minted token is printed for copy-paste onto the target box");
  assert.match(printed, /DF_DEVICE_TOKEN/, "the copy-paste instruction sets DF_DEVICE_TOKEN on the target box");
  assert.match(printed, /revoke/i, "the print points at revocation (the token is a live bearer credential)");

  // The whole point of mint-only: this machine's auth state is inert.
  const after = readFileSync(join(home, "state.json"), "utf8");
  assert.equal(after, before, "setup-token must not save state or reset ledgers on this machine");
  assert.equal(after.includes(MINTED_TOKEN), false, "the token minted for ANOTHER box is never persisted locally");
  assert.equal(hooksInstalled(), false, "minting a token for another box installs no hooks here");
});

test("setup-token: a non-approved / expired poll prints a clear retry, returns null, and persists no junk", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-setuptoken-expired-"));
  writeLocalState(home);
  const before = readFileSync(join(home, "state.json"), "utf8");
  const prev = pinEnv(home);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.endsWith("/pair/claim")) {
      // Never approved — the human never confirms in the browser.
      return { ok: true, json: async () => ({ status: "pending" }) };
    }
    if (u.endsWith("/pair")) {
      // A tiny deadline so the poll loop expires quickly and deterministically.
      return { ok: true, json: async () => ({ code: "WXYZ", pollSecret: "ps-1", expiresInMs: 40 }) };
    }
    throw new Error(`unexpected fetch to ${u}`);
  }) as unknown as typeof fetch;

  const cap = captureOutput();
  t.after(() => {
    cap.restore();
    globalThis.fetch = origFetch;
    restoreEnv(prev);
  });

  const minted = await (auth as any).setupToken({ pollMs: 5 });

  assert.equal(minted, null, "an expired / never-approved poll resolves to null, not a token");
  const printed = cap.lines.join("\n");
  assert.match(printed, /again|expired|retry/i, "a clear retry note is printed when the code was never approved");

  const after = readFileSync(join(home, "state.json"), "utf8");
  assert.equal(after, before, "a failed mint persists no junk to this machine's state");
});
