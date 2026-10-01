---
target-version: 2.6.0
status: accepted
supersedes: 0002-rstudio-x11-access
tags: [decision-record, sandbox, x11, xpra, ide, security]
---

# 0003 — GUI Presets Get a Private Display via xpra, Not the Host's X Server

## Context

[0002](./0002-rstudio-x11-access.md) decided that GUI presets (`rstudio`,
later `eclipse`) would reach a display by binding the host's own
`/tmp/.X11-unix` socket directory, its `XAUTHORITY` cookie file, and
passing `DISPLAY` through. It documented the cost in unusually blunt terms,
and verified it rather than assuming it: anything inside such a sandbox can
read the screen and inject synthetic keyboard and mouse input into *other*
windows on that display via XTEST — including, confirmed directly with both
`xdotool` and raw Xlib, under X11's own "untrusted" client mode, the
mechanism `ssh -X` relies on. That was the one place in this project where
a tool got a channel scoder could not mediate once open.

0002 considered the alternative — "a nested X server plus VNC, entirely
inside the sandbox" (its option C) — called it "structurally the safest of
the options that still uses bwrap," and rejected it on two concrete
grounds. Its analysis was right. Both grounds have since stopped applying.

## Decision

GUI presets run under an **xpra server inside the sandbox**. It owns a
virtual X display that exists only there, and forwards individual windows
over a unix socket to a client process on the host, which draws them on the
user's real desktop. The host's X socket, `XAUTHORITY` and `DISPLAY` are no
longer bound or passed through at all.

## Why 0002's Objections No Longer Hold

| 0002's objection to option C | Why xpra does not have it |
|---|---|
| "needs the same not-yet-built inbound port forwarding" — `buildPastaArgs` hardcodes `--tcp-ports none`, still true | xpra transports over a **unix socket**, not TCP. A socket in a bind-mounted directory needs no port forwarding, and bind mounts are what this project is built around. Confirmed stronger than expected: it works with `--unshare-net` fully in force, with pasta entirely uninvolved. |
| "plus a full nested X server, window manager, and VNC stack on top" | xpra's *seamless* mode forwards individual windows, so there is no desktop session and no window manager. It starts and manages its own `Xvfb` too. One package, not a stack. |

This is therefore a supersession of 0002's decision, not a correction of its
reasoning. Its analysis is what made this credible; one of its rejected
options simply got cheap.

## Verified Directly

The architecture was built and run end to end in a scoder-shaped sandbox
before being implemented, and then again as the implementation itself. The
end-to-end test `gui-display-is-private-end-to-end` is the standing version
of the last two rows.

| Claim | Result |
|---|---|
| An xpra server starts inside a bwrap sandbox shaped like scoder's | **Yes** — `xpra seamless server version 6.5.4-r0`, `uid=1000`, on its own virtual display created inside the sandbox. |
| It works with `--unshare-net` still in force | **Yes** — the sandbox had no network namespace access at all. |
| A socket in a bind-mounted directory is reachable from both sides | **Yes** — `srw-------`, created by the server inside, opened by the client outside. |
| A host-side client renders the sandboxed app's window on a real display | **Yes** — `xwininfo` on the host display listed `0x200028 "xclock on :0" 314x220`: the app's real window, forwarded from the sandbox's private display. |
| `--exit-with-children=yes` makes the server exit with the app | **Yes** — `all children have exited and --exit-with-children was specified, exiting`. |
| The client must wait for the socket | **Yes, and not marginally** — the socket appeared **~3s** after launch, so `waitForXpraSocket` polls rather than assuming. |
| A GUI program in the sandbox sees xpra's display, not the host's | **Yes** — `xdpyinfo` inside reports `name of display: :0` while the host's `:89` fails with `unable to open display`. |
| Software GL works inside the sandbox | **Yes** — `OpenGL is supported ... using 'llvmpipe'`. |

## Consequences

**What this closes.** The screen-reading and XTEST input-injection paths
0002 accepted. A GUI preset's sandbox now has exactly one channel to the
outside display: a unix socket carrying window contents and input events
for its own windows.

**What it does not close, and this must not be overstated.**
`guiDisplayBinds` still passes `XDG_RUNTIME_DIR` and
`DBUS_SESSION_BUS_ADDRESS` through, and `buildBwrapCommand` still binds
`/run` read-only, which is how the sandbox reaches the host's session bus.
xpra does nothing about that, and a session bus is a real capability
channel — notifications, portals, and whatever else the user's desktop
exposes on it. **Moving to xpra closes the largest and best-documented hole
in GUI isolation, not the last one.** Deciding what to do about D-Bus is
separate work and needs its own plan.

> **Since superseded by
> [0004](./0004-no-host-dbus.md).** `/run` is a tmpfs, the address is no
> longer passed through, and the host's session bus is unreachable. The
> paragraph above stands as written at the time: it was right that this was
> a real, open hole, and right that it needed its own decision.

Two capabilities xpra would otherwise proxy back are turned off explicitly
rather than left at their defaults, for the same reason: `--notifications=no`
and `--printing=no`. Observed directly during the end-to-end test — the
client tried to enumerate the host's printers over the system bus
unprompted. The clipboard is deliberately left **on**: X11 passthrough gave
the sandbox unrestricted clipboard access along with everything else, so
proxying it is the same capability with a name and an off switch, not a
regression. It is worth exposing as a flag.

**xpra becomes a hard dependency of GUI presets**, and its absence is a hard
failure. It deliberately does not fall back to the old X11 binds: a
security-motivated change that quietly degrades to the mechanism it
replaced is the worst available default, because the user believes they got
isolation, did not, and nothing on screen looks different. If an opt-out is
ever wanted it should be an explicit flag naming what it gives up.

**The distro's xpra is not usable.** Ubuntu 24.04 ships 3.1.5+dfsg1, about
five years old; Ubuntu 26.04 does not package it at all. So
`--install-dependencies` grows a repository-setup stage (key, per-codename
`.sources` file, `apt-get update`) reimplementing what upstream's
`get-xpra.sh` does for Debian/Ubuntu — reimplemented rather than piped into
a root shell, since a sandboxing tool whose own setup command is the least
contained thing the user runs would be an odd place to land.

**Failures get quieter.** An unreachable IDE used to mean bwrap could not
exec it and said so on the console. Now the server starts cleanly and fails
to spawn its child, into a log that is deliberately redirected away from the
console. The up-front `checkExecTargetReachable` call therefore stops being
a nicer diagnostic than the eventual failure and becomes close to the only
thing that will tell the user what went wrong — which is why xpra was added
to those checks *alongside* the tool and IDE ones, never in place of them.

**Per-IDE shutdown metadata is now unverified.** `ideShutdown`'s signal and
children-first/process-first values were measured against each IDE's real
process tree. Under xpra the tree gains a layer — what gets signalled is the
xpra server, not the IDE, with `--exit-with-children` carrying the request
down. Both presets' recorded values are **unchanged and unre-measured**;
this project's history with these two IDEs is that their process trees do
not behave as predicted, so they should be re-measured rather than reasoned
about.

**Eclipse has since been confirmed to start and run under xpra**, reported
directly from a real session — server up, `--start-child` launching
`/opt/eclipse/eclipse` with its full argv, m2e refreshing projects, its
embedded Tomcat starting. That session did not confirm the window reaching
the screen, because it hit a socket-detection bug that stopped any client
attaching. **RStudio is still unverified**; Electron is the likelier of the
two to need coaxing.

[IMPACTS](/src/tools/presets.ts)
[IMPACTS](/src/sandbox/xpra.ts)
[IMPACTS](/src/sandbox/entrypoint.sh)
[HAS_FEATURE](/design/features/xpra-gui-isolation.md)
[HAS_FEATURE](/design/features/tool-presets.md)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
