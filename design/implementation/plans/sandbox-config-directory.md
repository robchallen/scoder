---
target-version: 2.8.0
status: draft
tags: [plan, config, breaking-change, migration]
---

# Move `.agent*` Into a `.sandbox/` Directory

## Goal

Replace three (soon four) dotfiles in every project root with one directory:

| today | proposed |
|---|---|
| `.agentreadonly` | `.sandbox/readonly` |
| `.agentreadwrite` | `.sandbox/readwrite` |
| `.agentports` | `.sandbox/ports` |
| *(planned `.agentdbus`)* | `.sandbox/dbus` |

`AGENTS.md` does **not** move. It is a cross-tool convention that other
agents read, not scoder configuration.

This is a breaking change to a user-facing interface. The analysis below is
what it actually costs, what it actually buys, and where the sharp edges are.

## What it buys, beyond tidiness

### It deletes a bug class, not just three filenames

Each file is bound read-only **individually** today, and a bind needs a
source. So a file that does not exist gets no bind — and is therefore
*writable from inside the sandbox*. That is not hypothetical: it was found
and fixed twice, and the suite carries three regression tests for it
(`agentreadonly-missing-file-not-writable-from-sandbox`,
`agentports-missing-file-not-writable-from-sandbox`, and the `.agentreadwrite`
equivalent), plus explanatory paragraphs in two feature docs:

> a missing source path gets no bind mount at all, which previously left the
> freshly created default writable from inside that same session

Binding **the directory** removes the whole class. A file created inside
`.sandbox/` after the bind is covered automatically, because the bind is of
the directory, not of each file. The three tests become one, and two feature
docs lose a paragraph each.

The same property makes the D-Bus allowlist self-protecting for free rather
than needing its own bind and its own regression test — which is why
`dbus-proxy` now assumes this lands first.

### Host writes still reach the sandbox

Worth stating, because it is the thing a reader will worry about: a read-only
bind of a directory does not stop the **host** writing into it. The sandbox
sees the same inodes, so `scoder` appending an auto-detected port from
outside still shows up inside, exactly as it does today with a per-file bind.
Read-only constrains the sandbox, not scoder.

### One `.gitignore` line instead of three

A project that does not want this committed adds `.sandbox/` once.

## What it costs

### Scale

| | sites |
|---|---|
| `src/git/protection.ts` | 54 |
| `src/sandbox/launch.ts` | 8 |
| `src/index.ts` | 4 |
| `src/cli/parse-args.ts` | 2 |
| `src/types.ts` | 1 |
| `tests/scoder.test.ts` | ~150 occurrences, **30 test names** |
| `design/` | 28 documents |
| `skills/`, `README.md` | 2 |

Roughly 360 raw occurrences. Most are mechanical, but the test names are
not: they are the validation suite's index, cross-referenced from
`design/test-scripts/validation-suite.md` by `[TESTED_BY]` links that `em doc`
checks. Renaming a test means renaming its documented case in the same
commit, or the link check fails.

Two of the three filenames are already constants (`AGENT_PORTS_FILE`,
`AGENT_READWRITE_FILE`); `.agentreadonly` is an inline template string at
`protection.ts:167`. Hoisting all three to constants **first**, as a separate
no-behaviour-change commit, makes the actual move a small diff and is worth
doing for its own sake.

### The migration is the hard part, not the rename

A user upgrading has files scoder will stop reading. Silently ignoring them
is the worst outcome available: `.agentreadonly` ignored means protections
quietly stop applying, which is a security regression presented as an
upgrade.

Three options, in increasing order of how much I like them:

1. **Hard fail** on finding a legacy file. Safe, and hostile — it breaks
   every existing project on upgrade with no path forward except manual work.
2. **Auto-migrate**: create `.sandbox/`, move the files, tell the user. One
   step, but scoder would be rewriting the layout of someone's repository
   without being asked. scoder creates files today; moving and deleting them
   is a different category.
3. **Read both, prefer `.sandbox/`, warn on legacy, and offer
   `scoder --migrate-config`** to do the move when the user chooses. Nothing
   breaks, nothing is lost, the warning names the command, and the compat
   shim can be deleted after a release or two.

**Recommend 3.** It is the only one where a user who upgrades mid-task
notices nothing until they read the warning. The deprecation needs a stated
removal version in the warning text, or it will still be there in 2028.

One wrinkle for option 3: if a project has *both* (say, a half-finished
migration), `.sandbox/` should win and the legacy file should be reported as
ignored — stating which file was used matters more than being clever about
merging them.

### `.sandbox` is a generic name

Unlike `.agentreadonly`, `.sandbox` is plausible as something a project
already has — a test fixture directory, a Vagrant scratch area, a sandboxed
build output. scoder would bind it read-only and write defaults into it.

Mitigation: on first run, if `.sandbox/` exists and contains nothing scoder
recognises, say so and refuse to write into it rather than assuming it is
ours. A `.sandbox/README` written alongside the defaults also makes the
directory self-explanatory to the next person who finds it in a diff.

Alternatives considered: `.scoder/` is unambiguous but ties project
configuration to one tool's name, which is the opposite of where `AGENTS.md`
went. `.agent/` keeps the existing prefix and reads oddly as a directory.
`.sandbox/` is the best of the three *provided* the collision check exists.

## Sequencing

1. **Hoist the three filenames to constants.** No behaviour change, and it
   turns step 3 into a small diff.
2. **Collision check and `--migrate-config`**, both of which can land before
   anything moves.
3. **The move itself**, including the directory bind that replaces the three
   per-file binds, and deleting the "missing file is writable" machinery and
   its tests.
4. **Docs and test renames**, in the same commit as the code they describe so
   `em doc`'s link checking stays green.
5. **Then `dbus-proxy`**, which assumes `.sandbox/` exists and adds
   `.sandbox/dbus` to it.

## Open Questions

- **Does the read-only directory bind need the project bind to come first?**
  Almost certainly yes — ordering is how every other nested bind in this
  project works — but it is one `--dry-run` away from being confirmed rather
  than assumed, and the parent here is writable, unlike the `/run` case that
  failed during the xpra work.
- **Should `.sandbox/` be created when a project has none?** Today scoder
  writes three dotfiles into every project it touches. A directory is tidier
  but no less intrusive, and "scoder created a directory in my repo" is a
  more noticeable event than "scoder created a dotfile". Worth deciding
  deliberately rather than inheriting the current behaviour by default.
- **Is anything inside `.sandbox/` ever agent-writable?** Binding the whole
  directory read-only forecloses that. Nothing wants it today; it is a
  constraint being chosen rather than discovered.
- **Does `--migrate-config` use `git mv`?** It would keep history for a
  tracked file, but means failing or falling back in a repo where the files
  are untracked. Probably plain moves with a note, but it should be a
  decision.
