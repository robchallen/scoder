---
target-version: 2.1.0
status: draft
tags: [feature, tools, configuration]
---

# Tool Presets

## Summary

Built-in configuration presets for opencode, claude, copilot, and pi that
provide tool-specific config/data directory bind mounts into the sandbox.

## Motivation

Different AI coding tools store configuration and persistent data in
different locations. scoder maps each tool's directories into the sandbox
automatically, with config read-only and data/cache read-write.

## Implementation

[IMPLEMENTED_BY](/src/tools/presets.ts)

Each tool has an async function pair:
- `configBinds(realHome, sandboxHome)` — returns bind mounts and directory specs
- `validate()` — checks tool is installed, prints install instructions if missing

| Tool | Config (ro) | Data/Cache (rw) |
|------|------------|-----------------|
| opencode | ~/.config/opencode | ~/.local/share/opencode, ~/.cache/opencode |
| claude | ~/.claude, ~/.config/claude | — |
| copilot | ~/.config/gh, ~/.config/github-copilot | ~/.local/share/github-copilot |
| pi | — | ~/.pi/agent, ~/.local/share/pi, ~/.cache/pi |

[HAS_FEATURE](./sandbox-isolation.md)
