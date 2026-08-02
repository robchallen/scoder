---
target-version: 2.2.0
resolved-in: 2.2.0
status: resolved
tags: [issue, sandbox, worktree, user-experience]
---

# Worktree Check Ignores `--no-worktree`

> **Fixed in 2.2.0.** The check is now gated on `options.worktree`, matching
> the neighbouring `SCODER_SANDBOX` check, and the message no longer suggests
> a flag that cannot help. Covered by
> `direct-mode-works-in-linked-worktree` and
> `worktree-mode-refused-in-linked-worktree`.

## Summary

The git worktree branch of nested sandbox detection exits unconditionally when
the current directory is a linked git worktree, even when `--no-worktree` was
passed — and the error message advises passing `--no-worktree`, which does not
help.

## Root Cause

In `src/index.ts`, the `.git`-is-a-file check runs before and independently of
`options.worktree`:

```typescript
if (gitDirStat?.isFile()) {
    const gitContent = await Bun.file(gitDir).text();
    if (gitContent.startsWith("gitdir:")) {
        error("scoder is already running inside a git worktree");
        error("This creates a nested sandbox which bubblewrap cannot handle");
        error("Use --no-worktree to run scoder directly in the current directory");
        process.exit(1);
    }
}
```

The neighbouring `SCODER_SANDBOX` check is correctly gated on
`options.worktree`; this one is not.

## Impact

Direct mode is unusable in any linked git worktree, not just scoder's own.
Users working in their own `git worktree`-based branch layout cannot run
scoder there at all, and the suggested remedy is the flag they already passed.

Direct mode does not create a worktree, so there is no nesting to prevent in
that case — the bind of the resolved git common directory (already handled in
`src/sandbox/builder.ts`) is what direct mode needs, and it works.

## Suggested Fix

Gate the check on `options.worktree`, matching the `SCODER_SANDBOX` check:

```typescript
if (gitDirStat?.isFile() && options.worktree) {
```

Add a test that runs `scoder --no-worktree` from inside a linked worktree and
asserts success.

[IMPACTS](/src/index.ts)
[HAS_FEATURE](/design/features/nested-sandbox-detection.md)
[HAS_FEATURE](/design/features/direct-mode.md)
