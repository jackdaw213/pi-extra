# pi-remote — Implementation Spec

Target: pi (`@earendil-works/pi-coding-agent`) **1.4.0**. Decisions: ADR 0001–0005
(0004/0005 current). Glossary: `CONTEXT.md`. Research:
`docs/research/` (cited facts below by `[R]`).

## 1. Components

| Component | Runtime | Where it runs |
|---|---|---|
| `extension/` | TypeScript via jiti inside pi, zero npm deps | Every pi session on a machine |
| `hub/` | Node 22 + `ws` (only dep), Docker | Home lab, always-on |
| `stub/` | Node 22, zero deps, systemd socket-activated | Each machine, only while answering a spawn knock |
| `shared/` | Plain ESM `.mjs`, zero deps | Vendored into extension install + stub install |

Repo layout:

```
pi-remote/
├── extension/            index.ts, client.ts, bridge.ts, files.ts, spawn-bridge.ts, package.json
├── hub/                  server.mjs, agents.mjs, phoneapi.mjs, registry.mjs, package.json,
│                         Dockerfile, docker-compose.yml, web/ (PWA static)
├── stub/                 stub.mjs
├── shared/               protocol.mjs, spawn.mjs
├── deploy/               install.sh, units/pi-remote.socket, units/pi-remote.service
└── docs/                 CONTEXT.md, adr/, research/, SPEC.md
```

Ports: hub **8787** (TCP, one port). Cold-start stub **8788** per machine.

## 2. Identity & machine config

- Machine identity: `{ id, hostname, os, release }`. `id` = contents of
  `/etc/machine-id` (fallback: random UUID stored in config). `os` =
  `process.platform`, `release` = `os.release()`.
- Machine config file `~/.pi/remote/config.json`:
  ```json
  { "hubUrl": "ws://192.168.10.60:8787/agent", "machineToken": "<64 hex>", "machineId": "<id>" }
  ```
  Written by `deploy/install.sh`. Mode 600.
- Hub config: env `PI_REMOTE_PASSWORD` (dashboard login),
  `PI_REMOTE_TOKENS_FILE` (newline-separated machine tokens, mounted at
  `/data/tokens`), `PI_REMOTE_PORT` (default 8787).

## 3. Agent ⇄ Hub protocol (WebSocket, JSON text frames, one object per frame)

Every frame: `{ v: 1, type: "...", ... }`. Unknown types ignored.

### Agent → Hub

| type | payload | notes |
|---|---|---|
| `hello` | `{ machine, session: { id, name, cwd, model, thinkingLevel, state, pid, mode, startedAt, kind? } , token }` | First frame. `token` = machineToken. `mode` = `"terminal"` or `"remote"`. `session.id` = `ctx.sessionManager.getSessionId()`. `kind` = session kind per ADR 0006: `"temp"` (default for remote) or `"normal"` (terminal sessions always). |
| `state` | `{ sessionId, state: "idle" \| "working" \| "blocked", detail? }` | Derivation in §7. |
| `event` | `{ sessionId, seq, ev }` | `ev` = forwarded pi event, whitelist in §7. `seq` = per-session counter. |
| `message_result` | `{ sessionId, ref, ok, error? }` | Ack for hub→agent `message`. |
| `file` | `{ sessionId, op: "put", name, b64, mime?, announcedBy? }` | Session → phone file (§8). Cap 50 MB pre-encode. |
| `spawn_result` | `{ ref, ok, pid?, error? }` | Ack for hub→agent `spawn`. |
| `history` | `{ sessionId, chunkIndex, chunkTotal, events: [...] }` | Replay of the session transcript (phone-ui spec). Chunks in order; `chunkTotal 0` = no history. Relayed to phones verbatim. |
| `question` | `{ sessionId, callId, toolName, question, options: [string], multiSelect }` | Ask-user tool intercepted by the extension; the phone renders and answers it. Relayed to phones verbatim. Re-emitted after a history replay while still pending. |
| `pong` | `{}` | Heartbeat reply. |

### Hub → Agent

| type | payload | notes |
|---|---|---|
| `welcome` | `{}` | After `hello` with valid token. |
| `reject` | `{ reason }` | Bad token; then close. |
| `message` | `{ sessionId, ref, text, deliverAs: "steer" \| "followUp" \| null, attachments?: [{ name, b64, mime? }] }` | Semantics in §8. |
| `spawn` | `{ ref, name?, kind? }` | Spawn on this machine (§6). `kind`: `"temp"` (default) or `"normal"` (ADR 0006). |
| `abort` | `{ sessionId }` | → `ctx.abort()`. |
| `stop` | `{ sessionId }` | Only for `mode:"remote"` sessions → `ctx.shutdown()`. |
| `delete` | `{ sessionId, erase: bool }` | Stop the session in any mode and, when `erase` is true and the session kind is `"temp"` (checked by hub and agent), remove its transcript + inbox after exit (ADR 0006). |
| `history_request` | `{ sessionId }` | Phone asked for the past transcript → agent streams `history` chunks. Never auto-sent. |
| `question_answer` | `{ sessionId, callId, value? \| custom? \| cancelled? }` | The phone answered a pending `question`; exactly one field. |
| `ping` | `{}` | Every 25 s; agent answers `pong`; hub drops silent agents after 60 s. |

### Registry behavior (hub)

- On `hello` valid: register session (key `machineId/sessionId`), replace
  stale entry with same session id. On disconnect: mark dead, drop after
  re-`hello` timeout. On `state`/`event`: update.
- Sessions surviving SIGKILL `[R-risk 5]`: dead on socket close — no grace.

## 4. Hub ⇄ Phone API

Cookie `pr_auth` (HttpOnly, SameSite=Lax) after login. All endpoints under
the hub origin. Static PWA at `/`.

| Method/Path | Body/Query | Response |
|---|---|---|
| `POST /api/login` | `{ password }` | 204 + cookie; 401 otherwise. Constant-time compare. |
| `GET /api/registry` | — | `{ machines: [{ machine, sessions: [sessionSummary] }] }` (sessionSummary = hello payload session + state + connectedSince) |
| `POST /api/message` | `{ sessionId, machineId, text, deliverAs? }` | 202; queued to agent; result arrives on WS as `message_result` echo with same `ref`. |
| `POST /api/spawn` | `{ machineId, name?, kind? }` | If a live session exists on machine: `spawn` via it. Else: knock stub `http://<machine-ip>:8788/spawn` (§6). `kind`: `"temp"` default, `"normal"` otherwise (400 on other values; ADR 0006). 202 `{ ref }`; outcome via WS `spawn_result` echo. |
| `POST /api/abort` | `{ sessionId, machineId }` | → agent `abort`. |
| `POST /api/stop` | `{ sessionId, machineId }` | → agent `stop` (remote sessions only; 400 for terminal sessions). |
| `POST /api/history` | `{ sessionId, machineId }` | → agent `history_request`; chunks arrive on WS as `history` frames. |
| `POST /api/answer` | `{ sessionId, machineId, callId, value?\|custom?\|cancelled? }` | → agent `question_answer`; exactly one answer field. |
| `POST /api/delete` | `{ sessionId, machineId, erase? }` | → agent `delete`. `erase:true` refused with 409 unless the registry shows kind `"temp"` (ADR 0006). |
| `POST /api/file` | multipart: `machineId, sessionId, file` | → agent as message attachment (§8). Cap 50 MB. |
| `GET /api/file` | `?machineId&sessionId&name` | Streams the file back (hub asks agent via internal `file get`), `Content-Disposition: attachment`. |
| `WS /ws` | — (cookie auth) | Push channel: `registry`, `event`, `file`, `spawn_result`, `message_result` frames (schemas in §3, plus `registry` = full registry snapshot on change). |

Phone WS frames (hub → phone): `{ v:1, type:"registry"|"event"|"file"|"spawn_result"|"message_result"|"history"|"question", ... }`.
`event`/`history`/`question` frames fan out to ALL connected phones; client filters by sessionId.

## 5. Auth

- Agent → hub: `hello.token` must be in tokens file. Reject otherwise.
- Phone → hub: password → cookie. All `/api/*` + `/ws` require it.
- Stub → hub direction only (hub knocks stub): stub requires
  `?token=<machineToken>` matching its config. Same token file concept.
- No TLS in v1 (private LAN/ZeroTier; ADR 0005). Reverse-proxy TLS later
  without protocol change.

## 6. Spawn (sandbox parity — ADR 0002)

Exact wrapper (built by `shared/spawn.mjs`), a sibling transient unit:

```
systemd-run --user --collect --quiet
  --description="pi agent sandbox (remote)"
  --property=WorkingDirectory=<HOME>/.pi
  --property=ProtectSystem=strict
  --property=ProtectHome=read-only
  --property=ReadWritePaths=<HOME>/.pi
  --property=ReadWritePaths=<HOME>/.cache
  --property=ReadWritePaths=<HOME>/.npm
  --property=ReadWritePaths=/tmp
  --property=NoNewPrivileges=yes
  --property=ProtectKernelTunables=yes
  --property=ProtectKernelModules=yes
  --property=ProtectControlGroups=yes
  --property=ProtectClock=yes
  --property=ProtectHostname=yes
  --property=RestrictSUIDSGID=yes
  --property=RestrictNamespaces=yes
  --property=LockPersonality=yes
  -- sh -c 'sleep infinity | exec <piBin> --mode rpc --name <name>'
```

- No `--pty` (headless). No invoke-dir ReadWritePaths: phone sessions' home
  base folder IS `~/.pi` (fish launcher maps HOME→~/.pi the same way).
- `sleep infinity |` holds pi's stdin open forever: the unit is independent
  of the spawner and survives it; stdout/stderr go to the user journal.
- `<piBin>`: `~/.cache/pibolt-compiled/pi` if it exists and is newer than
  `/usr/lib/pi-bolt/pi`, else `/usr/lib/pi-bolt/pi` (replicates the fish
  `__pi_bolt_bin` freshness rule).
- Extension checks systemd availability: `systemctl --user` exit code at
  spawn time; if unavailable → `spawn_result` error / registry shows
  `spawnAvailable: false` for that machine.
- Path 1 (live session exists): hub → extension `spawn`; extension runs the
  wrapper (spawning from inside the sandbox works — probed 2026-10-30).
- Path 2 (zero sessions): hub → `http://<machine-ip>:8788/spawn?token=...&name=...`;
  `stub/stub.mjs` (woken by the socket unit) runs the same wrapper, replies
  200 `{"ok":true}`, idles out. Machine IP = registry-reported LAN/ZeroTier
  address (`hello.machine.addresses` = non-internal IPv4s).
- The new session's own extension dials the hub and appears on the dashboard
  (uniform model — child sessions serve themselves; the spawner only fires
  the unit). pi in RPC mode needs no TTY and loads extensions `[R-Q5]`.

## 7. Extension behavior (per session)

- Factory: register only. No sockets/timers `[R-Q8]`.
- `session_start`: read config (`~/.pi/remote/config.json`); if absent →
  inert (report nothing, log one line). Else start client: connect `hubUrl`,
  auto-retry with jittered backoff (0.5 s → 30 s cap). Build `hello` from
  `ctx.sessionManager` getters (`getSessionId/getSessionFile/getCwd/
  getSessionName`) + `ctx.model` + `ctx.mode` (`mode:"terminal"` if ctx.mode
  === "tui" else `"remote"`) `[R-Q6]`.
- Event forwarding: `pi.on()` for `input, agent_start, agent_end,
  agent_settled, turn_start, turn_end, message_start, message_update,
  message_end, tool_execution_start, tool_execution_update,
  tool_execution_end, queue_update, compaction_start, compaction_end,
  session_info_changed` → `event` frames. Handlers stay synchronous (no
  awaits) — dispatch is per-delta `[R-Q2]`.
- State machine: `working` from `agent_start` until `agent_settled`;
  `blocked` while a `ui_prompt_start` is open (`ui_prompt_end` clears);
  else `idle` `[R-Q2, herdr taxonomy]`. Send `state` on change.
- `session_shutdown`: if `reason === "quit"` → send nothing (socket dies with
  process), close client; else (`new|resume|fork|reload`) → close client,
  the next `session_start` re-registers with the new session `[R-Q6, herdr
  pattern]`.
- Hub `message` handler: write attachments to
  `~/.pi/remote/inbox/<sessionId>/<ts>-<name>`; text = original text + for
  each attachment a line `- attached file (saved): <abs path>`; images
  additionally inline as `ImageContent {type:"image", data:<b64>,
  mimeType}` `[R-Q7]`. Then: `ctx.isIdle()` → `pi.sendUserMessage(text)`
  ; busy → `pi.sendUserMessage(text, { deliverAs: deliverAs ?? "steer" })`
  `[R-Q1]`. Reply `message_result`.
- Hub `abort` → `ctx.abort()`. Hub `stop` (mode remote only) →
  `ctx.shutdown()`. Hub `delete` (any mode; ADR 0006) → optional erase of the
  transcript + inbox for temp sessions after exit, then `ctx.shutdown()`.
  Hub `history_request` → stream the session file as `history` chunks
  (shared/history.mjs), then re-emit any still-pending `question`. Hub
  `question_answer` → resolves the intercepted ask-user tool call. Ask-user
  tool calls (`*_ask_user_question`) are intercepted via `pi.on("tool_call")`
  and answered from the phone; the built-in UI never shows. Hub `spawn` → §6
  wrapper via `node:child_process.execFile` (`systemd-run` from inside the
  sandbox works — probed).
- Tool `send_file_to_phone(path)`: registered `direct`, `readOnlyHint`,
  TypeBox schema `{ path: string (description: absolute path) }`. Reads the
  file (≤50 MB), sends `file` frame, returns text result "sent to your
  phone: <name>" (or error text if too big/missing). The model calls it when
  the user asks to send a file to the phone.
- RPC-mode children: everything above works in RPC mode; `ctx.hasUI` is true
  but no phone dialog client exists — extension never uses `ctx.ui` except
  state widgets guarded by `ctx.mode === "tui"` `[R-Q8, risk 6]`.

## 8. File exchange

- Phone → session: hub receives upload, sends hub→agent `message` with
  `attachments`; extension saves to inbox, injects paths in the prompt text
  (agent uses `read` on them) and inlines images `[R-Q7]`.
- Session → phone: model calls `send_file_to_phone`; phone WS gets `file`
  frame; PWA shows a download card. Optional fetch-any-file: `GET
  /api/file?path=...` restricted to paths under `$HOME` (hub asks agent
  `file get` — same `file` put mechanism with `announcedBy:"fetch"`).

## 9. PWA (hub/web/)

Vanilla ES modules, no build step. Pages: login, dashboard, attach view.
- Dashboard: machines grouped, session cards (name, cwd, model, state badge
  idle/working/blocked, mode terminal/remote), "New session" per machine,
  session count. Live updates via WS `registry`.
- Attach view: transcript rendered from `event` frames (user text via
  `input`/`message_start`, assistant via `message_end` + live `text_delta`,
  tool calls via tool_execution_*), message box with deliverAs toggle
  (steer default when busy), attach button (≤50 MB), download cards, abort
  button, stop button (remote only).
- `manifest.webmanifest` + 192/512 px icons → Add to Home Screen.
- Session selection persists in URL hash (`#/m/<machineId>/s/<sessionId>`).

## 10. Hub runtime

- `hub/server.mjs`: node:http (static + REST), `ws` WebSocketServer (agents
  on `/agent`, phones on `/ws`), registry in memory. JSON frames, LF not
  needed (WS framing). Heartbeats per §3.
- Dockerfile: `FROM node:22-alpine`, non-root `node`, `--omit=dev` install,
  `USER node`, `read-only: true` rootfs, `cap_drop: [ALL]`,
  `no-new-privileges: true`, volume `pi-remote-data:/data`,
  `restart: unless-stopped`, healthcheck `wget -qO- localhost:8787/api/health`.
- `GET /api/health` → `{ok:true}` (no auth).

## 11. Stub & units (per machine, optional — cold start)

- `deploy/units/pi-remote.socket`: `ListenStream=0.0.0.0:8788` (user unit).
- `deploy/units/pi-remote.service`: `ExecStart=/usr/bin/node <HOME>/.pi/remote/stub.mjs`,
  hardened like §6 (ProtectSystem=strict, ProtectHome=read-only,
  ReadWritePaths=<HOME>/.pi /tmp, NoNewPrivileges), `Accept=no`, restarted
  per connection by systemd socket activation (probe-verified pattern).
- `stub.mjs`: HTTP server; `GET /spawn?token=&name=` validates token against
  machineToken, runs §6 wrapper, 200 JSON. Anything else 404. Exits after
  each request (socket unit re-wakes it).

## 12. deploy/install.sh (runs on a machine, outside agent sandbox where needed)

1. Detect hub URL + generate machineToken; write `~/.pi/remote/config.json`.
2. Copy `extension/` + vendored `shared/` → `~/.pi/agent/extensions/pi-remote/`
   (manifest dir with `package.json` `{"pi":{"extensions":["./index.ts"]}}`
   `[R-Q4]`).
3. Copy `stub/` + `shared/` → `~/.pi/remote/`.
4. Print the machineToken for the hub's tokens file; optional `--units` flag
   copies unit files + `systemctl --user daemon-reload && enable --now
   pi-remote.socket` (manual step; `~/.config` is read-only from agent
   sandboxes).
5. Print status and next steps. Idempotent.

## 13. Verification checklist (end-to-end)

1. Extension installed → `pi` in a terminal → hub logs show `hello`.
2. Phone (ZeroTier) → bookmark → login → dashboard shows machine + session,
   state flips idle→working when terminal agent runs.
3. Attach: live output streams; send message from phone while busy → steers;
   while idle → new turn; abort works.
4. Spawn path 1 (live session) → new session appears, sandboxed (verify
   `systemctl --user status` unit properties + write-probe outside
   ReadWritePaths fails).
5. Spawn path 2: stop all sessions → spawn from phone → stub wakes it.
6. File exchange both ways, image inline visible to model.
7. Stop remote session from phone → unit exits.
8. Kill a session hard (SIGKILL) → hub registry drops it.

## 14. Out of scope (v1)

TLS termination (lab reverse proxy later), multi-hub, message-editing,
history backfill beyond live events (`get_entries` later), notifications,
sessions on machines without the extension.
