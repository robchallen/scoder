---
target-version: 2.6.0
status: draft
tags: [feature, sandbox, x11, xpra, ide, security]
---

# xpra GUI Isolation

## Summary

A GUI preset (`rstudio`, `eclipse`) runs under an xpra server started
*inside* the sandbox. That server owns a virtual X display that exists only
there, and forwards individual windows over a unix socket to a client
process on the host, which draws them on the user's real desktop.

The host's `/tmp/.X11-unix`, `XAUTHORITY` and `DISPLAY` are not bound or
passed through. `DISPLAY` inside the sandbox is set by xpra, for its own
virtual display.

```
   host                                 │  sandbox (bwrap)
   scoder                               │
     ├─ bwrap ───────────────────────────┼─→ entrypoint.sh
     │                                   │     └─→ xpra start
     │                                   │           --bind=/tmp/scoder-xpra/xpra.sock
     │                                   │           --start-child=<ide>
     │                                   │           --exit-with-children=yes
     │                                   │             └─→ rstudio / eclipse
     │                                   │                   └─→ its own virtual X
     └─ xpra attach socket://…           │
          (sidecar, outside the sandbox) │
```

## Motivation

[ADR 0002](/architecture/decision-records/0002-rstudio-x11-access.md) bound
the host's X socket and cookie, and verified the cost rather than assuming
it: anything inside the sandbox could read the screen and inject synthetic
input into *other* windows via XTEST — including under X11's own
"untrusted" mode, which does not block it. It was the one channel scoder
could not mediate once open.

[ADR 0003](/architecture/decision-records/0003-xpra-gui-isolation.md)
supersedes that. It has the full argument, what this does and does not
close, and the verified results.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/xpra.ts)
[IMPLEMENTED_BY](/src/sandbox/entrypoint.sh)

Three moving parts, only one new in kind:

1. **In-sandbox xpra server**, started by `entrypoint.sh` as the GUI
   program's parent. `--daemon=no` (the default is `yes`, and a detached
   server leaves `$!` pointing at an exited pid), `--exit-with-children=yes`
   (takes a value; bare `--exit-with-children` is invalid), and
   `--start-child=` carrying the program's argv, `%q`-quoted because xpra
   hands it to a shell.
2. **A unix socket** at `/tmp/scoder-xpra/xpra.sock`, in a directory bound
   read-write — the only thing crossing the boundary. Read-write because the
   server inside has to create the socket; the host side only ever connects.
3. **Host-side `xpra attach` sidecar** (`attachXpraClient`). The same family
   as the pasta sidecar and the `--allow-ssh` tunnel: it lives outside the
   sandbox, starts once the sandbox exists, and is not covered by bwrap's
   `--die-with-parent`, so `launchSandbox` reaps it explicitly — before
   pasta, so the user does not watch a frozen window through shutdown.

### Which program gets wrapped

A preset declares `gui: true` (`ToolPreset`). It is a GUI preset whether
named as the primary tool or as the companion, so `entrypoint.sh` takes
`XPRA_TARGET=harness` for `scoder rstudio` and `XPRA_TARGET=ide` for
`scoder pi --ide rstudio`. Exactly one xpra server per session; the
companion wins if both are somehow GUI, since that is the arrangement
`--ide` exists for.

### The client must wait, and must pin its GDK backend

The socket appears **~3s** after launch (measured), and the client is
started from outside, so it always loses that race. `waitForXpraSocket`
polls with a 30s bound — bounded for the reason `waitForChildPid` is, that
an unbounded wait turns a failed launch into a silent hang.

`xpraClientEnv` sets `GDK_BACKEND` from what is actually reachable rather
than inheriting it. xpra's client otherwise refuses to start with
`'client' failed to initialize Gtk, no display?` even with a working
`DISPLAY`, a valid `XAUTHORITY` and `Gtk.init_check()` returning `True`:
`set_gdk_backend()` in `xpra/scripts/main.py` forces `GDK_BACKEND=wayland`
whenever `WAYLAND_DISPLAY` is merely *set*, whether or not a compositor is
listening, and the resulting error blames the display rather than the
backend choice. `attachXpraClient` reports which backend was tried when the
client fails, because upstream's message will not.

### Paths are in the sandbox's own /tmp

Both the socket directory and `entrypoint.sh` are bound under `/tmp`, which
is the sandbox's own tmpfs. Not a preference — a bind's mountpoint has to be
created, and it cannot be created inside a read-only bind, so `/run` (where
an earlier version put both) fails outright with `bwrap: Can't mkdir
parents ... Read-only file system`. That `/run/xpra` appeared to work during
development was an accident: the xpra package itself ships that directory.

A writable parent is not a weakness here. Verified directly from inside the
sandbox: `rm` and `mv` on a bind mountpoint both fail with `EBUSY`, and a
symlink over it fails with `EEXIST`, so an unprivileged process in the
namespace cannot remove or replace it, and `--ro-bind` makes the contents
unwritable.

The socket path also has a hard length limit — 107 bytes usable, 108 fails.
`/tmp/scoder-xpra/xpra.sock` puts the host side at 49 bytes including the
session root (see `session-temp-root`); a `$HOME`-based destination would
have spent much of that on the username.

### Capabilities

`--notifications=no` and `--printing=no` on both sides: xpra proxies the
host's notification daemon and printer list into the session otherwise,
which is a capability channel this layer exists to close. Observed directly
— the client tried to enumerate printers over the system bus unprompted.
Audio is off because the stack is not wired through the sandbox and produced
only `pactl` connection failures.

The clipboard is deliberately **on**. X11 passthrough gave the sandbox
unrestricted clipboard access along with everything else, so proxying it is
the same capability with a name and an off switch, not a regression. Worth
exposing as a flag.

### Hard dependency, never a fallback

`requireXpra` (`src/tools/presets.ts`), shared by every GUI preset's
`validate()`. A missing xpra fails with the same shape as the `bwrap` and
`pasta` checks in `main()`. It deliberately does not fall back to the old
X11 binds — see ADR 0003.

`--install-dependencies` adds the upstream repository (key,
per-codename `.sources`, `apt-get update`) before installing
`xpra xpra-x11` with `--no-install-recommends`; the distro's own package is
five years stale on Ubuntu 24.04 and absent on 26.04. See
`src/cli/dependencies.ts`.

## Known Gaps

- **RStudio and Eclipse are unverified under xpra.** The spike and the
  end-to-end test use `xclock` and `xdpyinfo`. Electron (RStudio) is the
  likelier of the two to need coaxing.
- **`ideShutdown` is unverified under xpra.** Both presets' recorded values
  were measured against a directly-exec'd IDE; the signalled process is now
  the xpra server. Unchanged, and should be re-measured rather than reasoned
  about.
- **D-Bus is untouched**, and is a real capability channel. ADR 0003 says so
  plainly rather than letting "we moved to xpra" imply more than it
  delivers. Separate work.
- **mmap is not wired up**, so transport is plain socket. xpra's default
  mmap file lands in a directory that is not the same on both sides of the
  namespace boundary; pointing `--mmap` inside the shared socket directory
  would fix that. Whether it matters at IDE window sizes is unmeasured —
  `xclock` proves correctness, not throughput.
- **`XDG_RUNTIME_DIR` is passed through but `/run` is read-only**, so the
  server logs errors saving session files under `/run/user/<uid>/xpra/`.
  Non-fatal, observed during the end-to-end test, untidied.

[HAS_FEATURE](./tool-presets.md)
[HAS_FEATURE](./ide-companion.md)
[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./session-temp-root.md)
[HAS_TEST](../test-scripts/validation-suite.md)
