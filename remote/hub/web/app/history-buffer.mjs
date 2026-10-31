// History chunk assembly for the attach view — the logic that used to live
// inline in hub/web/app/attach.mjs handleHistoryChunk/finishHistory, extracted
// as a pure module so tests run it directly in Node. No DOM, no imports.
//
// One history load owns one buffer. WS "history" frames arrive as
// { chunkIndex, chunkTotal, events } (shapes per shared/protocol.mjs):
//
// - chunkTotal 0 means the session has no history: the load completes
//   immediately with zero events.
// - A valid chunk is stored once; a repeated delivery of the same index is
//   ignored (first wins), so a duplicated tail chunk never duplicates events.
// - Frames with a malformed chunkTotal/chunkIndex are ignored.
// - The load is complete when every index 0..chunkTotal-1 has arrived;
//   assembly concatenates the chunks in index order — stream order, oldest
//   first — preserving each event exactly.

export function createHistoryBuffer() {
  return { total: null, chunks: new Map() };
}

// Records one chunk frame. Returns true when the load is complete.
export function acceptHistoryChunk(buffer, frame) {
  if (!buffer || !frame) return false;
  const total = frame.chunkTotal;
  if (total === 0) {
    buffer.total = 0; // session has no history: nothing to wait for
    return true;
  }
  if (!Number.isInteger(total) || total < 1) return false;
  const idx = frame.chunkIndex;
  if (!Number.isInteger(idx) || idx < 0 || idx >= total) return false;
  buffer.total = total;
  if (!buffer.chunks.has(idx)) {
    buffer.chunks.set(idx, Array.isArray(frame.events) ? frame.events : []);
  }
  for (let i = 0; i < total; i++) {
    if (!buffer.chunks.has(i)) return false; // still waiting on chunks
  }
  return true;
}

// All events oldest-first in chunk order, or null while the load is
// incomplete. chunkTotal 0 yields [].
export function assembleHistoryEvents(buffer) {
  if (!buffer || buffer.total == null) return null;
  for (let i = 0; i < buffer.total; i++) {
    if (!buffer.chunks.has(i)) return null; // incomplete: never assemble partial
  }
  const events = [];
  for (let i = 0; i < buffer.total; i++) events.push(...(buffer.chunks.get(i) || []));
  return events;
}
