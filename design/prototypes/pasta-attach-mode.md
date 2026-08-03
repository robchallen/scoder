---
target-version: 2.2.0
status: draft
tags: [prototype, sandbox, network, pasta, uid]
---

# Prototype: pasta Attach Mode

[IMPLEMENTED_BY](/design/prototypes/pasta-attach-mode.sh)

> **This approach was chosen.** See
> [ADR 0001](../../architecture/decision-records/0001-sandbox-uid-and-networking-composition.md)
> for the decision and its rationale: the sandbox should resemble an ordinary
> home directory rather than a root shell, and attach mode leaves room to change
> forwarded ports without restarting a session. The cheaper alternative of
> accepting uid 0 is rejected but retained.
>
> The implementation plan is
> [pasta-attach-mode-implementation](../implementation/plans/pasta-attach-mode-implementation.md),
> which is ready to build. This script rehearses the production shape and every
> design question it needed to answer is now closed.

## Purpose

Establish whether resolution option 1 in
[sandbox-uid-becomes-root](../implementation/issues/sandbox-uid-becomes-root.md)
actually works, before committing to it. That issue records that pasta's spawn
mode creates a nested user namespace which overrides bwrap's `--uid`, so the
sandboxed tool runs as uid 0.

## The Inversion

Production scoder builds one nested command:

```
bwrap --unshare-user --uid 1001 … pasta --config-net … -- <tool>
```

pasta is the last thing bwrap execs, so pasta's namespace is the innermost and
its mapping (`0 1001 1`) wins.

The prototype makes bwrap create **both** namespaces, so its own mapping is the
only one, and has pasta join from outside via its PID form:

```
bwrap --unshare-user --uid 1001 --unshare-net … <tool>     # namespaces + uid
pasta … <child-pid>                                        # attaches to the netns
```

### Closing the startup race

Naively, the tool would start before pasta attaches and see a dead network. Two
bwrap fds remove the window entirely:

| Flag | Role |
|------|------|
| `--info-fd` | bwrap writes `{"child-pid": N}` as soon as the namespaces exist |
| `--block-fd` | bwrap waits for data on this fd before exec'ing the tool |

Ordering becomes: namespaces exist → pasta attaches → tool starts. Both flags
are present in bubblewrap 0.9.0.

### Marshalling the file descriptors

`Bun.spawn` cannot pass fd 3 or above — its `stdio` is a fixed 3-tuple, and a
fourth entry fails with `Bad file descriptor`. bwrap is therefore launched
through a shell shim:

```bash
bash -c 'exec 3>"$1"; exec 9<>"$2"; shift 2; exec "$@"' _ <info> <fifo> bwrap …
```

`exec` with only redirections applies them to the shim rather than replacing it;
`exec "$@"` then runs bwrap with argv passed as **real arguments**, so nothing is
interpolated into a shell string and paths containing spaces survive. stdio
0/1/2 stay inherited, which the interactive tool needs.

The shim owns fd 9, so releasing the sandbox is a plain write to the fifo — what
the TypeScript side would do.

## Result

Every check passes:

```
host uid=1001 gid=1001, llm port=19731
bwrap child-pid: 227299
pasta pid: 227311
  uid           : 1001
  whoami        : scoder
  getpwuid home : /home/scoder
  spaced argv   : spaced-path-ok
  uid_map       :       1001       1001          1
  outbound TCP  : ok
  DNS           : resolves
  llm port      : reachable
  other loopback: blocked
killed pasta mid-session
  survived pasta teardown: yes
RESULT: all checks passed
```

Reading the significant lines:

- **`uid_map` of `1001 1001 1`** rather than the `0 1001 1` the production
  composition produces. This is the whole point.
- **`getpwuid home`** is `/home/scoder`, which attach mode does *not* achieve on
  its own — see the identity note below.
- **`outbound TCP` and `DNS` separately**, so a DNS-only failure cannot be
  mistaken for a dead network. That mistake was made on the first attempt.
- **`llm port` reachable while `other loopback` is blocked**, so `--llm-port`
  carries over to attach mode without weakening host isolation.
- **`survived pasta teardown`** — pasta was killed mid-session and the sandbox
  continued, because the netns belongs to bwrap. In spawn mode this would have
  destroyed the session. This is the property that would make changing forwarded
  ports without a restart possible later.

## Incidental Findings

**`/run` must be bound before overlaying `/etc/resolv.conf`**, because
`/etc/resolv.conf` is commonly a symlink into `/run/systemd/resolve/` and bwrap
resolves the bind destination through it. Production scoder binds `/run` for
unrelated reasons and so never encounters this. Noted because anyone trimming
the mount set could reintroduce it.

**The spaced-path bind must come after `--tmpfs /tmp`**, or the tmpfs masks it.
The first version of this prototype reported a bogus argv failure for exactly
that reason — the AGENTS.md pitfall about overlay ordering, in a new place.

## Identity Is Not Fixed by Attach Mode Alone

Worth stating plainly, because it is easy to assume otherwise: correcting the
uid does not correct `getpwuid()`. With the *host* `/etc/passwd`, uid 1001
resolves to the host home (`/home/vp22681`), which does not exist inside the
sandbox — so `~/.ssh`, the reason this was investigated, would still be wrong.

The custom `/etc/passwd` that `buildBwrapCommand` already writes supplies the
other half, and is already correct for the host uid. `/etc/group` still needs the
same treatment, and `~/.ssh` is not bound at all.

## What This Still Does Not Cover

The prototype answers every design question the implementation depends on. What
remains is production concern rather than open design, and is planned in
[pasta-attach-mode-implementation](../implementation/plans/pasta-attach-mode-implementation.md):

- **Teardown must be wired into scoder.** The prototype kills pasta explicitly.
  Production needs the same in the `finally` that already restores the
  `AGENTS.md` flag, since bwrap's `--die-with-parent` no longer reaps a pasta
  living on the host. Signal-terminated sessions still leak, which is the
  existing `no-explicit-signal-trap` debt.
- **The failure path needs a bound.** The prototype limits the child-pid wait to
  5s; an earlier version without that bound hung indefinitely on `--block-fd`
  with no diagnostic, which is exactly what production must avoid.
- **`~/.ssh` is not bound at all**, so ssh still has nothing to read even with
  resolution correct. Tracked separately; forwarding `SSH_AUTH_SOCK` is preferred
  over exposing private keys.
- **`--dry-run` will need to print both stages** or it stops describing what
  actually runs.

## Running It

```bash
./design/prototypes/pasta-attach-mode.sh
```

Exits 0 only if every check passes. Self-contained: it starts its own throwaway
listener on port 19731 for the `--llm-port` check, and cleans up its temp files,
its pasta and that listener on exit. Takes about 10s, most of it the deliberate
pause that proves the session survives pasta being killed.

[HAS_FEATURE](../features/network-isolation.md)
[HAS_FEATURE](../features/sandbox-isolation.md)
[HAS_FEATURE](../features/path-mirroring.md)
