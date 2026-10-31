// Pure todo-panel logic — Node-safe, no DOM. Consumed by attach.mjs and tests.
//
// Data source: the rpiv-todo extension's `todo` tool. Every successful call
// returns the full state snapshot under the tool result's `details`
// (rpiv-todo tool/response-envelope.ts buildToolResult):
//   details = { action, params, tasks: Task[], nextId, error? }
//   Task    = { id, subject, description?, activeForm?, status, blockedBy?... }
// Pi's live `tool_result` event carries that envelope on `ev.details` for
// custom tools (declarations in pi docs/extensions.md → extensions/types.ts);
// parseTodoTasks also accepts a nested `ev.result.details` defensively.

// Task statuses per rpiv-todo tool/types.ts. "deleted" is a tombstone: rpiv's
// own overlay hides it, so the panel drops it too.
const STATUSES = ["pending", "in_progress", "completed", "deleted"];

// Extract the rpiv-todo details envelope from a tool_result-like object.
// Live pi events carry it on `.details`; a nested `.result.details` and a
// bare TaskDetails envelope (rpiv-todo's persisted snapshot shape) are
// accepted defensively.
function extractDetails(resultLike) {
  if (!resultLike || typeof resultLike !== "object" || Array.isArray(resultLike)) return null;
  if (resultLike.details !== undefined) return resultLike.details;
  const result = resultLike.result;
  if (result && typeof result === "object" && !Array.isArray(result) && result.details !== undefined) {
    return result.details;
  }
  if (resultLike.tasks !== undefined) return resultLike;
  return null;
}

// A JSON string that parses to an array decodes (rpiv-todo repairs
// double-encoded arrays the same way, see its tool/normalize-params.ts);
// anything else is not a task list.
function decodeTasks(value) {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return Array.isArray(v) ? v : null;
}

// One task -> { id, subject, status, activeForm? }, or null when malformed,
// or undefined for a deleted tombstone (hidden, like rpiv-todo's overlay).
function normalizeTask(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  if (typeof t.id !== "number" || !Number.isFinite(t.id)) return null;
  if (typeof t.subject !== "string" || t.subject.length === 0) return null;
  if (typeof t.status !== "string" || !STATUSES.includes(t.status)) return null;
  if (t.status === "deleted") return undefined;
  const task = { id: t.id, subject: t.subject, status: t.status };
  if (typeof t.activeForm === "string" && t.activeForm.length > 0) task.activeForm = t.activeForm;
  return task;
}

// Parse a todo tool result into the visible task list.
// Returns [{ id, subject, status, activeForm? }] (deleted tombstones dropped),
// or null when the payload carries no readable snapshot — the caller then
// keeps whatever it showed before.
export function parseTodoTasks(resultLike) {
  const details = extractDetails(resultLike);
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const tasks = decodeTasks(details.tasks);
  if (tasks === null) return null;
  const out = [];
  for (const t of tasks) {
    const task = normalizeTask(t);
    if (task === null) return null; // one malformed element: garbage snapshot
    if (task !== undefined) out.push(task);
  }
  return out;
}

// Pure render model for the panel: done/total counts plus one line per task.
// icon: "todo" (pending, □) | "doing" (in_progress, ◐) | "done" (completed, ✓).
// activeForm travels only on the in-progress line (the present-continuous
// spinner label shown while that task runs).
export function renderTodoModel(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  let done = 0;
  const lines = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const icon = t.status === "completed" ? "done" : t.status === "in_progress" ? "doing" : "todo";
    if (icon === "done") done += 1;
    const line = {
      icon,
      subject: typeof t.subject === "string" ? t.subject : String(t?.subject ?? ""),
    };
    if (icon === "doing" && typeof t.activeForm === "string" && t.activeForm.length > 0) {
      line.activeForm = t.activeForm;
    }
    lines.push(line);
  }
  return { done, total: lines.length, lines };
}
