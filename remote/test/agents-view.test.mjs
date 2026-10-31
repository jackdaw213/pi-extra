// Seam: agents-view.summarizeAgents + agentLabel — the running-subagents
// panel's pure logic. Input entries are the attach view's live tool entries
// (view.tools values), shape { toolName, running, parent, label? }:
//   toolName — pi's tool name; "agent" spawns a subagent
//   running  — nested tool calls currently active inside this card
//   parent   — parentToolCallId for nested calls, null at top level
//   label    — optional display label (subagent type / task description)
// An entry is a running subagent while it is a top-level `agent` call still in
// the live map: pi keeps it there from tool_execution_start until the call's
// own tool_execution_end, so presence — not the nested badge count — is the
// liveness signal (a subagent between tool calls has running === 0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeAgents, agentLabel } from "../hub/web/app/agents-view.mjs";

function agentEntry(label, extra = {}) {
  return { toolName: "agent", running: 1, parent: null, label, ...extra };
}

test("one line per running top-level agent entry", () => {
  const model = summarizeAgents([
    agentEntry("general-purpose"),
    agentEntry("explore"),
    { toolName: "bash", running: 1, parent: null }, // ordinary tool: never a line
  ]);
  assert.equal(model.running, 2);
  assert.deepEqual(model.lines, [{ label: "general-purpose" }, { label: "explore" }]);
});

test("entries without a label fall back to the tool name", () => {
  const model = summarizeAgents([agentEntry(null), agentEntry(undefined)]);
  assert.equal(model.running, 2);
  assert.deepEqual(model.lines, [{ label: "agent" }, { label: "agent" }]);
});

test("nested-only children are ignored even when they are agent calls", () => {
  const model = summarizeAgents([
    { toolName: "bash", running: 0, parent: null },
    agentEntry("general-purpose", { parent: "t1" }), // sub-subagent nested in a card
    { toolName: "agent", running: 2, parent: "t1", label: null },
  ]);
  assert.equal(model.running, 0);
  assert.deepEqual(model.lines, []);
});

test("zero running agents: empty model, the panel hides", () => {
  const model = summarizeAgents([{ toolName: "bash", running: 1, parent: null }]);
  assert.equal(model.running, 0);
  assert.deepEqual(model.lines, []);
  assert.deepEqual(summarizeAgents([]), { running: 0, lines: [] });
  assert.deepEqual(summarizeAgents(null), { running: 0, lines: [] });
});

test("a subagent between nested tool calls still counts as running", () => {
  // running === 0: its nested calls finished; the agent call itself has not
  // ended, so the subagent is still executing (final message turn).
  const model = summarizeAgents([agentEntry("explore", { running: 0 })]);
  assert.equal(model.running, 1);
  assert.deepEqual(model.lines, [{ label: "explore" }]);
});

test("malformed entries are skipped, not fatal", () => {
  const model = summarizeAgents([null, 42, agentEntry("explore")]);
  assert.equal(model.running, 1);
  assert.deepEqual(model.lines, [{ label: "explore" }]);
});

test("agentLabel prefers subagent_type, then description, then name", () => {
  assert.equal(agentLabel({ subagent_type: "general-purpose", description: "Research auth" }), "general-purpose");
  assert.equal(agentLabel({ description: "Research auth flows", prompt: "..." }), "Research auth flows");
  assert.equal(agentLabel({ name: "scout" }), "scout");
  assert.equal(agentLabel({ prompt: "only a prompt" }), null);
  assert.equal(agentLabel(null), null);
  assert.equal(agentLabel("prompt text"), null);
});

test("agentLabel trims and truncates long values", () => {
  assert.equal(agentLabel({ description: "  Research auth flows  " }), "Research auth flows");
  const long = agentLabel({ description: "x".repeat(100) });
  assert.ok(long.length <= 61 && long.endsWith("…"));
});
