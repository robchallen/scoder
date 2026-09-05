---
target-version: 2.1.0
status: draft
tags: [feature, protection, security]
---

# Infrastructure Protection

## Summary

`.agentreadonly` file in the repository root defines paths that should be
mounted read-only inside the sandbox, even though the worktree itself is
writable. Default protections include `.github/`, `.claude/`,
`opencode.json`, `.gitignore`, and lockfiles.

## Motivation

A malicious or confused AI agent could inject CI/CD workflows, modify ignore
rules, or alter lockfiles. Read-only overlays prevent this.

## Implementation

[IMPLEMENTED_BY](/src/git/protection.ts#setupProtection)

- Default protected paths are always applied
- `.agentreadonly` (gitignore-style, one path per line, `#` comments) overrides defaults
- An empty `.agentreadonly` removes all default protections
- `$HOME/...` entries bind host home directories read-only into `/home/scoder/`
- The `.agentreadonly` file itself is always read-only — including in the
  very first session that finds it missing and writes the default: a
  missing source path gets no bind mount at all, which previously left the
  freshly created default writable from inside that same session (fixed;
  see `agentreadonly-missing-file-not-writable-from-sandbox`)
- Protected paths are applied as `--ro-bind` overlays **after** the worktree bind

[HAS_FEATURE](./sandbox-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
