---
target-version: 2.9.0
status: accepted
tags: [decision-record, sandbox, x11, dbus, ide, security]
---

# 0005 — An Explicit `--native-display` Opt-Out from xpra, Default Unchanged

## Context

[0003](./0003-xpra-gui-isolation.md) withdrew host X11 passthrough and made
xpra a hard dependency of GUI presets — but it wrote its own exit clause:

> If an opt-out is ever wanted it should be an explicit flag naming what it
> gives up.

This is that flag. What makes it wanted is not a tuning miss but two
recorded failures in the class xpra cannot reach:

- [Dialogs land at the screen origin under xpra, in Eclipse but not
  RStudio](/design/implementation/issues/xpra-dialogs-placed-at-screen-origin.md)
  (parked): SWT computes dialog coordinates against the virtual display's
  single-rectangle geometry; matching a real multi-monitor layout from
  inside the sandbox is not flag-reachable.
- Hovers, tooltips, dropdowns and menus are **override-redirect** windows —
  they bypass the window manager by design, and xpra has to reconstruct
  their semantics over its protocol. The one attempt to engage with that
  here, `--modal-windows=yes`, *broke* every dropdown menu and was reverted.

The other two complaint classes were transport problems and are already
fixed (the scroll-encoding workaround; path-mirrored mmap). What remains is
exactly the part a native display fixes completely.

The trade is stated plainly because it is the whole decision: **a secure
path nobody can use has a usage rate of zero**, and the alternative to an
unusable sandbox is not a safer sandbox — it is no sandbox at all. A warned
native mode trades one capability, the display, to keep every other one.

## Decision

A `--native-display` flag (env spelling `SCODER_NATIVE_DISPLAY=1`) runs GUI
presets against the host's X server directly, instead of under an xpra
server. **Everything 0003 decided about the default stands unchanged**: no
flag, no behavioural change of any kind, byte-identical built commands.

The native grant, priced — measured in
[0002](./0002-rstudio-x11-access.md), the investigation that justified
withdrawing this path in the first place:

| host session | what one X connection grants sandboxed code |
|---|---|
| Xorg | XTEST synthetic input into **every window on the session** — verified directly *not* blocked by X11 "untrusted" client mode — plus screen readback and full clipboard/selection read-write. |
| Wayland (X clients via XWayland) | disturbance confined to XWayland windows; Wayland-native windows are isolated by the compositor. Materially smaller — but "materially smaller than total" is still not "mediated". |

So the flag prints a two-line startup warning naming the grant and naming
what xpra would have done instead, calibrated to which of the two rows is
detected. It is per-run and typed, and **never** a `.sandbox/` setting:
display isolation is a property of who is running the code, not of the
repo, and a committed file must not be able to carry an isolation downgrade
into a stranger's sandbox. (`git clone` → `scoder claude` must never be
silently wider than the default; `.sandbox/readonly` is safe precisely
because it can only *add* protection.)

## The Two Invariants This Must Not Break

**`/run` stays a tmpfs** ([0004](./0004-no-host-dbus.md) is what closed
docker.sock, ssh-agent.sock and the session bus, and the tmpfs is what
closes them — not anything xpra does). The native grants are `/tmp/.X11-unix`
ro-bound *after* `--tmpfs /tmp` so the mountpoint is in the sandbox's own
tmpfs, the XAUTHORITY cookie, and `DISPLAY`. The single carve-out is the
cookie **file** itself when the host keeps it under `/run/user/<uid>/`
(GDM's spelling): one read-only file with no socket in it is not `/run`
coming back, and writing it down as a carve-out is what keeps it a file and
stops it growing into the directory containing it.

**The GUI program gets a private session bus, never the host's.** Under
xpra this was free — `xpra start` defaults to `--dbus-launch`, a private bus
inside the sandbox — and 0004's own experiment (a real RStudio on a private
bus, menus fine, host bus unreachable) is the evidence a private bus
suffices. Native mode drops the xpra server and must reproduce the effect
directly, in whichever form the session's lifecycle can safely host it:
`scoder rstudio` runs its tool under `dbus-run-session --` (prepended to the
exec vector at build time; exit status verified to propagate, and Ctrl-C
arrives as a process-group kill that no wrapper can block), while the
companion form starts the bus *beside* the IDE in the entry point — because
measured directly (dbus 1.16.2), `dbus-run-session` forwards no signals and
orphans its child, which would turn the ENTER-to-close handshake into a
wrapper kill plus an orphaned, force-killed IDE. Either way the daemon's
socket lands under the sandbox's own `/tmp` and its address exists only
inside the sandbox — the built command still contains no
`DBUS_SESSION_BUS_ADDRESS` at all. The pre-xpra `guiX11Binds` in git history
is otherwise nearly the native grant verbatim — including a
`DBUS_SESSION_BUS_ADDRESS` passthrough line that must not be ported, and is
the trap a copy-paste would fall into.

## Consequences

- **Notifications have no native equivalent.** xpra's channel (0004's
  outward-only reversal) exists because the display connection carries it;
  a native session with no bus has nowhere to send notifications. Accepted:
  this is what "naming what you give up" includes.
- **The clipboard stops being a named channel.** xpra proxies it with an off
  switch; native takes the implicit X selection, as 0002's era did.
- **Failures must be preflighted harder, not quieter.** 0003's note about
  failures getting quieter under xpra applies with more force: a native
  misfire surfaces as `cannot open display` in sandbox stderr or, with
  `--ide`, in `$IDE_LOG` where nobody looks. So native mode validates up
  front: host `DISPLAY` set, X socket directory present, and the cookie
  warned-about if absent rather than assumed.
- **`ideShutdown` gets closer to its measured conditions.** The recorded
  per-IDE signals were measured against a directly-exec'd IDE; the xpra
  layer interposed a server. Native mode removes the interposition — but
  "closer to measured" is still not "measured through the new wrapper",
  `dbus-run-session` sits above the IDE in the companion case, so the
  shutdown matrix stays a real-desktop checklist item.
- **The rejected shapes stay rejected**: falling back to native when xpra is
  missing (0003: "a security-motivated change that quietly degrades to the
  mechanism it replaced is the worst available default"); a `.sandbox/`
  setting (above); and "tune xpra harder", which this project has already
  tried twice — the modal-window revert and the parked placement issue —
  against exactly the two failure classes that turned out to be structural.

[IMPACTS](/src/tools/presets.ts)
[IMPACTS](/src/sandbox/builder.ts)
[HAS_FEATURE](/design/features/xpra-gui-isolation.md)
[HAS_FEATURE](/design/features/tool-presets.md)
[HAS_TEST](/design/test-scripts/validation-suite.md)
