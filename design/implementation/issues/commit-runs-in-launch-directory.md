---
target-version: 2.2.0
resolved-in: 2.2.0
status: resolved
tags: [issue, git, worktree, data-loss]
---

# Session Commit Runs in the Launch Directory, Not the Worktree

> **Fixed in 2.2.0.** `commitAllChanges` now takes a mandatory `repoDir` and
> passes it as `cwd`, and returns early when the worktree is clean. The caller
> in `src/index.ts` passes `worktreeInfo.worktreeDir`. Covered by
> `session-commit-lands-in-worktree` and
> `clean-worktree-session-commits-nothing`.
>
> The six historical `Committing session by scoder.` commits on `main` are
> left as-is; they are part of the recorded history.

## Summary

At the end of a worktree-mode session, scoder commits with `git add -A` and
`git commit` in **its own process working directory** — the user's main
checkout — instead of the worktree. Any uncommitted work in the main checkout is
swept into a commit titled `Committing session by scoder.` on whatever branch is
checked out there, usually `main`.

## Root Cause

`commitAllChanges` in `src/git/worktree.ts` spawns git without a `cwd`:

```typescript
const addProc = await Bun.spawn(["git", "add", "-A"], {
    stdout: "pipe",
    stderr: "pipe",
});
```

`Bun.spawn` inherits the parent's working directory, which is where the user ran
`scoder`. Every other worktree function takes an explicit directory
(`getCommitCount(worktreeInfo.worktreeDir, ...)`,
`getDiffStat(worktreeInfo.worktreeDir, ...)`); this one does not, and the caller
in `src/index.ts` has `worktreeInfo.worktreeDir` available but never passes it.

## Impact

Severe and silent:

- Unrelated in-progress work in the main checkout is committed without consent.
  Because the message is generic, it is easy to mistake for a scoder session
  commit and hard to attribute later.
- The worktree's actual changes are **not** committed, so the session summary
  that follows reports commit counts and diffstats for the wrong tree. "No
  changes were made" can be printed while the worktree holds real work.
- The `scoder/<repo>` branch does not advance, so the documented
  `git merge scoder/<repo>` recovers nothing.

The repository history already contains six such commits
(`b3091c2`, `31951e4`, `115dcfe`, `24da392`, `9d22e54`, `3fa0784`), all titled
`Committing session by scoder.` on `main`.

## Suggested Fix

Give `commitAllChanges` an explicit repository directory and pass the worktree:

```typescript
export async function commitAllChanges(
    repoDir: string,
    message: string,
): Promise<void> {
    const addProc = await Bun.spawn(["git", "add", "-A"], {
        cwd: repoDir,
        stdout: "pipe",
        stderr: "pipe",
    });
    // ...same for the commit
}
```

Called as `commitAllChanges(worktreeInfo.worktreeDir, "…")`. Also skip the
commit entirely when the worktree is clean, so empty sessions do not fail on
`git commit` returning non-zero.

A test should assert that a worktree-mode session leaves the *launching*
repository's `git status` unchanged, and advances the `scoder/*` branch.

[IMPACTS](/src/git/worktree.ts)
[IMPACTS](/src/index.ts)
[HAS_FEATURE](/design/features/git-worktree-isolation.md)
