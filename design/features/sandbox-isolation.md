---
target-version: 2.1.0
status: draft
tags: [feature, sandbox, filesystem]
---

# Sandbox Isolation

## Summary

bubblewrap (bwrap) provides unprivileged filesystem namespacing. The sandbox
has: read-only system mounts, ephemeral `/home/scoder` HOME on tmpfs,
selective tool config/data binds from the host home, and the project working
tree bind-mounted at its real absolute path.

## Motivation

AI coding tools need access to source code and configuration but should not
be able to modify system files, read files outside the project, or write to
arbitrary host locations. bwrap gives us this without root.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/builder.ts#buildBwrapCommand)

[IMPLEMENTED_BY](/src/sandbox/builder.ts#buildBwrapCommand)

The sandbox shape:

- `/usr`, `/bin`, `/lib`, `/lib64`, `/etc`, `/sys`, `/run` — ro-bind from host
- `/dev` — devtmpfs
- `/proc` — procfs
- `/tmp` — ephemeral tmpfs
- `/home/scoder` — ephemeral tmpfs with `.config/`, `.local/`, `.cache/` subdirs
- `<project-path>` — bind mount of worktree or cwd
- `<git-dir>` — bind mount of host `.git` directory (worktree mode only)

[HAS_FEATURE](./path-mirroring.md)
[HAS_FEATURE](./host-tool-binding.md)

[HAS_TEST](../test-scripts/validation-suite.md)
