---
target-version: 2.8.0
status: draft
tags: [plan, sandbox, dbus, security, ide]
---

# Filter D-Bus Through xdg-dbus-proxy

## Goal

Close the last documented hole in GUI isolation. [ADR
0003](/architecture/decision-records/0003-xpra-gui-isolation.md) says plainly
that moving to xpra closed the largest channel and not the last one:

> `guiDisplayBinds` still passes `XDG_RUNTIME_DIR` and
> `DBUS_SESSION_BUS_ADDRESS` through, and `buildBwrapCommand` still binds
> `/run` read-only, which is how the sandbox reaches the host's session bus.

This plan is that work. It started from a sketch which had the right
mechanism — `xdg-dbus-proxy`, as flatpak uses it — and three things worth
correcting, each of which changes the shape of the job. It then gained a
fourth decision the sketch did not reach at all: where the allowlist lives
(Decision 2), which turns out to matter more than any individual entry in
it.

## What is actually exposed, which is more than the sketch assumed

**Every sandbox, not just GUI ones.** The sketch frames this as something to
fix in `guiDisplayBinds`. But `buildBwrapCommand` binds `/run` read-only for
*every* sandbox (`src/sandbox/builder.ts`), and the session bus lives at the
well-known path `/run/user/<uid>/bus`. Only the *convenience* of
`DBUS_SESSION_BUS_ADDRESS` is GUI-scoped; the socket itself is reachable from
`scoder pi` as readily as from `scoder --ide rstudio pi`, by any process
willing to compute the path. So the fix belongs in `buildBwrapCommand`, and
its blast radius is every session rather than two presets.

**The system bus too.** `/run/dbus/system_bus_socket` arrives on the same
bind. It is a different bus with different services, and nothing in scoder
has ever needed it.

**What actually depends on `/run` inside the sandbox** is narrow, which is
what makes this tractable. Checked directly: the only in-sandbox uses are the
GUI presets' `XDG_RUNTIME_DIR` passthrough, and no test in the suite
references `/run` at all. `protection.ts` reads
`/run/systemd/resolve/resolv.conf`, but on the *host* at setup time, so it is
unaffected.

## Verified Groundwork

Checked before writing this, rather than assumed:

| Claim | Result |
|---|---|
| `xdg-dbus-proxy` is packaged | **Yes** — 0.1.7-1 on this distribution, not installed by default. |
| A `--ro-bind` unix socket still accepts `connect()` | **Yes** — tested directly in a bwrap sandbox. A read-only *mount* does not prevent connecting, because `connect()` is checked against the socket inode's own permission bits, which the bind preserves. This was the one scoder-specific risk in the sketch's mechanism. |
| The proxy can report readiness without polling | **Yes** — `--fd=N`, which flatpak uses for exactly this. Better than the socket-polling `waitForXpraSocket` has to do. |
| The proxy can report what an application asks for | **Yes** — `--log`. This is what makes the allowlist measurable instead of guessed. |
| Filter verbs available | `--filter`, `--talk=`, `--see=`, `--own=`, `--call=`, `--broadcast=`, plus `--sloppy-names`. |
| `/run` is bound for every sandbox, not only GUI ones | **Yes** — `buildBwrapCommand`, unconditional on `dirExists("/run")`. |
| Anything in the test suite depends on `/run` | **No** — zero references. |

Not verified, and needing a real desktop: whether the session bus genuinely
offers an escape on the reporting machine (`org.freedesktop.systemd1`'s
`StartTransientUnit` would run a process outside the sandbox), and what
RStudio and Eclipse actually call. This container has no session bus.

## Design Decisions

### 1. `--tmpfs /run`, not a narrower patch — and it pays for itself

The sketch is right that the host's `/run` should stop being bound. Worth
stating what else that buys, because it is not only a security change:
`/run/user/<uid>` becomes **writable**, and a documented pile of noise goes
away with it. From `xpra-gui-isolation`'s Known Gaps:

> both sides log a steady stream of failures writing under `/run/user/<uid>/`:
> xpra's own session files and pid files, the client's mmap file, and —
> loudest — `dconf`, which emits a `dconf-CRITICAL` per attempt

All of those are "the directory is read-only". A tmpfs fixes them. That entry
can be deleted rather than carried.

The risk is the unknown: something under `/run` that a sandboxed tool
legitimately reads and nobody has thought of. Mitigated by the narrow
dependency surface above, and by sequencing (Decision 9).

### 2. The allowlist is a project file, not a constant

The same shape as `.sandbox/ports` and `.sandbox/readonly`: deny by default, allow
what a read-only file in the repo names, log what was refused, and let the
user edit that file from outside the sandbox. It is the mechanism this
project already uses twice for exactly this problem — a capability that must
be narrow by default but that some projects legitimately need widened — and
D-Bus fits it better than either, because the right allowlist is genuinely
per-project.

**Born as `.sandbox/dbus`, not `.agentdbus`.** There is a pending migration of
every `.agent*` file into a `.sandbox/` directory (see
`sandbox-config-directory`), and adding a fourth file to a convention that is
about to be replaced would mean renaming it before anyone had used it. This
plan therefore assumes that migration lands **first**. If it does not, this
becomes `.agentdbus` and migrates with the rest.

The file holds well-known bus names, one per line, `#` comments, same as
`.sandbox/ports`:

```
# Services this project's tools may talk to on the session bus.
org.freedesktop.Notifications
org.freedesktop.portal.Desktop
```

Three things follow from reusing the pattern rather than inventing one:

- **Sane defaults, written on first run**, as `.sandbox/readonly` does — so the
  common case needs no action and the file documents itself by existing.
- **Self-protecting**, which under `.sandbox/` is free: the whole directory
  is bound read-only, so the sandbox cannot widen its own permissions.
- **A denial has somewhere to point.** When a call is refused, the message
  can name the file and the line to add, which is the difference between a
  menu that mysteriously does nothing and a one-line fix.

Whether to re-read it mid-session, as `.sandbox/ports` is watched, is an open
question. `xdg-dbus-proxy` takes its filter at startup and has no reload, so
honouring a change would mean restarting the proxy and reconnecting every
client — probably not worth it. Say so in the file's header rather than
leaving the user to wonder why their edit did nothing.

### 3. Derive the defaults by observation, not by guessing

The sketch proposes `org.freedesktop.Notifications`,
`org.freedesktop.portal.Desktop` and `org.freedesktop.portal.Documents`. That
is a reasonable starting point and it is still a guess, and the cost of
guessing wrong is specific: D-Bus passthrough exists in scoder *because*
RStudio's menus came up greyed out without it (see `tool-presets`). An
allowlist that does not restore that reintroduces the original bug while
claiming to improve security.

So: run the proxy with `--log` and a deliberately permissive filter, use both
IDEs normally for a while, and read off what they actually ask for. That list
becomes the *default* `.sandbox/dbus` content, and a project needing more can
add to it. Confirm RStudio's menus still work before calling it done. `--log` exists for
this; it should be used rather than reasoned around.

**Record the resulting list with its justification**, in the default file's
own comments as well as the ADR. Each entry should say which application
needs it and what breaks without it, because the next person to look will
otherwise have no way to tell a load-bearing entry from a defensive one — and
because the file is the thing they will actually be reading when something
is refused.

### 4. Default deny, including the system bus

`--filter` denies everything not named. The system bus gets no proxy at all
unless something turns out to need it, which nothing yet has.

Worth naming what default-deny costs: a D-Bus call that is silently dropped
produces an application-level symptom with no obvious cause — a menu that
does nothing, a dialog that never opens. That is the same class of problem as
the xpra scroll bug, which took a dozen rounds to find. **The proxy's `--log`
output should therefore be kept somewhere discoverable for a GUI session**,
not discarded, so the first question after "the file picker stopped working"
has an answer.

### 5. The proxy is a fourth sidecar, and should look like the other three

pasta, the ssh tunnel and the xpra client already share a shape: a host-side
process that bwrap's `--die-with-parent` does not reap, started around the
sandbox's lifecycle and terminated explicitly in `launchSandbox`'s `finally`
via `terminateProcess`. The proxy is the same thing again and should reuse
it rather than invent a fourth lifecycle.

Two differences from the sketch's bash:

- It must start **before** bwrap, because the socket has to exist for the
  bind. That is unlike the xpra client, which must start after.
- Readiness comes from `--fd=`, not from polling. The proxy writes to the
  descriptor when the socket is ready. scoder already has the machinery for
  passing an fd to a child — `wrapWithFdShim` does it for bwrap's
  `--info-fd`/`--block-fd`.

The namespace reaper added in `ide-companion` does **not** cover this: the
proxy runs on the host, outside the sandbox's mount namespace, by design.

### 6. Socket placement

Under the session root, which already owns every staged artifact and is
removed by the exit handler. The sandbox-side path is scoder's choice, since
`DBUS_SESSION_BUS_ADDRESS` is set to match — there is no same-path constraint
like xpra's mmap file.

The 107-byte unix socket limit applies (see `session-temp-root`).
`/tmp/scoder-<8 hex>/dbus/bus` is 29 bytes, so there is no issue, but it is
the reason not to put it under `$HOME`.

Inside, it should appear at `/run/user/<uid>/bus` — the path everything
expects — which the `--tmpfs /run` makes a writable mountpoint rather than
the read-only one that would otherwise need scaffolding.

### 7. Degrade cleanly on a host with no D-Bus

A headless server has no session bus. The proxy must simply not start, no
`DBUS_SESSION_BUS_ADDRESS` is set, and nothing warns — this is the normal
case for `scoder pi` on a build machine, not a degraded one.

### 8. A missing proxy binary: skip, do not fall back

`xpra`'s Decision 7 was that a missing binary is a hard failure, because
falling back to the mechanism it replaced would silently withdraw the
isolation the user believes they have. The same reasoning applies to the
*fallback*: if `xdg-dbus-proxy` is missing, scoder must **not** bind the raw
bus.

But the conclusion differs, because D-Bus is optional where a display is not.
A GUI preset without xpra cannot work at all; a sandbox without D-Bus mostly
can. So: no proxy, no bus, a one-line warning naming what is degraded, and
the session proceeds. `--install-dependencies` should add `xdg-dbus-proxy`
alongside the rest.

### 9. Sequence it, because this one touches every session

The xpra work was preset-scoped: a bug could only affect someone who ran
`--ide`. This changes `/run` for every sandbox scoder has ever started, and
the failure mode is a silently dropped call rather than a crash.

Suggested order:

1. `--tmpfs /run` alone, with no proxy and no bus at all. Small, and it
   independently fixes the `/run/user` write failures. Run both IDEs.
2. Proxy with a permissive filter and `--log`, to collect the real call list.
3. Tighten the filter to what was observed; confirm RStudio's menus.
4. `--install-dependencies`, docs, ADR 0004, tests.

An escape hatch worth having throughout, matching the xpra precedent:
`SCODER_DBUS_ARGS` appending to the proxy's own arguments, so a user can add
a `--talk=` without waiting for a release.

## Changes Required

### `src/sandbox/builder.ts`

- Replace `--ro-bind /run /run` with `--tmpfs /run`, plus `--dir
  /run/user/<uid>` so the bus mountpoint and `XDG_RUNTIME_DIR` exist.
- Bind the proxy socket at `/run/user/<uid>/bus` when there is one.

### `src/sandbox/dbus.ts` (new)

Mirroring `src/sandbox/xpra.ts`, which is the closest existing sibling:

- `dbusSocketPath()` — host side, under the session root
- `buildDbusProxyArgs(allowlist)` — split out so `--dry-run` can print it
  without starting anything, as `buildPastaArgs` and `buildXpraClientArgs` are
- `startDbusProxy()` — spawn, wait on `--fd=`, return a sidecar or null
- `stopDbusProxy()` — `terminateProcess`, same grace periods as pasta

### `src/git/protection.ts`

- Read and validate `.sandbox/dbus`, writing the default on first run —
  alongside the existing `.sandbox/ports` and `.sandbox/readonly` readers, which it
  should look like.

### `src/tools/presets.ts`

- `guiDisplayBinds` stops passing `DBUS_SESSION_BUS_ADDRESS` through; the
  value now points at the proxy and is set centrally.
- `XDG_RUNTIME_DIR` can stay, but now refers to a writable tmpfs path rather
  than the host's directory — which is what fixes the mcptools workaround
  (`MCPTOOLS_SOCKET_DIR=/tmp/mcptools`, added because `/run/user/<uid>` was
  read-only). That workaround should be revisited once this lands.

### `src/sandbox/launch.ts`

- Start the proxy before bwrap; stop it in the same `finally` as pasta, the
  ssh tunnel and the xpra client.

### Docs

- **ADR 0004**, recording what the allowlist admits and why. ADR 0003's
  "what it does not close" paragraph should then point at it.
- `design/features/dbus-isolation.md`
- `xpra-gui-isolation`'s Known Gaps entry for `/run/user` write failures can
  be deleted once Decision 1 lands.
- `skills/working-in-a-scoder-sandbox/SKILL.md` — an agent should know the
  bus is filtered, and where the log is.

### Tests

- A negative structural test: no `/run/user/<uid>/bus` from the host, and no
  `--ro-bind /run /run`, in the built command. That is the security claim, and
  it is the one a future change could silently undo — the direct analogue of
  `gui-preset-binds-xpra-socket-not-host-x11`.
- `--dry-run` coverage of the proxy argv.
- An end-to-end test if a session bus can be stood up in CI: start
  `dbus-daemon --session`, run a sandbox, assert an allowed name resolves and
  a denied one does not.

## Open Questions

- **What do RStudio and Eclipse actually need?** The whole of Decision 3.
  Nothing else should be settled before this is measured.
- **Is the escape real on a live desktop?** The sketch asserts
  `org.freedesktop.systemd1` and `flatpak-spawn` give a trivial escape. It is
  plausible and worth confirming once, because it is the sentence that
  justifies the work — and because an unverified claim in an ADR is worse
  than no claim.
- **Does anything legitimately need the system bus?** Assume not; find out
  from `--log`.
- **Is `XDG_RUNTIME_DIR` on a tmpfs enough for the IDEs?** It becomes a fresh
  empty writable directory rather than the host's, so anything expecting to
  find existing state there will not. That is the most likely source of a
  surprise from Decision 1.
