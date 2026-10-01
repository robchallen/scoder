---
target-version: 2.5.0
status: draft
tags: [feature, filesystem, agentreadwrite]
---

# Persistent Read-Write Access via `.sandbox/readwrite`

## Summary

A `.sandbox/readwrite` file at the project root lists `$HOME/...` directories
to bind read-write into the sandbox — a persistent cache, analysis output,
or any other directory outside the project tree that needs to survive
session restarts. One line per directory, exactly the same `$HOME/...`
line format `.sandbox/readonly` already uses for its own home binds, just
opening write access instead of read-only.

## Motivation

Direct mode's project bind is already a true read-write passthrough, but
nothing about it survives between sessions except what gets committed. A
persistent area outside the project needs a stable, predictable location,
and it needs to not silently upgrade access to something scoder already
treats as protected, or contradict what `.sandbox/readonly` already says about
the same path.

## Implementation

[IMPLEMENTED_BY](/src/git/protection.ts#setupReadWriteAccess)
[IMPLEMENTED_BY](/src/index.ts)

- One line per directory, `$HOME/<relative-path>`. Any line not starting
  with `$HOME/` is a hard error (exit 1) — unlike `.sandbox/readonly`, which
  also accepts local gitignore-style patterns for its own, separate
  protected-paths mode, `.sandbox/readwrite` supports nothing outside `$HOME`
  at all; there is no local-path mode to fall back to.
- **A missing target directory is created** (`mkdir -p`), not treated as
  an error and not left dangling. This is the one deliberate difference
  from `.sandbox/readonly`'s own `$HOME/...` binds, which require the target
  to already exist: the motivating use cases (`$HOME/.cache/<tool>`, a
  fresh `$HOME/<project>/figures` output directory) are commonly
  directories that don't exist yet on a machine's first run, and there is
  no "protect existing infrastructure" reasoning here working against
  that, unlike the read-only case. Skipped under `--dry-run`, which must
  stay side-effect free — the entry still appears in the dry-run preview,
  resolved best-effort.
- **Must resolve inside `$HOME`.** A symlink-based escape (the target
  resolves outside `$HOME` even though the line itself named a path under
  it) is a hard error, the same check `.sandbox/readonly`'s own HOME binds
  already apply.
- **Must not overlap a *fixed* scoder bind** — `fixedBindDestinations`
  (`src/git/protection.ts`), the exact real host paths scoder itself
  unconditionally binds every session (`buildExtraBinds`' host-tool list,
  a preset's own top-level dir like `.claude`/`.copilot`, the agent-skills
  snapshot). Shared with `.sandbox/readonly`'s own `$HOME/...` overlap
  check, not a separately-maintained list — both mechanisms need the same
  answer to "does this path collide with something scoder itself already
  places here." Deliberately **not** the bare namespace umbrellas a
  dynamic, per-preset sub-path happens to live under (`.cache`, `.config`,
  `.local` as bare entries) — those are never themselves bound, just
  scaffolded empty by `builder.ts`'s own `--dir` list.
  `$HOME/.cache/<tool>` — one of this feature's own motivating use cases —
  is nested under `.cache` without colliding with anything scoder itself
  put there, so blocking it would reject a perfectly safe case for no
  real protection. The check is still bidirectional, so an entry that is
  an *ancestor* of a fixed destination (e.g. bare `$HOME/.config`) is
  still correctly rejected.
- **Must not overlap an `.sandbox/readonly` `$HOME/...` entry.** The same
  path listed in both files, with directly opposite intents (protect vs.
  open for writing), is a hard error naming the conflicting path — reuses
  `ProtectionConfig.dependencyDirs` (already exactly the set of
  `.sandbox/readonly`'s own `$HOME/...` sandbox destinations) rather than a
  new, separately-maintained list.
- `.sandbox/readwrite` itself is always bound read-only into the sandbox,
  unconditionally — the same self-protection `.sandbox/readonly` and
  `.sandbox/ports` already give themselves. Created (a single header
  comment) if missing, before any bind is computed, skipped under
  `--dry-run` — the same bug class already fixed twice for those two
  files: a missing source path gets no bind mount at all, which would
  leave a freshly created default writable from inside the very session
  that finds it missing.
- Every directory named is bound at its own real, unmapped absolute path
  (`--bind <path> <path>`) — the sandbox's own `$HOME` already *is* the
  real host `$HOME` (see `path-mirroring`), so no remapping is needed or
  done.

## History

Replaces the earlier `scratch` symlink convention (one symlink, one target,
no format validation on where it could point, silently downgraded to
read-only on collision with something already protected). `.sandbox/readwrite`
generalizes it: any number of directories in one file, validated with
`.sandbox/readonly`'s own existing `$HOME/...` machinery rather than a
separate resolution path, and a genuine conflict with `.sandbox/readonly` is a
hard error rather than a silent downgrade.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./path-mirroring.md)
[HAS_FEATURE](./infrastructure-protection.md)

[HAS_TEST](../test-scripts/validation-suite.md)
