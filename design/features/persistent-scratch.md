---
target-version: 2.4.0
status: draft
tags: [feature, filesystem, scratch]
---

# Persistent Scratch via a `scratch` Symlink

## Summary

A symlink named exactly `scratch` at the project root opts a session into a
persistent, read-write area outside the project tree — for cloning and
patching a third-party dependency, pulling down a dataset, writing analysis
output, anything that shouldn't live in the project's own git history but
needs to survive session restarts. No flag, no config file: the symlink's
presence is the entire mechanism, matching `.agentreadonly`'s existing
"a file's presence changes behaviour" convention.

## Motivation

Direct mode's project bind is already a true read-write passthrough, but
nothing about it survives between sessions except what gets committed. A
persistent scratch area needs a stable location outside the ephemeral
sandbox, a stable position relative to the project so relative paths keep
resolving session to session, and it needs to not silently upgrade access to
something scoder already treats as protected.

## Implementation

[IMPLEMENTED_BY](/src/git/protection.ts#setupScratchLink)
[IMPLEMENTED_BY](/src/index.ts)

- The symlink itself is never touched. Its target is resolved from the
  symlink's own stored string (works even when the target doesn't exist yet
  — `realpath(1)` fails outright in that case, which this deliberately
  avoids depending on) and mirrored at that **same real absolute path** —
  the same path-mirroring principle the project bind and the worktree
  git-common-dir bind already use, just applied outside the project.
- The target must resolve inside the real `$HOME` — a hard error (exit 1)
  otherwise. A target that doesn't exist yet is different: warn and skip,
  session continues. That dangling state is treated as valid and
  informative (a fresh clone or a new colleague can see exactly what local
  setup step is missing), not a failure.
- If the resolved target overlaps something scoder already treats as
  read-only — an `.agentreadonly` `$HOME/...` entry, or one of
  `buildExtraBinds`' fixed host-tool paths (`~/.local/bin`, `~/.gitconfig`,
  `~/.cargo/bin`, `~/.rustup`, `~/.m2`, `~/.npmrc`, `~/.pypirc`,
  `~/.config/gh`, `~/.local/share/mise`, `~/.config/mise`, `~/R`,
  `~/.Rprofile`) — the mirrored bind is `ro-bind`, not `bind`. `scratch`
  resolves and is usable either way; it just isn't writable when it points
  at something already deliberately protected.
- No change to the existing project bind. Rejected during design: splitting
  the project bind into one bind per top-level entry (works, but changes how
  the *entire* project gets mounted the moment `scratch` exists, for no
  benefit); and overlayfs (also capable of shadowing the one entry, but its
  copy-up write semantics would silently break direct mode's write-through
  passthrough for every file in the project, not just `scratch`).
- Tracked (committed) or gitignored, either works. Tracked is recommended:
  git stores a symlink as a path-string blob, never dereferencing it, so a
  fresh `git worktree add` checkout carries it automatically — no
  scoder-side worktree-recreation logic needed.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./path-mirroring.md)
[HAS_FEATURE](./infrastructure-protection.md)

[HAS_TEST](../test-scripts/validation-suite.md)
