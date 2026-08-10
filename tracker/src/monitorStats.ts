import type { TrackerState } from "./config.js";

export interface ProviderCounts {
  claude: number;
  codex: number;
  grok: number;
  pi: number;
  openclaw: number;
  opencode: number;
  hermes: number;
  copilot: number;
}

export interface MonitorStats {
  files: ProviderCounts;
  sessions: ProviderCounts;
}

export function isCodexRolloutPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  const name = p.slice(p.lastIndexOf("/") + 1);
  return p.includes("/.codex/sessions/") && name.startsWith("rollout-") && name.endsWith(".jsonl");
}

/** The Grok CLI writes ONE cumulative log (~/.grok/logs/unified.jsonl, or a DF_GROK_HOME
 * override in tests) — so grok "files" counts that single cursor, while its sessions
 * count by digest like every provider. Matched by the stable logs/unified.jsonl tail,
 * never the home prefix (the override moves the home, not the layout). */
export function isGrokLogPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().endsWith("/logs/unified.jsonl");
}

/** pi.dev writes ONE JSONL file per session under a --cwd---encoded subdirectory of
 * agent/sessions/ (pi.ts's file header) -- so pi "files" counts real per-session
 * cursors, the same per-file idiom Claude/Codex use, not one aggregate cursor like
 * Grok's single log file. Matched by the stable "/agent/sessions/" path segment, never
 * the home prefix (a DF_PI_HOME override moves the home, not the layout). */
export function isPiSessionPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().includes("/agent/sessions/");
}

/** OpenClaw writes ONE JSONL file per session under agents/<agentId>/sessions/
 * (openclaw.ts's header, re-based off SQLite onto JSONL 2026-07-14) -- sync.ts's real
 * per-file byte-size cursor makes "files" count real session files, the SAME
 * per-file idiom Claude/Codex/pi use, not a per-agent-db aggregate the way the old
 * SQLite-backed adapter counted. Matched by the "/agents/<id>/sessions/...jsonl" path
 * shape, excluding the .trajectory.jsonl sidecar (never a cursor'd file -- openclaw.ts
 * never discovers it), never the home prefix (a DF_OPENCLAW_HOME override moves the
 * home, not the per-agent layout). */
export function isOpenClawSessionPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  return /\/agents\/[^/]+\/sessions\/.+\.jsonl$/.test(p) && !p.endsWith(".trajectory.jsonl");
}

/** opencode can have more than one db file coexisting (a builder who switched install
 * channels: opencode.db, or opencode-<channel>.db -- opencode.ts's header). Matched by
 * filename only (never a directory prefix, since DF_OPENCODE_HOME moves the home, not the
 * filename convention), so "files" counts real db files, not sessions. */
export function isOpencodeDbPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  const name = p.slice(p.lastIndexOf("/") + 1);
  return name === "opencode.db" || /^opencode-[a-z0-9._-]+\.db$/.test(name);
}

/** Hermes keeps ONE SQLite db (~/.hermes/state.db, hermes.ts's header) -- like Grok's
 * single log file, "files" for Hermes counts that one cursor, never a per-session count
 * (there is no per-session file at all for a SQLite adapter). Matched by the stable
 * state.db tail, never the home prefix (a DF_HERMES_HOME override moves the home only). */
export function isHermesDbPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().endsWith("/state.db");
}

/** Copilot CLI keeps ONE SQLite db (~/.copilot/session-store.db, copilot.ts's header) --
 * like Hermes/Grok's single files, "files" for Copilot counts that one cursor. Matched
 * by the stable session-store.db tail, never the home prefix (a DF_COPILOT_HOME override
 * moves the home only). */
export function isCopilotDbPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().endsWith("/session-store.db");
}

export function monitorStats(state: Pick<TrackerState, "cursors" | "threadDigests">): MonitorStats {
  const files: ProviderCounts = { claude: 0, codex: 0, grok: 0, pi: 0, openclaw: 0, opencode: 0, hermes: 0, copilot: 0 };
  const sessions: ProviderCounts = { claude: 0, codex: 0, grok: 0, pi: 0, openclaw: 0, opencode: 0, hermes: 0, copilot: 0 };

  for (const path of Object.keys(state.cursors ?? {})) {
    if (isCodexRolloutPath(path)) files.codex++;
    else if (isGrokLogPath(path)) files.grok++;
    else if (isPiSessionPath(path)) files.pi++;
    else if (isOpenClawSessionPath(path)) files.openclaw++;
    // SQLite adapters carry no session-grain file paths at all (opencode/hermes/copilot.ts
    // headers) -- these checks classify the per-db byte-size cursors sync.ts writes for
    // them, distinct from the "one file = one session" providers above.
    else if (isOpencodeDbPath(path)) files.opencode++;
    else if (isHermesDbPath(path)) files.hermes++;
    else if (isCopilotDbPath(path)) files.copilot++;
    else files.claude++;
  }

  for (const key of Object.keys(state.threadDigests ?? {})) {
    if (key.startsWith("codex_")) sessions.codex++;
    else if (key.startsWith("grok_")) sessions.grok++;
    else if (key.startsWith("pi_")) sessions.pi++;
    // SQLite adapters have no per-session file paths, so unlike files above, sessions
    // are classified the ONLY way available: the tool prefix on the digest key itself
    // (`${tool}_${toolSessionId}`, sync.ts's summaryDigest key) -- the same mechanism
    // every non-Claude provider already uses for its session count.
    else if (key.startsWith("openclaw_")) sessions.openclaw++;
    else if (key.startsWith("opencode_")) sessions.opencode++;
    else if (key.startsWith("hermes_")) sessions.hermes++;
    else if (key.startsWith("copilot_")) sessions.copilot++;
    else if (key.startsWith("claude_code_")) sessions.claude++;
  }

  return { files, sessions };
}

/** Grok/pi/OpenClaw/opencode/Hermes/Copilot segments render only when actually tracked —
 * a zero would read as "we looked and found nothing" on machines that never had that
 * CLI at all. */
export function formatProviderCounts(stats: MonitorStats): string {
  const grokFiles = stats.files.grok > 0 ? ` / Grok ${stats.files.grok}` : "";
  const grokSessions = stats.sessions.grok > 0 ? ` / Grok ${stats.sessions.grok}` : "";
  const piFiles = stats.files.pi > 0 ? ` / pi ${stats.files.pi}` : "";
  const piSessions = stats.sessions.pi > 0 ? ` / pi ${stats.sessions.pi}` : "";
  const openclawFiles = stats.files.openclaw > 0 ? ` / OpenClaw ${stats.files.openclaw}` : "";
  const openclawSessions = stats.sessions.openclaw > 0 ? ` / OpenClaw ${stats.sessions.openclaw}` : "";
  const opencodeFiles = stats.files.opencode > 0 ? ` / opencode ${stats.files.opencode}` : "";
  const opencodeSessions = stats.sessions.opencode > 0 ? ` / opencode ${stats.sessions.opencode}` : "";
  const hermesFiles = stats.files.hermes > 0 ? ` / Hermes ${stats.files.hermes}` : "";
  const hermesSessions = stats.sessions.hermes > 0 ? ` / Hermes ${stats.sessions.hermes}` : "";
  const copilotFiles = stats.files.copilot > 0 ? ` / Copilot ${stats.files.copilot}` : "";
  const copilotSessions = stats.sessions.copilot > 0 ? ` / Copilot ${stats.sessions.copilot}` : "";
  return `files Claude ${stats.files.claude} / Codex ${stats.files.codex}${grokFiles}${piFiles}${openclawFiles}${opencodeFiles}${hermesFiles}${copilotFiles} | sessions Claude ${stats.sessions.claude} / Codex ${stats.sessions.codex}${grokSessions}${piSessions}${openclawSessions}${opencodeSessions}${hermesSessions}${copilotSessions}`;
}
