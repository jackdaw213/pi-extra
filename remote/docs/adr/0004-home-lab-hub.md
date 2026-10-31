# ADR 0004 — Home-lab hub, single port, outbound extensions

Date: 2026-10-31
Supersedes: ADR 0001 (extension-only, no broker)

## Status

Accepted

## Context

Always-on analysis showed exactly two ways to keep a front door listening:
a resident process, or an OS-held socket (see
docs/research/always-on-socket-activation.md). The operator then pivoted the
target: not only this PC — one bookmark reaching pi sessions on any machine
on the LAN and ZeroTier, with the always-on piece living on the home lab,
which already runs Docker services 24/7. The operator's conclusion: "the only
thing deployed on the home lab is the listening" — a pure front door, not pi.

## Decision

A **hub** runs as a hardened Docker container on the home lab (arch-server),
always-on, listening on ONE port. It serves the dashboard (PWA), keeps the
live session registry, and relays all traffic between the phone and sessions.

The **remote extension** loaded by every pi session makes only OUTBOUND
connections to the hub (persistent connect-and-retry). It never listens
locally. Sessions therefore need no inbound firewall holes on any machine.

Sessions identify themselves with a stable machine identity (hostname +
/etc/machine-id + OS) plus session metadata (name, cwd, model, state), so the
dashboard groups sessions by machine.

Starting a session from the phone keeps ADR 0002 sandbox parity and uses two
paths, in order: (1) any live session's extension spawns it on its machine;
(2) with zero sessions, the hub knocks the machine's socket-activated stub,
which spawns and vanishes (probe-verified; see the research file). The
extension checks for systemd availability and reports "always-on unavailable"
per machine when absent.

## Consequences

- The lab is a dependency: hub down (or NAS-first boot order, Watchtower
  restarts) means the dashboard is down everywhere, even when this PC is fine.
- A compromised hub can inject prompts into pi sessions on every connected
  machine (= code execution inside their sandboxes). Mitigations: hub password,
  per-machine tokens, hardened container, no other secrets in it.
- The extension needs the hub URL configured once per machine.
