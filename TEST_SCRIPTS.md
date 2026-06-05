# Validation Test Scripts

This document explains what `tests/validate.ts` checks in plain language.

## How the validation script works

The script is developer-facing and is intended to be run from the repository:

```bash
bun run tests/validate.ts
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

**Expected result:** the sandboxed process sees `/home/scoder`, not the developer's real home directory.

### 2. `system-read-only`

Tries to create a file under `/usr/bin` from inside the sandbox.

**Expected result:** the write fails because system directories are mounted read-only.

### 3. `worktree-writable`

Creates a new file in the project working tree from inside the sandbox.

**Expected result:** the write succeeds, proving the sandbox can modify the isolated project worktree.

### 4. `github-protected`

Tries to create a file inside `.github/`.

**Expected result:** the write fails because `.github/` is protected read-only by default.

### 5. `gitignore-protected`

Tries to append text to `.gitignore`.

**Expected result:** the write fails because `.gitignore` is protected read-only by default.

### 6. `empty-agentreadonly-allows-writes`

Creates an empty `.agentreadonly`, commits it, then tries to create a file inside `.github/`.

**Expected result:** the write succeeds. An empty `.agentreadonly` removes the default workspace protection list, while `.agentreadonly` itself remains protected separately.

### 7. `agentreadonly-protected`

Creates and commits an empty `.agentreadonly`, then tries to modify that file from inside the sandbox.

**Expected result:** the write fails because `.agentreadonly` is always mounted read-only.

### 8. `agentreadonly-home-directory-readonly`

Creates a fake home directory with a reference directory outside the repository,
adds `$HOME/Git/other-project` to `.agentreadonly`, and runs `scoder` with that
fake home.

**Expected result:**
- the sandbox can read `/home/scoder/Git/other-project/data.txt`
- writes to that mirrored path fail because the bind is read-only

This verifies that bare `$HOME/...` entries in `.agentreadonly` are treated as
read-only host home directory binds mirrored under `/home/scoder/`.

### 9. `agentreadonly-home-directory-must-exist`

Creates a fake home directory without the referenced path, adds
`$HOME/Git/missing-project` to `.agentreadonly`, and runs `scoder`.

**Expected result:** `scoder` exits with an error explaining that the HOME bind
must reference an existing directory.

This verifies the validation guard for missing external reference directories.

### 10. `worktree-branch-created`

Runs `scoder` once, then checks the source repository for a `scoder/*` branch.

**Expected result:** a `scoder/<repo-name>` branch exists, proving the worktree lifecycle was set up.

### 11. `existing-scoder-worktree-reused`

Runs `scoder` once to create the worktree, writes an uncommitted file directly into that scoder worktree, then runs `scoder` again from inside that same worktree.

**Expected result:**
- `scoder` reports that it is already in the scoder worktree.
- The second run is not blocked by the uncommitted change.

This verifies the workflow fix where rerunning `scoder` from its own active worktree reuses that checkout instead of trying to create or switch worktrees again.

### 12. `symlinked-agents-skills-available`

Creates a fake home directory where `~/.agents/skills/linked-skill` is a
symlink to a real skill directory elsewhere on the host, then runs `scoder`
with that fake home.

**Expected result:** the skill file is present at
`/home/scoder/.agents/skills/linked-skill/SKILL.md` inside the sandbox.

This verifies that scoder snapshots `~/.agents` at startup with symlinks
resolved, so agent skills remain available even when the host `.agents` tree
contains symlinked entries.

### 13. `sandbox-agents-md-overlay-visible`

Creates a repository `AGENTS.md`, runs `scoder`, and checks the sandbox copy.

**Expected result:**
- the sandbox sees both the repository text and the injected `scoder sandbox` notice
- the host repository `AGENTS.md` is unchanged

This verifies that scoder overlays `AGENTS.md` inside the sandbox without modifying the real repository file.

### 14. `agents-md-overlay-in-direct-mode`

Creates a repository `AGENTS.md`, runs `scoder --no-worktree`, and checks the sandbox copy.

**Expected result:**
- the sandbox sees the `scoder sandbox` notice
- the sandbox does **not** see worktree-specific messages ("isolated git worktree", "Commit after all changes")

This verifies that the AGENTS.md overlay is conditional based on worktree vs direct mode.

### 15. `host-loopback-blocked`

Starts a temporary HTTP server on the host bound to `127.0.0.1`, then runs
`scoder` and tries to reach that server from inside the sandbox.

**Expected result:** the request fails and the test sees `BLOCKED`.

This verifies the loopback restriction added around the `pasta`-managed tool
network namespace.

### 16. `llm-port-allows-host-loopback`

Starts a temporary HTTP server on the host bound to `127.0.0.1`, then runs
`scoder --llm-port=<port>` and tries to reach that server from inside the
sandbox.

**Expected result:** the request succeeds and returns `SUCCESS`.

This verifies that the optional localhost exemption is applied only when an
explicit LLM port is configured.

### 17. `outbound-dns-works`

Runs `scoder` and, from inside the sandbox, uses Python's standard library to resolve `example.com`.

**Expected result:** the command prints `SUCCESS`.

This verifies that the nested tool namespace has working DNS resolution.

### 18. `dry-run-uses-pasta`

Runs `scoder --dry-run /bin/true` and inspects the printed command line.

**Expected result:** the dry-run output includes `pasta`.

This verifies that scoder launches tools through the `pasta` network layer.

### 19. `no-worktree-mode`

Runs `scoder --no-worktree --dry-run /bin/true` and checks:
- the output mentions "direct mode"
- no `scoder/*` branch is created

**Expected result:** both conditions are true.

This verifies that the `--no-worktree` flag bypasses git worktree creation.

## Current network coverage

The validation suite currently tests both sides of the network behavior:

- ✅ host loopback access is blocked (`host-loopback-blocked`)
- ✅ a configured localhost LLM port can be reached (`llm-port-allows-host-loopback`)
- ✅ outbound DNS resolution works (`outbound-dns-works`)

## Test Implementation Notes

### Environment Variable Passing

Some tests need to override environment variables (e.g., `HOME` for testing
`$HOME/...` binds). The `runScoder()` helper accepts an optional `env` parameter:

```typescript
const output = await runScoder(repoDir, ["-q", "/bin/bash", "-c", "echo $HOME"], {
  HOME: fakeHome,
});
```

### Server Cleanup

Tests that create HTTP servers must clean them up in a `finally` block:

```typescript
const server = Bun.serve({ ... });
try {
  // test logic
} finally {
  server.stop();
}
```

### Worktree Detection

The `existing-scoder-worktree-reused` test parses `git worktree list --porcelain`
output to find the worktree directory, then runs scoder from that directory.

### Temp Directory Cleanup

All tests create repos under a shared `TEST_BASE` directory, which is removed
by the `cleanup()` function in a finally block.
