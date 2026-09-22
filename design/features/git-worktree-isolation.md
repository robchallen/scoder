---
target-version: 2.2.0
status: draft
tags: [feature, git, worktree]
---

# Git Worktree Isolation

## Summary

Optional `-w` / `--worktree` mode creates an isolated git worktree at
`$HOME/<dirname(projDir)>/worktrees/<basename(projDir)>/scoder` on a dedicated branch
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
3. Create worktree at
   `$HOME/<dirname(projDir)>/worktrees/<basename(projDir)>/scoder`
   (`getWorktreesParentDir` in `src/git/worktree.ts`) — a sibling of the
   project's own real location, not nested under it: since the sandbox's
   `$HOME` is the real host `$HOME` (see `path-mirroring`), mapping the
   worktree directly onto `$HOME/<projDir>` would collide with the project's
   own real checkout at that exact path. The `/worktrees/` detour avoids the
   collision and puts "worktree" in the path itself, so it's obvious to the
   user what they're looking at. Two projects cannot collide under one
   parent either: the same basename in the same directory can only be the
   same project. Until 2.3.3 this repeated the whole relative `projDir`
   under `/worktrees/` rather than just its basename; the basename form is
   what makes the layout expressible as a worktrunk template (below), and
   existing worktrees are moved to it on the next session
   (`relocateWorktree`, best-effort — a failure warns and the session
   continues where it is).
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

## Interop: matching worktrunk's `worktree-path`

worktrunk (`wt`) creates worktrees wherever its own `worktree-path` template
says, which by default is a sibling of the repository — a path scoder binds
nothing at, so a worktree created inside a sandbox is invisible or
unwritable from the next one. Confirmed directly in a throwaway repo: the
default put branch `feat/one` at `<repo>.feat-one`.

**Inside the sandbox this is settled without any user configuration.**
scoder sets `WORKTRUNK_WORKTREE_PATH` (worktrunk's own env override, which
beats both user and project config) to the bound worktrees parent plus
`{{ branch | sanitize }}`, so `wt switch --create` lands beside scoder's own
worktree — see `buildBwrapCommand` in `src/sandbox/builder.ts`. It is an
absolute path rather than a relative template because scoder computes the
parent itself, which keeps it correct for a repository outside `$HOME`,
whose worktrees parent is deliberately relocated under `$HOME`.

**On the host**, where that variable is not set, the layout above is also
chosen so that one template puts worktrunk's worktrees in the same
directory, with no hardcoded path segments. In
`~/.config/worktrunk/config.toml`:

```toml
worktree-path = "{{ repo_path }}/../worktrees/{{ repo }}/{{ branch | sanitize }}"
```

For a repository at `~/Git/scoder` that resolves to
`~/Git/worktrees/scoder/<branch>`, alongside scoder's own worktree at
`~/Git/worktrees/scoder/scoder` — which is precisely where that template
would put a branch named `scoder`. Verified with `wt step eval`. It
generalizes to any depth: `~/Git/sub/proj` gives
`~/Git/sub/worktrees/proj/<branch>`, matching
`getWorktreesParentDir`'s own output for the same repository.

`{{ repo }}` is the repository *directory* name and `sanitize` turns `/`
into `-`, so branch `feature/auth` lands at `.../scoder/feature-auth`.

Two things to know:

- The two rules coincide only for repositories **under `$HOME`**. scoder
  anchors at `$HOME/<dirname(projDir)>`, worktrunk at `{{ repo_path }}/..`;
  for a repository outside `$HOME` (say `/srv/code/proj`) scoder
  deliberately relocates its worktree to `$HOME/srv/code/worktrees/proj/`
  so the sandbox can bind it, while worktrunk would use
  `/srv/code/worktrees/proj/`. Inside the sandbox
  `WORKTRUNK_WORKTREE_PATH` covers this case correctly anyway; it is only
  host-side `wt` that would disagree, and such a repository needs its own
  project-level `.config/wt.toml` for the two to line up there.
- A branch named exactly `scoder` would collide with scoder's own worktree
  directory of that name under the same parent.
