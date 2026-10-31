# ADR 0008 — Ask-user is bridged, not replaced

Date: 2026-11-26

## Status

Accepted. Supersedes ADR 0007.

## Context

ADR 0007 had pi-remote replace the ask-user tool. In the field that produced a
tool-name conflict with the main ask-user extension (rpiv-ask-user-question)
that could stop the whole extension from loading, and the replacement's
modal dialog in the terminal locked the session: cancel, answering, and
messaging all became impossible while a question was pending.

## Decision

pi-remote registers no ask tool and intercepts nothing. The main rpiv
extension remains the only ask tool; its terminal dialog behaves natively.
pi-remote is a bridge: it maps ask-user tool calls to the website's question
cards, and delivers phone answers through the rpiv extension's external
answer channel (`rpiv:ask-user:answer`), which settles the open
questionnaire — first answer wins, and an external answer closes the terminal
dialog. Ask-user tool results are forwarded so a terminal answer settles the
phone card.

## Consequences

- The terminal can always cancel, answer, and type while a question is
  pending; nothing modal is opened by pi-remote.
- The registration conflict is structurally gone (nothing registered).
- Phone-spawned (`--mode rpc`) sessions depend on the rpiv package's rpc
  fallback behavior; the bridge must keep those sessions answerable from the
  phone.
- If the rpiv extension is absent, ask questions simply do not surface on
  the phone; pi-remote still loads and does everything else.
