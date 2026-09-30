---
target-version: 2.5.0
status: draft
tags: [feature, sandbox, tmp, cleanup]
---

# Session Temp Root

## Summary

Everything scoder stages on the host for a sandbox to consume lives under a
single per-run directory, `/tmp/scoder-<id>`, where `<id>` is 8 hex
characters. Inside it, a staged artifact's host path mirrors the absolute
sandbox path it will be bound at:

```
/tmp/scoder-3f9a1c04/etc/passwd              -> /etc/passwd
/tmp/scoder-3f9a1c04/etc/group               -> /etc/group
/tmp/scoder-3f9a1c04/etc/resolv.conf         -> /etc/resolv.conf
/tmp/scoder-3f9a1c04/home/<user>/.agents     -> ~/.agents
/tmp/scoder-3f9a1c04/home/<user>/.local/bin  -> ~/.local/bin
/tmp/scoder-3f9a1c04/home/<user>/.ssh/config -> ~/.ssh/config
/tmp/scoder-3f9a1c04/.host/launch/           -> (never bound; host-side only)
```

The root is removed when the session ends, on every exit path.

## Motivation

Each staged artifact used to invent its own `/tmp/scoder-<concern>.XXXXXX`
directory — seven of them — with independent, and in two cases absent,
cleanup. `~/.local/bin` and the AGENTS.md overlay were never removed at all:
see `scoder-local-bin-staging-dirs-leak-into-tmp`, which measured 374 MB per
snapshot, ~40 accumulating during a single test run, and `/tmp` filling to
100% and failing the run. On the development host where this was implemented
there were 6,919 abandoned `scoder-local-bin.*` directories and 6,044
`scoder-agents-md.*` ones.

Cleanup being per-concern was the structural cause: each new staged artifact
needed someone to remember to add a matching teardown, and the two that
mattered most were the two nobody did. One root makes cleanup a property of
the scheme rather than of each call site.

The mirrored layout is the second half. `source` and `dest` were previously
invented independently by each call site; `source = sessionPath(dest)` is now
an invariant one helper holds. A live session is also inspectable in one
place, shaped like the sandbox it feeds.

## Implementation

[IMPLEMENTED_BY](/src/utils/session.ts)

- `sessionPath(dest)` — the host path for something bound at `dest`
- `stageDir(dest)` / `stageFile(dest)` — the same, created (`stageFile`
  creates the parent only; the caller writes the file)
- `hostScratchPath(...)` / `stageHostScratchDir(...)` — a reserved `.host/`
  subtree for artifacts with **no** sandbox-side path to mirror, because they
  are never bound in: the `--info-fd`/`--block-fd` fifos and pasta's pid file
- a process `exit` handler that `rmSync`s the root, `force: true` — see
  below

Call sites: `setupSandboxIdentity` (`identity.ts`), the AGENTS.md overlay and
the `~/.local/bin`, `~/.agents` and `resolv.conf` staging
(`git/protection.ts`), `startSshTunnel` (`sandbox/ssh.ts`), and
`launchSandbox`'s rendezvous directory (`sandbox/launch.ts`).

### The id is 8 hex characters, not a UUID

A unix socket path is usable to 107 bytes and fails at 108 (verified
directly), and staged artifacts include sockets: ssh's `ControlMaster` socket
under `~/.ssh-control`, and xpra's under the planned GUI isolation work. Since
the host path is the sandbox path plus the root prefix, the prefix is spent
directly out of that budget. A 36-character UUID leaves roughly 18 bytes of
headroom for a realistic `$HOME`-based destination, which a longer username
would spend; 8 hex characters leaves room to spare.

The `scoder-` prefix is kept so the root stays identifiable among everything
else in `/tmp` — greppable when debugging, and the precondition for any future
reaper of roots left behind by killed sessions.

### Cleanup is one exit handler, not a teardown step

`utils/session.ts` registers a single `process.on("exit")` handler and no
call site unstages anything.

scoder exits through `process.exit()` in about twenty-five places — argument
errors, every protection-config rejection, an unreachable exec target, a
failed ssh master, `--dry-run`, and the normal end of a session — and
`process.exit()` terminates synchronously, so pending `finally` blocks and
anything awaited in them do not run. A teardown step in `main()`'s `finally`
would therefore miss most exits, and adding a call to each site would
reproduce exactly the per-site fragility this feature removes: the leak it
fixes happened because two staging call sites out of seven never had their
teardown written.

It follows that cleanup is `rmSync`, not `rm` — an `exit` handler runs
synchronously and anything awaited inside one is dropped — and that `force`
is load-bearing rather than convenient, since most of these exits happen long
before a full session has staged anything and the root is usually partial or
absent.

Running at process exit also fixes an ordering constraint rather than
creating one: closing the ssh master politely is `ssh -O exit -S
<controlPath>`, and that control socket is under the root, so the root must
outlive `stopSshTunnel`. It now always does.

**Not covered:** `SIGKILL`, which cannot be handled, and anything else that
stops the process without an exit — those leave a root behind. Measured on a
full `bun test` run of the validation suite: 14 roots survived before the
handler was introduced, 1 after, that one containing a bare empty `etc/` from
a session killed mid-staging. The `scoder-` prefix on the root is what makes
a future reaper for these possible.

### SCODER_KEEP_SESSION_TMP

Set to any value, this makes the exit handler log where the root is and leave
it in place.
Staging is the part of a session that otherwise leaves no trace: what scoder
decided to put in front of the sandbox was only visible while it ran, and
`--dry-run` cleaning up behind itself means "run it and look at what it built"
needs an opt-out. Two validation-suite tests use it to read staged files back
after scoder has exited.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./local-bin-resolution.md)
[HAS_FEATURE](./path-mirroring.md)
[HAS_TEST](../test-scripts/validation-suite.md)
