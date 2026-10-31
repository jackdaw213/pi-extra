# Handoff — phone UI feature set

Labels: ready-for-human

Candidate: master @ 035b746 (post review-fixes). Verification: 84/84 tests,
extension TS strip-typecheck, hub boot smoke (static, vendor, auth, 404
paths) — all green. Review: 1 blocking (fence-info XSS) fixed with a
regression test; 6 of 7 non-blocking findings fixed, 1 accepted (below).

## What shipped

1. **Rendering** — `hub/web/app/markdown.mjs`: markdown → sanitized HTML
   (raw HTML escaped, link-scheme allowlist, fence-info whitelist), vendored
   marked/highlight.js/mermaid in `hub/web/vendor/` (no CDN; offline LAN
   OK). Live streaming re-renders throttled; mermaid renders client-side
   after the message completes, source fallback on parse failure.
2. **Session history** — attach requests `POST /api/history`; the extension
   maps its own session JSONL (`shared/history.mjs`) to replay events and
   streams them as `history` chunks; the phone buffers live events, renders
   history, then flushes. Same renderer, so history is rich.
3. **Subagents** — nested tool calls render inside their parent agent card
   (collapsed, live "N running" badge, tap to expand); orphans render flat.
4. **Questions** — `*_ask_user_question` tool calls are intercepted in the
   extension (`pi.on("tool_call")`), rendered as a question card with option
   chips; the composer switches to custom-answer mode; answered via
   `POST /api/answer`. Pending questions are re-emitted after a history
   replay, so attaching to an already-blocked session shows the card.
   Blocked sessions hang no more.
5. **Temp/normal + swipe delete** — spawn defaults to temp (normal option
   available); cards show a kind pill; swipe-left reveals Delete; temp
   sessions stop AND erase transcript+inbox (double-gated hub + extension);
   normal/terminal sessions stop only. ADR 0006.

## Deploy (human steps — the lab is agent-read-only)

1. Push/pull master on the lab, rebuild the hub container (deploy/README).
2. Update the extension on each machine (it loads from this repo path via
   the pi package config) and restart sessions.
3. On the phone, hard-refresh the PWA once to pick up the new static assets.

## Known limitations (accepted)

- Subagent nesting in HISTORY is flat: pi's transcript does not record
  nested tool calls as entries, so replay cannot reconstruct them. Live
  nesting is unaffected.
- A nested tool end arriving after its parent's end leaves the parent's
  count badge stale until the card leaves view (cosmetic).
- Question answers reach the model as the block-reason JSON (pi's tool_call
  interception has no replacement-result mechanism); the model reads it
  correctly but the transcript shows the tool call as errored.
- SPEC.md §3/§4 now documents the new frames; re-check on next protocol
  change.
