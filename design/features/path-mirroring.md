---
target-version: 2.2.0
status: draft
tags: [feature, git, sandbox]
---

# Path Mirroring

## Summary

Worktrees and the host `.git` directory are mounted at their real absolute
paths inside the sandbox, so git cross-references (`.git` file pointing to
main `.git/worktrees/`) resolve correctly without path translation.

The home directory is the deliberate **exception**: `/home` is replaced by a
tmpfs containing only `/home/scoder`, so no host path under `$HOME` exists
inside the sandbox. Every host path under the home directory must therefore be
translated before it crosses into the sandbox — see *Home remapping* below.

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

## Home remapping

Because mirroring stops at `$HOME`, any host path under the home directory is
meaningless inside the sandbox and has to be rewritten onto `/home/scoder`.
`toSandboxPath` is the single implementation of that rewrite. Three call sites
need it:

1. **The exec target.** `which <tool>` resolves the tool on the host, so a
   tool installed under `$HOME` (e.g. `~/.local/bin/claude` from a native
   installer) yields a path that does not exist inside the sandbox. Passing it
   through unrewritten produces a bare `execvp: No such file or directory`
   from pasta, with no indication of which path failed.
2. **Snapshot symlink targets.** Absolute symlink targets copied into the
   `~/.local/bin` snapshot must be rewritten, or the entry resolves on the host
   and dangles in the sandbox. See `local-bin-resolution`.
3. **Resolvability checks.** Deciding whether a symlink target will exist in the
   sandbox requires comparing the *mapped* path against the bind set.

`$HOME` may itself be a symlink (common with network homes), in which case
`which` and `realpath` return the resolved spelling while `$HOME` does not.
`resolveHomePrefixes` returns both so either form maps correctly.

A tool under `$HOME` in a directory that is not bound cannot work at all. That
case is detected before launch by comparing the mapped path against the bind
destinations of the built bwrap command (`collectBindDests`), and reported as an
actionable error rather than left to pasta.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/builder.ts#buildBwrapCommand)
[IMPLEMENTED_BY](/src/utils/paths.ts#toSandboxPath)

- Worktree is bound from its real path into the same path inside the sandbox
- `.git` directory is bound from its real path into the same path
- `GIT_WORK_TREE` is intentionally **not** set, relying on git's built-in worktree discovery
- Paths under `$HOME` are rewritten onto `/home/scoder` by `toSandboxPath`

## Testing

[HAS_TEST](../test-scripts/validation-suite.md)

[HAS_FEATURE](./git-worktree-isolation.md)
[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./local-bin-resolution.md)
