# ADR 0006 — Temp and normal sessions with different delete semantics

Date: 2026-11-26

## Status

Accepted

## Context

The dashboard lists live sessions, and swipe-to-delete on the phone must do
something sensible for three origins: sessions started in a terminal,
sessions spawned from the phone as keepers, and throwaway phone sessions.
Deleting must not silently destroy transcripts that the user wanted to keep,
and throwaways must not litter `pi --resume` forever. These goals conflict,
so delete behavior cannot be one-size-fits-all.

## Decision

Phone spawn offers two kinds: **temp session** (the default) and **normal
session**. A temp session is disposable by design: swiping it away stops it
and erases its transcript file. A normal session — and any terminal session —
is only stopped and removed from the dashboard; its transcript survives and
stays resumable. Temp sessions remain listed after finishing; only an
explicit swipe removes them.

## Consequences

- Spawn UI carries a temp/normal choice with temp as the default.
- The kind must be visible on the session card so the user knows what a
  swipe will destroy.
- Erasing a transcript is irreversible; the extension performs the erase
  only for sessions explicitly marked temp, after the process is stopped.
- Terminal sessions gained a stop path from the phone (previously
  terminal sessions could not be stopped remotely); the terminal owner sees
  their session end.
