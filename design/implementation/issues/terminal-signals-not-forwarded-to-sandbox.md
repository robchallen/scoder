---
target-version: 2.4.0
resolved-in: 2.4.0
status: resolved
tags: [issue, sandbox, signals, pty, tty]
---

# Terminal Signals Not Forwarded to the Sandboxed Process

> **Fixed in 2.4.0.** Two pieces, both required:
>
> 1. `src/sandbox/launch.ts` gains `installSignalForwarding`, which catches
>    SIGWINCH/SIGINT/SIGQUIT/SIGTSTP on scoder's own process and relays each
>    one to `-childPid` (the sandboxed process's whole group) with a plain
>    `kill()`. A second SIGINT within `DOUBLE_SIGINT_WINDOW_MS` (2000ms,
>    `SCODER_DOUBLE_SIGINT_WINDOW_MS` overridable) force-kills the launch via
>    the existing `killBwrapTree` instead of forwarding again.
> 2. `wrapWithFdShim`'s shell shim (`src/sandbox/builder.ts`) now does
>    `trap "" INT QUIT TSTP` before its final `exec "$@"` into bwrap. This is
>    not optional — see Root Cause below for why forwarding alone was
>    insufficient.
>
> Covered by `terminal-signals-forwarded-to-sandbox`, which needs a real
> controlling-terminal relationship to reproduce at all and so drives a real
> PTY through a small Python helper (`tests/helpers/pty-signal-harness.py`;
> Bun/Node have no first-party PTY allocation). Verified manually first, the
> same discipline `bwrap-not-orphaned-on-pasta-attach-failure` used, before
> being committed to the suite.

## Summary

Reported using `pi`: after a terminal window resize, `pi`'s TUI never
redraws — it has no idea the window changed size. Investigation (prompted by
"you might need to look into the pi internals") found the cause is not
`pi`-specific at all: **no terminal-driven signal reaches the sandboxed
process, for any tool** — not SIGWINCH on resize, not SIGINT on Ctrl-C, not
SIGQUIT or SIGTSTP either.

## Root Cause

`buildBwrapCommand` passes `--new-session` to bwrap (`src/sandbox/builder.ts`),
documented in `design/legacy/DESIGN.md` as "prevents signal leakage" — a real
security control, calling `setsid()` on the sandboxed process to block
TIOCSTI-style terminal injection and other cross-boundary signal games.
Confirmed directly: `tcgetpgrp()` on the inherited tty fd returns `ENOTTY`
from inside the sandbox once `--new-session` has run. A process with no
controlling terminal cannot be the target of the kernel's tty-driven signal
delivery, which is the *only* mechanism that generates SIGWINCH, and the
*only* mechanism that generates SIGINT/SIGQUIT/SIGTSTP from a keystroke.
scoder's own process sits outside that detached session, still receives
these normally, and can relay them on with a plain `kill()` — gated only on
permission, not on any controlling-terminal relationship.

That relay alone was not sufficient, and finding out why turned into most of
this investigation. `Bun.spawn`'s child (bwrap) shares scoder's own process
group by default. A real Ctrl-C at the terminal delivers SIGINT to that
*whole group* simultaneously — scoder (survives, now has a handler) **and
bwrap's own outer process** (no handler of its own, so the kernel's default
disposition applies: termination for SIGINT/SIGQUIT). bwrap dying triggers
`--die-with-parent`, which SIGKILLs the sandboxed child immediately — a
native, in-process reaction, racing scoder's own JS-level forward() and
winning every time. Confirmed directly: forwarding a real Ctrl-C without the
`trap` fix below threw `ESRCH` — the sandboxed process was already gone by
the time scoder's own handler ran, even though it had been alive and
responsive to SIGWINCH moments earlier in the same run.

The fix is to make bwrap's own process immune to these signals in the first
place, so the race can't happen: `trap "" INT QUIT TSTP` in the shell shim,
*before* `exec`-ing into bwrap. `SIG_IGN` persists across `exec` (unlike a
handler, which resets to default), so the ignore inherits all the way down
through bwrap and into whatever it ultimately execs. The sandboxed program
is still completely free to install its own real handler for any of these —
ignoring is not a handler, and any program can override its own inherited
disposition via `sigaction()`/`signal()`. The one caveat, confirmed while
building the regression test: this does *not* extend to a *shell's* `trap`
builtin specifically — POSIX forbids a non-interactive shell from
un-ignoring a signal that was already `SIG_IGN` on entry (a deliberate
`nohup`-adjacent protection), so a sandboxed command that is itself a shell
script relying on its own `trap` for one of these would not see it. `pi`,
being a Node.js program calling `process.on(...)` directly, is unaffected —
confirmed against its actual bundled source (installed via
`curl -fsSL https://pi.dev/install.sh | sh`, at the user's own instruction):
it registers `process.stdout.on("resize", this.resizeHandler)`, the
standard, correct API, and even already self-triggers a `SIGWINCH` at
startup (`process.kill(process.pid, "SIGWINCH")`) for its own initial
dimension check — the same direct-`kill()` mechanism this fix uses, just
scoder doing it externally rather than `pi` doing it to itself.

Independently of forwarding, the investigation surfaced a second, unrelated
gap while checking what an unhandled SIGINT does to scoder's own process:
**nothing in `src/` registered any signal handler at all.** Confirmed
directly — a bare `try { await Bun.sleep(...) } finally { ... }` around
nothing else never reached its `finally` on an unhandled SIGINT; Bun's
default disposition terminates the process immediately, skipping it
entirely. That means every Ctrl-C during any interactive session, for any
tool, previously leaked the pasta sidecar — the exact leak class
`bwrap-orphaned-on-pasta-attach-failure` fixed, just triggered a different
way. Installing `installSignalForwarding`'s handlers fixes this too, as a
side effect of existing at all: once any handler is registered for a
signal, Bun's default immediate-termination disposition no longer applies.

## Impact

- Resize corruption in any TUI tool run through scoder (reported via `pi`,
  applies to any of them).
- Ctrl-C previously did *something* — killed everything, hard — rather than
  nothing, so this was less immediately visible than the resize case, but
  it meant no tool could ever offer its own graceful "cancel this turn, not
  the whole session" behavior, the way most modern agent CLIs are built to.
- The pasta-sidecar leak on every Ctrl-C, independent of the above and
  arguably the more serious finding: a resource leak on an extremely common
  interactive action, not merely a display bug.

## Design Decision: Which Signals, and the Double-Ctrl-C Safety Net

Discussed with the user before implementing (not just SIGWINCH — "are there
other signals we should be considering at the same time?"). All four
terminal-generated signals share the identical delivery mechanism and are
equally affected, so all four get forwarded uniformly.

A second SIGINT within the window force-kills rather than forwarding again,
as a safety net for a tool that doesn't exit after the first one (a bug in
that tool, not scoder) — the user still needs an escape hatch that doesn't
depend on the sandboxed tool cooperating. Implemented by reusing the
existing `killBwrapTree` (SIGKILL the outer bwrap process, `terminateProcess`
the inner one), the same mechanism `bwrap-orphaned-on-pasta-attach-failure`
already established for tearing a launch down completely.

[IMPACTS](/src/sandbox/launch.ts)
[IMPACTS](/src/sandbox/builder.ts)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
[HAS_FEATURE](/design/features/network-isolation.md)
