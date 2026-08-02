---
target-version: 2.2.0
status: draft
tags: [prototype, sandbox, network, pasta, uid]
---

# Prototype: pasta Attach Mode

[IMPLEMENTED_BY](/design/prototypes/pasta-attach-mode.sh)

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
3. **Orchestration from Bun.** This needs bwrap to inherit two extra file
   descriptors beyond stdio. Whether `Bun.spawn` can pass arbitrary fds needs
   checking; if it cannot, the sequencing has to be arranged another way. This
   is the main implementation risk and should be settled first — it is cheap to
   test and would invalidate the approach.
4. **Failure paths.** What happens if pasta fails to attach: the sandbox is
   currently left blocked on `--block-fd` forever. Production needs a timeout
   and a clear error.

## Running It

```bash
./design/prototypes/pasta-attach-mode.sh
```

Exits 0 only if the uid is preserved *and* outbound TCP and DNS both work. Self
-contained; creates nothing outside `mktemp` files.

[HAS_FEATURE](../features/network-isolation.md)
[HAS_FEATURE](../features/sandbox-isolation.md)
[HAS_FEATURE](../features/path-mirroring.md)
