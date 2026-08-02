---
target-version: 2.2.0
status: draft
tags: [feature, tools, bin, symlinks]
---

# Local Bin Symlink Resolution

## Summary

At session startup, `~/.local/bin` contents are copied to a temporary
directory under `/tmp`. A symlink whose target *is* bound into the sandbox is
kept as a symlink, with its target rewritten into the sandbox namespace; a
symlink whose target is not reachable has the target binary copied in instead.
Regular files are copied as-is with their exec bits. The result is bind-mounted
read-only at `/home/scoder/.local/bin`.

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
2. **Symlink** → resolved to its real target, and the target mapped into the
   sandbox namespace via `toSandboxPath` (see `path-mirroring`). If the mapped
   target lands under a path that is actually bound into the sandbox, the entry
   stays a symlink but points at the **mapped** target — keeping the host
   spelling would leave it dangling inside the sandbox. Otherwise the target
   binary itself is copied into the snapshot.
3. **Broken/missing symlink** → skipped silently (same as
   `setupAgentsSnapshot` handling of unreadable entries)
4. **Directory** → skipped silently

The result is bind-mounted read-only at `/home/scoder/.local/bin`.

### Which paths count as bound

Resolvability is checked against two sources, because guessing wrong in either
direction has a cost:

- `SANDBOX_MOUNT_PREFIXES` — the always-present host-tool binds. This list must
  mirror `buildExtraBinds` **exactly**, and name the precise bound paths rather
  than their parents. A prefix that is not really bound (an earlier version
  listed the parent `/home/scoder/.local`) makes the check claim resolvability
  it cannot deliver, and the entry dangles.
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

- Absolute symlink, target bound → symlink kept, target rewritten to
  `/home/scoder/...`
- Absolute symlink, target unbound and under the size ceiling → target binary
  copied in
- Absolute symlink, target unbound and oversized → mapped symlink written,
  resolves only if something else binds the directory; logged as unresolved
- Relative same-dir symlinks → kept as-is; they resolve within the snapshot
- Relative parent-path symlinks (`../`) → kept as-is; may or may not resolve
  inside the sandbox depending on what is bind-mounted
- Regular files → copied as-is with exec bits

## Implementation

[IMPLEMENTED_BY](/src/git/protection.ts#setupLocalBinSnapshot)
[HAS_FEATURE](./host-tool-binding.md)
[HAS_FEATURE](./agents-skills-snapshot.md)
[HAS_FEATURE](./path-mirroring.md)

## Design Decisions

### Why copy the target binary rather than write a forwarding shim?

A forwarding shim that does `exec /the/real/host/path "$@"` only works if that
host path is accessible inside the sandbox — and if it were, the symlink would
have worked unchanged. For a genuinely unreachable target the shim fails
exactly as the symlink did, just later and less legibly. Copying the target
makes it present. This mirrors `setupAgentsSnapshot`, which also copies.

### Why rewrite kept symlink targets instead of leaving them alone?

Symlink targets are resolved by the kernel *inside* the sandbox namespace, so
an absolute host target is interpreted against the sandbox's `/home`, which
contains only `scoder`. Leaving the host spelling in place produces an entry
that looks correct on the host and dangles in the sandbox — the failure mode
that made `scoder claude` exit with `execvp: No such file or directory`.

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
   `$HOME`-installed tool is rewritten to `/home/scoder`.
6. **home-installed-tool-runs**: A tool symlinked from `~/.local/bin` into
   `~/.local/share` actually executes inside the sandbox.
