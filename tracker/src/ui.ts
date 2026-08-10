/**
 * Deploy Forward CLI presentation — zero-dependency ANSI.
 *
 * Deliberately hand-rolled: the tracker ships with NO runtime dependencies (a small,
 * auditable package is part of the privacy story), so no TUI framework. Visual
 * language mirrors the product: monospace, the corner-bracket motif from the logo
 * ([1], [2/4]), one restrained accent, dim hints. Everything degrades to plain text
 * when stdout is not a TTY or NO_COLOR is set — hooks and CI must never see ANSI
 * garbage or a stuck spinner.
 */

const tty = process.stdout.isTTY === true && !process.env.NO_COLOR;

function paint(open: number, close: number) {
  return (s: string): string => (tty ? `[${open}m${s}[${close}m` : s);
}

/**
 * Which ground the brand is painted on. Truecolor bypasses the terminal's own palette,
 * so a light-background user gets NO say via their color scheme — the CLI has to pick a
 * legible blue itself. Set with $DF_THEME=light or the `--light` flag.
 */
let ground: "dark" | "light" = process.env.DF_THEME === "light" ? "light" : "dark";

export function setTheme(t: "dark" | "light"): void {
  ground = t;
}

/**
 * The brand blue for a given ground — the SAME brand, chosen for legibility, not taste.
 * Measured (WCAG, 2026-07-17): #60a5fa is 7.79:1 on #0a0a0a but only 2.44:1 on #fafafa
 * (failing even the large-text bar); #1d4ed8 — the logo tile's own blue, and the one the
 * website uses on white — is 6.42:1 on #fafafa and 2.95:1 on black. Neither works on
 * both grounds, so the ground decides.
 */
export function brandRgb(g: "dark" | "light" = ground): [number, number, number] {
  return g === "light" ? [29, 78, 216] : [96, 165, 250];
}

export const c = {
  bold: paint(1, 22),
  dim: paint(2, 22),
  accent: paint(36, 39), // cyan — the brand accent's terminal cousin
  ok: paint(32, 39), // green
  warn: paint(33, 39), // yellow
  err: paint(31, 39), // red
  /** The site's own number-blue on dark (#60a5fa — the hero-stat color in the web
   * mockups), stepping to the tile's #1d4ed8 on a light ground. Read at CALL time, so
   * `--light` works even though composeScreen holds this as a paint reference. */
  brand: (s: string): string => {
    if (!tty) return s;
    const [r, g, b] = brandRgb();
    return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
  },
  /** The brand tile: white on #1d4ed8 with a FULL reset — banner()'s exact treatment,
   * exposed so the full-screen showcase can carry the same lockup. */
  tile: (s: string): string => (tty ? `\x1b[48;2;29;78;216m\x1b[38;2;255;255;255m${s}\x1b[0m` : s),
};

/**
 * OSC 8 hyperlink — makes `text` clickable (ctrl-click / hover in Windows Terminal,
 * iTerm2, VS Code, GNOME Terminal). Costs ZERO visible cells, which is why it composes
 * with the frame's width math: callers measure the PLAIN text and apply this after.
 * Terminals without OSC 8 ignore the sequence and print the text unchanged; non-TTY
 * gets no escape at all, same gate as every other paint.
 */
export function link(url: string, text: string): string {
  return tty ? `\x1b]8;;${url}\x07${text}\x1b]8;;\x07` : text;
}

export const sym = {
  ok: c.ok("✓"), // ✓
  todo: c.accent("▸"), // ▸
  err: c.err("✗"), // ✗
  bar: c.dim("─"), // ─
};

/**
 * Clamp a single-line status string so it can never soft-wrap. A `\r`-rewritten
 * live line only stays ONE line while it is narrower than the terminal: at
 * >= columns the terminal wraps and `\r` returns to the start of the last
 * wrapped row, appending a new physical line on every repaint. Plain text only
 * (the live line carries no ANSI codes). `width` is the terminal column count;
 * unknown width (piped stdout) passes through untouched.
 */
export function clampLine(s: string, width: number | undefined = process.stdout.columns): string {
  if (!width || s.length < width) return s;
  const max = width - 1; // leave the last cell empty: writing into it wraps some terminals
  return max > 3 ? s.slice(0, max - 3) + "..." : s.slice(0, Math.max(0, max));
}

/**
 * Live-monitor line builder. Windows terminals can report `columns` a few characters
 * wider than they actually render (ConPTY/scrollbar off-by-a-few), so an exact-width
 * clamp still wraps — and one wrapped line turns \r-rewriting into scroll spam. This
 * renderer keeps a hard safety margin AND drops whole trailing segments (lowest
 * priority last) instead of mid-word truncation. Paint is applied AFTER width math,
 * so ANSI codes never count against the width.
 */
export interface LiveSegment {
  t: string;
  /** optional paint from `c` (e.g. c.dim, c.err) — applied after fitting. */
  c?: (s: string) => string;
}

const LIVE_SEP = " · ";
const LIVE_HARD_CAP = 160; // clear of any real terminal edge even when columns lies

export function renderLive(segs: LiveSegment[], width: number | undefined = process.stdout.columns): string {
  const max = Math.min(width ? width - 2 : LIVE_HARD_CAP, LIVE_HARD_CAP);
  const keep = [...segs];
  const plainLen = (list: LiveSegment[]) => 2 + list.map((s) => s.t).join(LIVE_SEP).length;
  while (keep.length > 1 && plainLen(keep) > max) keep.pop();
  return "  " + keep.map((s) => (s.c ? s.c(s.t) : s.t)).join(tty ? c.dim(LIVE_SEP) : LIVE_SEP);
}

/**
 * The product banner — mark + lockup (Marco 2026-07-10), rendered to MATCH the browser
 * logo: the brand-blue tile (#1d4ed8) with four small white corner squares and the big
 * white center square (the SVG's 5-square reticle). Truecolor background paints the
 * tile; small corners = ■, big center = full blocks. Non-TTY (piped logs, CI, hooks)
 * degrades to one plain line — never art in a log file. Carries the running version so
 * any screenshot answers "which build did npx fetch".
 */
export function banner(version?: string): void {
  const v = version ? "v" + version : "";
  if (!tty) {
    console.log(`deploy-forward ${v} — rank the humans, not the models. (${DOMAIN})`.replace(/\s+/g, " "));
    return;
  }
  // White-on-brand-blue tile row (SGR truecolor; every modern terminal incl. Windows
  // Terminal). Reset fully at the row end so the tile never bleeds into the text column.
  const tile = (row: string): string => `[48;2;29;78;216m[38;2;255;255;255m${row}[0m`;
  console.log("");
  console.log(`  ${tile(" ■   ■ ")}  ${c.bold("Deploy Forward")}${v ? " " + c.dim(v) : ""}`);
  console.log(`  ${tile("  ███  ")}  ${c.dim("rank the humans, not the models")}`);
  console.log(`  ${tile(" ■   ■ ")}  ${c.dim(DOMAIN)}`);
  console.log("");
}

/** The bare domain for banner display — the full APP_BASE URL lives in config.ts;
 * this is presentation only (no protocol noise in the lockup). */
const DOMAIN = "leaderboard.deployforward.dev";

/** A dim full-width-ish horizontal rule for sectioning dashboards (hard-capped well
 * under any real terminal width — same caution as renderLive). */
export function rule(): void {
  const w = Math.min(Math.max(20, (process.stdout.columns ?? 60) - 4), 72);
  console.log(`  ${c.dim("─".repeat(w))}`);
}

/** One walkthrough line explaining what the tracker does (and refuses to do). */
export function howItWorks(): void {
  console.log(`  ${c.bold("How it works")}`);
  console.log(`  ${sym.bar} Reads usage ${c.bold("metadata")} from your local agent sessions — Claude Code,`);
  console.log(`    ${c.dim("Codex, Grok, pi, OpenClaw, opencode, Hermes: tokens, models, timestamps, tool counts.")}`);
  console.log(`  ${sym.bar} ${c.bold("Never")} your code, prompts, or file contents — audit us: the`);
  console.log(`    ${c.dim("whole package is a few readable files, no dependencies.")}`);
  console.log(`  ${sym.bar} Build Score ranks ${c.bold("outcomes, efficiency, quality, consistency")}.`);
  console.log(`    ${c.dim("Tokens and spend are status, never rank — spending more can't move you up.")}`);
  console.log("");
}

/** A numbered wizard step header in the corner-bracket brand motif: [2/4] Title */
export function step(n: number, total: number, title: string): void {
  console.log(`  ${c.accent(`[${n}/${total}]`)} ${c.bold(title)}`);
}

/** Step result lines. */
export function done(text: string): void {
  console.log(`        ${sym.ok} ${text}`);
}
export function todo(text: string): void {
  console.log(`        ${sym.todo} ${text}`);
}
export function fail(text: string): void {
  console.log(`        ${sym.err} ${text}`);
}
export function hint(text: string): void {
  console.log(`          ${c.dim(text)}`);
}
export function blank(): void {
  console.log("");
}

/** The big pairing code, displayed the way the /pair page expects it typed. */
export function bigCode(code: string): void {
  console.log("");
  console.log(`        ${c.accent("[")} ${c.bold(code.split("").join(" "))} ${c.accent("]")}`);
  console.log("");
}

/**
 * One-line Y/n confirmation (node:readline, zero deps). Returns the default when the
 * answer is empty. Callers must handle non-TTY stdin BEFORE prompting — a headless run
 * must never hang on a question — so this throws if stdin is not interactive.
 */
export async function confirm(question: string, def = true): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error("confirm() requires an interactive terminal.");
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = def ? "[Y/n]" : "[y/N]";
    const ans = (await rl.question(`        ${question} ${c.dim(suffix)} `)).trim().toLowerCase();
    if (ans === "") return def;
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

/** Pure validator for choose(): a 1-based selection or null. Digits only — Enter alone
 * never selects (picking an identity path is consent; silence is not consent). */
export function parseChoice(answer: string, count: number): number | null {
  const t = answer.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= count ? n : null;
}

export interface ChoiceOption {
  label: string;
  /** dim explainer rendered after the label, aligned across options. */
  hint?: string;
}

/**
 * Numbered single-choice menu (node:readline, zero deps). Renders the options as an
 * indented list in the corner-bracket motif and asks until a valid number is typed.
 * Same contract as confirm(): callers must handle non-TTY BEFORE prompting.
 */
export async function choose(options: ChoiceOption[]): Promise<number> {
  if (!process.stdin.isTTY) throw new Error("choose() requires an interactive terminal.");
  const width = Math.max(...options.map((o) => o.label.length));
  console.log("");
  options.forEach((o, i) => {
    const label = o.hint ? o.label.padEnd(width + 3) + c.dim(o.hint) : o.label;
    console.log(`          ${c.accent(`[${i + 1}]`)} ${label}`);
  });
  console.log("");
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const n = parseChoice(await rl.question(`        Choose ${c.dim(`[1-${options.length}]`)} `), options.length);
      if (n !== null) return n;
      console.log(`        ${c.dim(`Type a number from 1 to ${options.length}.`)}`);
    }
  } finally {
    rl.close();
  }
}

/** A consent question with no answer-through-silence: Enter is not yes or no. */
export async function confirmRequired(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error("confirmRequired() requires an interactive terminal.");
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const ans = (await rl.question(`        ${question} ${c.dim("[y/n]")} `)).trim().toLowerCase();
      if (ans === "y" || ans === "yes") return true;
      if (ans === "n" || ans === "no") return false;
      console.log(`        ${c.dim("Choose y or n. Pressing Enter does not publish you.")}`);
    }
  } finally {
    rl.close();
  }
}

/**
 * Countdown spinner for the device-flow wait: repaints
 * `⠋ Waiting for authorization... (Ns remaining)` once a second until stopped.
 * The deadline comes from GitHub's `expires_in`, so the user sees exactly how long
 * the code stays valid. Non-TTY prints the label once — no control codes, no redraw.
 */
export function countdownSpinner(
  label: string,
  deadlineMs: number,
): { done: (text?: string) => void; fail: (text?: string) => void } {
  const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const line = (): string => {
    const remaining = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
    return `${label} ${c.dim(`(${remaining}s remaining)`)}`;
  };
  if (tty) {
    timer = setInterval(() => {
      process.stdout.write(`\r[2K        ${c.accent(FRAMES[i++ % FRAMES.length])} ${line()}`);
    }, 1000);
    process.stdout.write(`        ${c.accent(FRAMES[0])} ${line()}`);
  } else {
    console.log(`        … ${label}`);
  }
  const stop = (mark: string, text?: string): void => {
    if (timer) {
      clearInterval(timer);
      process.stdout.write("\r[2K");
    }
    console.log(`        ${mark} ${text ?? label}`);
  };
  return {
    done: (text?: string) => stop(sym.ok, text),
    fail: (text?: string) => stop(sym.err, text),
  };
}

/**
 * Minimal spinner. TTY: animates in place and resolves to a ✓/✗ line. Non-TTY: prints
 * the label once and the resolution line when finished — no control codes, no redraw.
 */
export function spinner(label: string): { done: (text?: string) => void; fail: (text?: string) => void } {
  const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (tty) {
    timer = setInterval(() => {
      process.stdout.write(`\r        ${c.accent(FRAMES[i++ % FRAMES.length])} ${label}   `);
    }, 90);
  } else {
    console.log(`        … ${label}`);
  }
  const stop = (mark: string, text?: string): void => {
    if (timer) {
      clearInterval(timer);
      process.stdout.write("\r[2K");
    }
    console.log(`        ${mark} ${text ?? label}`);
  };
  return {
    done: (text?: string) => stop(sym.ok, text),
    fail: (text?: string) => stop(sym.err, text),
  };
}
