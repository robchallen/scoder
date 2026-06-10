---
target-version: 2.1.0
status: draft
tags: [issue, worktree, user-experience]
---

# Missing Warning for Uncommitted Host Changes

## Summary

When a user makes changes in their host working directory (via
`--no-worktree` mode or manual edits) and then starts a scoder session in
worktree mode, scoder silently boots into the isolated worktree without the
host's uncommitted changes. The user is not warned that their changes will
not be visible to the agent.

## Root Cause

`hasUncommittedChanges` is exported from `src/git/worktree.ts` and imported
in `src/index.ts` but is never called in the execution flow. The DESIGN.md
states this warning should exist but it was never wired up.

## Impact

Users may be confused when files they just edited are not visible to the
sandboxed agent. In the worst case, they may lose track of changes made in
different sessions.

## Suggested Fix

In `src/index.ts`, before calling `setupGitWorktree`, check for uncommitted
changes in the current directory and emit a visible warning:

```typescript
if (options.worktree) {
  const cwd = process.cwd();
  if (await isInGitRepo() && await hasUncommittedChanges(cwd)) {
    warning("You have uncommitted changes in your current directory.");
    warning("These changes will NOT be visible to the agent inside the isolated worktree.");
  }
  // ...
}
```

[IMPACTS](/src/index.ts)
[IMPACTS](/src/git/worktree.ts#hasUncommittedChanges)
