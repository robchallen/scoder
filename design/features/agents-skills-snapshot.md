---
target-version: 3.0.0
status: implemented
tags: [feature, skills, agents]
---

# Agent Skills

## Summary

At session start scoder finds every agent skill on the machine, keeps the
ones the project's `.sandbox/skills` selects, adds its own, copies them
(symlinks resolved) into one staged directory, and binds that read-only
where the session's main agent reads skills.

## Motivation

Skills are scattered: `~/.agents/skills`, `~/.claude/skills`, each agent's
own directory, and the project's. Agents read only their own locations,
symlinks between them dangle inside a sandbox that does not bind their
targets, and a machine with many skills gives every session all of them,
relevant or not. An earlier version copied `~/.agents` whole; then
explicit grants (`$HOME/.agents/skills/<name>` in `readonly`) briefly
replaced it, which left most sessions with no skills at all.

## Behavior

- **Candidates.** `find -L` for `SKILL.md` (depth 2-4) under the project's
  `.agents/skills`, `.claude/skills`, `.github/skills`, `.opencode/skills`,
  `.pi/skills`, then the user's `~/.agents/skills`, `~/.claude/skills`,
  `~/.copilot/skills`, `~/.config/opencode/skills`, `~/.pi/agent/skills`.
  A skill's name is its directory's name. Deduplicated by name and by
  resolved directory, first found wins — so project skills shadow the
  user's.
- **Selection.** The baseline `~/.config/scoder/sandbox/skills` plus the
  project's `.sandbox/skills`: one regular expression per line, `#`
  comments, each matched against the whole name. The shipped baseline
  selects nothing; a missing project file starts a configure session on
  an interactive start. A line that does not compile is warned about and skipped
  (and refused by the configure review).
- **scoder's own skills** (`working-in-a-scoder-sandbox`,
  `configure-scoder-sandbox`) are always added, unless a selected skill of
  the same name is there already (the user's copy wins).
- **Where.** Bound read-only at the main agent's own user-skills
  directory: Claude Code `~/.claude/skills`, pi `~/.pi/agent/skills`,
  opencode `~/.config/opencode/skills`, Copilot `~/.copilot/skills`; any
  other tool `~/.agents/skills`. The other directories that agent also
  reads (pi and Copilot: `~/.agents/skills`; opencode: `~/.claude/skills`
  and `~/.agents/skills`) are hidden behind an empty directory when they
  exist on the host, so the agent sees each selected skill once; when
  they do not exist nothing is bound, so nothing is created there. With
  `--bind claude pi`, only pi's directories are touched. When
  that directory is a symlink on the host, the bind goes to its target —
  bwrap cannot make a mountpoint through a link whose target is not
  mounted (reported earlier as `Can't mkdir ~/.claude/skills/...`). bwrap
  leaves an empty directory as the mountpoint when the host has none.
- **The list.** In every session the staged `configure-scoder-sandbox`
  skill ends with a table of every candidate ("Skills on this machine":
  name, where found, whether this session has it, description), so an
  agent asked for a missing skill knows it exists locally and how to add
  it. The table is from start-up; the live watch below does not rewrite
  it.
- **Configure sessions** ignore `.sandbox/skills` and bind every
  candidate.
- **Recipes** carry a *Skills* section: the patterns for that kind of
  project.

- **Live.** In an ordinary session scoder polls `.sandbox/skills` and the
  baseline's `skills` every 2 s (`SCODER_SKILLS_POLL_MS`). On a change it
  re-discovers and re-selects, and makes the staged directory match —
  newly selected skills copied in, deselected ones removed, scoder's own
  kept. The staged directory is the bind source, so the change is visible
  in the sandbox at once; the agent picks it up on its own skills reload
  (e.g. `/reload`), with no scoder restart.

## Limitations

- Copilot may also read `~/.claude/skills` (unconfirmed); it is not hidden.
- The content of an already-selected skill is a start-up copy: edits to
  it on the host are not seen until it is deselected and reselected, or
  scoder restarts.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/skills.ts)

Wired from `skillsBind` in `src/index.ts`; the shipped default is
`src/defaults/skills`.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./configure-mode.md)

[HAS_TEST](../test-scripts/validation-suite.md)
