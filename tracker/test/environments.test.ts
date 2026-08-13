/**
 * L23 launch-anywhere onboarding: the pure `environments` recipe surface.
 *
 * Hermetic by construction — detectEnvironment takes an explicit env map and
 * renderEnvironments takes an explicit appBase, so nothing here reads the real
 * process.env, touches the network, or reads a real home. The invariants: detection
 * precedence is stable, every rendered line is copy-paste-safe at 80 columns, the
 * detected recipe leads, and the auth/companion/pointer copy is present verbatim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectEnvironment,
  renderEnvironments,
  RECIPES,
  ENVIRONMENTS_MAX_WIDTH,
  LAUNCH_ANYWHERE_HINT,
  type RecipeId,
} from "../src/environments.ts";

const APP_BASE = "https://leaderboard.deployforward.dev";

test("detectEnvironment: each signal maps to its recipe", () => {
  assert.equal(detectEnvironment({ CI: "true" }), "ci");
  assert.equal(detectEnvironment({ GITHUB_ACTIONS: "true" }), "ci");
  assert.equal(detectEnvironment({ CODESPACES: "true" }), "container");
  assert.equal(detectEnvironment({ REMOTE_CONTAINERS: "true" }), "container");
  assert.equal(detectEnvironment({ DEVCONTAINER: "true" }), "container");
  assert.equal(detectEnvironment({ CLOUD_SHELL: "true" }), "cloudshell");
  assert.equal(detectEnvironment({ GOOGLE_CLOUD_SHELL: "true" }), "cloudshell");
  assert.equal(detectEnvironment({ SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" }), "server");
  assert.equal(detectEnvironment({ SSH_TTY: "/dev/pts/0" }), "server");
});

test("detectEnvironment: nothing obvious -> null (caller prints the full menu)", () => {
  assert.equal(detectEnvironment({}), null);
  // A falsy CI value is not a match (some shells export CI="" or CI="false").
  assert.equal(detectEnvironment({ CI: "" }), null);
  assert.equal(detectEnvironment({ CI: "false" }), null);
  assert.equal(detectEnvironment({ CI: "0" }), null);
});

test("detectEnvironment: precedence is CI > container > cloudshell > server", () => {
  // A Codespace reached over SSH is a container, not a bare server.
  assert.equal(detectEnvironment({ CODESPACES: "true", SSH_CONNECTION: "x" }), "container");
  // CI wins over everything (automation is the most specific).
  assert.equal(detectEnvironment({ CI: "true", CODESPACES: "true", SSH_TTY: "x" }), "ci");
  // Cloud Shell beats a plain SSH signal.
  assert.equal(detectEnvironment({ CLOUD_SHELL: "true", SSH_CONNECTION: "x" }), "cloudshell");
});

test("renderEnvironments: every line is width-safe at 80 columns", () => {
  // The whole point is copy-paste into a shell/workflow/devcontainer.json without wrap.
  const cases: (RecipeId | null)[] = [null, "server", "ci", "container", "cloudshell"];
  for (const detected of cases) {
    const text = renderEnvironments({ appBase: APP_BASE, detected });
    for (const line of text.split("\n")) {
      assert.ok(
        line.length <= ENVIRONMENTS_MAX_WIDTH,
        `line exceeds ${ENVIRONMENTS_MAX_WIDTH} cols (${line.length}) [detected=${detected}]: ${JSON.stringify(line)}`,
      );
    }
  }
});

test("renderEnvironments: output is plain text (no ANSI escapes)", () => {
  const text = renderEnvironments({ appBase: APP_BASE, detected: "ci" });
  // eslint-disable-next-line no-control-regex
  const hasAnsi = /\x1b/.test(text);
  assert.ok(!hasAnsi, "recipes must never carry ANSI escapes - pipes and copy-paste stay clean");
});

test("renderEnvironments: the menu lists all four recipes and the canonical pointer", () => {
  const text = renderEnvironments({ appBase: APP_BASE, detected: null });
  for (const r of RECIPES) assert.ok(text.includes(r.title), `menu missing recipe: ${r.id}`);
  assert.ok(text.includes(`${APP_BASE}/how#environments`), "footer must point at the canonical long form");
  // The clean L22 auth path is named, and the companion command that mints it.
  assert.ok(text.includes("DF_DEVICE_TOKEN"), "recipes must name the token env var");
  assert.ok(text.includes("setup-token"), "recipes must name the companion command that mints the token");
  assert.ok(text.includes("DF_HOME"), "recipes must show the state-portability env var");
});

test("renderEnvironments: a detected environment leads, the rest follow", () => {
  const text = renderEnvironments({ appBase: APP_BASE, detected: "ci" });
  assert.ok(text.includes("Detected this environment (ci)"), "detected env is announced");
  const ci = RECIPES.find((r) => r.id === "ci")!;
  const server = RECIPES.find((r) => r.id === "server")!;
  assert.ok(text.indexOf(ci.title) < text.indexOf(server.title), "the detected recipe appears before the others");
  assert.ok(text.includes("Other environments:"), "the remaining recipes are still listed");
  // All four are still present — detection reorders, never hides.
  for (const r of RECIPES) assert.ok(text.includes(r.title), `detected view dropped recipe: ${r.id}`);
});

test("LAUNCH_ANYWHERE_HINT: one line, names the command, token, and setup-token", () => {
  assert.ok(!LAUNCH_ANYWHERE_HINT.includes("\n"), "the happy-path hint is a single line");
  assert.ok(LAUNCH_ANYWHERE_HINT.includes("npx deploy-forward environments"), "points at the recipes command");
  assert.ok(LAUNCH_ANYWHERE_HINT.includes("setup-token"), "names the token-minting companion");
  assert.ok(LAUNCH_ANYWHERE_HINT.includes("DF_DEVICE_TOKEN"), "names the token env var");
});
