---
target-version: 2.1.0
status: draft
tags: [feature, sandbox, filesystem]
---

# Sandbox Isolation

## Summary

bubblewrap (bwrap) provides unprivileged filesystem namespacing. The sandbox
has: read-only system mounts, ephemeral `/home/scoder` HOME on tmpfs,
selective tool config/data binds from the host home, and the project working
tree bind-mounted at its real absolute path.

## Motivation

AI coding tools need access to source code and configuration but should not
be able to modify system files, read files outside the project, or write to
arbitrary host locations. bwrap gives us this without root.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/builder.ts#buildBwrapCommand)

[IMPLEMENTED_BY](/src/sandbox/builder.ts#buildBwrapCommand)

The sandbox shape:

- `/usr`, `/bin`, `/lib`, `/lib64`, `/etc`, `/sys`, `/run` — ro-bind from host
- `/dev` — devtmpfs
- `/proc` — procfs
- `/tmp` — ephemeral tmpfs
- `/home/scoder` — ephemeral tmpfs with `.config/`, `.local/`, `.cache/` subdirs
- `<project-path>` — bind mount of worktree or cwd
- `<git-dir>` — bind mount of host `.git` directory (worktree mode only)

**Terminal signal forwarding.** `--new-session` (see below) detaches the
sandboxed process from any controlling terminal, which as a side effect
blocks the kernel's own delivery of SIGWINCH/SIGINT/SIGQUIT/SIGTSTP to it —
there is no foreground process group left for the tty driver to target.
`installSignalForwarding` (`src/sandbox/launch.ts`) catches these on
scoder's own (unaffected) process and relays each one directly to the
sandboxed process's group with `kill()`, which is gated only on permission,
not on any controlling-terminal relationship. This does not reopen what
`--new-session` closed — it blocks the *sandboxed* process from reaching
things outside it; this is scoder, the trusted launcher, explicitly relaying
a signal in. A second SIGINT within a short window force-kills the launch
rather than forwarding again, as a safety net for a tool that doesn't exit
on the first one. See
[design/implementation/issues/terminal-signals-not-forwarded-to-sandbox.md](/design/implementation/issues/terminal-signals-not-forwarded-to-sandbox.md).

- **`--new-session`** — calls `setsid()` on the sandboxed process; blocks
  TIOCSTI-style terminal injection and other signal leakage between the
  sandbox and the session outside it. Its own outer bwrap process is made
  immune to SIGINT/SIGQUIT/SIGTSTP (`trap "" INT QUIT TSTP` in
  `wrapWithFdShim`'s shell shim, before it execs into bwrap) — without that,
  a real Ctrl-C kills bwrap's own unhandled process directly (it shares
  scoder's process group), and `--die-with-parent` reacts by killing the
  sandboxed process before the forwarding above ever gets a chance to run.

[HAS_FEATURE](./path-mirroring.md)
[HAS_FEATURE](./host-tool-binding.md)

[HAS_TEST](../test-scripts/validation-suite.md)
