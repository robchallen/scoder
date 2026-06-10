---
target-version: 2.1.0
status: draft
tags: [debt, tools, copilot]
---

# Copilot CLI Config Paths Unverified

## Summary

The copilot preset binds `~/.config/github-copilot` and
`~/.local/share/github-copilot`. These paths are based on documentation
and convention, not verified against the actual tool.

## Impact

Config paths may be incorrect if the copilot CLI stores data in different
locations than documented.

## Discovery

Design document analysis during v2.1.0 TypeScript migration. Copilot CLI
was not installed on the development machine at the time of preset creation.

[IMPACTS](/src/tools/presets.ts)
[HAS_FEATURE](/design/features/tool-presets.md)
