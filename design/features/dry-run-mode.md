---
target-version: 2.1.0
status: draft
tags: [feature, debugging]
---

# Dry-Run Mode

## Summary

`--dry-run` prints the complete bwrap command that would be executed,
including all bind mounts, environment variables, and pasta arguments,
without actually running the sandbox.

## Motivation

Debugging sandbox configuration is difficult when the tool runs inside the
sandbox. Dry-run mode lets developers inspect the exact command line before
execution.

## Implementation

[IMPLEMENTED_BY](/src/index.ts)

When `options.dryRun` is true, the bwrap command array is printed to stdout
and the process exits before spawning.

[HAS_FEATURE](./sandbox-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
