---
target-version: 2.1.0
status: draft
tags: [feature, skills, agents]
---

# Agent Skills Snapshot

## Summary

`~/.agents` is copied (with symlink resolution via `cp -aL`) to a temporary
directory under `/tmp` at session startup, then bind-mounted read-only into
`/home/scoder/.agents`.

## Motivation

Agent skills stored in `~/.agents` often use symlinks to reference skills
installed elsewhere. Direct binding of `~/.agents` would not resolve these
symlinks inside the sandbox. The snapshot approach resolves symlinks at copy
time while keeping the skills usable read-only.

## Trade-off

The sandbox sees a startup-time snapshot. Live updates to `~/.agents` made
after the session begins are not visible.

## Implementation

[IMPLEMENTED_BY](/src/git/protection.ts#setupAgentsSnapshot)

[HAS_FEATURE](./sandbox-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
