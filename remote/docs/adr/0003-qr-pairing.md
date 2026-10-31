# ADR 0003 — QR-code pairing with a generated key secret

Date: 2026-10-30

## Status

Superseded by ADR 0005 (hub password and machine tokens). The QR flow
existed only while the extension served the phone directly; the hub pivot
made it a plain website login.

## Context

The extension's HTTP server lets a client inject prompts into a pi session,
which means running code inside that session's sandbox. ZeroTier membership
alone is network-level access control shared with other machines (the GPU
server is on the same network). The operator wants the phone to hold a secret
"like an SSH key, but not the SSH key", delivered by scanning a QR code.

## Decision

On first use the extension generates a random secret, stores it under
`~/.pi`, and renders a QR code in the terminal encoding the server address and
the secret. The phone scans it once; the Phone client stores the secret and
sends it with every request. Requests without the secret are rejected. The
user's real SSH keys are never read or reused.

## Consequences

- Losing the phone means rotating the secret (regenerate, re-scan).
- Any new phone or browser pairs by scanning the QR again; there is no
  account, no push notification, no server-side session state beyond the
  secret check.
- Traffic rides the ZeroTier network; TLS termination is not provided by the
  extension in v1 (HTTP inside the private network), so the secret header is
  the application-level gate.
