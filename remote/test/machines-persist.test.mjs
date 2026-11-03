// Seam: hub machine-record persistence — after a hub restart, cold spawn
// (SPEC §6 path 2) must work before any pi session reconnects. Boots a REAL
// hub twice against a throwaway env (conventions.md): first with a live fake
// agent hello (records learned + written to machines.json), then restarted
// with no agents at all — the machine must still answer /api/registry, with
// its addresses and spawn token restored.
//
// Throwaway env only: random port, throwaway password, throwaway state files
// in /tmp. The deployed hub on the home lab is never touched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "../hub/node_modules/ws/index.js";

const here = join(fileURLToPath(import.meta.url), "..");
const hubRoot = join(here, "..", "hub");
const PASSWORD = "test-pw";
const MACHINE_ID = "machine-persist";
const TOKEN = "persist-token";

let workdir = null;
let tokensFile = null;
let machinesFile = null;
let hub = null;
let port = null;
let cookie = null;

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

function startHub(port_) {
  const child = spawn(process.execPath, [join(hubRoot, "server.mjs")], {
    cwd: hubRoot,
    env: {
      ...process.env,
      PI_REMOTE_PORT: String(port_),
      PI_REMOTE_PASSWORD: PASSWORD,
      PI_REMOTE_TOKENS_FILE: tokensFile,
      PI_REMOTE_MACHINES_FILE: machinesFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[hub] ${d}`));
  return child;
}

async function login(port_) {
  const res = await fetch(`http://127.0.0.1:${port_}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 204);
  const set = res.headers.get("set-cookie") || "";
  const c = /pr_auth=[^;]+/.exec(set)?.[0] ?? null;
  assert.ok(c, "login must set pr_auth cookie");
  return c;
}

async function registry(port_, useCookie = true) {
  const headers = useCookie && cookie ? { Cookie: cookie } : {};
  const res = await fetch(`http://127.0.0.1:${port_}/api/registry`, { headers });
  assert.equal(res.status, 200);
  return res.json();
}

before(async () => {
  workdir = await mkdtemp(join(tmpdir(), "pi-remote-machines-test-"));
  tokensFile = join(workdir, "tokens");
  machinesFile = join(workdir, "machines.json");
  await writeFile(tokensFile, `${TOKEN}\n`);
  cookie = null;
});

after(async () => {
  if (hub) hub.kill("SIGKILL");
  await rm(workdir, { recursive: true, force: true });
});

test("machine records survive a hub restart and enable cold spawn data", async () => {
  // --- run 1: a machine says hello; the hub persists its record ----------
  port = await freePort();
  hub = startHub(port);
  await wait(port);
  cookie = await login(port);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`);
  const welcomed = new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.on("message", (data) => {
      if (JSON.parse(String(data)).type === "welcome") resolve();
    });
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      machine: {
        id: MACHINE_ID,
        hostname: "persist-host",
        os: "linux",
        release: "",
        addresses: ["192.0.2.7"],
      },
      session: {
        id: "sess-persist",
        name: "sess-persist",
        cwd: "/tmp",
        model: null,
        thinkingLevel: null,
        state: "idle",
        pid: 4242,
        mode: "remote",
        kind: "temp",
        startedAt: new Date().toISOString(),
      },
      token: TOKEN,
    })
  );
  await welcomed;
  // hello -> registry broadcast -> persist is synchronous after register;
  // give the write a beat.
  await new Promise((r) => setTimeout(r, 250));
  ws.close();

  const persisted = JSON.parse(await readFile(machinesFile, "utf8"));
  const rec = persisted.find((m) => m.machine?.id === MACHINE_ID);
  assert.ok(rec, "machines.json must contain the helloing machine");
  assert.equal(rec.spawnToken, TOKEN);
  assert.deepEqual(rec.machine.addresses, ["192.0.2.7"]);

  const live = await registry(port);
  assert.equal(live.machines.length, 1, "live registry lists the machine");
  hub.kill("SIGKILL");
  hub = null;

  // --- run 2: restarted hub, NO agent ever connects -----------------------
  port = await freePort();
  hub = startHub(port);
  await wait(port);
  cookie = await login(port);

  const restored = await registry(port);
  assert.equal(restored.machines.length, 1, "restarted hub restores the machine record");
  const m = restored.machines[0];
  assert.equal(m.machine.id, MACHINE_ID);
  assert.equal(m.machine.hostname, "persist-host");
  assert.deepEqual(m.machine.addresses, ["192.0.2.7"], "addresses must survive for the stub knock");
  assert.equal(m.sessions.length, 0, "sessions are never restored — only machine records");
});
