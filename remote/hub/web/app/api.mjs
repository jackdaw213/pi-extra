// REST calls. Exact paths and body fields per docs/SPEC.md §4.
// Auth is the pr_auth cookie; nothing is stored client-side.

let onUnauthorized = null;
let onActivity = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = typeof fn === "function" ? fn : null;
}
// Fired on every API call — the idle sign-out controller treats API use as
// user activity.
export function setActivityListener(fn) {
  onActivity = typeof fn === "function" ? fn : null;
}

async function req(method, path, body) {
  onActivity?.();
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Network error");
  }
  if (res.status === 401) {
    if (onUnauthorized) onUnauthorized();
    throw new Error("Not signed in");
  }
  return res;
}

// POST /api/login {password} -> 204 + cookie; 401 -> wrong password.
export async function login(password) {
  let res;
  try {
    res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
  } catch {
    throw new Error("Network error");
  }
  if (res.status === 401) throw new Error("Wrong password");
  if (!res.ok) throw new Error(`Login failed (${res.status})`);
  return true;
}

// GET /api/registry -> { machines: [{ machine, sessions: [sessionSummary] }] }
export async function getRegistry() {
  const res = await req("GET", "/api/registry");
  if (!res.ok) throw new Error(`Registry failed (${res.status})`);
  const data = await res.json();
  return { machines: Array.isArray(data?.machines) ? data.machines : [] };
}

// POST /api/message { sessionId, machineId, text, deliverAs?, attachments? } -> 202.
// attachments: [{ name, mime?, b64 }] — the hub enforces the 50 MB total cap.
export async function sendMessage(sessionId, machineId, text, deliverAs, attachments) {
  const body = { sessionId, machineId, text };
  if (deliverAs) body.deliverAs = deliverAs;
  if (attachments && attachments.length) body.attachments = attachments;
  const res = await req("POST", "/api/message", body);
  if (!res.ok) throw new Error(`Send failed (${res.status})`);
}

// POST /api/ping — user-activity heartbeat: touches the sliding session so
// the 15-minute idle sweep does not sign the user out while they are using it.
export async function ping() {
  try {
    await req("POST", "/api/ping");
  } catch {}
}

// POST /api/logout — drops the server-side session and the cookie.
export async function logout() {
  let res;
  try {
    res = await fetch("/api/logout", { method: "POST" });
  } catch {
    return; // network gone: the cookie dies with the next 401 anyway
  }
  if (res.status === 401 && onUnauthorized) onUnauthorized();
}

// POST /api/spawn { machineId, name?, kind? } -> 202 { ref }; outcome via WS spawn_result.
// kind per ADR 0006: "temp" (default) or "normal". The hub validates again.
export async function spawnSession(machineId, name, kind) {
  const body = { machineId };
  if (name) body.name = name;
  if (kind) body.kind = kind;
  const res = await req("POST", "/api/spawn", body);
  if (!res.ok) throw new Error(`Spawn failed (${res.status})`);
  try {
    return (await res.json())?.ref ?? null;
  } catch {
    return null;
  }
}

// POST /api/delete { machineId, sessionId, erase? } -> 202. erase:true is only
// accepted for temp sessions (ADR 0006); the hub answers 409 otherwise.
export async function deleteSession(machineId, sessionId, erase) {
  const body = { machineId, sessionId };
  if (erase) body.erase = true;
  const res = await req("POST", "/api/delete", body);
  if (!res.ok) {
    let msg = null;
    try {
      msg = (await res.json())?.error ?? null;
    } catch {}
    throw new Error(msg || `Delete failed (${res.status})`);
  }
}

// POST /api/history { machineId, sessionId } -> 202 once routed; the reply
// arrives as WS "history" chunk frames. 404 when the hub has no such session.
export async function historyRequest(machineId, sessionId) {
  const res = await req("POST", "/api/history", { machineId, sessionId });
  if (res.status === 404) throw new Error("Session not found");
  if (!res.ok) throw new Error(`History request failed (${res.status})`);
}

// ---- passkey (Face ID) login — see app/passkeys.mjs for the flows --------

// GET /api/passkey/enabled -> { enabled, registered }. Public: the login
// view needs the flag before any auth.
export async function passkeyStatus() {
  const res = await fetch("/api/passkey/enabled");
  if (!res.ok) throw new Error(`Passkey status failed (${res.status})`);
  return res.json();
}

// POST /api/passkey/login/options -> { options, token }. Public.
export async function passkeyLoginOptions() {
  let res;
  try {
    res = await fetch("/api/passkey/login/options", { method: "POST" });
  } catch {
    throw new Error("Network error");
  }
  if (!res.ok) {
    let msg = null;
    try {
      msg = (await res.json())?.error ?? null;
    } catch {}
    throw new Error(msg || `Passkey options failed (${res.status})`);
  }
  return res.json();
}

// POST /api/passkey/login { response, token } -> 204 + pr_auth cookie.
export async function passkeyLogin(assertion, token) {
  let res;
  try {
    res = await fetch("/api/passkey/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response: assertion, token }),
    });
  } catch {
    throw new Error("Network error");
  }
  if (!res.ok) {
    let msg = null;
    try {
      msg = (await res.json())?.error ?? null;
    } catch {}
    throw new Error(msg || `Passkey login failed (${res.status})`);
  }
  return true;
}

// POST /api/passkey/register/options (auth) -> { options, token }.
export async function passkeyRegisterOptions() {
  const res = await req("POST", "/api/passkey/register/options");
  if (!res.ok) {
    let msg = null;
    try {
      msg = (await res.json())?.error ?? null;
    } catch {}
    throw new Error(msg || `Passkey options failed (${res.status})`);
  }
  return res.json();
}

// POST /api/passkey/register { response, token } (auth) -> 204.
export async function passkeyRegister(attestation, token) {
  const res = await req("POST", "/api/passkey/register", { response: attestation, token });
  if (!res.ok) {
    let msg = null;
    try {
      msg = (await res.json())?.error ?? null;
    } catch {}
    throw new Error(msg || `Passkey registration failed (${res.status})`);
  }
  return true;
}

// POST /api/passkey/delete { id? } (auth) -> 204. No id = remove all.
export async function passkeyDelete(id) {
  const body = id === undefined ? {} : { id };
  const res = await req("POST", "/api/passkey/delete", body);
  if (!res.ok) {
    let msg = null;
    try {
      msg = (await res.json())?.error ?? null;
    } catch {}
    throw new Error(msg || `Passkey removal failed (${res.status})`);
  }
  return true;
}

// POST /api/answer { machineId, sessionId, callId, value?|custom? } -> 202.
// answer is { value } (tapped option label) or { custom } (typed text); the
// phone never sends cancelled — the extension settles questions itself.
export async function answer(machineId, sessionId, callId, answer) {
  const res = await req("POST", "/api/answer", { machineId, sessionId, callId, ...answer });
  if (!res.ok) {
    let msg = null;
    try {
      msg = (await res.json())?.error ?? null;
    } catch {}
    throw new Error(msg || `Answer failed (${res.status})`);
  }
}

// POST /api/abort { sessionId, machineId }
export async function abortSession(sessionId, machineId) {
  const res = await req("POST", "/api/abort", { sessionId, machineId });
  if (!res.ok) throw new Error(`Abort failed (${res.status})`);
}

// POST /api/stop { sessionId, machineId } — remote-mode sessions only.
export async function stopSession(sessionId, machineId) {
  const res = await req("POST", "/api/stop", { sessionId, machineId });
  if (!res.ok) throw new Error(`Stop failed (${res.status})`);
}

// POST /api/file — multipart with field names machineId, sessionId, file. Cap 50 MB.
export async function uploadFile(sessionId, machineId, file) {
  const fd = new FormData();
  fd.append("machineId", machineId);
  fd.append("sessionId", sessionId);
  fd.append("file", file);
  let res;
  try {
    res = await fetch("/api/file", { method: "POST", body: fd });
  } catch {
    throw new Error("Network error");
  }
  if (res.status === 401) {
    if (onUnauthorized) onUnauthorized();
    throw new Error("Not signed in");
  }
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
}

// GET /api/file?machineId&sessionId&name — streams back as attachment.
export function fileDownloadUrl(machineId, sessionId, name) {
  return (
    `/api/file?machineId=${encodeURIComponent(machineId)}` +
    `&sessionId=${encodeURIComponent(sessionId)}` +
    `&name=${encodeURIComponent(name)}`
  );
}
