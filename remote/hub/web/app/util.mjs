// Pure helpers. No DOM access. Import-safe from Node (smoke tests).

// Last path segment of a POSIX or Windows path.
export function basename(p) {
  if (!p) return "";
  const s = String(p).replace(/[\\/]+$/, "");
  const i = s.lastIndexOf("/");
  const j = s.lastIndexOf("\\");
  const out = s.slice(Math.max(i, j) + 1);
  return out || s;
}

export function trunc(s, n = 120) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// One-line summary of a tool args object, e.g. `command=ls -la  file=a.txt`.
export function argsSummary(args) {
  if (args == null) return "";
  if (typeof args === "string") return trunc(args, 200);
  if (typeof args !== "object") return trunc(String(args), 200);
  try {
    const parts = Object.entries(args).map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${trunc(val ?? "null", 100)}`;
    });
    return trunc(parts.join("  "), 300);
  } catch {
    return trunc(String(args), 200);
  }
}

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// Human duration from milliseconds, e.g. `350 ms`, `1.2 s`.
export function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

// Decoded byte count of a base64 string (padding-aware). No decoding needed.
export function b64Bytes(b64) {
  if (typeof b64 !== "string") return 0;
  let pad = 0;
  if (b64.length > 0 && b64[b64.length - 1] === "=") pad++;
  if (b64.length > 1 && b64[b64.length - 2] === "=") pad++;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

// Push channel URL: same origin, /ws path.
export function wsUrl() {
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  return proto + location.host + "/ws";
}

// User text from an `input` event, or from a user `message` (message_start/end).
export function userTextFrom(ev) {
  if (!ev) return null;
  if (ev.type === "input") return typeof ev.text === "string" ? ev.text : null;
  const m = ev.message;
  if (!m || m.role !== "user") return null;
  const c = m.content;
  if (typeof c === "string") return c || null;
  if (Array.isArray(c)) {
    const t = c
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return t || null;
  }
  return null;
}

// Joined text blocks of an assistant message (authoritative final text).
export function assistantTextFrom(message) {
  if (!message || !Array.isArray(message.content)) return null;
  const t = message.content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n\n");
  return t.length ? t : null;
}

export function attachRoute(machineId, sessionId) {
  return `#/m/${encodeURIComponent(machineId)}/s/${encodeURIComponent(sessionId)}`;
}

// Hash routes: "#/m/<machineId>/s/<sessionId>" -> { machineId, sessionId }, else null.
export function parseHash(hash) {
  const m = /^#\/m\/([^/]+)\/s\/([^/]+)$/.exec(hash || "");
  if (!m) return null;
  try {
    return { machineId: decodeURIComponent(m[1]), sessionId: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

// Is the transcript's user message the echo of the text the phone itself
// sent? Trim both sides first: the `input` event keeps the raw typed text
// (dictation adds trailing spaces) while userTextFrom() trims the recorded
// message. The recorded message also carries display lines for image
// attachments after a "\n" separator, so the prefix case requires whitespace
// holding that newline right after the sent text — a real later message that
// merely continues it ("hello world", "hello worldX") is never swallowed.
export function isInputEcho(pendingText, messageText) {
  if (typeof pendingText !== "string" || pendingText.trim().length === 0) return false;
  if (typeof messageText !== "string") return false;
  const sent = pendingText.trim();
  const echoed = messageText.trim();
  if (echoed === sent) return true;
  return echoed.startsWith(sent) && /^\s*\n/.test(echoed.slice(sent.length));
}

// Ask-user tool names (the main rpiv extension's tool and variants). Web-local
// copy of shared/question.mjs's predicate — /shared is not served to browsers.
export function isAskUserTool(toolName) {
  return typeof toolName === "string" && /^([a-z_]*_)?ask_user_question$/.test(toolName);
}

// Bubble text for a user message. The recorded/input text carries plumbing
// lines appended for attachments — the extension's "- attached file (saved):
// <path>" per saved file and pi's "[Image: original ...]" coordinate hint —
// which are noise in a chat bubble: drop those whole lines and show only what
// was typed. Empty means the send was attachment-only; the caller picks a
// placeholder. Only WHOLE lines are dropped, so typed text that merely
// contains these strings survives.
export function userDisplayText(text) {
  if (typeof text !== "string") return "";
  const lines = text
    .split("\n")
    .filter((line) => !/^- attached file \(saved\): /.test(line) && !/^\[Image: original /.test(line));
  return lines.join("\n").trim();
}
