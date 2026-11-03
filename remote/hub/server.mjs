// pi-remote hub — entry point (docs/SPEC.md §10).
//
// One HTTP port (default 8787) serves:
//   /            static PWA from ./web (optional; API works without it)
//   /api/*       REST for phones (see phoneapi.mjs)
//   /agent (WS)  pi session extensions (see agents.mjs)
//   /ws     (WS) logged-in phones, push channel
//
// Config (env): PI_REMOTE_PASSWORD (required), PI_REMOTE_TOKENS_FILE
// (default /data/tokens, newline-separated machine tokens, SIGHUP reloads),
// PI_REMOTE_PORT (default 8787).

import http from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry } from "./registry.mjs";
import { createAgentHub } from "./agents.mjs";
import { createPhoneApi } from "./phoneapi.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), "-", ...a);

// --- configuration ----------------------------------------------------------

const port = Number(process.env.PI_REMOTE_PORT || 8787);
const password = process.env.PI_REMOTE_PASSWORD;
if (!password) {
  console.error("PI_REMOTE_PASSWORD is not set. The hub needs it for dashboard login.");
  process.exit(1);
}
const tokensFile = process.env.PI_REMOTE_TOKENS_FILE || "/data/tokens";
// Machine records (identity, addresses, spawn token) survive hub restarts so
// cold spawn (SPEC §6 path 2) works before any pi session reconnects. Lives
// next to the tokens file by default — same volume, same trust domain.
const machinesFile = process.env.PI_REMOTE_MACHINES_FILE || path.join(path.dirname(tokensFile), "machines.json");

function loadTokens() {
  try {
    const tokens = new Set(
      readFileSync(tokensFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    );
    log(`Loaded ${tokens.size} machine token(s) from ${tokensFile}`);
    return tokens;
  } catch {
    log(`WARNING: cannot read tokens file ${tokensFile}. No agent can connect until it exists (SIGHUP reloads).`);
    return new Set();
  }
}
let tokens = loadTokens();
process.on("SIGHUP", () => {
  tokens = loadTokens();
});

// --- wiring -------------------------------------------------------------------

const registry = createRegistry();

// Boot-time restore of machine records (best effort: a corrupt/unwritable
// file must never keep the hub from starting — machines relearn on hello).
try {
  const restored = registry.restoreMachineRecords(JSON.parse(readFileSync(machinesFile, "utf8")));
  if (restored > 0) log(`Restored ${restored} machine record(s) from ${machinesFile}`);
} catch {}

// Called when a hello (re)registers a machine: persist the records so the
// NEXT hub restart can cold-spawn immediately. Atomic-ish write: temp file
// + rename, failures only logged.
function persistMachineRecords() {
  try {
    const dir = path.dirname(machinesFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = machinesFile + ".tmp";
    writeFileSync(tmp, JSON.stringify(registry.machineRecordsSnapshot(), null, 2), { mode: 0o644 });
    renameSync(tmp, machinesFile);
  } catch (e) {
    log(`WARNING: cannot persist machine records to ${machinesFile}: ${e?.message || e}`);
  }
}

let phoneApi = null;
const fanout = (frame) => {
  try {
    phoneApi?.broadcast(frame);
  } catch {}
};
const agents = createAgentHub({ registry, getTokens: () => tokens, fanout, onMachinesChanged: persistMachineRecords });
phoneApi = createPhoneApi({ registry, agents, password });

// --- static PWA (./web, built by the PWA build; optional at runtime) ----------

const webRoot = path.join(here, "web");
const webAvailable = existsSync(webRoot) && statSync(webRoot).isDirectory();
if (!webAvailable) log("WARNING: web UI folder is missing; only the API will be served.");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Method not allowed");
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (pathname.includes("\0")) {
    res.writeHead(400);
    return res.end();
  }
  const filePath = path.normalize(path.join(webRoot, pathname === "/" ? "index.html" : pathname));
  if (filePath !== webRoot && !filePath.startsWith(webRoot + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  let data = null;
  let mime = "application/octet-stream";
  try {
    data = readFileSync(filePath);
    mime = MIME[path.extname(filePath).toLowerCase()] || mime;
  } catch {
    // index.html fallback for extension-less routes (PWA deep links)
    if (!path.extname(filePath)) {
      try {
        data = readFileSync(path.join(webRoot, "index.html"));
        mime = MIME[".html"];
      } catch {}
    }
  }
  if (data === null) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(
      webAvailable ? "Not found" : "pi-remote hub is running, but the web UI folder is missing."
    );
  }
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": data.length,
    // no-store, not no-cache: iOS Firefox kept serving stale copies even when
    // asked to revalidate. Never let a cache keep these files at all — the
    // app is tiny and the hub is a LAN control plane, correctness > caching.
    "Cache-Control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : data);
}

// --- http server ----------------------------------------------------------------

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (url.pathname.startsWith("/api/")) {
    phoneApi.handleApi(req, res, url).catch((e) => {
      log("API error:", (e && e.stack) || e);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Server error." }));
      }
    });
    return;
  }
  serveStatic(req, res, url);
});

server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname === "/agent") {
    return agents.wss.handleUpgrade(req, socket, head, (ws) => agents.wss.emit("connection", ws, req));
  }
  if (url.pathname === "/ws") return phoneApi.handleUpgrade(req, socket, head);
  socket.destroy();
});

server.listen(port, "0.0.0.0", () => {
  log(`pi-remote hub listening on port ${port}`);
  log(`Agents: ws://<host>:${port}/agent | Phones: /ws (cookie auth) | Web UI: ${webAvailable ? "./web" : "missing"}`);
});

// Keep the always-on hub alive through stray async errors; log loudly.
process.on("uncaughtException", (e) => log("uncaughtException:", (e && e.stack) || e));
process.on("unhandledRejection", (e) => log("unhandledRejection:", (e && e.stack) || e));

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  log(`${signal} received, shutting down.`);
  server.close(() => process.exit(0));
  for (const ws of agents.wss.clients) {
    try {
      ws.close(1001, "hub shutting down");
    } catch {}
  }
  for (const ws of phoneApi.wss.clients) {
    try {
      ws.close(1001, "hub shutting down");
    } catch {}
  }
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
