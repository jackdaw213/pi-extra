# ADR 0005 — Hub password and machine tokens (QR pairing dropped)

Date: 2026-10-31
Supersedes: ADR 0003 (QR pairing with a generated key secret)

## Status

Accepted

## Context

ADR 0003's QR flow existed because the extension itself was going to serve
the phone directly, so the secret had to cross from terminal to phone. With
the lab hub (ADR 0004), the phone talks only to a normal website. The
operator asked to drop QR pairing: "where are we going to store the secret if
it is a website — we only need a password."

## Decision

Two credentials, two boundaries:

- **Phone → hub**: a single hub password, set once at hub deployment, entered
  once in the browser and remembered by it. Standard web login.
- **Extension → hub**: a machine token stored in `~/.pi` on each machine,
  presented on the outbound handshake. The hub accepts only known tokens.

The user's SSH keys are never read or reused.

## Consequences

- No QR rendering, no pairing flow, no generated per-phone secret.
- Password reset = change the hub configuration.
- Token revocation happens at the hub; a machine loses access on removal.
- Transport is plain HTTP/WebSocket inside the LAN/ZeroTier; TLS termination
  can be added later via the lab's existing reverse proxy without protocol
  changes.
