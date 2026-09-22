---
target-version: 2.2.0
status: draft
tags: [feature, git, sandbox]
---

# Path Mirroring

## Summary

Every host path — the worktree, the host `.git` directory, and (as of the
$HOME rename) the home directory itself — is mounted at its own real
absolute path inside the sandbox, not remapped onto a separate synthetic
namespace. Git cross-references (`.git` file pointing to main
`.git/worktrees/`) resolve correctly without path translation, and so does
anything else that persists an absolute host path (Eclipse's own p2 profile
registry, tool caches, `.location` files, etc.) — the sandbox and the host
agree on what a given path means.

The one thing still translated is **spelling**, not location: `$HOME` can
have more than one valid spelling on the host (the raw `$HOME` value and its
symlink-resolved form, when they differ, as they commonly do on network
homes) — `toSandboxPath` canonicalizes those onto the one spelling actually
bound into the sandbox. It is not a remapping into a different namespace
any more.

## Problem

Git worktrees use a `.git` **file** (not directory) containing:
```
gitdir: /path/to/main/.git/worktrees/<name>
```

And the main repo's `.git/worktrees/<name>/gitdir` points back:
```
$HOME/<dirname(projDir)>/worktrees/<basename(projDir)>/scoder
```

If the sandbox remapped paths onto a separate namespace, these
cross-references would break — this was true when `/home` was replaced with
a synthetic `/home/scoder`, and would be equally true today if the worktree
were naively mapped onto `$HOME/<projDir>`: with $HOME no longer a separate
sandbox-only namespace, that would collide with the project's own real
checkout living at that same path. The worktree instead lives at a distinct
sibling location — see `git-worktree-isolation` — specifically to avoid that
collision while still being a real, unmapped, absolute path both inside and
outside the sandbox.

## Home spelling canonicalization

`$HOME` used to be the deliberate exception to path mirroring: `/home` was
replaced by a tmpfs containing only a synthetic `/home/scoder`, so every host
path under the real home directory had to be rewritten before it could cross
into the sandbox. That is no longer true — the sandbox's own `$HOME` is the
real host `$HOME`, bound at the same path on both sides, mirrored like
everything else.

What's left for `toSandboxPath` to do is narrower: `$HOME` may itself be a
symlink (common with network homes), in which case `which` and `realpath`
return the resolved spelling while the raw `$HOME` env var does not. Both
spellings refer to the same real, bound-in directory, but only one of them is
the literal path the sandbox has mounted things at — `toSandboxPath` rewrites
the resolved spelling onto the raw one. `resolveHomePrefixes` returns both
spellings so either form gets canonicalized correctly. Three call sites need
this:

1. **The exec target.** `which <tool>` resolves the tool on the host; if that
   resolution went through a symlinked `$HOME`, the returned path needs
   canonicalizing onto the raw `$HOME` spelling before it's passed to bwrap.
2. **Snapshot symlink targets.** Absolute symlink targets copied into the
   `~/.local/bin` snapshot need the same canonicalization. See
   `local-bin-resolution`.
3. **Resolvability checks.** Deciding whether a symlink target will exist in
   the sandbox requires comparing the canonicalized path against the bind
   set.

A tool under `$HOME` in a directory that is not bound cannot work at all. That
case is detected before launch by comparing the mapped path against the bind
destinations of the built bwrap command (`collectBindDests`), and reported as an
actionable error rather than left to pasta.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/builder.ts#buildBwrapCommand)
[IMPLEMENTED_BY](/src/utils/paths.ts#toSandboxPath)

- Worktree is bound from its real path into the same path inside the sandbox
- `.git` directory is bound from its real path into the same path
- `GIT_WORK_TREE` is intentionally **not** set, relying on git's built-in worktree discovery
- `$HOME` is bound at its own real path (see `getRealHome` in `src/utils/paths.ts`); `toSandboxPath` only canonicalizes a symlink-resolved spelling of `$HOME` onto the raw one, it no longer rewrites onto a separate namespace

## Testing

[HAS_TEST](../test-scripts/validation-suite.md)

[HAS_FEATURE](./git-worktree-isolation.md)
[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./local-bin-resolution.md)
