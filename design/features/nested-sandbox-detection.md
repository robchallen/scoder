---
target-version: 2.2.0
status: draft
tags: [feature, sandbox, git, worktree]
---

# Nested Sandbox Detection

## Summary

scoder refuses to start when it would create a sandbox inside a sandbox, or a
worktree from a worktree. Two independent checks run before any other setup:

1. **Git worktree check** — if worktree mode is requested *and* `.git` in the
   current directory is a *file* whose contents begin with `gitdir:`, the
   current directory is a linked git worktree rather than a main checkout, so
   the worktree scoder would create could not be reached. scoder exits with an
   error. Direct mode is unaffected: it creates no worktree, so there is
   nothing to nest.
2. **Scoder sandbox check** — if `SCODER_SANDBOX=1` is set (the sandbox always
   sets it, see `sandbox-isolation`) *and* worktree mode was requested, scoder
   exits with an error advising `--no-worktree`. Direct mode is permitted
   inside an existing sandbox.

## Motivation

Creating a git worktree from a linked worktree resolves `.git` indirectly and
produces a worktree whose git directory lies outside anything scoder
bind-mounts, so the agent sees a broken or empty repository. Nesting
bubblewrap sandboxes compounds the problem: the inner sandbox tries to
bind-mount host paths that only existed in the outer sandbox's mount
namespace.

Refusing early gives a clear diagnostic instead of an agent silently working
in an empty or partial checkout.

## Approach

Both checks run in `main()` immediately after argument parsing, before
dependency checks and before any worktree or protection setup, so a nested
invocation costs nothing and mutates nothing.

The sandbox sets `SCODER_SANDBOX=1` via `--setenv` in the bwrap command, which
is what makes the second check possible from inside a session.

## Implementation

[IMPLEMENTED_BY](/src/index.ts)
[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./git-worktree-isolation.md)
[HAS_FEATURE](./direct-mode.md)

## Testing

[HAS_TEST](../test-scripts/validation-suite.md)

Two tests cover the worktree check from both sides:
`direct-mode-works-in-linked-worktree` asserts `--no-worktree` succeeds inside a
linked worktree, and `worktree-mode-refused-in-linked-worktree` asserts `-w`
still refuses. The `SCODER_SANDBOX` branch is guarded rather than asserted on:
worktree tests self-skip when nesting is detected, so the suite passes both on
the host and inside a scoder session.
