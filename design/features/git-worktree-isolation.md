---
target-version: 2.2.0
status: draft
tags: [feature, git, worktree]
---

# Git Worktree Isolation

## Summary

Optional `-w` / `--worktree` mode creates an isolated git worktree at
`$HOME/<dirname(projDir)>/worktrees/<projDir>/scoder` on a dedicated branch
`scoder/<proj>`. Changes are committed on exit. On reboot, stale worktree
references are detected, pruned, and recreated.

## Motivation

Isolating changes to a separate branch and filesystem location prevents the
AI tool from modifying the user's working tree directly. All changes can be
reviewed, merged, or discarded after the session.

The worktree is checked out from a commit, so **uncommitted work in the user's
checkout is invisible to the agent**. Worktree mode used to only warn about
this at startup rather than refuse, since the user might not need those
changes in the session — changed to a hard refusal (exit 1) once that gap
between "invisible to the agent" and "just a warning" was judged too easy to
miss, matching the requirement already used for a non-git directory (see
`direct-mode` for the equivalent requirement there).

## Implementation

[IMPLEMENTED_BY](/src/git/worktree.ts#setupGitWorktree)
[IMPLEMENTED_BY](/src/git/worktree.ts#commitAllChanges)

Flow:
1. Refuse (exit 1, `--worktree requires a clean checkout`) if the launching
   checkout has uncommitted changes the agent would not be able to see —
   checked in `main` (`src/index.ts`) before `setupGitWorktree` runs at
   all, so a refused launch never creates a branch or worktree to begin
   with. Not-a-git-repo is still caught by `setupGitWorktree`'s own check
   below: `hasUncommittedChanges` returns `false`, not `true`, for a
   non-repo `cwd`, so the flow falls through to it correctly.
2. Create branch `scoder/<proj>` off HEAD
3. Create worktree at `$HOME/<dirname(projDir)>/worktrees/<projDir>/scoder`
   (`getWorktreesParentDir` in `src/git/worktree.ts`) — a sibling of the
   project's own real location, not nested under it: since the sandbox's
   `$HOME` is the real host `$HOME` (see `path-mirroring`), mapping the
   worktree directly onto `$HOME/<projDir>` would collide with the project's
   own real checkout at that exact path. The `/worktrees/<projDir>` detour
   avoids the collision and puts "worktree" in the path itself, so it's
   obvious to the user what they're looking at.
4. Bind worktree into sandbox at its real absolute path
5. On exit: commit all changes **in the worktree**, print summary (commit count, diffstat)
6. Reboot recovery: if worktree directory is missing but branch exists, run `git worktree prune` and recreate with `git worktree add <dir> <branch>`

The worktree's *parent* directory (the same path without the trailing
`/scoder`) is ensured to exist and bound read-write on every session,
worktree mode or not — see `buildBwrapCommand` in `src/sandbox/builder.ts`.
This is deliberate, forward-looking infrastructure for explicitly supporting
multiple named worktrees from within a direct-mode session in future; today
it's just an empty, writable directory when unused.

### Commit target

`commitAllChanges` takes a mandatory `repoDir` and passes it as `cwd`. This is
load-bearing: `Bun.spawn` inherits scoder's own working directory, so omitting
`cwd` commits the *user's main checkout* rather than the worktree — sweeping
unrelated in-progress work into a `Committing session by scoder.` commit while
leaving the worktree's real changes uncommitted, and making the session summary
describe the wrong tree. It also returns early when the worktree is clean, so an
empty session does not fail on `git commit` returning non-zero.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./path-mirroring.md)

[HAS_TEST](../test-scripts/validation-suite.md)
