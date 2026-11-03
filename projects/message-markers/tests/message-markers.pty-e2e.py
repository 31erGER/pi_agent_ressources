#!/usr/bin/env python3
"""Final end-to-end test: rail glyphs, alt+up/down jumping, clean /quit."""
import fcntl
import os
import pty
import re
import select
import struct
import sys
import termios
import time

ROWS, COLS = 14, 100
pi = "/home/julian/.pi/agent/bin/pi"
t0 = time.time()
results = {}

def log(msg):
    print(f"[{time.time() - t0:6.2f}] {msg}", flush=True)

def main():
    log("starting")
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.chdir("/tmp")
        os.execv(pi, [pi])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    raw = b""

    def read_chunk(t):
        nonlocal raw
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.1)
            if r:
                try:
                    d = os.read(fd, 65536)
                except OSError:
                    return False
                if not d:
                    return False
                raw += d
        return True

    def send(b):
        os.write(fd, b)
        log(f"send {b!r}")

    def wait_for(pred, timeout, what):
        end = time.time() + timeout
        while time.time() < end:
            if not read_chunk(0.2):
                log(f"FAIL: EOF while waiting for {what}")
                return False
            if pred(raw):
                log(f"ok: {what}")
                return True
        log(f"FAIL: timeout waiting for {what}")
        return False

    def check(name, cond):
        results[name] = cond
        log(f"{'PASS' if cond else 'FAIL'}: {name}")

    # 1. startup
    if not wait_for(lambda d: b"qwen" in d, 30, "startup banner"):
        return 1
    time.sleep(1.0)

    # 2. msg1 + response
    seg = len(raw)
    send(b"Jump test alpha\r")
    if not wait_for(lambda d: re.search(rb"\xe2\x86\x91 ?[\d,]+ in", d[seg:]), 120, "response to msg1"):
        return 1
    time.sleep(1.0)

    # 3. msg2 + response
    seg = len(raw)
    send(b"Jump test beta\r")
    if not wait_for(lambda d: re.search(rb"Jump test beta.{0,4000}\xe2\x86\x91 ?[\d,]+ in", d[seg:], re.S), 180, "response to msg2"):
        return 1
    time.sleep(1.5)

    # 4. rail glyphs written after msg2 (active marker + inactive dot).
    # Diff rendering only rewrites changed lines, so scan the whole msg2 phase.
    phase = raw[seg:]
    check("rail_active_glyph", b"\xe2\x96\xb8" in phase)
    check("rail_dot_glyph", b"\xc2\xb7" in phase)

    # 5. alt+up (pi encodes it as ESC p): jump from msg2 to msg1 ->
    #    "Jump test alpha" line rewritten (moves to top of viewport)
    seg = len(raw)
    send(b"\x1bp")
    read_chunk(2.5)
    after_up = raw[seg:]
    check("alt_up_jumps_to_prev", b"Jump test alpha" in after_up)

    # 6. alt+down (ESC n): jump back to msg2 -> "Jump test beta" at top
    seg = len(raw)
    send(b"\x1bn")
    read_chunk(2.5)
    after_down = raw[seg:]
    check("alt_down_jumps_to_next", b"Jump test beta" in after_down)

    # 7. clean quit (/quit exits directly, no confirmation)
    send(b"/quit\r")
    end = time.time() + 20
    exited = False
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.3)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                d = b""
            if not d:
                exited = True
                break
            raw += d
        try:
            p, st = os.waitpid(pid, os.WNOHANG)
            if p:
                exited = True
                log("process exited")
                break
        except ChildProcessError:
            exited = True
            break
    check("clean_exit", exited)

    with open("/tmp/message-markers-final.log", "wb") as fh:
        fh.write(raw)
    log(f"total_bytes={len(raw)}")
    log("SUMMARY: " + " ".join(f"{k}={'ok' if v else 'BAD'}" for k, v in results.items()))
    return 0 if all(results.values()) else 1

if __name__ == "__main__":
    sys.exit(main())
