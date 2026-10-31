#!/usr/bin/env python3
"""Capture raw terminal input with timestamps, mimicking pi's terminal setup.

Run in the SAME Konsole profile where the hardware-key behavior misbehaves:
    python3 ~/GitHub/pi-image/tools/input-capture.py [--no-kitty]

Then: press hardware PASTE (with text copied), wait 2s, press a letter,
wait 2s, press hardware PASTE again, wait, then press Ctrl+C to exit.
Every input chunk is logged as: ms since previous chunk, byte count, hex.
Pass --no-kitty to skip pushing kitty keyboard flags (bracketed paste stays on).
"""
import os
import select
import sys
import termios
import time
import tty

kitty = "--no-kitty" not in sys.argv

out = sys.stdout.buffer


def w(b: bytes) -> None:
    out.write(b)
    out.flush()


w(b"\x1b[?2004h")  # bracketed paste ON (pi enables this)
if kitty:
    w(b"\x1b[>7u")  # kitty keyboard flags 7 (what pi pushes)
w(b"\r\n=== input capture ready (kitty flags: " + (b"ON" if kitty else b"OFF") + b") ===\r\n")
w(b"press hardware PASTE, wait, press a letter, wait, paste again, then Ctrl+C\r\n\r\n")

old = termios.tcgetattr(0)
tty.setraw(0)
last = time.monotonic()
try:
    while True:
        r, _, _ = select.select([0], [], [], 0.5)
        if not r:
            continue
        data = os.read(0, 65536)
        now = time.monotonic()
        w(f"\r\n[{(now - last) * 1000:8.1f} ms since previous] {len(data):4d} bytes: {data.hex(' ')}\r\n".encode())
        w(f"    repr: {data!r}\r\n".encode())
        last = now
        if b"\x03" in data:  # Ctrl+C ends capture
            w(b"\r\n=== exit ===\r\n")
            break
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, old)
    if kitty:
        w(b"\x1b[<u")  # pop kitty flags
    w(b"\x1b[?2004l")  # bracketed paste off
