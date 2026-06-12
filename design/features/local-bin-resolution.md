---
target-version: 2.2.0
status: draft
tags: [feature, tools, bin, symlinks]
---

# Local Bin Symlink Resolution

## Summary

At session startup, `~/.local/bin` contents are copied to a temporary
directory under `/tmp`. Symlinks that point to host paths outside the
sandbox are replaced with small bash forwarding shims (`#!/bin/bash`
`exec` the real target). Non-broken symlinks and regular files are
copied as-is. The result is bind-mounted read-only at
`/home/scoder/.local/bin`.

## Motivation

`~/.local/bin` is `--ro-bind` from the host, so symlinks inside are
dereferenced into the sandbox as-is. When a symlink points to a host
path (e.g. `/home/user/.cargo/bin/cargo`), the target does not exist
inside the sandbox and the tool silently fails.

The `~/.agents` snapshot pattern (`agents-skills-snapshot`) solves this
for skill directories but `~/.local/bin` was left as a raw bind because
of concerns about size and permission restoration.

## Approach

At startup, `~/.local/bin` is scanned entry-by-entry and copied to a
temporary directory under `/tmp`. Each entry is handled according to
its type:

1. **Regular file** → copied as-is with executable permission preserved
2. **Symlink** → resolved to its real target. If the resolved target
   exists and is accessible inside the sandbox (its path maps to one
   of the known sandbox mount prefixes, e.g. `~/.cargo/bin` →
   `/home/scoder/.cargo/bin`), the symlink is copied as-is. If the
   target is outside the sandbox, the target binary itself is copied
   into the snapshot.
3. **Broken/missing symlink** → skipped silently (same as
   `setupAgentsSnapshot` handling of unreadable entries)
4. **Directory** → skipped silently

The result is bind-mounted read-only at `/home/scoder/.local/bin`.

## Trade-offs

### Performance

- Copying `~/.local/bin` adds ~20-100ms to startup (mostly scripts,
  not binaries)
- Forwarding shims add one extra process creation per invocation, but
  `exec` replaces the shim instantly — no meaningful overhead
- The temp copy is cleaned up by bwrap on sandbox exit

### Size

- `~/.local/bin` typically has 50-500 files (shims), 5-50 MB total
- Forwarding shims are ~50-100 bytes each — negligible
- Temp dir lives on tmpfs under `/tmp` — reclaimed on exit

### Security

- Forwarding shims expose the real host binary path inside the sandbox
- This is the same info visible from `ls -la ~/.local/bin` on the host
- The shims themselves are read-only inside the sandbox

### Correctness

- Works for absolute symlinks → forwarding shim
- Works for relative same-dir symlinks → copied as-is
- Relative parent-path symlinks (`../`) → copied as-is; may or may
  not resolve inside the sandbox depending on what's bind-mounted
- Regular files → copied as-is
- Tools already covered by other binds (mise shims, cargo, rustup,
  etc.) still work via both the existing bind and any shim coverage

## Implementation

[IMPLEMENTED_BY](/src/git/protection.ts#setupLocalBinSnapshot)
[HAS_FEATURE](./host-tool-binding.md)
[HAS_FEATURE](./agents-skills-snapshot.md)

## Design Decisions

### Why copy the target binary instead of a forwarding shim?

A forwarding shim that does `exec /the/real/host/path "$@"` only works
if that host path is also accessible inside the sandbox. If the target
is truly outside the sandbox, the shim would still fail.

Copying the target binary into the snapshot ensures the tool is always
available inside the sandbox, regardless of whether the target path is
bind-mounted. This is the same pattern used by `setupAgentsSnapshot`
for `~/.agents` — it copies rather than symlinks.

### Why not just `--bind` the real targets?

The real targets are often scattered across `~/.cargo/bin`,
`~/.local/share/mise/shims`, `.venv/bin`, etc. Resolving and
bind-mounting each individually would require scanning every symlink
at startup and managing a dynamic bind list. A single temp-dir snapshot
with forwarding shims is simpler and more robust.

## Testing

[HAS_TEST](../test-scripts/validation-suite.md)

Three test cases verify:

1. **local-bin-symlink-resolved**: A symlink in `~/.local/bin` pointing
   to a host path outside the sandbox has its target binary copied into
   the snapshot and the tool executes correctly.
2. **local-bin-regular-file**: Regular executable files in `~/.local/bin`
   are copied with their permissions intact and work inside the sandbox.
3. **local-bin-symlink-arg-passthrough**: Tools accessed via the
   snapshot handle arguments correctly.
