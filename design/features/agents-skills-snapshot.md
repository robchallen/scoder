---
target-version: 2.1.0
status: draft
tags: [feature, skills, agents]
---

# Agent Skills Snapshot

## Summary

The skills a project grants in `.sandbox/readonly` —
`$HOME/.agents/skills/<name>`, one per skill, or `$HOME/.agents` for the
whole directory — are copied (with symlink resolution) to a temporary
directory under `/tmp` at session startup, then bind-mounted read-only into
`$HOME/.agents` (the real host `$HOME`). scoder's own skills are always
added. A configure session gets the whole directory, to choose from.

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
user's `~/.agents` already has one there and the project grants it
(theirs wins). When the host has
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

**Resolved: symlinked skills directories.** A first launch failed with
`bwrap: Can't mkdir ~/.claude/skills/working-in-a-scoder-sandbox: No such
file or directory`. Cause, confirmed by the reporter: `~/.claude/skills` was
a symlink to `~/.agents/skills` — a common way to share skills between
agents. The `~/.claude` bind brings the symlink in, but its target (the
`~/.agents` snapshot) is mounted *later* in the inner layer, so at the
moment of the skill bind the symlink dangles and bwrap cannot make a
mountpoint through it. Reproduced under bwrap. The Claude bind is now
skipped when `~/.claude/skills`, or the skill path itself, is a symlink;
once the snapshot is mounted the symlink resolves to it, and it already
holds the injected skill. The reverse arrangement (`~/.agents/skills`
linking to a real `~/.claude/skills`) needs no special case: the snapshot
is copied with symlinks resolved, and the Claude bind goes to a real
directory. scoder also creates a missing `~/.claude/skills` before binding,
as cheap insurance.

## Implementation

[IMPLEMENTED_BY](/src/git/protection.ts#setupAgentsSnapshot)

[HAS_FEATURE](./sandbox-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
