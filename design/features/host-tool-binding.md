---
target-version: 2.1.0
status: draft
tags: [feature, tools, configuration]
---

# Host Tool Binding

## Summary

Selective read-only bind mounts from the host home directory into the
sandbox's own `$HOME` (the real host `$HOME` — see `path-mirroring`) for
configuration every session needs: `.gitconfig`, `.config/gh`,
`.local/share/fonts`, `.config/mimeapps.list`, GTK themes and icons,
`.config/worktrunk/config.toml`.

Toolchain paths — `.cargo/bin`, `.rustup`, mise shims and config, R
packages and profile, `.m2`, uv's tools and pythons, `.npmrc`, `.pypirc` —
and `.local/bin` entries used to be bound here for every session. Since
[configure mode](./configure-mode.md) they are granted per project in
`.sandbox/readonly`/`readwrite` instead.

## Motivation

The sandbox HOME is ephemeral tmpfs. Host tools and configuration that the
AI tool relies on (git identity, language runtimes via mise/rustup, package
registries) must be available inside the sandbox. `.local/share/fonts` and
`.config/mimeapps.list` serve a different need — GUI presets (`rstudio`,
`eclipse`) need real fonts to render text at all, and desktop apps commonly
consult `mimeapps.list` for file-type "open with" associations — and
`worktrunk/config.toml` another again: worktrunk (`wt`) reads
`worktree-path` from it to decide where a new worktree goes, and without it
inside the sandbox `wt switch --create` falls back to worktrunk's own
default (a sibling of the repository), which is outside every bind scoder
sets up. It is the only host-level path worktrunk needs — everything else it
writes (caches, logs, branch markers, trash) lives in the repository's own
`.git/wt/`, already bound read-write, confirmed directly by tracing
`wt config state get`. Bound only when the file exists, which is a better
gate than the `wt` binary: a host with the binary and no config has nothing
to bind. Note that `~/.config/worktrunk/approvals.toml` is deliberately not
bound, so an approval granted inside a sandbox stays in that session. The
config's own `worktree-path` is separately overridden for the sandbox via
`WORKTRUNK_WORKTREE_PATH` — see
[design/features/git-worktree-isolation.md](/design/features/git-worktree-isolation.md). But the
same reasoning applies: read-only, host-provided, and otherwise
unavailable in a fresh tmpfs `$HOME`.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/builder.ts#buildExtraBinds)

Each path is checked for existence before binding. Missing paths are silently
skipped (the tool may not use them).

[HAS_FEATURE](./sandbox-isolation.md)
