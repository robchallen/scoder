---
target-version: 2.2.0
status: draft
tags: [feature, sandbox, documentation]
---

# AGENTS.md Overlay

## Summary

The workspace `AGENTS.md` visible inside the sandbox is overlaid from a
temporary file that appends sandbox-specific instructions (scoder sandbox
notice, worktree/direct mode context) without modifying the repository copy.

## Motivation

The sandboxed agent needs to know it is running in a restricted environment
so it does not try to access unavailable paths or assume host HOME. The
repository `AGENTS.md` must remain untouched.

## Implementation

[IMPLEMENTED_BY](/src/git/protection.ts#getAgentsMdOverlayBind)

### Overlay creation

- Copy repository `AGENTS.md` (if it exists) to a temp file in `/tmp`
- Append a `scoder sandbox` notice with mode-specific context (worktree vs direct)
- Bind-mount the temp file read-only (`--ro-bind`) over `AGENTS.md` in the sandbox
- Overlay must be applied after the main worktree/cwd bind (protection overlays section)

### Overlay masking from git

The overlay replaces `AGENTS.md` with different content, which git would detect
as a modification. Since the overlay is read-only, the agent cannot fix it. To
prevent git operations from failing, scoder marks `AGENTS.md` as
`--skip-worktree` via `git update-index` before launching the sandbox and
restores normal tracking afterwards.

The restore runs in a `finally` block, and `process.exit()` is deliberately
called **outside** the corresponding `try`. `process.exit()` terminates the
process synchronously and does not run pending `finally` blocks, so exiting from
inside the `try` would skip the restore entirely and leave `AGENTS.md`
permanently flagged `S` — after which git silently ignores edits to that file.
Signal-terminated sessions still bypass the restore; see the
`no-explicit-signal-trap` debt record.

Masking applies in direct mode too, where the repository root is the current
directory rather than the worktree.

[IMPLEMENTED_BY](/src/git/protection.ts#addGitExclude)
[IMPLEMENTED_BY](/src/git/protection.ts#removeGitExclude)

The `--skip-worktree` flag tells git the file is intentionally modified and
should not be touched. This allows the agent to use git freely inside the
sandbox (worktree operations, stash, etc.) without seeing a dirty working tree.

[HAS_FEATURE](./sandbox-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
