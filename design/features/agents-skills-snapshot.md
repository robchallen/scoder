---
target-version: 2.8.0
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
- **Selection.** `.sandbox/skills`: one regular expression per line, `#`
  comments, each matched against the whole name. Missing file: the shipped
  default, `.*`. A line that does not compile is warned about and skipped
  (and refused by the configure review).
- **scoder's own skills** (`working-in-a-scoder-sandbox`,
  `configure-scoder-sandbox`) are always added, unless a selected skill of
  the same name is there already (the user's copy wins).
- **Where.** Bound read-only at the main agent's own user-skills
  directory: Claude Code `~/.claude/skills`, pi `~/.pi/agent/skills`,
  opencode `~/.config/opencode/skills`, Copilot `~/.copilot/skills`; any
  other tool `~/.agents/skills`. Only there: with `--bind claude pi`, pi
  gets the skills and Claude Code's directory is as the host has it. When
  that directory is a symlink on the host, the bind goes to its target —
  bwrap cannot make a mountpoint through a link whose target is not
  mounted (reported earlier as `Can't mkdir ~/.claude/skills/...`). bwrap
  leaves an empty directory as the mountpoint when the host has none.
- **Configure sessions** ignore `.sandbox/skills` and bind every
  candidate, and the staged `configure-scoder-sandbox` skill ends with a
  table of them ("Skills on this machine": name, where found,
  description), so the agent can choose.
- **Recipes** carry a *Skills* section: the patterns for that kind of
  project.

## Limitations

- An agent that also reads other directories still sees them if they are
  bound: opencode reads `~/.claude/skills` and `~/.agents/skills` too, so
  `scoder --bind claude opencode` shows it Claude's skills unfiltered.
- A snapshot: skills changed on the host mid-session are not seen.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/skills.ts)

Wired from `skillsBind` in `src/index.ts`; the shipped default is
`src/defaults/skills`.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./configure-mode.md)

[HAS_TEST](../test-scripts/validation-suite.md)
