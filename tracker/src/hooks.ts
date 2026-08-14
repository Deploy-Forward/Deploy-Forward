/**
 * Claude Code hook integration — presence AND the sync daemon.
 *
 * `login`/`start` install lightweight hooks into ~/.claude/settings.json that invoke
 * `deploy-forward beat` on session lifecycle events. Each beat refreshes your
 * "building now" presence, and on turn/session end it spawns a DETACHED, debounced
 * one-shot sync — so the agent harness itself is the daemon: no resident process, no
 * terminal to babysit, data syncs exactly when new transcript data exists. We merge
 * into the existing hooks config rather than overwriting, and tag our entries so they
 * can be cleanly removed.
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { loadState } from "./config.js";

const DF_TAG = "deployforward-buildboard";
const BEAT_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] as const;

function settingsPath(): string {
  return process.env.DF_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
}

/**
 * Absolute, collision-proof invocation of THIS tracker binary. A bare `df` resolves to the
 * coreutils disk-free command on most machines (`df: unknown option -- event`), so the hook
 * must call the exact entry via node. Forward slashes work in both bash and cmd on Windows.
 *
 * DEV-RUN GUARD (the "Stop hook error: ERR_MODULE_NOT_FOUND auth.js" bug, 2026-07-09):
 * a tsx run's entry is bin/df.ts, whose `../src/*.js` import specifiers only resolve
 * under tsx — but hooks execute with PLAIN node (execPath is node even under tsx), which
 * type-strips df.ts and then fails to find src/*.js. So a hook installed from a dev run
 * fired that error on every Stop event. Fix: a .ts entry is remapped to its compiled
 * dist twin (dist/bin/df.js — always present, tsc runs on prepare); if that is missing,
 * fall back to the published package via npx (never bare `df`, per the collision above).
 */
export function resolveRunnableEntry(
  argv1: string | undefined = process.argv[1],
  fileExists: (p: string) => boolean = existsSync,
): string | null {
  let entry = argv1 ? resolve(argv1) : null;
  if (entry && /\.(ts|mts|cts)$/i.test(entry)) {
    const compiled = resolve(dirname(entry), "..", "dist", "bin", "df.js");
    entry = fileExists(compiled) ? compiled : null;
  }
  return entry;
}

export function cliInvocation(
  execPath: string = process.execPath,
  argv1: string | undefined = process.argv[1],
  fileExists: (p: string) => boolean = existsSync,
): string {
  const node = execPath.replace(/\\/g, "/");
  const entry = resolveRunnableEntry(argv1, fileExists);
  return entry ? `"${node}" "${entry.replace(/\\/g, "/")}"` : "npx -y deploy-forward";
}

function dfHookEntry(event: string, invoke: string) {
  return {
    _source: DF_TAG,
    hooks: [{ type: "command", command: `${invoke} beat --event ${event}` }],
  };
}

/**
 * Is this hook entry one of OURS — tagged or not? Pre-0.9.x installs wrote entries
 * WITHOUT the _source tag, so the tag-only dedup below let one orphan per historical
 * install location accumulate forever (npx cache dirs get evicted; each orphan then
 * fails every prompt with a red "exit code 1" — Marco hit 6 of them, 2026-07-10).
 * Recognize ours by the command shape instead: some hook command invoking a
 * deploy-forward entry (df.js/df.ts or the npx package) with our `beat --event` verb.
 * The `beat --event` requirement keeps this from ever matching another product's
 * hook that merely mentions deploy-forward.
 */
export function isDfBeatEntry(entry: unknown): boolean {
  const hooks = (entry as { hooks?: Array<{ command?: unknown }> })?.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) => typeof h?.command === "string" && /(deploy-forward|df\.(js|ts))"? +beat +--event\b/.test(h.command),
  );
}

export function installHooks(): void {
  const p = settingsPath();
  let settings: any = {};
  if (existsSync(p)) {
    try {
      settings = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      // NEVER clobber a file we couldn't parse: settings.json holds the user's ENTIRE
      // Claude Code config (permissions, hooks, everything). Overwriting it with {} to
      // install our hooks would be catastrophic data loss for a config typo. Abort and
      // say so — the same posture uninstallHooks already takes.
      console.error(`  ✗ Could not parse ${p} — fix the JSON and re-run (hooks NOT installed, file untouched).`);
      return;
    }
  }
  settings.hooks ??= {};

  const invoke = cliInvocation();
  for (const event of BEAT_EVENTS) {
    const list: any[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    // Remove EVERY prior entry of ours — tagged (_source) or legacy-untagged
    // (isDfBeatEntry) — so exactly one entry per event survives a re-install from any
    // location. Self-heals the orphan accumulation described on isDfBeatEntry.
    const withoutOurs = list.filter((e) => e?._source !== DF_TAG && !isDfBeatEntry(e));
    settings.hooks[event] = [...withoutOurs, dfHookEntry(event, invoke)];
  }

  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(settings, null, 2));
  console.log(`  ✓ Installed Deploy Forward presence hooks into ${p}`);
}

/**
 * Grok's frozen copy of Claude's hooks. Grok's `[claude_compat] imported = true` snapshots
 * ~/.claude/settings.json into THIS file ONCE and never re-syncs — so a duplicate that
 * accumulated in settings.json before the import is frozen here forever, and grok runs it
 * on every event IN ADDITION to its live compat-scan of settings.json (Marco, 2026-07-14:
 * six beats per prompt, the stale ones red "exit code 1"). Home resolution mirrors
 * grok.ts's grokHome() (DF_GROK_HOME override honored) — inlined to keep hooks.ts free of a
 * grok.ts import. */
function grokImportedHooksPath(): string {
  const home = process.env.DF_GROK_HOME ?? join(homedir(), ".grok");
  return join(home, "hooks", "imported-from-claude.json");
}

/** Our beat entries in one event's list — tagged (_source) OR legacy-untagged (shape). */
function ourBeatEntries(list: unknown[]): unknown[] {
  return list.filter((e) => (e as { _source?: string })?._source === DF_TAG || isDfBeatEntry(e));
}

/**
 * Collapse DUPLICATE beat entries down to one current entry, in place, on a hooks map.
 * Only touches an event that ALREADY has MORE THAN ONE of ours — never introduces a beat
 * where none exists (the "never install native ~/.grok/hooks / double-fire" invariant:
 * de-duplication is cleanup, not installation) and never rewrites a already-single event
 * (so a clean install serializes byte-identical -> no needless write). Returns whether
 * anything changed. Non-df entries are preserved verbatim.
 */
function collapseDuplicateBeats(hooksMap: Record<string, unknown>, invoke: string): boolean {
  let changed = false;
  for (const event of Object.keys(hooksMap)) {
    const list = Array.isArray(hooksMap[event]) ? (hooksMap[event] as unknown[]) : [];
    if (ourBeatEntries(list).length <= 1) continue; // 0 or 1 -> nothing to heal here
    const withoutOurs = list.filter(
      (e) => (e as { _source?: string })?._source !== DF_TAG && !isDfBeatEntry(e),
    );
    hooksMap[event] = [...withoutOurs, dfHookEntry(event, invoke)];
    changed = true;
  }
  return changed;
}

/** The pinned entry path inside a beat command (`"node" "<entry>" beat ...`), or null
 * for the npx-fallback form (`npx -y deploy-forward beat ...`), which has no path to rot. */
function pinnedEntryOf(command: string): string | null {
  const m = /^"[^"]+" "([^"]+)" beat /.exec(command);
  return m ? m[1] : null;
}

/** Re-pin OUR beat entries whose pinned binary no longer exists — the npx cache is
 * disposable (a purge, or a publish swapping @latest to a new cache dir, deletes the
 * old install) and a dead pin makes EVERY session event error MODULE_NOT_FOUND.
 * installHooks never repairs this (`!hooksInstalled()` short-circuits on entries that
 * are present-but-dead), so the heal is the only path back. */
function repinDeadBeats(
  hooksMap: Record<string, unknown>,
  invoke: string,
  fileExists: (p: string) => boolean = existsSync,
): boolean {
  let changed = false;
  for (const event of Object.keys(hooksMap)) {
    const list = Array.isArray(hooksMap[event]) ? (hooksMap[event] as unknown[]) : [];
    hooksMap[event] = list.map((e) => {
      const entry = e as { _source?: string; hooks?: { command?: string }[] };
      if (entry?._source !== DF_TAG && !isDfBeatEntry(e)) return e;
      const pinned = pinnedEntryOf(entry.hooks?.[0]?.command ?? "");
      if (pinned === null || fileExists(pinned)) return e;
      changed = true;
      return dfHookEntry(event, invoke);
    });
  }
  return changed;
}

/** Heal one JSON settings file's hooks map, writing ONLY when something actually
 * changed (a duplicate collapsed, or a dead pin replaced).
 * Soft: a missing or unparseable file is left untouched (never clobber the user's config). */
function healHookFile(path: string, hooksAt: (doc: any) => Record<string, unknown> | undefined): void {
  if (!existsSync(path)) return;
  let doc: any;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return; // never clobber a file we couldn't parse (installHooks takes the same posture)
  }
  const map = hooksAt(doc);
  if (!map || typeof map !== "object") return;
  const invoke = cliInvocation();
  const collapsed = collapseDuplicateBeats(map, invoke);
  const repinned = repinDeadBeats(map, invoke);
  if (collapsed || repinned) {
    writeFileSync(path, JSON.stringify(doc, null, 2));
  }
}

/**
 * Idempotent self-heal for beat-hook DUPLICATE accumulation. installHooks() already
 * collapses to exactly one, but only runs at SETUP (the bare run's `if (!hooksInstalled())`
 * short-circuits once ANY entry exists), so a second live entry appended between setups —
 * every `npx --yes deploy-forward@latest` fetches a fresh npm-cache path, and npx keeps every cached
 * version — persists and fires on every event. Runs on the returning-run so ordinary use
 * self-heals; writes only when it actually removes a duplicate. Reaches TWO surfaces:
 * ~/.claude/settings.json (which Claude AND Grok's compat-scan both execute) and Grok's
 * frozen import copy (which installHooks never touched). Both heals are soft — a hook path
 * must never break a bare run.
 */
export function healHooks(): void {
  healHookFile(settingsPath(), (d) => d?.hooks);
  healHookFile(grokImportedHooksPath(), (d) => d?.hooks);
}

/** Are our tagged hook entries present in the Claude Code settings? (wizard/status) */
export function hooksInstalled(): boolean {
  const p = settingsPath();
  if (!existsSync(p)) return false;
  try {
    const settings = JSON.parse(readFileSync(p, "utf8"));
    return BEAT_EVENTS.some((event) =>
      Array.isArray(settings?.hooks?.[event]) &&
      settings.hooks[event].some((e: any) => e?._source === DF_TAG),
    );
  } catch {
    return false;
  }
}

export function uninstallHooks(): void {
  const p = settingsPath();
  if (!existsSync(p)) return;
  let settings: any;
  try {
    settings = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return;
  }
  if (!settings.hooks) return;
  for (const event of BEAT_EVENTS) {
    if (Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = settings.hooks[event].filter(
        (e: any) => e?._source !== DF_TAG && !isDfBeatEntry(e),
      );
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
  }
  writeFileSync(p, JSON.stringify(settings, null, 2));
  console.log("  ✓ Removed Deploy Forward presence hooks");
}

/**
 * Which harness actually invoked this hook process? The SAME ~/.claude/settings.json
 * entry is executed by Claude Code AND by Grok CLI (Grok scans Claude's settings
 * natively as a compat source), so the command line cannot distinguish them — only
 * the environment can. Grok's hook runner injects GROK_HOOK_EVENT / GROK_SESSION_ID
 * as RESERVED variables on every hook (docs/user-guide/10-hooks.md) and ALSO sets
 * CLAUDE_PROJECT_DIR as a compat alias, so the GROK_* check must come first.
 * Without this, Grok sessions present as claude_code in the live ticker (G3 honesty
 * fix, docs/grok-capture-plan.md).
 */
export function detectBeatTool(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GROK_HOOK_EVENT || env.GROK_SESSION_ID) return "grok";
  return "claude_code";
}

/**
 * Should this beat spawn a sync? Pure + unit-tested. Turn ends (Stop) sync on a lazy
 * 5-minute debounce; session boundaries (SessionStart/SessionEnd) on a tight 60s one
 * (SessionStart also catches up anything missed while the machine was off). Prompt
 * beats are presence-only — syncing mid-turn would race the transcript being written.
 */
export function syncDueForEvent(event: string, lastSyncAt: number, now: number): boolean {
  const age = now - lastSyncAt;
  if (event === "SessionEnd" || event === "SessionStart") return age > 60_000;
  if (event === "Stop") return age > 5 * 60_000;
  return false;
}

export async function beat(event: string): Promise<void> {
  const state = loadState();
  if (!state.deviceToken) return; // silently no-op if unpaired; hooks must never block

  // THE DAEMON: spawn a detached one-shot `sync` when due, then return immediately.
  // Fire-and-forget (unref, ignored stdio) — a hook must never block a Claude Code
  // session or surface errors into it, and the child stamps lastSyncAt itself.
  try {
    // Same dev-run guard as cliInvocation: a .ts entry remaps to the compiled dist twin
    // so the detached child runs under plain node without the tsx loader.
    const entry = syncDueForEvent(event, state.lastSyncAt, Date.now()) ? resolveRunnableEntry() : null;
    if (entry) {
      spawn(process.execPath, [entry, "sync"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    }
  } catch {
    /* best-effort */
  }

  try {
    await fetch(`${state.apiBase}/beat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${state.deviceToken}`,
      },
      body: JSON.stringify({ tool: detectBeatTool(), event }),
    });
  } catch {
    /* presence is best-effort; never surface errors into a Claude Code session */
  }
}
