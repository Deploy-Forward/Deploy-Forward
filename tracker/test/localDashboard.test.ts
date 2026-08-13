// localDashboard: the brand-aligned localhost render of super-start (issue #2's
// "hosted locally" surface). Seams under test:
//   - escapeHtml: every interpolated string passes through it (model ids and cwd
//     basenames are attacker-adjacent: they come from other tools' logs).
//   - renderDashboardHtml: PURE payload -> full HTML document. The page is
//     self-contained by contract: zero external asset loads (no <script src>, no
//     <link>, no url(http...), no @import) — the same never-phones-home posture
//     the tracker itself pins. Content is server-rendered: everything readable
//     with JavaScript disabled (client JS only refreshes).
//   - dashboardPayload: ShowcaseData -> JSON-safe payload stamped with version +
//     generatedAt (sessions detail deliberately dropped — lean wire).
//   - startDashboardServer: binds 127.0.0.1 ONLY, serves / (html) and /data.json
//     (fresh payload), 404s the rest.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  renderDashboardHtml,
  dashboardPayload,
  startDashboardServer,
  type DashboardPayload,
} from "../src/localDashboard.ts";
import { TRACKER_VERSION } from "../src/sync.ts";
import type { ShowcaseData } from "../src/superStart.ts";

function fixtureShowcase(): ShowcaseData {
  return {
    harnesses: [
      { name: "Claude", sessions: 12 },
      { name: "Grok", sessions: 3 },
    ],
    totalSessions: 15,
    tokenTotal: 1_000_000,
    modelRows: [
      { model: "grok-4.6", input: 286_900, output: 30_800, cacheRead: 6_100_000, cacheCreation: 0, total: 6_417_700 },
      { model: "<img src=x onerror=alert(1)>", input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 },
    ],
    spendTotalUsd: 12.34,
    activeHours: 7.5,
    sessions: [],
    spendIsPartial: true,
    days: Array.from({ length: 30 }, (_, i) => ({
      day: `2026-07-${String(i + 1).padStart(2, "0")}`,
      spendUsd: i === 29 ? 4.2 : 0,
      tokens: i === 29 ? 50_000 : 0,
    })),
    spend30dUsd: 4.2,
    codexLimits: {
      primary: { usedPercent: 37, windowMinutes: 300, resetsInSeconds: null },
      secondary: undefined,
    },
    claude5h: { blockStartMs: 1000, lastEntryMs: 2000, tokensUsed: 55_000, active: true, resetMs: 3000 },
    grokCredits: { percent: 41, periodType: "USAGE_PERIOD_TYPE_WEEKLY", periodStart: null, periodEnd: null, tier: null, ts: 0 },
  } as unknown as ShowcaseData;
}

test("escapeHtml neutralizes the five HTML metacharacters", () => {
  assert.equal(escapeHtml(`<img src="x" & 'y'>`), "&lt;img src=&quot;x&quot; &amp; &#39;y&#39;&gt;");
});

test("dashboardPayload stamps version + generatedAt and carries rows verbatim; sessions detail is dropped", () => {
  const now = Date.parse("2026-08-13T03:00:00.000Z");
  const p = dashboardPayload(fixtureShowcase(), now);
  assert.equal(p.version, TRACKER_VERSION);
  assert.equal(p.generatedAt, "2026-08-13T03:00:00.000Z");
  assert.equal(p.modelRows[0].model, "grok-4.6");
  assert.equal(p.modelRows[0].input, 286_900);
  assert.equal((p as unknown as Record<string, unknown>).sessions, undefined);
  // JSON round-trip must be lossless — this payload IS the /data.json body.
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
});

test("renderDashboardHtml: server-rendered content, hostile ids escaped, self-contained by contract", () => {
  const p = dashboardPayload(fixtureShowcase(), Date.parse("2026-08-13T03:00:00.000Z"));
  const html = renderDashboardHtml(p);

  // A full document with honest metadata.
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<title>[^<]*deploy-forward[^<]*<\/title>/i);

  // Content is visible WITHOUT JavaScript: the model table is in the HTML itself,
  // not conjured by a script (the invisible-content trap).
  assert.match(html, />grok-4\.6</);
  assert.match(html, />286,900</);

  // Hostile model id arrives escaped; the raw payload sits ONLY in the JSON island.
  assert.ok(!/<img src=x onerror/.test(html), "hostile model id must never land as live markup");
  assert.match(html, /&lt;img src=x onerror/);

  // Self-contained: no external asset loads of any kind.
  assert.ok(!/<script\s+[^>]*src=/i.test(html), "no external scripts");
  assert.ok(!/<link\s/i.test(html), "no <link> loads at all");
  assert.ok(!/url\(\s*['"]?https?:/i.test(html), "no CSS url() fetches");
  assert.ok(!/@import/i.test(html), "no CSS imports");
  assert.ok(!/<img\s/i.test(html), "no <img> — the mark is inline SVG");

  // Limits lanes: vendor-reported Codex renders its percent; the Claude 5h lane
  // carries the word "estimate" (never dressed as a vendor number).
  assert.match(html, /37%/);
  assert.match(html, /estimate/i);

  // Partial spend is marked, mirroring the CLI's trailing "+" honesty.
  assert.match(html, /\$12\.34\s*\+/);
});

test("vendor-reported Claude lanes render as REAL percent bars and replace the 5h estimate", () => {
  const data = fixtureShowcase();
  const p = dashboardPayload(data, Date.parse("2026-08-13T03:00:00.000Z"), {
    lanes: [
      { kind: "session", group: "session", percent: 100, severity: "warning", resetsAt: "2026-08-13T05:00:00.000Z", scopeLabel: null },
      { kind: "weekly_all", group: "weekly", percent: 41, severity: "ok", resetsAt: "2026-08-18T00:00:00.000Z", scopeLabel: null },
    ],
    note: null,
  });
  const html = renderDashboardHtml(p);
  // Real vendor percents drive real bar fills.
  assert.match(html, /width:100\.0%/);
  assert.match(html, /width:41\.0%/);
  assert.match(html, /Claude session/);
  assert.match(html, /Claude weekly/);
  // The replace rule: with vendor lanes present, the timestamp reconstruction and
  // its "estimate" label disappear entirely.
  assert.ok(!/estimate/i.test(html), "vendor lanes must replace the estimate, not sit beside it");
});

test("a vendor-lanes failure note surfaces beside the estimate lane, which stays", () => {
  const p = dashboardPayload(fixtureShowcase(), Date.parse("2026-08-13T03:00:00.000Z"), {
    lanes: null,
    note: "token expired — run: claude login",
  });
  const html = renderDashboardHtml(p);
  assert.match(html, /estimate/i);
  assert.match(html, /token expired/);
});

test("renderDashboardHtml: null spend renders as no-priced-usage, never $0.00", () => {
  const data = fixtureShowcase();
  (data as { spendTotalUsd: number | null }).spendTotalUsd = null;
  (data as { spend30dUsd: number | null }).spend30dUsd = null;
  const html = renderDashboardHtml(dashboardPayload(data, Date.now()));
  assert.ok(!/\$0\.00/.test(html), "unknown spend must not render as free");
});

test("startDashboardServer: 127.0.0.1 only, serves html + fresh json, 404s the rest", async () => {
  let calls = 0;
  const read = (): DashboardPayload => {
    calls += 1;
    return dashboardPayload(fixtureShowcase(), Date.parse("2026-08-13T03:00:00.000Z"));
  };
  const { server, port, url } = await startDashboardServer({ port: 0 }, read);
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const addr = server.address();
    assert.ok(addr && typeof addr === "object" && addr.address === "127.0.0.1", "must bind loopback only");

    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), />grok-4\.6</);

    const json = await fetch(`http://127.0.0.1:${port}/data.json`);
    assert.equal(json.status, 200);
    assert.match(json.headers.get("content-type") ?? "", /application\/json/);
    const body = (await json.json()) as DashboardPayload;
    assert.equal(body.version, TRACKER_VERSION);

    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(missing.status, 404);

    assert.ok(calls >= 2, "every request re-reads — the page is never a stale snapshot");
  } finally {
    server.close();
  }
});
