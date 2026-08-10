/**
 * Passive update nudge (update.ts): pure decision + the daily throttle through
 * state.updateCheck, against a mocked registry fetch and a temp DF_HOME.
 * The invariants: failures throttle too (a dead network can't stall every run),
 * a dev build ahead of the registry never nudges, and the cached answer decides
 * within the window without a network call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newerVersionFrom, checkForNewerVersion, staleVersionBanner, UPDATE_CHECK_INTERVAL_MS } from "../src/update.ts";
import { TRACKER_VERSION } from "../src/sync.ts";
import { loadState, saveState } from "../src/config.ts";

test("newerVersionFrom: nudges only on a strictly newer, parseable registry answer", () => {
  assert.equal(newerVersionFrom("0.11.3", "0.12.0"), "0.12.0");
  assert.equal(newerVersionFrom("0.11.3", "0.11.3"), null);
  assert.equal(newerVersionFrom("0.12.0", "0.11.3"), null, "dev build ahead of registry: no nudge");
  assert.equal(newerVersionFrom("0.11.3", null), null, "failed check: no nudge");
  assert.equal(newerVersionFrom("0.11.3", "not-a-version"), null, "garbage compares equal, never a false nudge");
});

test("staleVersionBanner: loud, names both versions and the exact remedy, only when running trails latest", () => {
  assert.equal(
    staleVersionBanner({ running: "0.22.2", latest: "0.22.3" }),
    "deploy-forward v0.22.2 is behind v0.22.3 - run: npx --yes deploy-forward@latest",
    "the field bug's exact case: a stale cache one patch behind must nag verbatim",
  );
  assert.equal(staleVersionBanner({ running: "0.22.3", latest: "0.22.3" }), "", "running == latest: never nag");
  assert.equal(staleVersionBanner({ running: "0.23.0", latest: "0.22.3" }), "", "dev build ahead of registry: never nag");
  assert.equal(staleVersionBanner({ running: "0.22.2", latest: null }), "", "unknown latest: never nag on uncertainty");
  assert.equal(staleVersionBanner({ running: "0.22.2", latest: "not-a-version" }), "", "unparseable latest compares equal: never a false nag");
});

test("checkForNewerVersion: daily throttle serves the cached answer; a failed check throttles too", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-upd-"));
  const prevHome = process.env.DF_HOME;
  process.env.DF_HOME = home;
  const origFetch = globalThis.fetch;
  let fetches = 0;
  t.after(() => {
    globalThis.fetch = origFetch;
    if (prevHome === undefined) delete process.env.DF_HOME;
    else process.env.DF_HOME = prevHome;
  });

  // 1) Fresh state, registry says a huge version -> nudge + one fetch + stamp saved.
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ version: "99.0.0" }) })) as any;
  globalThis.fetch = ((...args: any[]) => { fetches++; return (async () => ({ ok: true, json: async () => ({ version: "99.0.0" }) }))(); }) as any;
  const NOW = 1_783_700_000_000;
  assert.equal(await checkForNewerVersion(NOW), "99.0.0");
  assert.equal(fetches, 1);
  assert.deepEqual(loadState().updateCheck, { at: NOW, latest: "99.0.0" });

  // 2) Within the window: cached answer, NO network.
  assert.equal(await checkForNewerVersion(NOW + UPDATE_CHECK_INTERVAL_MS - 1), "99.0.0");
  assert.equal(fetches, 1, "throttled — no second fetch inside the window");

  // 3) Window expired + registry now equals the running version -> no nudge, stamp refreshed.
  globalThis.fetch = ((...args: any[]) => { fetches++; return (async () => ({ ok: true, json: async () => ({ version: TRACKER_VERSION }) }))(); }) as any;
  assert.equal(await checkForNewerVersion(NOW + UPDATE_CHECK_INTERVAL_MS + 1), null);
  assert.equal(fetches, 2);

  // 4) Window expired + network DOWN -> null, and the FAILURE is stamped (throttles).
  const s = loadState();
  saveState({ ...s, updateCheck: { at: 0, latest: null } }); // force expiry
  globalThis.fetch = ((...args: any[]) => { fetches++; return Promise.reject(new Error("offline")); }) as any;
  assert.equal(await checkForNewerVersion(NOW + 2 * UPDATE_CHECK_INTERVAL_MS), null);
  assert.equal(fetches, 3);
  assert.equal(loadState().updateCheck!.latest, null, "failure recorded");
  assert.equal(await checkForNewerVersion(NOW + 2 * UPDATE_CHECK_INTERVAL_MS + 1), null);
  assert.equal(fetches, 3, "failed check throttles too — no retry storm on dead networks");
});
