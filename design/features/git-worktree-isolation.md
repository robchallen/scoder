---
target-version: 2.1.0
status: draft
tags: [feature, git, worktree]
---

# Git Worktree Isolation

## Summary

Optional `-w` / `--worktree` mode creates an isolated git worktree at
`/tmp/scoder/<project-path>` on a dedicated branch `scoder/<proj>`. Changes
are committed on exit. On reboot, stale worktree references are detected,
pruned, and recreated.

## Motivation

Isolating changes to a separate branch and filesystem location prevents the
AI tool from modifying the user's working tree directly. All changes can be
reviewed, merged, or discarded after the session.

## Implementation

[IMPLEMENTED_BY](/src/git/worktree.ts#setupGitWorktree)

Flow:
1. Create branch `scoder/<proj>` off HEAD
2. Create worktree at `/tmp/scoder/<project-path>`
3. Bind worktree into sandbox at its real absolute path
4. On exit: commit all changes, print summary (commit count, diffstat)
5. Reboot recovery: if worktree directory is missing but branch exists, run `git worktree prune` and recreate with `git worktree add <dir> <branch>`

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./path-mirroring.md)

[HAS_TEST](../test-scripts/validation-suite.md)
[TESTED_BY](/tests/validate.ts)
