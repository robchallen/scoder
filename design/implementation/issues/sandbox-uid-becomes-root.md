---
target-version: 2.2.0
status: draft
tags: [issue, sandbox, network, pasta, uid]
---

# Sandbox Reports uid 0 (root) Instead of the Host uid

## Summary

`id -a` inside a scoder sandbox reports `uid=0(root) gid=0(root)`, not the
host user's uid. scoder computes the correct uid and passes it to bwrap, and
bwrap applies it correctly — but `pasta` runs *inside* the bwrap sandbox and
creates a **second, nested user namespace** that remaps the process to uid 0.

## Root Cause

pasta's spawn mode is documented as:

> Without PID or `--netns`, run the given command or a default shell in a new
> network **and user namespace**, and connect it via pasta.

scoder's command is `bwrap … pasta … -- <tool>`, so pasta is the last thing
bwrap execs and the tool is pasta's child. bwrap's user namespace is therefore
the *parent* of pasta's, and pasta's mapping wins.

Isolated empirically:

```
$ bwrap … --unshare-user --uid 1001 --gid 1001 /bin/bash -c 'id -a'
uid=1001(vp22681) gid=1001(vp22681)                    # bwrap is correct

$ bwrap … --unshare-user --uid 1001 --gid 1001 pasta … -- /bin/bash -c 'id -a'
uid=0(root) gid=0(root)                                # pasta overrides it
```

The two `/proc/self/uid_map` values show exactly what happens:

```
bwrap only:     1001  1001  1      # inside-1001 → host-1001
bwrap + pasta:     0  1001  1      # inside-0    → host-1001
```

pasta needs to be root *within its own namespace* to create the tap device and
configure the interface, so it maps the caller to 0.

## Impact

**Ownership is not affected.** Because pasta maps inside-0 back to the caller,
files created in the sandbox are owned by the real host user:

```
in-sandbox: uid 0    →    on host: 1001(vp22681)
```

So this is a compatibility and correctness-of-appearance problem, not a
privilege or permissions one:

- Tools that refuse to run as root, or change behaviour when `id -u` is 0
  (npm, some package managers and linters), misbehave for no real reason
- It contradicts the rest of the sandbox identity, which scoder sets
  deliberately: `HOME=/home/scoder`, `USER=scoder`, `LOGNAME=scoder`
- Anything writing to `~` by way of uid lookup rather than `$HOME` may target
  `/root`

## Why the Obvious Fixes Do Not Work

Confirmed by testing, so these are not re-tried:

1. **`--uid` / `--gid` on bwrap** — already correct; pasta overrides them
   afterwards. Changing how scoder computes the uid cannot help. (`SUDO_UID`
   handling was added while chasing this; it is unrelated to the cause.)
2. **`pasta --runas 1001:1001`** — still reports uid 0 inside. `--runas`
   applies to the pasta network handler process, which drops to `nobody`, not
   to the spawned command.
3. **Reversing the nesting** (`pasta … -- bwrap --unshare-user --uid 1001 …`) —
   fails outright:
   ```
   Couldn't write to /proc/self/uid_map: Operation not permitted
   Couldn't configure user mappings
   clone: Operation not permitted
   ```
   pasta's namespace maps exactly one uid (`0 1001 1`), so a nested bwrap has no
   1001 available to map to.

## Possible Resolutions

Each is a structural change to how pasta and bwrap compose, not a flag tweak.

1. **pasta attach mode** — `pasta [OPTION]... PID`. Have bwrap create the
   namespaces (`--unshare-net --unshare-user --uid <host uid>`) and attach
   pasta from outside by PID. Keeps bwrap's uid mapping authoritative.

   **Prototyped and working** — see
   [pasta-attach-mode](../../prototypes/pasta-attach-mode.md). The uid comes out
   as the host uid with `uid_map` of `1001 1001 1`, and both raw TCP and DNS
   work. The startup race is closed with bwrap's `--info-fd` (which publishes
   the child PID) and `--block-fd` (which holds the exec until pasta has
   attached), so there is no window without networking.

   Remaining unknowns before adopting: pasta teardown now that it lives outside
   the sandbox and `--die-with-parent` no longer covers it; whether `Bun.spawn`
   can pass the two extra file descriptors this needs; and `--llm-port`
   forwarding, which the prototype does not exercise.
2. **pasta netns mode** — `pasta --netns <path>`, servicing a pre-created
   persistent network namespace that bwrap joins. bwrap cannot join a netns by
   path on its own, so this needs `nsenter`, plus netns lifecycle management
   and cleanup.
3. **Accept uid 0 and fix the identity instead** — make `getpwuid(0)` resolve to
   `/home/scoder` so `~/.ssh` and similar land correctly, rather than trying to
   avoid uid 0. Cheapest by a wide margin: a corrected `/etc/passwd` entry plus
   a few binds. Written up as
   [accept-root-uid-in-sandbox](../plans/accept-root-uid-in-sandbox.md), with
   the core change verified. Leaves tools that branch on `id -u` misbehaving,
   which is the open question there.

**Option 1 is chosen** — see
[ADR 0001](/architecture/decision-records/0001-sandbox-uid-and-networking-composition.md).
The deciding arguments were not diff size, which favours option 3, but that the
sandbox should present an ordinary home directory rather than a root shell, and
that attach mode leaves room to change forwarded ports without restarting a
session. Option 3 is rejected and retained, since its `/etc/group`, ssh-material
and temp-file items apply to option 1 as well.

Note that option 1 fixes the uid but not the *identity*: `getpwuid` still needs a
passwd entry pointing at `/home/scoder`, or `~/.ssh` remains wrong. The entry
scoder already writes is correct for uid 1001.

## Testing

[HAS_TEST](../../test-scripts/validation-suite.md)

`sandbox-uid-preserved` is marked `test.failing`: it asserts the *desired*
behaviour, so it passes while the bug exists and starts failing as soon as the
composition is fixed, prompting removal of the `.failing` marker.

`sandbox-uid-maps-to-host-user` pins the property that makes this survivable —
files created in the sandbox are owned by the host user. That must keep holding
through any fix.

[IMPACTS](/src/sandbox/builder.ts)
[HAS_FEATURE](/design/features/network-isolation.md)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
