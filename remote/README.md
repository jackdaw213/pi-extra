# remote

Use pi from the phone. A hub (Docker, on the home lab at arch-server) serves
the dashboard; every pi session's extension connects out to the hub. From the
phone: see machines and sessions, attach to a live session, start new ones,
exchange files, answer ask-user dialogs.

- `extension/` — the pi extension (loads in every session)
- `hub/` — the hub server + web dashboard (Docker)
- `shared/` — protocol modules used by both
- `deploy/` — machine installer (`install.sh`) + systemd units
- `docs/` — SPEC.md, ADRs, research

Config: `~/.pi/remote/config.json` (written by deploy/install.sh).
