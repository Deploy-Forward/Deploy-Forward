/**
 * L23 launch-anywhere onboarding: the headless/server recipes docs/environments.md
 * documents, surfaced IN THE PRODUCT as `npx deploy-forward environments`.
 *
 * docs/environments.md stays the canonical long form; this is the discoverable short
 * form — a few copy-paste blocks a user actually sees, each built around the L22 clean
 * headless-auth path (mint a portable device token with `setup-token`, hand it to the
 * target box as DF_DEVICE_TOKEN) plus DF_HOME for state portability.
 *
 * Everything here is PURE (no I/O, no process reads beyond the env map the caller
 * passes): detection takes an explicit env, rendering takes an explicit appBase, so the
 * whole surface is width-checked and asserted in test/environments.test.ts with no
 * network and no real home. bin/df.ts is the only place that wires it to process.env /
 * APP_BASE and prints it.
 *
 * Output is deliberately PLAIN TEXT (no ANSI): the blocks are meant to be copy-pasted
 * into a shell, a workflow file or a devcontainer.json, and must render identically in a
 * TTY and a pipe, width-safe at 80 columns.
 */

/** The single hardest column budget: every rendered line stays at or under this so the
 * blocks never soft-wrap in an 80-col terminal (the copy-paste guarantee). */
export const ENVIRONMENTS_MAX_WIDTH = 80;

export type RecipeId = "server" | "ci" | "container" | "cloudshell";

export interface Recipe {
  id: RecipeId;
  /** One-line heading shown above the block. */
  title: string;
  /** The copy-paste body lines (already indented two spaces under the title). */
  body: string[];
}

/**
 * The four recipes, in menu order. Each is a 3-5 line copy-paste block. The auth line is
 * the same clean path everywhere: `setup-token` on an already-signed-in machine prints a
 * portable device token, carried to the target as DF_DEVICE_TOKEN. DF_HOME keeps state
 * portable where the default ~/.config/df does not survive (containers).
 */
export const RECIPES: readonly Recipe[] = [
  {
    id: "server",
    title: "Server / SSH  (EC2, a VPS, any box you SSH into)",
    body: [
      "  # 1. On a machine already signed in, mint a portable device token:",
      "  npx deploy-forward setup-token          # prints DF_DEVICE_TOKEN",
      "  # 2. On the server, hand it over and sync (metadata only, exits 0):",
      "  export DF_DEVICE_TOKEN='<paste-the-token>'",
      "  npx -y deploy-forward@latest sync",
    ],
  },
  {
    id: "ci",
    title: "CI  (GitHub Actions, or any pipeline)",
    body: [
      "  # Save `npx deploy-forward setup-token` output as a secret: DF_DEVICE_TOKEN",
      "  - name: deploy-forward sync",
      "    if: ${{ always() }}",
      "    env: { DF_DEVICE_TOKEN: ${{ secrets.DF_DEVICE_TOKEN }} }",
      "    run: npx -y deploy-forward@latest sync",
    ],
  },
  {
    id: "container",
    title: "Container / devcontainer / Codespaces",
    body: [
      "  // .devcontainer/devcontainer.json  (also: add .df/ to .gitignore)",
      '  "containerEnv": { "DF_DEVICE_TOKEN": "${localEnv:DF_DEVICE_TOKEN}",',
      '                    "DF_HOME": "${containerWorkspaceFolder}/.df" },',
      '  "postStartCommand": "npx -y deploy-forward@latest sync || true"',
    ],
  },
  {
    id: "cloudshell",
    title: "Google Cloud Shell  (has a browser — interactive flow works as-is)",
    body: [
      "  npx -y deploy-forward@latest         # one-time: approve in the browser",
      "  npx -y deploy-forward@latest sync    # headless after that ($HOME persists)",
    ],
  },
] as const;

/**
 * Detect the current environment from an env map, cheaply, for the recipe worth showing
 * first. Returns null when nothing obvious matches (then the caller prints the full
 * menu). Precedence, most-specific first: CI automation, then a container/Codespace,
 * then Cloud Shell, then a plain SSH box — a Codespace reached over SSH is a container,
 * not a bare server.
 */
export function detectEnvironment(env: NodeJS.ProcessEnv = process.env): RecipeId | null {
  const truthy = (v: string | undefined): boolean => v !== undefined && v !== "" && v !== "0" && v !== "false";
  // GitHub Actions and most CI set CI=true; GITHUB_ACTIONS is the belt-and-braces signal.
  if (truthy(env.CI) || truthy(env.GITHUB_ACTIONS)) return "ci";
  // Codespaces (CODESPACES), VS Code devcontainers (REMOTE_CONTAINERS), the devcontainer
  // CLI (DEVCONTAINER) — any one means "container".
  if (truthy(env.CODESPACES) || truthy(env.REMOTE_CONTAINERS) || truthy(env.DEVCONTAINER)) return "container";
  // Google Cloud Shell sets CLOUD_SHELL=true (and GOOGLE_CLOUD_SHELL).
  if (truthy(env.CLOUD_SHELL) || truthy(env.GOOGLE_CLOUD_SHELL)) return "cloudshell";
  // A plain SSH session: SSH_CONNECTION/SSH_TTY are set by sshd for the login shell.
  if (truthy(env.SSH_CONNECTION) || truthy(env.SSH_TTY)) return "server";
  return null;
}

/**
 * The one-line discoverability hint the interactive happy path carries (bare-run
 * ceremony + returning-run dashboard). Kept here so both call sites print the identical
 * copy and a test can pin it. Deliberately a single line in the existing dim-hint style —
 * it never clutters the happy path, just points a future headless run at the recipes.
 */
export const LAUNCH_ANYWHERE_HINT =
  "Running on a server or CI? npx deploy-forward setup-token, then set DF_DEVICE_TOKEN there - see: npx deploy-forward environments";

function renderRecipe(r: Recipe): string[] {
  return [r.title, ...r.body];
}

/**
 * Build the full `environments` output as one plain-text string. When `detected` names a
 * recipe it leads ("Detected ... - start here:") and the rest follow under "Other
 * environments:"; otherwise every recipe prints under "Environments:". The footer points
 * at the canonical long form (APP_BASE + /how#environments) and names the setup-token
 * companion so the token step is never a dead reference.
 */
export function renderEnvironments(opts: { appBase: string; detected?: RecipeId | null }): string {
  const { appBase, detected } = opts;
  const out: string[] = [];
  out.push("Launch anywhere — run the tracker on a server, in CI, or a container.");
  out.push("First-time auth needs a human once; after that a device token travels.");
  out.push("");

  const byId = (id: RecipeId): Recipe => RECIPES.find((r) => r.id === id)!;
  if (detected) {
    const lead = byId(detected);
    out.push(`Detected this environment (${detected}) — start here:`);
    out.push("");
    out.push(...renderRecipe(lead));
    const rest = RECIPES.filter((r) => r.id !== detected);
    if (rest.length > 0) {
      out.push("");
      out.push("Other environments:");
      for (const r of rest) {
        out.push("");
        out.push(...renderRecipe(r));
      }
    }
  } else {
    out.push("Environments:");
    for (const r of RECIPES) {
      out.push("");
      out.push(...renderRecipe(r));
    }
  }

  out.push("");
  out.push(`Full guide:  ${appBase}/how#environments`);
  out.push("Companion:   `npx deploy-forward setup-token` mints the DF_DEVICE_TOKEN");
  out.push("             these recipes use. Fallback: seed DF_HOME/state.json instead.");
  return out.join("\n");
}
