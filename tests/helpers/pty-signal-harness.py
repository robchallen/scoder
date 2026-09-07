#!/usr/bin/env python3
"""Runs a command under a real PTY, as its controlling terminal, in a
process group separate from a session leader that ignores SIGINT/SIGQUIT/
SIGTSTP the way a real interactive shell does — then exercises the exact
sequence terminal-signals-not-forwarded-to-sandbox.md's fix depends on:
a resize (TIOCSWINSZ, the same mechanism a terminal uses), one Ctrl-C, and
a second Ctrl-C shortly after.

Exists because Bun/Node have no first-party PTY allocation, and this
specific bug is only observable with a real controlling-terminal
relationship in place — a plain Bun.spawn (pipes, no tty) cannot reproduce
it. See design/implementation/issues/terminal-signals-not-forwarded-to-sandbox.md
for how this was used during the investigation itself.

Usage:
  pty-signal-harness.py --logfile PATH --cwd DIR -- CMD [ARGS...]

Protocol against --logfile (the command under test must write these):
  a line containing "started"      -- ready; the harness starts sending signals
  a line containing "WINCH"        -- the resize was received
  a line containing "INT"          -- the first Ctrl-C was received
  a line containing "exited"       -- the command exited on its own

Exit code 0 and a final line of exactly PASS if every step succeeded;
otherwise exit 1 and a line starting with FAIL: explaining which step
didn't.
"""
import os
import sys
import pty
import fcntl
import termios
import struct
import time
import signal

STARTUP_TIMEOUT_S = 8
SIGNAL_REACT_TIMEOUT_S = 5
DOUBLE_CTRLC_GAP_S = 0.3
SESSION_EXIT_TIMEOUT_S = 10


def parse_args(argv):
    logfile = None
    cwd = None
    i = 0
    while i < len(argv):
        if argv[i] == "--logfile":
            logfile = argv[i + 1]
            i += 2
        elif argv[i] == "--cwd":
            cwd = argv[i + 1]
            i += 2
        elif argv[i] == "--":
            i += 1
            break
        else:
            i += 1
    cmd = argv[i:]
    if not logfile or not cwd or not cmd:
        print("FAIL: usage: pty-signal-harness.py --logfile PATH --cwd DIR -- CMD [ARGS...]")
        sys.exit(2)
    return logfile, cwd, cmd


def wait_for(logfile, substr, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(logfile) and substr in open(logfile).read():
            return True
        time.sleep(0.05)
    return False


def main():
    logfile, cwd, cmd = parse_args(sys.argv[1:])
    if os.path.exists(logfile):
        os.remove(logfile)

    master_fd, slave_fd = pty.openpty()
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))

    session_leader_pid = os.fork()
    if session_leader_pid == 0:
        os.close(master_fd)
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)

        # Play the role of a real interactive shell: ignore these itself
        # while a foreground job runs, so the shell's own reaction never
        # confounds observing the job's independent handling of the same
        # signal (both are in the same process group, so both receive it).
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGQUIT, signal.SIG_IGN)
        signal.signal(signal.SIGTSTP, signal.SIG_IGN)

        job_pid = os.fork()
        if job_pid == 0:
            os.chdir(cwd)
            os.execvp(cmd[0], cmd)
            os._exit(127)

        os.waitpid(job_pid, 0)
        os._exit(0)

    os.close(slave_fd)

    def fail(msg):
        print(f"FAIL: {msg}")
        try:
            os.kill(session_leader_pid, signal.SIGKILL)
            os.waitpid(session_leader_pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        os.close(master_fd)
        sys.exit(1)

    if not wait_for(logfile, "started", STARTUP_TIMEOUT_S):
        fail("command never started (no 'started' marker in the log)")

    # A resize, via the same TIOCSWINSZ mechanism a real terminal uses.
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    if not wait_for(logfile, "WINCH", SIGNAL_REACT_TIMEOUT_S):
        fail("SIGWINCH was not forwarded to the sandboxed process")

    # First Ctrl-C: must forward gracefully, not kill anything.
    os.write(master_fd, b"\x03")
    if not wait_for(logfile, "INT", SIGNAL_REACT_TIMEOUT_S):
        fail("first SIGINT was not forwarded to the sandboxed process")

    time.sleep(DOUBLE_CTRLC_GAP_S)
    if "exited" in open(logfile).read():
        fail("sandboxed process exited after only one Ctrl-C (should still be running)")

    # Second Ctrl-C, quickly: must force-kill the whole launch.
    os.write(master_fd, b"\x03")
    deadline = time.time() + SESSION_EXIT_TIMEOUT_S
    session_exited = False
    while time.time() < deadline:
        try:
            wpid, _ = os.waitpid(session_leader_pid, os.WNOHANG)
            if wpid == session_leader_pid:
                session_exited = True
                break
        except ChildProcessError:
            session_exited = True
            break
        time.sleep(0.1)

    os.close(master_fd)

    if not session_exited:
        try:
            os.kill(session_leader_pid, signal.SIGKILL)
            os.waitpid(session_leader_pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        fail("session did not exit after a second Ctrl-C within the double-press window")

    print("PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()
