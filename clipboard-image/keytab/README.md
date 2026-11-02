# SofleV2 hardware Copy/Paste keys in Konsole

Makes the SofleV2's hardware COPY / CUT / PASTE / UNDO keys work inside
terminals. Without this, those keys do nothing in any terminal: no terminal
encodes them, so a TUI such as pi never receives them.

`sofle-copypaste.keytab` is a Konsole keyboard schema. When selected, Konsole
translates the hardware keys into kitty-protocol CSI-u byte sequences, which
pi parses as ordinary key presses:

| Hardware key (ZMK bind) | Linux keycode | xkb keysym | Qt key | Konsole sends       | pi sees      |
|-------------------------|---------------|------------|--------|---------------------|--------------|
| COPY (`&kp K_COPY`)     | KEY_COPY 133  | XF86Copy   | Copy   | `ESC [ 99 ; 6 u`    | ctrl+shift+c |
| CUT (`&kp K_CUT`)       | KEY_CUT 134   | XF86Cut    | Cut    | `ESC [ 120 ; 6 u`   | ctrl+shift+x |
| PASTE (`&kp K_PASTE`)   | KEY_PASTE 135 | XF86Paste  | Paste  | `ESC [ 118 ; 6 u`   | ctrl+shift+v |
| UNDO (`&kp K_UNDO`)     | KEY_UNDO 131  | Undo       | Undo   | `ESC [ 122 ; 5 u`   | ctrl+z       |

The modifier number is the kitty keyboard protocol encoding: bitmask
shift=1, alt=2, ctrl=4, plus 1. Ctrl+Shift = 1+4+1 = 6; Ctrl alone = 4+1 = 5.

## Install

`~/.local/share/konsole/` is not writable from the agent sandbox, so you run
these steps yourself.

1. Copy the file:

   ```bash
   cp ~/GitHub/pi-extra/clipboard-image/keytab/sofle-copypaste.keytab ~/.local/share/konsole/
   ```

2. Fully quit Konsole (all windows). Konsole scans keytabs at start.
3. Open pi's Konsole profile: Settings → Edit Current Profile → Keyboard,
   and select **Sofle hardware copy/paste**. OK to apply.

The dropdown entry is the name from the `keyboard "..."` line in the file.
The setting is stored in the profile and applies to every future session of
that profile.

### Why the file is long

A Konsole keytab replaces the whole default table; keys not listed fall back
to "send the raw event text" (nothing, for special keys). The file therefore
contains the complete shipped default table (Konsole 26.08.2,
`Default (XFree 4)`) with four added entries at the end. All default
behaviour is preserved byte for byte.

## pi needs no keybindings.json

pi-side keybindings.json is NOT needed and intentionally absent (deleted
permanently on 2026-10-31 after live testing; a backup sits at
`/tmp/keybindings.json.experiment-backup`):

- **PASTE** reaches pi as `ctrl+shift+v` CSI-u bytes, and pi-image's extension
  shortcut registration owns that key — extension shortcuts are evaluated
  before built-in editor handling, so no keybindings.json entry is required
  (verified in pi 1.4.0 `custom-editor.js`). The smart paste queues an image
  or inserts clipboard text.
- **COPY** with a selection is Konsole's own `edit_copy` action (bound to the
  hardware key in Konsole Shortcuts); it never reaches pi. Hardware COPY with
  no selection reaches the app as `ctrl+shift+c`, but pi binds no action to
  that key by default — a harmless no-op.
- Hardware UNDO sends `ctrl+z`, which pi maps to `app.suspend` by default.
  If you do not want that, delete or comment out the `key Undo` line in the
  keytab.

Do not recreate the old `~/.pi/agent/keybindings.json`.

## Verify

### Without pi (raw bytes)

In a Konsole window using the new keytab:

```bash
cat -v
```

Press the hardware PASTE key. Output: `^[[118;6u` (ESC shows as `^[`).
COPY shows `^[[99;6u`, CUT shows `^[[120;6u`, UNDO shows `^[[122;5u`.

This works with plain `cat -v` because the keytab output is sent
unconditionally - no kitty-protocol negotiation is needed. Do not use
`showkey -a`; it only works on Linux virtual consoles, not in Konsole.

### Inside pi

1. **Paste**: copy an image (Spectacle → Copy to Clipboard, or
   `wl-copy < image.png`), press PASTE in pi. The image joins the queue
   widget (pi-image extension).
2. **Copy**: select text in pi, press COPY, then check `wl-paste` in another
   window.
3. `/hotkeys` shows the active bindings for the editor and application.

## Caveats

- **Konsole's own shortcuts still own the typed combos.** Literal
  Ctrl+Shift+C / Ctrl+Shift+V are consumed by Konsole's Copy/Paste actions
  and never reach pi. The hardware keys bypass this: Konsole sees the
  XF86Copy/XF86Paste key events (not the combos), the keytab fires, and pi
  receives the CSI-u bytes. Inside Konsole the hardware keys are therefore
  the only way to trigger pi's `ctrl+shift+c` / `ctrl+shift+v` bindings.
- **KDE shortcuts intercept first.** If the hardware keys do nothing after
  installing, check System Settings → Shortcuts for bindings on
  XF86Copy/XF86Paste/XF86Cut/XF86Undo (from the earlier manual mapping).
  A KDE shortcut captures the key before Konsole sees it. Those mappings
  keep working in KDE apps; only remove them if they block the keytab.
  GOTCHA (cost a full 2026-11-01 debugging session): there are TWO hiding
  places, and the one that matters for Konsole is NOT obvious:
  1. `~/.config/kdeglobals` `[Shortcuts]` — stored under the Qt name:
     `Paste=Paste; Shift+Ins; Ctrl+V` (the leading bare `Paste` IS the
     hardware key; greps for "XF86" miss it). This one governs OTHER KDE
     apps' standard paste action — removing it kills hardware paste there.
  2. **`~/.local/share/kxmlgui5/konsole/sessionui.rc`** — KXmlGui per-action
     saved shortcuts, which OVERRIDE everything for Konsole:
     `<Action name="edit_paste" shortcut="Ctrl+Shift+V; Paste"/>`. The
     trailing `Paste` captures the hardware key inside Konsole even when
     kdeglobals is clean (Qt log proof: Key_Paste → ExactMatch → dispatched
     to edit_paste; Key_Undo → NoMatch → keytab fires). Konsole itself
     re-writes this file whenever its Shortcuts dialog is OKed.
  Fix for Konsole: drop `; Paste` from the sessionui.rc line (keep
  Ctrl+Shift+V), restart Konsole. Keep kdeglobals intact so the hardware
  key still pastes in other KDE apps — the two layers are independent.
- **Kitty protocol interplay.** pi requests kitty keyboard flags 7 at
  startup. Konsole 26.08 then kitty-encodes ordinary keys, but these four
  keys have no kitty functional codes and produce no text, so Konsole falls
  through to the keytab (verified in Konsole 26.08.2 source:
  `Vt102Emulation::handleKittyKeyEvent` returns false for them, and
  `KittyKeyMap` has no entry for them). The keytab works with or without
  kitty mode.
- **Other terminals** do not read Konsole keytabs; there the keys stay dead
  unless the terminal has its own mapping mechanism.

## How the mapping chain works

```
SofleV2 &kp K_PASTE
  → HID Consumer "AC Paste" usage
  → Linux KEY_PASTE (135)
  → xkb <PAST> → keysym XF86Copy-style XF86Paste      (xkeyboard-config inet)
  → Qt::Key_Paste                                     (Qt 6.12 qxkbcommon.cpp)
  → Konsole keytab entry "Paste"                      (name parsed via
       QKeySequence::fromString; Qt 6 dropped the Qt::Key_XF86* names)
  → bytes ESC [ 118 ; 6 u written to the pty
  → pi parses kitty CSI-u → ctrl+shift+v → pi-image's extension shortcut
     (smart paste; extension shortcuts are evaluated before built-in editor
     handling, so no keybindings.json entry is needed)
```

Important: the keytab names are `Copy`, `Cut`, `Paste`, `Undo` - not
`XF86Copy` etc. Qt 6.12 has no `Key_XF86Copy`; a keytab line
`key XF86Copy` would fail `QKeySequence::fromString` and become a dead
entry (silently ignored). Verified against Konsole 26.08.2
(`KeyboardTranslatorReader.cpp`), Qt 6.12 (`qkeysequence.cpp`,
`qxkbcommon.cpp`) and the installed `xkeyboard-config`.

Confidence: high for this machine (Konsole 26.08.2, Qt 6.12, Plasma 6.8
Wayland). The file was validated field by field against the shipped
`default.keytab` and a re-implementation of Konsole's keytab parser; the
only unverified step is the live GUI test, which needs a running Konsole.

## Plasma 6.8.2 regression: the hardware PASTE key arrives as a chord (fixed)

Since the kwin 6.8.2 update (2026-10-31), the hardware PASTE key no longer
reaches Konsole as `XF86Paste`. Verified 2026-11-01:

- `cat -v` + hardware PASTE shows NO bytes — the keytab entry never fires.
- With text on the clipboard the text still pastes — that is Konsole's own
  `edit_paste` action (default shortcut Ctrl+Shift+V) consuming a synthesized
  paste chord; with an image on the clipboard it pastes nothing (Konsole can
  only paste text). kglobalaccel claims no XF86Paste shortcut (D-Bus
  `org.kde.KGlobalAccel.actionList` returns empty), so the translation
  happens inside kwin, not in a shortcut binding.

**The fix (in this repo's keytab):** a `key V+Ctrl+Shift` entry sends the
same byte sequence the hardware key used to send. It needs Konsole's Paste
ACTION unbound so the chord falls through to the terminal emulation:

1. Copy the updated keytab to `~/.local/share/konsole/` (same filename —
   the profile selection survives) and fully restart Konsole.
2. Settings → Configure Keyboard Shortcuts → **Paste** → clear the
   Ctrl+Shift+V binding. (Edit → Paste stays available via the menu.)
3. Keep the fish binding below for text paste at the shell prompt.

Result, verified at each hop: pi (kitty protocol) receives `ESC[86;6u` and
clipboard-image queues the image (pty-tested 2026-11-01); fish receives
`ESC[118;6u` and the binding below inserts clipboard text; `cat -v` shows
`^[[118;6u` again. If a future Plasma fixes the keysym delivery, the old
`key Paste` entry resumes automatically — both entries can coexist.

## Making the keys work in NORMAL terminals (outside pi)

The keytab sends escape bytes to the running program. pi understands them; a
plain shell does not (no app-level copy/paste exists there). Konsole
source-verified precedence (release/26.08 + Qt 6.8):

- **COPY — safe to bind to Konsole.** `edit_copy` is disabled without a
  selection and Qt does not consume keys matched only by disabled shortcuts,
  so: selection -> Konsole copies; no selection -> the key falls through to
  the app. Bind: Settings -> Configure Keyboard Shortcuts -> Copy -> press the
  hardware key (records as single key "Copy"; persisted as
  `konsolerc [Shortcuts] edit_copy=Copy`, Konsole-wide).
- **PASTE — do NOT bind to Konsole.** `edit_paste` is always enabled and
  always intercepts; binding it would shadow pi (text-only paste, image paste
  lost). For plain shells use a shell binding instead: fish (tested, below),
  bash (readline quoted keyseq + `bind -x` with wl-paste), zsh (a zle widget).
- **CUT / UNDO** — Konsole has no such actions; they stay keytab-only
  (bytes to the app).

### Fish binding for PASTE (pty-tested)

Requires the keytab from this directory to be selected in the Konsole
profile, so that pressing PASTE sends `ESC [ 118 ; 6 u` to fish.

Install: save one file, `~/.config/fish/conf.d/sofle-paste.fish`, with
exactly this content (fish loads `conf.d/*.fish` automatically; takes effect
in NEW shells only):

```fish
# Sofle PASTE key: insert clipboard text at cursor (kitty CSI-u from Konsole keytab)
bind \e\[118\;6u 'commandline -i (wl-paste -n --type text/plain)'
```

Escaping rules, all verified on fish 4.9.3 (Arch):

- Write the sequence UNQUOTED: `\e\[118\;6u`. fish tokenizes it as ONE
  sequence; `bind` lists it back as `bind \e\[118\;6u '...'` (a single
  binding, no per-character tokens).
- Never quote the sequence. fish processes escapes only OUTSIDE quotes
  (inside double quotes only `\\`, `\"`, `\$` are special), so
  `bind "\e[118;6u"`, `bind '\e[118;6u'` and `bind "\x1b[118;6u"` all fail
  with `bind: cannot parse key '\e[118;6u'`.
- The action must be `commandline -i` (insert at cursor). `commandline
  insert` is not an insert subcommand: its positional args REPLACE the whole
  command line. Tested: line `AA`, cursor moved left, paste `XX` → with
  `insert` the line became `insert\nXX` (typed `AA` destroyed); with `-i` it
  became `AXXA`.
- Empty clipboard: `(wl-paste -n ...)` expands to nothing and the key is a
  silent no-op. Multi-line clipboard text inserts verbatim, newlines kept.
- **Over SSH the binding is inert**: the remote shell cannot see the local
  clipboard (`wl-paste` has no Wayland session there). To paste over SSH use
  Konsole's own paste — `Ctrl+V` or `Shift+Insert` — which reads the local
  clipboard and writes the text through the pty. Works on any server, no
  remote setup.

Test proof (python3 pty harness, headless, fish 4.9.3): fish started with
`--no-config` in a pty, the binding installed, then the literal bytes
`\x1b[118;6u` written to the pty. The bound command fired; with `wl-paste`
replaced by a PATH stub that logs its arguments, the stub received exactly
`-n --type text/plain` and the stub text landed at the cursor. Normal typing
(`[;168uabc`) still reached the command line untouched, so the binding
does not swallow regular input. The COPY sequence `\x1b[99;6u` stayed
inert: no wl-paste call, nothing inserted, typing unaffected. The same
conf.d file passed end-to-end with a config-loading fish, and `fish -c`
(non-interactive) sources it without errors — no `status is-interactive`
guard needed.

COPY at the fish prompt: do NOT add a fish binding for `\e[99;6u`. At a
shell prompt the selection belongs to Konsole, not to the shell, so a shell
binding has nothing to copy. Hardware COPY there is the Konsole action
binding (Settings → Configure Keyboard Shortcuts → Copy, as described
above).
