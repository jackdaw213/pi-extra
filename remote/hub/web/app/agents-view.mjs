// Pure running-subagents logic — Node-safe, no DOM. Consumed by attach.mjs
// and tests.
//
// Input: the attach view's live tool entries (view.tools values), shape
// { toolName, running, parent, label? }:
//   toolName — pi's tool name; "agent" spawns a subagent
//   running  — nested tool calls currently active inside this card (badge)
//   parent   — parentToolCallId for nested calls, null at top level
//   label    — optional display label (subagent type / task description)
//
// An entry is a RUNNING SUBAGENT while it is a top-level `agent` call still
// present in the live map: pi keeps the entry from tool_execution_start until
// the call's own tool_execution_end, so presence — not the nested badge
// count — is the liveness signal. A subagent between tool calls (composing
// its final message) has running === 0 but is still executing.

const AGENT_TOOL = "agent";

// Summarize the live tool entries for the subagents panel:
//   { running, lines: [{ label }] }
// running counts top-level `agent` calls in flight (one line each); 0 means
// the panel hides. Nested-only children are never panel lines.
export function summarizeAgents(entries) {
  const lines = [];
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.toolName !== AGENT_TOOL) continue;
    if (entry.parent) continue;
    lines.push({ label: entryLabel(entry) });
  }
  return { running: lines.length, lines };
}

function entryLabel(entry) {
  if (typeof entry.label === "string" && entry.label.length > 0) return entry.label;
  return typeof entry.toolName === "string" && entry.toolName ? entry.toolName : AGENT_TOOL;
}

// Best-effort subagent label from an agent tool call's arguments. The
// opensec-pi-subagents `agent` tool takes
//   { prompt, description, subagent_type, model? }
// so prefer the agent type, then the short task description, then a generic
// name field. Returns null when args carry no usable name — the caller falls
// back to the tool name ("agent").
export function agentLabel(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  for (const key of ["subagent_type", "description", "name"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim().length > 0) return truncLabel(v.trim(), 60);
  }
  return null;
}

function truncLabel(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
