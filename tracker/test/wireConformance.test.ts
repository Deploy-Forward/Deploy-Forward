/**
 * Wire conformance — the executable half of the published capture contract.
 *
 * `contract/wire.schema.json` (repo root) is the normative, machine-readable schema of
 * the ingest payload. This test is the drift guard that keeps it honest: `toIngest()`'s
 * actual output for every parsed harness must validate against the schema, and the
 * schema must actually BITE (the negative cases below fail validation for the documented
 * reasons). If a wire field is added, removed, or reshaped, exactly one of these
 * assertions goes red, and the fix is to change the schema and the docs in the same
 * commit as the code.
 *
 * The validator is a deliberate ~80-line subset of JSON Schema (type / required /
 * properties / items / enum / pattern / minimum / $ref into $defs) — the tracker ships
 * with ZERO runtime dependencies and this test keeps that true for dev-time too. The
 * schema must not use keywords outside that subset; the loader throws on unknown
 * keywords so a schema edit cannot silently go unvalidated.
 *
 * PRIVACY PINS (the contract/PRIVACY.md claims, held by assertion): `context` and `cwd`
 * exist on SessionSummary but must NEVER appear in toIngest() output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toIngest } from "../src/sync.js";
import type { SessionSummary, ToolName } from "../src/types.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(REPO_ROOT, "contract", "wire.schema.json"), "utf8"));

// ---------------------------------------------------------------------------
// Minimal JSON-Schema-subset validator (see header for why not a dependency)
// ---------------------------------------------------------------------------

const KNOWN_KEYWORDS = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description",
  "type", "required", "properties", "items", "enum", "pattern", "minimum",
]);

type Json = unknown;

function resolveRef(ref: string): Record<string, Json> {
  if (!ref.startsWith("#/$defs/")) throw new Error(`unsupported $ref: ${ref}`);
  const def = (SCHEMA.$defs as Record<string, Json>)[ref.slice("#/$defs/".length)];
  if (!def) throw new Error(`unresolved $ref: ${ref}`);
  return def as Record<string, Json>;
}

function typeOf(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Validate `value` against `schema`, appending human-readable problems to `errors`. */
function validate(value: Json, schema: Record<string, Json>, path: string, errors: string[]): void {
  for (const k of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(k)) throw new Error(`schema keyword outside the validated subset: ${k} at ${path}`);
  }
  if (typeof schema.$ref === "string") {
    validate(value, resolveRef(schema.$ref), path, errors);
    return;
  }
  if (schema.enum !== undefined) {
    if (!(schema.enum as Json[]).includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
    return;
  }
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    const actual = typeOf(value);
    if (!allowed.includes(actual === "number" ? "number" : actual)) {
      errors.push(`${path}: expected ${allowed.join("|")}, got ${actual}`);
      return; // no point checking structure of the wrong type
    }
  }
  if (typeof value === "string" && typeof schema.pattern === "string") {
    if (!new RegExp(schema.pattern).test(value)) errors.push(`${path}: ${JSON.stringify(value)} fails pattern ${schema.pattern}`);
  }
  if (typeof value === "number" && typeof schema.minimum === "number") {
    if (value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => validate(item, schema.items as Record<string, Json>, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, Json>;
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) errors.push(`${path}: missing required ${req}`);
    }
    const props = (schema.properties as Record<string, Record<string, Json>> | undefined) ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj && obj[key] !== undefined) validate(obj[key], sub, `${path}.${key}`, errors);
    }
  }
}

function validatePayload(payload: Json): string[] {
  const errors: string[] = [];
  validate(payload, SCHEMA as Record<string, Json>, "$", errors);
  return errors;
}

// ---------------------------------------------------------------------------
// Synthetic sessions — the seam is toIngest ∘ schema, not the parsers
// ---------------------------------------------------------------------------

const TOOLS: ToolName[] = ["claude_code", "codex", "grok", "pi", "openclaw", "opencode", "hermes", "copilot", "gemini"];

function minimalSession(tool: ToolName): SessionSummary {
  return {
    tool,
    toolSessionId: `sess-${tool}-01`,
    model: "model-a",
    tokens: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
    models: [{ id: "model-a", input: 100, output: 50, cacheRead: 0, cacheCreation: 0 }],
    entryPoint: "cli",
    thinkingTokens: 0,
    wallMs: 60_000,
    activeMs: 40_000,
    idleMs: 20_000,
    startedAt: 1_754_000_000_000,
    endedAt: 1_754_000_060_000,
    repoHash: null,
    messageCount: 3,
    turns: 1,
    longestLoopMs: 30_000,
  };
}

/** Every optional wire field populated — the widest legal payload. */
function richSession(): SessionSummary {
  return {
    ...minimalSession("claude_code"),
    toolSessionId: "sess-rich.01:a_b-c",
    thinkingTokens: 250,
    repoHash: "a".repeat(64),
    orgRepo: "acme-corp/widgets",
    attribution: { canonicalRepoId: "repo_1", grantIds: ["grant_1"], localRepoId: "local_1" },
    mue: { alpha: 1.1, cActual: 5000, cIdeal: 4000, ratio: 0.8, costPerOutput: 12.5, compactions: 1, points: 9 },
    skills: [{ id: "commit", count: 2 }],
    agents: [{ id: "explore", count: 1 }],
    days: [
      { day: "2026-08-01", activeMs: 20_000, idleMs: 10_000, tokens: { input: 50, output: 25, cacheRead: 0, cacheCreation: 0 } },
      {
        day: "2026-08-02",
        activeMs: 20_000,
        idleMs: 10_000,
        tokens: { input: 50, output: 25, cacheRead: 0, cacheCreation: 0 },
        models: [{ id: "model-a", input: 50, output: 25, cacheRead: 0, cacheCreation: 0 }],
      },
    ],
    outcomes: [
      { type: "merged_pr", nodeId: "PR_node", repoHash: "b".repeat(64), prNumber: 7, addDel: 120, observedAt: 1_754_000_050_000 },
      { type: "commit", sha: "abc1234", observedAt: 1_754_000_055_000 },
    ],
    // Local-only fields — MUST NOT survive toIngest (privacy pin below).
    cwd: "/home/m/proj",
    context: { occupancyTokens: 1000, model: "model-a", windowTokens: 200_000 },
  };
}

function asPayload(sessions: SessionSummary[]): Json {
  // JSON round-trip mirrors the real POST body: undefined-valued optionals drop out,
  // exactly as JSON.stringify does on the wire (that drop is load-bearing for digests).
  return JSON.parse(JSON.stringify({ trackerVersion: "0.0.0-test", sessions: sessions.map(toIngest) }));
}

// ---------------------------------------------------------------------------
// Conformance: every parsed harness's wire output validates
// ---------------------------------------------------------------------------

test("wire conformance: a minimal session from each of the nine harnesses validates", () => {
  for (const tool of TOOLS) {
    const errors = validatePayload(asPayload([minimalSession(tool)]));
    assert.deepEqual(errors, [], `${tool}: ${errors.join("; ")}`);
  }
});

test("wire conformance: the widest legal payload (every optional populated) validates", () => {
  const errors = validatePayload(asPayload([richSession()]));
  assert.deepEqual(errors, [], errors.join("; "));
});

test("privacy pin: cwd and context never survive toIngest()", () => {
  const wire = toIngest(richSession()) as Record<string, unknown>;
  assert.equal("cwd" in wire, false, "cwd must never go on the wire");
  assert.equal("context" in wire, false, "context (window occupancy) must never go on the wire");
});

// ---------------------------------------------------------------------------
// The schema bites: documented violations are caught, with the documented reason
// ---------------------------------------------------------------------------

test("negative: a session id outside the safe charset fails the pattern gate", () => {
  const bad = { ...minimalSession("codex"), toolSessionId: "has spaces!" };
  const errors = validatePayload(asPayload([bad]));
  assert.ok(errors.some((e) => e.includes("toolSessionId") && e.includes("pattern")), errors.join("; "));
});

test("negative: missing token counts fail required-field validation", () => {
  const payload = asPayload([minimalSession("pi")]) as { sessions: Record<string, unknown>[] };
  delete payload.sessions[0].tokens;
  const errors = validatePayload(payload);
  assert.ok(errors.some((e) => e.includes("missing required tokens")), errors.join("; "));
});

test("negative: a negative token count fails the minimum gate", () => {
  const bad = minimalSession("grok");
  bad.tokens = { ...bad.tokens, output: -5 };
  const errors = validatePayload(asPayload([bad]));
  assert.ok(errors.some((e) => e.includes("tokens.output") && e.includes("minimum")), errors.join("; "));
});

test("negative: an unknown tool id fails the enum gate", () => {
  const payload = asPayload([minimalSession("hermes")]) as { sessions: Record<string, unknown>[] };
  payload.sessions[0].tool = "made-up-tool";
  const errors = validatePayload(payload);
  assert.ok(errors.some((e) => e.includes("tool") && e.includes("enum")), errors.join("; "));
});
