// isSubagentSession — decide whether a session_start belongs to a pi subagent
// so the remote extension can stay inert for it (features: "Subagent sessions
// never appear in the list").
//
// Signals (all gathered defensively by the extension; this module is pure):
//   parentSession — the session header's parentSession field (docs/session-format.md:
//       set for /fork, /clone, and newSession({ parentSession }); pi's in-process
//       subagents create their session via SessionManager.create(cwd, dir,
//       { parentSession: parent.sessionFile })). A truthy parentSession on a
//       FRESH start is a subagent; user-driven session switches carry their own
//       session_start reason and must still register.
//   name — pi subagents are named "<agent>#<8 hex>" by the subagents package
//       (setSessionName runs BEFORE session_start fires). Secondary signal,
//       gated to fresh starts.
//   reason — the session_start reason. Subagent sessions fire "startup" (pi's
//       default); user-driven switches fire new/resume/fork/clone/reload.
import { test } from "node:test";
import assert from "node:assert/strict";

import { isSubagentSession, parentSessionFromHeaderLine } from "../shared/subagent.mjs";

const T = (name, fn) => test(name, fn);

// ---- parentSession signal (primary) ---------------------------------------

T("truthy parentSession on a fresh start is a subagent", () => {
  assert.equal(
    isSubagentSession({ parentSession: "/home/x/.pi/agent/sessions/a/b.jsonl", reason: "startup" }),
    true,
  );
});

T("parentSession with a missing reason still counts (fresh by default)", () => {
  assert.equal(isSubagentSession({ parentSession: "/p/s.jsonl" }), true);
});

T("parentSession on a user-driven switch is NOT a subagent", () => {
  for (const reason of ["new", "resume", "fork", "clone", "reload"]) {
    assert.equal(isSubagentSession({ parentSession: "/p/s.jsonl", reason }), false, reason);
  }
});

T("no parentSession and no name is never a subagent, whatever the reason", () => {
  assert.equal(isSubagentSession({ reason: "startup" }), false);
  assert.equal(isSubagentSession({}), false);
  assert.equal(isSubagentSession(), false);
});

// ---- name suffix signal (secondary) ---------------------------------------

T("the observed subagent name shape '#<8 hex>' on a fresh start is a subagent", () => {
  assert.equal(isSubagentSession({ name: "researcher#8bfcde41", reason: "startup" }), true);
});

T("name suffix needs 6+ hex chars", () => {
  assert.equal(isSubagentSession({ name: "agent#abcde", reason: "startup" }), false);
  assert.equal(isSubagentSession({ name: "agent#abcdef", reason: "startup" }), true);
});

T("name suffix must be hex", () => {
  assert.equal(isSubagentSession({ name: "agent#xyz123", reason: "startup" }), false);
  assert.equal(isSubagentSession({ name: "agent#12345g", reason: "startup" }), false);
});

T("a hash not at the end of the name does not match", () => {
  assert.equal(isSubagentSession({ name: "agent#8bfcde41x", reason: "startup" }), false);
  assert.equal(isSubagentSession({ name: "a#8bfcde41/b", reason: "startup" }), false);
});

T("subagent-looking name on a user-driven switch is NOT a subagent", () => {
  // A resumed or forked session keeps its old name; a human chose to open it.
  assert.equal(isSubagentSession({ name: "researcher#8bfcde41", reason: "resume" }), false);
  assert.equal(isSubagentSession({ name: "researcher#8bfcde41", reason: "fork" }), false);
});

// ---- combined -------------------------------------------------------------

T("both signals together still decide true", () => {
  assert.equal(
    isSubagentSession({
      parentSession: "/p/parent.jsonl",
      name: "researcher#8bfcde41",
      reason: "startup",
    }),
    true,
  );
});

T("a normal terminal session is not a subagent", () => {
  assert.equal(isSubagentSession({ name: "my work", reason: "startup" }), false);
});

T("a phone-spawned session (rpc, plain --name) is not a subagent", () => {
  assert.equal(isSubagentSession({ name: "deploy help", reason: "startup" }), false);
});

// ---- header line parser ---------------------------------------------------

T("parentSessionFromHeaderLine reads the documented header field", () => {
  const line =
    '{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/p","parentSession":"/p/original/session.jsonl"}';
  assert.equal(parentSessionFromHeaderLine(line), "/p/original/session.jsonl");
});

T("a header without parentSession yields undefined", () => {
  const line =
    '{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/p"}';
  assert.equal(parentSessionFromHeaderLine(line), undefined);
});

T("a null/empty parentSession yields undefined", () => {
  assert.equal(
    parentSessionFromHeaderLine('{"type":"session","parentSession":null}'),
    undefined,
  );
  assert.equal(parentSessionFromHeaderLine('{"type":"session","parentSession":""}'), undefined);
});

T("garbage lines yield undefined", () => {
  assert.equal(parentSessionFromHeaderLine("not json"), undefined);
  assert.equal(parentSessionFromHeaderLine(""), undefined);
  assert.equal(parentSessionFromHeaderLine("[1,2,3]"), undefined);
  assert.equal(parentSessionFromHeaderLine('{"parentSession":42}'), undefined);
});
