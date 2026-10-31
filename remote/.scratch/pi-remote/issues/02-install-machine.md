# 02 — Install pi-remote on this PC and verify against the lab hub

**What to build:** this PC appears on the lab dashboard. Every terminal pi
session shows up with its state; the extension is inert on machines without
config, so nothing else changes.

**Blocked by:** 01 — Deploy the hub on the home lab

**Status:** done

- [ x] Run `deploy/install.sh --hub-url ws://<lab-ip>:8787/agent --name "workstation"`
- [ x] Add the printed machine token to the hub's `/data/tokens` (operator or agent via SSH if permitted)
- [ x] Restart a terminal pi session; the session card appears on the dashboard with state flipping idle → working
- [ x] Kill that session hard; the card disappears from the registry
- [ x] Cold-start units: `deploy/install.sh --units` (optional; verifies stub wake + parity spawn)
