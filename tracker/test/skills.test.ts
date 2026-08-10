import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript, normalizeSkillId, foldSkillBuckets } from "../src/jsonl.ts";

const line = (o: unknown) => JSON.stringify(o);

/** A harness-injected slash-command user line (the real markup shape). */
function commandLine(name: string, args = "some secret args"): string {
  return line({
    type: "user",
    isMeta: true,
    timestamp: "2026-06-28T10:00:00Z",
    message: {
      role: "user",
      content: `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args>${args}</command-args>`,
    },
  });
}

/** An assistant line carrying a Skill tool_use block. */
function skillToolLine(skill: string, blockId: string, extra: Record<string, unknown> = {}): string {
  return line({
    type: "assistant",
    uuid: "u-" + blockId,
    timestamp: "2026-06-28T10:00:01Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Invoking the skill now with private reasoning text." },
        { type: "tool_use", id: blockId, name: "Skill", input: { skill, args: "confidential argument text", ...extra } },
      ],
    },
  });
}

test("extracts <command-name> tags from user messages (string AND text-block content)", () => {
  const blockForm = line({
    type: "user",
    timestamp: "2026-06-28T10:00:02Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "<command-name>/deep-research</command-name><command-args>topic x</command-args>" }],
    },
  });
  const p = parseTranscript([commandLine("/grilling"), blockForm].join("\n"));
  assert.deepEqual(
    p.skills.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "deep-research", count: 1 },
      { id: "grilling", count: 1 },
    ],
  );
});

test("extracts Skill tool_use calls from assistant messages (input.skill)", () => {
  const p = parseTranscript(
    [skillToolLine("superpowers:brainstorming", "toolu_1"), skillToolLine("superpowers:brainstorming", "toolu_2")].join("\n"),
  );
  assert.deepEqual(p.skills, [{ id: "superpowers:brainstorming", count: 2 }]);
});

test("command tags in assistant messages and Skill blocks in user messages are IGNORED", () => {
  // Wrong-side markers must not count: an assistant echoing "<command-name>" text, or a
  // tool_result in a user line — neither is a capture point.
  const assistantEcho = line({
    type: "assistant",
    timestamp: "2026-06-28T10:00:00Z",
    message: { role: "assistant", content: [{ type: "text", text: "<command-name>/grilling</command-name>" }] },
  });
  const userToolResult = line({
    type: "user",
    timestamp: "2026-06-28T10:00:01Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
  });
  const p = parseTranscript([assistantEcho, userToolResult].join("\n"));
  assert.deepEqual(p.skills, []);
});

test("re-logged assistant copies count a Skill tool_use block ONCE (dedup by block id)", () => {
  // Streamed copies of the same assistant message re-log the same tool_use block.
  const p = parseTranscript(
    [skillToolLine("verify", "toolu_A"), skillToolLine("verify", "toolu_A"), skillToolLine("verify", "toolu_A")].join("\n"),
  );
  assert.deepEqual(p.skills, [{ id: "verify", count: 1 }]);
});

test("plumbing commands are excluded — only real workflow skills count", () => {
  const p = parseTranscript(
    [
      commandLine("/compact"),
      commandLine("/clear"),
      commandLine("/model"),
      commandLine("/usage"),
      commandLine("/resume"),
      commandLine("/init"),
      commandLine("/review"),
      commandLine("/end"),
      commandLine("/install-github-app"),
      commandLine("/grilling"), // the one real skill
    ].join("\n"),
  );
  assert.deepEqual(p.skills, [{ id: "grilling", count: 1 }]);
});

test("normalization: strips '/', lowercases, collapses ns:name ONLY when ns === name", () => {
  assert.equal(normalizeSkillId("/Grilling"), "grilling");
  assert.equal(normalizeSkillId("frontend-design:frontend-design"), "frontend-design");
  assert.equal(normalizeSkillId("skill-creator:skill-creator"), "skill-creator");
  // Distinct namespace is KEPT — the raw normalized slug is the contract.
  assert.equal(normalizeSkillId("superpowers:brainstorming"), "superpowers:brainstorming");
  assert.equal(normalizeSkillId("/superpowers:test-driven-development"), "superpowers:test-driven-development");
  // Directory-scoped skill names survive the charset.
  assert.equal(normalizeSkillId("apps/web:deploy"), "apps/web:deploy");
  // Plumbing dropped even in tag-value form.
  assert.equal(normalizeSkillId("/compact"), null);
});

test("sanitization: non-conforming ids are DROPPED (charset + length), never truncated", () => {
  assert.equal(normalizeSkillId("evil skill!"), null); // space + '!'
  assert.equal(normalizeSkillId("<script>"), null);
  assert.equal(normalizeSkillId(""), null);
  assert.equal(normalizeSkillId("/"), null);
  assert.equal(normalizeSkillId("x".repeat(65)), null); // over 64 -> dropped, not sliced
  assert.equal(normalizeSkillId("x".repeat(64)), "x".repeat(64));
  const p = parseTranscript([commandLine("/bad name!"), skillToolLine("also bad!", "toolu_1")].join("\n"));
  assert.deepEqual(p.skills, []);
});

test("caps at 16 distinct skills; overflow folds into 'other' by count", () => {
  const lines: string[] = [];
  // 20 distinct skills with descending counts: skill-0 x21, skill-1 x20, ... skill-19 x2.
  for (let i = 0; i < 20; i++) {
    for (let c = 0; c < 21 - i; c++) lines.push(skillToolLine("skill-" + i, `toolu_${i}_${c}`));
  }
  const p = parseTranscript(lines.join("\n"));
  assert.equal(p.skills.length, 16);
  const other = p.skills.find((s) => s.id === "other");
  assert.ok(other, "overflow bucket exists");
  // skills 15..19 (counts 6,5,4,3,2) fold into other.
  assert.equal(other!.count, 6 + 5 + 4 + 3 + 2);
  // Total invocations are conserved across the fold.
  const total = p.skills.reduce((acc, s) => acc + s.count, 0);
  assert.equal(total, (21 + 2) * 10); // sum 2..21
  // Top entry survives intact.
  assert.deepEqual(p.skills[0], { id: "skill-0", count: 21 });
});

test("foldSkillBuckets merges overflow into an EXISTING 'other' bucket", () => {
  const bySkill = new Map<string, number>();
  bySkill.set("other", 100); // pre-existing (e.g. from a subagent merge)
  for (let i = 0; i < 17; i++) bySkill.set("s" + i, 50 - i);
  const folded = foldSkillBuckets(bySkill);
  // "other"(100) is itself a top-15 keeper, so the overflow merges INTO it: 15 entries total
  // (same shape as foldModelBuckets — never two "other" buckets).
  assert.equal(folded.length, 15);
  const other = folded.find((s) => s.id === "other")!;
  // The 3 smallest (36,35,34) fold into the existing bucket.
  assert.equal(other.count, 100 + 36 + 35 + 34);
});

test("NO CONTENT LEAK: parser skills output carries ONLY ids and counts", () => {
  const secretArg = "SECRET_TOKEN=abc123 launch the missiles";
  const secretText = "private user prose that must never leave the host";
  const content = [
    line({
      type: "user",
      timestamp: "2026-06-28T10:00:00Z",
      message: {
        role: "user",
        content: `${secretText}\n<command-name>/grilling</command-name>\n<command-args>${secretArg}</command-args>`,
      },
    }),
    skillToolLine("superpowers:writing-plans", "toolu_1", { args: secretArg }),
  ].join("\n");
  const p = parseTranscript(content);

  // Exactly the two skills, nothing else.
  assert.equal(p.skills.length, 2);
  for (const s of p.skills) {
    assert.deepEqual(Object.keys(s).sort(), ["count", "id"], "each entry is EXACTLY {id, count}");
    assert.equal(typeof s.id, "string");
    assert.equal(typeof s.count, "number");
  }
  // The serialized output must contain no argument text, no message content, no secrets.
  const wire = JSON.stringify(p.skills);
  assert.ok(!wire.includes("SECRET_TOKEN"), "no command args leak");
  assert.ok(!wire.includes("missiles"), "no command args leak");
  assert.ok(!wire.includes("private user prose"), "no message content leaks");
  assert.ok(!wire.includes("confidential argument text"), "no Skill input args leak");
});

test("a session with no skill markers parses to an empty skills array", () => {
  const p = parseTranscript(
    line({
      type: "user",
      timestamp: "2026-06-28T10:00:00Z",
      message: { role: "user", content: "plain prompt, /grilling mentioned in prose is NOT a marker" },
    }),
  );
  assert.deepEqual(p.skills, []);
});
