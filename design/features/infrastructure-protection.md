---
target-version: 2.1.0
status: draft
tags: [feature, protection, security]
---

# Infrastructure Protection

## Summary

`.sandbox/readonly` file in the repository root defines paths that should be
mounted read-only inside the sandbox, even though the worktree itself is
writable. Default protections include `.github/`, `.claude/`,
`opencode.json`, `.gitignore`, and lockfiles.

## Motivation

A malicious or confused AI agent could inject CI/CD workflows, modify ignore
rules, or alter lockfiles. Read-only overlays prevent this.

## Implementation

[IMPLEMENTED_BY](/src/git/protection.ts#setupProtection)

- Default protected paths are always applied
- `.sandbox/readonly` (gitignore-style, one path per line, `#` comments) overrides defaults
- An empty `.sandbox/readonly` removes all default protections
- `$HOME/...` entries bind a host file *or* directory read-only into the
  sandbox's own `$HOME` (the real host `$HOME` — see `path-mirroring`), at
  the same path it already lives at. Only real ancestor directories get a
  scaffolding `--dir` entry, never the entry's own leaf path — reported
  directly, a file target (`$HOME/.private/apis/secrets.prop`) failed with
  `bwrap: Can't create file at <path>: Is a directory` when the leaf was
  included too, since bwrap processes `--dir` before `--ro-bind` and had
  already scaffolded an empty directory exactly where the file needed a
  file mountpoint instead.
- A `$HOME/...` entry must not overlap `fixedBindDestinations`
  (`src/git/protection.ts`, shared with `.sandbox/readwrite`'s own overlap
  check) — the exact, specific real host paths scoder itself
  unconditionally binds (`buildExtraBinds`' host-tool list, a preset's own
  top-level dir like `.claude`/`.copilot`, the agent-skills snapshot).
  Deliberately **not** the bare namespace umbrellas a dynamic, per-preset
  sub-path happens to live under (`.cache`, `.config`, `.local` as bare
  entries) — those are never themselves bound, just scaffolded empty by
  `builder.ts`'s own `--dir` list. Reported directly:
  `$HOME/.local/share/fonts` was rejected outright under an earlier,
  broader version of this check that blocked the bare `.local` umbrella
  wholesale, even though nothing was bound at that bare path at the
  time — fixed by narrowing the check to the exact fixed destinations
  (fonts has since become one of them itself; see below). The check is
  still bidirectional, so an entry that is an *ancestor* of a fixed
  destination (e.g. bare `$HOME/.config`, containing `.config/mise` and
  `.config/gh`) is still correctly rejected.
- The `.sandbox/readonly` file itself is always read-only — including in the
  very first session that finds it missing and writes the default: a
  missing source path gets no bind mount at all, which previously left the
  freshly created default writable from inside that same session (fixed;
  see `agentreadonly-missing-file-not-writable-from-sandbox`)
- Protected paths are applied as `--ro-bind` overlays **after** the worktree bind

[HAS_FEATURE](./sandbox-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
