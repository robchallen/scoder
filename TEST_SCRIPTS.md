# Validation Test Scripts

This document explains what `tests/validate.sh` checks in plain language.

## How the validation script works

The script is developer-facing and is intended to be run from the repository:

```bash
./tests/validate.sh
```

For each test case it:

1. Creates a fresh temporary git repository under `/tmp`.
2. Adds a small starter project with a tracked file, `.github/ci.yml`, `.gitignore`, and `package-lock.json`.
3. Runs `scoder` against that repo using `/bin/bash` as the sandboxed command.
4. Checks for the expected result.
5. Removes any `scoder/*` worktrees and branches created during the test.
6. Deletes the temporary repo.

An outer cleanup trap also removes any leftover temporary repos, worktrees, and branches if the script exits early.

## What each test checks

### 1. `home-isolation`

Runs `scoder` and prints `$HOME` from inside the sandbox.

Expected result: the sandboxed process sees `/home/scoder`, not the developer's real home directory.

### 2. `system-read-only`

Tries to create a file under `/usr/bin` from inside the sandbox.

Expected result: the write fails because system directories are mounted read-only.

### 3. `worktree-writable`

Creates a new file in the project working tree from inside the sandbox.

Expected result: the write succeeds, proving the sandbox can modify the isolated project worktree.

### 4. `github-protected`

Tries to create a file inside `.github/`.

Expected result: the write fails because `.github/` is protected read-only by default.

### 5. `gitignore-protected`

Tries to append text to `.gitignore`.

Expected result: the write fails because `.gitignore` is protected read-only by default.

### 6. `empty-agentreadonly-allows-writes`

Creates an empty `.agentreadonly`, commits it, then tries to create a file inside `.github/`.

Expected result: the write succeeds. An empty `.agentreadonly` removes the default workspace protection list, while `.agentreadonly` itself remains protected separately.

### 7. `agentreadonly-protected`

Creates and commits an empty `.agentreadonly`, then tries to modify that file from inside the sandbox.

Expected result: the write fails because `.agentreadonly` is always mounted read-only.

### 8. `worktree-branch-created`

Runs `scoder` once, then checks the source repository for a `scoder/*` branch.

Expected result: a `scoder/<repo-name>` branch exists, proving the worktree lifecycle was set up.

### 9. `existing-scoder-worktree-reused`

Runs `scoder` once to create the worktree, writes an uncommitted file directly into that scoder worktree, then runs `scoder` again from inside that same worktree.

Expected result:

- `scoder` reports that it is already in the scoder worktree.
- The second run is not blocked by the uncommitted change.

This verifies the workflow fix where rerunning `scoder` from its own active worktree reuses that checkout instead of trying to create or switch worktrees again.

### 10. `symlinked-agents-skills-available`

Creates a fake home directory where `~/.agents/skills/linked-skill` is a
symlink to a real skill directory elsewhere on the host, then runs `scoder`
with that fake home.

Expected result: the skill file is present at
`/home/scoder/.agents/skills/linked-skill/SKILL.md` inside the sandbox.

This verifies that scoder snapshots `~/.agents` at startup with symlinks
resolved, so agent skills remain available even when the host `.agents` tree
contains symlinked entries.
