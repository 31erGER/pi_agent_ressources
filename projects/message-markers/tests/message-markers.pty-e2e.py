#!/usr/bin/env python3
"""PTY end-to-end test for the message-markers extension (visual rail + click jump).

Runs real pi sessions in a pseudo-terminal (100x14) with the extension loaded:

  session 0: build a 4-message fixture session (needed for the resume check)
  session 1: fresh session — send 2 messages, verify:
      * one dot per user message, rail at column 96 (3 columns left of the
        right edge, i.e. the "20px" gap), 1 row per dot ("15px" spacing)
      * rail block vertically centered
      * alt+up jumps to the previous message
      * SGR mouse click on the other dot jumps to that message
      * clean /quit
  session 2: resume the fixture session — expect 4 markers (3 dots + 1 active)
      for messages that predate extension activation, with no new input.

Screen verification uses a minimal terminal emulator (grid + cursor tracking)
fed with the raw PTY output; rail glyphs are detected at their exact column.

MM_DEBUG=1 prints reconstructed screens at checkpoints.
Run:  cd /tmp && python3 .../message-markers.pty-e2e.py
"""
import fcntl
import glob
import os
import pty
import re
import select
import shutil
import signal
import struct
import sys
import termios
import time

COLS, ROWS = 100, 14
EXT = "/home/julian/.pi/agent/extensions"
FIXTURE_SESSION = "/tmp/message-markers-fixture-session.jsonl"
DOT = "\u00b7"
ARROW = "\u25b8"
ELLIPSIS = "\u2026"

t0 = time.time()
results = {}


def log(msg):
    print(f"[{time.time() - t0:6.2f}] {msg}", flush=True)


def dump_screen(tag, scr):
    if os.environ.get("MM_DEBUG") != "1":
        return
    log(f"--- screen {tag} ---")
    for i, line in enumerate(scr.visible()):
        log(f"  {i:2d}|{line.rstrip()}|")


def counter_in_tokens(raw_bytes):
    """The '↑ N in' input-token counter from the status bar (0 until a turn ends)."""
    vals = re.findall(rb"\xe2\x86\x91 ([1-9][\d,]*) in", raw_bytes)
    return int(vals[-1].replace(b",", b"")) if vals else 0


# -----------------------------------------------------------------------------
# Minimal terminal emulator: grid + cursor + the CSI/ESC/OSC ops that matter.
# -----------------------------------------------------------------------------

class Screen:
    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.grid = [[" "] * cols for _ in range(rows)]
        self.y = 0
        self.x = 0
        self.state = "normal"  # normal | esc | csi | osc
        self.buf = b""
        self.sgr_params = {}

    def feed(self, text):
        for ch in text:
            self.step(ch)

    def step(self, ch):
        o = ord(ch)
        if self.state == "esc":
            if ch == "[":
                self.state, self.buf = "csi", ""
            elif ch == "]":
                self.state, self.buf = "osc", ""
            elif ch == "==":
                pass  # KVT
            else:
                self.state = "normal"  # consume other escapes (final byte)
            return
        if self.state == "osc":
            if ch == "\x07" or ch == "\x1b":
                self.state = "normal"
            return
        if self.state == "csi":
            if 0x30 <= o <= 0x3F or o == 0x3A:
                self.buf += ch
                return
            if 0x40 <= o <= 0x7E:
                self.csi(ch)
                self.state = "normal"
                return
            return
        # normal
        if ch == "\x1b":
            self.state = "esc"
            return
        if ch == "\r":
            self.x = 0
        elif ch == "\n" or ch == "\x0b" or ch == "\x0c":
            self.y += 1
            if self.y >= self.rows:
                self.scroll()
        elif ch == "\x08":
            self.x = max(0, self.x - 1)
        elif ch == "\t":
            self.x = min(self.cols - 1, (self.x // 8 + 1) * 8)
        elif o >= 0x20:
            self.put(ch)
            self.x = min(self.cols, self.x + 1)
            if self.x == self.cols:
                self.x = 0
                self.y += 1
                if self.y >= self.rows:
                    self.scroll()

    def scroll(self):
        del self.grid[0]
        self.grid.append([" "] * self.cols)

    def put(self, ch):
        self.grid[self.y][self.x] = ch

    def csi(self, final):
        body = self.buf
        if body and body[0] == "?":
            body = body[1:]  # private mode marker: ignore for our purposes
        vals = [int(p) if p.isdigit() else 0 for p in body.split(";")]
        if final == "H":
            y = vals[0] if len(vals) > 0 and vals[0] else 1
            x = vals[1] if len(vals) > 1 and vals[1] else 1
            self.y, self.x = max(0, y - 1), max(0, x - 1)
        elif final == "d":
            self.y = max(0, (vals[0] if vals else 1) - 1)
        elif final == "G":
            self.x = max(0, (vals[0] if vals else 1) - 1)
        elif final == "A":
            self.y = max(0, self.y - (vals[0] or 1))
        elif final == "B":
            self.y = min(self.rows - 1, self.y + (vals[0] or 1))
        elif final == "C":
            self.x = min(self.cols - 1, self.x + (vals[0] or 1))
        elif final == "D":
            self.x = max(0, self.x - (vals[0] or 1))
        elif final == "J":
            n = vals[0] if vals else 0
            if n == 2 or n == 3:
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
                self.x = self.y = 0
            elif n == 0:
                for cx in range(self.x, self.cols):
                    self.grid[self.y][cx] = " "
                for cy in range(self.y + 1, self.rows):
                    self.grid[cy] = [" "] * self.cols
            elif n == 1:
                for cx in range(0, self.x + 1):
                    self.grid[self.y][cx] = " "
                for cy in range(0, self.y):
                    self.grid[cy] = [" "] * self.cols
        elif final == "K":
            n = vals[0] if vals else 0
            if n == 0:
                for cx in range(self.x, self.cols):
                    self.grid[self.y][cx] = " "
            elif n == 1:
                for cx in range(0, self.x + 1):
                    self.grid[self.y][cx] = " "
            elif n == 2:
                for cx in range(self.cols):
                    self.grid[self.y][cx] = " "
        elif final == "L":
            n = vals[0] if vals else 1
            for _ in range(n):
                del self.grid[self.y:]
                self.grid += [[" "] * self.cols for _ in range(n)]
        elif final == "M":
            n = vals[0] if vals else 1
            for _ in range(n):
                del self.grid[self.y:self.y + n]
                self.grid = [[" "] * self.cols for _ in range(n)] + self.grid
        elif final == "m":
            pass  # SGR: appearance only; grid stores visible chars

    def visible(self):
        return ["".join(r) for r in self.grid]


# -----------------------------------------------------------------------------
# Rail detection.
# -----------------------------------------------------------------------------

def rail_cells(screen):
    """Screen rows whose column 96 (0-based) holds a rail glyph."""
    dots, actives, ellipses = [], [], []
    for i, line in enumerate(screen.visible()):
        if len(line) > 96:
            if line[96] == DOT:
                dots.append(i)
            elif line[96] == ARROW:
                actives.append(i)
            elif line[96] == ELLIPSIS:
                ellipses.append(i)
    return dots, actives, ellipses


def top_message(scr):
    for line in scr.visible():
        if "Jump test" in line or "Resume fixture" in line:
            return line
    return ""


# -----------------------------------------------------------------------------
# PTY harness.
# -----------------------------------------------------------------------------

def run_session(args, body, log_path, env_extra=None):
    pid, master = pty.fork()
    if pid == 0:
        os.chdir("/tmp")  # session files are keyed to the working directory
        os.environ["TERM"] = "xterm-256color"
        if env_extra:
            os.environ.update(env_extra)
        elif "MESSAGE_MARKERS_DEBUG" in os.environ:
            os.environ.pop("MESSAGE_MARKERS_DEBUG")
        pi = shutil.which("pi")
        os.execve(pi, [pi] + args, dict(os.environ))
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    logf = open(log_path, "wb")
    state = {"buf": b""}

    def raw():
        return state["buf"]

    def read(seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([master], [], [], 0.1)
            if r:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                state["buf"] += chunk
                logf.write(chunk)
        return state["buf"]

    def wait(pred, timeout, what):
        end = time.time() + timeout
        while time.time() < end:
            if pred(state["buf"]):
                log(f"ok: {what}")
                return True
            read(0.2)
        log(f"FAIL: timeout waiting for {what}")
        return False

    def send(data):
        log(f"send {data!r}")
        os.write(master, data)

    def check(name, ok):
        results[name] = ok
        log(("PASS: " if ok else "FAIL: ") + name + (" " if ok else " (bad)"))

    def wait_counter_above(baseline, timeout, what):
        end = time.time() + timeout
        while time.time() < end:
            read(0.2)
            if counter_in_tokens(state["buf"]) > baseline:
                log(f"ok: {what}")
                return True
        log(f"FAIL: timeout waiting for {what}")
        return False

    ctx = {
        "wait": wait,
        "check": check,
        "read": read,
        "send": send,
        "raw": raw,
        "wait_counter_above": wait_counter_above,
    }
    try:
        body(ctx)
    finally:
        try:
            send(b"/quit\r")
            read(3.0)
            time.sleep(0.5)
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
            for _ in range(20):
                p, status = os.waitpid(pid, os.WNOHANG)
                if p != 0:
                    break
                time.sleep(0.25)
            else:
                try:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                except OSError:
                    pass
        except OSError:
            pass
        try:
            os.close(master)
        except OSError:
            pass
        logf.close()
        check("clean_exit", b"pi --session" in state["buf"])
        log(f"session log: {log_path} ({len(state['buf'])} bytes)")


# -----------------------------------------------------------------------------
# Session bodies.
# -----------------------------------------------------------------------------

def fixture(ctx):
    """Build a 4-message fixture session for the resume test."""
    wait, send, raw = ctx["wait"], ctx["send"], ctx["raw"]
    wait(lambda d: b"What's up" in d or b"type /help" in d or b"pi" in d, 60, "startup banner")
    time.sleep(1.0)
    for i in range(1, 5):
        send(f"Resume fixture {i} (reply OK)\r".encode())
        if not ctx["wait_counter_above"](counter_in_tokens(raw()), 90, f"response to fixture msg {i}"):
            return
        time.sleep(0.5)


def fresh(ctx):
    wait, check, read, send = ctx["wait"], ctx["check"], ctx["read"], ctx["send"]
    raw, wait_counter_above = ctx["raw"], ctx["wait_counter_above"]
    wait(lambda d: b"What's up" in d or b"type /help" in d or b"pi" in d, 60, "startup banner")
    time.sleep(1.0)
    # msg1 + response (wait until the input-token counter becomes non-zero)
    send(b"Jump test alpha\r")
    if not wait_counter_above(0, 120, "response to msg1"):
        return
    time.sleep(1.0)
    # msg2 + response (counter must grow again)
    base = counter_in_tokens(raw())
    send(b"Jump test beta\r")
    if not wait_counter_above(base, 180, "response to msg2"):
        return
    time.sleep(1.5)

    # Poll for the rail: the second user-message component can still be in
    # the queue (not yet in the rendered tree) when the counter ticked.
    dots, actives, scr = [], [], None
    end = time.time() + 10
    while time.time() < end:
        read(0.5)
        scr = Screen(ROWS, COLS)
        scr.feed(raw().decode("utf-8", "replace"))
        dots, actives, _ = rail_cells(scr)
        if len(dots) == 1 and len(actives) == 1:
            break
    dump_screen("after msg2", scr)
    check("rail_has_dot_and_active", len(dots) == 1 and len(actives) == 1)
    # independent column check: the only '▸ ' in the UI is the active rail mark
    arrow_lines = [l.find(ARROW + " ") for l in scr.visible() if l.find(ARROW + " ") >= 0]
    check(
        "rail_glyph_at_col_96",
        arrow_lines == [96] and all(scr.visible()[i][96] == DOT for i in dots) if dots else arrow_lines == [96],
    )
    check(
        "rail_vertically_centered",
        bool(dots + actives) and 0 < min(dots + actives) and max(dots + actives) < ROWS - 2,
    )

    # alt+up (pi encodes it as ESC p): jump from msg2 to msg1
    send(b"\x1bp")
    read(2.5)
    scr = Screen(ROWS, COLS)
    scr.feed(raw().decode("utf-8", "replace"))
    dump_screen("after alt+up", scr)
    check("alt_up_jumps_to_prev", "Jump test alpha" in top_message(scr))

    # click the inactive dot (msg2's dot) → jump to msg2.
    # The rail is a centered mini-map; between reading the screen and the
    # click a re-layout may move the block, so re-read the dot position
    # and retry a few times.
    clicked = False
    for attempt in range(4):
        scr = Screen(ROWS, COLS)
        scr.feed(raw().decode("utf-8", "replace"))
        if attempt > 0:
            dump_screen(f"retry {attempt}", scr)
        dots, _, _ = rail_cells(scr)
        if not dots:
            read(1.0)
            continue
        x, y = 97, dots[0] + 1  # SGR coords are 1-based: col 96→97
        log(f"clicking dot at screen ({x - 1}, {y - 1}) attempt {attempt + 1}")
        send(f"\x1b[<0;{x};{y}M".encode())  # press left
        time.sleep(0.3)
        send(f"\x1b[<0;{x};{y}m".encode())  # release left → click
        read(3.0)
        scr = Screen(ROWS, COLS)
        scr.feed(raw().decode("utf-8", "replace"))
        dump_screen(f"after click {attempt + 1}", scr)
        if "Jump test beta" in top_message(scr):
            clicked = True
            break
    check("click_dot_jumps_to_next", clicked)


def resume(ctx, session_path):
    check, read = ctx["check"], ctx["read"]
    raw = ctx["raw"]
    # Resuming takes a while; poll the reconstructed screen until the rail
    # with 4 markers (3 dots + active) appears.
    dots, actives, ellipses, scr = [], [], [], None
    end = time.time() + 120
    while time.time() < end:
        read(1.0)
        scr = Screen(ROWS, COLS)
        scr.feed(raw().decode("utf-8", "replace"))
        dots, actives, ellipses = rail_cells(scr)
        if len(dots) + len(actives) == 4:
            log("resumed rail visible")
            break
    dump_screen("resumed", scr)
    check("resume_shows_4_markers", len(dots) + len(actives) == 4)
    check("resume_active_is_last", len(actives) == 1 and len(dots) == 3)


def main():
    log(f"terminal {COLS}x{ROWS}, extensions in {EXT}")
    ext = os.path.join(EXT, "message-markers.ts")
    if not os.path.exists(ext):
        log("FAIL: extension file missing")
        return 1

    # session 0: build the fixture
    run_session([], fixture, "/tmp/message-markers-fixture.log")
    fixture_files = sorted(glob.glob("/home/julian/.pi/agent/sessions/--tmp--/*.jsonl"), key=os.path.getmtime)
    fixture_path = None
    for f in reversed(fixture_files):
        try:
            content = open(f, "rb").read().decode("utf-8", "replace")
        except OSError:
            continue
        if "Resume fixture 4" in content and "Resume fixture 1" in content:
            fixture_path = f
            break
    if not fixture_path:
        log("FAIL: fixture session file not found")
        results["fixture_built"] = False
        return 1
    results["fixture_built"] = True
    log(f"fixture session: {fixture_path}")

    # session 1: fresh (with opt-in debug logging to diagnose rail geometry)
    run_session(
        [],
        fresh,
        "/tmp/message-markers-final.log",
        env_extra={"MESSAGE_MARKERS_DEBUG": "/tmp/message-markers-debug-final.log"},
    )

    # session 2: resume the fixture
    run_session(["--session", fixture_path], lambda ctx: resume(ctx, fixture_path), "/tmp/message-markers-resume.log")

    log("SUMMARY: " + " ".join(f"{k}={'ok' if v else 'BAD'}" for k, v in results.items()))
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
