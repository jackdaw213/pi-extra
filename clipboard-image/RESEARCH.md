# pi media + keyboard research — verified findings and plan

Two research passes, both verified on this machine. Nothing has been changed yet.

> **STATUS 2026-10-31 (Part 4 — paste deferral ROOT-CAUSED):** the terminal-paste
> render deferral is REPRODUCED headlessly against the real binary and is NOT a
> render/input-buffer bug in the terminal-paste path at all: since the keytab
> install the hardware PASTE key sends `ESC[118;6u` → pi-image smart paste →
> `ctx.ui.pasteToEditor`, and pi core's `pasteToEditor` inserts text with NO
> render request (interactive-mode.ts:2655). Part 3's "not reproducible
> headlessly" conclusion was testing the wrong path. Upstream draft + repro:
> Part 4 and tools/paste-repro.py.

> **STATUS 2026-10-31 (post-build):** superseded — the plan below is now
> history. Built: session-autoname extension, `terminal.images: "kitty"`, the
> pi-image extension (ctrl+v / alt+v queue, widget previews, /watch), and the
> Konsole keytab. Plan item 5's `/show` was built and then REMOVED (kitty
> transcript images unreliable on Konsole regular mode — see git history);
> `/watch` (mpv sixel in a detached Konsole window) ships in its place.
>
> **STATUS 2026-10-31 (preview removal):** the widget's kitty thumbnail
> preview (and its alt+N / click overlay) was removed on user request after
> live testing — kitty images anchored in the fixed widget band drift upward
> on Konsole scrollback and the line diff ghosts around the image rows. The
> pi-image widget is now one text line; text-only is final for now.
>
> **STATUS 2026-10-31 (minimal surface):** `/paste-image` and `/watch` were
> removed on user decision — the command duplicated the ctrl+v / alt+v paste
> keys, and video playback (mpv sixel in a detached Konsole window) is gone.
> The surface is now keys only: ctrl+v / alt+v queue the clipboard image,
> alt+x drops the most recently queued one, and the widget shows the queued
> count only (no filenames).
>
> **STATUS 2026-10-31 (keybindings.json deleted; paste render watcher):**
> `~/.pi/agent/keybindings.json` is GONE (see keytab/README.md). Part 3 below
> documents the terminal-originated paste render investigation and the
> watcher the extension now registers.

## Part 1 — Image rendering, paste keys, session naming (2026-10-31)

### Verified facts

- Terminal: **Konsole 26.08.2**. Supports sixel (22.04+) and the **kitty graphics
  protocol** (~25.04+, no animation, no file-transfer mode; images scroll with text).
- pi natively renders inline images (kitty + iTerm2 protocols, full placement /
  reserved-rows logic in pi-tui), but detection is **env-var only**
  (`KITTY_WINDOW_ID`, `TERM_PROGRAM=kitty|wezterm|ghostty`, iTerm2 vars).
  Konsole matches none → auto-detection leaves images off.
  Override: `terminal.images: "kitty"` in `~/.pi/agent/settings.json` or
  `PI_IMAGE_PROTOCOL=kitty`. Fallback if kitty fails: `"iterm2"`.
- Session naming is manual today (`/name`, `--name`, `ctrl+r` in `/resume`).
  Extension API has `pi.setSessionName(name)` / `pi.getSessionName()` and nested
  model calls via `ctx.modelRegistry.streamSimple()` → auto-naming is buildable.
  Cheap local models: vllm glm53 (192.168.192.20:8000), strata llama.cpp.
- Image paste: pi has built-in `app.clipboard.pasteImage` (Linux default `ctrl+v`;
  pastes image OR text by querying the clipboard itself via wl-paste).
  `~/.pi/agent/keybindings.json` currently DISABLES it
  (`{"app.clipboard.pasteImage": []}`) per pi-image-tools conflict advice →
  user relies on pi-image-tools `alt+v`.
- Terminals never transmit images. Konsole's `ctrl+shift+v` is its own text
  paste; with an image-only clipboard it sends nothing to the app.
- Hardware keys (SofleV2 ZMK, `config/sofle.keymap` lines 113–119):
  `&kp K_UNDO / K_CUT / K_COPY / K_PASTE` = HID AC usages → Linux `KEY_COPY` 133 /
  `KEY_PASTE` 135 → XKB `XF86Copy` / `XF86Paste`. User mapped them in KDE.
  NO terminal encodes these keys (kitty keyboard protocol has no Copy/Paste
  codes; Konsole keytab has no entry) → pi cannot see them without terminal-side
  mapping.
- Installed: img2sixel, wl-paste, wl-copy, mpv, ffmpeg, imagemagick (with SIXEL
  coder, verified). NOT installed: chafa, timg, viu, xclip, kitty.

### Plan (approved scope, not yet built)

1. **Session auto-naming** extension (`session-autoname`): on first user message
   of a session, if unnamed, ask cheap local model for a 3–6 word title,
   `pi.setSessionName()`.
2. **`terminal.images: "kitty"`** + live test in Konsole; fallback `iterm2`.
3. **Rebind image paste**: re-enable built-in `app.clipboard.pasteImage`
   (ctrl+v works today; ctrl+shift+v requires freeing Konsole's shortcut first,
   unconfirmed whether the combo then reaches the app). Adjust pi-image-tools
   config.json to avoid conflicts.
4. **Konsole keytab** mapping XF86Copy → `\x1b[99;6u` (ctrl+shift+c) and
   XF86Paste → `\x1b[118;6u` (ctrl+shift+v); user imports, then bind pi keys to
   match.
5. **`/show <file>`** command: images render inline (entry renderer + Image
   component); video → `mpv --vo=sixel` in a NEW Konsole window (user's choice
   over timg / ffmpeg frame storyboard).

### Open tests

- Does pi's kitty renderer paint on Konsole 26.08.2? (kitty first, then iterm2)
- Does an unbound ctrl+shift+v reach the app in Konsole?
- Do Konsole keytabs accept XF86 keysyms?

---


---

## Part 2 — img2sixel empty output: gdk-pixbuf2 + Glycin (2026-10-31)

### Symptom

pi-image-tools preview: "Sixel conversion produced empty output."
`img2sixel test.png` → exit 0, **0 bytes** stdout, only a warning:
`WARNING: Glycin running without sandbox. Bubblewrap (bwrap) doesn't work in the environment.`

### Root cause chain (verified locally)

1. gdk-pixbuf2 **2.44.8-1** depends on **glycin 2.2.4-1**; image loading goes
   through glycin's out-of-process loaders (`/usr/lib/glycin-loaders/2+/…`).
2. Glycin sandboxes its loaders with **bwrap**; bwrap needs user namespaces.
3. Inside pi's sandbox (systemd unit): `bwrap --ro-bind / / -- true` →
   **"No permissions to create a new namespace"** → glycin falls back to
   no-sandbox → still fails → gdk-pixbuf decode yields nothing →
   img2sixel (linked against gdk-pixbuf, confirmed via ldd) writes 0 bytes.
4. Upstream/Arch context (researcher-confirmed, Arch forum #311650 Jan 2026
   "[SOLVED] img2sixel doesn't work", gdk-pixbuf GitLab #292, glycin #203):
   Arch enabled glycin loading in gdk-pixbuf2 **2.44.1-4** (Sept 2025).
   Failure is not sandbox-only — reported broken in normal sessions too.
   No fixed release yet (2.44.8 current).
   Community fix = downgrade (2.44.1-3 = glycin disabled, or 2.42.12-2) — rejected.
5. Ruled out: the stale empty `/usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache`
   (owned by nobody, 2025-10-28) is NOT the trigger — bypassing it via
   `GDK_PIXBUF_MODULE_FILE=/nonexistent` changed nothing (still 0 bytes).
6. pi-image-tools calls bare `img2sixel` (`--version` probe, then
   `img2sixel <file>` reading stdout) — resolved via PATH; pi's PATH puts
   `~/.pi/agent/bin` FIRST. Wrapper interception is therefore possible.

### Verified alternative (no downgrade needed)

- **ImageMagick's SIXEL coder works on this machine** (verified):
  `magick input.png sixel:-` → real sixel bytes (64×64 → 2214 B; 400px-wide
  resize of 924×2000 → 45 KB). No gdk-pixbuf/glycin involvement (`ldd` clean).
- chafa 1.14+ (`--format sixels`, own decoders) and timg (ffmpeg decoders)
  also avoid gdk-pixbuf but are not installed.

### Options (no downgraded packages)

| Option | Scope | Cost |
|---|---|---|
| A. Wrapper `~/.pi/agent/bin/img2sixel` → `exec magick "$1" sixel:-` (handle `--version`) | fixes pi-image-tools previews only | tiny, reversible, zero root |
| B. pi kitty rendering (`terminal.images: "kitty"`, Part 1 item 2) | transcript images skip sixel entirely | one setting + test |
| C. AUR `gdk-pixbuf2-noglycin` or `libsixel-git` (built without gdk-pixbuf) | fixes img2sixel system-wide | AUR build, maintainance lag |
| D. Fix pi sandbox to allow namespaces (fish launcher systemd-run props) | lets glycin-based apps try inside pi | may not help if glycin is broken system-wide; test first |
| — Downgrade (2.44.1-3 / 2.42.12-2) | — | rejected by owner |

**Recommendation:** A + B (both tiny, verified mechanisms), optionally C for a
system-wide fix. Open test: run `img2sixel /tmp/test64.png | wc -c` in a NORMAL
Konsole tab — 0 bytes confirms system-wide breakage (then D is pointless, C is
the only system-wide fix).

---

## Part 3 — terminal-originated paste renders one input event late (2026-10-31)

### Symptom (user's live report, Konsole 26.08.2, pi TUI regular mode)

With Konsole's Paste ACTION bound to the hardware PASTE key, pasting TEXT
into pi shows NOTHING until the next keypress. Pasting twice shows the first
paste only after a keypress, the second on the next keypress — the screen is
exactly one input event behind. The text IS in the editor state (it appears
complete, and submitting sends it). The contrast claim: pi-image's smart
paste (ctrl+v/alt+v/ctrl+shift+v) appeared to render immediately.

### What pi 1.4.0 actually does (verified in source: npm dist + Pi-Bolt kit,
both byte-equivalent to the installed bundle)

- `tui/dist/stdin-buffer.js` — `StdinBuffer.process/continuePaste`: reassembles
  bracketed pastes split across stdin reads and emits ONE `paste` event;
  `terminal.js` re-wraps it as `\x1b[200~…\x1b[201~` and calls the TUI input
  handler. No negotiation buffering applies to paste chunks
  (`isKeyboardProtocolNegotiationSequencePrefix` does not match them).
- `tui/dist/tui.js` — `TuiBase.handleTerminalInput`: runs input listeners
  (extension `onTerminalInput`) first, then `focusedComponent.handleInput(data)`,
  then **`requestImmediateRender()` unconditionally**. A paste frame is
  requested on `process.nextTick` — no missing render request, no coalescing
  that waits for the next input.
- `tui/dist/components/editor.js` — `Editor.handleInput` paste buffer →
  `handlePaste` → `insertTextAtCursorInternal` → synchronous insert +
  `onChange`. The editor's render cache (`isRenderedText`) is state-keyed, so
  the next frame redraws the new text. The Editor is an "unreported" child,
  re-rendered every frame.
- `modes/interactive/components/custom-editor.js` — `CustomEditor.handleInput`
  consults (1) extension shortcuts and (2) `app.clipboard.pasteImage` BEFORE
  the editor. Neither matches a paste chunk: `matchesKey` was exercised
  directly against `\x1b[200~hello\x1b[201~` for every registered key
  (pi-image's ctrl+v / alt+v / ctrl+shift+v / alt+x and the built-in ctrl+v
  default) — all false. Paste chunks reach `Editor.handleInput` untouched.
- For the contrast claim: `ctx.ui.pasteToEditor` (`interactive-mode.js` line
  ~2137) is `this.editor.handleInput("\x1b[200~…\x1b[201~")` with **NO**
  `requestRender` — text smart paste should defer the same way; only IMAGE
  smart paste renders immediately (its `setWidget` → `renderWidgets()` →
  `requestRender()`). The observed contrast likely came from image pastes.

### Empirical probes (all headless, no `pi` run)

1. Pure `TuiMainScreen` + `Editor` + `StdinBuffer` probe against the npm
   pi-tui 1.4.0 dist (Node): every paste chunk produced a frame containing
   the pasted text immediately.
2. Same probe against the Pi-Bolt kit's pi-tui dist (the code the compiled
   copy embeds): identical result. The kit's dist differs from npm (live-line
   diffing renderer, chunked paste reassembly) — still renders immediately.
3. Real-pty probe (`ProcessTerminal` + `StdinBuffer` + `TuiMainScreen` +
   `Editor` wired exactly like pi) under **Node 22** and under the Pi-Bolt
   **Bun 1.4.3** runtime: pastes render a frame instantly in both.
4. Watcher end-to-end probe: the shipped watcher pattern (input listener +
   coalesced `setTimeout(0)` poke) through the real pipeline — consumes
   nothing, poke lands after the insert, burst of 3 pastes → 1 poke, normal
   keys → no poke.

### Konsole side (release/26.08 source)

`TerminalDisplay::doPaste` wraps the text in `\x1b[200~…\x1b[201~` (ESC
stripped, newlines → `\r`) and emits ONE `QKeyEvent`; `Emulation::sendKeyEvent`
is overridden by `Vt102Emulation::sendKeyEvent`, whose kitty path explicitly
falls through for synthetic paste events (`key() == 0`), so the legacy
encoder emits the whole bracketed paste in ONE `sendData` → `Pty::sendData` →
one pty write. No chunking, no delays.

### Conclusion

No missing `requestRender` exists anywhere in the paste path, and the
deferral is NOT reproducible headlessly at any reachable layer. Remaining
suspects are live-environment-only: Bun event-loop ordering when stdin events
queue behind a blocked turn (e.g. the Pi-Bolt IdleCollector's synchronous
`Bun.gc(true)` full GC 500 ms after idle), or a Konsole-side repaint quirk.
Upstream improvement worth filing (not a bug fix — not reproducible):
`interactive-mode.js` `pasteToEditor` should call `this.ui.requestRender()`
after `editor.handleInput`, exactly as `handleRightClickPaste` and
`handleClipboardPaste` already do — one line, makes extension text pastes
deterministic.

### Workaround shipped (extension-side, non-fragile)

The extension registers ONE raw-input listener via `ctx.ui.onTerminalInput`
(on `session_start`, re-bound to the fresh context each time, unsubscribed on
`session_shutdown`). The listener always returns `undefined` — it consumes
nothing and transforms nothing. On a chunk containing a bracketed-paste
marker (`\x1b[200~` or `\x1b[201~`; no other terminal input contains either)
it schedules ONE coalesced `setTimeout(0)`. The macrotask timer fires only
after the current input dispatch (listener → editor insert → pi's immediate
render) has fully finished, so the poke is ordered strictly AFTER the editor
insert. The poke is `ctx.ui.setStatus("pi-image-paste-render", undefined)`:
pi deletes the never-set footer status key (invisible) and its
`setExtensionStatus` unconditionally calls `ui.requestRender()` (verified in
both the npm and kit dists). Worst case cost: one extra no-op diff frame per
paste burst.

Live test: paste text via the hardware PASTE key in pi — the text should now
appear immediately (and at worst one ~0–16 ms frame later).

---

## Part 4 — Upstream: paste chunk deferred until next input event (2026-10-31)

> REPRODUCED headlessly and ROOT-CAUSED. Part 3's conclusion ("not
> reproducible headlessly; remaining suspects are live-environment-only") is
> WRONG for the path the user actually triggers daily. Part 3 tested the
> TERMINAL bracketed-paste path — which is genuinely fine (proven below,
> byte-level) — but since the Konsole keytab install, the hardware PASTE key
> does not send bracketed paste at all: it sends `ESC[118;6u`
> (ctrl+shift+v), which pi-image's smart paste owns, and the deferral lives
> in pi core's `ctx.ui.pasteToEditor`. The render-poke watcher (78328d0)
> never fires on that path because `ESC[118;6u` contains no bracketed-paste
> markers — which is why "the workaround does NOT help".

### Upstream issue draft (for https://github.com/earendil-works/pi/issues — not filed)

**Title:** `ctx.ui.pasteToEditor()` inserts text with no render request —
pasted text appears only after the next keypress

**Environment**

- pi 1.4.0 (verified identical in the npm dist, the Pi-Bolt kit tree, and the
  installed Pi-Bolt 1.0.7 AOT bundle). Both runtimes affected: Bun 1.4.3 AOT
  and Node 22.
- Arch Linux, Konsole 26.08.2, kitty keyboard protocol flags 7 active
  (pi pushes `ESC[>7u`; Konsole replies). Bracketed paste on.
- The paste arrives as ONE complete chunk (proven with a raw capture tool and
  with an in-pi input logger — see Repro).

**Symptom**

An extension inserts clipboard text via `ctx.ui.pasteToEditor(text)` (here:
the pi-image extension, whose smart paste owns ctrl+v / alt+v /
ctrl+shift+v). The text lands in the editor state (submitting sends it), but
NOTHING is painted until the next keypress; each further paste again stays
invisible until the keypress after it. The screen behaves as if exactly one
input event behind.

**Expected** — the insert renders immediately, like the built-in paste paths.

**Actual** — zero frame bytes are written for the insert. Verified at byte
level: after the paste key, pi emits only a 29-byte cursor-position frame
(`ESC[?2026h ESC[26;3H ESC[?25l ESC[?2026l`) and then NOTHING for as long as
we wait (2.5 s in the repro); the pasted text appears in the very next frame
after any keypress.

**Root cause (file/function)**

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` line
  2655 (npm 1.4.0 dist `modes/interactive/interactive-mode.js` line 2137):
  `pasteToEditor: (text) => this.editor.handleInput(`` `\x1b[200~${text}\x1b[201~` `` ``)` —
  inserts via the editor and requests NO render.
- Contrast with pi's own built-in paste paths, which DO render after their
  async inserts: `handleClipboardPaste` (`this.ui.requestRender()` after
  `insertTextAtCursor`, line 3124) and `handleRightClickPaste`. The
  extension-facing API simply lacks the call.
- Aggravating ordering (why even pi's one automatic render misses it): the
  shortcut handler is async. `TuiBase.handleTerminalInput` (tui.ts) calls
  `focusedComponent.handleInput(data)` then `requestImmediateRender()`
  unconditionally — but an extension handler returns at its FIRST await
  (clipboard read), so the immediate render fires on the UNCHANGED editor
  (that is the 29-byte cursor frame), and the insert happens in a later
  macrotask with no render request behind it. Even a synchronous clipboard
  would race: the handler's continuation is a promise microtask, and pi's
  `process.nextTick` render callback runs first.
- No input buffer is involved. An in-pi raw-input logger shows the chunk
  arriving instantly and completely; `StdinBuffer` emits the paste/key event
  synchronously; the editor state updates immediately. The "buffer" that
  holds the text is the renderer's dirty state with NO frame scheduled;
  the next input event is the first thing after the insert that requests a
  frame (`handleTerminalInput` → `requestImmediateRender`).

**Repro (self-contained, in this repo)**

- `tools/paste-repro.py` — spawns the real binary in a pty with
  `--no-session --offline --no-mcp` (no model calls, no auth, no prompts),
  injects input exactly as the terminal would, and classifies each run as
  IMMEDIATE (echo within the wait window) or DEFERRED (echo only after a
  wake key `x`), with per-chunk timestamps in `/tmp/pi-repro/<case>.log`.
- `tools/minrepro-ext/index.ts` — the minimal core repro: a 10-line
  extension registering `alt+o` → `ctx.ui.pasteToEditor("QZMIN")`. Run:
  `python3 tools/paste-repro.py content` and read the `core-min` row
  (injected `ESC`+`o`; QZMIN renders only after the wake key).
- `tools/inputlog-ext/index.ts` — loads via `-e` and logs every raw input
  chunk pi receives to `/tmp/pi-repro/pi-input.log`, proving the chunk
  arrives instantly and completely.

**Isolation matrix (each row a separate real-binary pty run)**

| Row | Configuration | Bracketed paste `ESC[200~…ESC[201~` | Keytab/smart paste path |
|---|---|---|---|
| full | compiled AOT binary, extensions on | IMMEDIATE (~1–2 ms frame) | DEFERRED (smart-keytab) |
| noext | `--no-extensions` | IMMEDIATE | n/a (no smart paste) |
| kitty | kitty protocol reply injected first | IMMEDIATE | DEFERRED (smart-kitty) |
| regular | `--tui-mode regular` | IMMEDIATE | n/a |
| ab-plain | bracketed vs plain bytes, one run | IMMEDIATE / IMMEDIATE | — |
| double | two bracketed pastes | IMMEDIATE / IMMEDIATE | — |
| large / multiline / burst / trailing-kitty-release / 6 s-idle | shape variants | IMMEDIATE | — |
| node | npm pi on Node 22 | IMMEDIATE | — |
| systemd | fish-launcher sandbox properties via `systemd-run --user --pty` | IMMEDIATE | — |
| smart-ab | smart paste then bracketed paste, one run | second paste paints instantly AND flushes the still-unpainted smart paste (the user's "one event behind") | DEFERRED |
| core-min | 10-line extension, `pasteToEditor` only | — | DEFERRED |

Real-Konsole check (Xvfb 1600x900, user's actual "Profile 1", real pi binary
bridged on a private pty): pi's paste frame bytes go out in ~1–2 ms and
Konsole paints them immediately (pixel diff of screenshots; both for
injected bracketed paste and for pi's whole startup). Konsole's painting is
exonerated; so are the systemd sandbox, Bun, kitty protocol state,
extension set, paste size/shape, and idle timing.

**Suggested fix**

One line, same precedent as `handleClipboardPaste`:

```ts
pasteToEditor: (text) => {
    this.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
    this.ui.requestRender();
},
```

`setEditorText` (line 2656) deserves the same look — it is the other
programmatic editor mutation exposed to extensions and it also requests no
render. A render-request inside the API (rather than relying on callers)
would fix every extension at once; pi's built-in callers keep their explicit
calls.

**Extension-side workaround until fixed (not applied here)**

After `ctx.ui.pasteToEditor(...)`, poke one render, e.g.
`ctx.ui.setStatus("<key>", undefined)` (pi's `setExtensionStatus` always
calls `ui.requestRender()`). The shipped paste-marker watcher (Part 3 /
commit 78328d0) does not cover this path — it triggers only on chunks
containing `\x1b[200~`/`\x1b[201~`, which `ESC[118;6u` does not contain.

### Repro script notes

- `python3 tools/paste-repro.py` runs the whole matrix (~4 min);
  `content` adds paste-shape rows plus the smart-paste rows;
  `smart-ab` is the single-run user-observable A/B.
- The smart rows need the `wl-paste` stub (created by the script at
  `/tmp/pi-repro/stub/`) so the clipboard payload is deterministic and the
  real clipboard is never touched: `PATH=/tmp/pi-repro/stub:$PATH
  WAYLAND_DISPLAY=wayland-stub`.
- Run it anywhere; it never sends prompts or model calls
  (`--no-session --offline --no-mcp`), never writes sessions, and never
  touches `~/.pi`.

> Fix shipped in pi-image (commit ef4e4df): direct render poke after
> pasteToEditor; watcher removed.
