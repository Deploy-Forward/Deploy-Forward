import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatProviderCounts,
  isCodexRolloutPath,
  isPiSessionPath,
  isOpenClawSessionPath,
  isOpencodeDbPath,
  isHermesDbPath,
  isCopilotDbPath,
  monitorStats,
} from "../src/monitorStats.ts";

test("monitorStats classifies Codex rollout paths on Windows and POSIX", () => {
  assert.equal(isCodexRolloutPath("C:\\Users\\m\\.codex\\sessions\\2026\\07\\05\\rollout-2026-07-05T10-00-00.jsonl"), true);
  assert.equal(isCodexRolloutPath("/home/m/.codex/sessions/2026/07/05/rollout-2026-07-05T10-00-00.jsonl"), true);
  assert.equal(isCodexRolloutPath("C:\\Users\\m\\.claude\\projects\\repo\\rollout-looks-like-codex.jsonl"), false);
  assert.equal(isCodexRolloutPath("C:\\Users\\m\\.codex\\sessions\\2026\\07\\05\\notes.jsonl"), false);
});

test("monitorStats classifies pi session paths on Windows and POSIX", () => {
  assert.equal(isPiSessionPath("C:\\Users\\m\\.pi\\agent\\sessions\\--home-m-proj--\\20260701_abc.jsonl"), true);
  assert.equal(isPiSessionPath("/home/m/.pi/agent/sessions/--home-m-proj--/20260701_abc.jsonl"), true);
  // A DF_PI_HOME override moves the home prefix, not the layout -- still matched.
  assert.equal(isPiSessionPath("/tmp/df-pi-home/agent/sessions/--proj--/s.jsonl"), true);
  assert.equal(isPiSessionPath("C:\\Users\\m\\.claude\\projects\\repo\\s1.jsonl"), false);
});

test("monitorStats classifies OpenClaw session paths on Windows and POSIX", () => {
  assert.equal(isOpenClawSessionPath("C:\\Users\\m\\.openclaw\\agents\\main\\sessions\\91c1c277-9827-4353-8fcc-e4ecd55d8e57.jsonl"), true);
  assert.equal(isOpenClawSessionPath("/home/m/.openclaw/agents/main/sessions/91c1c277-9827-4353-8fcc-e4ecd55d8e57.jsonl"), true);
  // A DF_OPENCLAW_HOME override moves the home prefix, not the per-agent layout.
  assert.equal(isOpenClawSessionPath("/tmp/df-openclaw-home/agents/agent-b/sessions/s1.jsonl"), true);
  // The richer trajectory sidecar sits right next to the transcript -- never a cursor'd
  // file (openclaw.ts's discovery excludes it outright), so it must never classify here.
  assert.equal(isOpenClawSessionPath("/home/m/.openclaw/agents/main/sessions/91c1c277.trajectory.jsonl"), false);
  assert.equal(isOpenClawSessionPath("C:\\Users\\m\\.claude\\projects\\repo\\s1.jsonl"), false);
});

test("monitorStats classifies opencode db paths on Windows and POSIX", () => {
  assert.equal(isOpencodeDbPath("C:\\Users\\m\\.local\\share\\opencode\\opencode.db"), true);
  assert.equal(isOpencodeDbPath("/home/m/.local/share/opencode/opencode.db"), true);
  assert.equal(isOpencodeDbPath("/home/m/.local/share/opencode/opencode-beta.db"), true);
  // A DF_OPENCODE_HOME override moves the home prefix, never the filename convention.
  assert.equal(isOpencodeDbPath("/tmp/df-opencode-home/opencode-prod.db"), true);
  assert.equal(isOpencodeDbPath("/home/m/.local/share/opencode/auth.json"), false);
});

test("monitorStats classifies Hermes db paths on Windows and POSIX", () => {
  assert.equal(isHermesDbPath("C:\\Users\\m\\.hermes\\state.db"), true);
  assert.equal(isHermesDbPath("/home/m/.hermes/state.db"), true);
  // A DF_HERMES_HOME override moves the home prefix, not the single-db layout.
  assert.equal(isHermesDbPath("/tmp/df-hermes-home/state.db"), true);
  assert.equal(isHermesDbPath("/home/m/.hermes/sessions/legacy.jsonl"), false);
});

test("monitorStats classifies Copilot db paths on Windows and POSIX", () => {
  assert.equal(isCopilotDbPath("C:\\Users\\m\\.copilot\\session-store.db"), true);
  assert.equal(isCopilotDbPath("/home/m/.copilot/session-store.db"), true);
  // A DF_COPILOT_HOME override moves the home prefix, not the single-db layout.
  assert.equal(isCopilotDbPath("/tmp/df-copilot-home/session-store.db"), true);
  assert.equal(isCopilotDbPath("/home/m/.copilot/turns.db"), false);
});

test("monitorStats reports provider-specific file and session counts (all eight providers)", () => {
  const stats = monitorStats({
    cursors: {
      "C:\\Users\\m\\.claude\\projects\\repo\\s1.jsonl": { byteOffset: 1 },
      "C:\\Users\\m\\.claude\\projects\\repo\\s2.jsonl": { byteOffset: 1 },
      "C:\\Users\\m\\.codex\\sessions\\2026\\07\\05\\rollout-a.jsonl": { byteOffset: 1 },
      "C:\\Users\\m\\.grok\\logs\\unified.jsonl": { byteOffset: 1 },
      "C:\\Users\\m\\.pi\\agent\\sessions\\--home-m-proj--\\20260701_abc.jsonl": { byteOffset: 1 },
      "C:\\Users\\m\\.openclaw\\agents\\agent-a\\sessions\\sess-oc.jsonl": { byteOffset: 1 },
      "C:\\Users\\m\\.local\\share\\opencode\\opencode.db": { byteOffset: 1 },
      "C:\\Users\\m\\.hermes\\state.db": { byteOffset: 1 },
      "C:\\Users\\m\\.copilot\\session-store.db": { byteOffset: 1 },
    },
    threadDigests: {
      "claude_code_s1": "a",
      "claude_code_s2": "b",
      codex_rolloutA: "c",
      "grok_019f43ae": "d",
      "pi_sess-aaa": "e",
      "openclaw_sess-oc": "f",
      "opencode_sess-op": "g",
      "hermes_sess-he": "h",
      "copilot_sess-cop": "i",
      legacy_unknown: "ignored",
    },
  });

  assert.deepEqual(stats, {
    files: { claude: 2, codex: 1, grok: 1, pi: 1, openclaw: 1, opencode: 1, hermes: 1, copilot: 1 },
    sessions: { claude: 2, codex: 1, grok: 1, pi: 1, openclaw: 1, opencode: 1, hermes: 1, copilot: 1 },
  });
  assert.equal(
    formatProviderCounts(stats),
    "files Claude 2 / Codex 1 / Grok 1 / pi 1 / OpenClaw 1 / opencode 1 / Hermes 1 / Copilot 1 | " +
      "sessions Claude 2 / Codex 1 / Grok 1 / pi 1 / OpenClaw 1 / opencode 1 / Hermes 1 / Copilot 1",
  );
});

test("formatProviderCounts hides Grok/pi/OpenClaw/opencode/Hermes/Copilot when untracked (never a false 'found nothing')", () => {
  const stats = monitorStats({
    cursors: { "C:\\Users\\m\\.claude\\projects\\repo\\s1.jsonl": { byteOffset: 1 } },
    threadDigests: { claude_code_s1: "a" },
  });
  assert.equal(formatProviderCounts(stats), "files Claude 1 / Codex 0 | sessions Claude 1 / Codex 0");
});
