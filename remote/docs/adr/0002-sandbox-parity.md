# ADR 0002 — Sandbox parity for phone-started sessions

Date: 2026-10-30

## Status

Accepted

## Context

Terminal sessions on this PC launch through the `pi` fish function, which
wraps the binary in a systemd transient unit (`systemd-run --user --pty`) with
a fixed property list: ProtectSystem=strict, ProtectHome=read-only,
ReadWritablePaths for `~/.pi`, the invoke dir, `~/.cache`, `~/.npm`, and /tmp,
NoNewPrivileges, and the Protect/Restrict hardening set. Sessions started from
the phone must be confined identically — a phone is the easiest device to
lose, and the whole point of the sandbox is that a compromised or mistaken
agent run cannot write outside its allowed paths.

## Decision

Phone-started sessions are launched through the identical `systemd-run`
property list, taken from the fish launcher as the single source of truth, run
as a new transient user unit. The default working directory is `~/.pi`
(Home base folder). No relaxation, no second sandbox profile.

## Consequences

- The property list must be kept in sync with `~/.config/fish/config.fish`;
  drift is a security bug, so the launcher properties are embedded verbatim
  from one reviewed source.
- Phone-started sessions run headless (no terminal), so they are driven
  programmatically while remaining full sessions with transcripts on disk.
- A phone-started session is exactly as confined as a terminal one: it can
  write `~/.pi`, the invoke dir, caches, and /tmp — nothing else.
