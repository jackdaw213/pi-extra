// Seam: todo-view.parseTodoTasks + renderTodoModel — the todo panel's pure
// logic. The rpiv-todo extension returns the full state snapshot under the
// tool result's `details` on every successful `todo` call:
//   details = { action, params, tasks: Task[], nextId, error? }
//   Task    = { id, subject, description?, activeForm?, status, blockedBy?... }
// Pi's live `tool_result` event carries that envelope on `ev.details` (custom
// tools); parseTodoTasks also accepts `ev.result.details` defensively.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTodoTasks, renderTodoModel } from "../hub/web/app/todo-view.mjs";

// A realistic successful `todo` tool result, shaped like pi's live
// `tool_result` event for a custom tool (fields per the declarations in
// pi docs/extensions.md: toolCallId, input, content, isError, toolName,
// details).
function todoResult(tasks, extra = {}) {
  return {
    type: "tool_result",
    toolCallId: "c1",
    toolName: "todo",
    input: { action: "update", id: 2, status: "in_progress" },
    content: [{ type: "text", text: "Updated #2 (pending → in_progress)" }],
    isError: false,
    details: {
      action: "update",
      params: { action: "update", id: 2, status: "in_progress" },
      tasks,
      nextId: 4,
    },
    ...extra,
  };
}

const SNAPSHOT = [
  { id: 1, subject: "Read the context files", status: "completed" },
  { id: 2, subject: "Write the failing tests", status: "in_progress", activeForm: "writing tests" },
  { id: 3, subject: "Wire the panels", status: "pending", blockedBy: [2] },
];

test("happy path: tasks parse from a realistic tool_result event", () => {
  const tasks = parseTodoTasks(todoResult(SNAPSHOT));
  assert.deepEqual(tasks, [
    { id: 1, subject: "Read the context files", status: "completed" },
    { id: 2, subject: "Write the failing tests", status: "in_progress", activeForm: "writing tests" },
    { id: 3, subject: "Wire the panels", status: "pending" },
  ]);
});

test("a bare details object also parses (snapshot shape, not the event)", () => {
  const tasks = parseTodoTasks({ action: "list", tasks: SNAPSHOT, nextId: 4 });
  assert.ok(Array.isArray(tasks) && tasks.length === 3);
});

test("result.details.tasks is read defensively when the event nests the result", () => {
  const tasks = parseTodoTasks({ result: { details: { tasks: SNAPSHOT } } });
  assert.ok(Array.isArray(tasks) && tasks.length === 3);
});

test("JSON-string-encoded tasks decode (rpiv-todo double-encoding repair)", () => {
  const tasks = parseTodoTasks(todoResult(JSON.stringify(SNAPSHOT)));
  assert.deepEqual(tasks, [
    { id: 1, subject: "Read the context files", status: "completed" },
    { id: 2, subject: "Write the failing tests", status: "in_progress", activeForm: "writing tests" },
    { id: 3, subject: "Wire the panels", status: "pending" },
  ]);
});

test("deleted tombstoned tasks are dropped from the visible list", () => {
  const tasks = parseTodoTasks(
    todoResult([...SNAPSHOT, { id: 9, subject: "scratched idea", status: "deleted" }])
  );
  assert.deepEqual(tasks.map((t) => t.id), [1, 2, 3]);
});

test("missing tasks field returns null", () => {
  assert.equal(parseTodoTasks({ details: { action: "clear", nextId: 1 } }), null);
  assert.equal(parseTodoTasks({}), null);
  assert.equal(parseTodoTasks(null), null);
  assert.equal(parseTodoTasks(undefined), null);
});

test("garbage payloads return null", () => {
  assert.equal(parseTodoTasks(todoResult("not json")), null);
  assert.equal(parseTodoTasks(todoResult({ id: 1 })), null); // object, not an array
  assert.equal(parseTodoTasks(todoResult([{ id: "x", subject: "s", status: "pending" }])), null);
  assert.equal(parseTodoTasks(todoResult([{ id: 1, subject: "", status: "pending" }])), null);
  assert.equal(parseTodoTasks(todoResult([{ id: 1, subject: "s", status: "cancelled" }])), null);
  assert.equal(parseTodoTasks(todoResult([null])), null);
  assert.equal(parseTodoTasks({ details: "garbage" }), null);
});

test("renderTodoModel counts done/total and maps icons", () => {
  const tasks = parseTodoTasks(todoResult(SNAPSHOT));
  const model = renderTodoModel(tasks);
  assert.equal(model.done, 1);
  assert.equal(model.total, 3);
  assert.deepEqual(
    model.lines.map((l) => [l.icon, l.subject]),
    [
      ["done", "Read the context files"],
      ["doing", "Write the failing tests"],
      ["todo", "Wire the panels"],
    ]
  );
});

test("renderTodoModel keeps activeForm only on the in-progress line", () => {
  const model = renderTodoModel(parseTodoTasks(todoResult(SNAPSHOT)));
  assert.equal(model.lines[0].activeForm, undefined);
  assert.equal(model.lines[1].activeForm, "writing tests");
  assert.equal(model.lines[2].activeForm, undefined);
});

test("renderTodoModel on an empty list: zero counts, no lines (panel hides)", () => {
  const model = renderTodoModel([]);
  assert.equal(model.done, 0);
  assert.equal(model.total, 0);
  assert.deepEqual(model.lines, []);
});
