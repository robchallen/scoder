---
target-version: 2.8.0
status: draft
tags: [feature, sandbox, dbus, security]
---

# D-Bus Isolation

## Summary

The sandbox gets a `/run` of its own — a tmpfs, not the host's — and reaches
the session bus only through `xdg-dbus-proxy`, which forwards calls to names
listed in `.sandbox/dbus` and refuses everything else.

## Motivation

This started as "close the D-Bus hole [ADR 0003](/architecture/decision-records/0003-xpra-gui-isolation.md)
documented", and the investigation found something larger.

`--ro-bind /run /run` handed the sandbox **every socket under `/run`**, and
permission was not the obstacle it appears to be. Measured on a real host:

| socket | mode | reachable from the sandbox? |
|---|---|---|
| `/run/docker.sock` | `srw-rw---- root:docker` | **yes** — `connect()` succeeded |
| `/run/ssh-agent.sock` | `srw-rw-rw-` | **yes** — world-writable |
| the session bus | `/run/user/<uid>/bus` | **yes** |

A reachable Docker socket is root on the host, by design: it is an API for
creating privileged containers. A reachable ssh-agent is the user's keys,
which is exactly what `--allow-ssh` goes to the trouble of *not* handing over
— that feature multiplexes a single pre-authenticated connection inward while
`/run` was quietly offering the agent to anything that asked.

**The group-gated one is the instructive case**, because the obvious reason
to think it safe is wrong. Inside the sandbox, `id -G` reports
`1000 65534 65534` and the socket shows as `nobody nogroup`, which looks like
the `docker` group has been dropped. It has not. Entering a user namespace
changes how ids are *rendered*, not the credentials the kernel checks —
verified with a `root:docker` file at mode 640 that the sandbox read while
reporting no such group. **A sandbox reaches whatever its user can reach.**

## Implementation

[IMPLEMENTED_BY](/src/sandbox/dbus.ts)

### `/run` is a tmpfs

`buildBwrapCommand` replaces the read-only bind with `--tmpfs /run` plus
`--dir /run/user/<uid>`. Everything above becomes unreachable in one step.

Two things come back deliberately. The session bus returns through the proxy,
filtered. And `/run/user/<uid>` becomes **writable**, which silences the
stream of failures xpra, its Xvfb and `dconf` used to log against a read-only
one — a Known Gap in `xpra-gui-isolation` that this closes rather than
carries.

### The proxy

A fourth sidecar, alongside pasta, the ssh tunnel and the xpra client: a
host-side process bwrap's `--die-with-parent` does not reap, so it is
terminated in `launchSandbox`'s `finally`. It differs in starting **before**
bwrap, because its socket has to exist for the bind. The namespace reaper
added in `ide-companion` does not cover it, deliberately — it runs on the
host, which is the point of it.

Readiness comes from the proxy itself via `--fd=`, not from polling as
`waitForXpraSocket` must: the proxy writes one byte when its socket is
serving, so there is no window where the socket exists but the proxy does not
answer. Verified directly — 1 byte, socket present.

### The allowlist

`.sandbox/dbus`, one well-known name per line, `#` comments, defaults written
on first run — the same shape as `.sandbox/ports`. Everything not listed is
refused, and the sandbox sees those services as simply absent.

Two names are deliberately not defaults, and a test asserts they are not:

- `org.freedesktop.secrets` — the keyring, i.e. every stored credential
- `org.freedesktop.systemd1` — starting units outside the sandbox, i.e. an
  escape

`--log` is always on, because **a refused call has no symptom of its own**.
It presents as a menu that quietly does nothing, which is the same class of
problem as the xpra scroll regression that took a dozen rounds to find.
Without the log there is nothing to look at when a user asks why.

### Degrading

Three ways this ends up absent, all normal rather than degraded: no session
bus on the host, no `xdg-dbus-proxy` installed, or an empty allowlist. In
each case the sandbox simply has no bus.

A missing proxy **warns but does not fall back** to binding the host socket.
xpra's rule — never silently degrade to the mechanism you replaced — applies
to the fallback; the conclusion differs only in that a missing xpra is fatal
for a GUI preset while a missing bus is survivable.

## Known Gaps

- **The default allowlist is a guess.** The plan calls for deriving it by
  observation: run with `--log`, use both IDEs, read off what they ask for.
  That has not been done, and it matters — D-Bus passthrough exists in scoder
  *because* RStudio's menus came up greyed out without it, so a list that
  does not restore that reintroduces the original bug while claiming to
  improve security.
- **Not tested against a live session bus.** The proxy mechanism is verified
  (readiness, filtering, logging, an allowed name passing and a denied one
  returning `ServiceUnknown`) against a throwaway `dbus-daemon --session`.
  Whether RStudio and Eclipse are happy is unmeasured.
- **`XDG_RUNTIME_DIR` is now a fresh empty directory.** Anything expecting to
  find existing state there will not. This is the most likely source of a
  surprise from the tmpfs.
- **The system bus is simply gone.** Nothing has needed it; if something
  does, it needs its own proxy rather than a hole.
- **No reload.** `xdg-dbus-proxy` takes its filter at startup, so editing
  `.sandbox/dbus` takes effect next session. The file's header says so.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./xpra-gui-isolation.md)
[HAS_TEST](../test-scripts/validation-suite.md)
