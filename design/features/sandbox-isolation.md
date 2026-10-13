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

- `/usr`, `/bin`, `/lib`, `/lib64`, `/etc`, `/sys` — ro-bind from host
- `/run` — a **tmpfs**, not the host's, with `/run/user/<uid>` created
  writable inside it, mode `0700` like the host's (`--perms` — a bare
  `--dir` gives `0755`, and older bwrap builds left `0777&~umask` in
  place). Binding the host's read-only handed the sandbox every socket
  under it, and permission was no obstacle: `/run/docker.sock`
  (`root:docker`) and `/run/ssh-agent.sock` both accepted `connect()`,
  because entering a user namespace changes how ids are *rendered*, not the
  credentials the kernel checks. Nothing comes back through it — in
  particular the session bus does not; see
  [0004-no-host-dbus](/architecture/decision-records/0004-no-host-dbus.md).
  One consequence worth knowing: on a systemd host `/etc/resolv.conf` is a
  symlink into `/run`, which this dangles, so the DNS snapshot is bound at
  the *resolved* path instead — bwrap will not create a mountpoint through a
  symlink, verified, including with the target's parent scaffolded first.
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
- `/dev/tty` — the user's own pty, bound in the outer layer when scoder is on
  a terminal, so OSC 52 copies written to `/dev/tty` reach the terminal
  despite `--new-session`; `TIOCSTI` still refused (see
  [clipboard-sharing](./clipboard-sharing.md)).
- `/dev/console` — bound to `/dev/null`. bwrap's `--dev` otherwise binds the
  user's terminal there whenever its stdout is a tty, and `syslog()` with
  `LOG_CONS` falls back to `/dev/console` when there is no `/dev/log` —
  which is how RStudio's rsession errors reached pi's terminal (see
  [the issue](../implementation/issues/rstudio-jsonrpc-error-in-pi-terminal.md)).
- `/dev` — **two bwrap layers**, not one. The *outer* layer
  (`buildDevLayer` in `src/sandbox/builder.ts`) owns `/dev` and nothing
  else: it binds the real root straight through, unshares only the user
  namespace, and builds `/dev` with bwrap's own `--dev`. The *inner* layer
  is everything else this document describes, and takes that `/dev`
  wholesale with a recursive `--dev-bind /dev /dev`.

  `--dev` builds the same small node set an earlier fixed list of
  individual `--dev-bind`s did (`null`, `zero`, `full`, `random`,
  `urandom`, `tty`, `fd`) on a private tmpfs, so this is no less isolating
  than binding those nodes by hand — and it is emphatically not the
  wholesale `--dev-bind /dev /dev` of every raw disk, TPM and USB node
  that came before either, since the inner layer's wholesale bind binds
  the *outer layer's synthetic* `/dev`, never the host's. What `--dev`
  adds is a **fresh devpts instance** at `/dev/pts` (`ptmxmode=666`) with
  `/dev/ptmx` a symlink to `pts/ptmx`, and that is the part that matters:
  without it no process in the sandbox can allocate a pty at all.
  Confirmed directly inside a live sandbox — with the hand-bound nodes,
  `openat("/dev/ptmx")` and `openat("/dev/pts/ptmx")` both failed with
  `ENOENT` and `openpty()` failed outright; with this shape both open and
  `openpty()` returns `/dev/pts/0`. Two separate confirmed reasons the old
  binds could not work: a bind of the devtmpfs `/dev/ptmx` node keeps its
  source dentry, so the kernel's ptmx open path (`path_pts()`) looks for a
  `pts` sibling beside it on devtmpfs rather than in the sandbox and finds
  no devpts there; and the host's own devpts, bound in at `/dev/pts`, is
  mounted `ptmxmode=000`, so its internal ptmx node is unopenable by the
  sandbox uid. Eclipse's and RStudio's embedded terminals deadlocked on
  exactly that — see
  [design/implementation/issues/eclipse-rstudio-embedded-terminal-deadlocks.md](/design/implementation/issues/eclipse-rstudio-embedded-terminal-deadlocks.md).

  Binding the host's `/dev/pts` wholesale was also an isolation hole in
  its own right, independent of the deadlock: the sandbox could see the
  host's pty slaves and, they being owned by the same uid, open them
  read/write — i.e. reach the user's own terminals. A fresh devpts
  instance closes that; the prototype harness checks for it explicitly.

  **Why two layers instead of one bwrap with `--dev /dev`**, which would
  also give a working devpts: pasta cannot attach to a network namespace
  created by a bwrap invoked with `--dev`. Confirmed directly on a real
  host with `design/prototype/nested-bwrap-pasta.sh`, which builds both
  shapes and runs identical checks — the single-layer shape fails with
  `Couldn't switch to pasta namespaces: Operation not permitted`, the
  nested one passes everything. No mechanism for that has ever been
  established (`lsns` shows an identical, single-layer namespace structure
  either way, disproving the nested-userns explanation once offered for
  it), so the two concerns are split rather than reconciled: `--dev` on
  the outer layer, `--unshare-net` on the inner, whose namespaces pasta
  attaches to and which never sees `--dev`.

  Consequences worth knowing:
  - Ordering is load-bearing twice over. `--dev` mounts a fresh tmpfs over
    `/dev`, so in the outer layer it must follow the root bind and precede
    any device bind into `/dev`.
  - Device nodes a preset binds from `/dev` (e.g. `/dev/dri`, below) are
    hoisted into the outer layer too, as `--dev-bind-try`, or the inner
    layer's bind would have no source to resolve. The preset's own gating
    still decides whether the sandbox gets them.
  - `--info-fd` and `--block-fd` stay on the inner layer: the child pid the
    outer layer would publish is the inner bwrap process, which sits
    outside the network namespace pasta must attach to. Both fds reach the
    inner layer by plain inheritance through the outer one, confirmed
    directly.
  - `--die-with-parent` is needed on both layers, or the inner one
    outlives the outer.
  - `collectBindDests` deliberately skips the outer layer: its `--bind / /`
    populates nothing in the sandbox the tool runs in, and counting it
    would make every path look bound and silently defeat the exec-target
    reachability check in `src/index.ts`.

- `/dev/dri` (GPU render nodes) — bound separately, only for GUI presets
  that need it (`rstudio`, `eclipse` — see `guiDisplayBinds` in
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
  on the node existing on the host: a host with no
  GPU at all has no `/dev/dri` to bind, and Chromium is expected to fall
  back to software rendering in that case instead of crashing, since the
  difference between "no GPU at all" and "GPU present but access denied"
  is exactly what this fix targets. Covers only the generic DRM/nouveau
  path — a host using the proprietary NVIDIA driver needs its own separate
  `/dev/nvidia*` nodes, not covered here; no GPU-backed host available in
  this project to verify that gap against directly.
- `/proc` — procfs
- `/tmp` — ephemeral tmpfs; the one entry-point log for a GUI/companion
  session (see [ide-companion](./ide-companion.md), "The session log") is a
  host-staged file bound over it at the same path, so a GUI's output is
  readable from outside the sandbox for the life of the session
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
