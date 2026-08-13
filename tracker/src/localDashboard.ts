/**
 * localDashboard — the brand-aligned localhost render of super-start (issue #2's
 * "hosted locally" surface): `deploy-forward serve` binds 127.0.0.1, serves one
 * self-contained HTML page plus /data.json, both re-read from disk per request.
 *
 * Posture, pinned by test/localDashboard.test.ts:
 *  - Loopback ONLY. The server never binds an outward interface.
 *  - Zero external asset loads: no <link>, no <script src>, no <img>, no CSS
 *    url()/@import fetches. The mark is inline SVG; fonts are local-or-fallback
 *    stacks. Opening the page can never phone anywhere.
 *  - Content is server-rendered: everything reads with JavaScript disabled. The
 *    client script only refreshes (fetches / again and swaps the body).
 *  - Same honesty rules as the CLI: null spend renders as "no priced usage"
 *    (never $0.00), partial spend carries the trailing "+", the Claude 5h lane
 *    says "estimate", and a lane with no vendor denominator gets no bar.
 *
 * Design system: the canonical Deploy Forward brand (web/src/app.css +
 * marketing/df-shell.css + Logo.svelte): paper #fbfbfa, ink #0a0c12, accent
 * #1d4ed8, teal #0d9488; JetBrains Mono for data, Work Sans for prose (both with
 * local fallback stacks — nothing is fetched); sharp corners, 1px hairlines.
 */
import { createServer, type Server } from "node:http";

import { TRACKER_VERSION } from "./sync.js";
import { readShowcaseData, type ShowcaseData, type ShowcaseDay, type ShowcaseHarness } from "./superStart.js";
import { estimateCostUsd, type UsageRow, type CodexRateLimits, type Claude5hBlock } from "./usageView.js";
import { composeLimitLanes, currentClaudeVendorLanes, type ClaudeVendorLanes } from "./limitLanes.js";
import type { ClaudeLimitLane } from "./limitsFetch.js";
import type { GrokCredits } from "./grok.js";

/** Default port for `deploy-forward serve` — uncommon on purpose, overridable with --port. */
export const DASHBOARD_DEFAULT_PORT = 4780;

// ---- payload ----------------------------------------------------------------------------------

export interface DashboardModelRow extends UsageRow {
  /** Estimated USD at canonical list rates, or null when unpriced — never guessed. */
  estCostUsd: number | null;
}

/** JSON-safe subset of ShowcaseData the page renders. Sessions detail is deliberately
 * dropped: the dashboard aggregates; per-session drill-down stays in the CLI. */
/** Vendor-reported Claude lanes (opt-in limitsFetch), or the reason they're absent.
 * lanes === null with note === null simply means "not opted in / not fetched" — the
 * page then falls back to the timestamp estimate, exactly like the CLI. */
export type DashboardClaudeVendor = ClaudeVendorLanes;

export interface DashboardPayload {
  version: string;
  generatedAt: string; // ISO
  harnesses: ShowcaseHarness[];
  totalSessions: number;
  tokenTotal: number;
  activeHours: number;
  modelRows: DashboardModelRow[];
  spendTotalUsd: number | null;
  spendIsPartial: boolean;
  days: ShowcaseDay[];
  spend30dUsd: number | null;
  codexLimits: CodexRateLimits | null;
  claude5h: Claude5hBlock | null;
  claudeLanes: ClaudeLimitLane[] | null;
  claudeLanesNote: string | null;
  grokCredits: GrokCredits | null;
}

export function dashboardPayload(
  data: ShowcaseData,
  now: number = Date.now(),
  vendor: DashboardClaudeVendor = { lanes: null, note: null },
): DashboardPayload {
  const payload: DashboardPayload = {
    version: TRACKER_VERSION,
    generatedAt: new Date(now).toISOString(),
    harnesses: data.harnesses,
    totalSessions: data.totalSessions,
    tokenTotal: data.tokenTotal,
    activeHours: data.activeHours,
    modelRows: data.modelRows.map((r) => ({ ...r, estCostUsd: estimateCostUsd(r, r.model) })),
    spendTotalUsd: data.spendTotalUsd,
    spendIsPartial: data.spendIsPartial,
    days: data.days,
    spend30dUsd: data.spend30dUsd,
    codexLimits: data.codexLimits,
    claude5h: data.claude5h,
    claudeLanes: vendor.lanes,
    claudeLanesNote: vendor.note,
    grokCredits: data.grokCredits,
  };
  // JSON-clean by construction: this object IS the /data.json body, so undefined
  // members (e.g. an absent secondary Codex window) must not survive to differ
  // from what a client would parse back.
  return JSON.parse(JSON.stringify(payload)) as DashboardPayload;
}

// ---- render -----------------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function comma(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** 1_234_567 -> "1.2M" — same magnitudes the CLI table prints. */
function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function money(v: number): string {
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The official mark, verbatim from web/src/lib/Logo.svelte. */
const MARK_SVG =
  '<svg class="mark" viewBox="0 0 128 128" aria-hidden="true" width="26" height="26">' +
  '<rect width="128" height="128" rx="26" fill="#1d4ed8"/>' +
  '<rect x="22" y="22" width="15" height="15" fill="#ffffff"/>' +
  '<rect x="91" y="22" width="15" height="15" fill="#ffffff"/>' +
  '<rect x="22" y="91" width="15" height="15" fill="#ffffff"/>' +
  '<rect x="91" y="91" width="15" height="15" fill="#ffffff"/>' +
  '<rect x="46" y="46" width="36" height="36" fill="#ffffff"/>' +
  "</svg>";

// Lane composition lives in limitLanes.ts — ONE seam shared with the CLI usage
// footer, so the two surfaces can never disagree about what a limit lane says.

const CSS = `
:root{
  --bg:#fbfbfa; --surface:#ffffff; --gray-50:#f5f5f4; --line:#edeeec; --line-2:#e2e3e0;
  --ink:#0a0c12; --gray-700:#2b3242; --gray-500:#727a89; --gray-400:#9aa1ad;
  --accent:#1d4ed8; --teal:#0d9488;
  --sans:'Work Sans',system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'JetBrains Mono',ui-monospace,'Cascadia Mono',Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--bg)}
body{font-family:var(--sans);color:var(--ink);line-height:1.5}
a{color:var(--accent);text-decoration:none}
.wrap{max-width:1060px;margin:0 auto;padding:0 32px}
header{border-bottom:1px solid var(--line);background:var(--surface)}
.head-row{display:flex;align-items:center;gap:12px;padding:18px 0}
.wordmark{font-weight:600;font-size:15px;letter-spacing:-.01em}
.head-meta{margin-left:auto;font-family:var(--mono);font-weight:700;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--gray-500)}
main{padding:40px 0 12px}
section{margin-bottom:44px}
h2{font-family:var(--mono);font-weight:700;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--gray-500);margin-bottom:16px}
/* The hero strip wears the mark's own geometry: the logo's four corner squares
   as registration marks framing this machine's numbers. */
.stats-frame{position:relative;padding:26px 30px;margin-bottom:44px}
.reg{position:absolute;width:7px;height:7px;background:var(--ink)}
.reg-tl{top:0;left:0}.reg-tr{top:0;right:0}.reg-bl{bottom:0;left:0}.reg-br{bottom:0;right:0}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:24px}
.stat b{display:block;font-family:var(--mono);font-weight:500;font-size:30px;letter-spacing:-.01em;line-height:1.25}
.stat span{font-size:12px;color:var(--gray-500)}
.money{color:var(--teal)}
.lane{display:flex;align-items:center;gap:14px;padding:7px 0}
.lane-label{flex:0 0 150px;font-size:13px}
.track{flex:1;height:8px;background:var(--line)}
.fill{height:8px;background:var(--accent);transform-origin:left}
.lane-detail{flex:0 0 auto;font-family:var(--mono);font-size:11.5px;color:var(--gray-500);min-width:150px;text-align:right}
.lane-detail-wide{flex:1}
.days{display:flex;align-items:flex-end;gap:3px;height:110px;border-bottom:1px solid var(--line-2)}
/* Day bars are the ONLY encoding of per-day magnitude, so they never animate in:
   an entrance reveal that stalls (throttled engine, screenshot pass) would hide
   real content. The lane fills may animate because their numbers always sit in
   the adjacent detail text. */
.day{flex:1;background:var(--accent);min-height:0}
.day.today{background:var(--ink)}
.day.zero{background:transparent}
.days-meta{display:flex;justify-content:space-between;margin-top:8px;font-family:var(--mono);font-size:10.5px;color:var(--gray-400)}
table{width:100%;border-collapse:collapse}
th{font-family:var(--mono);font-weight:700;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--gray-400);text-align:right;padding:0 0 8px 16px;border-bottom:1px solid var(--line-2)}
th:first-child{text-align:left;padding-left:0}
td{font-family:var(--mono);font-size:12.5px;text-align:right;padding:7px 0 7px 16px;border-bottom:1px solid var(--line);white-space:nowrap}
td:first-child{text-align:left;padding-left:0}
td.dim{color:var(--gray-500)}
td.money{color:var(--teal)}
tbody tr:hover td{background:var(--gray-50)}
.cols{display:grid;grid-template-columns:1fr 260px;gap:48px}
footer{border-top:1px solid var(--line);margin-top:14px;background:var(--surface)}
.foot-row{display:flex;align-items:center;justify-content:space-between;padding:16px 0 26px;font-family:var(--mono);font-size:10px;letter-spacing:.06em;color:var(--gray-400)}
@media (prefers-reduced-motion:no-preference){
  .fill{animation:growx .45s cubic-bezier(.2,.7,.2,1)}
}
@keyframes growx{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@media (max-width:820px){.stats{grid-template-columns:repeat(2,1fr);gap:20px}.cols{grid-template-columns:1fr}.wrap{padding:0 20px}.lane-detail{min-width:0}.stats-frame{padding:20px 22px}}
`;

const REFRESH_JS = `
(function(){
  function tick(){
    fetch('/').then(function(r){return r.text()}).then(function(t){
      var doc=new DOMParser().parseFromString(t,'text/html');
      if(doc.body)document.body.replaceChildren.apply(document.body,Array.prototype.slice.call(doc.body.childNodes));
    }).catch(function(){/* offline or closing — keep the last good render */});
  }
  setInterval(tick,15000);
})();
`;

export function renderDashboardHtml(p: DashboardPayload): string {
  const lanes = composeLimitLanes(p);
  const maxDayTokens = Math.max(1, ...p.days.map((d) => d.tokens));
  const spendTotal =
    p.spendTotalUsd === null ? "no priced usage" : money(p.spendTotalUsd) + (p.spendIsPartial ? " +" : "");
  const spend30 = p.spend30dUsd === null ? "no priced usage · 30d" : `${money(p.spend30dUsd)} est. spend · 30d`;

  const laneHtml = lanes
    .map((l) => {
      // No vendor denominator -> no bar AT ALL: an empty track would read as "0%
      // used", which is false. The detail text (already carrying "estimate")
      // stretches into the track's place instead.
      const bar =
        l.percent === null
          ? ""
          : `<div class="track"><div class="fill" style="width:${l.percent.toFixed(1)}%"></div></div>`;
      const detailClass = l.percent === null ? "lane-detail lane-detail-wide" : "lane-detail";
      return `<div class="lane"><div class="lane-label">${escapeHtml(l.label)}</div>${bar}<div class="${detailClass}">${escapeHtml(l.detail)}</div></div>`;
    })
    .join("\n");

  const dayHtml = p.days
    .map((d, i) => {
      const h = d.tokens === 0 ? 0 : Math.max(3, Math.round((d.tokens / maxDayTokens) * 104));
      const title = `${d.day} · ${compact(d.tokens)} tokens${d.spendUsd > 0 ? ` · ${money(d.spendUsd)}` : ""}`;
      const today = i === p.days.length - 1 ? " today" : "";
      return `<div class="day${d.tokens === 0 ? " zero" : ""}${today}" style="height:${h}px" title="${escapeHtml(title)}"></div>`;
    })
    .join("");

  const modelHtml = p.modelRows
    .map((r) => {
      const cost =
        r.estCostUsd === null ? '<td class="dim">unpriced</td>' : `<td class="money">${escapeHtml(money(r.estCostUsd))}</td>`;
      return (
        `<tr><td>${escapeHtml(r.model)}</td><td>${escapeHtml(comma(r.input))}</td>` +
        `<td>${escapeHtml(comma(r.output))}</td><td>${escapeHtml(compact(r.cacheRead))}</td>` +
        `<td>${escapeHtml(compact(r.cacheCreation))}</td><td>${escapeHtml(compact(r.total))}</td>${cost}</tr>`
      );
    })
    .join("\n");

  const harnessHtml = p.harnesses
    .map((h) => `<tr><td>${escapeHtml(h.name)}</td><td>${escapeHtml(comma(h.sessions))}</td></tr>`)
    .join("\n");

  const generated = p.generatedAt.replace("T", " ").replace(/\.\d+Z$/, "Z");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>deploy-forward — local usage</title>
<style>${CSS}</style>
</head>
<body>
<header><div class="wrap head-row">${MARK_SVG}<span class="wordmark">Deploy Forward</span><span class="head-meta">local · v${escapeHtml(p.version)} · ${escapeHtml(generated)}</span></div></header>
<main class="wrap">
<section class="stats-frame"><span class="reg reg-tl"></span><span class="reg reg-tr"></span><span class="reg reg-bl"></span><span class="reg reg-br"></span>
<div class="stats">
<div class="stat"><b>${escapeHtml(compact(p.tokenTotal))}</b><span>tokens read</span></div>
<div class="stat"><b>${escapeHtml(comma(p.totalSessions))}</b><span>sessions</span></div>
<div class="stat"><b>${escapeHtml(p.activeHours.toFixed(1))}h</b><span>active time</span></div>
<div class="stat"><b class="${p.spendTotalUsd === null ? "" : "money"}">${escapeHtml(spendTotal)}</b><span>api-equivalent spend</span></div>
</div>
</section>
${lanes.length > 0 ? `<section><h2>Limits</h2>\n${laneHtml}</section>` : ""}
<section><h2>Last 30 days</h2>
<div class="days">${dayHtml}</div>
<div class="days-meta"><span>${escapeHtml(p.days[0]?.day ?? "")}</span><span class="${p.spend30dUsd === null ? "" : "money"}">${escapeHtml(spend30)}</span><span>${escapeHtml(p.days[p.days.length - 1]?.day ?? "")}</span></div>
</section>
<section class="cols">
<div><h2>Model mix</h2>
<table><thead><tr><th>model</th><th>input</th><th>output</th><th>cache read</th><th>cache create</th><th>total</th><th>est. cost</th></tr></thead>
<tbody>
${modelHtml}
</tbody></table></div>
<div><h2>Harnesses</h2>
<table><thead><tr><th>harness</th><th>sessions</th></tr></thead>
<tbody>
${harnessHtml}
</tbody></table></div>
</section>
</main>
<footer><div class="wrap foot-row"><span>metadata only · local display · spend never ranks</span><a href="https://deployforward.dev">deployforward.dev</a></div></footer>
<script>${REFRESH_JS}</script>
</body>
</html>
`;
}

// ---- server -----------------------------------------------------------------------------------

export interface DashboardServer {
  server: Server;
  port: number;
  url: string;
}

// The consent-gated vendor fetch lives in limitLanes.ts (currentClaudeVendorLanes),
// shared with the CLI usage footer.

/**
 * Serve the dashboard on 127.0.0.1. Every request re-reads the corpus (readData
 * defaults to a fresh readShowcaseData pass plus the consent-gated vendor lanes) —
 * the page is never a stale snapshot. Loopback binding is part of the privacy
 * contract, not a default to override.
 */
export function startDashboardServer(
  opts: { port: number },
  readData: () => DashboardPayload | Promise<DashboardPayload> = async () =>
    dashboardPayload(readShowcaseData(), Date.now(), await currentClaudeVendorLanes()),
): Promise<DashboardServer> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const path = (req.url ?? "/").split("?")[0];
        if (path === "/") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(renderDashboardHtml(await readData()));
        } else if (path === "/data.json") {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(await readData()));
        } else {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("not found");
        }
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(`dashboard error: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : opts.port;
      resolve({ server, port, url: `http://127.0.0.1:${port}/` });
    });
  });
}
