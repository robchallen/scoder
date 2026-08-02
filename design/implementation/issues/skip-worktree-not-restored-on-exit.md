---
target-version: 2.2.0
resolved-in: 2.2.0
status: resolved
tags: [issue, git, agents-md]
---

# skip-worktree Not Restored on Normal Exit

> **Fixed in 2.2.0.** The exit code is captured in a variable and
> `process.exit()` moved after the `try`/`finally`, so `removeGitExclude`
> runs on the normal path. Covered by
> `skip-worktree-cleared-after-session`.
>
> Signal-terminated sessions still bypass cleanup — see the
> `no-explicit-signal-trap` debt record.

## Summary

The `finally` block that clears the `AGENTS.md` skip-worktree flag never runs on
the normal exit path, because `process.exit()` is called *inside* the
corresponding `try`. Sessions therefore leave `AGENTS.md` permanently flagged
`S` in the repository index.

## Root Cause

In `src/index.ts`:

```typescript
await addGitExclude(repoRoot, "AGENTS.md");

try {
    // ...launch, wait, summarise...
    process.exit(exitCode);      // terminates immediately
} finally {
    await removeGitExclude(repoRoot, "AGENTS.md");
}
```

`process.exit()` tears the process down synchronously; pending `finally` blocks
do not execute. Verified directly:

```
$ bun run -e 'try { process.exit(0) } finally { console.log("FINALLY RAN") }'
$        # no output
```

The `finally` only helps if the body throws before reaching `process.exit`,
which is the uncommon path.

## Impact

After any normal session, `git ls-files -v AGENTS.md` reports `S`. While that
flag is set, git silently ignores changes to `AGENTS.md` in that worktree:
edits do not show in `git status`, are not staged by `git add -A`, and are lost
on branch switches. The user gets no indication why.

The flag survives across sessions, so this accumulates rather than
self-correcting.

## Suggested Fix

Capture the exit code and leave the `try` before exiting:

```typescript
let exitCode = 0;
try {
    // ...launch, wait, summarise...
    exitCode = await proc.exited;
} finally {
    await removeGitExclude(repoRoot, "AGENTS.md");
}
process.exit(exitCode);
```

Signal-terminated sessions still bypass cleanup — see the
`no-explicit-signal-trap` debt record.

A test should assert `git ls-files -v AGENTS.md` reports `H`, not `S`, after a
completed session. The existing `addGitExclude`/`removeGitExclude` tests call
those functions directly and so cannot catch this; the scoder-level tests assert
only that the run succeeds.

[IMPACTS](/src/index.ts)
[HAS_FEATURE](/design/features/agents-md-overlay.md)
