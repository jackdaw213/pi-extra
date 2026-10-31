// Seam: shared/history.mjs — session JSONL -> replay-event mapping + chunking.
// Fixture lines follow pi docs/session-format.md exactly (v3 entries).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionTranscript, chunkHistoryEvents } from "../shared/history.mjs";

const T0 = 1733234400000; // 2024-12-03T14:00:00Z, unix ms

// --- fixtures (shapes straight from session-format.md) ----------------------

const header = {
  type: "session",
  version: 3,
  id: "11111111-1111-1111-1111-111111111111",
  timestamp: "2024-12-03T14:00:00.000Z",
  cwd: "/proj",
};

const systemMsg = {
  type: "message",
  id: "sys1",
  parentId: null,
  timestamp: "2024-12-03T14:00:00.500Z",
  message: { role: "system", content: "", sections: { preamble: "You are an expert" }, timestamp: T0 },
};

const userMsg = {
  type: "message",
  id: "u1",
  parentId: "sys1",
  timestamp: "2024-12-03T14:00:01.000Z",
  message: { role: "user", content: "List the files", timestamp: T0 + 1000 },
};

const assistantWithToolCall = {
  type: "message",
  id: "a1",
  parentId: "u1",
  timestamp: "2024-12-03T14:00:02.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "Running ls." },
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls -la" } },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: T0 + 2000,
  },
};

const toolResult = {
  type: "message",
  id: "t1",
  parentId: "a1",
  timestamp: "2024-12-03T14:00:03.000Z",
  message: {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "bash",
    content: [{ type: "text", text: "file.txt" }],
    isError: false,
    timestamp: T0 + 3000,
  },
};

const assistantText = {
  type: "message",
  id: "a2",
  parentId: "t1",
  timestamp: "2024-12-03T14:00:04.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "Here is **the** list." },
      { type: "thinking", thinking: "secret thoughts", thinkingSignature: "sig" },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: T0 + 4000,
  },
};

const modelChange = {
  type: "model_change",
  id: "mc1",
  parentId: "a2",
  timestamp: "2024-12-03T14:05:00.000Z",
  provider: "openai",
  modelId: "gpt-4o",
};

const usageEntry = {
  type: "usage",
  id: "us1",
  parentId: "mc1",
  timestamp: "2024-12-03T14:08:00.000Z",
  kind: "cache_warm",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  usage: { input: 0, output: 0, cacheRead: 50000, cacheWrite: 0, totalTokens: 50000, cost: { input: 0, output: 0, cacheRead: 0.015, cacheWrite: 0, total: 0.015 } },
};

const compaction = {
  type: "compaction",
  id: "cp1",
  parentId: "us1",
  timestamp: "2024-12-03T14:10:00.000Z",
  summary: "User discussed X, Y, Z...",
  firstKeptEntryId: "a2",
  tokensBefore: 50000,
};

const customEntry = {
  type: "custom",
  id: "ce1",
  parentId: "cp1",
  timestamp: "2024-12-03T14:20:00.000Z",
  customType: "my-extension",
  data: { count: 42 },
};

const labelEntry = {
  type: "label",
  id: "lb1",
  parentId: "ce1",
  timestamp: "2024-12-03T14:30:00.000Z",
  targetId: "u1",
  label: "checkpoint-1",
};

const sessionInfo = {
  type: "session_info",
  id: "si1",
  parentId: "lb1",
  timestamp: "2024-12-03T14:35:00.000Z",
  name: "Refactor auth module",
};

const customMessage = {
  type: "custom_message",
  id: "cm1",
  parentId: "si1",
  timestamp: "2024-12-03T14:25:00.000Z",
  customType: "my-extension",
  content: "Injected context...",
  display: true,
};

const line = (o) => JSON.stringify(o);
const fullFixture = [
  line(header),
  line(systemMsg),
  line(userMsg),
  line(assistantWithToolCall),
  line(toolResult),
  line(assistantText),
  line(modelChange),
  line(usageEntry),
  line(compaction),
  line(customEntry),
  line(labelEntry),
  line(sessionInfo),
  line(customMessage),
  "{not valid json", // malformed line — skipped
  "", // blank line — skipped
  line({ type: "teleport", id: "zz9", parentId: "cm1", timestamp: "2024-12-03T14:40:00.000Z" }), // unknown type — skipped
  line({ type: "message", id: "w1", parentId: "zz9", timestamp: "2024-12-03T14:41:00.000Z", message: { role: "hologram", content: "?" } }), // unknown role — skipped
  line({ type: "message", id: "w2", parentId: "w1", timestamp: "2024-12-03T14:42:00.000Z" }), // missing message — skipped
].join("\n");

// --- parseSessionTranscript --------------------------------------------------

test("maps a full session to replay events in order, skipping noise", () => {
  const events = parseSessionTranscript(fullFixture);
  assert.deepEqual(events, [
    { type: "input", text: "List the files" },
    {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: T0 + 2000 },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Running ls." },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls -la" } },
        ],
        timestamp: T0 + 2000,
      },
    },
    { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls -la" } },
    {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "file.txt" }] },
      isError: false,
      durationMs: 1000,
    },
    {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: T0 + 4000 },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here is **the** list." }],
        timestamp: T0 + 4000,
      },
    },
  ]);
});

test("emits input for user messages with mixed text+image content, images dropped", () => {
  const jsonl = [
    line(header),
    line({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2024-12-03T14:00:01.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "What is in this picture?" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
        timestamp: T0,
      },
    }),
  ].join("\n");
  assert.deepEqual(parseSessionTranscript(jsonl), [
    { type: "input", text: "What is in this picture?" },
  ]);
});

test("skips user messages without text (image-only)", () => {
  const jsonl = [
    line(header),
    line({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2024-12-03T14:00:01.000Z",
      message: { role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], timestamp: T0 },
    }),
  ].join("\n");
  assert.deepEqual(parseSessionTranscript(jsonl), []);
});

test("omits timestamp when the message has none", () => {
  const jsonl = [
    line(header),
    line({
      type: "message",
      id: "a1",
      parentId: null,
      timestamp: "2024-12-03T14:00:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    }),
  ].join("\n");
  const events = parseSessionTranscript(jsonl);
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].message, { role: "assistant", content: [{ type: "text", text: "Hi" }] });
});

test("tool call without a stored result stays open (no synthetic end)", () => {
  const jsonl = [
    line(header),
    line(assistantWithToolCall),
  ].join("\n");
  const events = parseSessionTranscript(jsonl);
  assert.deepEqual(events, [
    {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: T0 + 2000 },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Running ls." },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls -la" } },
        ],
        timestamp: T0 + 2000,
      },
    },
    { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls -la" } },
  ]);
});

test("tool result without a matching start still renders (end-only, no durationMs)", () => {
  const jsonl = [
    line(header),
    line({
      type: "message",
      id: "t1",
      parentId: null,
      timestamp: "2024-12-03T14:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_orphan",
        toolName: "read",
        content: [{ type: "text", text: "data" }],
        isError: true,
        timestamp: T0 + 3000,
      },
    }),
  ].join("\n");
  assert.deepEqual(parseSessionTranscript(jsonl), [
    {
      type: "tool_execution_end",
      toolCallId: "call_orphan",
      toolName: "read",
      result: { content: [{ type: "text", text: "data" }] },
      isError: true,
    },
  ]);
});

test("flags failed tool results with isError true", () => {
  const jsonl = [
    line(header),
    line(assistantWithToolCall),
    line({
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: "2024-12-03T14:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "exit 1" }],
        isError: true,
        timestamp: T0 + 3000,
      },
    }),
  ].join("\n");
  const events = parseSessionTranscript(jsonl);
  const end = events.find((e) => e.type === "tool_execution_end");
  assert.equal(end.isError, true);
});

test("omits durationMs when timestamps are unusable", () => {
  const jsonl = [
    line(header),
    line(assistantWithToolCall),
    line({
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: "2024-12-03T14:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: T0 + 1000, // before the assistant message — nonsense
      },
    }),
  ].join("\n");
  const events = parseSessionTranscript(jsonl);
  const end = events.find((e) => e.type === "tool_execution_end");
  assert.equal("durationMs" in end, false);
});

test("truncates oversized tool result text at ~2KB", () => {
  const big = "x".repeat(10_000);
  const jsonl = [
    line(header),
    line(assistantWithToolCall),
    line({
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: "2024-12-03T14:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: big }],
        isError: false,
        timestamp: T0 + 3000,
      },
    }),
  ].join("\n");
  const events = parseSessionTranscript(jsonl);
  const end = events.find((e) => e.type === "tool_execution_end");
  const text = end.result.content[0].text;
  assert.ok(text.length < 2200, `result text should be bounded, got ${text.length}`);
  assert.ok(text.startsWith("x"));
  assert.ok(text.endsWith("[truncated]"));
});

test("truncates oversized tool arguments to a bounded string", () => {
  const bigArgs = { command: "y".repeat(10_000) };
  const jsonl = [
    line(header),
    line({
      type: "message",
      id: "a1",
      parentId: null,
      timestamp: "2024-12-03T14:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: bigArgs }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "m",
        usage: {},
        stopReason: "toolUse",
        timestamp: T0 + 2000,
      },
    }),
  ].join("\n");
  const events = parseSessionTranscript(jsonl);
  const start = events.find((e) => e.type === "tool_execution_start");
  assert.equal(typeof start.args, "string");
  assert.ok(start.args.length < 2200, `args should be bounded, got ${start.args.length}`);
  assert.ok(start.args.startsWith("{"));
  assert.ok(start.args.endsWith("[truncated]"));
  // The toolCall block inside message_end content is truncated the same way.
  const end = events.find((e) => e.type === "message_end");
  const call = end.message.content.find((b) => b.type === "toolCall");
  assert.equal(call.arguments, start.args);
});

test("keeps small arguments as the original object", () => {
  const events = parseSessionTranscript(fullFixture);
  const start = events.find((e) => e.type === "tool_execution_start");
  assert.deepEqual(start.args, { command: "ls -la" });
});

test("tolerates garbage input: empty, blank lines, JSON fragments", () => {
  assert.deepEqual(parseSessionTranscript(""), []);
  assert.deepEqual(parseSessionTranscript("\n\n  \n"), []);
  assert.deepEqual(parseSessionTranscript("nope\n{\"a\":1\n[1,2]\nnull\n\"str\"\n42"), []);
  assert.deepEqual(parseSessionTranscript(line(header)), []);
});

// --- chunkHistoryEvents ------------------------------------------------------

test("chunks nothing into a single empty chunk", () => {
  const chunks = chunkHistoryEvents([]);
  assert.deepEqual(chunks, [{ chunkIndex: 0, chunkTotal: 1, events: [] }]);
});

test("fits up to 200 events into one chunk", () => {
  const events = Array.from({ length: 200 }, (_, i) => ({ type: "input", text: `m${i}` }));
  const chunks = chunkHistoryEvents(events);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], { chunkIndex: 0, chunkTotal: 1, events });
});

test("splits more than 200 events into ordered chunks", () => {
  const events = Array.from({ length: 250 }, (_, i) => ({ type: "input", text: `m${i}` }));
  const chunks = chunkHistoryEvents(events);
  assert.equal(chunks.length, 2);
  assert.deepEqual(
    chunks.map((c) => [c.chunkIndex, c.chunkTotal, c.events.length]),
    [[0, 2, 200], [1, 2, 50]]
  );
  assert.deepEqual([...chunks[0].events, ...chunks[1].events], events); // order preserved
});

test("respects the byte ceiling when events are large", () => {
  const ev = { type: "input", text: "z".repeat(1024) }; // ~1KB serialized each
  const events = Array.from({ length: 600 }, () => ev);
  const chunks = chunkHistoryEvents(events, { maxBytes: 64 * 1024 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    const bytes = Buffer.byteLength(JSON.stringify(c.events), "utf8");
    assert.ok(bytes <= 64 * 1024, `chunk ${c.chunkIndex} exceeds byte ceiling: ${bytes}`);
  }
  assert.deepEqual([...chunks.flatMap((c) => c.events)], events);
});

test("an event larger than the ceiling gets its own chunk, never split", () => {
  const big = { type: "input", text: "b".repeat(300 * 1024) };
  const chunks = chunkHistoryEvents([big, { type: "input", text: "small" }], { maxBytes: 256 * 1024 });
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].events, [big]);
  assert.deepEqual(chunks[1].events, [{ type: "input", text: "small" }]);
  assert.deepEqual(chunks.map((c) => c.chunkTotal), [2, 2]);
});
