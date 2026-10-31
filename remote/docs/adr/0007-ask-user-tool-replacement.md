# ADR 0007 — Ask-user tool replaced, mirrored to terminal, first answer wins

Date: 2026-11-26

## Status

Superseded by ADR 0008 (bridge, not replace).

Accepted

## Context

The phone answers ask-user questions via `tool_call` interception that blocks
the built-in tool and returns the answer as the block reason. Pi treats
blocked calls as errors, so the terminal shows the question as failed with a
raw JSON line, and the built-in dialog never appears in the terminal — a
terminal user never sees the question at all.

## Decision

The extension replaces the ask-user tool implementation instead of blocking
it. The replacement relays the question to the phone and, in TUI mode, also
opens pi's own select dialog so the terminal sees and can answer the
question. Whichever surface answers first wins; the other sees the question
settled. The tool returns a normal success result carrying the answer, so
the transcript reads it as a completed call, not a failure.

## Consequences

- The phone and the terminal are equal answer surfaces; a dangling dialog
  after the phone answers first is closed by the dialog's own timeout and
  its late resolution is ignored.
- The recorded transcript shows a successful tool result with the answer.
- Subagent sessions inherit the same behavior; their questions surface in
  the parent's phone UI.
