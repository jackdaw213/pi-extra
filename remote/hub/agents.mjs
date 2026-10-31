// Agent-facing WebSocket endpoint (/agent) — docs/SPEC.md §3, §5, §10.
//
// One WebSocket per pi session (the extension dials the hub per session).
// Token check happens on hello (§5); bad tokens get `reject` + close.
// Frames from agents (event / file / spawn_result / message_result / history)
// are relayed verbatim to every connected phone via the `fanout` callback.
// Heartbeats: the hub sends a JSON `ping` every 25 s and drops an agent after
// 60 s of silence (HEARTBEAT_* in shared/protocol.mjs).

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import * as P from "../shared/protocol.mjs";

// PROTOCOL EXTENSION (hub -> agent), kept out of shared/ on purpose — v1.1:
//   { v:1, type:"file_get", sessionId, path, fetchId }
// The agent answers with the normal A_FILE frame (op:"put", announcedBy:"fetch")
// carrying { name, b64, mime? } and echoes fetchId when it can. Used by the
// hub to serve GET /api/file (SPEC §8 "fetch any file"). The extension agent
// is told the same; agents that ignore the frame just cause a timeout.
export const H_FILE_GET = "file_get";

function tokenDigest(t) {
  return createHash("sha256").update(String(t)).digest();
}

// Constant-time enough: hashes normalize length before timingSafeEqual.
function tokensEqual(a, b) {
  return timingSafeEqual(tokenDigest(a), tokenDigest(b));
}

export function createAgentHub({ registry, getTokens, fanout }) {
  const conns = new Map(); // connId -> { id, ws, lastSeen, token }

  // Pending phone-initiated file fetches: "connId/sessionId" -> { fetchId, resolve, timer }.
  // One in-flight fetch per session; concurrent requests get a 409 upstream.
  const pendingFetches = new Map();

  const wss = new WebSocketServer({ noServer: true, maxPayload: P.MAX_FILE_BYTES * 2 });

  const isOpen = (ws) => ws.readyState === ws.OPEN;
  const send = (ws, frame) => {
    if (!isOpen(ws)) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  };
  const broadcastRegistry = () => fanout(P.frame(P.P_REGISTRY, registry.snapshot()));

  function checkToken(candidate) {
    const tokens = getTokens();
    if (typeof candidate !== "string" || candidate.length === 0 || tokens.size === 0) return false;
    for (const t of tokens) if (tokensEqual(t, candidate)) return true;
    return false;
  }

  function settleFetch(conn, f) {
    let key = conn.id + "/" + f.sessionId;
    let pending = pendingFetches.get(key) || null;
    if (!pending && f.fetchId) {
      for (const [k, v] of pendingFetches) {
        if (v.fetchId === f.fetchId) {
          pending = v;
          key = k;
          break;
        }
      }
    }
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingFetches.delete(key);
    pending.resolve({ ok: true, name: f.name, b64: f.b64, mime: f.mime });
  }

  function handle(conn, f) {
    switch (f.type) {
      case P.A_HELLO: {
        if (!checkToken(f.token)) {
          send(conn.ws, P.frame(P.H_REJECT, { reason: "bad token" }));
          conn.ws.close(1008, "bad token");
          return;
        }
        conn.token = f.token;
        if (registry.register(conn.id, f.machine, f.session, f.token)) broadcastRegistry();
        send(conn.ws, P.frame(P.H_WELCOME));
        return;
      }
      case P.A_STATE: {
        if (registry.applyState(conn.id, f.sessionId, f.state, f.detail)) broadcastRegistry();
        return;
      }
      // Relayed verbatim to all phones; the PWA filters by sessionId (SPEC §4).
      // A_HISTORY carries replayed transcript chunks (phone-ui history spec).
      case P.A_EVENT:
      case P.A_HISTORY:
      case P.A_QUESTION: // ask-user interception: the phone renders and answers it
      case P.A_MESSAGE_RESULT:
      case P.A_SPAWN_RESULT:
        fanout(f);
        return;
      case P.A_FILE: {
        if (f.op === "put" && f.announcedBy === "fetch") settleFetch(conn, f);
        fanout(f);
        return;
      }
      case P.A_PONG:
        return; // lastSeen is refreshed on every inbound frame
      case P.H_PING:
        send(conn.ws, P.frame(P.A_PONG)); // agents may ping the hub too; be polite
        return;
      default:
        return; // unknown types are ignored per protocol
    }
  }

  wss.on("connection", (ws) => {
    const conn = { id: randomUUID(), ws, lastSeen: Date.now(), token: null };
    conns.set(conn.id, conn);

    ws.on("message", (data, isBinary) => {
      conn.lastSeen = Date.now();
      if (isBinary) return;
      const f = P.parseFrame(String(data));
      if (f) handle(conn, f);
    });

    ws.on("close", () => {
      conns.delete(conn.id);
      const prefix = conn.id + "/";
      for (const [k, p] of [...pendingFetches]) {
        if (!k.startsWith(prefix)) continue;
        clearTimeout(p.timer);
        pendingFetches.delete(k);
        p.resolve({ ok: false, status: 502, error: "The agent hung up during the file request." });
      }
      if (registry.removeConnection(conn.id)) broadcastRegistry();
    });

    ws.on("error", () => {}); // 'close' always follows; cleanup happens there
  });

  // Heartbeat (SPEC §3): JSON ping every 25 s; terminate after 60 s of silence.
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const conn of conns.values()) {
      if (now - conn.lastSeen > P.HEARTBEAT_TIMEOUT_MS) {
        try {
          conn.ws.terminate();
        } catch {}
        continue;
      }
      send(conn.ws, P.frame(P.H_PING));
    }
  }, P.HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  function sendToSession(machineId, sessionId, frame) {
    const entry = registry.getEntry(machineId, sessionId);
    if (!entry) return false;
    const conn = conns.get(entry.connId);
    if (!conn || !isOpen(conn.ws)) return false;
    return send(conn.ws, frame);
  }

  function sendToMachine(machineId, frame) {
    const live = registry.liveSessionConnId(machineId);
    if (live) {
      const conn = conns.get(live);
      if (conn && isOpen(conn.ws)) return send(conn.ws, frame);
    }
    for (const id of registry.machineConnIds(machineId)) {
      const conn = conns.get(id);
      if (conn && isOpen(conn.ws)) return send(conn.ws, frame);
    }
    return false;
  }

  // Ask an agent for a file (hub-internal file_get, see header comment).
  // Resolves { ok:true, name, b64, mime } or { ok:false, status, error }.
  function fetchFile(machineId, sessionId, path, timeoutMs = 15000) {
    const entry = registry.getEntry(machineId, sessionId);
    if (!entry) return Promise.resolve({ ok: false, status: 404, error: "Session not found." });
    const conn = conns.get(entry.connId);
    if (!conn || !isOpen(conn.ws))
      return Promise.resolve({ ok: false, status: 404, error: "The agent is not connected." });
    const key = conn.id + "/" + sessionId;
    if (pendingFetches.has(key))
      return Promise.resolve({
        ok: false,
        status: 409,
        error: "Another file request is already running for this session.",
      });
    const fetchId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingFetches.delete(key);
        resolve({ ok: false, status: 504, error: "The agent did not answer the file request." });
      }, timeoutMs);
      pendingFetches.set(key, { fetchId, resolve, timer });
      send(conn.ws, { v: P.PROTOCOL_VERSION, type: H_FILE_GET, sessionId, path, fetchId });
    });
  }

  return {
    wss,
    fetchFile,
    sendToSession,
    sendToMachine,
    hasLiveSession: (machineId) => registry.hasLiveSession(machineId),
  };
}
