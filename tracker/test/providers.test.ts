/**
 * W1.5 drift-plumbing tests (docs/harness-adapters-implementation.md, spec §5.1–5.2):
 * the provider registry's invariants, the shared isDriftSuspected threshold rule, and
 * the acceptance fixture — a renamed-fields corpus trips the threshold, a healthy
 * corpus does not. Fixtures are SYNTHESIZED (pi's docs-derived schema, same builders
 * as pi.test.ts); scans take an explicit temp home, never the machine's real ~/.pi.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PROVIDERS, isDriftSuspected } from "../src/providers.ts";
import { scanPiCorpus } from "../src/pi.ts";
import type { TrackerState } from "../src/config.ts";

const STATE = { repoHmacKey: "test-key", gapMs: 5 * 60_000 } as unknown as TrackerState;

// ---------------------------------------------------------------------------
// Registry invariants (spec §5.1 — documentation-as-code)
// ---------------------------------------------------------------------------

test("registry: one row per parsed provider, ids unique and wire-valid", () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.deepEqual(
    [...ids].sort(),
    ["claude_code", "codex", "copilot", "gemini", "grok", "hermes", "openclaw", "opencode", "pi"],
    "exactly the nine parsed providers, no unregistered parsing",
  );
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const p of PROVIDERS) {
    assert.ok(p.display.length > 0, `${p.id} has a display name`);
    assert.ok(p.format.length > 0, `${p.id} documents its format`);
  }
});

test("registry: fingerprint gates exist exactly where a format collision is possible", () => {
  const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
  // Claude Code and Codex own their config dirs — ungated by design, not omission.
  assert.equal(byId.claude_code.fingerprint, null);
  assert.equal(byId.codex.fingerprint, null);
  // Grok shares ~/.grok with a community fork; pi/openclaw/opencode/hermes/copilot marks
  // are all structural (no proprietary content string exists for any of them) — every
  // one of the six remaining providers is gated.
  assert.equal(typeof byId.grok.fingerprint, "function");
  assert.equal(typeof byId.pi.fingerprint, "function");
  assert.equal(typeof byId.openclaw.fingerprint, "function");
  assert.equal(typeof byId.opencode.fingerprint, "function");
  assert.equal(typeof byId.hermes.fingerprint, "function");
  assert.equal(typeof byId.copilot.fingerprint, "function");
  // Gemini's ~/.gemini can be shadowed by non-CLI Gemini products — structural gate.
  assert.equal(typeof byId.gemini.fingerprint, "function");
});

test("registry: home resolvers honor the hermetic env overrides", () => {
  const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
  const prev = {
    pi: process.env.DF_PI_HOME,
    grok: process.env.DF_GROK_HOME,
    codex: process.env.DF_CODEX_SESSIONS,
    openclaw: process.env.DF_OPENCLAW_HOME,
    opencode: process.env.DF_OPENCODE_HOME,
    hermes: process.env.DF_HERMES_HOME,
    copilot: process.env.DF_COPILOT_HOME,
    gemini: process.env.DF_GEMINI_HOME,
  };
  process.env.DF_PI_HOME = "/tmp/df-test-pi-home";
  process.env.DF_GROK_HOME = "/tmp/df-test-grok-home";
  process.env.DF_CODEX_SESSIONS = "/tmp/df-test-codex-sessions";
  process.env.DF_OPENCLAW_HOME = "/tmp/df-test-openclaw-home";
  process.env.DF_OPENCODE_HOME = "/tmp/df-test-opencode-home";
  process.env.DF_HERMES_HOME = "/tmp/df-test-hermes-home";
  process.env.DF_COPILOT_HOME = "/tmp/df-test-copilot-home";
  process.env.DF_GEMINI_HOME = "/tmp/df-test-gemini-home";
  try {
    assert.equal(byId.pi.home(), "/tmp/df-test-pi-home");
    assert.equal(byId.grok.home(), "/tmp/df-test-grok-home");
    assert.equal(byId.codex.home(), "/tmp/df-test-codex-sessions");
    assert.equal(byId.openclaw.home(), "/tmp/df-test-openclaw-home");
    assert.equal(byId.opencode.home(), "/tmp/df-test-opencode-home");
    assert.equal(byId.hermes.home(), "/tmp/df-test-hermes-home");
    assert.equal(byId.copilot.home(), "/tmp/df-test-copilot-home");
    assert.equal(byId.gemini.home(), "/tmp/df-test-gemini-home");
    // Claude's resolver returns EXISTING roots only (possibly none on this machine) —
    // shape check, not content: the walker itself is covered by sync's own tests.
    assert.ok(Array.isArray(byId.claude_code.home()));
  } finally {
    for (const [k, env] of [
      ["pi", "DF_PI_HOME"],
      ["grok", "DF_GROK_HOME"],
      ["codex", "DF_CODEX_SESSIONS"],
      ["openclaw", "DF_OPENCLAW_HOME"],
      ["opencode", "DF_OPENCODE_HOME"],
      ["hermes", "DF_HERMES_HOME"],
      ["copilot", "DF_COPILOT_HOME"],
      ["gemini", "DF_GEMINI_HOME"],
    ] as const) {
      if (prev[k] === undefined) delete process.env[env];
      else process.env[env] = prev[k];
    }
  }
});

// ---------------------------------------------------------------------------
// isDriftSuspected — the spec threshold, verbatim (>5% AND >20 unknown, both strict)
// ---------------------------------------------------------------------------

test("isDriftSuspected: fires only when BOTH rate (>5%) and count (>20) trip", () => {
  assert.equal(isDriftSuspected({ unknownLines: 21, totalLines: 100 }), true, "21% of 100, 21 lines — drift");
  assert.equal(isDriftSuspected({ unknownLines: 21, totalLines: 1000 }), false, "2.1% — a big corpus's noise floor");
  assert.equal(isDriftSuspected({ unknownLines: 10, totalLines: 20 }), false, "50% but only 10 lines — a tiny corpus's one bad file");
  assert.equal(isDriftSuspected({ unknownLines: 500, totalLines: 1000 }), true, "50% of 1000 — unambiguous");
});

test("isDriftSuspected: boundaries are strict; an empty scan is never drift", () => {
  assert.equal(isDriftSuspected({ unknownLines: 20, totalLines: 100 }), false, "exactly 20 lines does not trip (>20 is strict)");
  assert.equal(isDriftSuspected({ unknownLines: 25, totalLines: 500 }), false, "exactly 5% does not trip (>5% is strict)");
  assert.equal(isDriftSuspected({ unknownLines: 0, totalLines: 0 }), false);
  assert.equal(isDriftSuspected({ unknownLines: 0, totalLines: 10_000 }), false);
});

// ---------------------------------------------------------------------------
// Acceptance (W1.5): renamed fields trip the threshold; a healthy corpus does not
// ---------------------------------------------------------------------------

function piHeader(id: string): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-07-01T10:00:00.000Z", cwd: "/home/m/proj" });
}
function piAssistant(id: string, i: number): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: `2026-07-01T10:00:${String(i % 60).padStart(2, "0")}.000Z`,
    message: { role: "assistant", model: "model-a", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
  });
}
/** The drift shape: the harness renamed the discriminator (`type` -> `kind`), so every
 * entry parses as JSON but matches no known entry type — the silent-zero failure mode
 * this task exists to make loud. */
function piRenamed(id: string, i: number): string {
  return JSON.stringify({
    kind: "message",
    id,
    parentId: null,
    timestamp: `2026-07-01T10:01:${String(i % 60).padStart(2, "0")}.000Z`,
    message: { role: "assistant", model: "model-a", usage: { input: 10, output: 5 } },
  });
}

test("acceptance: a renamed-fields pi corpus trips isDriftSuspected; a healthy one does not", () => {
  const home = mkdtempSync(join(tmpdir(), "df-providers-drift-"));
  try {
    const dir = join(home, "agent", "sessions", "--home-m-proj--");
    mkdirSync(dir, { recursive: true });

    // Healthy session: header + 25 recognized assistant entries, zero unknown.
    writeFileSync(join(dir, "20260701_ok.jsonl"), [piHeader("sess-ok"), ...Array.from({ length: 25 }, (_, i) => piAssistant(`a${i}`, i))].join("\n"));
    const healthy = scanPiCorpus(STATE, home);
    assert.equal(healthy.unknownLines, 0);
    assert.ok(healthy.totalLines >= 26);
    assert.equal(isDriftSuspected(healthy), false, "a healthy corpus never warns");

    // Drifted session lands in the same corpus: 25 renamed-discriminator lines —
    // >20 unknown AND far past 5% — the warning MUST fire (never a silent zero).
    writeFileSync(join(dir, "20260701_drift.jsonl"), [piHeader("sess-drift"), ...Array.from({ length: 25 }, (_, i) => piRenamed(`z${i}`, i))].join("\n"));
    const drifted = scanPiCorpus(STATE, home);
    assert.equal(drifted.unknownLines, 25, "every renamed line is counted, none silently dropped");
    assert.equal(isDriftSuspected(drifted), true, "renamed fields trip the threshold");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
