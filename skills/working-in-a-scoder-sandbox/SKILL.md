---
name: working-in-a-scoder-sandbox
description: 'Use when the current git branch matches `scoder/*` or when the user tells you that you are in a scoder sandbox or scoder worktree. Use this if the user requests you update your copy of the code to incorporate changes from upstream and you detect you are in a sandbox. Use if you find that full paths that previously worked fail and your home directory is now `/home/scoder`. Use if you are unexpectedly unable to write to a configuration file in your home directory like AGENTS.md. Do NOT use for generic Git advice outside scoder or for unrelated sandbox/container environments.'
license: MIT
allowed-tools: Read Bash Grep Glob
---

# Working in a scoder sandbox

This skill explains how to behave when working inside a `scoder` sandboxed
worktree. It is a capability skill: it helps you reason about the
environment, choose Git commands that fit the workflow, and avoid assumptions
that are true in a normal checkout but false in a `scoder` session. The skill
gives you guidance about what Git and filesystem operations will or will not
behave normally inside a `scoder` session. It is helpful for deciding how to
pick up changes from `main`, when other checkouts can see your work, what paths
are protected, and when to commit.

`scoder` sandboxes are fairly permissive. They are not expected to prevent
intentional misuse but rather accidental filesystem errors and keep a
seperation between user and agent views of the repository. You still need to exercise
caution when composing bash commands.

## Available Scripts

No helper scripts are bundled with this skill.

## When to Use This Skill

Use this skill when:

- the current branch name matches `scoder/*` and your home directory is now `/home/scoder/`
- the user says that you are in a scoder sandbox or scoder worktree
- you need to decide whether a file write is likely to succeed inside scoder
- you need to bring upstream `main` changes into an in-progress sandbox session
- you need to know whether another checkout can already see sandbox changes
- file edits are failing and you are not sure why

Do not use this skill for:

- ordinary Git workflows outside scoder
- generic container, VM, or sandbox guidance unrelated to scoder

## Prerequisites

- A Git checkout where the active branch is a `scoder/*` branch, or the user
  has explicitly said the session is running inside scoder.
- Read access to the repository docs if you need to confirm details:
  [`references/scoder-sandbox-behavior.md`](references/scoder-sandbox-behavior.md).

## Workflow

### 1. Confirm you are really in the sandbox workflow

The strongest signal for this skill is that the current branch is `scoder/*`.
If the user only mentions scoder in passing, verify the branch or the current
working arrangement before giving sandbox-specific advice. Your `$HOME` is "/home/scoder"

### 2. Absolute paths may be different

Relative paths from `$HOME` will match exactly the layout of this repository outside
the sandbox. However your `$HOME` is `/home/scoder/` which is different from the
users `$HOME` variable outside the sandbox.

Use paths relative to `$HOME` so that your context will stay the same if you are moved out
of the sandbox later.

You may have stale context that uses absolute paths including the users `$HOME` if an original
session was started outside of the sandbox. If you replace their `$HOME` with `/home/scoder`
you should be able to find the file.

Symbolic links outside of the repository will probably be broken. A common problem is
with agent skill directories and this means you may not have a complete set of skills available.

### 2. Assume the sandbox branch started from the user's current `HEAD`

There is nothing special about `main`. A scoder session starts from whatever
branch or commit the user launched it from, then creates or reuses
`scoder/<repo>`.

This matters when reasoning about diffs and rebases: compare against the
current branch context, not against `main` by default.

### 3. Work as if the project worktree is writable but the environment is selective

What is usually safe:

- editing normal project files in the sandbox worktree
- running Git on the current `scoder/*` branch
- rerunning `scoder` from the same scoder worktree

What is usually constrained:

- writes to system paths such as `/usr`, `/etc`, `/bin`
- writes to protected infra files such as `.github/`, `.gitignore`, lockfiles,
  and `.agentreadonly` unless the repository's `.agentreadonly` configuration
  has explicitly relaxed protection
- writing to `AGENTS.md` is not possible.

When a task fails with a read-only error, first check whether the target is a
protected path or a broken symlink rather than assuming the whole worktree is broken.
Abandon an edit and confer with the user if you get a read only error.
`.agentreadonly` is a gitignore like file specifying places that the user does not want you to change.

### 4. Update from local changes in main branch explicitly

Inside the sandbox, do not assume `git pull` will bring in the latest `main`.
The scoder branch may not have an upstream configured for that purpose. The
local code is where the relevant changes are.

Prefer:

```bash
git rebase main
```

or:

```bash
git merge main
```

Use this when the user asks to pick up their latest local changes, or when you discover
that the branch you started from is behind the worktree root branch and the task depends on
those changes. **DO NOT** try and pull or merge from origin. You may have to manage merge conflicts.

**GOTCHAS**: If the user changes a read only protected file, then a rebase or merge will fail as
they are unable to update the sandbox copy (which will be read only). In this case the only
real option is for the user to fix things outside the sandbox.

### 5. Treat commits as the visibility boundary

Other checkouts do not see sandbox changes just because files were edited in
the scoder sandbox. They see changes when commits move the `scoder/*` branch.

That means:

- uncommitted edits are local to the active scoder worktree
- `git log`, `git diff <branch>`, merge, and rebase from another checkout only
  reflect committed state
- if the user expects review or integration from another checkout, commit first

### 6. Commit at meaningful checkpoints

Inside scoder, committing is not just for final cleanup. It is also how you:

- make progress visible outside the worktree
- create safe restore points before riskier rebases or merges
- allow the user to inspect branch state from another checkout

Commit often:

- After each round of changes is complete before you hand back to the user.
- before asking the user to review results from another checkout.
- before rebasing or merging if you have important in-progress changes.

Avoid churning tiny commits within one round of changes for no reason, but do not hold critical progress
only in uncommitted work if the task is long-running.

## Guidance

- Think of the scoder branch as a disposable integration branch for the session,
  not as the user's long-lived development branch.
- Think of the scoder sandbox as an ephemeral working copy; the branch ref is only
  the committed record of that work. If you don't commit all your changes will be
  lost when the session exits.
- If a command fails because a path is read-only, inspect whether the target is
  intentionally protected or a broken symlink before deciding whether you should
  work around it (unlikely).
- If the user wants the latest upstream state, fetch and rebase or merge
  explicitly rather than using `git pull` by habit.
- If the user talks about what another session can or cannot see, distinguish
  carefully between uncommitted worktree state and committed branch state.

## Validation

Before relying on this skill's assumptions, check:

- the branch really is `scoder/*`, or the user explicitly said this is a scoder session
- the operation you want is against the sandbox worktree, not the user's source checkout
- the path you want to modify is not one of scoder's protected read-only paths
- the user expectation is clear about committed versus uncommitted visibility

## Troubleshooting

### A write failed with a read-only error

Check whether the target is a protected path like `.github/`, `.gitignore`, a
lockfile, or `.agentreadonly`, or `AGENTS.md`. That is different from the project worktree
being non-writable.

### The user can't see your changes

Make sure you have committed them and suggest they checkout the
`scoder/{project}` branch in their IDE or use one of the following commands on the terminal:
* `git diff scoder/{project}`

### The user expects another checkout to see current work

Clarify whether they mean committed branch state or uncommitted worktree state.
If they need another checkout to see the changes through the branch, commit.

### The user reran scoder from the scoder worktree

That is expected to reuse the existing scoder worktree rather than blocking on
its uncommitted changes.

## References

- [scoder sandbox behavior summary](references/scoder-sandbox-behavior.md)
