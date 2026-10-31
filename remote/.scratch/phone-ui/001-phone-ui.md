# Spec: Phone UI — rendering, history, subagents, questions, swipe delete

Labels: ready-for-agent

## Problem Statement

From the phone, pi sessions are usable but crude:

1. Everything renders as plain text. Tables, code, lists, and diagrams the
   agent produces show as raw characters.
2. Attaching to a session shows only what happens from now on. The past is
   invisible — unlike `pi --resume`, which shows the whole transcript.
3. Spawned subagents are invisible. Their activity interleaves with the main
   stream, there is no indicator the main session is waiting on them, and
   ask-user questions render as a bare tool card. A question from a
   phone-spawned session hangs forever because nobody can answer it.
4. Removing a session requires terminal fiddling. There is no delete gesture.
5. Typing on the phone is slow; there is no voice input.

## Solution

1. **Rich rendering.** Assistant output renders as markdown — bold, lists,
   tables, tappable links — with syntax-highlighted code blocks and mermaid
   diagrams drawn as diagrams, live while streaming and in history.
2. **Session history.** Attaching shows the session's entire past transcript
   immediately — chat-app style, the same content `pi --resume` shows —
   rendered with the same richness, and live output continues below it.
3. **Subagent cards.** Each subagent appears as its own collapsible card
   nested under the agent tool card, live-updating, with a running count.
   Subagent work never mixes into the main flow.
4. **Question cards.** An ask-user tool call renders as a question card with
   tappable option chips; the composer stays live, so typed text answers the
   question with a custom response. Answerable from the phone in any session
   mode.
5. **Swipe delete.** Swiping a session card from right to left reveals
   Delete. Temp sessions (the default spawn) stop and erase their transcript;
   normal sessions and terminal sessions stop only — transcript kept. Spawn
   offers a temp/normal choice, temp default (ADR 0006).

## User Stories

1. As a phone user, I want assistant replies rendered as markdown, so that structure is readable at a glance.
2. As a phone user, I want tables rendered as real tables, so that tabular output is scannable.
3. As a phone user, I want fenced code blocks with syntax highlighting, so that code is easy to read.
4. As a phone user, I want inline code styled distinctly from prose, so that identifiers stand out.
5. As a phone user, I want mermaid blocks rendered as diagrams, so that graphs are pictures instead of text.
6. As a phone user, I want links tappable, so that I can follow references.
7. As a phone user, I want markdown rendered while the reply streams, so that formatting appears as it arrives.
8. As a phone user, I want code blocks to scroll horizontally, so that long lines do not break the layout.
9. As a phone user, I want model-sent HTML treated as text, so that output can never script my phone.
10. As a phone user, I want the renderer to work offline, so that rendering never depends on an internet CDN.
11. As a phone user, I want the entire session history shown when I attach, so that I catch up like `pi --resume`.
12. As a phone user, I want history to include tool cards, so that the past reads like the live view.
13. As a phone user, I want history rendered with the same markdown richness, so that old tables and diagrams display.
14. As a phone user, I want history and live output to join seamlessly, so that nothing duplicates or gaps.
15. As a phone user, I want long histories to attach without freezing the phone, so that opening a session stays fast.
16. As a phone user, I want each subagent as its own card nested under the agent tool card, so that subagent work is separate from the main flow.
17. As a phone user, I want subagent cards to live-update with the subagent's tool calls, so that I see progress as it happens.
18. As a phone user, I want a running count on the subagent activity, so that I know the main session is waiting on N subagents.
19. As a phone user, I want subagent cards collapsed by default, so that the stream stays compact.
20. As a phone user, I want tap-to-expand on a subagent card, so that I can inspect its work on demand.
21. As a phone user, I want ask-user questions rendered as a question card, so that I notice the session is blocked and what it asks.
22. As a phone user, I want to answer by tapping an option chip, so that answering is one tap.
23. As a phone user, I want to type a custom answer in the composer while a question is open, so that I am not limited to the listed options.
24. As a phone user, I want the composer to return to normal messaging after a question is answered, so that later text goes to the session as usual.
25. As a phone user, I want the question card to show my chosen answer, so that I have a record of what was sent.
26. As a phone user, I want swipe-left on a session card to reveal Delete, so that I can remove sessions with one gesture.
27. As a phone user, I want swiping a temp session away to stop it and erase its transcript, so that throwaways never litter `pi --resume`.
28. As a phone user, I want swiping a normal session away to stop it but keep its transcript, so that keeper sessions stay resumable.
29. As a phone user, I want swiping a terminal session away to stop its pi process but keep the transcript, so that I retain history.
30. As a phone user, I want new sessions to default to temp, so that spawning stays one tap and cleanup stays cheap.
31. As a phone user, I want to choose a normal session at spawn, so that I can keep sessions that matter.
32. As a phone user, I want the session kind visible on the card, so that I always know what a delete will destroy.
33. As a phone user, I want a deleted card to animate away, so that the gesture feels complete.


## Scenarios

Executable scenarios live in `features/pi-remote-phone-ui.feature` and are
the living specification. Summary of pinned behaviors:

- Markdown (bold, lists, tables, links, highlighted code, inline code)
  renders; raw syntax does not show; model HTML never executes; mermaid
  draws or falls back to source; streaming renders progressively.
- Attach shows the entire past transcript — messages and tool cards, oldest
  first — rendered richly, joined seamlessly by live output, without
  duplication, even while the session is working.
- Subagent tool calls nest inside their subagent card with a live count and
  never appear in the main stream; cards collapse and expand.
- A question card shows the question plus option chips; tapping a chip
  answers; typing in the composer answers with custom text; the card shows
  the answer; the composer returns to normal afterwards; the session reads
  blocked until answered.
- Swipe-left reveals Delete; deleting a temp session stops it and erases its
  transcript; deleting a normal or terminal session stops it and keeps the
  transcript; spawn defaults to temp and offers normal; cards show their kind.

## Implementation Decisions

- **Renderer module.** A pure, Node-testable markdown→HTML module (text in,
  sanitized HTML string out) using vendored libraries in the hub's static
  web tree — no CDN, the PWA must work on the LAN alone. Sanitization is
  mandatory: model output is untrusted. Syntax highlighting and mermaid are
  part of the same vendored asset set; mermaid renders client-side after
  attach of the HTML, falling back to showing the source block on parse
  failure.
- **History replay.** The extension reads its own session file (JSONL,
  format per pi docs) and maps it to replay events equivalent to the live
  event stream; the hub relays them to an attaching phone; the phone renders
  them through the same handlers as live events, then live output appends.
  Oversized tool results truncate in replay. The extension owns the mapping
  as a pure module so it is testable without pi.
- **Subagent nesting.** Nested pi tool calls already carry
  `parentToolCallId`; the extension already forwards the relevant events. The
  phone groups nested events under the parent agent tool card incrementally
  as events arrive (collapsed by default, live count badge); orphan nested
  events render top level. No protocol change needed for display.
- **Ask-user interception.** The extension intercepts ask-user tool calls
  (blocking the built-in execution), sends a question frame carrying the
  call id, question text, options, and multi-select flag, and blocks until
  the phone answers or the run aborts; the answer returns as the tool
  result. This works in every session mode and makes the phone the single
  answer surface, so the terminal never shows a competing dialog. Protocol
  additions are additive new frame types; unknown types stay ignored and the
  protocol version stays 1.
- **Temp/normal sessions.** Spawn payload gains a `kind` ("temp" default,
  "normal"); the kind rides the session summary to the dashboard card as a
  visible tag. Delete of a temp session: hub asks the extension to stop the
  session and erase its transcript file after process exit. Delete of a
  normal or terminal session: stop only. Terminal sessions gain a stop path
  from the phone — this deliberately relaxes the old "terminal sessions
  survive stop" rule (ADR 0006).
- **Swipe UI.** Touch gesture on session cards revealing a delete action;
  pure gesture-state logic kept testable; card animates out on delete.

## Testing Decisions

- Runner: Node's built-in test runner, zero new dependencies.
- Good tests verify external behavior at public seams, never internals.
- Seams (few, highest available):
  1. **Hub WebSocket boundary** — fake extension client + fake phone client
     against the real hub server: history request/relay, question
     relay/answer, delete semantics per session kind, temp flag propagation.
  2. **Pure shared modules** — frame parsing, session-JSONL→replay-event
     mapping, markdown→sanitized-HTML rendering.
  3. **Pure phone modules** — swipe gesture state machine.
- Browser-only behaviors (gesture feel, dictation, mermaid canvas) are
  covered by the Gherkin scenarios as manual verification; automated tests
  stay on the pure seams above.
- Prior art: none — these are the repo's first automated tests;
  `features/*.feature` remains the executable spec.

## Out of Scope

- Editing, annotating, or branching history.
- Chart rendering from data (only mermaid diagrams).
- Push notifications when a session blocks (the existing badge suffices).
- Text-to-speech or voice output; phones already provide system-wide voice
  input, so no in-app dictation is built.
- Erasing transcripts of normal or terminal sessions.
- Any hub or dashboard redesign beyond the listed controls.

## Further Notes

- Vocabulary: CONTEXT.md — Session history, Temp session, Normal session,
  Question card, Dictation.
- ADR 0006 governs delete semantics; ADR 0002 sandbox parity is untouched.
- The hub stays CDN-independent: every renderer asset is vendored.
