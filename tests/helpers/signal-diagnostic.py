#!/usr/bin/env python3
"""Fixture for the terminal-signal-forwarding test (see
tests/helpers/pty-signal-harness.py). Registers handlers for the signals
--new-session detaches the sandboxed process from, logs each one, and —
deliberately — does not exit on SIGINT/SIGQUIT/SIGTSTP, so the test can
observe scoder's own double-Ctrl-C force-kill rather than the diagnostic's
own reaction to a single one.

Usage: signal-diagnostic.py LOGFILE
"""
import os
import signal
import sys
import time

logfile = sys.argv[1]


def log(msg):
    with open(logfile, "a") as f:
        f.write(msg + "\n")
        f.flush()


def handler(name):
    def h(signum, frame):
        log(f"{name} at {time.time()}")

    return h


for sig, name in [
    (signal.SIGWINCH, "WINCH"),
    (signal.SIGINT, "INT"),
    (signal.SIGTSTP, "TSTP"),
    (signal.SIGQUIT, "QUIT"),
]:
    signal.signal(sig, handler(name))

log(f"started pid={os.getpid()}")
for _ in range(100):
    time.sleep(0.1)
log("exited naturally (test should have force-killed before this)")
