---
target-version: 2.1.0
status: draft
tags: [feature, tools, configuration]
---

# Host Tool Binding

## Summary

Selective read-only bind mounts from the host home directory into
`/home/scoder` for development tools and configuration that the sandboxed
process needs: `.gitconfig`, `.local/bin`, `.cargo/bin`, `.rustup`, mise
shims and config, R packages and profile, `.m2` (Maven), `.npmrc`,
`.pypirc`.

## Motivation

The sandbox HOME is ephemeral tmpfs. Host tools and configuration that the
AI tool relies on (git identity, language runtimes via mise/rustup, package
registries) must be available inside the sandbox.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/builder.ts#buildExtraBinds)

Each path is checked for existence before binding. Missing paths are silently
skipped (the tool may not use them).

[HAS_FEATURE](./sandbox-isolation.md)
