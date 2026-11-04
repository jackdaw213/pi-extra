# pi-remote — deployment guide

Two targets: the **hub** (always-on container in the home lab) and one or more
**machines** running pi sessions. Requires Linux with a systemd user session,
node 22 at `/usr/bin/node`, and bash.

## 1. Deploy the hub

```bash
cd hub/
docker compose up -d
```

The hub listens on **8787**. Dashboard login comes from `PI_REMOTE_PASSWORD`
(read from the environment or a `.env` file next to the compose file — keep
that file out of any repository); `PI_REMOTE_TOKENS_FILE` defaults to
`/data/tokens` in the `pi-remote-data` volume.

### Passkey (Face ID) login — optional, HTTPS only

WebAuthn credentials are bound to the serving domain, and browsers refuse the
ceremony on plain HTTP. Once the dashboard is reachable over HTTPS (e.g. via
Nginx Proxy Manager with a Let's Encrypt cert for a DuckDNS domain), set:

```bash
# .env next to the compose file
PI_REMOTE_RP_ID=pi-remote.example.duckdns.org     # the serving domain
PI_REMOTE_ORIGIN=https://pi-remote.example.duckdns.org  # optional; defaults to https://<RP_ID>
```

Then `docker compose up -d` (recreate picks up the env). With `PI_REMOTE_RP_ID`
set, the login page offers "Sign in with Face ID" after the first passkey is
registered (password login → "Add Face ID" banner on the dashboard). Password
login always remains as fallback; removing the banner's passkey restores
password-only. `PI_REMOTE_RP_ID` unset (default) keeps the endpoints disabled.

## 2. Register a machine token

Each machine gets a 64-hex `machineToken`. The hub accepts only sessions
whose `hello.token` is in the tokens file — one token per line:

```bash
docker compose exec hub sh -c 'echo <machineToken> >> /data/tokens'
```

(Or append the line to the file behind the `pi-remote-data` volume on the
host.)

## 3. Install a machine

On the target machine, in a normal shell (NOT inside an agent sandbox — the
script writes `~/.pi`, `~/.pi/agent` and, with `--units`, `~/.config`):

```bash
git clone <repo> && cd pi-remote      # or copy the checkout over
./deploy/install.sh --hub-url ws://<hub-ip>:8787/agent --name "my machine" --units
```

- `--hub-url` — required on first run; re-runs keep the existing value.
- `--name` — optional display name, stored in the config.
- `--units` — also install the systemd user units that arm cold start.
- `--uninstall` — remove everything this script installed.

The script is idempotent: it keeps the existing `machineToken` and machine id
and refreshes the copied files. It prints the machineToken at the end — add
it to `/data/tokens` (step 2) if not done yet.

What lands where:

| Path | Contents |
|---|---|
| `~/.pi/remote/config.json` | hubUrl, machineToken, machineId (mode 600) |
| `~/.pi/remote/stub.mjs` + `shared/` | cold-start stub (port 8788) |
| `~/.pi/agent/extensions/pi-remote/` | pi extension + vendored `shared/` |
| `~/.config/systemd/user/pi-remote.{socket,service}` | cold-start units (`--units`) |

## 4. Verify

1. Start (or restart) `pi` in a terminal on the machine. The extension reads
   `~/.pi/remote/config.json`, dials the hub and sends `hello`.
2. Open `http://<hub-ip>:8787`, log in: the machine and its session cards
   appear, and state flips idle → working as the agent runs.

## 5. Cold start (optional, `--units`)

When the phone asks for a new session on a machine with **no** live session,
the hub knocks `http://<machine-ip>:8788/spawn` and the stub spawns a
sandboxed pi via `systemd-run --user` (SPEC §6).

- `pi-remote.socket` holds `0.0.0.0:8788` and wakes `pi-remote.service` per
  connection. The stub answers and exits; the service has **no** `Restart=`
  on purpose — socket activation re-wakes it.
- Status: `systemctl --user status pi-remote.socket`
  Logs: `journalctl --user -u pi-remote.service`
- The service is hardened (`ProtectSystem=strict`, `NoNewPrivileges`, …): it
  can read the whole home but write only `~/.pi` and `/tmp`.

## 6. Uninstall

```bash
./deploy/install.sh --uninstall
```

Removes config, stub, extension and units. Remote-started sessions (transient
`run-*.service` units) keep running; stop them with
`systemctl --user stop <unit>` if wanted. Then delete the machine's token
line from `/data/tokens`.

## Deployment notes (2026-10-31, first production deploy)

- The hub lives at `~/Homelab_Services/pi-remote-hub/` on arch-server
  (`192.168.10.202:8787`): `hub/` + `shared/` copied from this repo plus a
  deployment compose whose build context is that folder. Update = re-copy the
  two directories, `docker compose up -d --build`.
- `tokens` is a bind-mounted file (`./tokens:/data/tokens`). The hub reads
  the token list **once at boot and on SIGHUP** — after editing the file run
  `docker exec pi-remote-hub kill -HUP 1`.
- ZeroTier: `.1` is not live; network-server holds `192.168.192.5`. The hub
  is reachable via LAN/WireGuard at `192.168.10.202:8787`. Direct ZeroTier
  access from the phone needs a managed route via network-server (a
  Homelab-Network change).
- The Dockerfile pre-creates `/data` owned by the runtime user so the named
  volume is writable.
