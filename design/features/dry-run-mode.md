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

[IMPLEMENTED_BY](/src/index.ts#printBwrapCommand)

When `options.dryRun` is true, the bwrap command array is printed to stdout
and the process exits before spawning.

**Sensitive `--setenv` values are redacted in the printed preview.**
Reported directly: the preview printed several real API keys/tokens in
cleartext (from `builder.ts`'s `passThrough` env var list — LLM/search
provider credentials the sandboxed tool needs at runtime), which a user
pasted directly into a chat log with no reason to expect a *preview* to
expose live secrets — `--dry-run`'s own contract (side-effect free, safe
to run and share the output of) directly implies it shouldn't. Any
`--setenv` value whose name matches `/token|key|secret|password|credential/i`
(case-insensitive) prints as `<redacted>` instead — a substring
heuristic, not an exact match against `passThrough`'s own list, so a
newly added provider env var is covered automatically. Only the printed
preview is affected; the real command actually executed (non-dry-run)
is never touched.

[HAS_FEATURE](./sandbox-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
