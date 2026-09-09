---
target-version: 2.1.0
status: draft
tags: [debt, reliability]
---

# No Explicit Signal Trap

> **Partially addressed in 2.4.0** — see
> `design/implementation/issues/terminal-signals-not-forwarded-to-sandbox.md`,
> which was about forwarding terminal signals into the sandboxed process but
> surfaced this exact gap as a side finding: an unhandled SIGINT was
> confirmed directly to skip `launchSandbox`'s `finally` entirely (Bun's
> default disposition for an unhandled SIGINT is immediate termination), so
> "under normal operation, cleanup is reliable" below was never actually
> true — a plain Ctrl-C during any interactive session, not just SIGKILL or
> a crash, leaked the pasta sidecar every time. `installSignalForwarding`
> now registers real handlers for SIGWINCH/SIGINT/SIGQUIT/SIGTSTP, which
> closes that specific, most-common case.
>
> Real gaps remain, so this isn't fully resolved:
> - **SIGTERM is not in `FORWARDED_SIGNALS`** — still hits Bun's default
>   disposition everywhere, skipping cleanup the same way SIGINT used to.
> - **The handlers only exist during `launchSandbox`'s own execution
>   window** — installed once `childPid` is known, removed in its own
>   `finally`. A signal arriving in `index.ts`'s `main()` before that (git
>   worktree setup, protection setup) or after (session summary, commit,
>   `stopSshTunnel`) still has no handler at all.
> - SIGKILL and a hard system crash remain permanently uncatchable by any
>   userspace program — not a gap that can be closed in software, unlike
>   the two above.

## Summary

The current signal handling relies on Bun's async/await for cleanup,
`process.exit()` for controlled termination, and bwrap's
`--die-with-parent` for orphan cleanup. No explicit signal trap exists
outside `launchSandbox`'s own execution window (see the update above).

## Impact

Edge cases (SIGKILL, system crash, SIGTERM, or any signal arriving outside
the `launchSandbox` window) may still skip cleanup and leave temp files or
a leaked pasta sidecar behind.

## Comparison

The original bash version had explicit signal traps. The TypeScript
runtime handles cleanup differently, but abnormal termination paths
may leave more residue.

[IMPACTS](/src/index.ts)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
