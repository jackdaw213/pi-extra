# ADR 0001 — Extension-only architecture, no broker daemon

Date: 2026-10-30

## Status

Superseded by ADR 0004 (home-lab hub). The always-on requirement and the
multi-machine goal reversed the no-broker stance: the hub on the lab is the
front door; the extension connects outbound to it.

## Context

The phone needs to discover, attach to, and steer any running pi session on
this PC. The conventional design is an always-on broker daemon (a systemd user
service) that sessions register with and the phone talks to. The operator
explicitly rejected that: the only components may be pi, the remote extension
inside each session, and the phone.

## Decision

Every capability lives inside the remote extension, which pi loads in every
session from `~/.pi/agent/extensions/`. Each running session serves the phone
directly over HTTP on the ZeroTier network. Session liveness and addresses are
tracked in the on-disk registry (see CONTEXT.md), not in a central process.

## Consequences

- Nothing new must be installed, enabled, or monitored on this PC beyond the
  extension files themselves.
- If no session is running, nothing answers on the network — that is accepted;
  starting the first session is the phone's bootstrap action, done by
  attaching to whatever session the user's bookmark or QR points at.
- Discovery depends on the registry files being pruned of dead entries on
  read, since no daemon owns them.
- Cold start is accepted: with zero running sessions the dashboard is
  unreachable until a terminal session revives it. The documented future
  option is systemd socket activation — a socket unit holds the port at zero
  idle cost and wakes a small on-demand landing service that lists sessions
  and starts new ones. Revisit only if cold start proves annoying in use.
