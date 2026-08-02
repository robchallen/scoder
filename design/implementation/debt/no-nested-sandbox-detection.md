---
target-version: 2.1.0
resolved-in: 2.2.0
status: resolved
tags: [debt, sandbox, security]
---

# No Nested Sandbox Detection

> **Resolved in 2.2.0.** Both nesting checks described below are implemented in
> `src/index.ts` and documented as
> [nested-sandbox-detection](/design/features/nested-sandbox-detection.md).
> One gap remains, tracked separately as
> [worktree-check-ignores-no-worktree](/design/implementation/issues/worktree-check-ignores-no-worktree.md).

## Summary

If scoder is run inside an existing scoder sandbox, it will attempt to
create a worktree from the worktree's `.git` file, which may not work
correctly.

## Impact

Nested scoder sessions could produce confusing behaviour or failures.

## Suggested Resolution

Detect nesting (e.g., check for `SCODER_SANDBOX=1` env var) and either
refuse or adjust behaviour.

[IMPACTS](/src/index.ts)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
