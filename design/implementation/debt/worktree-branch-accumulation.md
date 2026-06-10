---
target-version: 2.1.0
status: draft
tags: [debt, git, worktree]
---

# Worktree and Branch Accumulation

## Summary

scoder creates worktrees and branches but never cleans them up
automatically. Over time, old branches accumulate on the system.

## Mitigation

Branches are reused across sessions on the same project, so accumulation
is slow. Manual cleanup instructions are provided in session summaries.

## Resolution

Manual cleanup per session:
```
git branch --list 'scoder/*'
git worktree remove /tmp/scoder/<path> && git branch -D scoder/<name>
```

[IMPACTS](/src/git/worktree.ts)
[HAS_FEATURE](/design/features/git-worktree-isolation.md)
