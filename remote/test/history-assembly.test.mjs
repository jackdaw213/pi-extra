// Seam: attach-view history chunk assembly (hub/web/app/history-buffer.mjs).
// Pure extraction of the chunk-assembly logic from hub/web/app/attach.mjs —
// testable directly in Node (no DOM).
//
// The "plausible stream" and "assembly equals pre-chunk list" tests run
// against REAL data: the newest pi session JSONL on this machine, mapped by
// shared/history.mjs and chunked by shared/history.mjs — the exact pipeline
// the extension runs in production. No filename is hardcoded: candidates are
// picked newest-first via readdir; the newest transcript with a substantial
// event count wins (the literal newest file is often a tiny session that just
// started). If no sessions exist at all, the tests skip with a clear message
// so the suite stays portable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSessionTranscript, chunkHistoryEvents } from "../shared/history.mjs";
import {
  createHistoryBuffer,
  acceptHistoryChunk,
  assembleHistoryEvents,
} from "../hub/web/app/history-buffer.mjs";

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
const MIN_EVENTS = 100; // a substantial transcript, not a session that just started
const MAX_CANDIDATES = 8; // newest-first scan bound; keeps the suite fast

// Newest session JSONL whose parsed transcript qualifies, or null. Never
// throws: a missing/unreadable sessions directory counts as "no data".
// minChunks lets the assembly test require a transcript that actually splits
// into several chunks (the literal newest file is often a small live session
// that still fits one).
async function loadRealTranscript({ minEvents = MIN_EVENTS, minChunks = 1 } = {}) {
  let entries;
  try {
    entries = await readdir(SESSIONS_DIR, { recursive: true });
  } catch {
    return null; // no sessions directory on this machine
  }
  const files = entries.filter((e) => e.endsWith(".jsonl"));
  const byAge = await Promise.all(
    files.map(async (rel) => {
      const full = join(SESSIONS_DIR, rel);
      const st = await stat(full).catch(() => null);
      return { full, mtimeMs: st && st.isFile() ? st.mtimeMs : -1 };
    })
  );
  byAge.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { full } of byAge.slice(0, MAX_CANDIDATES)) {
    const text = await readFile(full, "utf8").catch(() => null);
    if (text == null) continue;
    const events = parseSessionTranscript(text);
    if (events.length < minEvents) continue;
    if (chunkHistoryEvents(events).length < minChunks) continue;
    return { file: full, events };
  }
  return null;
}

test("real session transcript maps to a plausible replay stream", async (t) => {
  const real = await loadRealTranscript();
  if (!real) {
    return t.skip(`no session JSONL with >= ${MIN_EVENTS} events under ~/.pi/agent/sessions — nothing to verify against`);
  }
  const { file, events } = real;
  assert.ok(
    events.length > MIN_EVENTS,
    `expected a substantial real transcript from ${file}, got ${events.length} events`
  );
  const first = events[0];
  assert.ok(
    first.type === "input" || first.type === "message_start",
    `first replay event should be input or message_start, got ${JSON.stringify(first).slice(0, 120)}`
  );
});

test("out-of-order chunk delivery assembles exactly the pre-chunk list", async (t) => {
  const real = await loadRealTranscript({ minChunks: 2 });
  if (!real) {
    return t.skip(`no session JSONL with >= ${MIN_EVENTS} events spanning >= 2 chunks under ~/.pi/agent/sessions — nothing to verify against`);
  }
  const { file, events } = real;
  const frames = chunkHistoryEvents(events);
  assert.ok(frames.length > 1, `expected the real transcript to split into several chunks, got ${frames.length} from ${file}`);

  // Deliver reversed (worst-case out of order) through the same first-wins
  // acceptance the attach view uses.
  const buffer = createHistoryBuffer();
  let complete = false;
  for (const frame of [...frames].reverse()) {
    if (acceptHistoryChunk(buffer, frame)) {
      complete = true;
      break;
    }
  }
  assert.equal(complete, true, "delivery of every chunk must complete the load");

  const assembled = assembleHistoryEvents(buffer);
  assert.equal(assembled.length, events.length, "assembled count must equal the pre-chunk count exactly");
  assert.deepEqual(assembled, events, "assembled events must equal the pre-chunk list exactly (count AND order)");

  // Duplicate tail delivery: ignored (first-wins), assembly unchanged —
  // a late repeated chunk must never duplicate events at the tail.
  assert.equal(acceptHistoryChunk(buffer, frames[frames.length - 1]), true);
  assert.deepEqual(assembleHistoryEvents(buffer), events);
});

test("guard parity: malformed frames are ignored, partial loads stay incomplete", () => {
  const buffer = createHistoryBuffer();
  // Malformed totals and indexes: ignored, load stays incomplete.
  assert.equal(acceptHistoryChunk(buffer, { chunkIndex: 0, chunkTotal: "2", events: [] }), false);
  assert.equal(acceptHistoryChunk(buffer, { chunkIndex: 0, chunkTotal: -1, events: [] }), false);
  assert.equal(acceptHistoryChunk(buffer, { chunkTotal: 2, events: [] }), false); // no chunkIndex
  assert.equal(acceptHistoryChunk(buffer, { chunkIndex: 2, chunkTotal: 2, events: [] }), false); // out of range
  assert.equal(acceptHistoryChunk(buffer, {}), false);
  assert.equal(assembleHistoryEvents(buffer), null);

  // Real chunks arrive out of order: incomplete until the last one lands.
  const chunk0 = { chunkIndex: 0, chunkTotal: 2, events: [{ type: "input", text: "a" }] };
  const chunk1 = { chunkIndex: 1, chunkTotal: 2, events: [{ type: "message_start", message: { role: "assistant", content: [] } }] };
  assert.equal(acceptHistoryChunk(buffer, chunk1), false);
  assert.equal(assembleHistoryEvents(buffer), null);
  assert.equal(acceptHistoryChunk(buffer, chunk0), true);
  assert.deepEqual(assembleHistoryEvents(buffer), [chunk0.events[0], chunk1.events[0]]);

  // chunkTotal 0: the session has no history — complete immediately, no events.
  const empty = createHistoryBuffer();
  assert.equal(acceptHistoryChunk(empty, { chunkIndex: 0, chunkTotal: 0, events: [] }), true);
  assert.deepEqual(assembleHistoryEvents(empty), []);

  // Non-array events in a valid slot count as an empty chunk, not a crash.
  const weird = createHistoryBuffer();
  assert.equal(acceptHistoryChunk(weird, { chunkIndex: 0, chunkTotal: 1, events: "garbage" }), true);
  assert.deepEqual(assembleHistoryEvents(weird), []);
});
