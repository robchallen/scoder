---
target-version: 2.1.0
status: draft
tags: [feature, tools, configuration]
---

# Host Tool Binding

## Summary

Selective read-only bind mounts from the host home directory into the
sandbox's own `$HOME` (the real host `$HOME` — see `path-mirroring`) for
development tools and configuration that the sandboxed process needs:
`.gitconfig`, `.local/bin`, `.cargo/bin`, `.rustup`, mise shims and config,
R packages and profile, `.m2` (Maven), `.npmrc`, `.pypirc`, `.config/gh`,
`.local/share/fonts`, `.config/mimeapps.list`.

## Motivation

The sandbox HOME is ephemeral tmpfs. Host tools and configuration that the
AI tool relies on (git identity, language runtimes via mise/rustup, package
registries) must be available inside the sandbox. `.local/share/fonts` and
`.config/mimeapps.list` serve a different need — GUI presets (`rstudio`,
`eclipse`) need real fonts to render text at all, and desktop apps commonly
consult `mimeapps.list` for file-type "open with" associations — but the
same reasoning applies: read-only, host-provided, and otherwise
unavailable in a fresh tmpfs `$HOME`.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/builder.ts#buildExtraBinds)

Each path is checked for existence before binding. Missing paths are silently
skipped (the tool may not use them).

[HAS_FEATURE](./sandbox-isolation.md)
