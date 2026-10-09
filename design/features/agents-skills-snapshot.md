---
target-version: 2.1.0
status: draft
tags: [feature, skills, agents]
---

# Agent Skills Snapshot

## Summary

`~/.agents` is copied (with symlink resolution via `cp -aL`) to a temporary
directory under `/tmp` at session startup, then bind-mounted read-only into
`$HOME/.agents` (the real host `$HOME`).

## Motivation

Agent skills stored in `~/.agents` often use symlinks to reference skills
installed elsewhere. Direct binding of `~/.agents` would not resolve these
symlinks inside the sandbox. The snapshot approach resolves symlinks at copy
time while keeping the skills usable read-only.

## Trade-off

The sandbox sees a startup-time snapshot. Live updates to `~/.agents` made
after the session begins are not visible.

## The scoder skill

The snapshot also carries scoder's own skill,
`skills/working-in-a-scoder-sandbox/SKILL.md`, embedded in the binary and
written to `skills/working-in-a-scoder-sandbox/` in the copy unless the
user's `~/.agents` already has one there (theirs wins). When the host has
no `~/.agents` at all, the snapshot is still made, holding just the skill.
The host's directory is never written. This replaced an `AGENTS.md`
instruction to `npx skills add` it, which could not work from inside: the
snapshot is read-only.

Claude Code reads `~/.claude/skills` instead, which is bound read-write from
the host, so the `claude` preset adds a staged copy of the skill bound
read-only at `~/.claude/skills/working-in-a-scoder-sandbox`, after the
`~/.claude` bind so it lands on top. The accepted cost: bwrap creates that
directory (and `skills/`, if missing) on the host as the mountpoint, empty.
Skipped when the user's own `SKILL.md` is there — tested on the file, not
the directory, since the leftover mountpoint is an empty directory.
Verified under bwrap: readable, read-only inside, only the empty directory
left on the host.

**Open — keep an eye on it.** A first launch failed with `bwrap: Can't mkdir
~/.claude/skills/working-in-a-scoder-sandbox: No such file or directory`;
the next launch worked. Two causes are covered: a symlinked
`~/.claude/skills` (reproduced here with bwrap — now skipped) and a
missing `~/.claude/skills` on an older bwrap that does not create parent
mountpoint directories (unconfirmed; the dev container's newer bwrap does
create them — scoder now creates `skills/` itself first). The reporter
says no symlink existed, so the second theory, or something else, is the
live one. If it recurs: note the bwrap version (`bwrap --version`) and
`ls -la ~/.claude ~/.claude/skills` from just before the launch.

## Implementation

[IMPLEMENTED_BY](/src/git/protection.ts#setupAgentsSnapshot)

[HAS_FEATURE](./sandbox-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
