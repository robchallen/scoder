---
target-version: 2.8.0
status: accepted
tags: [decision-record, sandbox, dbus, security]
---

# 0004 — The Sandbox Gets No Host D-Bus at All

## Context

`--ro-bind /run /run` handed the sandbox **every socket under `/run`**, and
permission was not the obstacle it appears to be. Measured on a real host:

| socket | mode | reachable from the sandbox? |
|---|---|---|
| `/run/docker.sock` | `srw-rw---- root:docker` | **yes** — `connect()` succeeded |
| `/run/ssh-agent.sock` | `srw-rw-rw-` | **yes** — world-writable |
| the session bus | `/run/user/<uid>/bus` | **yes** |

The group-gated one is the instructive case, because the obvious reason to
think it safe is wrong. Inside the sandbox `id -G` reports `1000 65534 65534`
and the socket shows as `nobody nogroup`, which looks like the `docker` group
has been dropped. It has not. Entering a user namespace changes how ids are
*rendered*, not the credentials the kernel checks — verified with a
`root:docker` file at mode 640 that the sandbox read while reporting no such
group. **A sandbox reaches whatever its user can reach.**

Replacing that bind with `--tmpfs /run` closes all three at once. The open
question was what, if anything, to put back for the session bus.

## The Answer We Nearly Shipped

An `xdg-dbus-proxy` sidecar, filtering the host bus against a per-project
allowlist in `.sandbox/dbus`, with `--log` so a refused call could be
diagnosed. It was built, it worked, and it was wrong — not in its mechanics
but in its premise.

The premise was a symptom recorded in `tool-presets`: RStudio's menus came up
greyed out, and passing `DBUS_SESSION_BUS_ADDRESS` through fixed it. The
feature doc was honest that this was "a well-motivated fix, **not a verified
one** — this project has no real RStudio Desktop install or desktop D-Bus
session to confirm it against directly." Everything built on top of it
inherited the same unexamined assumption: that what the application needed was
*the user's* bus.

It needed *a* bus.

## What Actually Revealed It

The proxy appeared to work perfectly in its first real session — both IDEs
fine, clipboard working in and out — while its log stayed completely empty.
The explanation was that `xpra start` defaults `--dbus-launch` to
`dbus-launch --sh-syntax --close-stderr`: it starts a **private session bus
inside the sandbox** and exports that address into everything `--start-child`
runs, so the filtered socket was never touched by anything.

Which means the session was, accidentally, the experiment nobody had run: a
real RStudio, with a real session bus, and no host bus reachable at all. The
menus were fine. That is the only direct evidence this project has ever had on
the question, and it falsifies the premise the proxy was built on.

## Decision

**Nothing brings the host's session bus back.** Specifically:

- `--tmpfs /run` stays. It is what closes the hole, and it does so on its own.
- `DBUS_SESSION_BUS_ADDRESS` is **not** passed through. Forwarding an address
  without the socket is worse than leaving it unset: it points applications at
  a path that does not exist, where an unset variable lets xpra's own bus take
  over cleanly.
- GUI presets keep **xpra's private bus**, at its default. It is what gives
  Electron and GTK applications the bus they expect.
- Non-GUI presets get **no bus**, which is where they already were.
- `--notifications=yes` replaces `--notifications=no`, so the sandbox can
  still reach the user.
- `xdg-dbus-proxy`, `.sandbox/dbus` and the allowlist are deleted.

## Why Not Keep the Proxy

**It is not what closes the hole.** The tmpfs is. The proxy re-opens a
controlled slice of what the tmpfs removed, so no-proxy is the *more* isolated
position, not the less — a private bus reaches nothing on the host, where the
proxy reached three named services.

**Its defaults contained the opposite of what it was for.** Two of the three
were `org.freedesktop.portal.Desktop` and `org.freedesktop.portal.Documents`.
The xdg portals exist specifically to hand sandboxed applications files from
*outside* their sandbox. In practice the tmpfs had already defanged the worst
of it — nothing binds `/run/user/<uid>/doc`, so the documents portal has
nowhere to deliver through — but a documented sandbox-escape mechanism had
been written into the defaults of a feature whose stated job was isolation,
and nobody noticed until the feature's necessity was questioned.

**The allowlist was an unbounded maintenance surface**, derived by guesswork,
for a capability nothing had demonstrated a need for.

## What This Costs

- **`xdg-open` opens inside the sandbox**, not on the host desktop. Observed:
  one "open containing folder" brought up a file manager and a browser in
  there. Arguably the more correct behaviour for a sandbox; certainly the
  heavier one.
- **Host screensaver-inhibit silently does nothing** during long jobs. Minor,
  and silent, which is the annoying part.
- **No access to the host keyring**, so credential helpers will not persist
  anything. This was already true: `org.freedesktop.secrets` was deliberately
  excluded from the proxy's defaults too.
- **Clipboard is unaffected.** It is X11 selections forwarded by xpra, which
  is why it kept working throughout.

Notifications are the one thing deliberately kept, and they travel down the
display connection rather than over a bus: content raised inside the session,
relayed to the client, shown on the real desktop. Outward only — the sandbox
cannot call the host's notification service or reach anything else through it.

## The System Bus Was Never In Scope

`/run/dbus/system_bus_socket` went with the tmpfs and does not come back. The
first thing to notice was R's `bspm`, which warns "D-Bus service not found!"
at startup. Leaving it that way is deliberate: `bspm` exists to install apt
packages as **root on the host** on request, which is the `docker.sock` class
of escape wearing an unexpected hat. Anything that genuinely needs the system
bus needs its own mediation, not a hole.

## Consequences

- A capability channel that existed for a year, unexamined, is gone, and the
  negative is asserted by two tests (`run-is-a-tmpfs-not-the-host` and
  `no-host-dbus-address-in-the-sandbox`) because the symptom that justified it
  is exactly the kind a well-meaning future change would try to fix again.
- GUI and non-GUI presets now differ in whether a session bus exists at all.
  That is a real inconsistency, accepted because the alternative — a bus for
  non-GUI presets — would mean building the thing this record deletes.
- **The generalisable lesson is to test that the hole exists before fixing
  it.** The greyed-out menus were real; the diagnosis was plausible; the fix
  worked. None of that established that the *host's* bus was required, and one
  session with a private bus would have settled it at any point in the
  preceding year.
- A corollary, specific to this stack: xpra's scope is much wider than it
  looks. It brought its own session bus, its own notification forwarding, its
  own printer enumeration and its own menu watcher, two of which had already
  been turned off individually before anyone looked at the pattern. More of it
  is worth reading before the next feature is built beside it.

[IMPACTS](/src/sandbox/builder.ts)
[IMPACTS](/src/sandbox/entrypoint.sh)
[IMPACTS](/src/tools/presets.ts)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
[HAS_FEATURE](/design/features/xpra-gui-isolation.md)
