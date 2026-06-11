---
target-version: 2.1.0
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
[HAS_FEATURE](../features/dry-run-mode.md)
[HAS_FEATURE](../features/apparmor-compatibility.md)
[HAS_FEATURE](../features/direct-mode.md)

## Summary

`tests/scoder.test.ts` is a self-contained integration test suite that creates
temporary git repositories under `/tmp`, runs `scoder` against them using
`/bin/bash` as the sandboxed command, and asserts expected behaviour. 20
tests cover all sandbox mechanics.

## How to Run

```bash
bun run tests/scoder.test.ts
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

## Current Network Coverage

- Host loopback access is blocked (`host-loopback-blocked`)
- A configured localhost LLM port can be reached (`llm-port-allows-host-loopback`)
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

### Temp Directory Cleanup

All tests create repos under a shared `TEST_BASE` directory, which is removed
by the `cleanup()` function in a finally block.

