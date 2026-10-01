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

**Decided: automatic, one-shot, no prompt.** The user base is small enough
that the cost of being clever outweighs the cost of being wrong, and the
alternatives are worse in ways that matter:

- *Hard fail* breaks every existing project on upgrade with no path forward.
- *Read both with a deprecation warning* leaves a compat shim that outlives
  everyone, and a window where two sources of truth disagree.
- *A `--migrate-config` command* is a step the user has to know about, and
  silently ignoring the legacy files until they run it means protections
  quietly stop applying — a security regression presented as an upgrade.

So: on finding legacy files and no `.sandbox/`, scoder creates the directory,
moves them, and says what it did. No flag, no prompt.

What that obliges, since scoder is now rewriting part of someone's
repository:

- **Say so, per file**, at `info` level. A silent `git status` full of
  renames is alarming.
- **Move, never copy-and-delete.** A failed copy that still unlinks the
  original loses a user's protection list.
- **Never overwrite.** If both `.agentreadonly` and `.sandbox/readonly`
  exist, the new one wins and the legacy file is left alone and reported, not
  merged. Merging two configs that disagree is how you get a protection list
  nobody wrote.
- **Migrate before anything reads configuration**, so the rest of startup
  sees only the new layout and no code path needs to know both.

### `.sandbox` is a generic name

Unlike `.agentreadonly`, `.sandbox` is plausible as something a project
already has — a test fixture directory, a Vagrant scratch area, a sandboxed
build output. scoder would bind it read-only and write defaults into it.

Mitigation, kept deliberately cheap: if `.sandbox/` exists and contains none
of scoder's own files, warn once that it is about to be bound read-only and
written into. A warning rather than a refusal, because refusing would block a
session over a directory that is probably fine, and the warning is enough to
explain an otherwise baffling build failure. A `.sandbox/README` written
alongside the defaults also makes the directory self-explanatory to the next
person who finds it in a diff.

Alternatives considered: `.scoder/` is unambiguous but ties project
configuration to one tool's name, which is the opposite of where `AGENTS.md`
went. `.agent/` keeps the existing prefix and reads oddly as a directory.
`.sandbox/` is the best of the three *provided* the collision check exists.

## Sequencing

1. **Hoist the three filenames to constants.** No behaviour change, and it
   turns step 3 into a small diff.
2. **The move itself**: the new paths, the automatic migration, and the
   directory bind that replaces the three per-file binds, deleting the
   "missing file is writable" machinery with it.
3. **Docs**, in the same commit as the code they describe so `em doc`'s link
   checking stays green.
4. **Test renames**, scripted, in a commit of their own so the mechanical
   change is reviewable apart from the behavioural one.
5. **Then `dbus-proxy`**, which assumes `.sandbox/` exists and adds
   `.sandbox/dbus` to it.

## Open Questions — all now decided

- **Does the read-only directory bind need the project bind first?** Yes.
  Ordering is how every other nested bind in this project works, and the
  parent here is writable, unlike the `/run` case that failed during the xpra
  work.
- **Should `.sandbox/` be created when a project has none?** Yes,
  automatically, as a documented feature rather than a side effect.
- **Is anything inside `.sandbox/` ever agent-writable?** No. Always
  read-only, which is what makes the whole directory self-protecting and
  removes the "missing file is writable" class outright.
- **Does the migration use `git mv`?** No, and no separate command either —
  plain moves, done automatically on first run.
- **Test names.** Renamed to match, scripted, in a commit of their own. The
  names are the validation suite's index and are cross-referenced by
  `[TESTED_BY]` links, so leaving 30 of them calling a file by a name it no
  longer has would be a lasting papercut in the one place a reader goes to
  find out how something is verified. Safe to do mechanically because
  `em doc`'s broken-link check and the failure-count baseline both catch a
  mistake immediately.
