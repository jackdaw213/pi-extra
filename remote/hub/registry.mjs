// In-memory agent registry (docs/SPEC.md §3).
//
// Sessions are keyed "<machineId>/<sessionId>". One agent connection registers
// the sessions of its hello frames; when the connection closes its sessions
// drop immediately (SIGKILL parity: dead on socket close, no grace).
// Machine records (identity, addresses, spawn token) persist for the lifetime
// of the process once a machine has said hello: they are needed for cold spawn
// (SPEC §6 path 2) after the last session of a machine is gone.
//
// Pure data — no I/O, no dependencies.

import * as P from "../shared/protocol.mjs";

export function createRegistry() {
  const sessions = new Map(); // "machineId/sessionId" -> entry
  const machines = new Map(); // machineId -> { machine, spawnToken, connIds:Set }

  const keyOf = (machineId, sessionId) => machineId + "/" + sessionId;

  // Registers (or replaces, for the same session id) a session for a connection.
  // Returns true when the registry changed (callers broadcast a snapshot then).
  function register(connId, machine, session, token) {
    const machineId = machine && machine.id;
    const sessionId = session && session.id;
    if (typeof machineId !== "string" || typeof sessionId !== "string") return false;

    let mrec = machines.get(machineId);
    if (!mrec) {
      mrec = {
        machine: { ...machine, addresses: Array.isArray(machine.addresses) ? machine.addresses.slice() : [] },
        spawnToken: typeof token === "string" ? token : "",
        connIds: new Set(),
      };
      machines.set(machineId, mrec);
    } else {
      mrec.machine = {
        ...machine,
        addresses: Array.isArray(machine.addresses) ? machine.addresses.slice() : mrec.machine.addresses || [],
      };
      if (typeof token === "string") mrec.spawnToken = token;
    }
    mrec.connIds.add(connId);

    const key = keyOf(machineId, sessionId);
    const prev = sessions.get(key);
    const connectedSince =
      prev && prev.connId === connId ? prev.connectedSince : new Date().toISOString();
    sessions.set(key, {
      machineId,
      sessionId,
      session: { ...session },
      state: P.STATES.includes(session.state) ? session.state : "idle",
      detail: session.detail,
      connectedSince,
      connId,
    });
    return true;
  }

  // Drops every session held by a connection. Keeps machine records (see header).
  // Returns true when anything changed.
  function removeConnection(connId) {
    let changed = false;
    for (const [key, e] of [...sessions]) {
      if (e.connId !== connId) continue;
      sessions.delete(key);
      changed = true;
    }
    for (const mrec of machines.values()) mrec.connIds.delete(connId);
    return changed;
  }

  // Applies a state frame from a connection. Returns true on a visible change.
  function applyState(connId, sessionId, state, detail) {
    if (!P.STATES.includes(state)) return false;
    for (const e of sessions.values()) {
      if (e.connId !== connId || e.sessionId !== sessionId) continue;
      if (e.state === state && e.detail === detail) return false;
      e.state = state;
      e.detail = detail;
      return true;
    }
    return false;
  }

  function getEntry(machineId, sessionId) {
    return sessions.get(keyOf(machineId, sessionId)) || null;
  }

  function getMachine(machineId) {
    return machines.get(machineId) || null; // { machine, spawnToken, connIds }
  }

  // Persistable machine records: identity, addresses, spawn token. Restored
  // at boot so cold spawn (SPEC §6 path 2) works right after a hub restart,
  // before any pi session has connected again.
  function machineRecordsSnapshot() {
    return [...machines.values()].map((m) => ({
      machine: { ...m.machine, addresses: [...(m.machine.addresses || [])] },
      spawnToken: m.spawnToken,
    }));
  }

  // Seeds machine records from a machineRecordsSnapshot() array. Sessions and
  // connections are NOT restored — only the data cold spawn needs. Returns
  // the number of records added (known machines keep their in-memory record).
  function restoreMachineRecords(list) {
    if (!Array.isArray(list)) return 0;
    let added = 0;
    for (const rec of list) {
      const id = rec?.machine?.id;
      if (typeof id !== "string" || id.length === 0 || machines.has(id)) continue;
      const machine = {
        ...rec.machine,
        addresses: Array.isArray(rec.machine.addresses) ? rec.machine.addresses.slice() : [],
      };
      machines.set(id, {
        machine,
        spawnToken: typeof rec.spawnToken === "string" ? rec.spawnToken : "",
        connIds: new Set(),
      });
      added++;
    }
    return added;
  }

  // Connection id holding any live session of the machine, or null.
  function liveSessionConnId(machineId) {
    for (const e of sessions.values()) if (e.machineId === machineId) return e.connId;
    return null;
  }

  function machineConnIds(machineId) {
    return [...(machines.get(machineId)?.connIds || [])];
  }

  function hasLiveSession(machineId) {
    return liveSessionConnId(machineId) !== null;
  }

  // SPEC §4: { machines: [{ machine, sessions: [sessionSummary] }] }
  // sessionSummary = hello payload session + state (+ detail) + connectedSince.
  function snapshot() {
    const byMachine = new Map();
    for (const e of sessions.values()) {
      let list = byMachine.get(e.machineId);
      if (!list) byMachine.set(e.machineId, (list = []));
      const s = { ...e.session, state: e.state, connectedSince: e.connectedSince };
      if (e.detail !== undefined) s.detail = e.detail;
      list.push(s);
    }
    const ids = [...new Set([...byMachine.keys(), ...machines.keys()])];
    ids.sort((a, b) =>
      String(machines.get(a)?.machine?.hostname || a).localeCompare(
        String(machines.get(b)?.machine?.hostname || b)
      )
    );
    return {
      machines: ids.map((id) => ({
        machine: machines.get(id)?.machine || { id },
        sessions: (byMachine.get(id) || []).sort(
          (x, y) =>
            String(x.name || "").localeCompare(String(y.name || "")) ||
            String(x.id || "").localeCompare(String(y.id || ""))
        ),
      })),
    };
  }

  return {
    register,
    removeConnection,
    applyState,
    getEntry,
    getMachine,
    machineRecordsSnapshot,
    restoreMachineRecords,
    liveSessionConnId,
    machineConnIds,
    hasLiveSession,
    snapshot,
  };
}
