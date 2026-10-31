// Seam: hub WebSocket boundary — history request routing + verbatim relay.
// Boots the REAL hub entrypoint (hub/server.mjs, the file Docker runs) as a
// child process with throwaway env (server.mjs auto-starts, exports nothing,
// and installs process-level handlers, so a child process is the honest way
// to boot it). Fake agent + fake phone clients connect per docs/SPEC.md §3-§5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "../hub/node_modules/ws/index.js";

const here = join(fileURLToPath(import.meta.url), "..");
const HUB_URL_PREFIX = join(here, "..", "hub", "server.mjs");
const AGENT_TOKEN = "test-token";
const MACHINE_ID = "test-machine";
const SESSION_ID = "test-session";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitUntil(fn, label, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function httpJson(port, method, path, { body, cookie } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  }).then(async (res) => ({ status: res.status, setCookie: res.headers.get("set-cookie"), body: await res.json().catch(() => null) }));
}

// Collects WS frames into an array; resolves when one arrives.
function nextFrame(ws, inbox) {
  return waitUntil(() => inbox.length > 0, "a ws frame").then(() => inbox.shift());
}

function startHub(port, tokensFile) {
  const child = spawn(process.execPath, [HUB_URL_PREFIX], {
    env: {
      ...process.env,
      PI_REMOTE_PORT: String(port),
      PI_REMOTE_PASSWORD: "test-pw",
      PI_REMOTE_TOKENS_FILE: tokensFile,
    },
    stdio: ["ignore", "ignore", "pipe"], // hub logs to stderr on failure paths
  });
  child.stderr.on("data", () => {}); // keep the pipe drained
  return child;
}

test("POST /api/history routes history_request to the agent; A_HISTORY chunks relay to phones verbatim", async () => {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), "pi-remote-hubws-"));
  const tokensFile = join(dir, "tokens");
  await writeFile(tokensFile, AGENT_TOKEN + "\n");
  const hub = startHub(port, tokensFile);
  const sockets = [];
  try {
    await waitUntil(
      async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
          return r.ok;
        } catch {
          return false;
        }
      },
      "hub to come up",
    );
    assert.equal(hub.exitCode, null, "hub process died at boot");

    // --- fake agent: connect /agent, say hello with the machine token -------
    const agentInbox = [];
    const agent = new WebSocket(`ws://127.0.0.1:${port}/agent`);
    sockets.push(agent);
    agent.on("message", (data) => agentInbox.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => {
      agent.on("open", resolve);
      agent.on("error", reject);
    });
    agent.send(JSON.stringify({
      v: 1,
      type: "hello",
      machine: { id: MACHINE_ID, hostname: "test-host", os: "linux", release: "x", addresses: [] },
      session: {
        id: SESSION_ID, name: "Test session", cwd: "/tmp", model: null, thinkingLevel: null,
        state: "idle", pid: 4242, mode: "terminal", startedAt: new Date().toISOString(),
      },
      token: AGENT_TOKEN,
    }));
    const welcome = await nextFrame(agent, agentInbox);
    assert.equal(welcome.type, "welcome");

    // --- fake phone: login for the pr_auth cookie, then open /ws ------------
    const login = await httpJson(port, "POST", "/api/login", { body: { password: "test-pw" } });
    assert.equal(login.status, 204);
    const cookie = (login.setCookie || "").split(";")[0];
    assert.ok(cookie.startsWith("pr_auth="), "login must set the pr_auth cookie");

    const phoneInbox = [];
    const phone = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
    sockets.push(phone);
    phone.on("message", (data) => phoneInbox.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => {
      phone.on("open", resolve);
      phone.on("error", reject);
    });

    // --- the flow under test ------------------------------------------------
    const asked = await httpJson(port, "POST", "/api/history", {
      body: { machineId: MACHINE_ID, sessionId: SESSION_ID },
      cookie,
    });
    assert.equal(asked.status, 202);
    assert.deepEqual(asked.body, { ok: true });

    const request = await nextFrame(agent, agentInbox);
    assert.deepEqual(request, { v: 1, type: "history_request", sessionId: SESSION_ID });

    // The agent answers with two A_HISTORY chunks, in order (shared/protocol.mjs).
    const chunk0 = { v: 1, type: "history", sessionId: SESSION_ID, chunkIndex: 0, chunkTotal: 2, events: [{ type: "input", text: "hello from the past" }] };
    const chunk1 = { v: 1, type: "history", sessionId: SESSION_ID, chunkIndex: 1, chunkTotal: 2, events: [{ type: "message_start", message: { role: "assistant", content: [], timestamp: 1733234400000 } }] };
    agent.send(JSON.stringify(chunk0));
    agent.send(JSON.stringify(chunk1));

    await waitUntil(() => phoneInbox.filter((f) => f.type === "history").length >= 2, "two history frames on the phone");
    const historyFrames = phoneInbox.filter((f) => f.type === "history");
    assert.deepEqual(historyFrames, [chunk0, chunk1]); // verbatim, ordered
    // The phone push channel also carries the registry snapshot(s) around it.
    assert.ok(phoneInbox.some((f) => f.type === "registry"));
  } finally {
    for (const ws of sockets) {
      try { ws.close(); } catch {}
    }
    hub.kill("SIGTERM");
    await new Promise((resolve) => {
      if (hub.exitCode !== null) return resolve();
      hub.on("exit", resolve);
      setTimeout(() => {
        try { hub.kill("SIGKILL"); } catch {}
        resolve();
      }, 3000).unref();
    });
  }
});

test("POST /api/history requires login", async () => {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), "pi-remote-hubws-"));
  const tokensFile = join(dir, "tokens");
  await writeFile(tokensFile, AGENT_TOKEN + "\n");
  const hub = startHub(port, tokensFile);
  try {
    await waitUntil(
      async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
          return r.ok;
        } catch {
          return false;
        }
      },
      "hub to come up",
    );
    const res = await httpJson(port, "POST", "/api/history", { body: { machineId: MACHINE_ID, sessionId: SESSION_ID } });
    assert.equal(res.status, 401);
  } finally {
    hub.kill("SIGTERM");
    await new Promise((resolve) => {
      if (hub.exitCode !== null) return resolve();
      hub.on("exit", resolve);
      setTimeout(resolve, 3000).unref();
    });
  }
});

test("POST /api/history validates the body and unknown sessions", async () => {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), "pi-remote-hubws-"));
  const tokensFile = join(dir, "tokens");
  await writeFile(tokensFile, AGENT_TOKEN + "\n");
  const hub = startHub(port, tokensFile);
  let cookie;
  try {
    await waitUntil(
      async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
          return r.ok;
        } catch {
          return false;
        }
      },
      "hub to come up",
    );
    const login = await httpJson(port, "POST", "/api/login", { body: { password: "test-pw" } });
    cookie = (login.setCookie || "").split(";")[0];

    const missing = await httpJson(port, "POST", "/api/history", { body: { sessionId: SESSION_ID }, cookie });
    assert.equal(missing.status, 400);
    assert.ok(/machineId/.test(missing.body.error));

    const unknown = await httpJson(port, "POST", "/api/history", {
      body: { machineId: MACHINE_ID, sessionId: "no-such-session" },
      cookie,
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, "Session not found.");
  } finally {
    hub.kill("SIGTERM");
    await new Promise((resolve) => {
      if (hub.exitCode !== null) return resolve();
      hub.on("exit", resolve);
      setTimeout(resolve, 3000).unref();
    });
  }
});
