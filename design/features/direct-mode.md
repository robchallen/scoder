---
target-version: 2.1.0
status: draft
tags: [feature, sandbox, workflow]
---

# Direct Mode (`--no-worktree`)

## Summary

`--no-worktree` runs the sandboxed tool directly in the current working
directory without creating a git worktree or branch. Changes are immediate
in the working directory, with no commit on exit.

## Motivation

Not every session needs branch isolation. Quick experiments, non-git
projects, and testing benefit from faster startup and simpler cleanup.

## Behavior

- **Still requires a git repository.** Direct mode used to tolerate a
  non-git directory silently: git commands elsewhere
  (`addGitExclude`/`removeGitExclude` for the AGENTS.md overlay mask,
  `getProjDir`'s repo-root resolution) just no-op or fall back to `cwd`
  without checking exit codes, so nothing crashed — but there was no
  undo/audit trail for whatever the agent did there, cutting against the
  project's own "you can always review with `git diff`/`status`" safety
  story. It now refuses (exit 1, `not inside a git repository`) with the
  same message `setupGitWorktree` already used for the equivalent
  worktree-mode check, checked before any sandbox setup.
- No git worktree created
- No branch created
- Sandboxed execution in current directory
- `.agentreadonly` protection still applies
- AGENTS.md overlay still created
- No commit on exit
- Changes are immediate in the working directory

## Implementation

[IMPLEMENTED_BY](/src/index.ts#main)
[IMPLEMENTED_BY](/src/sandbox/builder.ts#buildBwrapCommand)

`main` (`src/index.ts`) checks `isInGitRepo()` before any other direct-mode
setup, refusing outright if it's false. When `options.worktree` is false,
the sandbox then binds `process.cwd()` directly instead of a worktree path.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_TEST](../test-scripts/validation-suite.md)
