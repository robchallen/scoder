---
target-version: 2.2.0
status: draft
tags: [test-script, validation]
---

# Validation Test Suite

[HAS_FEATURE](../features/sandbox-isolation.md)
[HAS_FEATURE](../features/network-isolation.md)
[HAS_FEATURE](../features/git-worktree-isolation.md)
[HAS_FEATURE](../features/infrastructure-protection.md)
[HAS_FEATURE](../features/agents-md-overlay.md)
[HAS_FEATURE](../features/agents-skills-snapshot.md)
[HAS_FEATURE](../features/local-bin-resolution.md)
[HAS_FEATURE](../features/dry-run-mode.md)
[HAS_FEATURE](../features/apparmor-compatibility.md)
[HAS_FEATURE](../features/direct-mode.md)

## Summary

`tests/scoder.test.ts` is a self-contained integration test suite that creates
temporary git repositories under `/tmp`, runs `scoder` against them using
`/bin/bash` as the sandboxed command, and asserts expected behaviour. 29
tests cover all sandbox mechanics.

## How to Run

```bash
bun test tests/scoder.test.ts
```

or:

```bash
em test
```

## How It Works

For each test case:

1. Creates a fresh temporary git repository under `/tmp`
2. Adds a small starter project with a tracked file, `.github/ci.yml`, `.gitignore`, and `package-lock.json`
3. Runs `scoder` against that repo using `/bin/bash` as the sandboxed command
4. Checks for the expected result
5. Removes any `scoder/*` worktrees and branches created during the test
6. Deletes the temporary repo

An outer cleanup trap also removes any leftover temporary repos, worktrees, and branches if the script exits early.

## Test Cases

### 1. home-isolation
[TESTED_BY](/tests/scoder.test.ts#testHomeIsolation)

Verifies `$HOME` inside the sandbox is `/home/scoder`, not the developer's real home.

### 2. system-read-only
[TESTED_BY](/tests/scoder.test.ts#testSystemReadOnly)

Attempts to create a file under `/usr/bin`. Must fail because system directories are mounted read-only.

### 3. worktree-writable
[TESTED_BY](/tests/scoder.test.ts#testWorktreeWritable)

Creates a file in the project working tree. Must succeed, proving the sandbox can modify the isolated worktree.

### 4. github-protected
[TESTED_BY](/tests/scoder.test.ts#testGithubProtected)

Attempts to create a file inside `.github/`. Must fail (default protected).

### 5. gitignore-protected
[TESTED_BY](/tests/scoder.test.ts#testGitignoreProtected)

Attempts to modify `.gitignore`. Must fail (default protected).

### 6. empty-agentreadonly-allows-writes
[TESTED_BY](/tests/scoder.test.ts#testEmptyAgentreadonlyAllowsWrites)

Empty `.agentreadonly` removes default workspace protection. Write to `.github/` must succeed.

### 7. agentreadonly-protected
[TESTED_BY](/tests/scoder.test.ts#testAgentreadonlyProtected)

`.agentreadonly` is always mounted read-only, even when empty.

### 8. agentreadonly-home-directory-readonly
[TESTED_BY](/tests/scoder.test.ts#testAgentreadonlyHomeDirectoryReadonly)

`$HOME/Git/other-project` in `.agentreadonly` binds a host directory read-only. Can read but not write.

### 9. agentreadonly-home-directory-must-exist
[TESTED_BY](/tests/scoder.test.ts#testAgentreadonlyHomeDirectoryMustExist)

References to non-existent paths via `$HOME/...` must fail with a clear error about the directory missing.

### 10. worktree-branch-created
[TESTED_BY](/tests/scoder.test.ts#testWorktreeBranchCreated)

Running scoder creates a `scoder/<repo-name>` branch.

### 11. existing-scoder-worktree-reused
[TESTED_BY](/tests/scoder.test.ts#testExistingScoderWorktreeReused)

Rerunning from an existing scoder worktree reuses the checkout rather than creating a new one.

### 12. worktree-recreated-if-missing
[TESTED_BY](/tests/scoder.test.ts#testWorktreeRecreatedIfMissing)

Deleting the worktree directory (simulating system reboot) and rerunning scoder prunes the stale reference and recreates the worktree.

### 13. symlinked-agents-skills-available
[TESTED_BY](/tests/scoder.test.ts#testSymlinkedAgentsSkillsAvailable)

Symlinked agent skills are resolved at snapshot time and available read-only inside the sandbox.

### 14. sandbox-agents-md-overlay-visible
[TESTED_BY](/tests/scoder.test.ts#testSandboxAgentsMdOverlayVisible)

AGENTS.md overlay appends scoder sandbox notice without modifying the host repository copy.

### 15. agents-md-overlay-in-direct-mode
[TESTED_BY](/tests/scoder.test.ts#testAgentsMdOverlayInDirectMode)

AGENTS.md overlay in direct mode does not include worktree-specific messages.

### 16. host-loopback-blocked
[TESTED_BY](/tests/scoder.test.ts#testHostLoopbackBlocked)

Host localhost HTTP server is unreachable from the sandbox via pasta's default loopback blocking.

### 17. llm-port-allows-host-loopback
[TESTED_BY](/tests/scoder.test.ts#testLlmPortAllowsHostLoopback)

`--llm-port=<port>` allows reaching a specific host localhost port.

### 18. outbound-dns-works
[TESTED_BY](/tests/scoder.test.ts#testOutboundDnsWorks)

DNS resolution works inside the sandbox via pasta's DHCP/DNS.

### 19. dry-run-uses-pasta
[TESTED_BY](/tests/scoder.test.ts#testDryRunUsesPasta)

Dry-run output includes `pasta` in the command line.

### 20. no-worktree-mode
[TESTED_BY](/tests/scoder.test.ts#testNoWorktreeMode)

`--no-worktree` flag bypasses git worktree creation and the output mentions "direct mode".

### 21. local-bin-symlink-resolved
[TESTED_BY](/tests/scoder.test.ts#testLocalBinSymlinkResolved)

A symlink in `~/.local/bin` pointing to a host path outside the sandbox is
resolved via a forwarding shim and the tool executes correctly.

### 22. local-bin-regular-file
[TESTED_BY](/tests/scoder.test.ts#testLocalBinRegularFile)

Regular executable files in `~/.local/bin` are copied with their
permissions intact and work inside the sandbox.

### 23. local-bin-symlink-arg-passthrough
[TESTED_BY](/tests/scoder.test.ts#testLocalBinSymlinkArgPassthrough)

Forwarding shim passes all arguments through to the underlying tool.

### 24. llm-port-auto-detect
[TESTED_BY](/tests/scoder.test.ts#testLlmPortAutoDetect)

When `SCODER_LLM_PORT` is set and the port is open on localhost, scoder
auto-detects it and allows the sandbox to reach that port without
explicitly passing `--llm-port`.

### 25. addGitExclude should mark AGENTS.md as skip-worktree
[TESTED_BY](/tests/scoder.test.ts#testAddGitExclude)

`addGitExclude` sets the `--skip-worktree` index flag on `AGENTS.md` so git
ignores the overlay modification. This is what prevents the overlay from
appearing as a dirty working tree inside the sandbox.

### 26. removeGitExclude should restore normal tracking
[TESTED_BY](/tests/scoder.test.ts#testRemoveGitExclude)

`removeGitExclude` clears the `--skip-worktree` flag after the session ends,
restoring normal git tracking for `AGENTS.md`.

### 27. addGitExclude should be idempotent
[TESTED_BY](/tests/scoder.test.ts#testAddGitExcludeIdempotent)

Calling `addGitExclude` multiple times does not duplicate entries in the git index.

### 28. scoder should succeed in direct mode with AGENTS.md excluded
[TESTED_BY](/tests/scoder.test.ts#testScoderDirectModeExclude)

scoder runs successfully in `--no-worktree` mode with AGENTS.md excluded from
git tracking. The exclude is cleaned up after the session.

### 29. scoder should succeed in worktree mode with AGENTS.md excluded
[TESTED_BY](/tests/scoder.test.ts#testScoderWorktreeModeExclude)

scoder runs successfully in worktree mode with AGENTS.md excluded from the
worktree git index. The exclude is cleaned up after the session.

## Current Network Coverage

- Host loopback access is blocked (`host-loopback-blocked`)
- A configured localhost LLM port can be reached (`llm-port-allows-host-loopback`)
- Auto-detection of an open LLM port enables that port without `--llm-port` (`llm-port-auto-detect`)
- Outbound DNS resolution works (`outbound-dns-works`)

## Test Implementation Notes

### Environment Variable Passing

Some tests override `HOME` via the `runScoder()` helper's `env` parameter:

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

The `worktree-recreated-if-missing` test identifies the scoder branch worktree
(skipping the main worktree) by looking for `branch refs/heads/scoder/*` entries.

### Git Skip-Worktree Detection

Tests use `git ls-files -v` to check `--skip-worktree` state: uppercase `S`
means skip-worktree, uppercase `H` means normal staged file.

### Temp Directory Cleanup

All tests create repos under a shared `TEST_BASE` directory, which is removed
by the `cleanup()` function in a finally block.
