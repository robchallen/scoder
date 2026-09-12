---
target-version: 2.5.0
status: accepted
tags: [decision-record, sandbox, x11, rstudio]
---

# 0002 — RStudio Desktop Gets Direct Host X11 Access

## Context

RStudio Desktop is a GUI application. Launched through scoder unmodified,
it fails immediately:

```
[ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc:249] Missing X server or $DISPLAY
[ERROR:ui/aura/env.cc:257] The platform failed to initialize.  Exiting.
```

The sandbox has no X server of its own and no connection to the host's.
Making RStudio work at all means choosing how it reaches a display.

The motivating case is bridging `pi` and RStudio in the same environment
without the isolation gap the alternative created: connecting `pi` (inside
the sandbox) to a live RStudio session running natively on the host, via
`mcptools`' session bridging. That gives anything inside the sandbox the
ability to execute arbitrary R code in a full, unsandboxed host session —
a much larger hole than anything considered here. Running RStudio *inside*
the sandbox instead, with `pi` reachable from its embedded terminal, keeps
that boundary intact; this decision is about the narrower cost of doing
that.

## Options Considered

**A. Bind the host's real X11 socket into the sandbox.** Cheapest by far —
one bind, one env var. Verified directly (see "What Was Verified" below)
that it works, and that it carries a real cost: anything inside the
sandbox gets the same access to that X display any of the user's own
desktop apps have.

**B. RStudio Server over HTTP**, reachable via a forwarded port instead of
a shared X11 socket. No X11 protocol exposed at all — genuinely safer in
kind, not just in degree, since HTTP has no equivalent of X11's
client-to-client trust model. Rejected for this project specifically:
RStudio Server's normal architecture needs root/PAM to broker per-user
sessions, which the sandbox's single synthetic identity doesn't support
without finding and verifying a non-root, no-PAM launch path; and pasta's
inbound port forwarding (`--tcp-ports`, distinct from the outbound
`--tcp-ns` `.agentports` already uses) is hardcoded off in
`buildPastaArgs` today — reachable, but real, unbuilt work either way.

**C. A nested X server (Xvnc) plus VNC, entirely inside the sandbox**, with
only a VNC port crossing the boundary. Structurally the safest of the
options that still uses bwrap: a compromised or misused X server here is
just "something happened inside the sandbox," not a host escape. Rejected
for the same practical reason as B — needs the same not-yet-built inbound
port forwarding, plus a full nested X server, window manager, and VNC
stack on top. Heavier than this project's own stated shape.

**D. A VM or a full container.** The properly isolated answer if the
actual threat model were a dedicated, malicious actor. It is not: the
sandbox's job here is to prevent *accidents* — a careless or
over-eager agent doing something destructive to the host — not to hold
against someone deliberately trying to break out. bwrap is already a
lighter-weight tool than that stronger threat model would call for; VNC
and RStudio Server are heavier than bwrap's own weight class, and a VM or
container heavier still. Rejected as solving a problem this project isn't
trying to solve.

## Decision

**Option A.** A new `rstudio` tool preset (`src/tools/presets.ts`) binds
`/tmp/.X11-unix` read-only and passes `DISPLAY` through; if the host X
session uses cookie-based auth, it also binds the `XAUTHORITY` file
(read-only) and points `XAUTHORITY` at the sandbox-side copy, not the
host's own path.

## What Was Verified

Not assumed — built a real bwrap sandbox shaped exactly like scoder's own
and a real X server (Xvfb) to stand in for the host's:

| Claim | Result |
|---|---|
| Binding `/tmp/.X11-unix` and setting `DISPLAY` is enough for a no-auth X server | **Yes** — confirmed directly. |
| A cookie-auth X server (the realistic case) refuses without `XAUTHORITY` and its file bound in | **Yes** — confirmed directly: `Authorization required, but no authorization protocol specified`. |
| Binding the `XAUTHORITY` file and setting the env var to the sandbox-side path fixes it | **Yes** — confirmed directly. |
| No IPC/PID namespace work is needed for this (MIT-SHM depends on a shared IPC namespace) | **Yes** — `buildBwrapCommand` only unshares `--unshare-user`/`--unshare-net`; IPC and PID are already shared with the host. |
| X11's "untrusted" client mode (the mechanism `ssh -X` relies on by default) blocks XTEST-based synthetic input injection into other windows | **No** — confirmed directly, via both `xdotool` and raw Xlib: a properly-generated `xauth ... untrusted` cookie did not block `XTestFakeKeyEvent`. This was the natural candidate mitigation and it does not hold; it should not be relied on as one. |

## Consequences

Anything running inside a sandbox launched with the `rstudio` preset has
the same access to that X display any of the user's own desktop
applications have — not just the RStudio window. Concretely, and verified
above rather than assumed: it can read the screen, and it can inject
synthetic keyboard/mouse input into *other* windows on that display via
XTEST, ordinary and undocumented-as-dangerous X11 client APIs that need no
exploit. If anything else with real privilege shares that display — a
terminal, an editor, a browser session — code running inside the sandbox
(R code inherently is arbitrary code) has a plausible, no-exploit-needed
path to acting on it. This is accepted, not overlooked, for the stated
threat model (accidents, not a dedicated adversary); it is a genuinely
different, stronger bar than every other preset in this project, since
every other one confines its tool to filesystem and network access scoder
already mediates, while this one hands over a live channel scoder has no
further control over once it's open.

[IMPACTS](/src/tools/presets.ts)
[HAS_FEATURE](/design/features/tool-presets.md)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
