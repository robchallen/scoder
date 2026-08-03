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
> Not yet implemented — this remains a prototype.

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

## Result

Verified working:

```
host uid=1001 gid=1001
bwrap child-pid: 404007
  uid inside : 1001
  uid_map    :       1001       1001          1
  interfaces : lo enp0s31f6
  TCP to 1.1.1.1:443 : ok
  DNS        : resolves
RESULT: uid preserved and networking works
```

The `uid_map` is the whole point: `1001 1001 1` rather than the `0 1001 1` that
the production composition produces. Connectivity is checked by raw TCP to an IP
*and* by DNS, so a DNS-only failure cannot be mistaken for a dead network.

## Incidental Finding

The prototype must bind `/run` before overlaying `/etc/resolv.conf`, because
`/etc/resolv.conf` is commonly a symlink into `/run/systemd/resolve/` and bwrap
resolves the bind destination through it. Production scoder binds `/run` for
unrelated reasons and so never encounters this. Noted because anyone trimming
the mount set could reintroduce it.

## What This Does Not Prove

The prototype validates the mechanism, not a production implementation. Open
before adopting:

1. **pasta lifetime and teardown.** pasta now runs on the host, outside the
   sandbox, so bwrap's `--die-with-parent` no longer covers it. The prototype's
   pasta did exit along with the netns, but that is a single observation, not a
   guarantee — an orphaned pasta per session would be a bad regression. pasta
   offers `-P, --pid FILE`; production should write a PID file and terminate it
   explicitly on session exit.
2. **Port forwarding.** `--tcp-ns` / `--udp-ns` are documented independently of
   invocation mode, so the `--llm-port` feature should carry over, but the
   prototype does not exercise it. Worth a direct test before relying on it.
3. ~~**Orchestration from Bun.**~~ **Resolved.** `Bun.spawn`'s `stdio` is a fixed
   3-tuple and cannot pass fd 3 or above — a fourth entry fails with
   `Bad file descriptor`. This does not block the approach: a `bash -c` shim can
   open the descriptors itself while stdio 0/1/2 stay inherited for the
   interactive tool, which is verified working and is exactly what this
   prototype already does. So the shell script here is close to the shape the
   implementation needs, rather than a throwaway harness.
4. **Failure paths.** What happens if pasta fails to attach: the sandbox is
   currently left blocked on `--block-fd` forever. Production needs a timeout
   and a clear error.

5. **Identity, not just uid.** The prototype binds the host `/etc/passwd`, so
   `getpwuid(1001)` resolves to the *host* home (`/home/vp22681`), which does not
   exist inside the sandbox. Attach mode fixes the uid; it does not by itself fix
   `~/.ssh`. The custom `/etc/passwd` that `buildBwrapCommand` already writes
   supplies the other half and is already correct for uid 1001 — verified giving
   `whoami: scoder` and `getpwuid home: /home/scoder`. `/etc/group` still needs
   equivalent treatment, and `~/.ssh` itself is not bound at all. See
   [ADR 0001](../../architecture/decision-records/0001-sandbox-uid-and-networking-composition.md).

## Running It

```bash
./design/prototypes/pasta-attach-mode.sh
```

Exits 0 only if the uid is preserved *and* outbound TCP and DNS both work. Self
-contained; creates nothing outside `mktemp` files.

[HAS_FEATURE](../features/network-isolation.md)
[HAS_FEATURE](../features/sandbox-isolation.md)
[HAS_FEATURE](../features/path-mirroring.md)
