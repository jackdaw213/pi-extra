# pi-image

Custom pi extension: smart-paste the clipboard into pi with three keys and
drop a mistake with one more. A text-only status line above the editor shows
the queued count. Built for this machine (Arch Linux, KDE Plasma, Wayland,
Konsole 26.08.2).

Replaces `pi-image-tools` (removed from `~/.pi/agent/settings.json` packages
and deleted from `~/.pi/agent/npm/node_modules/`). Written from the pi
extension API directly (`~/GitHub/pi-extra/clipboard-image/RESEARCH.md` has the research that
drove the design).

## Why it exists

- `img2sixel` (libsixel) is broken system-wide: gdk-pixbuf2 2.44.x loads images
  through Glycin, whose bwrap sandbox fails on this machine (verified). This
  extension never calls img2sixel: it normalizes every image to PNG with
  ImageMagick; pi renders the attached images in the transcript through its
  native kitty-protocol support.
- Konsole supports the kitty graphics protocol, but pi only auto-detects it on
  kitty/wezterm/ghostty/iterm2 via env vars. `terminal.images: "kitty"` in
  `~/.pi/agent/settings.json` forces it on (option B).
- The extension's own draft widget is TEXT-ONLY (see below): kitty images
  anchored in a fixed band above the editor are not reliable on Konsole.

## Usage (the whole surface is four keys + Enter)

- `ctrl+shift+v` / `ctrl+v` / `alt+v` — smart paste; all three keys run the
  identical handler:
  - An image on the clipboard is queued for the next message (wl-paste on
    Wayland, xclip fallback; normalized to PNG via `magick`; max 10 images,
    15 MB each). A successful image paste is silent — the count line below is
    the feedback.
  - With no image, the clipboard TEXT is inserted verbatim at the cursor via
    pi's `pasteToEditor` (bracketed-paste handling, large content collapses),
    followed by one render poke so the text paints immediately (pi core's
    `pasteToEditor` requests no render of its own). Bytes pass through as-is
    — no newline trimming.
  - With neither, a single `[pi-image] clipboard is empty` notify.
- `alt+x` — drop the most recently queued image. No-op when the queue is
  already empty; intermediate drops are silent, and dropping the last image
  shows a `[pi-image] queue empty` notify (the count line disappears with it).
- `Enter` on an EMPTY (or whitespace-only) editor — send the queued images
  with no text. This is the "paste screenshot → Enter → sent" flow: pi's own
  submit gate makes a bare Enter a no-op, so a screenshot could never be sent
  alone (details below). The message carries one text part, `(see attached
  image)`, plus the queued PNGs — pi builds user messages as
  `[text, ...images]` and the Anthropic adapter forwards text blocks verbatim,
  so a non-empty text part is required for providers that reject empty text
  blocks. The string is pi's own placeholder for exactly this situation.
  - While the agent is streaming, the send is queued with
    `deliverAs: "steer"` — the same pi queue a typed message uses mid-run
    (visible in the pending-messages display).
  - While compaction is running the send pauses (pi's `prompt()` rejects
    every send during compaction); the queue is kept and a warning notify
    says so. Press Enter again after it finishes.
  - With no model selected the send is refused with an error notify and the
    queue is kept.
  - Typed text + Enter is completely untouched: the normal submit path,
    slash commands, `!` bash mode, and history all behave exactly as before.

That is all. On send, the queued images attach to the message as PNG; pi
renders them in the transcript when `terminal.images: "kitty"` is active.
Images already attached by other means are preserved.

### How Enter-on-empty works, and why not a raw-input listener

pi's submit gate (verified in the installed pi 1.4.0 bundle,
`interactive-mode.js setupEditorSubmitHandler`):

```js
this.defaultEditor.onSubmit = async (text) => {
  text = text.trim();
  if (!text)
    return;   // ← whitespace-only submissions are dropped here
```

So a whitespace-only editor never submits either, and the extension `input`
event never fires for an empty editor. The base editor's `submitValue()`
already clears the editor before calling `onSubmit`, so a bare Enter is a
complete no-op today.

The fix replaces the editor through the OFFICIAL `ctx.ui.setEditorComponent`
extension point (same pattern as pi's `modal-editor.ts` example) with a real
`CustomEditor` — pi's own exported class — whose `submitValue` is wrapped at
the instance level: empty/whitespace text + non-empty queue →
`pi.sendUserMessage(...)`; everything else → the original `submitValue`
untouched. Because the editor processes Enter ONLY while it is the focused
component, this can never hijack Enter while a core dialog is open: the model
selector, settings, session/tree/trust selectors, and extension
select/confirm/permission dialogs all take focus (verified in the bundle —
they swap the editor container's child via `showSelector`/
`pushExtensionDialog`, they do not sit on the TUI overlay stack).

A raw `ctx.ui.onTerminalInput` listener on `\r` was REJECTED: the TUI runs
extension input listeners for ALL raw input BEFORE focus dispatch
(`TuiBase.handleTerminalInput`), so such a listener also fires while a dialog
is focused. No public API covers that case — `tui.hasOverlayEntries` misses
the container-swap dialogs above, and there is no public editor-identity or
dialog-state API — so plain Enter via that route could send images on the
same Enter that confirms a model selection. A dedicated send shortcut was
considered and skipped: the empty-Enter path already covers the flow, and a
second key would add surface without adding capability.

> `/paste-image` and `/watch` were removed on user decision (2026-10-31) —
> the command duplicated the paste keys, and video playback is gone.

### Status line (above the editor) — count only

While images are queued, ONE text line sits above the editor:

```
[pi-image] 2 queued · alt+x drops last
```

- Singular for one image: `[pi-image] 1 queued · …`.
- Count only — no filenames (screenshot names are noise).
- Truncated to the terminal width; hidden entirely when the queue is empty.
- No kitty images are drawn for the widget — nothing for the terminal to
  repaint or retransmit, so the widget line is byte-stable by construction.

**Why text-only:** the earlier thumbnail strip (kitty images side by side
plus an alt+1..5 / click preview overlay) was REMOVED on user request after
live testing on Konsole 26.08.2. Kitty images anchored in a fixed band above
the editor drift upward when the user scrolls — the terminal scrolls the
anchored image with the scrollback while pi keeps the band fixed — and the
line diff ghosts/duplicates lines around the image rows. Text rendering in
pi is reliable; kitty images in that band are not. RESEARCH.md holds the
evidence.

## Hardware Copy/Paste keys (Konsole keytab)

`keytab/sofle-copypaste.keytab` maps the SofleV2's hardware COPY / CUT /
PASTE / UNDO keys to kitty-protocol CSI-u bytes inside Konsole, so pi can
see them (no terminal encodes these keys by default). Install, pi
keybindings, and test steps: **[keytab/README.md](keytab/README.md)**.

### Lifecycle guarantees (fixed in the 2026-10 rework)

- After any queue change the widget ends up **hidden when the queue is empty**
  and up to date otherwise — clearing is unconditional and idempotent, and
  the line cache is dropped on hide.
- A failing `notify()` or a stale/throwing extension context can no longer
  lose queued images: the `input` transform mutates the queue first and keeps
  all UI side effects guarded, so the message always carries the queued
  images. The `alt+x` drop follows the same pattern.
- The widget is registered with pi **once per show** (pi calls the
  `setWidget` factory immediately and replaces the component on every call).
  The widget is a single plain-text line, so unchanged frames are byte-stable
  trivially — there are no kitty payloads to repaint or retransmit.
- A stale `pi-image-previews` session entry from an older build (the removed
  widget-style toggle) is ignored on `session_start`.

## Show images in the conversation (agent-side)

REMOVED for now: kitty-protocol images anchored in the scrolling transcript
rendered unreliably on Konsole in regular mode (images stretched over text
when scrolling). See RESEARCH.md — a robust replacement needs a different
rendering strategy in regular mode.

## Install

```bash
ln -sfn ~/GitHub/pi-extra/clipboard-image ~/.pi/agent/extensions/clipboard-image
```

Requires: `wl-clipboard` (Wayland), `imagemagick`. Transcript image rendering
needs `terminal.images: "kitty"` in `~/.pi/agent/settings.json`.

## Development

```bash
npm install        # dev deps: pi 1.4.0 packages, typescript, jiti
npm run typecheck  # tsc, strict
npm test           # headless harness: jiti + mock ExtensionAPI/pi-tui
```

The harness (`harness/`) loads `index.ts` through jiti with
`@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` aliased to
minimal mocks (width measuring and truncation; a faithful CustomEditor
submit path) and drives the extension through a mock
`ExtensionAPI`/`ExtensionContext` that mirrors pi 1.4.0 interactive-mode
semantics (factory invoked immediately by `setWidget`). It asserts the
lifecycle guarantees above, the count-only widget (exact line, singular,
hidden when empty, hard truncation at narrow widths, byte-stable repeat
renders, no filenames), failure injection (notify/setWidget throw, stale
context), and the alt+x drop semantics (drops only the last queued image,
silent until the queue empties, then a single `queue empty` notify; no-op on
an empty queue) — no model calls, no terminal needed. Enqueues run through the real ctrl+v clipboard path against a
wl-paste stub, and the smart-paste tests drive the same stub in text mode:
the three registered paste keys (identical handler), text fallback through
`pasteToEditor` with byte-exact payloads plus the one render poke after the
insert (and no poke on the image or empty-clipboard paths), image-priority
over text when both
mime types are offered, and the empty-clipboard notify.
The empty-editor Enter groups drive the registered editor factory: exact
`sendUserMessage` content (placeholder text + PNG ImageContent), queue
cleared and widget hidden, the typed-text submit path untouched, queue-empty
no-op, whitespace-only editor, steer delivery mid-run, the compaction pause
and its resume via `session_compact`/`agent_settled`, the no-model refusal,
and queue restoration when the send throws synchronously.

## Notes

- The extension OWNS the paste keys: `ctrl+shift+v`, `ctrl+v`, and `alt+v`
  are all registered by the extension with one smart-paste handler. Extension
  shortcuts are evaluated before built-in editor handling (verified in pi
  1.4.0 `custom-editor.js`), so they shadow the built-in
  `app.clipboard.pasteImage` default (`ctrl+v` on Linux) without any
  keybindings.json entry — `~/.pi/agent/keybindings.json` intentionally does
  NOT exist (deleted 2026-10-31 after live testing; do not recreate it).
  Without the extension's ownership, ctrl+shift+v would reach pi's built-in
  action, whose Linux path inserts the image's file PATH as text instead of
  attaching it. `tui.input.copy` keeps its stock binding; hardware COPY with
  no selection (`ctrl+shift+c`) is a harmless no-op in pi — selection-copy is
  Konsole's own action.
- `alt+x` is not bound by any pi default action, so the extension owns it.
- The empty-Enter send goes through `pi.sendUserMessage`, whose async
  failures surface as pi extension errors; if `prompt()` rejects after the
  call (e.g. an auth failure), the images are lost — the same exposure the
  input transform has on a normal typed send. The two detectable refusal
  cases (compaction, no model) keep the queue.
- Clipboard captures are cached in `~/.cache/pi-image`.
- Terminal-originated bracketed paste (Konsole's Paste action) needs no help:
  pi renders it itself. Only the extension's own text smart paste pokes a
  render — pi core's `pasteToEditor` inserts text without requesting one
  (see RESEARCH.md "Part 4").
