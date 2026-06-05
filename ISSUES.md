# Known Issues

## 1. Missing Warning for Uncommitted Host Changes

**Description:**
According to `DESIGN.md`: "If the user has uncommitted changes in their working tree when starting scoder (and not already in a scoder worktree), we prompt to commit them first." 

However, if a user makes changes in their host working directory (e.g., via `--no-worktree` mode or manual edits) and then starts a new `scoder` session in worktree mode, `scoder` will silently boot into the isolated worktree without the host's uncommitted changes. The user is not warned, leading to potential confusion about missing files.

**Root Cause:**
The function `hasUncommittedChanges` is exported from `src/git/worktree.ts` and imported at the top of `src/index.ts`, but it is never actually called in the execution flow.

**Suggested Fix:**
In `src/index.ts`, right before calling `setupGitWorktree`, check if the current directory has uncommitted changes and alert the user. Because `scoder` aims for minimal interactive friction, it could either issue a highly visible warning or safely abort, prompting the user to commit or stash.

```typescript
// Proposed fix in src/index.ts around line 118:
if (options.worktree) {
  const cwd = process.cwd();
  if (await isInGitRepo() && await hasUncommittedChanges(cwd)) {
    warning("⚠️  You have uncommitted changes in your current directory.");
    warning("   These changes will NOT be visible to the agent inside the isolated worktree.");
    // Optionally: exit to force the user to handle them:
    // error("   Please commit or stash them before starting scoder.");
    // process.exit(1);
  }

  worktreeInfo = await setupGitWorktree(true);
  // ...
}
```
