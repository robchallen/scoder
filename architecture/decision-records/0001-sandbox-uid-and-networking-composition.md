---
target-version: 2.3.0
status: accepted
tags: [decision-record, sandbox, network, pasta, uid]
---

# 0001 — Sandbox uid and the bwrap/pasta Composition

## Context

scoder composes bwrap and pasta as a single nested command:

```
bwrap --unshare-user --uid 1001 … pasta --config-net … -- <tool>
```

pasta is the last thing bwrap execs, and pasta's spawn mode always creates a new
network **and user** namespace. That inner namespace maps inside-0 to the
caller, overriding bwrap's `--uid`, so the sandboxed tool runs as uid 0. The
symptom that surfaced it was `~/.ssh` resolving under `/root`, because OpenSSH
locates it via `getpwuid()` rather than `$HOME`.

Full analysis in
[sandbox-uid-becomes-root](../../design/implementation/issues/sandbox-uid-becomes-root.md).

## Decision

Adopt **pasta attach mode**: bwrap creates both namespaces (`--unshare-net`
alongside `--unshare-user`) so its uid mapping is the only one, and pasta joins
the existing netns from outside via its PID form.

Reject the cheaper alternative of accepting uid 0 and correcting root's NSS
identity, recorded in
[accept-root-uid-in-sandbox](../../design/implementation/plans/accept-root-uid-in-sandbox.md).

## Rationale

Two reasons, both of which outweigh the smaller diff of the rejected option:

1. **The sandbox should look and smell like an ordinary home directory.** The
   whole point of the environment is to present an LLM with as little unusual
   context as possible. Running as root is unusual: it changes tool behaviour
   (npm and friends), makes `ls -l` read as root-owned, makes permission bits
   meaningless, and leaves the agent reasoning about an environment that does
   not resemble the developer's own. A normal unprivileged user with a normal
   home is one less thing to confuse it.

2. **It leaves room to change open ports without restarting a session.** In
   attach mode the network namespace belongs to bwrap and outlives pasta, so the
   network handler is separately addressable from the sandbox. In spawn mode
   pasta *owns* the namespaces, so anything touching pasta destroys the session.
   This is a future possibility rather than a requirement — see below.

## Consequences

### Required alongside it

Attach mode fixes the uid but **not** the identity. Verified: with uid 1001 and
the host `/etc/passwd`, `getpwuid(1001)` resolves to `/home/vp22681`, which does
not exist inside the sandbox, so `~/.ssh` would still be wrong.

The custom `/etc/passwd` already written by `buildBwrapCommand` supplies the
missing half, and is already correct for this decision:

```
scoder:x:1001:1001:Sandbox User:/home/scoder:/bin/bash

  whoami        : scoder
  getpwuid home : /home/scoder
```

Note this entry would have needed rewriting to uid 0 under the rejected option.
Under this decision it stands as is. `/etc/group` still needs equivalent
handling.

Separately, and independent of either option: `~/.ssh` is not bound into the
sandbox at all, so ssh has nowhere to read from even once resolution is correct.
Forwarding `SSH_AUTH_SOCK` is preferred over binding private keys. Carried over
from the rejected plan, which retains the option analysis.

### Implementation constraints

- **`Bun.spawn` cannot pass file descriptors beyond 0/1/2.** Its `stdio` is a
  fixed 3-tuple (see [bun-spawn](../../design/refs/bun-spawn.md)); probing a
  fourth entry fails with `Bad file descriptor`. The
  race-closing design needs `--info-fd` and `--block-fd`, so bwrap must be
  launched through a shell shim that opens those descriptors itself, with
  stdio 0/1/2 still inherited for the interactive tool. Verified working; this
  is the shape the prototype already uses, so the prototype is close to the
  implementation.
- **pasta teardown becomes scoder's problem.** pasta now runs on the host, so
  bwrap's `--die-with-parent` no longer covers it. `pasta -P/--pid FILE` writes
  a usable pid; verified that killing it mid-session leaves the sandbox running,
  because the netns belongs to bwrap. An orphaned pasta per session would be a
  bad regression, so this must be wired into session exit.
- **Failure path.** If pasta never attaches, the sandbox blocks on `--block-fd`
  indefinitely — observed directly. Needs a bounded wait and a clear error.
- **`--llm-port` carries over.** Verified: `--tcp-ns <port>` is reachable from
  inside while other host loopback ports stay blocked.

All of these are settled and planned in
[pasta-attach-mode-implementation](../../design/implementation/plans/pasta-attach-mode-implementation.md),
which is ready to build.

### On the port-reconfiguration possibility

Recorded as motivation, not a commitment. pasta has no runtime reconfiguration
interface — no signal or control socket for changing forwarded ports — so this
would mean terminating pasta and attaching a fresh one with different options to
the same still-running netns, with a brief connectivity gap. Attach mode makes
that *possible*; spawn mode makes it impossible. No further design work done.

## Status of the Tracking Test

`sandbox-uid-preserved` in the validation suite is marked `test.failing` and
asserts the uid inside the sandbox equals the host uid. Under this decision that
is the target behaviour, so the test stays as is and the `.failing` marker comes
off when the composition is implemented.

`sandbox-uid-maps-to-host-user` stays valid either way.

## Alternatives Considered

| | Attach mode (chosen) | Accept uid 0 (rejected) |
|---|---|---|
| uid inside | host uid | 0 |
| Environment resembles a real home | yes | no — root, with root's quirks |
| Change size | shell shim plus two-stage startup | passwd/group file plus binds |
| Room for later port changes | yes | no |
| Open risks | teardown, `--llm-port` | whether presets tolerate root |

The rejected plan is retained rather than deleted: its `/etc/group`, ssh
material and temp-file items apply to this decision too.

[HAS_FEATURE](../../design/features/network-isolation.md)
[HAS_FEATURE](../../design/features/sandbox-isolation.md)
