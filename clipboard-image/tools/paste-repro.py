#!/usr/bin/env python3
"""paste-repro.py — pty repro for the deferred-paste defect in pi / Pi-Bolt.

VERDICT (2026-10-31, Pi-Bolt 1.0.7 / pi 1.4.0 AOT bundle at ~/.cache):
  DEFERRED  the extension smart-paste path: keytab bytes \x1b[118;6u
            (Konsole hardware PASTE key) -> pi-image smartPaste ->
            ctx.ui.pasteToEditor(text) -> editor insert with NO render
            request. The text sits unpainted until the NEXT input event.
  IMMEDIATE the terminal bracketed-paste path \x1b[200~text\x1b[201~ through
            the whole stack (every matrix row below); real Konsole also
            paints those frames instantly (Xvfb test, bridge in RESEARCH.md).

Root cause: packages/coding-agent/src/modes/interactive/interactive-mode.ts
line 2655 — `pasteToEditor: (text) => this.editor.handleInput(...)` has no
requestRender, unlike the built-in handleClipboardPaste (line 3124). The
async shortcut handler aggravates it: pi's requestImmediateRender() fires at
handleInput return, i.e. BEFORE the awaited clipboard read finishes, so even
the one render pi does request races ahead of the insert.

Spawns the REAL pi binary in a pty (no model calls: --no-session --offline
--no-mcp), injects input exactly as the terminal would, and watches pi's
OUTPUT with timestamps:

  IMMEDIATE  the pasted text is echoed while we are still waiting (before any
             further input)
  DEFERRED   the echo appears only after we inject a wake key (`x`)

Each case writes a raw capture to /tmp/pi-repro/<case>.log with per-chunk
timestamps for post-mortem analysis. When tools/inputlog-ext/index.ts exists
it is loaded via `-e`, so pi's received input stream is logged to
/tmp/pi-repro/pi-input.log — evidence that the paste chunk arrives instantly
and complete, and that pi simply renders nothing for it.

Usage:
    python3 tools/paste-repro.py              # run the full matrix
    python3 tools/paste-repro.py full noext   # run named cases only
    python3 tools/paste-repro.py content      # paste-shape variants + smart
    python3 tools/paste-repro.py smart-ab     # the user-observable A/B
"""
import fcntl
import os
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

REPRO_DIR = "/tmp/pi-repro"
BOLT_COMPILED = os.path.expanduser("~/.cache/pibolt-compiled/pi")
BOLT_PACKAGED = "/usr/lib/pi-bolt/pi"
PI_NODE = "/usr/bin/pi"
INPUTLOG_EXT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "inputlog-ext", "index.ts")
MINREPRO_EXT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "minrepro-ext", "index.ts")

# Flags that keep the run offline and prompt-free.
BASE_FLAGS = ["--no-session", "--offline", "--no-mcp", "-na"]


def pi_flags(extra=()):
    """BASE_FLAGS + the input-logger extension (if present) + extras."""
    flags = list(BASE_FLAGS)
    if os.path.isfile(INPUTLOG_EXT):
        flags += ["-e", INPUTLOG_EXT]
    flags += list(extra)
    return flags

MARKER1 = "QZ7K1"  # first bracketed paste
MARKER2 = "QZ7K2"  # second bracketed paste (double-paste case)
MARKERP = "QZ7KP"  # plain bytes, no paste wrappers
WAKE_KEY = "x"

ANSI_RE = re.compile(
    rb"\x1b\[[0-9;?<>=! /:.]*[@-~]"          # CSI
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?"  # OSC
    rb"|\x1b[PX^_][^\x1b]*(?:\x1b\\)?"       # DCS / SOS / PM / APC
    rb"|\x1b[()][0-9A-B]"                    # charset
    rb"|\x1b[=>78cMnOl]"                     # misc two-byte
)


def strip_ansi(b: bytes) -> bytes:
    return ANSI_RE.sub(b"", b)


class Capture:
    def __init__(self, path):
        self.path = path
        self.chunks = []  # (t_rel_monotonic, raw bytes) relative to capture start
        self.file = open(path, "wb")

    def add(self, t, data):
        self.chunks.append((t, data))
        self.file.write(f"[{t*1000:9.2f} ms] ".encode() + data.hex().encode() + b"\n")
        self.file.flush()

    def first_seen(self, marker: bytes, t_since: float):
        """Earliest time >= t_since at which marker appears in ANSI-stripped
        cumulative output. Returns absolute capture-relative time or None."""
        acc = b""
        for t, data in self.chunks:
            acc += strip_ansi(data)
            if marker in acc and t >= t_since - 1e-9:
                return t
        return None


def spawn(cmd, env_extra=None, winsize=(30, 100)):
    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env.pop("TERM_PROGRAM", None)
    env.pop("KITTY_WINDOW_ID", None)
    env.pop("KITTY_PID", None)
    if env_extra:
        env.update(env_extra)
    master, slave = os.openpty()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", winsize[0], winsize[1], 0, 0))
    errpath = os.path.join(REPRO_DIR, "stderr-tmp.txt")
    p = subprocess.Popen(
        cmd,
        stdin=slave,
        stdout=slave,
        stderr=open(errpath, "wb"),
        start_new_session=True,
        env=env,
        close_fds=True,
    )
    os.close(slave)
    return p, master


def drain_and_kill(p, master):
    try:
        if p.poll() is None:
            os.killpg(os.getpgid(p.pid), signal.SIGTERM)
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and p.poll() is None:
            r, _, _ = select.select([master], [], [], 0.05)
            if r:
                try:
                    if not os.read(master, 65536):
                        break
                except OSError:
                    break
        if p.poll() is None:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        p.wait(timeout=3)
    except (ProcessLookupError, OSError):
        pass
    finally:
        try:
            os.close(master)
        except OSError:
            pass


def wait_quiet(master, cap, max_wait=20.0, quiet_for=0.8):
    """Wait until the TUI has painted and output goes quiet."""
    t0 = time.monotonic()
    last = t0
    total = 0
    while time.monotonic() - t0 < max_wait:
        r, _, _ = select.select([master], [], [], 0.05)
        if r:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            now = time.monotonic()
            cap.add(now - cap.t0, data)
            total += len(data)
            last = now
        elif time.monotonic() - last > quiet_for and total > 0:
            return time.monotonic() - cap.t0
    return time.monotonic() - cap.t0


def run_case(name, cmd, env_extra=None, kitty_reply=False, double_paste=False,
             plain_too=False, paste_delay=2.5, wake_delay=1.5, custom_paste=None,
             marker=None, paste_at=None):
    print(f"\n=== case: {name} ===")
    print(f"  cmd: {' '.join(cmd[:2])} {' '.join(cmd[2:])}")
    os.makedirs(REPRO_DIR, exist_ok=True)
    log_path = os.path.join(REPRO_DIR, f"{name}.log")
    cap = Capture(log_path)
    cap.t0 = time.monotonic()

    p, master = spawn(cmd, env_extra)
    start_t = wait_quiet(master, cap)
    if p.poll() is not None:
        print(f"  PROCESS EXITED EARLY rc={p.returncode} — see {log_path}")
        drain_and_kill(p, master)
        return
    print(f"  startup paint: {start_t*1000:.0f} ms, {sum(len(d) for _, d in cap.chunks)} bytes")

    events = []  # (time_to_write, label, payload, marker)
    if kitty_reply:
        events.append((start_t + 0.3, "kitty-flags-reply", b"\x1b[?7u", None))
    ev_t = start_t + (paste_at if paste_at is not None else 0.5)
    paste_payload = custom_paste if custom_paste is not None else \
        b"\x1b[200~" + MARKER1.encode() + b"\x1b[201~"
    marker1 = marker if marker is not None else MARKER1.encode()
    events.append((ev_t, "paste1", paste_payload, marker1))
    if double_paste:
        events.append((ev_t + paste_delay, "paste2", b"\x1b[200~" + MARKER2.encode() + b"\x1b[201~", MARKER2.encode()))
        ev_t += paste_delay
    if plain_too:
        events.append((ev_t + paste_delay, "plain", MARKERP.encode(), MARKERP.encode()))
        ev_t += paste_delay
    events.append((ev_t + paste_delay, "wake-key", WAKE_KEY.encode(), None))

    for t, label, payload, marker in events:
        # sleep until scheduled time, capturing output meanwhile
        while time.monotonic() - cap.t0 < t:
            r, _, _ = select.select([master], [], [], 0.02)
            if r:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                cap.add(time.monotonic() - cap.t0, data)
        if p.poll() is not None:
            print(f"  PROCESS EXITED EARLY during {label} rc={p.returncode}")
            break
        w_t = time.monotonic() - cap.t0
        os.write(master, payload)
        cap.add(w_t, b"<<INJECT:" + payload + b">>")
        if marker:
            seen = cap.first_seen(marker, w_t)
            if seen is None:
                print(f"  {label:18s} -> marker {marker.decode()} NOT echoed within window")
            else:
                print(f"  {label:18s} -> marker echoed at +{(seen - w_t)*1000:7.1f} ms"
                      f"  ({'IMMEDIATE' if seen - w_t < 0.15 else 'DEFERRED'})")
        else:
            print(f"  {label:18s} -> injected {payload!r}")

    # final drain
    end_t = time.monotonic() - cap.t0 + wake_delay
    while time.monotonic() - cap.t0 < end_t:
        r, _, _ = select.select([master], [], [], 0.02)
        if r:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            cap.add(time.monotonic() - cap.t0, data)

    # was the marker ever on screen after the wake key?
    for marker in tuple({marker1, MARKER2.encode(), MARKERP.encode()}):
        seen = cap.first_seen(marker, 0)
        if seen is not None:
            print(f"  final screen: {marker.decode()} appeared at +{seen*1000:.0f} ms overall")
    print(f"  capture: {log_path}")
    drain_and_kill(p, master)


SYSTEMD_WRAP = [
    "systemd-run", "--user", "--pty", "--collect", "--quiet",
    "--property=WorkingDirectory=/tmp/pi-repro",
    "--property=ProtectSystem=strict",
    "--property=ProtectHome=read-only",
    "--property=ReadWritePaths=" + os.path.expanduser("~/.pi"),
    "--property=ReadWritePaths=/tmp",
    "--property=NoNewPrivileges=yes",
    "--property=ProtectKernelTunables=yes",
    "--property=ProtectKernelModules=yes",
    "--property=ProtectControlGroups=yes",
    "--property=ProtectClock=yes",
    "--property=ProtectHostname=yes",
    "--property=RestrictSUIDSGID=yes",
    "--property=RestrictNamespaces=yes",
    "--property=LockPersonality=yes",
    "--setenv=TERM=xterm-256color",
    "--setenv=COLORTERM=truecolor",
    "--setenv=HOME=" + os.path.expanduser("~"),
]


def ensure_stub():
    """A wl-paste stub so smart-paste rows are deterministic and hermetic."""
    stub_dir = os.path.join(REPRO_DIR, "stub")
    os.makedirs(stub_dir, exist_ok=True)
    stub = os.path.join(stub_dir, "wl-paste")
    if not os.path.exists(stub):
        with open(stub, "w") as f:
            f.write("#!/bin/bash\n"
                    "# stub wl-paste: no image types, fixed text payload\n"
                    'if [ "$1" = "--list-types" ]; then exit 0; fi\n'
                    "printf 'QZ7KSMART'\n")
        os.chmod(stub, 0o755)
    return stub_dir


def smart_env():
    envd = dict(os.environ)
    envd.pop("DISPLAY", None)
    envd["PATH"] = ensure_stub() + ":" + envd["PATH"]
    envd["WAYLAND_DISPLAY"] = "wayland-stub"
    return envd


def run_content_cases():
    """Paste shape variants against the full live-like config."""
    big = ("LOREM-" * 260)[:2000]  # 2000 bytes, single line
    multiline = "line-one\rline-two\rline-three QZ7KM"  # Konsole converts \n to \r
    run_case("large", [BOLT_COMPILED] + pi_flags(), custom_paste=b"\x1b[200~" + big.encode() + b"\x1b[201~",
             marker=big[:6].encode())
    run_case("multiline", [BOLT_COMPILED] + pi_flags(), custom_paste=b"\x1b[200~" + multiline.encode() + b"\x1b[201~",
             marker=b"QZ7KM")
    run_case("trailrel", [BOLT_COMPILED] + pi_flags(), kitty_reply=True,
             custom_paste=b"\x1b[200~QZ7KT\x1b[201~\x1b[27;1;65u", marker=b"QZ7KT")
    run_case("burst", [BOLT_COMPILED] + pi_flags(),
             custom_paste=b"\x1b[200~QZ7KB\x1b[201~\x1b[200~QZ7KC\x1b[201~\x1b[200~QZ7KD\x1b[201~",
             marker=b"QZ7KD")
    run_case("late", [BOLT_COMPILED] + pi_flags(), paste_at=6.0, marker=b"QZ7K1")
    # smart-paste path: hardware PASTE key via Konsole keytab sends ESC[118;6u
    # (ctrl+shift+v) -> pi-image smartPaste -> ctx.ui.pasteToEditor. Stub
    # wl-paste so the clipboard payload is deterministic and hermetic.
    stub_env = {
        "PATH": "/tmp/pi-repro/stub:" + os.environ["PATH"],
        "WAYLAND_DISPLAY": "wayland-stub",
    }
    envd = dict(os.environ); envd.pop("DISPLAY", None)
    envd.update(stub_env)
    run_case("smart-keytab", [BOLT_COMPILED] + pi_flags(), env_extra=envd,
             custom_paste=b"\x1b[118;6u", marker=b"QZ7KSMART")
    run_case("smart-kitty", [BOLT_COMPILED] + pi_flags(), env_extra=dict(smart_env()),
             kitty_reply=True, custom_paste=b"\x1b[118;6u", marker=b"QZ7KSMART")
    # minimal CORE repro (no pi-image): a 10-line extension inserts text via
    # ctx.ui.pasteToEditor on ctrl+o — same deferral, proving the hole is in
    # pi's pasteToEditor API, not in pi-image.
    run_case("core-min", [BOLT_COMPILED] + pi_flags(["-e", MINREPRO_EXT]),
             custom_paste=b"\x1bo", marker=b"QZMIN")


def run_smart_vs_bracketed():
    """The user-observable contrast in ONE session: the keytab smart paste
    defers, then a terminal bracketed paste renders instantly — and flushes
    the still-unpainted smart-paste text with it ("screen one event behind")."""
    envd = smart_env()
    os.makedirs(REPRO_DIR, exist_ok=True)
    log_path = os.path.join(REPRO_DIR, "smart-vs-bracketed.log")
    cap = Capture(log_path)
    cap.t0 = time.monotonic()
    p, master = spawn([BOLT_COMPILED] + pi_flags(), envd)
    start_t = wait_quiet(master, cap)
    if p.poll() is not None:
        print(f"  PROCESS EXITED EARLY rc={p.returncode}")
        drain_and_kill(p, master)
        return
    t_smart = start_t + 0.5
    t_bracket = t_smart + 2.5
    t_wake = t_bracket + 2.5
    for t, label, payload in (
        (t_smart, "smart-paste (keytab ctrl+shift+v)", b"\x1b[118;6u"),
        (t_bracket, "bracketed paste (terminal paste)", b"\x1b[200~QZ7KB\x1b[201~"),
        (t_wake, "wake-key", b"x"),
    ):
        while time.monotonic() - cap.t0 < t:
            r, _, _ = select.select([master], [], [], 0.02)
            if r:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                cap.add(time.monotonic() - cap.t0, data)
        if p.poll() is not None:
            break
        w_t = time.monotonic() - cap.t0
        os.write(master, payload)
        cap.add(w_t, b"<<INJECT:" + payload + b">>")
        print(f"  injected {label} at +{w_t:.2f}s")
    for marker in (b"QZ7KSMART", b"QZ7KB"):
        seen = cap.first_seen(marker, 0)
        if seen is None:
            print(f"  {marker.decode()}: NEVER rendered")
        else:
            print(f"  {marker.decode()}: first rendered at +{seen:.2f}s overall")
    print(f"  capture: {log_path}")
    drain_and_kill(p, master)


def main():
    os.makedirs(REPRO_DIR, exist_ok=True)
    cases = {
        # a. Pi-Bolt compiled binary, extensions on (live-like)
        "full": dict(cmd=[BOLT_COMPILED] + BASE_FLAGS),
        # b. extensions disabled
        "noext": dict(cmd=[BOLT_COMPILED] + BASE_FLAGS + ["--no-extensions"]),
        # c. kitty keyboard protocol reply (Konsole replies live; pty does not by default)
        "kitty": dict(cmd=[BOLT_COMPILED] + BASE_FLAGS, kitty_reply=True),
        # d. regular-mode TUI (TuiMainScreen instead of TuiAltScreen)
        "regular": dict(cmd=[BOLT_COMPILED] + BASE_FLAGS + ["--tui-mode", "regular"]),
        # A/B: bracketed paste vs plain bytes in one run
        "ab-plain": dict(cmd=[BOLT_COMPILED] + BASE_FLAGS, plain_too=True),
        # double paste (the user's "one event behind" pattern)
        "double": dict(cmd=[BOLT_COMPILED] + BASE_FLAGS, double_paste=True),
        # node runtime comparison
        "node": dict(cmd=[PI_NODE] + BASE_FLAGS),
        # sandboxed like the fish launcher
        "systemd": dict(cmd=SYSTEMD_WRAP + [BOLT_COMPILED] + BASE_FLAGS),
    }
    wanted = sys.argv[1:] or list(cases)
    if wanted == ["content"]:
        run_content_cases()
        return
    if wanted == ["smart-ab"]:
        run_smart_vs_bracketed()
        return
    for name in wanted:
        if name not in cases:
            print(f"unknown case {name}", file=sys.stderr)
            continue
        try:
            run_case(name, **cases[name])
        except Exception as e:  # keep the matrix going
            print(f"  case {name} FAILED: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
