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

- No git worktree created
- No branch created
- Sandboxed execution in current directory
- `.agentreadonly` protection still applies
- AGENTS.md overlay still created
- No commit on exit
- Changes are immediate in the working directory

## Implementation

[IMPLEMENTED_BY](/src/sandbox/builder.ts#buildBwrapCommand)

When `options.worktree` is false, the sandbox binds `process.cwd()` directly
instead of a worktree path.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_TEST](../test-scripts/validation-suite.md)
