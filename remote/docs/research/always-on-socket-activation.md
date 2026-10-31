# Research — Always-on dashboard via systemd socket activation

Date: 2026-10-31. Question: can the phone's dashboard bookmark be reachable
at all times, without an always-running daemon, on this PC?

## Verdict

Yes. A systemd **socket unit** holds the well-known port permanently at zero
idle cost (no process until a connection arrives). A first connection wakes a
tiny on-demand **landing service** that serves the dashboard and can start
new sandboxed sessions. This removes the cold-start limitation entirely: the
phone can bootstrap from zero running sessions.

## Probe evidence (all run 2026-10-31 on this PC, from inside the pi sandbox)

| Probe | Result |
|---|---|
| `systemctl --version` | systemd 262 (262.1-1-arch) — full socket-activation support |
| Transient socket+service created over D-Bus (`busctl … StartTransientUnit`) with aux unit | OK (job spawned) |
| `Listen` property type | `a(ss)` pairs of (kind, address) — unit-file `ListenStream=` maps to dbus `Listen ("Stream", addr)`. `ListenStream` as a dbus property name is rejected ("unknown property") |
| `ExecStart` via `a(sasb)` | argv must be non-empty: path, argv array (argv[0] required), ignore-failure bool |
| Socket bound to ZeroTier IP | `ss -tln` shows `192.168.192.2:47613 LISTEN` |
| Connection wakes service | `curl http://192.168.192.2:47613/` → `probe-always.service` executed and wrote its timestamp file |
| Cleanup | `systemctl --user stop` released the port; `reset-failed` cleared state |
| Sandbox interference | none — `systemd-run --user` and user-manager D-Bus both work from inside the session sandbox (also probed 2026-10-30) |

Cleanup verified: no probe units remain (`probe-always.socket/service`,
`probe-sock.socket` stopped; transient units vanish on stop anyway).

## Design that fits the constraints

- **Well-known port** (e.g. `192.168.192.2:8637`) owned by `pi-remote.socket`
  — a static unit, or created transiently by the first session's extension
  (transient units survive their creator but not logout/reboot).
- **Landing service** `pi-remote.service` (`Accept=no`): a zero-dependency
  Node script (node v22.23.4 present) that serves the PWA dashboard, reads
  the session registry, and offers "start new session". It runs only while a
  client is connected/being served. It can spawn sandboxed sessions itself
  (same `systemd-run` parity property list as the extension launcher), so the
  launcher logic must be one shared module.
- The stub gets the same hardening properties (ProtectSystem=strict,
  ProtectHome=read-only, ReadWritePaths `~/.pi` + `/tmp`, NoNewPrivileges).
- Session extensions bind dynamic ports and register in the registry; the
  stub proxies or the client connects directly (spec decision).

## Install story

`~/.config` is read-only inside the sandbox (probed: `Read-only file system`),
so the one-time enable is a manual step outside the agent sandbox — three
commands (`mkdir -p ~/.config/systemd/user`, copy two unit files,
`systemctl --user enable --now pi-remote.socket`). The project can generate
the unit files and a wizard script for it. Transient creation (as probed) can
serve as the fallback that needs no manual step, at the cost of vanishing on
logout/reboot.

## Tiers

1. **v1 baseline**: terminal-revive only (as agreed in ADR 0001).
2. **Socket activation**: dashboard reachable whenever the user manager runs
   (while logged in — the normal working state). One-time manual install.
3. **+ linger** (`loginctl enable-linger jackdaw`, Linger=no today): also
   survives reboot without login. One manual command.

## Unknowns / not probed

- Behavior across logout/login with a transient unit (documented: transient
  units do not survive a manager restart; static enabled units do).
- Phone-side reachability over ZeroTier is assumed working (interface up,
  zerotier-one enabled at boot); end-to-end phone test happens at install.
