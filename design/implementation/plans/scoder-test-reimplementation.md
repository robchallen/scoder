---
target-version: 2.2.0
completed-in: 2.2.0
status: complete
tags: [test-script, validation]
---

# Scoder Test Reimplementation Plan

> **Completed in 2.2.0.** Implemented as `tests/scoder.test.ts` (29 tests) —
> not `tests/validate.test.ts` as drafted below. `tests/validate.ts` and
> `tests/validate.test.ts` were both removed. See
> [validation-suite](/design/test-scripts/validation-suite.md).

## Goal
Create a clean reimplementation of the scoder validation test suite using the Bun test framework (`bun test`) instead of a standalone script.

## Design Constraints
- Tests must run in parallel without interfering with each other
- Each test must create its own unique temporary directory
- Tests must NOT run inside a scoder sandbox (check SCODER_SANDBOX=1)
- Worktree tests should be skipped when nested sandbox is detected
- All 20 test cases from the original tests/scoder.test.ts must be implemented

## Test Implementation Requirements

### Test Structure
1. Use `bun test` framework with `test()` calls
2. Each test creates a unique temp directory using timestamp + random string
3. Git operations use `$` from "bun"
4. Scoder commands use `Bun.spawn()` with `stdout: "pipe", stderr: "pipe"`
5. All test output combined (stdout + stderr) should be returned
6. Cleanup must happen in `finally` blocks

### Key Implementation Details

#### Temp Directory Generation
```typescript
const caseDir = `/tmp/scoder-test-${name}-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
const repoDir = `${caseDir}/repo`;
```

#### Running Scoder
```typescript
async function runScoder(repoDir: string, args: string[], env?: Record<string, string>): Promise<string> {
	const proc = await Bun.spawn(["bun", "run", scoderScript, ...args], {
		cwd: repoDir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return stdout + stderr;
}
```

#### Nested Sandbox Detection
```typescript
const SCODER_SANDBOX = process.env.SCODER_SANDBOX === "1";
if (SCODER_SANDBOX) {
	console.log("Skipping worktree tests (nested sandbox detected)");
}
```

#### Cleanup
```typescript
afterAll(async () => {
	await $`rm -rf /tmp/scoder-test-*`.quiet();
});
```

## Test Cases (20 total)

### Core Sandbox Tests
1. home-isolation - verify $HOME is /home/scoder
2. system-read-only - verify /usr/bin is read-only
3. worktree-writable - verify worktree is writable
4. github-protected - verify .github/ is protected
5. gitignore-protected - verify .gitignore is protected

### Agentreadonly Tests
6. empty-agentreadonly-allows-writes - verify empty .agentreadonly removes protection
7. agentreadonly-protected - verify .agentreadonly itself is always protected
8. agentreadonly-home-directory-readonly - verify $HOME/ binds are read-only
9. agentreadonly-home-directory-must-exist - verify $HOME/ paths must exist

### Git Worktree Tests
10. worktree-branch-created - verify scoder branch is created
11. existing-scoder-worktree-reused - verify worktree reuse works
12. worktree-recreated-if-missing - verify worktree recreation after reboot
13. symlinked-agents-skills-available - verify symlinked skills work

### AGENTS.md Overlay Tests
14. sandbox-agents-md-overlay-visible - verify AGENTS.md overlay works
15. agents-md-overlay-in-direct-mode - verify direct mode overlay

### Network Tests
16. host-loopback-blocked - verify host localhost is blocked
17. llm-port-allows-host-loopback - verify --llm-port exception works
18. outbound-dns-works - verify DNS resolution works

### Mode Tests
19. dry-run-uses-pasta - verify dry-run includes pasta
20. no-worktree-mode - verify --no-worktree flag works

## Implementation Steps

1. Create new test file `/home/vp22681/Git/scoder/tests/validate.test.ts`
2. Implement test helpers (createTestRepo, runScoder, runScoderInDir)
3. Implement all 20 test cases based on original tests/scoder.test.ts logic
4. Add cleanup hooks for temp directories
5. Add nested sandbox detection
6. Test that all tests pass outside scoder sandbox
7. Verify worktree tests are skipped when SCODER_SANDBOX=1

## Acceptance Criteria
- All 20 tests implement and pass outside scoder sandbox
- Tests run in parallel without interference
- Temp directories are cleaned up after tests
- Nested sandbox detection works correctly
- Test output shows pass/fail/skip counts
