#!/usr/bin/env node
// pi-remote cold-start stub (docs/SPEC.md §6 path 2, §11, ADR 0002).
//
// Woken by the pi-remote.socket systemd user unit when the hub knocks
// http://<machine>:8788/spawn while no pi session is alive. Answers the knock
// (spawning a sandboxed pi via shared/spawn.mjs) and exits; the socket unit
// stays up and re-wakes a fresh instance per connection. Node 22, zero deps.
//
// Env:
//   PI_REMOTE_STUB_PORT  port to bind when NOT socket-activated (default 8788)
//   PI_REMOTE_CONFIG     config file path (default ~/.pi/remote/config.json)

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --- load runSpawn: repo layout (../shared/) or installed layout (./shared/) --
let runSpawn = null;
for (const spec of ["../shared/spawn.mjs", "./shared/spawn.mjs"]) {
  try {
    const mod = await import(new URL(spec, import.meta.url).href);
    if (typeof mod.runSpawn === "function") {
      runSpawn = mod.runSpawn;
      break;
    }
  } catch {
    /* try the next candidate */
  }
}
if (!runSpawn) {
  console.error("[stub] fatal: shared/spawn.mjs not found next to stub.mjs");
  process.exit(1);
}

const CONFIG_PATH = process.env.PI_REMOTE_CONFIG || join(homedir(), ".pi", "remote", "config.json");
const PORT = (() => {
  const n = Number.parseInt(process.env.PI_REMOTE_STUB_PORT ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : 8788;
})();

// systemd socket activation (Accept=no): systemd binds 8788 and hands us the
// already-listening fd; binding the port ourselves would fail with EADDRINUSE.
const sdActivated =
  process.env.LISTEN_PID === String(process.pid) &&
  Number.parseInt(process.env.LISTEN_FDS ?? "0", 10) >= 1;

function readMachineToken() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (typeof cfg?.machineToken !== "string" || !cfg.machineToken) {
    throw new Error(`machineToken missing in ${CONFIG_PATH}`);
  }
  return cfg.machineToken;
}

// Constant-time compare (sha256 digests make input length irrelevant).
function tokenMatches(candidate, expected) {
  const a = createHash("sha256").update(String(candidate)).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

let inFlight = 0;
const RESP_SETTLED = Symbol("respSettled");

// After the last response: stop listening and let the process exit naturally.
// Socket activation starts a fresh instance per connection; the unit has no
// Restart= on purpose.
function settle(res) {
  if (res[RESP_SETTLED]) return;
  res[RESP_SETTLED] = true;
  inFlight -= 1;
  if (inFlight > 0) return;
  server.close();
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 250).unref();
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.once("finish", () => settle(res));
  res.once("close", () => settle(res));
  try {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    /* connection died mid-write; 'close' settles */
  }
}

function log(method, path, status, ms) {
  console.log(`[stub] ${method} ${path} ${status} ${ms}ms`);
}

async function handle(req, res) {
  const url = new URL(req.url ?? "/", "http://stub.invalid");
  const method = req.method ?? "GET";
  const path = url.pathname;
  const started = Date.now();

  if (method === "GET" && path === "/health") {
    send(res, 200, { ok: true });
    log(method, path, 200, Date.now() - started);
    return;
  }

  if (method === "GET" && path === "/spawn") {
    let expected;
    try {
      expected = readMachineToken();
    } catch (err) {
      send(res, 500, { ok: false, error: `config unavailable: ${err.message}` });
      log(method, path, 500, Date.now() - started);
      return;
    }
    if (!tokenMatches(url.searchParams.get("token") ?? "", expected)) {
      send(res, 401, { ok: false, error: "bad token" });
      log(method, path, 401, Date.now() - started);
      return;
    }
    const name = url.searchParams.get("name") || undefined;
    // Session kind per ADR 0006; shared/spawn.mjs validates + defaults to temp.
    const kind = url.searchParams.get("kind") || undefined;
    let result;
    try {
      result = await runSpawn({ name, kind });
    } catch (err) {
      result = { ok: false, error: String(err?.message ?? err) };
    }
    const status = result.ok ? 200 : 500;
    send(res, status, result.ok ? { ok: true } : { ok: false, error: result.error ?? "spawn failed" });
    log(method, path, status, Date.now() - started);
    return;
  }

  send(res, 404, { ok: false, error: "not found" });
  log(method, path, 404, Date.now() - started);
}

const server = createServer((req, res) => {
  inFlight += 1;
  handle(req, res).catch((err) => {
    console.error(`[stub] handler error: ${err?.stack ?? err}`);
    send(res, 500, { ok: false, error: String(err?.message ?? err) });
  });
});

server.on("error", (err) => {
  console.error(`[stub] fatal: ${err.message}`);
  process.exit(1);
});

server.listen(sdActivated ? { fd: 3 } : { port: PORT, host: "0.0.0.0" }, () => {
  const a = server.address();
  const where = sdActivated
    ? `systemd-activated fd 3 (${a && typeof a === "object" ? `${a.address}:${a.port}` : "ok"})`
    : `0.0.0.0:${PORT}`;
  console.log(`[stub] pid ${process.pid} listening on ${where}; config: ${CONFIG_PATH}`);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("unhandledRejection", (err) => {
  console.error(`[stub] unhandled rejection: ${err?.stack ?? err}`);
});
