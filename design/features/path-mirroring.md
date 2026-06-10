---
target-version: 2.1.0
status: draft
tags: [feature, git, sandbox]
---

# Path Mirroring

## Summary

Worktrees and the host `.git` directory are mounted at their real absolute
paths inside the sandbox, so git cross-references (`.git` file pointing to
main `.git/worktrees/`) resolve correctly without path translation.

## Problem

Git worktrees use a `.git` **file** (not directory) containing:
```
gitdir: /path/to/main/.git/worktrees/<name>
```

And the main repo's `.git/worktrees/<name>/gitdir` points back:
```
/tmp/scoder/<project-path>
```

If the sandbox remapped paths (e.g., worktree at `/home/scoder/workspace`
instead of `/tmp/scoder/<project-path>`), these cross-references would break.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/builder.ts#buildBwrapCommand)

- Worktree is bound from its real path into the same path inside the sandbox
- `.git` directory is bound from its real path into the same path
- `GIT_WORK_TREE` is intentionally **not** set, relying on git's built-in worktree discovery

[HAS_FEATURE](./git-worktree-isolation.md)
[HAS_FEATURE](./sandbox-isolation.md)
