// pi-remote shared — subagent session detection. Pure, zero-dependency.
// Runs on Node 22 and Bun inside pi (extension).
//
// pi runs subagents as in-process sessions: each one fires its own
// `session_start`, and without a guard the remote extension registers every
// subagent at the hub as if it were a session of its own. This module is the
// pure decision the extension applies in session_start to stay INERT for
// subagent sessions (no bridge, no hub connection).
//
// Signals, in evidence order:
//
// 1. parentSession (primary) — docs/session-format.md defines the session
//    header field `parentSession` for sessions "created via /fork, /clone, or
//    newSession({ parentSession })". pi's subagents create their session with
//    SessionManager.create(cwd, dir, { parentSession: parent.sessionFile }),
//    so a persisted subagent's header carries it. The field is therefore NOT
//    subagent-specific: user-driven switches (/fork, /clone, RPC new_session)
//    set it too. The discriminator is the session_start reason — those switches
//    fire with their own reason (new/resume/fork/clone/reload), while a
//    subagent session fires pi's default reason "startup" (no sessionStartEvent
//    is passed when the subagent creates its session).
//
// 2. name suffix (secondary) — the subagents package names spawned agents
//    `${base}#${agentId.slice(0, 8)}` (agentId = randomUUID().slice(0, 17), so
//    the suffix is 8 lowercase hex chars) and does so BEFORE session_start
//    fires, so the name is already visible in the handler. This is package
//    behavior, not a pi-doc guarantee, so it only ever ADDS detections (fresh
//    starts only). It is what catches subagents whose SessionManager is
//    in-memory (no session file, header unreachable).
//
// A session counts as a subagent when it is a fresh start (reason "startup",
// or missing — pi always sends one, but defensive absence counts as fresh)
// AND (parentSession is truthy OR the name ends in `#` + 6+ hex chars).

// Reasons user-driven session switches fire; a session_start with one of these
// is a human decision (possibly of a session whose header has parentSession)
// and must register as usual.
const USER_SESSION_REASONS = new Set(["new", "resume", "fork", "clone", "reload"]);

// Observed subagent naming: "researcher#8bfcde41" — 8 hex chars, but anything
// 6+ keeps the signal tolerant to other id schemes of the same shape.
const SUBAGENT_NAME_SUFFIX_RE = /#[0-9a-f]{6,}$/;

// Returns true when the session described by the signals is a subagent.
// All fields optional; unknown shapes decide "not a subagent" (fail-open:
// the worst case is today's behavior — a subagent registers at the hub).
export function isSubagentSession({ parentSession, name, reason } = {}) {
	if (typeof reason === "string" && USER_SESSION_REASONS.has(reason)) return false;
	if (parentSession) return true;
	return typeof name === "string" && SUBAGENT_NAME_SUFFIX_RE.test(name);
}

// Parses one JSONL line (the session file's first line) and returns the truthy
// `parentSession` header value, or undefined. Defensive: any malformed or
// unexpected line yields undefined.
export function parentSessionFromHeaderLine(line) {
	if (typeof line !== "string" || line.length === 0) return undefined;
	let header;
	try {
		header = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!header || typeof header !== "object" || Array.isArray(header)) return undefined;
	const p = header.parentSession;
	if (typeof p === "string" && p.length > 0) return p;
	return undefined;
}
