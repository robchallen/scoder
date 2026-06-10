---
target-version: 2.1.0
status: draft
tags: [debt, reliability]
---

# No Explicit Signal Trap

## Summary

The current signal handling relies on Bun's async/await for cleanup,
`process.exit()` for controlled termination, and bwrap's
`--die-with-parent` for orphan cleanup. No explicit signal trap exists.

## Impact

Edge cases (SIGKILL, system crash) may leave temp files behind. Under
normal operation, cleanup is reliable.

## Comparison

The original bash version had explicit signal traps. The TypeScript
runtime handles cleanup differently, but abnormal termination paths
may leave more residue.

[IMPACTS](/src/index.ts)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
