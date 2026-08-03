---
target-version: 2.3.0
status: ready
tags: [plan, sandbox, network, pasta, uid]
---

# Implementing pasta Attach Mode

> **Ready to implement.** Every design question is closed and each answer is
> verified by [pasta-attach-mode](../../prototypes/pasta-attach-mode.sh), which
> rehearses the production shape and exits 0. Decision and rationale in
> [ADR 0001](../../../architecture/decision-records/0001-sandbox-uid-and-networking-composition.md);
> the defect in [sandbox-uid-becomes-root](../issues/sandbox-uid-becomes-root.md).

## Goal

Stop pasta overriding bwrap's `--uid`, so the sandboxed tool runs as the host
user with a home directory that resolves correctly through both `$HOME` and
`getpwuid()`.

## The Change in One Line

From one nested command:

```
bwrap --unshare-user --uid 1001 …            pasta --config-net … -- <tool>
```

to two stages, where bwrap owns both namespaces and pasta joins from outside:

```
bash -c 'exec 3>"$1"; exec 9<>"$2"; shift 2; exec "$@"' _ <info> <fifo> \
  bwrap --unshare-user --uid 1001 --unshare-net … --info-fd 3 --block-fd 9 <tool>
pasta … -P <pidfile> <child-pid>
```

## Settled Design Questions

All verified by the prototype; none need re-litigating during implementation.

| Question | Answer |
|---|---|
| Does bwrap's uid survive? | Yes. `uid_map` is `1001 1001 1`, not `0 1001 1` |
| How is the child pid obtained? | `--info-fd`, which emits `{"child-pid": N}` |
| How is the startup race closed? | `--block-fd`; bwrap waits before exec'ing the tool |
| Can `Bun.spawn` pass fd 3+? | **No** — `stdio` is a fixed 3-tuple. Use a shell shim |
| Is argv safe through the shim? | Yes — `exec "$@"`; a path with spaces survives |
| Does `--llm-port` still work? | Yes — `--tcp-ns <port>` reachable, other loopback blocked |
| Can pasta be reaped? | Yes — `-P <pidfile>`, then kill on exit |
| Does the sandbox survive pasta dying? | Yes — the netns is bwrap's, session continues |
| Is the identity correct? | Only with the custom passwd: `whoami scoder`, home `/home/scoder` |

## Work Items

### 1. Split `buildBwrapCommand` into two commands

`src/sandbox/builder.ts` currently returns one argv ending in
`pasta … -- <tool>`. It must return both stages instead:

```typescript
export interface SandboxCommand {
	sandbox: string[];   // the shim + bwrap + tool
	pastaArgs: string[]; // everything except the trailing child pid
}
```

- Drop `pasta` and its flags from the bwrap argv; keep the flag *construction*,
  since `--tcp-ns` / `--udp-ns` handling is unchanged.
- Add `--unshare-net` next to `--unshare-user`.
- Add `--info-fd 3 --block-fd 9`.
- Prepend the shim: `["bash", "-c", SHIM_SCRIPT, "_", infoPath, fifoPath]`.
  Pass bwrap and its args as ordinary argv after that — never interpolate them
  into the shell string.

`collectBindDests` operates on the bwrap argv and keeps working unchanged, so
the `$HOME`-tool pre-flight in `src/index.ts` is unaffected.

### 2. Orchestrate the two stages in `src/index.ts`

Replacing the single `Bun.spawn(bwrapCmd)`:

1. Create the info file and the block fifo (`mkfifo`, via `Bun.spawn`).
2. Spawn the shim with `stdio: ["inherit", "inherit", "inherit"]` — unchanged
   for the interactive tool.
3. Poll the info file for `{"child-pid": N}`, bounded (see item 3).
4. Spawn pasta with `-P <pidfile>` and the child pid as its final argument.
5. Confirm the pid file is non-empty; fail loudly if not.
6. Release the sandbox by writing to the fifo — a plain `Bun.write(fifoPath,
   "go")`, since the shim owns fd 9, not scoder.
7. `await proc.exited` as now.

### 3. Failure handling

The prototype demonstrates the failure mode: with no release, the sandbox blocks
on `--block-fd` indefinitely and the session hangs with no diagnostic.

- Bound the child-pid wait (prototype uses 5s) and on timeout kill the shim and
  report that bwrap never published a pid.
- If pasta fails to attach or writes no pid file, kill the shim rather than
  releasing it into a network-less sandbox.
- Every path that abandons the sandbox must also remove the temp files.

### 4. Teardown

pasta now runs on the host, so bwrap's `--die-with-parent` no longer reaps it.
An orphaned pasta per session would be a bad regression — spawn-mode pastas have
already been observed outliving their command by ~an hour.

- Kill the pid from `-P` in the same `finally` that currently calls
  `removeGitExclude`, which is the block reached on the normal exit path now
  that `process.exit()` sits outside the `try`.
- Remove the info file, fifo and pid file there too.
- Signal-terminated sessions still leak; that is the existing
  `no-explicit-signal-trap` debt, now with one more reason to fix it.

### 5. Complete the identity

Attach mode fixes the uid but not NSS resolution. The passwd entry
`buildBwrapCommand` already writes is correct for the host uid, so only the
gaps remain:

- Write `/etc/group` for the host gid, which currently has no handling.
- Build both from a copy of the host file rather than emitting a single line —
  the current one-line passwd discards `nobody` and everything else.
- Replace the fixed `bwrap_passwd_${uid}` temp path: predictable, in shared
  `/tmp`, never cleaned up, and it collides between concurrent sessions.

Carried over from the rejected
[accept-root-uid-in-sandbox](./accept-root-uid-in-sandbox.md), which retains the
fuller analysis.

### 6. `~/.ssh` is still not bound

Out of scope here but the reason the defect was noticed: correct resolution only
makes ssh look in the right place. Bind nothing, and there is nothing to find.
Forwarding `SSH_AUTH_SOCK` is preferred over exposing private keys; the options
are analysed in the rejected plan. Track separately.

## Test Plan

- Remove `.failing` from `sandbox-uid-preserved`. It becomes the primary
  assertion and will start passing.
- Keep `sandbox-uid-maps-to-host-user` unchanged; it must stay true.
- New cases:
  - `getent passwd $(id -u)` home field is `/home/scoder`
  - `getpwuid` resolution via Python, the path OpenSSH uses
  - `whoami` is `scoder`
  - no pasta process survives a completed session (guards item 4)
  - `llm-port-auto-detect` and `llm-port-allows-host-loopback` still pass —
    these already exist and are the regression guard for item 1
- `host-loopback-blocked` is the guard that `--unshare-net` has not accidentally
  opened the host's loopback.

## Risks

- **Startup latency.** Two stages plus a poll add to session start. The
  prototype's pid appears within a couple of polls; if it proves slow, shorten
  the interval rather than the bound.
- **A shell dependency in the launch path.** `bash` becomes required to start a
  sandbox. It is already a hard dependency of the wrapper script, so this is
  not new, but it is now load-bearing.
- **Reduced observability.** An extra process sits between scoder and bwrap.
  `--dry-run` should print both stages, or it stops being a faithful picture of
  what runs.

## Rollback

The two composition styles are mutually exclusive but independent of everything
else, so reverting is a matter of restoring the single-argv `buildBwrapCommand`.
Worth keeping the split in one commit, separate from items 5 and 6, so it can be
reverted without losing the identity fixes — which are correct either way.

[IMPACTS](/src/sandbox/builder.ts)
[IMPACTS](/src/index.ts)
[HAS_FEATURE](/design/features/network-isolation.md)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
[HAS_TEST](/design/test-scripts/validation-suite.md)
