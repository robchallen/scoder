---
target-version: 2.1.0
status: draft
tags: [debt, testing, validation]
---

# No Real-Tool Integration Tests

## Summary

The validation suite (`tests/validate.ts`) uses `/bin/bash` as the
sandboxed tool, which exercises sandbox mechanics but does not test with
real tools (opencode, gh, claude, copilot).

## Impact

Edge cases in how specific tools interact with the sandbox (paths they
write to, signals they handle) may surface only during real use.

## Discovery

Design document analysis during v2.1.0 TypeScript migration.

[IMPACTS](/tests/validate.ts)
[HAS_FEATURE](/design/features/tool-presets.md)
