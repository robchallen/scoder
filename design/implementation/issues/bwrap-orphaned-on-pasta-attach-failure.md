---
target-version: 2.3.0
resolved-in: 2.3.0
status: resolved
tags: [issue, sandbox, pasta, cleanup]
---

# bwrap Left Running When pasta Fails to Attach

> **Fixed in 2.3.0.** `launchSandbox`'s two failure branches now call
> `killBwrapTree`, which also terminates the inner process — the already-known
> `childPid` when available, or one discovered via `pgrep -P <outer-pid>`
> beforehand when it is not. The termination itself (SIGTERM, wait, escalate
> to SIGKILL) is `terminateProcess` in the new `src/utils/process.ts`, shared
> with `stopPasta` and `--allow-ssh`'s `stopSshTunnel`, which had the identical
> "outside bwrap's own reap path" problem. Covered by
> `bwrap-not-orphaned-on-pasta-attach-failure`, which forces the failure
> deterministically with a fake `pasta` on `PATH` rather than relying on an
> environment where pasta genuinely cannot attach.

## Summary

When pasta fails to attach to the sandbox's network namespace — or bwrap
never reports a child pid at all — `launchSandbox` kills the process it
tracks and returns. The actual sandbox is not torn down: bwrap forks
internally, and the process that is left running holds the namespaces open
indefinitely, orphaned rather than reaped.

Found while implementing `--allow-ssh`: this environment cannot open
`/dev/net/tun`, so pasta always fails to attach here, which turned every
sandbox launch attempt during development into a leaked process. The
trigger (`/dev/net/tun` missing) is environment-specific; the bug is not —
any pasta-attach failure hits it, on any machine.

## Root Cause

Confirmed directly with a process-tree trace (not inferred): bubblewrap forks
into two processes even without `--unshare-pid`. The pid `Bun.spawn` returns
and `launchSandbox` tracks as `proc.pid` is only the **outer** setup process.
A second, **inner** process — its child — is the one that actually holds the
new namespaces and blocks reading `--block-fd`, waiting for pasta.

```
PID    PPID  CMD
24949  24927 bwrap ... --block-fd 9 -- /bin/bash -c sleep 5   <- proc.pid (tracked)
24950  24949 bwrap ... --block-fd 9 -- /bin/bash -c sleep 5   <- actually blocked, untracked
```

`launchSandbox`'s two failure branches (`src/sandbox/launch.ts`) only ever
signal the tracked pid:

```typescript
if (childPid === null) {
	error("bwrap did not report its child pid, so networking cannot attach");
	proc.kill();
	await proc.exited;
	return { exitCode: 1 };
}

sidecar = await attachPasta(options, childPid, pidFile);
if (!sidecar) {
	proc.kill();
	await proc.exited;
	return { exitCode: 1 };
}
```

Killing pid `24949` reaps it cleanly — `proc.exited` resolves — but pid
`24950` is simply reparented to pid 1 and keeps running, still blocked on a
fifo nothing will ever write to:

```
PID   PPID  CMD
24950 1     bwrap ... --block-fd 9 -- /bin/bash -c sleep 5
```

`--die-with-parent` does not help here: it means the sandbox dies if the
process that *launched* bwrap dies (scoder itself), not that bwrap's own
internal child dies with bwrap's own outer setup process.

The `!sidecar` branch already has the inner process's real pid in scope — it
is exactly the `childPid` argument passed to `attachPasta`, since pasta needs
it to know what namespace to attach to. The `childPid === null` branch has no
such value on hand, because `waitForChildPid` timed out before bwrap ever
reported it — though the trace above shows the inner fork can already have
happened by that point, so a leak is possible there too, just without an
already-known pid to target.

## Impact

- One leaked bwrap process per failed attach attempt, each still holding a
  full set of read-only system binds, a tmpfs `/home`, and the ephemeral
  identity/resolv.conf overlays open.
- They do not appear anywhere in scoder's own accounting — nothing in
  `launchSandbox` or `stopPasta` knows about the inner pid — so nothing ever
  cleans them up. They accumulate for as long as the machine stays up.
- Distinct from, and not caught by, the existing `pasta-sidecar-reaped` test,
  which asserts pasta itself is reaped after a **successful** session. This
  is a bwrap leak on the **failure** path, which nothing currently exercises.

## Suggested Fix

Kill the inner process too, using the already-known `childPid` when
available, or discovering it via `pgrep -P <outer-pid>` beforehand when it
is not (the lookup must happen *before* killing the outer process, since
`pgrep -P` searches by current ppid and the inner process's ppid changes
once it is reparented):

```typescript
async function killBwrapTree(
	proc: Bun.Subprocess<"inherit", "inherit", "inherit">,
	childPid: number | null,
): Promise<void> {
	const innerPid = childPid ?? (await findChildPid(proc.pid));

	proc.kill();
	await proc.exited;

	if (innerPid !== null) {
		await terminateProcess(innerPid, TERM_GRACE_MS, KILL_GRACE_MS);
	}
}
```

`terminateProcess` (SIGTERM, wait, escalate to SIGKILL) is the same
escalation `stopPasta` already implements for the identical "this process
runs outside bwrap's own reap path" problem — by the time this fix and
`--allow-ssh`'s `stopSshTunnel` both exist, it is used three times, so it is
worth lifting into a small shared `src/utils/process.ts` rather than writing
a third private copy.

A regression test needs a way to force a pasta-attach failure deterministically
rather than relying on this environment's `/dev/net/tun` absence, which will
not reproduce everywhere: a fake `pasta` shimmed ahead of the real one on
`PATH`, always exiting non-zero, mirroring the `PATH`-shim technique already
used for the `--allow-ssh` test fixture (see
[ssh-tunnel-opt-in](../plans/ssh-tunnel-opt-in.md)'s Test Plan). Assert no
bwrap process matching the test's cwd survives.

[IMPACTS](/src/sandbox/launch.ts)
[HAS_FEATURE](/design/features/network-isolation.md)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
