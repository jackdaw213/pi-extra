// Seam: hub WebSocket boundary — delete semantics per session kind (ADR 0006)
// and kind relay on spawn, against a REAL hub booted as a child process.
//
// Throwaway env only (conventions.md): random port, throwaway password,
// throwaway tokens file in /tmp. The deployed hub on the home lab is never
// touched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "../hub/node_modules/ws/index.js";

const here = join(fileURLToPath(import.meta.url), "..");
const hubRoot = join(here, "..", "hub");
const PASSWORD = "test-pw";
const MACHINE_ID = "machine-test";

let hub = null;
let port = 0;
let cookie = null;
let workdir = null;
let tokensFile = null;

const agentFrames = { temp: [], normal: [], noKind: [] };
const agents = {}; // key -> ws

function wait(port_, tries = 100) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const s = new WebSocket(`ws://127.0.0.1:${port_}/agent`);
      const ok = () => {
        try { s.close(); } catch {}
        resolve();
      };
      s.once("open", ok);
      s.once("error", () => {
        try { s.close(); } catch {}
        if (n <= 0) return reject(new Error("hub did not come up"));
        setTimeout(() => attempt(n - 1), 100);
      });
    };
    attempt(tries);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

function helloFrame(kind, sessionId, pid) {
  const session = {
    id: sessionId,
    name: sessionId,
    cwd: "/tmp",
    model: null,
    thinkingLevel: null,
    state: "idle",
    pid,
    mode: "remote",
    startedAt: new Date().toISOString(),
  };
  if (kind !== undefined) session.kind = kind;
  return { v: 1, type: "hello", machine: { id: MACHINE_ID, hostname: "test-host", os: "linux", release: "", addresses: [] }, session, token: "test-token" };
}

function connectAgent(key, kind, sessionId, pid) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`);
    agents[key] = ws;
    ws.on("message", (data) => {
      const f = JSON.parse(String(data));
      if (f.type === "welcome") resolve(ws);
      if (f.type !== "ping" && f.type !== "welcome") agentFrames[key].push(f);
    });
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify(helloFrame(kind, sessionId, pid))));
  });
}

async function api(method, path, body, useCookie = true) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (useCookie && cookie) headers["Cookie"] = cookie;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

async function waitForFrame(key, pred, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const f = agentFrames[key].find(pred);
    if (f) return f;
    if (Date.now() > deadline) throw new Error(`no matching frame for agent ${key}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

before(async () => {
  workdir = await mkdtemp(join(tmpdir(), "pi-remote-hub-test-"));
  tokensFile = join(workdir, "tokens");
  await writeFile(tokensFile, "test-token\n");
  port = await freePort();
  hub = spawn(process.execPath, [join(hubRoot, "server.mjs")], {
    cwd: hubRoot,
    env: {
      ...process.env,
      PI_REMOTE_PORT: String(port),
      PI_REMOTE_PASSWORD: PASSWORD,
      PI_REMOTE_TOKENS_FILE: tokensFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  hub.stderr.on("data", (d) => process.stderr.write(`[hub] ${d}`));
  await wait(port);

  // Phone login -> pr_auth cookie.
  const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 204);
  const set = res.headers.get("set-cookie") || "";
  cookie = /pr_auth=[^;]+/.exec(set)?.[0] ?? null;
  assert.ok(cookie, "login must set pr_auth cookie");

  await connectAgent("temp", "temp", "sess-temp", 111);
  await connectAgent("normal", "normal", "sess-normal", 222);
  await connectAgent("noKind", undefined, "sess-nokind", 333);
});

after(async () => {
  for (const ws of Object.values(agents)) {
    try { ws.close(); } catch {}
  }
  if (hub) {
    hub.kill("SIGTERM");
    await new Promise((r) => {
      hub.once("exit", r);
      setTimeout(() => {
        try { hub.kill("SIGKILL"); } catch {}
        r();
      }, 3000);
    });
  }
  await rm(workdir, { recursive: true, force: true });
});

test("registry summaries pass the session kind through", async () => {
  const res = await api("GET", "/api/registry");
  assert.equal(res.status, 200);
  const reg = await res.json();
  const machine = reg.machines.find((m) => m.machine.id === MACHINE_ID);
  assert.ok(machine, "machine present");
  const kinds = Object.fromEntries(machine.sessions.map((s) => [s.id, s.kind]));
  assert.equal(kinds["sess-temp"], "temp");
  assert.equal(kinds["sess-normal"], "normal");
});

test("POST /api/delete with erase:true reaches a temp agent as delete erase:true", async () => {
  const res = await api("POST", "/api/delete", { machineId: MACHINE_ID, sessionId: "sess-temp", erase: true });
  assert.equal(res.status, 202);
  const f = await waitForFrame("temp", (f) => f.type === "delete" && f.sessionId === "sess-temp");
  assert.equal(f.erase, true);
});

test("POST /api/delete with erase:true is refused for a normal session", async () => {
  const res = await api("POST", "/api/delete", { machineId: MACHINE_ID, sessionId: "sess-normal", erase: true });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /temp/i);
  // The normal agent must not receive a delete frame at all.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(agentFrames.normal.find((f) => f.type === "delete"), undefined);
});

test("POST /api/delete without erase stops a normal session (erase:false relayed)", async () => {
  const res = await api("POST", "/api/delete", { machineId: MACHINE_ID, sessionId: "sess-normal" });
  assert.equal(res.status, 202);
  const f = await waitForFrame("normal", (f) => f.type === "delete" && f.sessionId === "sess-normal");
  assert.equal(f.erase, false);
});

test("erase:true is refused for sessions whose hello carried no kind", async () => {
  const res = await api("POST", "/api/delete", { machineId: MACHINE_ID, sessionId: "sess-nokind", erase: true });
  assert.equal(res.status, 409);
});

test("POST /api/delete for an unknown session is 404", async () => {
  const res = await api("POST", "/api/delete", { machineId: MACHINE_ID, sessionId: "sess-missing", erase: false });
  assert.equal(res.status, 404);
});

test("POST /api/delete without a login cookie is rejected", async () => {
  const res = await api("POST", "/api/delete", { machineId: MACHINE_ID, sessionId: "sess-temp", erase: true }, false);
  assert.equal(res.status, 401);
});

test("POST /api/spawn relays kind in the H_SPAWN frame", async () => {
  const res = await api("POST", "/api/spawn", { machineId: MACHINE_ID, kind: "normal" });
  assert.equal(res.status, 202);
  const f = await waitForFrame("temp", (f) => f.type === "spawn" && f.kind === "normal");
  assert.ok(f.ref);
});

test("POST /api/spawn defaults kind to temp", async () => {
  const res = await api("POST", "/api/spawn", { machineId: MACHINE_ID });
  assert.equal(res.status, 202);
  await waitForFrame("temp", (f) => f.type === "spawn" && f.kind === "temp");
});

test("POST /api/spawn rejects kinds outside the whitelist", async () => {
  const res = await api("POST", "/api/spawn", { machineId: MACHINE_ID, kind: "throwaway" });
  assert.equal(res.status, 400);
});

test("POST /api/spawn without a login cookie is rejected", async () => {
  const res = await api("POST", "/api/spawn", { machineId: MACHINE_ID }, false);
  assert.equal(res.status, 401);
});
