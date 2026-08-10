/**
 * D14 two-way org join — CLI lane (docs/d14-two-way-join-spec.md, C5/C8/C11), tracker
 * side. The SERVER routes these functions call (POST /api/org/invite/redeem, /org/
 * request, /org/request/cancel, /org/leave) are a separate, Marco-gated build lane
 * (server lane, human-gated) and are NOT implemented anywhere yet — every test here drives the
 * CLIENT contract against a FAKE fetchImpl (mocked HTTP, per the spec's documented
 * response shapes), never a live route.
 *
 * Covers: extractOrgSlug (pure), the C11 exception-matrix renderer (pure), the four
 * pure response mappers, and the four network functions (redeemInviteCode,
 * requestToJoinOrg, cancelJoinRequest, leaveOrgDevice) end to end against a fake fetch.
 *
 * Run: npx tsx --test test/orgJoin.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractOrgSlug,
  renderOrgErrorLine,
  mapInviteRedeemResponse,
  mapJoinRequestResponse,
  mapCancelRequestResponse,
  mapLeaveOrgResponse,
  redeemInviteCode,
  requestToJoinOrg,
  cancelJoinRequest,
  leaveOrgDevice,
} from "../src/orgContext.ts";
import { APP_BASE } from "../src/config.ts";

// ---- extractOrgSlug (pure) -----------------------------------------------------------

test("extractOrgSlug: a bare slug passes through, lowercased", () => {
  assert.equal(extractOrgSlug("acme"), "acme");
  assert.equal(extractOrgSlug("Acme-Corp"), "acme-corp");
  assert.equal(extractOrgSlug("  acme  "), "acme");
});

test("extractOrgSlug: a full org URL (any scheme/host) yields the slug", () => {
  assert.equal(extractOrgSlug("https://deployforward.dev/org/acme"), "acme");
  assert.equal(extractOrgSlug("https://deployforward.dev/org/acme/"), "acme");
  assert.equal(extractOrgSlug("http://localhost:3000/org/Acme-Corp"), "acme-corp");
  assert.equal(extractOrgSlug("deployforward.dev/org/acme?ref=x"), "acme");
});

test("extractOrgSlug: empty / whitespace-only / no-slug-shape input returns null", () => {
  assert.equal(extractOrgSlug(""), null);
  assert.equal(extractOrgSlug("   "), null);
  assert.equal(extractOrgSlug("https://deployforward.dev/leaderboard"), null);
  assert.equal(extractOrgSlug("two words"), null);
});

// ---- renderOrgErrorLine (pure, C11's table) ------------------------------------------

test("renderOrgErrorLine: every documented C11 code renders a non-empty, honest line", () => {
  const codes = [
    "invalid_device_token",
    "malformed_token",
    "invite_not_found",
    "invite_expired",
    "invite_revoked",
    "invite_accepted",
    "invite_exhausted",
    "invite_login_mismatch",
    "invite_unbound",
    "identity_gate",
    "already_member",
    "org_not_found",
    "request_cap_user",
    "request_cap_org",
    "request_denied_cooldown",
    "last_admin",
    "not_a_member",
    "network",
  ];
  for (const code of codes) {
    const line = renderOrgErrorLine(code);
    assert.ok(line.length > 0, `code ${code} must render a line`);
    assert.doesNotMatch(line, /undefined|\[object/, `code ${code} must never leak a raw value`);
  }
});

test("renderOrgErrorLine: invite_unbound names the web origin (default APP_BASE, or an injected one)", () => {
  assert.match(renderOrgErrorLine("invite_unbound"), new RegExp(APP_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(renderOrgErrorLine("invite_unbound", { origin: "https://custom.example" }), /https:\/\/custom\.example\/join/);
});

test("renderOrgErrorLine: an UNRECOGNIZED code renders a safe fallback, never throws or blanks", () => {
  const line = renderOrgErrorLine("some_future_code_nobody_pinned_yet");
  assert.ok(line.includes("some_future_code_nobody_pinned_yet"));
});

// ---- pure response mappers ------------------------------------------------------------

test("mapInviteRedeemResponse: a well-formed 200 body maps to a typed success", () => {
  const r = mapInviteRedeemResponse(200, { ok: true, orgId: "org1", orgLabel: "Acme", role: "member", teamId: "team1" });
  assert.deepEqual(r, { ok: true, orgId: "org1", orgLabel: "Acme", role: "member", teamId: "team1" });
});

test("mapInviteRedeemResponse: teamId omitted -> null, never undefined leaking through", () => {
  const r = mapInviteRedeemResponse(200, { ok: true, orgId: "org1", orgLabel: "Acme", role: "member" });
  assert.equal((r as { teamId: string | null }).teamId, null);
});

test("mapInviteRedeemResponse: a 403 error body maps to the reason code, not a guessed success", () => {
  const r = mapInviteRedeemResponse(403, { error: "invite_login_mismatch" });
  assert.deepEqual(r, { ok: false, code: "invite_login_mismatch", status: 403, restoreBy: undefined });
});

test("mapInviteRedeemResponse: a 2xx body missing the documented shape falls through to unknown, never a false success", () => {
  const r = mapInviteRedeemResponse(200, { surprising: true });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "unknown");
});

test("mapJoinRequestResponse: alreadyPending is a SUCCESS (spec E10), not an error", () => {
  const r = mapJoinRequestResponse(200, { orgId: "org1", orgLabel: "Acme", alreadyPending: true, expiresAt: 123 });
  assert.deepEqual(r, { ok: true, orgId: "org1", orgLabel: "Acme", alreadyPending: true, expiresAt: 123 });
});

test("mapJoinRequestResponse: a fresh request omits alreadyPending -> false, not undefined", () => {
  const r = mapJoinRequestResponse(200, { orgId: "org1", orgLabel: "Acme" });
  assert.equal((r as { alreadyPending: boolean }).alreadyPending, false);
});

test("mapJoinRequestResponse: 429 request_cap_org maps through honestly", () => {
  const r = mapJoinRequestResponse(429, { error: "request_cap_org" });
  assert.deepEqual(r, { ok: false, code: "request_cap_org", status: 429, restoreBy: undefined });
});

test("mapCancelRequestResponse: 200 ok is success (idempotent, spec E16), any non-2xx is the mapped error", () => {
  assert.deepEqual(mapCancelRequestResponse(200, {}), { ok: true });
  assert.deepEqual(mapCancelRequestResponse(404, { error: "request_not_found" }), { ok: false, code: "request_not_found", status: 404, restoreBy: undefined });
});

test("mapLeaveOrgResponse: 200 ok is success, 409 last_admin maps through honestly", () => {
  assert.deepEqual(mapLeaveOrgResponse(200, {}), { ok: true });
  assert.deepEqual(mapLeaveOrgResponse(409, { error: "last_admin" }), { ok: false, code: "last_admin", status: 409, restoreBy: undefined });
});

test("account_deleted: restoreBy is threaded through when the server sends it", () => {
  const r = mapInviteRedeemResponse(403, { error: "account_deleted", restoreBy: 999 });
  assert.deepEqual(r, { ok: false, code: "account_deleted", status: 403, restoreBy: 999 });
});

// ---- network functions (fetchImpl injected — NEVER the real network) -----------------

function fakeFetch(status: number, body: unknown, opts: { throws?: boolean } = {}): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (opts.throws) throw new Error("simulated network failure");
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const PAIRED = { apiBase: "http://mock.invalid/api", deviceToken: "tok-abc" };
const UNPAIRED = { apiBase: "http://mock.invalid/api", deviceToken: null };

test("redeemInviteCode: no device token -> invalid_device_token, ZERO network calls", async () => {
  const { impl, calls } = fakeFetch(200, { ok: true, orgId: "x", orgLabel: "X", role: "member" });
  const r = await redeemInviteCode(UNPAIRED, "acme:secret", impl);
  assert.deepEqual(r, { ok: false, code: "invalid_device_token", status: 401 });
  assert.equal(calls.length, 0, "an unpaired device must never reach the network");
});

test("redeemInviteCode: posts to /org/invite/redeem with the device bearer + { token }, maps a success", async () => {
  const { impl, calls } = fakeFetch(200, { ok: true, orgId: "org1", orgLabel: "Acme", role: "member", teamId: null });
  const r = await redeemInviteCode(PAIRED, "acme:secretcode", impl);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${PAIRED.apiBase}/org/invite/redeem`);
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, `Bearer ${PAIRED.deviceToken}`);
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { token: "acme:secretcode" });
});

test("redeemInviteCode: a network throw resolves to a typed 'network' error, never an unhandled rejection", async () => {
  const { impl } = fakeFetch(200, {}, { throws: true });
  const r = await redeemInviteCode(PAIRED, "acme:secret", impl);
  assert.deepEqual(r, { ok: false, code: "network", status: 0 });
});

test("redeemInviteCode: invite_unbound (device-only rejection, spec E20) maps through honestly", async () => {
  const { impl } = fakeFetch(403, { error: "invite_unbound" });
  const r = await redeemInviteCode(PAIRED, "acme:secret", impl);
  assert.deepEqual(r, { ok: false, code: "invite_unbound", status: 403, restoreBy: undefined });
});

test("requestToJoinOrg: no device token -> invalid_device_token, zero network calls", async () => {
  const { impl, calls } = fakeFetch(200, { orgId: "x", orgLabel: "X" });
  const r = await requestToJoinOrg(UNPAIRED, "acme", undefined, impl);
  assert.deepEqual(r, { ok: false, code: "invalid_device_token", status: 401 });
  assert.equal(calls.length, 0);
});

test("requestToJoinOrg: an unparseable identifier fails CLIENT-SIDE (org_not_found), zero network calls", async () => {
  const { impl, calls } = fakeFetch(200, {});
  const r = await requestToJoinOrg(PAIRED, "https://deployforward.dev/leaderboard", undefined, impl);
  assert.deepEqual(r, { ok: false, code: "org_not_found", status: 404 });
  assert.equal(calls.length, 0, "a slug that cannot be parsed must never reach the network");
});

test("requestToJoinOrg: accepts a bare slug OR a full org URL, posts the EXTRACTED slug + optional message", async () => {
  const { impl, calls } = fakeFetch(200, { orgId: "org1", orgLabel: "Acme" });
  await requestToJoinOrg(PAIRED, "https://deployforward.dev/org/Acme/", "please let me in", impl);
  assert.equal(calls[0].url, `${PAIRED.apiBase}/org/request`);
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { slug: "acme", message: "please let me in" });
});

test("requestToJoinOrg: message omitted -> the key itself is omitted, not sent as undefined/null", async () => {
  const { impl, calls } = fakeFetch(200, { orgId: "org1", orgLabel: "Acme" });
  await requestToJoinOrg(PAIRED, "acme", undefined, impl);
  const body = JSON.parse(calls[0].init?.body as string);
  assert.deepEqual(body, { slug: "acme" });
  assert.ok(!("message" in body));
});

test("requestToJoinOrg: request_denied_cooldown (spec E21, deny durability) maps through honestly", async () => {
  const { impl } = fakeFetch(429, { error: "request_denied_cooldown" });
  const r = await requestToJoinOrg(PAIRED, "acme", undefined, impl);
  assert.deepEqual(r, { ok: false, code: "request_denied_cooldown", status: 429, restoreBy: undefined });
});

test("cancelJoinRequest: posts { orgId } to /org/request/cancel with the device bearer", async () => {
  const { impl, calls } = fakeFetch(200, {});
  const r = await cancelJoinRequest(PAIRED, "org1", impl);
  assert.deepEqual(r, { ok: true });
  assert.equal(calls[0].url, `${PAIRED.apiBase}/org/request/cancel`);
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { orgId: "org1" });
});

test("cancelJoinRequest: no device token -> invalid_device_token, zero network calls", async () => {
  const { impl, calls } = fakeFetch(200, {});
  const r = await cancelJoinRequest(UNPAIRED, "org1", impl);
  assert.deepEqual(r, { ok: false, code: "invalid_device_token", status: 401 });
  assert.equal(calls.length, 0);
});

test("leaveOrgDevice: posts to /org/leave with the device bearer, no orgId needed (server infers from the token)", async () => {
  const { impl, calls } = fakeFetch(200, {});
  const r = await leaveOrgDevice(PAIRED, impl);
  assert.deepEqual(r, { ok: true });
  assert.equal(calls[0].url, `${PAIRED.apiBase}/org/leave`);
});

test("leaveOrgDevice: last_admin (spec E19) maps through honestly, never a false success", async () => {
  const { impl } = fakeFetch(409, { error: "last_admin" });
  const r = await leaveOrgDevice(PAIRED, impl);
  assert.deepEqual(r, { ok: false, code: "last_admin", status: 409, restoreBy: undefined });
});

test("leaveOrgDevice: no device token -> invalid_device_token, zero network calls", async () => {
  const { impl, calls } = fakeFetch(200, {});
  const r = await leaveOrgDevice(UNPAIRED, impl);
  assert.deepEqual(r, { ok: false, code: "invalid_device_token", status: 401 });
  assert.equal(calls.length, 0);
});
