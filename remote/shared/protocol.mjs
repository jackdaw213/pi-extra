// pi-remote shared protocol — the contract between extension, hub, stub, and PWA.
// Plain ESM, zero dependencies. Runs on Node 22 and Bun.
// Frame shape: { v: 1, type: "...", ...payload }. Unknown types are ignored.

export const PROTOCOL_VERSION = 1;

// Agent -> Hub
export const A_HELLO = "hello"; // { machine:{id,hostname,os,release,addresses[]}, session:{id,name,cwd,model,thinkingLevel,state,pid,mode,kind,startedAt}, token }
export const A_STATE = "state"; // { sessionId, state:"idle"|"working"|"blocked", detail? }
export const A_EVENT = "event"; // { sessionId, seq, ev }   (ev = forwarded pi event)
// A_QUESTION: the extension intercepted an ask-user tool call and waits for the
// phone. callId echoes back in H_QUESTION_ANSWER. options are plain labels.
export const A_QUESTION = "question"; // { sessionId, callId, toolName, question, options:[string], multiSelect }
export const A_MESSAGE_RESULT = "message_result"; // { sessionId, ref, ok, error? }
export const A_FILE = "file"; // { sessionId, op:"put", name, b64, mime?, announcedBy? }
export const A_SPAWN_RESULT = "spawn_result"; // { ref, ok, pid?, error? }
export const A_HISTORY = "history"; // { sessionId, chunkIndex, chunkTotal, events:[...] }  (chunkIndex 0-based; chunkTotal 0 = no history, events always [])
export const A_PONG = "pong"; // {}

// Hub -> Agent
export const H_WELCOME = "welcome"; // {}
export const H_REJECT = "reject"; // { reason }
export const H_MESSAGE = "message"; // { sessionId, ref, text, deliverAs:"steer"|"followUp"|null, attachments?:[{name,b64,mime?}] }
export const H_SPAWN = "spawn"; // { ref, name?, kind? } — kind is the session kind per ADR 0006: "temp" (the default, disposable: delete erases its transcript) or "normal" (keeper: delete keeps the transcript). Absent/invalid kind on the wire is treated as "temp".
export const H_DELETE = "delete"; // { sessionId, erase:bool } — stop the session; when erase is true also remove its transcript (hub + extension both refuse erase for anything but a temp session, ADR 0006).
export const H_HISTORY_REQUEST = "history_request"; // { sessionId }  (phone asks via POST /api/history; the extension never auto-sends)
export const H_ABORT = "abort"; // { sessionId }
export const H_STOP = "stop"; // { sessionId }
// H_QUESTION_ANSWER: the phone answered an A_QUESTION. Exactly one of:
//   value    — tapped option label (string)
//   custom   — typed free text (string)
//   cancelled — true (no answer; run aborted or phone dismissed)
export const H_QUESTION_ANSWER = "question_answer"; // { sessionId, callId, value?, custom?, cancelled? }
export const H_PING = "ping"; // {}

// Hub -> Phone (WebSocket /ws)
export const P_REGISTRY = "registry"; // { machines:[{machine, sessions:[sessionSummary]}] }
// plus A_EVENT, A_FILE, A_SPAWN_RESULT, A_MESSAGE_RESULT, A_HISTORY, A_QUESTION relayed verbatim.

// Phone -> Hub REST bodies are defined in docs/SPEC.md §4.

export const STATES = ["idle", "working", "blocked"];
export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB pre-encode cap
export const HEARTBEAT_INTERVAL_MS = 25_000;
export const HEARTBEAT_TIMEOUT_MS = 60_000;

// pi events the extension forwards (see docs/SPEC.md §7). Nothing else.
export const FORWARDED_PI_EVENTS = [
  "input",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_result", // carries details.tasks from the todo tool (rpiv-todo snapshot) — older clients ignore it
  "queue_update",
  "compaction_start",
  "compaction_end",
  "session_info_changed",
];

export function frame(type, payload = {}) {
  return { v: PROTOCOL_VERSION, type, ...payload };
}

// Parses one WS text frame. Returns null for anything malformed or wrong-version.
export function parseFrame(raw) {
  try {
    const f = JSON.parse(typeof raw === "string" ? raw : String(raw));
    if (!f || typeof f !== "object" || f.v !== PROTOCOL_VERSION || typeof f.type !== "string") return null;
    return f;
  } catch {
    return null;
  }
}
