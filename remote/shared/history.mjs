// pi-remote shared history — map a pi session transcript (JSONL) to replay
// events the phone already renders, and chunk them for the wire.
// Plain ESM, zero dependencies. Runs on Node 22 and Bun inside pi (extension).
//
// Replay events are shaped exactly like the forwarded pi events consumed by
// hub/web/app/attach.mjs handleEvent (shapes per pi docs/json.md):
//
//   user message       -> { type:"input", text }                         (1 per message; text only, images dropped)
//   assistant message  -> { type:"message_start", message:{ role:"assistant", content:[], timestamp? } }
//                       { type:"message_end",   message:{ role:"assistant", content:[...], timestamp? } }
//   tool call          -> { type:"tool_execution_start", toolCallId, toolName, args }
//   tool result        -> { type:"tool_execution_end", toolCallId, toolName, result:{content:[...]}, isError, durationMs? }
//
// Contract notes (documented decisions, see test/history.test.mjs):
// - User messages replay as `input` ONLY — never a user message_start echo —
//   so the phone renders each user bubble exactly once with no dedupe step.
// - Assistant text replays as message_start (empty content, like live) plus
//   message_end carrying the final content: text blocks and toolCall blocks,
//   thinking/signature provider data stripped.
// - tool_execution_end.durationMs is derived (toolResult entry timestamp minus
//   the requesting assistant message timestamp) — an approximation of the
//   tool's own duration, which the transcript does not record. Omitted when
//   either timestamp is missing or the difference is negative.
// - A tool call whose result is not in the file (session still running or
//   crashed) emits NO synthetic end: the card stays "running" and a live
//   tool_execution_end finalizes it by toolCallId.
// - Oversized data truncates: tool arguments serialize >2 KB -> a truncated
//   JSON string; tool result text >2 KB -> head plus a "[truncated]" marker.
// - Skipped as noise: session header, system/branchSummary/compactionSummary/
//   bashExecution/custom message roles, compaction/context_edit/branch_summary/
//   usage/custom/label/session_info/model_change/thinking_level_change/
//   custom_message entries, unknown entry types, unknown message roles,
//   malformed lines. Sessions with /tree branching replay in file order
//   (chronological), not active-branch order.

// Wire-size caps. Oversized tool arguments/results are cut here so one history
// frame stays small; the phone renders short summaries anyway.
const TRUNCATE_CHARS = 2048;
const TRUNCATION_MARKER = "\n…[truncated]";

// Default chunk shape for A_HISTORY frames (see protocol.mjs).
const MAX_EVENTS_PER_CHUNK = 200;
const MAX_CHUNK_BYTES = 256 * 1024;

function truncateText(text) {
  return text.length > TRUNCATE_CHARS ? text.slice(0, TRUNCATE_CHARS) + TRUNCATION_MARKER : text;
}

// Tool arguments pass through when small; oversized ones become a truncated
// JSON string (attach.mjs argsSummary renders strings fine).
function fitArguments(args) {
  if (args === undefined) return undefined;
  try {
    const json = JSON.stringify(args);
    if (json === undefined) return "[unserializable arguments]";
    if (json.length <= TRUNCATE_CHARS) return args;
    return truncateText(json);
  } catch {
    return "[unserializable arguments]";
  }
}

// Joined text of a message content (string or content-block array).
function joinedText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const text = content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text;
}

function finiteNumber(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isoToMs(iso) {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// Assistant content sanitized for replay: text + toolCall blocks only,
// thinking blocks and provider signatures dropped, oversized args truncated.
function replayAssistantContent(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ type: "text", text: block.text });
    } else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
      out.push({ type: "toolCall", id: block.id, name: block.name, arguments: fitArguments(block.arguments) });
    }
    // thinking / unknown block types are dropped
  }
  return out;
}

// One parsed JSONL line -> zero or more replay events.
function eventsForEntry(entry, pendingCalls) {
  if (!entry || typeof entry !== "object") return [];
  if (entry.type === "message") {
    const message = entry.message;
    if (!message || typeof message !== "object") return [];
    const timestamp = finiteNumber(message.timestamp);
    switch (message.role) {
      case "user": {
        const text = joinedText(message.content);
        return text ? [{ type: "input", text }] : [];
      }
      case "assistant": {
        const content = replayAssistantContent(message.content);
        const events = [
          { type: "message_start", message: { role: "assistant", content: [], ...(timestamp !== null ? { timestamp } : {}) } },
          { type: "message_end", message: { role: "assistant", content, ...(timestamp !== null ? { timestamp } : {}) } },
        ];
        for (const block of content) {
          if (block.type === "toolCall") {
            pendingCalls.set(block.id, {
              toolName: block.name,
              requestedAt: timestamp,
            });
            events.push({
              type: "tool_execution_start",
              toolCallId: block.id,
              toolName: block.name,
              ...(block.arguments !== undefined ? { args: block.arguments } : {}),
            });
          }
        }
        return events;
      }
      case "toolResult": {
        if (typeof message.toolCallId !== "string") return [];
        const pending = pendingCalls.get(message.toolCallId);
        pendingCalls.delete(message.toolCallId);
        const toolName = typeof message.toolName === "string" ? message.toolName : (pending?.toolName ?? "tool");
        const resultText = truncateText(joinedText(message.content) || "");
        const isError = message.isError === true;
        const durationMs = deriveDurationMs(pending?.requestedAt, finiteNumber(message.timestamp));
        return [
          {
            type: "tool_execution_end",
            toolCallId: message.toolCallId,
            toolName,
            result: { content: resultText ? [{ type: "text", text: resultText }] : [] },
            isError,
            ...(durationMs !== null ? { durationMs } : {}),
          },
        ];
      }
      default:
        return []; // system, bashExecution, custom, branchSummary, compactionSummary, unknown roles
    }
  }
  // session header, model_change, usage, compaction, context_edit,
  // branch_summary, custom, custom_message, label, session_info, unknown types
  return [];
}

function deriveDurationMs(requestedAt, resultAt) {
  if (requestedAt === null || resultAt === null) return null;
  const delta = resultAt - requestedAt;
  return delta >= 0 ? delta : null;
}

// Parses a pi session transcript (raw JSONL text) into replay events,
// oldest first. Never throws: malformed lines and unknown shapes are skipped.
export function parseSessionTranscript(jsonlText) {
  const events = [];
  if (typeof jsonlText !== "string") return events;
  const pendingCalls = new Map(); // toolCallId -> { toolName, requestedAt }
  for (const lineText of jsonlText.split("\n")) {
    const trimmed = lineText.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // malformed line
    }
    events.push(...eventsForEntry(entry, pendingCalls));
  }
  return events;
}

const encoder = new TextEncoder();
const eventBytes = (event) => encoder.encode(JSON.stringify(event)).length;

// Splits replay events into A_HISTORY chunk payloads
// { chunkIndex, chunkTotal, events }. Limits: at most maxEvents events and
// maxBytes serialized bytes per chunk; a single event larger than the byte
// ceiling gets its own chunk (events are never split). An empty event list
// yields one empty chunk; the extension signals a missing file with
// chunkTotal 0 instead (see bridge.ts).
export function chunkHistoryEvents(events, opts = {}) {
  const maxEvents = opts.maxEvents ?? MAX_EVENTS_PER_CHUNK;
  const maxBytes = opts.maxBytes ?? MAX_CHUNK_BYTES;
  const groups = [];
  let current = [];
  let currentBytes = 0;
  for (const event of events) {
    const size = eventBytes(event);
    if (current.length > 0 && (current.length >= maxEvents || currentBytes + size > maxBytes)) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(event);
    currentBytes += size;
  }
  groups.push(current); // always at least one (possibly empty) chunk
  return groups.map((chunkEvents, i) => ({
    chunkIndex: i,
    chunkTotal: groups.length,
    events: chunkEvents,
  }));
}
