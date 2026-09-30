---
target-version: 2.2.0
status: draft
tags: [feature, tools, bin, symlinks]
---

# Local Bin Symlink Resolution

## Summary

At session startup, `~/.local/bin` contents are copied to a temporary
directory under `/tmp`. A symlink whose target *is* bound into the sandbox is
kept as a symlink, with its target canonicalized to the spelling actually
bound into the sandbox (see `path-mirroring`); a symlink whose target is not
reachable has the target binary copied in instead. Regular files are copied
as-is with their exec bits. The result is bind-mounted read-only at
`$HOME/.local/bin` (the real host `$HOME`).

## Motivation

`~/.local/bin` is `--ro-bind` from the host, so symlinks inside are
dereferenced into the sandbox as-is. When a symlink points to a host
path (e.g. `/home/user/.cargo/bin/cargo`), the target does not exist
inside the sandbox and the tool silently fails.

The `~/.agents` snapshot pattern (`agents-skills-snapshot`) solves this
for skill directories but `~/.local/bin` was left as a raw bind because
of concerns about size and permission restoration.

## Approach

At startup, `~/.local/bin` is scanned entry-by-entry and copied into the
session temp root, at the host path mirroring `~/.local/bin` itself (see
`session-temp-root`). Each entry is handled according to its type:

1. **Regular file** → copied as-is with executable permission preserved
2. **Symlink** → resolved to its real target, and the target canonicalized
   via `toSandboxPath` (see `path-mirroring`) — a no-op unless the target was
   spelled through a symlinked `$HOME`. If the canonicalized target lands
   under a path that is actually bound into the sandbox, the entry stays a
   symlink but points at the canonicalized target. Otherwise the target
   binary itself is copied into the snapshot.
3. **Broken/missing symlink** → skipped silently (same as
   `setupAgentsSnapshot` handling of unreadable entries)
4. **Directory** → copied recursively, with symlinks inside dereferenced.
   These usually hold libraries belonging to a tool in `~/.local/bin`
   alongside them, so skipping them (as an earlier version did) left the
   tool present but unable to load what it needs.

The result is bind-mounted read-only at `$HOME/.local/bin`.

### Which paths count as bound

Resolvability is checked against two sources, because guessing wrong in either
direction has a cost:

- `sandboxMountPrefixes(realHome)` — the always-present host-tool binds. This
  list must mirror `buildExtraBinds` **exactly**, and name the precise bound
  paths rather than their parents. A prefix that is not really bound (an
  earlier version listed the parent `$HOME/.local`) makes the check claim
  resolvability it cannot deliver, and the entry dangles. The worktree tree
  itself isn't in this list — it's checked separately via
  `isWorktreeMountPath`, since (unlike this fixed list) its location depends
  on the project.
- The active tool preset's bind destinations, passed in per session. These are
  dynamic — `~/.local/share/claude` is bound for `scoder claude` and not for
  `scoder opencode` — so they cannot live in a static list.

### Size ceiling on copying

An unresolvable target above `MAX_LOCAL_BIN_COPY_BYTES` (64 MB) is not copied;
a mapped symlink is written instead and the entry is logged as unresolved. Some
tools ship very large single-file binaries — Claude Code's native installer is
around 275 MB — and copying one of those on every launch of an *unrelated* tool
is not a reasonable startup cost. Such a tool needs a preset bind (as `claude`
has) rather than a per-launch copy.

## Trade-offs

### Performance

- Copying `~/.local/bin` adds ~20-100ms to startup (mostly scripts, not
  binaries)
- Kept symlinks cost nothing at invocation time
- The temp copy is cleaned up on exit

### Size

- `~/.local/bin` typically has 50-500 files, 5-50 MB total
- Large unresolvable targets are not copied at all (see *Size ceiling*), so a
  single oversized binary cannot dominate startup
- Temp dir lives under `/tmp` — reclaimed on exit

### Security

- A kept symlink exposes the sandbox-mapped target path, not a host path
- Copied targets are read-only inside the sandbox

### Correctness

- Absolute symlink, target bound → symlink kept, target canonicalized (a
  no-op unless it was spelled through a symlinked `$HOME`)
- Absolute symlink, target unbound and under the size ceiling → target binary
  copied in
- Absolute symlink, target unbound and oversized → mapped symlink written,
  resolves only if something else binds the directory; logged as unresolved
- Relative same-dir symlinks → kept as-is; they resolve within the snapshot
- Relative parent-path symlinks (`../`) → kept as-is; may or may not resolve
  inside the sandbox depending on what is bind-mounted
- Regular files → copied as-is with exec bits
- Directories → copied recursively and dereferenced, so a tool's adjacent
  library directory survives into the snapshot

## Implementation

[IMPLEMENTED_BY](/src/git/protection.ts#setupLocalBinSnapshot)
[HAS_FEATURE](./host-tool-binding.md)
[HAS_FEATURE](./agents-skills-snapshot.md)
[HAS_FEATURE](./session-temp-root.md)
[HAS_FEATURE](./path-mirroring.md)

## Design Decisions

### Why copy the target binary rather than write a forwarding shim?

A forwarding shim that does `exec /the/real/host/path "$@"` only works if that
host path is accessible inside the sandbox — and if it were, the symlink would
have worked unchanged. For a genuinely unreachable target the shim fails
exactly as the symlink did, just later and less legibly. Copying the target
makes it present. This mirrors `setupAgentsSnapshot`, which also copies.

### Why rewrite kept symlink targets instead of leaving them alone?

Symlink targets are resolved by the kernel *inside* the sandbox namespace.
Most of the time that's now the same real `$HOME` the host has (see
`path-mirroring`), so a plain absolute target already resolves unchanged —
but a target spelled through a symlinked `$HOME` (network homes commonly
have one) still needs canonicalizing onto the raw `$HOME` spelling actually
bound in, or it dangles. This is the same failure mode that made `scoder
claude` exit with `execvp: No such file or directory` before the rewrite
existed.

### Why not just `--bind` the real targets?

The real targets are often scattered across `~/.cargo/bin`,
`~/.local/share/mise/shims`, `.venv/bin`, etc. Resolving and bind-mounting each
individually would require scanning every symlink at startup and managing a
fully dynamic bind list. A snapshot plus targeted preset binds is simpler.

However, a tool whose own binary lives under `$HOME` in an unbound directory
*does* need a bind — a snapshot entry alone cannot help when the tool is the
thing being launched. That is why the `claude` preset binds
`~/.local/share/claude` rather than relying on the copy path.

## Testing

[HAS_TEST](../test-scripts/validation-suite.md)

Six test cases verify:

1. **local-bin-symlink-resolved**: A symlink in `~/.local/bin` pointing to a
   host path outside the sandbox has its target copied into the snapshot and
   the tool executes correctly.
2. **local-bin-regular-file**: Regular executable files in `~/.local/bin` are
   copied with their permissions intact and work inside the sandbox.
3. **local-bin-symlink-arg-passthrough**: Tools accessed via the snapshot
   handle arguments correctly.
4. **local-bin-symlink-target-mapped**: No entry in the snapshot is a symlink
   to a host `$HOME` path, whichever branch each entry took.
5. **home-installed-tool-exec-path-mapped**: The exec target for a
   `$HOME`-installed tool resolves correctly inside the sandbox (unchanged,
   since the sandbox's `$HOME` is the real host `$HOME`).
6. **home-installed-tool-runs**: A tool symlinked from `~/.local/bin` into
   `~/.local/share` actually executes inside the sandbox.
