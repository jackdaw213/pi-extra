# pi-remote — control pi sessions from your phone

Labels: ready-for-agent

## Problem Statement

You work with pi in terminals on your PC. When you walk away, you cannot see
what a session is doing, tell it what to do next, hand it a file, or start a
new session — only from the chair in front of the computer. A phone should be
enough.

## Solution

One bookmark on the phone. It opens a dashboard served by a small always-on
container on the home lab: every pi session on every machine you chose, with
its live state. Tap a session to attach — you see the output as it happens,
send messages, exchange files. One button starts a new session, confined by
exactly the same sandbox as a terminal start. No accounts, no app store, no
always-running software on the PC: the sessions connect out to the lab, and
the lab holds the door.

Full protocol and component contract: `docs/SPEC.md`. Vocabulary:
`CONTEXT.md`. Decisions: `docs/adr/0001`–`0005`.

## User Stories

1. As a phone user, I want one bookmark that always answers, so that I never
   think about which machine or port is up.
2. As a phone user, I want to log in once with a password, so that access is
   simple and remembered.
3. As a phone user, I want every machine and its pi sessions on one screen,
   so that I see the whole herd at a glance.
4. As a phone user, I want each session's state (idle, working, blocked), so
   that I know which one needs me.
5. As a phone user, I want to attach to any session, so that I can follow
   what it is doing right now.
6. As a phone user, I want the output streamed live, so that I am reading the
   session, not its archaeology.
7. As a phone user, I want to see messages typed in the terminal, so that the
   phone view never disagrees with the terminal view.
8. As a phone user, I want to send a message to a working session, so that I
   can steer it without waiting.
9. As a phone user, I want to send a message to an idle session, so that I
   can start new work from anywhere.
10. As a phone user, I want to abort a run, so that I can stop a mistake
    immediately.
11. As a phone user, I want to stop a session the phone started, so that I
    can clean up remotely.
12. As a phone user, I want to start a new session on a machine of my
    choice, so that work can begin while I am away from the desk.
13. As a phone user, I want that new session sandboxed exactly like a
    terminal start, so that remote convenience never loosens security.
14. As a phone user, I want the new session to land in ~/.pi by default, so
    that it cannot write where terminal sessions cannot.
15. As a phone user, I want to attach files to a message, so that the agent
    can read what I found on my phone.
16. As a phone user, I want images to reach the model inline, so that I can
    show it a screenshot.
17. As a phone user, I want a session to hand me files, so that results come
    to me without SSH.
18. As a phone user, I want dead sessions to disappear from the dashboard, so
    that I never attach to a ghost.
19. As a phone user, I want sessions to reappear after a hub restart, so
    that lab maintenance does not orphan anything.
20. As a machine owner, I want sessions to connect out only, so that no
    inbound ports open on my PCs.
21. As a machine owner, I want per-machine tokens, so that I choose which
    machines the hub may see.
22. As a machine owner, I want the extension inert without config, so that
    machines without the config behave exactly as before.
23. As a machine owner, I want to uninstall with one command, so that trying
    this out is reversible.
24. As an operator, I want the hub as one hardened Docker container, so that
    deployment matches the rest of the lab.
25. As an operator, I want the repo to be the single source of extension and
    hub versions, so that syncing machines is one command, not a system.
26. As an operator, I want the always-on piece to degrade gracefully without
    systemd, so that a machine either fully works or clearly says so.

## Scenarios

Executable scenarios: `features/pi-remote.feature` (17 scenarios). They were
verified on this machine at the integration seam during the build (see
Testing Decisions); the phone-leg scenarios run at install time.

## Implementation Decisions

- Hub on the home lab as one Docker container; one port; agents connect out
  (ADR 0004, supersedes 0001).
- Phone login is a password; extension↔hub is a per-machine token; no QR
  (ADR 0005, supersedes 0003).
- Extension in every session, zero npm deps, loaded from the user extensions
  directory; factory purity; idempotent shutdown (pi 1.4.0 extension API).
- Message injection via `sendUserMessage` (steer when busy); abort via
  `ctx.abort()`; stop via `ctx.shutdown()` for phone-started sessions only.
- Spawn = `systemd-run --user` sibling transient unit with the exact fish
  launcher property list; stdin held by `sleep infinity |` inside the unit so
  the unit outlives its spawner; default folder `~/.pi` (ADR 0002).
- Two spawn paths: via a live session's extension; via a socket-activated
  stub when a machine has zero sessions.
- File exchange: upload lands in `~/.pi/remote/inbox/<sessionId>/` and paths
  are named in the prompt; images also inline as base64 content; outbound via
  the `send_file_to_phone` tool.
- State taxonomy (idle/working/blocked) follows herdr's; derived from
  agent lifecycle plus prompt-open windows.

## Testing Decisions

- Seam: the hub's public surface (REST + WebSockets) is the one seam. Tests
  speak the protocol from outside — no module-level tests of the hub.
- The extension is tested at the next seam down: a real `pi --mode rpc` with
  a mock hub, asserting the frame flow (hello, events, injection, spawn,
  reconnect).
- The stub is tested at its HTTP seam (health, auth, one real spawn) plus
  `systemd-analyze verify` for the units.
- Prior art: pi's checked examples (subagent for spawning, herdr for
  outbound state reporting) were the reference implementations.
- The phone-leg (ZeroTier, Safari PWA) is verified at install time by the
  operator — it is environment, not code.

## Out of Scope

TLS termination (lab reverse proxy later), multi-hub, message editing,
transcript backfill beyond live events, push notifications, machines without
the extension, pi versions before 1.4.0.

## Further Notes

Cold start and spawn parity were probe-verified on this machine before the
build (see `docs/research/`). The lab is read-only for agents: the operator
runs the compose deploy and the machine install (commands in
`deploy/README.md`).
