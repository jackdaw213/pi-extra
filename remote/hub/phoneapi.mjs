// Phone-facing REST API + WebSocket push channel (/ws) — docs/SPEC.md §4, §5, §8.
//
// Cookie auth: POST /api/login sets pr_auth (HttpOnly, SameSite=Lax). Tokens are
// STATELESS: HMAC-signed expiry stamps derived from the hub password, so logged-in
// sessions survive hub restarts/redeploys; the 15-minute idle expiry lives in the
// stamp and sliding renewal re-issues cookies on activity. Password compare is
// constant-time. /api/health needs no auth (SPEC §10).

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import * as P from "../shared/protocol.mjs";

const JSON_BODY_LIMIT = 1024 * 1024; // 1 MB for plain JSON bodies
// Room for inline attachments: 50 MB raw -> ~67 MB base64, plus JSON overhead.

const AUTH_SECRET_PREFIX = "pi-remote-auth:";

// Stateless auth token: "<expiryMs>.<hmac>". Deterministic per (password, expiry),
// so the same login moment validates identically on any hub process with the same
// password — restarts and redeploys never log the user out. Changing the password
// invalidates every outstanding cookie.
export function mintAuthToken(password, nowMs, idleMs) {
  const secret = createHash("sha256").update(AUTH_SECRET_PREFIX + password).digest();
  const expiry = String(nowMs + idleMs);
  const sig = createHmac("sha256", secret).update(expiry).digest("hex");
  return `${expiry}.${sig}`;
}

// Returns {ok:true, expired} for a well-formed token under `password` (expired
// flags the idle window having passed), or null for anything else.
export function verifyAuthToken(password, token, nowMs) {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const expiryMs = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(expiryMs) || expiryMs <= 0) return null;
  const secret = createHash("sha256").update(AUTH_SECRET_PREFIX + password).digest();
  const expected = createHmac("sha256", secret).update(token.slice(0, dot)).digest("hex");
  const got = token.slice(dot + 1);
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { ok: true, expired: nowMs > expiryMs };
}
const MESSAGE_BODY_LIMIT = 80 * 1024 * 1024;
const UPLOAD_BODY_LIMIT = P.MAX_FILE_BYTES + 1024 * 1024; // multipart overhead margin
const SPAWN_KNOCK_TIMEOUT_MS = 15000;
const STUB_PORT = 8788; // cold-start stub per machine (SPEC §6, §11)

function sha256(s) {
  return createHash("sha256").update(String(s ?? "")).digest();
}

// Length-normalized constant-time compare (SPEC §4).
function passwordEquals(given, expected) {
  return timingSafeEqual(sha256(given), sha256(expected));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers["content-length"] || 0);
    if (len > limit) {
      const e = new Error("body too large");
      e.tooLarge = true;
      return reject(e);
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        const e = new Error("body too large");
        e.tooLarge = true;
        req.destroy();
        return reject(e);
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", () => {
      if (!done) {
        done = true;
        reject(new Error("request aborted"));
      }
    });
  });
}

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendNoContent(res, cookie) {
  if (res.headersSent) return;
  res.writeHead(204, {
    "Cache-Control": "no-store",
    ...(cookie ? { "Set-Cookie": cookie } : {}),
  });
  res.end();
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Minimal multipart/form-data parser (Node 22, no deps). Returns
// { fields: {name:string}, file: {name, mime, data:Buffer} | null } or null.
function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) return null;
  const boundary = Buffer.from("--" + (m[1] || m[2]).trim());
  const fields = {};
  let file = null;

  let i = body.indexOf(boundary);
  if (i === -1) return null;
  while (i !== -1) {
    const afterBoundary = i + boundary.length;
    if (body[afterBoundary] === 45 && body[afterBoundary + 1] === 45) break; // "--" terminator
    let start = afterBoundary;
    if (body[start] === 13 && body[start + 1] === 10) start += 2;
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    let end = next;
    if (body[end - 2] === 13 && body[end - 1] === 10) end -= 2;
    const part = body.subarray(start, end);

    const headEnd = part.indexOf("\r\n\r\n");
    if (headEnd !== -1) {
      const headers = part.subarray(0, headEnd).toString("utf8");
      const content = part.subarray(headEnd + 4);
      const disp = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] || "";
      const rawName = /filename\*=utf-8''([^;\r\n]+)/i.exec(disp)?.[1];
      let fname = rawName !== undefined ? rawName : /filename="([^"]*)"/i.exec(disp)?.[1];
      if (fname === undefined) fname = /filename=([^;\r\n]+)/i.exec(disp)?.[1];
      const ctype = /content-type:[^\r\n]*/i.exec(headers)?.[0]?.split(":")[1]?.trim();
      if (fname !== undefined) {
        let name = fname;
        try {
          name = decodeURIComponent(fname);
        } catch {}
        file = { name, mime: ctype || "application/octet-stream", data: content };
      } else {
        const name = /[\s;]name="([^"]*)"/i.exec(disp)?.[1] ?? /^\s*[^;]*?name=([^;\r\n]+)/i.exec(disp)?.[1];
        if (name !== undefined) fields[name] = content.toString("utf8");
      }
    }
    i = next;
  }
  return { fields, file };
}

export function createPhoneApi({ registry, agents, password, passkeys }) {
  // Idle window for the stateless tokens: an untouched cookie expires after
  // 15 minutes; authenticated requests re-issue (slide) the cookie while at
  // least half the window remains. WS upgrades only validate — an
  // open-but-untouched PWA still counts as idle.
  const IDLE_TIMEOUT_MS = 15 * 60_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  function newAuthCookie() {
    return `pr_auth=${mintAuthToken(password, Date.now(), IDLE_TIMEOUT_MS)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
  }

  // Validates the cookie; when `res` is given and the token is past half its
  // window, slides it by re-issuing a fresh cookie on the response.
  function isAuthed(req, { res } = {}) {
    const verdict = verifyAuthToken(password, parseCookies(req)["pr_auth"], Date.now());
    if (!verdict || verdict.expired) return false;
    if (res) {
      const remaining = Number(parseCookies(req)["pr_auth"].split(".")[0]) - Date.now();
      if (remaining < IDLE_TIMEOUT_MS / 2) res.setHeader("Set-Cookie", newAuthCookie());
    }
    return true;
  }

  // ---- WebSocket push channel (SPEC §4) ----------------------------------
  wss.on("connection", (ws) => {
    // Start every phone with a full snapshot so the PWA renders immediately.
    try {
      ws.send(JSON.stringify(P.frame(P.P_REGISTRY, registry.snapshot())));
    } catch {}
    ws.on("message", () => {}); // phones only receive in v1
    ws.on("error", () => {});
  });

  function broadcast(frame) {
    if (wss.clients.size === 0) return;
    const s = JSON.stringify(frame);
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      try {
        ws.send(s);
      } catch {}
    }
  }

  function handleUpgrade(req, socket, head) {
    if (!isAuthed(req)) {
      try {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      } catch {}
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  }

  // ---- shared helpers -----------------------------------------------------
  async function jsonBody(req, limit = JSON_BODY_LIMIT) {
    const buf = await readBody(req, limit);
    try {
      return JSON.parse(buf.toString("utf8") || "{}");
    } catch {
      const e = new Error("bad json");
      e.badJson = true;
      throw e;
    }
  }

  function bodyError(res, e) {
    if (e && e.tooLarge) return sendJson(res, 413, { error: "Body too large." });
    if (e && e.badJson) return sendJson(res, 400, { error: "The request body must be JSON." });
    return sendJson(res, 400, { error: "Could not read the request body." });
  }

  function requireString(v) {
    return typeof v === "string" && v.length > 0;
  }

  // Returns [] | [{name,b64,mime?}] | null when invalid.
  function sanitizeAttachments(list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const a of list) {
      if (!a || typeof a.name !== "string" || typeof a.b64 !== "string") return null;
      if (a.mime !== undefined && a.mime !== null && typeof a.mime !== "string") return null;
      out.push({ name: a.name, b64: a.b64, ...(a.mime ? { mime: a.mime } : {}) });
    }
    let bytes = 0;
    for (const a of out) bytes += Math.floor((a.b64.length * 3) / 4);
    if (bytes > P.MAX_FILE_BYTES) return null;
    return out;
  }

  // ---- endpoints -----------------------------------------------------------

  async function handleLogin(req, res) {
    let body;
    try {
      body = await jsonBody(req);
    } catch (e) {
      return bodyError(res, e);
    }
    if (typeof body.password !== "string" || !passwordEquals(body.password, password)) {
      return sendJson(res, 401, { error: "Wrong password." });
    }
    sendNoContent(res, newAuthCookie());
  }

  async function handleMessage(req, res) {
    let b;
    try {
      b = await jsonBody(req, MESSAGE_BODY_LIMIT);
    } catch (e) {
      return bodyError(res, e);
    }
    const { sessionId, machineId, text, deliverAs, attachments } = b;
    if (typeof sessionId !== "string" || !requireString(machineId) || typeof text !== "string") {
      return sendJson(res, 400, { error: "sessionId, machineId and text are required." });
    }
    if (deliverAs !== undefined && deliverAs !== null && deliverAs !== "steer" && deliverAs !== "followUp") {
      return sendJson(res, 400, { error: 'deliverAs must be "steer" or "followUp".' });
    }
    const atts = sanitizeAttachments(attachments);
    if (atts === null) return sendJson(res, 400, { error: "Bad attachments." });

    const ref = randomUUID();
    const frame = P.frame(P.H_MESSAGE, { sessionId, ref, text, deliverAs: deliverAs ?? null });
    if (atts.length) frame.attachments = atts;
    if (!agents.sendToSession(machineId, sessionId, frame)) {
      return sendJson(res, 404, { error: "Session not found." });
    }
    return sendJson(res, 202, { ref }); // result arrives as message_result on /ws
  }

  async function handleSpawn(req, res) {
    let b;
    try {
      b = await jsonBody(req);
    } catch (e) {
      return bodyError(res, e);
    }
    const { machineId, name } = b;
    if (!requireString(machineId)) return sendJson(res, 400, { error: "machineId is required." });
    if (name !== undefined && name !== null && typeof name !== "string") {
      return sendJson(res, 400, { error: "name must be a string." });
    }
    // Session kind per ADR 0006: optional, defaults to "temp". Strictly
    // validated here; absent/null on the relayed frame means temp again.
    const kind = b.kind === undefined || b.kind === null ? "temp" : b.kind;
    if (kind !== "temp" && kind !== "normal") {
      return sendJson(res, 400, { error: 'kind must be "temp" or "normal".' });
    }
    const ref = randomUUID();

    // Path 1 (SPEC §6): a live session on the machine relays the spawn.
    if (
      agents.hasLiveSession(machineId) &&
      agents.sendToMachine(machineId, P.frame(P.H_SPAWN, { ref, kind, ...(name ? { name } : {}) }))
    ) {
      return sendJson(res, 202, { ref });
    }

    // Path 2: no live session — knock the cold-start stub on the machine.
    const mrec = registry.getMachine(machineId);
    const addresses = mrec?.machine?.addresses;
    if (!mrec || !Array.isArray(addresses) || addresses.length === 0) {
      return sendJson(res, 404, { error: "Machine not connected." });
    }
    const qs = new URLSearchParams({ token: mrec.spawnToken || "" });
    if (name) qs.set("name", name);
    qs.set("kind", kind);
    const knockUrl = `http://${addresses[0]}:${STUB_PORT}/spawn?` + qs.toString();
    let result;
    try {
      const r = await fetch(knockUrl, { signal: AbortSignal.timeout(SPAWN_KNOCK_TIMEOUT_MS) });
      let j = null;
      try {
        j = await r.json();
      } catch {}
      if (r.ok && j && j.ok === true) {
        result = { ref, ok: true, ...(Number.isFinite(j.pid) ? { pid: j.pid } : {}) };
      } else {
        result = {
          ref,
          ok: false,
          error: r.ok ? "The machine answered but did not start a session." : "The machine refused the spawn request.",
        };
      }
    } catch (e) {
      result = {
        ref,
        ok: false,
        error:
          e?.name === "TimeoutError"
            ? "The machine did not answer in time."
            : "Could not reach the machine stub.",
      };
    }
    // The stub only answers ok:true synchronously; the hub emits the
    // spawn_result itself so the phone learns the outcome on /ws (SPEC §6).
    broadcast(P.frame(P.A_SPAWN_RESULT, result));
    return sendJson(res, 202, { ref });
  }

  // Phone asks a session for its past transcript (phone-ui spec). The hub
  // routes history_request to that session's agent; the reply arrives as
  // A_HISTORY chunk frames on /ws, relayed verbatim (see agents.mjs).
  async function handleHistory(req, res) {
    let b;
    try {
      b = await jsonBody(req);
    } catch (e) {
      return bodyError(res, e);
    }
    const { sessionId, machineId } = b;
    if (typeof sessionId !== "string" || !requireString(machineId)) {
      return sendJson(res, 400, { error: "sessionId and machineId are required." });
    }
    if (!agents.sendToSession(machineId, sessionId, P.frame(P.H_HISTORY_REQUEST, { sessionId }))) {
      return sendJson(res, 404, { error: "Session not found." });
    }
    return sendJson(res, 202, { ok: true }); // chunks arrive as history frames on /ws
  }

  // ---- passkey (WebAuthn) login — docs/SPEC.md §10 ------------------------
  // The hub stays single-user: registration requires the password cookie, so
  // a passkey can only be ADDED by someone who already knows the password.
  // Passkey login mints the same stateless pr_auth cookie as the password.
  // All endpoints answer 400 when the feature is disabled (no PI_REMOTE_RP_ID).
  function passkeyDisabled(res) {
    return sendJson(res, 400, { error: "Passkeys are disabled: PI_REMOTE_RP_ID is not set on the hub." });
  }

  async function handlePasskeyStatus(req, res) {
    // Public: the login view needs the flag before any auth. It leaks nothing
    // beyond "a passkey exists".
    const s = passkeys.status();
    return sendJson(res, 200, { enabled: s.enabled, registered: s.registered });
  }

  async function handlePasskeyRegisterOptions(req, res) {
    if (!passkeys.enabled) return passkeyDisabled(res);
    const { options, token } = await passkeys.registrationOptions();
    return sendJson(res, 200, { options, token });
  }

  async function handlePasskeyRegister(req, res) {
    if (!passkeys.enabled) return passkeyDisabled(res);
    let b;
    try {
      b = await jsonBody(req);
    } catch (e) {
      return bodyError(res, e);
    }
    try {
      await passkeys.register(b.response, b.token);
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : "The passkey could not be registered." });
    }
    return sendNoContent(res);
  }

  async function handlePasskeyLoginOptions(req, res) {
    if (!passkeys.enabled) return passkeyDisabled(res);
    try {
      const { options, token } = await passkeys.authenticationOptions();
      return sendJson(res, 200, { options, token });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : "No passkey is registered." });
    }
  }

  async function handlePasskeyLogin(req, res) {
    if (!passkeys.enabled) return passkeyDisabled(res);
    let b;
    try {
      b = await jsonBody(req);
    } catch (e) {
      return bodyError(res, e);
    }
    try {
      await passkeys.login(b.response, b.token);
    } catch (e) {
      return sendJson(res, 401, { error: e instanceof Error ? e.message : "Passkey login failed." });
    }
    return sendNoContent(res, newAuthCookie()); // same session as password login
  }

  async function handlePasskeyDelete(req, res) {
    if (!passkeys.enabled) return passkeyDisabled(res);
    let b;
    try {
      b = await jsonBody(req);
    } catch (e) {
      return bodyError(res, e);
    }
    if (b.id !== undefined && (typeof b.id !== "string" || b.id.length === 0)) {
      return sendJson(res, 400, { error: "id must be a non-empty string." });
    }
    // No id = remove all registered passkeys (single-user hub: they all
    // belong to the same person; password login always recovers access).
    passkeys.remove(typeof b.id === "string" ? b.id : undefined);
    return sendNoContent(res);
  }

  // Phone answer to a pending ask-user question (A_QUESTION -> H_QUESTION_ANSWER).
  // Body: { machineId, sessionId, callId, value?|custom?|cancelled? } — exactly
  // one of value (tapped option label), custom (typed text), cancelled (true).
  // The hub only routes; the extension validates callId against its pending set.
  async function handleAnswer(req, res) {
    let b;
    try {
      b = await jsonBody(req);
    } catch (e) {
      return bodyError(res, e);
    }
    const { machineId, sessionId, callId } = b;
    if (!requireString(machineId) || typeof sessionId !== "string" || !requireString(callId)) {
      return sendJson(res, 400, { error: "machineId, sessionId and callId are required." });
    }
    let answer;
    if (b.cancelled === true) answer = { cancelled: true };
    else if (typeof b.value === "string" && b.value.length > 0) answer = { value: b.value };
    else if (typeof b.custom === "string" && b.custom.length > 0) answer = { custom: b.custom };
    else return sendJson(res, 400, { error: "One of value, custom or cancelled is required." });
    if (!agents.sendToSession(machineId, sessionId, P.frame(P.H_QUESTION_ANSWER, { sessionId, callId, ...answer }))) {
      return sendJson(res, 404, { error: "Session not found." });
    }
    return sendJson(res, 202, { ok: true });
  }

  async function handleAbort(req, res) {
    let b;
    try {
      b = await jsonBody(req);
    } catch (e) {
      return bodyError(res, e);
    }
    const { sessionId, machineId } = b;
    if (typeof sessionId !== "string" || !requireString(machineId)) {
      return sendJson(res, 400, { error: "sessionId and machineId are required." });
    }
    if (!agents.sendToSession(machineId, sessionId, P.frame(P.H_ABORT, { sessionId }))) {
      return sendJson(res, 404, { error: "Session not found." });
    }
    return sendJson(res, 202, { ok: true });
  }

  async function handleStop(req, res) {
    let b;
    try {
      b = await jsonBody(req);
    } catch (e) {
      return bodyError(res, e);
    }
    const { sessionId, machineId } = b;
    if (typeof sessionId !== "string" || !requireString(machineId)) {
      return sendJson(res, 400, { error: "sessionId and machineId are required." });
    }
    const entry = registry.getEntry(machineId, sessionId);
    if (!entry) return sendJson(res, 404, { error: "Session not found." });
    if (entry.session.mode !== "remote") {
      return sendJson(res, 400, { error: "Only remote sessions can be stopped." });
    }
    if (!agents.sendToSession(machineId, sessionId, P.frame(P.H_STOP, { sessionId }))) {
      return sendJson(res, 404, { error: "Session not found." });
    }
    return sendJson(res, 202, { ok: true });
  }

  // Swipe-to-delete (ADR 0006): stop a session; erase:true additionally
  // removes the transcript. erase is accepted ONLY for sessions whose registry
  // kind is "temp" (defense in depth — the extension refuses again), because
  // erasing is irreversible and terminal/normal transcripts must survive.
  async function handleDelete(req, res) {
    let b;
    try {
      b = await jsonBody(req);
    } catch (e) {
      return bodyError(res, e);
    }
    const { sessionId, machineId } = b;
    if (typeof sessionId !== "string" || !requireString(machineId)) {
      return sendJson(res, 400, { error: "sessionId and machineId are required." });
    }
    if (b.erase !== undefined && typeof b.erase !== "boolean") {
      return sendJson(res, 400, { error: "erase must be a boolean." });
    }
    const erase = b.erase === true;
    const entry = registry.getEntry(machineId, sessionId);
    if (!entry) return sendJson(res, 404, { error: "Session not found." });
    if (erase && entry.session?.kind !== "temp") {
      return sendJson(res, 409, {
        error: "Only temp sessions can be erased. Delete without erase to keep the transcript.",
      });
    }
    if (!agents.sendToSession(machineId, sessionId, P.frame(P.H_DELETE, { sessionId, erase }))) {
      return sendJson(res, 404, { error: "Session not found." });
    }
    return sendJson(res, 202, { ok: true });
  }

  // Phone -> session file upload (SPEC §4, §8): multipart machineId, sessionId, file.
  async function handleFileUpload(req, res) {
    const ctype = req.headers["content-type"] || "";
    if (!/multipart\/form-data/i.test(ctype)) {
      return sendJson(res, 400, { error: "Use multipart/form-data." });
    }
    let body;
    try {
      body = await readBody(req, UPLOAD_BODY_LIMIT);
    } catch (e) {
      return bodyError(res, e);
    }
    const parsed = parseMultipart(body, ctype);
    if (!parsed) return sendJson(res, 400, { error: "Could not parse the upload." });
    const machineId = parsed.fields.machineId;
    const sessionId = parsed.fields.sessionId;
    if (!machineId || !sessionId) {
      return sendJson(res, 400, { error: "machineId and sessionId fields are required." });
    }
    if (!parsed.file || !parsed.file.name) {
      return sendJson(res, 400, { error: "A file field is required." });
    }
    if (parsed.file.data.length > P.MAX_FILE_BYTES) {
      return sendJson(res, 413, { error: "File is larger than 50 MB." });
    }
    const ref = randomUUID();
    const frame = P.frame(P.H_MESSAGE, {
      sessionId,
      ref,
      text: "", // the extension appends the "attached file (saved)" line itself
      deliverAs: null,
      attachments: [
        {
          name: parsed.file.name,
          b64: parsed.file.data.toString("base64"),
          mime: parsed.file.mime,
        },
      ],
    });
    if (!agents.sendToSession(machineId, sessionId, frame)) {
      return sendJson(res, 404, { error: "Session not found." });
    }
    return sendJson(res, 202, { ref });
  }

  // Session -> phone file download (SPEC §4, §8): hub asks the agent with the
  // hub-internal file_get frame (see agents.mjs), then streams the answer back.
  async function handleFileDownload(req, res, url) {
    const q = url.searchParams;
    const machineId = q.get("machineId");
    const sessionId = q.get("sessionId");
    const filePath = q.get("path") ?? q.get("name");
    if (!machineId || !sessionId || !filePath) {
      return sendJson(res, 400, { error: "machineId, sessionId and path are required." });
    }
    const r = await agents.fetchFile(machineId, sessionId, filePath);
    if (!r.ok) return sendJson(res, r.status || 502, { error: r.error || "Could not fetch the file." });
    const data = Buffer.from(r.b64, "base64");
    const name = String(r.name || filePath.split("/").pop() || "file");
    const safeName = name.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "file";
    res.writeHead(200, {
      "Content-Type": r.mime || "application/octet-stream",
      "Content-Length": data.length,
      "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    });
    res.end(data);
  }

  async function handleApi(req, res, url) {
    const p = url.pathname;

    if (p === "/api/health") return sendJson(res, 200, { ok: true }); // no auth (§10)
    if (p === "/api/login") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      return handleLogin(req, res);
    }
    // Public passkey LOGIN endpoints (pre-auth): the login view fetches the
    // feature flag and drives the browser WebAuthn ceremony before any
    // cookie exists. Registration/management endpoints stay behind the gate.
    if (p === "/api/passkey/enabled") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "Use GET." });
      return handlePasskeyStatus(req, res);
    }
    if (p === "/api/passkey/login/options") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      return handlePasskeyLoginOptions(req, res);
    }
    if (p === "/api/passkey/login") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      return handlePasskeyLogin(req, res);
    }

    if (!isAuthed(req, { res })) return sendJson(res, 401, { error: "Login required." });

    if (p === "/api/ping") {
      // User-activity heartbeat from the phone: isAuthed already touched the
      // sliding session, nothing else to do.
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      return sendNoContent(res);
    }
    if (p === "/api/logout") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      res.setHeader("Set-Cookie", "pr_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
      return sendNoContent(res);
    }
    if (p === "/api/registry") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "Use GET." });
      return sendJson(res, 200, registry.snapshot());
    }
    if (p === "/api/message") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      return handleMessage(req, res);
    }
    if (p === "/api/history") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      return handleHistory(req, res);
    }
    if (p === "/api/answer") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      return handleAnswer(req, res);
    }
    if (p === "/api/spawn") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      return handleSpawn(req, res);
    }
    if (p === "/api/abort") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      return handleAbort(req, res);
    }
    if (p === "/api/stop") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      return handleStop(req, res);
    }
    if (p === "/api/delete") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      return handleDelete(req, res);
    }
    if (p === "/api/file") {
      if (req.method === "POST") return handleFileUpload(req, res);
      if (req.method === "GET") return handleFileDownload(req, res, url);
      return sendJson(res, 405, { error: "Use GET or POST." });
    }
    // Auth-only passkey endpoints (registration management). Login endpoints
    // above sit BEFORE the auth gate on purpose.
    if (p === "/api/passkey/register/options") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      return handlePasskeyRegisterOptions(req, res);
    }
    if (p === "/api/passkey/register") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      return handlePasskeyRegister(req, res);
    }
    if (p === "/api/passkey/delete") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      return handlePasskeyDelete(req, res);
    }
    return sendJson(res, 404, { error: "Not found." });
  }

  return { handleApi, handleUpgrade, broadcast, wss };
}
