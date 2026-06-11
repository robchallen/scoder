---
target-version: 2.1.0
status: draft
tags: [debt, testing, performance]
---

# Validation Test Speed

## Summary

The validation test suite creates git worktrees, which is slow (several
seconds per test). 20 tests take noticeable wall-clock time.

## Impact

Developer iteration speed is reduced. Running the full suite after every
change takes 30+ seconds.

## Potential Mitigations

- Lighter-weight tests for basic functionality
- Parallelize independent tests
- Mock filesystem operations where possible

[IMPACTS](/tests/scoder.test.ts)
[HAS_FEATURE](/design/features/git-worktree-isolation.md)
