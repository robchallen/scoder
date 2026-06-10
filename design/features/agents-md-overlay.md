---
target-version: 2.1.0
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

- Copy repository `AGENTS.md` (if it exists) to a temp file
- Append a `scoder sandbox` notice with mode-specific context
- Bind-mount the temp file read-only over `AGENTS.md` in the sandbox
- Overlay must be applied after the main worktree bind (same as protection overlays)

[HAS_FEATURE](./sandbox-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
