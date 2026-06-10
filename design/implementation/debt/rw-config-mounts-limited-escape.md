---
target-version: 2.1.0
status: draft
tags: [debt, sandbox, security]
---

# Read-Write Config Mounts Create Limited Escape

## Summary

Some tool presets mount data/cache directories as read-write (e.g.,
opencode's `~/.local/share/opencode`). The sandboxed tool can modify
persistent state on the host.

## Rationale

These tools need to persist session data, databases, and caches. The
read-write mounts are intentional and necessary for normal operation.

## Impact

A limited escape from the sandbox's filesystem isolation. The tool can
write to its own data directories on the host, though not to arbitrary
locations.

[IMPACTS](/src/tools/presets.ts)
[HAS_FEATURE](/design/features/tool-presets.md)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
