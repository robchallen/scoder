---
target-version: 2.4.0
resolved-in: 2.4.0
status: resolved
tags: [issue, sandbox, filesystem]
---

# `update-alternatives` Cannot Find Its Own State Inside the Sandbox

> **Fixed in 2.4.0.** `buildBwrapCommand` now conditionally binds
> `/var/lib/dpkg/alternatives` (Debian/Ubuntu) and `/var/lib/alternatives`
> (Fedora/RHEL and derivatives) read-only, alongside the other conditional
> system binds (`/lib64`, `/sbin`, `/sys`, `/run`). Covered by
> `update-alternatives-state-mounted`, which reuses the daemonize-then-exit
> fake pasta shim from `terminal-signals-forwarded-to-sandbox` so the real
> scoder binary can run this end-to-end (this environment's own lack of
> `/dev/net/tun` would make a real pasta attach non-deterministic here, and
> what's under test is a filesystem bind, not pasta) — and asserts the
> sandboxed output matches the host's own `update-alternatives --list`
> output exactly, not just "did not error."

## Summary

Reported: "binaries that use update-alternatives cannot be found" inside a
scoder sandbox. Investigation found the binaries themselves always ran
fine — the report describes `update-alternatives`'s own management commands
(`--list`, `--query`, `--display`, `--config`) failing, not the underlying
tool being missing.

## Root Cause

Debian's `update-alternatives` — and the equivalent on RPM-based
distributions — splits an alternative's data across two separate
locations:

- **`/etc/alternatives/<name>`**: a symlink to whichever choice is
  currently selected. This is what actually running the alternative
  depends on, and `/etc` is fully `ro-bind`ed into the sandbox already, so
  this half always worked.
- **`/var/lib/dpkg/alternatives/<name>`** (or `/var/lib/alternatives/<name>`
  on RPM-based systems): the administrative state — every registered
  choice, its priority, and whether the group is in `auto` or `manual`
  mode. `update-alternatives` itself reads *this* file to answer `--list`,
  `--query`, `--display`, or to do `--config`/`--set`. Nothing under `/var`
  was ever bound into the sandbox at all.

Confirmed directly, not inferred: built the exact bwrap invocation
`buildBwrapCommand` generates (verified via `--dry-run`, then actually
executed, bypassing only the fd-shim/pasta machinery which is orthogonal to
this bug) and ran it by hand.

```
$ java -version
openjdk version "25.0.3" 2026-04-21
...                                          # <- runs fine

$ update-alternatives --list java
update-alternatives: error: no alternatives for java
                                              # <- fails: no /var/lib/dpkg/alternatives/java to read
```

Adding `--ro-bind /var/lib/dpkg/alternatives /var/lib/dpkg/alternatives` to
that same invocation fixed `--list`/`--display`/`--query` immediately, and
a genuinely mutating command (`--install`, `--set`) still correctly fails
with `Read-only file system` — consistent with every other system path in
the sandbox, and confirmed directly rather than assumed:

```
$ update-alternatives --install /usr/bin/foo foo /bin/true 1
update-alternatives: using /bin/true to provide /usr/bin/foo (foo) in auto mode
update-alternatives: error: unable to remove '/etc/alternatives/foo.dpkg-tmp': Read-only file system
```

## A Related, Separate Finding (Not Fixed Here)

While tracing this, `isSymlink()` in `src/sandbox/builder.ts` — used to
skip an explicit `--ro-bind /sbin /sbin` when `/sbin` is a symlink into
`/usr/sbin` on merged-usr systems, since `/usr` already covers it — turned
out to be silently broken. It calls `Bun.file(path).stat()`, which follows
symlinks (confirmed directly: `Bun.file("/lib64").stat().isDirectory()`
returns `true`, describing the *target*, not the link itself), so
`stat.isSymbolicLink()` can never be true for a symlink whose target
exists. The guard is dead code: `/sbin` always gets bound explicitly, on
every host, symlink or not. Harmless in practice — a redundant read-only
bind of content already reachable via `/usr` — but a real latent bug,
separate from this one, and out of scope here since it doesn't affect
correctness (only wastes one bind entry). Not filed as its own issue
record; noted here since it surfaced from the exact same investigation and
the same code region.

## Verified Groundwork

| Claim | Result |
|---|---|
| The binary itself (`java`) runs correctly via the `/etc/alternatives` symlink chain, with only `/etc` and `/usr` bound | **Yes** — confirmed directly, `java -version` succeeds. |
| `update-alternatives --list`/`--query`/`--display` fail without `/var/lib/dpkg/alternatives` bound | **Yes** — confirmed directly, `error: no alternatives for <name>`. |
| Binding `/var/lib/dpkg/alternatives` read-only fixes the read-side commands | **Yes** — confirmed directly, output matches the host's own. |
| A mutating command (`--install`, `--set`) still correctly fails read-only | **Yes** — confirmed directly, `Read-only file system`. |
| bwrap auto-creates missing intermediate directories (`/var`, `/var/lib`) for a `--ro-bind` destination, without an explicit `--dir` first | **Yes** — confirmed directly: the bind succeeded with no `--dir /var` or `--dir /var/lib` anywhere in the test invocation. |
| `isSymlink()` correctly detects `/sbin` as a symlink | **No** — confirmed directly, always returns `false` for a resolvable symlink; see "A Related, Separate Finding" above. |

[IMPACTS](/src/sandbox/builder.ts)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
