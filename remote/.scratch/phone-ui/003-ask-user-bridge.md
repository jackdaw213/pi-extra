# Spec: Ask-user bridge — build on the main extension, no duplicate tool

Labels: ready-for-agent

## Problem Statement

The pi-remote extension registered its own ask-user tool and blocked the real
one. Three failures in the field: the duplicate registration collides with the
main ask-user extension (@juicesharp/rpiv-ask-user-question), which can stop
the whole pi-remote extension from loading; the terminal never shows the
question dialog; and when a question is pending the terminal locks — the
modal dialog swallows cancel, answering, and messaging. The user wants the
terminal to show the question and answer it, the phone to show it too, and
answering from either to work — with one ask tool, not two.

## Solution

pi-remote stops being an ask tool and becomes a bridge. The main rpiv
extension stays THE ask tool (its terminal dialog is native, cancellable, and
never blocks the composer). The rpiv extension ships an external answer
channel (its `rpiv:ask-user:answer` event settles an open questionnaire,
first answer wins, keyed by tool-call id, and closes the terminal dialog when
an external answer arrives). pi-remote renders the questions on the website
and delivers phone answers through that channel.

## User Stories

1. As a terminal user, I want the ask-user dialog to appear and behave exactly like the main extension's, so that nothing about my terminal changes.
2. As a terminal user, I want to cancel or answer while a question is pending, so that the session never locks.
3. As a phone user, I want the same question as a card with tappable options, so that I can answer from anywhere.
4. As a phone user, I want my answer to close the terminal dialog, so that the run continues immediately.
5. As a terminal user, I want my answer to settle the phone card, so that both surfaces agree.
6. As a phone user, I want a question answered in the terminal to show its answer on my card, so that I have a record.
7. As a user, I want pi-remote to load even when another extension provides ask-user tools, so that a name conflict can never break the hub connection.
8. As a user, I want exactly one ask-user tool, so that there are no duplicates or conflicts.
9. As a phone user of a phone-spawned session, I want questions answerable from the phone, so that headless sessions never hang.

## Scenarios

Pinned in `features/pi-remote-phone-ui.feature` ("Question appears in the
terminal too" updated): question visible in terminal and phone; either answer
wins and settles both; terminal never locks (cancel/abort/type always work);
pi-remote loads with the main extension present; phone-spawned sessions
answer from the phone.

## Implementation Decisions

- Delete the duplicate tool: remove the extension's `registerTool` calls, the
  `tool_call` interception for ask tools, the pending-question map, and the
  local-answer path. pi-remote registers nothing ask-related.
- Bridge in: the forwarded `tool_execution_start` event for ask-user tools
  carries the questions in its input — map that to the existing A_QUESTION
  frame (callId = the real toolCallId; contract unchanged, phone untouched).
- Phone answer out: emit the main extension's answer-channel event with the
  toolCallId and the answer, using the event names and payload shapes from
  the rpiv package source (answer-channel.ts, events.ts, tool/external-answer.ts).
  React to its result event: accepted → nothing more; rejected (already
  settled) → the card settles from the forwarded tool result instead.
- Terminal answer in: forward ask-user `tool_result` events (like todo) so
  the phone card settles with the recorded answer.
- Phone-spawned sessions run `--mode rpc`; the agent must determine from the
  rpiv source (rpc-fallback.ts, docs/hosts.md) what happens to questionnaires
  there and make the phone-answer path work for them — that case is the
  reason the bridge exists.
- The subagent gating, state machine, logging, and all other extension
  behavior are untouched.

## Testing Decisions

- Pure seams: the question mapping (tool input → A_QUESTION payload), the
  answer-channel payload construction, and the result mapping (tool result →
  phone card settle) — red-green in test/question.test.mjs and a new
  test/ask-bridge.test.mjs.
- The rpiv package source on this machine is the fixture source of truth for
  event names and payload shapes.

## Out of Scope

- Multi-question rendering (first question surfaces, as shipped).
- Any change to the todo/agents panels, theme, or dashboard.
- Supporting other ask-user extensions besides the main rpiv one.

## Further Notes

- ADR 0007 is superseded by ADR 0008 (bridge, not replace).
- The user keeps the rpiv extension installed; pi-remote must never fight it.
