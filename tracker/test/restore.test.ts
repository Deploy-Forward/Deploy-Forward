/**
 * `deploy-forward restore` (plan Task 11): the pure response-mapper (unit-tested with
 * plain status/body objects, no network) plus a light end-to-end pass against a mocked
 * /api/restore (syncOnce.test.ts's fetch-mock + temp-DF_HOME pattern) proving restore()
 * posts the device bearer to the right URL and maps each documented response correctly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapRestoreResponse, restore } from "../src/restore.ts";
import { PARSER_EPOCH } from "../src/config.ts";

// ---- mapRestoreResponse: PURE, no fetch/mock needed --------------------------------------

test("mapRestoreResponse: {restored:true} -> restored", () => {
  assert.deepEqual(mapRestoreResponse(200, { restored: true }), { kind: "restored" });
});

test("mapRestoreResponse: {restored:false, alreadyLive:true} -> already_live", () => {
  assert.deepEqual(mapRestoreResponse(200, { restored: false, alreadyLive: true }), { kind: "already_live" });
});

test("mapRestoreResponse: 401 -> not_paired regardless of body shape", () => {
  assert.deepEqual(mapRestoreResponse(401, { error: "invalid_device_token" }), { kind: "not_paired" });
  assert.deepEqual(mapRestoreResponse(401, {}), { kind: "not_paired" });
});

test("mapRestoreResponse: a 500 (or any other unexpected status) is a generic error, carrying detail when present", () => {
  assert.deepEqual(mapRestoreResponse(500, { error: "internal" }), { kind: "error", status: 500, detail: "internal" });
  assert.deepEqual(mapRestoreResponse(500, {}), { kind: "error", status: 500, detail: undefined });
});

test("mapRestoreResponse: a 2xx matching neither documented shape is a soft error, never a false success", () => {
  assert.deepEqual(mapRestoreResponse(200, {}), { kind: "error", status: 200, detail: undefined });
  assert.deepEqual(mapRestoreResponse(200, { restored: false }), { kind: "error", status: 200, detail: undefined });
});

// ---- restore(): light end-to-end pass against a mocked /api/restore -----------------------

function writeState(home: string, deviceToken: string | null): void {
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      apiBase: "http://mock.invalid/api",
      deviceToken,
      uid: null,
      handle: null,
      repoHmacKey: "k".repeat(64),
      cursors: {},
      threadDigests: {},
      parserEpoch: PARSER_EPOCH,
      gapMs: 5 * 60 * 1000,
    }),
  );
}

test("restore(): POSTs the device bearer to <apiBase>/restore and prints on {restored:true}", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-home-restore-ok-"));
  writeState(home, "test-token");
  const prevDfHome = process.env.DF_HOME;
  process.env.DF_HOME = home;

  const calls: { url: string; init: any }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return { status: 200, json: async () => ({ restored: true }) };
  }) as any;
  t.after(() => {
    globalThis.fetch = origFetch;
    if (prevDfHome === undefined) delete process.env.DF_HOME;
    else process.env.DF_HOME = prevDfHome;
  });

  await restore();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://mock.invalid/api/restore");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-token");
});

test("restore(): {restored:false, alreadyLive:true} resolves without throwing", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-home-restore-live-"));
  writeState(home, "test-token");
  const prevDfHome = process.env.DF_HOME;
  process.env.DF_HOME = home;

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ status: 200, json: async () => ({ restored: false, alreadyLive: true }) })) as any;
  t.after(() => {
    globalThis.fetch = origFetch;
    if (prevDfHome === undefined) delete process.env.DF_HOME;
    else process.env.DF_HOME = prevDfHome;
  });

  await assert.doesNotReject(() => restore());
});

test("restore(): 401 prints not-paired guidance, does not throw, and sets a non-zero exit code", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-home-restore-401-"));
  writeState(home, "stale-token");
  const prevDfHome = process.env.DF_HOME;
  process.env.DF_HOME = home;
  const prevExitCode = process.exitCode;
  process.exitCode = undefined;

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ status: 401, json: async () => ({ error: "invalid_device_token" }) })) as any;
  t.after(() => {
    globalThis.fetch = origFetch;
    if (prevDfHome === undefined) delete process.env.DF_HOME;
    else process.env.DF_HOME = prevDfHome;
    process.exitCode = prevExitCode;
  });

  await assert.doesNotReject(() => restore());
  assert.equal(process.exitCode, 1);
});

test("restore(): a genuine server error (500) throws, hitting the tracker's standard top-level error path", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-home-restore-500-"));
  writeState(home, "test-token");
  const prevDfHome = process.env.DF_HOME;
  process.env.DF_HOME = home;

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ status: 500, json: async () => ({ error: "internal_error" }) })) as any;
  t.after(() => {
    globalThis.fetch = origFetch;
    if (prevDfHome === undefined) delete process.env.DF_HOME;
    else process.env.DF_HOME = prevDfHome;
  });

  await assert.rejects(() => restore(), /internal_error/);
});

test("restore(): with no stored device token, throws telling the user to onboard first (no network attempted)", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "df-home-restore-nopair-"));
  const prevDfHome = process.env.DF_HOME;
  process.env.DF_HOME = home; // no state.json at all -- loadState()'s fresh-state default (deviceToken: null)

  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return { status: 200, json: async () => ({}) };
  }) as any;
  t.after(() => {
    globalThis.fetch = origFetch;
    if (prevDfHome === undefined) delete process.env.DF_HOME;
    else process.env.DF_HOME = prevDfHome;
  });

  await assert.rejects(() => restore(), /npx --yes deploy-forward@latest/);
  assert.equal(fetchCalled, false, "no network attempted without a stored device token");
});
