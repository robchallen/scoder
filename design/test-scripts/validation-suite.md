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

## Summary

`tests/validate.ts` is a self-contained integration test suite that creates
temporary git repositories under `/tmp`, runs `scoder` against them using
`/bin/bash` as the sandboxed command, and asserts expected behaviour. 20
tests cover all sandbox mechanics.

## How to Run

```bash
bun run tests/validate.ts
```

## Test Structure

Each test case:
1. Creates a fresh repo via `createTestRepo(name)` with a starter project (file.txt, .github/ci.yml, .gitignore, package-lock.json)
2. Runs `scoder` via `runScoder(repoDir, args)` which spawns `bun run src/index.ts ...`
3. Checks stdout/stderr for expected output
4. Cleanup: removes scoder branches and worktrees, deletes temp repo

## Test Cases

### 1. home-isolation
[TESTED_BY](/tests/validate.ts#testHomeIsolation)

Verifies `$HOME` inside the sandbox is `/home/scoder`, not the developer's real home.

### 2. system-read-only
[TESTED_BY](/tests/validate.ts#testSystemReadOnly)

Attempts to create a file under `/usr/bin`. Must fail.

### 3. worktree-writable
[TESTED_BY](/tests/validate.ts#testWorktreeWritable)

Creates a file in the project working tree. Must succeed.

### 4. github-protected
[TESTED_BY](/tests/validate.ts#testGithubProtected)

Attempts to create a file inside `.github/`. Must fail (default protected).

### 5. gitignore-protected
[TESTED_BY](/tests/validate.ts#testGitignoreProtected)

Attempts to modify `.gitignore`. Must fail (default protected).

### 6. empty-agentreadonly-allows-writes
[TESTED_BY](/tests/validate.ts#testEmptyAgentreadonlyAllowsWrites)

Empty `.agentreadonly` removes protection. Write to `.github/` must succeed.

### 7. agentreadonly-protected
[TESTED_BY](/tests/validate.ts#testAgentreadonlyProtected)

`.agentreadonly` itself is always read-only, even when empty.

### 8. agentreadonly-home-directory-readonly
[TESTED_BY](/tests/validate.ts#testAgentreadonlyHomeDirectoryReadonly)

`$HOME/...` entries in `.agentreadonly` bind host directories read-only.

### 9. agentreadonly-home-directory-must-exist
[TESTED_BY](/tests/validate.ts#testAgentreadonlyHomeDirectoryMustExist)

References to non-existent paths via `$HOME/...` must fail with clear error.

### 10. worktree-branch-created
[TESTED_BY](/tests/validate.ts#testWorktreeBranchCreated)

Running scoder creates a `scoder/<repo-name>` branch.

### 11. existing-scoder-worktree-reused
[TESTED_BY](/tests/validate.ts#testExistingScoderWorktreeReused)

Rerunning from an existing worktree directory reuses the checkout.

### 12. worktree-recreated-if-missing
[TESTED_BY](/tests/validate.ts#testWorktreeRecreatedIfMissing)

Deleting the worktree directory (simulating reboot) and rerunning scoder recovers correctly.

### 13. symlinked-agents-skills-available
[TESTED_BY](/tests/validate.ts#testSymlinkedAgentsSkillsAvailable)

Symlinked agent skills are resolved and available inside the sandbox.

### 14. sandbox-agents-md-overlay-visible
[TESTED_BY](/tests/validate.ts#testSandboxAgentsMdOverlayVisible)

AGENTS.md overlay is visible in sandbox, host copy unchanged.

### 15. agents-md-overlay-in-direct-mode
[TESTED_BY](/tests/validate.ts#testAgentsMdOverlayInDirectMode)

AGENTS.md overlay in direct mode does not include worktree-specific messages.

### 16. host-loopback-blocked
[TESTED_BY](/tests/validate.ts#testHostLoopbackBlocked)

Host localhost HTTP server is unreachable from sandbox.

### 17. llm-port-allows-host-loopback
[TESTED_BY](/tests/validate.ts#testLlmPortAllowsHostLoopback)

`--llm-port=<port>` allows reaching a specific host localhost port.

### 18. outbound-dns-works
[TESTED_BY](/tests/validate.ts#testOutboundDnsWorks)

DNS resolution works inside the sandbox.

### 19. dry-run-uses-pasta
[TESTED_BY](/tests/validate.ts#testDryRunUsesPasta)

Dry-run output includes `pasta` in the command line.

### 20. no-worktree-mode
[TESTED_BY](/tests/validate.ts#testNoWorktreeMode)

`--no-worktree` flag bypasses git worktree creation.
