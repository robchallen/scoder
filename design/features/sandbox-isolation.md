---
target-version: 2.1.0
status: draft
tags: [feature, sandbox, filesystem]
---

# Sandbox Isolation

## Summary

bubblewrap (bwrap) provides unprivileged filesystem namespacing. The sandbox
has: read-only system mounts, a fresh tmpfs `/home` populated with the real
host `$HOME` (see `path-mirroring`), selective tool config/data binds from
the host home, and the project working tree bind-mounted at its real
absolute path.

## Motivation

AI coding tools need access to source code and configuration but should not
be able to modify system files, read files outside the project, or write to
arbitrary host locations. bwrap gives us this without root.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/builder.ts#buildBwrapCommand)

[IMPLEMENTED_BY](/src/sandbox/builder.ts#buildBwrapCommand)

The sandbox shape:

- `/usr`, `/bin`, `/lib`, `/lib64`, `/etc`, `/sys`, `/run` — ro-bind from host
- `/opt` — ro-bind from host, if present. The FHS location for manually-
  installed, self-contained software (IDEs, vendor-shipped JDKs, browsers),
  outside `/usr` and so unreached by the bind above. Also a common
  `/etc/alternatives` target (e.g. an IDE's launcher script), in which case
  a tool could resolve correctly through the alternatives symlink chain and
  still fail at the final hop without this. See
  [design/implementation/issues/opt-not-mounted.md](/design/implementation/issues/opt-not-mounted.md).
- `/var/lib/dpkg/alternatives`, `/var/lib/alternatives` — ro-bind from host,
  whichever exists. `/etc/alternatives` (covered by the `/etc` bind above)
  is enough to *run* whichever alternative is selected, but
  `update-alternatives` itself keeps its administrative state (registered
  choices, priorities, auto/manual mode) under `/var/lib`, which nothing
  else mounts. See
  [design/implementation/issues/update-alternatives-state-not-mounted.md](/design/implementation/issues/update-alternatives-state-not-mounted.md).
- `/dev` — individual `--dev-bind` of specific real host device nodes
  (`null`, `zero`, `full`, `urandom`, `random`, `tty`, `pts`, `ptmx`,
  `fd`), plus a fresh `--tmpfs` for `/dev/shm` — not a wholesale
  `--dev-bind /dev /dev` (every raw disk, TPM, USB, and other device
  node on the host), and not bwrap's own synthetic `--dev` construction
  either. `--dev`'s incompatibility with pasta is now pinned down
  precisely, via a direct `strace` comparison of pasta's real attach
  sequence: with individual `--dev-bind`s, pasta's `setns(fd,
  CLONE_NEWUSER)` and `setns(fd, CLONE_NEWNET)` both succeed cleanly;
  with `--dev /dev`, the exact same sequence up to that point instead
  fails at `setns(fd, CLONE_NEWNET)` with `EPERM` — `Couldn't switch to
  pasta namespaces`, pasta's own generic error text for that failure,
  with no indication of which syscall or namespace was actually
  involved. `lsns` shows an identical, single-layer namespace structure
  either way — this is not a persistently-nested user namespace (a
  plausible-sounding but directly disproven theory floated during
  investigation), but most likely the network namespace's frozen
  "owning user namespace" reference ending up different depending on
  exactly when in `--dev`'s extra internal setup (mounting a fresh
  devpts instance, symlinking `ptmx`) the network namespace gets
  created relative to the user namespace settling into its final form
  — not confirmed against bwrap's own source, but reproduced
  deterministically across delays and namespace-topology checks, ruling
  out a timing race or a namespace-nesting difference as the cause.
  Individually-named real `--dev-bind`s side-steps whatever that
  incompatibility is, while still narrowing exposure far below the
  original wholesale bind. Confirmed working directly for a plain tool
  (`scoder pi`); `full` and `ptmx` were added to the list afterward.
- `/dev/pts/ptmx` — the devpts-*internal* multiplexer node, exposed as
  a side effect of binding the whole `/dev/pts` directory above, is
  separately shadowed by a later, narrower `--dev-bind` sourced from
  the top-level `/dev/ptmx` (bwrap applies binds in order, so a later,
  narrower bind at a nested path overrides an earlier, broader one
  covering it — confirmed directly with an isolated non-`/dev`
  reproduction). Reported directly: on at least one real host, the
  host's own devpts-internal `/dev/pts/ptmx` carries mode `0000`
  (locked down by that host's own devpts configuration, unrelated to
  anything this sandbox does), while the top-level `/dev/ptmx` bound
  separately is mode `0666` and demonstrably works — multiple real pty
  slaves already existed under `/dev/pts` in that host's own live
  session, proving ordinary PTY allocation via the standard path was
  never broken. Some native pty libraries (used by GUI terminal panes,
  e.g. Eclipse's or RStudio's embedded terminal) open the per-instance
  `/dev/pts/ptmx` specifically — the namespace-aware convention — rather
  than the top-level symlink; this makes that path resolve to the
  confirmed-working device too, without touching any real host file's
  actual permissions.
- `/dev/dri` (GPU render nodes) — bound separately, only for GUI presets
  that need it (`rstudio`, `eclipse` — see `guiX11Binds` in
  `src/tools/presets.ts`), not part of the fixed list above. **Load-bearing,
  not optional**, for at least RStudio Desktop: reported directly, RStudio
  showed a white window then crashed with `SIGILL` ("Illegal instruction
  (core dumped)") once `/dev` was narrowed to the fixed list above, which
  never included it. RStudio Desktop is Electron/Chromium-based, and
  Chromium's GPU process, unable to open a DRM render node, hits an
  internal `CHECK()`/`NOTREACHED()` failure rather than falling back to
  software rendering cleanly — release Chromium compiles a failed `CHECK`
  to a hardware trap instruction, which the OS reports as exactly this
  signal, not a graceful error message. `--dev-bind`, not `--ro-bind`:
  bwrap only grants actual device-node access through `--dev-bind`. Gated
  on the node existing on the host, same as the X11 socket: a host with no
  GPU at all has no `/dev/dri` to bind, and Chromium is expected to fall
  back to software rendering in that case instead of crashing, since the
  difference between "no GPU at all" and "GPU present but access denied"
  is exactly what this fix targets. Covers only the generic DRM/nouveau
  path — a host using the proprietary NVIDIA driver needs its own separate
  `/dev/nvidia*` nodes, not covered here; no GPU-backed host available in
  this project to verify that gap against directly.
- `/proc` — procfs
- `/tmp` — ephemeral tmpfs
- `$HOME` (the real host `$HOME`) — fresh per-session tmpfs with `.config/`, `.local/`, `.cache/` subdirs, populated by the binds below; nothing in it persists across sessions except what's explicitly bound in
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
