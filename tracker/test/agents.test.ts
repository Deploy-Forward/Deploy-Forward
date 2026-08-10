/**
 * Agents signal (0.11.0): Task tool_use subagent_type -> a SEPARATE windowed field.
 * Mirrors skills.test.ts — same guardrails (names only, block-id dedup, wrong-side
 * markers ignored), plus the separation invariant: agents never leak into skills and
 * vice versa (the server's skills-vs-turns plausibility gate assumes skills are skills).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript, normalizeAgentId } from "../src/jsonl.ts";

const line = (o: unknown) => JSON.stringify(o);

/** An assistant line carrying a subagent-dispatch tool_use block. The harness renamed
 * the tool Task -> Agent; both names must capture (the corpus holds both eras). */
function taskToolLine(subagentType: unknown, blockId: string, toolName = "Task"): string {
  return line({
    type: "assistant",
    uuid: "u-" + blockId,
    timestamp: "2026-07-10T10:00:01Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Dispatching a subagent with private task text." },
        { type: "tool_use", id: blockId, name: toolName, input: { subagent_type: subagentType, prompt: "confidential task prompt", description: "secret" } },
      ],
    },
  });
}

test("captures BOTH tool names: 'Agent' (current harness) and 'Task' (pre-rename)", () => {
  const p = parseTranscript(
    [taskToolLine("explore", "toolu_n1", "Agent"), taskToolLine("explore", "toolu_n2", "Task"), taskToolLine("fork", "toolu_n3", "Agent")].join("\n"),
  );
  assert.deepEqual(
    p.agents.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "explore", count: 2 },
      { id: "fork", count: 1 },
    ],
  );
});

test("extracts Task tool_use dispatches (input.subagent_type) into agents — NOT skills", () => {
  const p = parseTranscript(
    [taskToolLine("Explore", "toolu_a1"), taskToolLine("general-purpose", "toolu_a2"), taskToolLine("Explore", "toolu_a3")].join("\n"),
  );
  assert.deepEqual(
    p.agents.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "explore", count: 2 }, // normalized lowercase
      { id: "general-purpose", count: 1 },
    ],
  );
  assert.deepEqual(p.skills, [], "a Task dispatch must never count as a skill");
});

test("re-logged copies count a Task block ONCE (dedup by block id); Skill blocks never leak into agents", () => {
  const skillLine = line({
    type: "assistant",
    uuid: "u-sk",
    timestamp: "2026-07-10T10:00:02Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_sk1", name: "Skill", input: { skill: "code-review" } }],
    },
  });
  const p = parseTranscript([taskToolLine("plan", "toolu_b1"), taskToolLine("plan", "toolu_b1"), skillLine].join("\n"));
  assert.deepEqual(p.agents, [{ id: "plan", count: 1 }]);
  assert.deepEqual(p.skills, [{ id: "code-review", count: 1 }]);
});

test("malformed dispatches are DROPPED, never mangled", () => {
  const p = parseTranscript(
    [
      taskToolLine(42, "toolu_c1"), // non-string
      taskToolLine("", "toolu_c2"), // empty
      taskToolLine("Bad Name With Spaces", "toolu_c3"), // fails the charset gate
      taskToolLine("x".repeat(65), "toolu_c4"), // over length
      taskToolLine("fine-agent", "toolu_c5"),
    ].join("\n"),
  );
  assert.deepEqual(p.agents, [{ id: "fine-agent", count: 1 }]);
});

test("normalizeAgentId: lowercases, gates charset/length, keeps namespaces verbatim, has NO plumbing list", () => {
  assert.equal(normalizeAgentId("  Explore "), "explore");
  assert.equal(normalizeAgentId("my-ns:agent"), "my-ns:agent");
  // "agents" is on the skills PLUMBING list but is a legitimate agent name here.
  assert.equal(normalizeAgentId("agents"), "agents");
  assert.equal(normalizeAgentId("has spaces"), null);
  assert.equal(normalizeAgentId("x".repeat(65)), null);
});
