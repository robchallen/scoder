#!/usr/bin/env bun
/// <reference types="bun" />

// EM: Validation test suite for scoder sandbox runner
// EM: Implements tests for all sandbox mechanics described in design/test-scripts/validation-suite.md

// Import test utilities from bun:test
import { test, expect } from "bun:test";

// ### Constants
const TEST_BASE = "/tmp/scoder-test-repos";
const SCODER_HOME = "/home/scoder";

// ### Test state tracking
const tempRepos: string[] = [];
const testServers: Bun.Server[] = [];

// ### Helper functions

async function fileExists(path: string): Promise<boolean> {
	try {
		return await Bun.file(path).exists();
	} catch {
		return false;
	}
}

async function dirExists(path: string): Promise<boolean> {
	try {
		const stat = await Bun.file(path).stat();
		return stat.isDirectory();
	} catch {
		return false;
	}
}

// Get absolute path to scoder executable
const SCODER_PATH = `${__dirname}/../scoder`;

async function runScoder(repoDir: string, args: string[], env?: Record<string, string>): Promise<string> {
	const proc = await Bun.spawn([SCODER_PATH, ...args], {
		cwd: repoDir,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});

	await proc.exited;

	if (proc.exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`scoder failed with exit code ${proc.exitCode}: ${stderr}`);
	}

	const stdout = await new Response(proc.stdout).text();
	return stdout;
}

async function runScoderInDir(runDir: string, args: string[]): Promise<string> {
	const proc = await Bun.spawn([SCODER_PATH, ...args], {
		cwd: runDir,
		stdout: "pipe",
		stderr: "pipe",
	});

	await proc.exited;

	if (proc.exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`scoder failed with exit code ${proc.exitCode}: ${stderr}`);
	}

	const stdout = await new Response(proc.stdout).text();
	return stdout;
}

async function createTempRepo(): Promise<string> {
	const repoDir = `${TEST_BASE}/repo-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
	
	// Create directory structure
	await Bun.spawn(["mkdir", "-p", `${repoDir}/.github`]).exited;
	
	// Initialize git repo
	const initProc = await Bun.spawn(["git", "init"], { cwd: repoDir });
	await initProc.exited;
	if (initProc.exitCode !== 0) {
		throw new Error("Failed to init git repo");
	}
	
	// Configure git
	await Bun.spawn(["git", "config", "user.email", "test@example.com"], { cwd: repoDir }).exited;
	await Bun.spawn(["git", "config", "user.name", "Test User"], { cwd: repoDir }).exited;
	
	// Create starter files
	await Bun.write(`${repoDir}/README.md`, "# Test Project\n");
	await Bun.write(`${repoDir}/.github/ci.yml`, `name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`);
	await Bun.write(`${repoDir}/.gitignore`, `node_modules/\n.DS_Store\n`);
	await Bun.write(`${repoDir}/package-lock.json`, `{ "name": "test", "version": "1.0.0" }\n`);
	
	// Add and commit
	const addProc = await Bun.spawn(["git", "add", "."], { cwd: repoDir });
	await addProc.exited;
	if (addProc.exitCode !== 0) {
		throw new Error("Failed to add files");
	}
	
	const commitProc = await Bun.spawn(["git", "commit", "-m", "initial commit"], { cwd: repoDir });
	await commitProc.exited;
	if (commitProc.exitCode !== 0) {
		throw new Error("Failed to commit");
	}
	
	return repoDir;
}

async function cleanupRepo(repoDir: string): Promise<void> {
	// Remove any scoder branches and worktrees
	try {
		const worktreeListProc = await Bun.spawn(
			["git", "worktree", "list", "--porcelain"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await worktreeListProc.exited;
		
		if (worktreeListProc.exitCode === 0) {
			const output = await new Response(worktreeListProc.stdout).text();
			const lines = output.split("\n");
			
			for (const line of lines) {
				if (line.startsWith("worktree ")) {
					const worktreePath = line.slice("worktree ".length).trim();
					if (worktreePath.includes("scoder")) {
						const removeProc = await Bun.spawn(
							["git", "worktree", "remove", worktreePath, "--force"],
							{ cwd: repoDir }
						);
						await removeProc.exited;
					}
				}
			}
		}
	} catch {
		// Ignore errors during cleanup
	}
	
	// Remove any scoder branches
	try {
		const branchListProc = await Bun.spawn(
			["git", "branch", "--list", "scoder/*"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await branchListProc.exited;
		
		if (branchListProc.exitCode === 0) {
			const output = await new Response(branchListProc.stdout).text();
			const branches = output.trim().split("\n").filter(b => b.trim());
			
			for (const branch of branches) {
				const deleteProc = await Bun.spawn(
					["git", "branch", "-D", branch.trim()],
					{ cwd: repoDir }
				);
				await deleteProc.exited;
			}
		}
	} catch {
		// Ignore errors during cleanup
	}
	
	// Remove the temp directory
	await Bun.spawn(["rm", "-rf", repoDir]).exited;
}

// ### Cleanup on exit
function setupGlobalCleanup(): void {
	const cleanup = async () => {
		// Stop test servers
		for (const server of testServers) {
			try {
				server.stop();
			} catch {
				// Ignore errors
			}
		}
		
		// Remove temp repos
		for (const repo of tempRepos) {
			try {
				await cleanupRepo(repo);
			} catch {
				// Ignore errors
			}
		}
		
		// Remove test base directory
		try {
			await Bun.spawn(["rm", "-rf", TEST_BASE]).exited;
		} catch {
			// Ignore errors
		}
	};
	
	// Set up cleanup on exit
	process.on("exit", cleanup);
	process.on("SIGINT", () => { cleanup(); process.exit(0); });
	process.on("SIGTERM", () => { cleanup(); process.exit(0); });
}

// ### Test: home-isolation
test("home-isolation: $HOME inside sandbox is /home/scoder", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		const output = await runScoder(repoDir, ["-q", "/bin/bash", "-c", "echo $HOME"]);
		expect(output.trim()).toBe(SCODER_HOME);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: system-read-only
test("system-read-only: Cannot create file under /usr/bin", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", "touch /usr/bin/test-file"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;
		
		// Should fail with non-zero exit code
		expect(proc.exitCode).not.toBe(0);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: worktree-writable
test("worktree-writable: Can create file in project working tree", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		// Run scoder in worktree mode to create the worktree
		await runScoder(repoDir, ["-w", "-q", "/bin/bash", "-c", "echo setup"]);
		
		// Parse worktree directory from git worktree list
		const worktreeListProc = await Bun.spawn(
			["git", "worktree", "list", "--porcelain"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await worktreeListProc.exited;
		
		const worktreeList = await new Response(worktreeListProc.stdout).text();
		const lines = worktreeList.split("\n");
		
		let worktreeDir: string | null = null;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].startsWith("worktree ")) {
				worktreeDir = lines[i].slice("worktree ".length).trim();
				break;
			}
		}
		
		if (!worktreeDir) {
			// If no worktree found, skip worktree-specific check and test direct mode
			const testFilePath = `${repoDir}/test-file.txt`;
			expect(await fileExists(testFilePath)).toBe(false);
			
			const output = await runScoder(repoDir, ["-q", "/bin/bash", "-c", `touch ${testFilePath}`]);
			
			// File should exist now
			expect(await fileExists(testFilePath)).toBe(true);
			
			// Clean up
			await Bun.spawn(["git", "rm", "-f", "test-file.txt"], { cwd: repoDir }).exited;
			return;
		}
		
		// File should NOT exist in the original repo yet (it's in worktree)
		const testFilePath = `${worktreeDir}/test-file.txt`;
		expect(await fileExists(testFilePath)).toBe(false);
		
		const output = await runScoder(repoDir, ["-w", "-q", "/bin/bash", "-c", `touch ${testFilePath}`]);
		
		// File should exist now in worktree
		expect(await fileExists(testFilePath)).toBe(true);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: github-protected
test("github-protected: Cannot create file inside .github/", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", "touch .github/test-file"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;
		
		// Should fail because .github/ is protected by default
		expect(proc.exitCode).not.toBe(0);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: gitignore-protected
test("gitignore-protected: Cannot modify .gitignore", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", "echo '# test' >> .gitignore"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;
		
		// Should fail because .gitignore is protected by default
		expect(proc.exitCode).not.toBe(0);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: empty-agentreadonly-allows-writes
test("empty-agentreadonly-allows-writes: Empty .agentreadonly removes default protection", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		// Create empty .agentreadonly
		await Bun.write(`${repoDir}/.agentreadonly`, "");
		
		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", "touch .github/test-file"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;
		
		// Should succeed because .agentreadonly is empty (no default protection)
		expect(proc.exitCode).toBe(0);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: agentreadonly-protected
test("agentreadonly-protected: .agentreadonly is always mounted read-only", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		// Create .agentreadonly with some content
		await Bun.write(`${repoDir}/.agentreadonly`, "# test");
		
		// Try to modify .agentreadonly inside the sandbox
		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", "echo '# modified' >> .agentreadonly"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;
		
		// Should fail because .agentreadonly is bind-mounted read-only
		expect(proc.exitCode).not.toBe(0);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: agentreadonly-home-directory-readonly
test("agentreadonly-home-directory-readonly: .agentreadonly HOME bind is read-only", async () => {
	// Create a test directory in home
	const testHomeDir = `${process.env.HOME}/.scoder-test-home-bind`;
	await Bun.spawn(["mkdir", "-p", testHomeDir]).exited;
	
	// Create a test file in the directory first
	await Bun.write(`${testHomeDir}/test-read-file.txt`, "readable content");
	
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		// Create .agentreadonly with HOME bind
		await Bun.write(`${repoDir}/.agentreadonly`, `$HOME/.scoder-test-home-bind/`);
		
		// Try to write to the bind-mounted directory
		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", `touch ${testHomeDir}/test-write-file`],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;
		
		// Should fail because the bind is read-only
		expect(proc.exitCode).not.toBe(0);
		
		// Should still be able to read
		const readProc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", `cat ${testHomeDir}/test-read-file.txt 2>&1`],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await readProc.exited;
		
		// Read should succeed (exit code 0 means success, non-zero means failure)
		expect(readProc.exitCode).toBe(0);
		
		const readOutput = await new Response(readProc.stdout).text();
		// Verify the content matches
		expect(readOutput.trim()).toBe("readable content");
	} finally {
		await cleanupRepo(repoDir);
		await Bun.spawn(["rm", "-rf", testHomeDir]).exited;
	}
});

// ### Test: agentreadonly-home-directory-must-exist
test("agentreadonly-home-directory-must-exist: Non-existent HOME bind path fails with error", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		// Create .agentreadonly with non-existent path
		await Bun.write(`${repoDir}/.agentreadonly`, `$HOME/.non-existent-path/`);
		
		// Should fail with error message
		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", "echo test"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;
		
		// Should fail because the referenced directory doesn't exist
		expect(proc.exitCode).not.toBe(0);
		
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toMatch(/must reference an existing directory/);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: worktree-branch-created
test("worktree-branch-created: Running scoder creates scoder/<repo-name> branch", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		// Get initial branch
		const initialBranchProc = await Bun.spawn(
			["git", "branch", "--show-current"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await initialBranchProc.exited;
		const initialBranch = await new Response(initialBranchProc.stdout).text().then(t => t.trim());
		
		// Run scoder with worktree mode
		await runScoder(repoDir, ["-w", "-q", "/bin/bash", "-c", "echo test"]);
		
		// Check that scoder/<repo-name> branch was created
		const repoName = repoDir.split("/").pop() || "unknown";
		const branchName = `scoder/${repoName}`;
		
		const branchListProc = await Bun.spawn(
			["git", "branch", "--list", branchName],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await branchListProc.exited;
		
		const output = await new Response(branchListProc.stdout).text();
		expect(output).toContain(branchName);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: existing-scoder-worktree-reused
test("existing-scoder-worktree-reused: Rerunning from existing worktree reuses checkout", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		// Run scoder once to create worktree
		const output1 = await runScoder(repoDir, ["-w", "-q", "/bin/bash", "-c", "echo first"]);
		
		// Parse worktree directory from git worktree list
		const worktreeListProc = await Bun.spawn(
			["git", "worktree", "list", "--porcelain"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await worktreeListProc.exited;
		
		const worktreeList = await new Response(worktreeListProc.stdout).text();
		const lines = worktreeList.split("\n");
		
		let worktreeDir: string | null = null;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].startsWith("worktree ")) {
				worktreeDir = lines[i].slice("worktree ".length).trim();
				break;
			}
		}
		
		expect(worktreeDir).not.toBeNull();
		
		// Run scoder from the worktree directory
		const output2 = await runScoderInDir(worktreeDir, ["-q", "/bin/bash", "-c", "echo second"]);
		
		// Should reuse the existing worktree (no error about nested worktree)
		expect(output2).not.toContain("scoder is already running inside a git worktree");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: worktree-recreated-if-missing
test("worktree-recreated-if-missing: Deleting worktree and rerunning recreates it", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		// Run scoder once to create worktree
		await runScoder(repoDir, ["-w", "-q", "/bin/bash", "-c", "echo first"]);
		
		// Get worktree directory
		const worktreeListProc = await Bun.spawn(
			["git", "worktree", "list", "--porcelain"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await worktreeListProc.exited;
		
		const worktreeList = await new Response(worktreeListProc.stdout).text();
		const lines = worktreeList.split("\n");
		
		let worktreeDir: string | null = null;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].startsWith("worktree ")) {
				worktreeDir = lines[i].slice("worktree ".length).trim();
				break;
			}
		}
		
		expect(worktreeDir).not.toBeNull();
		
		// Delete the worktree directory (simulating reboot)
		await Bun.spawn(["rm", "-rf", worktreeDir]).exited;
		
		// Verify worktree is gone
		expect(await dirExists(worktreeDir)).toBe(false);
		
		// Run scoder again - should recreate worktree
		// We need to run from repoDir, not worktreeDir, since worktree was deleted
		const output = await runScoder(repoDir, ["-w", "-q", "/bin/bash", "-c", "echo second"]);
		
		// Should succeed and recreate worktree
		expect(output).not.toContain("Failed");
		
		// Verify worktree was recreated
		expect(await dirExists(worktreeDir)).toBe(true);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: symlinked-agents-skills-available
test("symlinked-agents-skills-available: Symlinked agent skills are available in sandbox", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		// Check if ~/.agents exists and has skills
		const agentsDir = `${process.env.HOME}/.agents`;
		if (!(await dirExists(agentsDir))) {
			// Skip test if no skills directory
			return;
		}
		
		// Run scoder and check if skills are available
		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", "ls /home/scoder/.agents 2>&1"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;
		
		// Skills should be available (or at least the directory exists)
		expect(proc.exitCode).toBe(0);
		
		const output = await new Response(proc.stdout).text();
		// The output should include some skills or be empty (directory exists but no skills)
		// We just verify the directory is accessible
		expect(output).not.toContain("No such file or directory");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-agents-md-overlay-visible
test("sandbox-agents-md-overlay-visible: AGENTS.md overlay is visible in sandbox", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		// Run scoder and check if overlay content is present
		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", "grep -c 'scoder sandbox' AGENTS.md"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;
		
		// Should find the overlay content
		expect(proc.exitCode).toBe(0);
		
		const output = await new Response(proc.stdout).text();
		expect(parseInt(output.trim())).toBeGreaterThan(0);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: agents-md-overlay-in-direct-mode
test("agents-md-overlay-in-direct-mode: AGENTS.md overlay in direct mode lacks worktree messages", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		// Run scoder in direct mode (no worktree)
		const proc = await Bun.spawn(
			["scoder", "--no-worktree", "-q", "/bin/bash", "-c", "grep 'git worktree' AGENTS.md"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;
		
		// Should NOT find worktree-specific messages in direct mode
		// The grep will fail (exitCode != 0) if no match found, which is what we want
		expect(proc.exitCode).not.toBe(0);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: host-loopback-blocked
test("host-loopback-blocked: Host localhost HTTP server is unreachable", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	// Start a local HTTP server
	const server = Bun.serve({
		port: 19999,
		fetch(req) {
			return new Response("OK");
		},
	});
	testServers.push(server);
	
	try {
		// Try to reach the host localhost from inside the sandbox
		// This should fail due to pasta's default loopback blocking
		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:19999"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;
		
		// Should fail (curl will return 000 or error)
		expect(proc.exitCode).not.toBe(0);
	} finally {
		await cleanupRepo(repoDir);
		server.stop();
	}
});

// ### Test: llm-port-allows-host-loopback
test("llm-port-allows-host-loopback: --llm-port allows reaching specific localhost port", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	// Start a local HTTP server
	const server = Bun.serve({
		port: 19998,
		fetch(req) {
			return new Response("OK");
		},
	});
	testServers.push(server);
	
	try {
		// Try to reach the host localhost with --llm-port
		const proc = await Bun.spawn(
			["scoder", "--llm-port", "19998", "-q", "/bin/bash", "-c", "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:19998"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;
		
		// Should succeed now that we've enabled the port
		expect(proc.exitCode).toBe(0);
		
		const output = await new Response(proc.stdout).text();
		expect(output.trim()).toBe("200");
	} finally {
		await cleanupRepo(repoDir);
		server.stop();
	}
});

// ### Test: outbound-dns-works
test("outbound-dns-works: DNS resolution works inside sandbox", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		// Try to resolve a known DNS name
		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", "getent hosts google.com"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;
		
		// Should succeed
		expect(proc.exitCode).toBe(0);
		
		const output = await new Response(proc.stdout).text();
		// Should have at least one IP address
		expect(output.length).toBeGreaterThan(0);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: dry-run-uses-pasta
test("dry-run-uses-pasta: Dry-run output includes pasta in command", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		const output = await runScoder(repoDir, ["--dry-run", "-q", "/bin/bash", "-c", "echo test"]);
		
		// Should include pasta in the command
		expect(output).toMatch(/pasta/);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: no-worktree-mode
test("no-worktree-mode: --no-worktree bypasses worktree creation", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	
	try {
		const output = await runScoder(repoDir, ["--no-worktree", "-q", "/bin/bash", "-c", "echo test"]);
		
		// Should NOT create a scoder branch (this is the main test)
		const repoName = repoDir.split("/").pop() || "unknown";
		const branchName = `scoder/${repoName}`;
		
		const branchListProc = await Bun.spawn(
			["git", "branch", "--list", branchName],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" }
		);
		await branchListProc.exited;
		
		const branchOutput = await new Response(branchListProc.stdout).text();
		expect(branchOutput).not.toContain(branchName);
		
		// Verify the command ran successfully
		expect(output).toBe("test\n");
	} finally {
		await cleanupRepo(repoDir);
	}
});
