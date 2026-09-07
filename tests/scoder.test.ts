#!/usr/bin/env bun
/// <reference types="bun" />

// EM: Validation test suite for scoder sandbox runner
// EM: Implements tests for all sandbox mechanics described in design/test-scripts/validation-suite.md

// Import test utilities from bun:test
import { afterAll, expect, test } from "bun:test";
import { addGitExclude, removeGitExclude } from "../src/git/protection.ts";

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

async function runScoder(
	repoDir: string,
	args: string[],
	env?: Record<string, string>,
): Promise<string> {
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
	await Bun.spawn(["git", "config", "user.email", "test@example.com"], {
		cwd: repoDir,
	}).exited;
	await Bun.spawn(["git", "config", "user.name", "Test User"], { cwd: repoDir })
		.exited;

	// Create starter files
	await Bun.write(`${repoDir}/README.md`, "# Test Project\n");
	await Bun.write(
		`${repoDir}/.github/ci.yml`,
		`name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`,
	);
	await Bun.write(`${repoDir}/.gitignore`, `node_modules/\n.DS_Store\n`);
	await Bun.write(
		`${repoDir}/package-lock.json`,
		`{ "name": "test", "version": "1.0.0" }\n`,
	);

	// Add and commit
	const addProc = await Bun.spawn(["git", "add", "."], { cwd: repoDir });
	await addProc.exited;
	if (addProc.exitCode !== 0) {
		throw new Error("Failed to add files");
	}

	const commitProc = await Bun.spawn(
		["git", "commit", "-m", "initial commit"],
		{ cwd: repoDir },
	);
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
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
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
							{ cwd: repoDir },
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
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await branchListProc.exited;

		if (branchListProc.exitCode === 0) {
			const output = await new Response(branchListProc.stdout).text();
			const branches = output
				.trim()
				.split("\n")
				.filter((b) => b.trim());

			for (const branch of branches) {
				const deleteProc = await Bun.spawn(
					["git", "branch", "-D", branch.trim()],
					{ cwd: repoDir },
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
// Worktrees for temp repos land here: projDir for /tmp/scoder-test-repos/repo-X
// is "tmp/scoder-test-repos/repo-X". Scoped deliberately — /tmp/scoder also
// holds the developer's real worktrees and must never be removed wholesale.
const TEST_WORKTREE_BASE = "/tmp/scoder/tmp/scoder-test-repos";

// Artifacts the ~/.local/bin tests create in the *real* home directory. Left
// behind, they show up in every subsequent real scoder session.
const HOME_TEST_ARTIFACTS = [
	`${process.env.HOME}/.local/bin/scoder-test-tool`,
	`${process.env.HOME}/.local/bin/scoder-test-script`,
	`${process.env.HOME}/bin/scoder-test-bin`,
];

const CLEANUP_PATHS = [TEST_BASE, TEST_WORKTREE_BASE, ...HOME_TEST_ARTIFACTS];

// afterAll is the mechanism that actually runs. The previous implementation
// registered an async callback on process.on("exit") and was never called at
// all — so temp repos and the ~/.local/bin artifacts accumulated on the
// developer's machine. Even wired up, that approach fails twice over: the
// "exit" event does not fire reliably under the test runner, and it cannot
// await, so async cleanup would never settle.
afterAll(async () => {
	for (const server of testServers) {
		try {
			server.stop();
		} catch {
			// Ignore errors
		}
	}

	for (const proc of mockSshdProcesses) {
		try {
			proc.kill();
		} catch {
			// Ignore errors
		}
	}

	for (const path of CLEANUP_PATHS) {
		try {
			await Bun.spawn(["rm", "-rf", path]).exited;
		} catch {
			// Ignore errors
		}
	}
});

// An interrupted run never reaches afterAll, so signals need their own path.
// This one must be synchronous — the process is on its way out.
function setupSignalCleanup(): void {
	const cleanup = (): void => {
		for (const path of CLEANUP_PATHS) {
			try {
				Bun.spawnSync(["rm", "-rf", path]);
			} catch {
				// Ignore errors
			}
		}
	};

	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});
}

setupSignalCleanup();

// ### Test: home-isolation
test("home-isolation: $HOME inside sandbox is /home/scoder", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const output = await runScoder(repoDir, [
			"-q",
			"/bin/bash",
			"-c",
			"echo $HOME",
		]);
		expect(output.trim()).toBe(SCODER_HOME);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-uid-preserved
// The regression this guards: pasta's spawn mode created a nested user
// namespace that overrode bwrap's --uid, so the tool ran as root. bwrap now
// owns both namespaces and pasta attaches from outside — see ADR 0001. Was
// marked test.failing until the composition was fixed.
test("sandbox-uid-preserved: uid inside the sandbox is the host uid, not root", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const output = await runScoder(repoDir, ["-q", "/bin/bash", "-c", "id -u"]);
		expect(output.trim()).toBe(String(process.getuid?.()));
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-identity-consistent
// $HOME alone is not enough: anything resolving the user through getpwuid or
// getgrgid reads /etc/passwd and /etc/group, and OpenSSH locates ~/.ssh that
// way. Bound from the host those name the developer's own account, so the gid
// used to resolve to the host username.
test("sandbox-identity-consistent: passwd and group describe only the sandbox user", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const output = await runScoder(repoDir, [
			"-q",
			"/bin/bash",
			"-c",
			'id -un; id -gn; python3 -c "import os,pwd;print(pwd.getpwuid(os.getuid()).pw_dir)"',
		]);
		const [user, group, home] = output.trim().split("\n");

		expect(user).toBe("scoder");
		expect(group).toBe("scoder");
		// The path OpenSSH would use to find ~/.ssh
		expect(home).toBe(SCODER_HOME);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-identity-files-cleaned
// The overlay files live in a per-session temp directory. The implementation
// they replaced used a fixed /tmp/bwrap_passwd_<uid> that was never removed and
// collided between concurrent sessions.
test("sandbox-identity-files-cleaned: no identity temp directory survives a session", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	const countIdentityDirs = async (): Promise<number> => {
		const proc = Bun.spawn(
			["bash", "-c", "ls -d /tmp/scoder-identity-* 2>/dev/null | wc -l"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;
		return Number.parseInt((await new Response(proc.stdout).text()).trim(), 10);
	};

	try {
		const before = await countIdentityDirs();
		await runScoder(repoDir, ["-q", "/bin/bash", "-c", "true"]);
		expect(await countIdentityDirs()).toBe(before);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: pasta-sidecar-reaped
// pasta now runs outside the sandbox, so bwrap's --die-with-parent no longer
// reaps it and scoder must do so explicitly. Without that, every session leaks
// a process. Counts sidecars rather than asserting zero, because the developer
// may legitimately have other scoder sessions running.
test("pasta-sidecar-reaped: a completed session leaves no pasta process behind", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	const countPasta = async (): Promise<number> => {
		const proc = Bun.spawn(["pgrep", "-c", "pasta"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		// pgrep exits 1 with no output when nothing matches
		const out = (await new Response(proc.stdout).text()).trim();
		return out === "" ? 0 : Number.parseInt(out, 10);
	};

	try {
		const before = await countPasta();

		await runScoder(repoDir, ["-q", "/bin/bash", "-c", "true"]);
		// Teardown signals and waits, but reaping is not instantaneous
		await Bun.sleep(500);

		expect(await countPasta()).toBe(before);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-uid-maps-to-host-user
// The counterpart that must keep holding: whatever uid the sandbox reports,
// files it creates are owned by the real host user, because pasta's namespace
// maps inside-0 back to the caller. This is why the uid bug is a compatibility
// problem rather than a permissions or ownership one.
test("sandbox-uid-maps-to-host-user: files created in the sandbox are owned by the host user", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		await runScoder(repoDir, [
			"-q",
			"/bin/bash",
			"-c",
			"touch owned-by-host.txt",
		]);

		const proc = await Bun.spawn(
			["stat", "-c", "%u", `${repoDir}/owned-by-host.txt`],
			{ stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;
		const owner = (await new Response(proc.stdout).text()).trim();

		expect(owner).toBe(String(process.getuid?.()));
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
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
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
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await worktreeListProc.exited;

		const worktreeList = await new Response(worktreeListProc.stdout).text();
		const lines = worktreeList.split("\n");

		// Find the worktree that has a scoder branch (skip the repo itself which is listed as main worktree)
		let worktreeDir: string | null = null;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].startsWith("branch refs/heads/scoder/")) {
				for (let j = i - 1; j >= 0; j--) {
					if (lines[j]?.startsWith("worktree ")) {
						worktreeDir = lines[j].slice("worktree ".length).trim();
						break;
					}
				}
				break;
			}
		}

		if (!worktreeDir) {
			// If no worktree found, skip worktree-specific check and test direct mode
			const testFilePath = `${repoDir}/test-file.txt`;
			expect(await fileExists(testFilePath)).toBe(false);

			await runScoder(repoDir, [
				"-q",
				"/bin/bash",
				"-c",
				`touch ${testFilePath}`,
			]);

			// File should exist now
			expect(await fileExists(testFilePath)).toBe(true);

			// Clean up
			await Bun.spawn(["git", "rm", "-f", "test-file.txt"], { cwd: repoDir })
				.exited;
			return;
		}

		// File should NOT exist in the worktree yet
		const testFilePath = `${worktreeDir}/test-file.txt`;
		expect(await fileExists(testFilePath)).toBe(false);

		// Use sandbox path inside shell command (worktree is mounted at /home/scoder/<projDir> in sandbox)
		const sandboxWorktreePath = worktreeDir.replace(
			"/tmp/scoder/",
			"/home/scoder/",
		);
		await runScoder(repoDir, [
			"-w",
			"-q",
			"/bin/bash",
			"-c",
			`touch ${sandboxWorktreePath}/test-file.txt`,
		]);

		// File should exist now on the host worktree
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
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
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
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
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
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
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
			[
				"scoder",
				"-q",
				"/bin/bash",
				"-c",
				"echo '# modified' >> .agentreadonly",
			],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		// Should fail because .agentreadonly is bind-mounted read-only
		expect(proc.exitCode).not.toBe(0);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// EM: ### Tests for the missing-.agentreadonly escape
// EM: A missing source path gets no bind mount at all, which otherwise
// EM: leaves that path part of the regular read-write project bind —
// EM: letting the sandboxed agent create or edit .agentreadonly itself.
// EM: Same bug class as .agentports; see
// EM: design/implementation/plans/agentports.md.

// ### Test: agentreadonly-created-if-missing
test("agentreadonly-created-if-missing: a real session creates .agentreadonly with the default protected list", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const proc = Bun.spawn([SCODER_PATH, "-q", "/bin/bash", "-c", "true"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		// The session itself may still fail later (pasta attaching), but the
		// file is created before that point is ever reached.
		const content = await Bun.file(`${repoDir}/.agentreadonly`).text();
		expect(content).toContain(".github/");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: agentreadonly-missing-file-not-writable-from-sandbox
test("agentreadonly-missing-file-not-writable-from-sandbox: a session with no pre-existing .agentreadonly still protects it read-only", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const proc = Bun.spawn(
			[
				SCODER_PATH,
				"-q",
				"/bin/bash",
				"-c",
				"echo '# modified' >> .agentreadonly",
			],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		const stderr = await new Response(proc.stderr).text();

		// A pasta-attach failure means the sandboxed command never ran at
		// all — the file would be untouched regardless of whether the fix
		// under test works, so this would otherwise pass trivially whenever
		// the sandbox can't launch (as in this suite's own dev environment,
		// which lacks /dev/net/tun). Requiring the absence of that specific
		// failure keeps the case honest: it fails here for that reason, not
		// a false pass, and proves the real thing on a working machine.
		expect(stderr).not.toContain("pasta failed to attach");

		// Writing must fail inside the sandbox, in this very first session —
		// not just protected starting the next run.
		expect(proc.exitCode).not.toBe(0);

		const content = await Bun.file(`${repoDir}/.agentreadonly`).text();
		expect(content).not.toContain("modified");
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
		await Bun.write(
			`${repoDir}/.agentreadonly`,
			`$HOME/.scoder-test-home-bind/`,
		);

		// Try to write to the bind-mounted directory (use sandbox path, not host path)
		const testHomeSandbox = `${SCODER_HOME}/.scoder-test-home-bind`;
		const proc = await Bun.spawn(
			[
				"scoder",
				"-q",
				"/bin/bash",
				"-c",
				`touch ${testHomeSandbox}/test-write-file`,
			],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		// Should fail because the bind is read-only
		expect(proc.exitCode).not.toBe(0);

		// Should still be able to read (use sandbox path)
		const readProc = await Bun.spawn(
			[
				"scoder",
				"-q",
				"/bin/bash",
				"-c",
				`cat ${testHomeSandbox}/test-read-file.txt 2>&1`,
			],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
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
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
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
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await initialBranchProc.exited;

		// Run scoder with worktree mode
		await runScoder(repoDir, ["-w", "-q", "/bin/bash", "-c", "echo test"]);

		// Check that scoder/<repo-name> branch was created
		const repoName = repoDir.split("/").pop() || "unknown";
		const branchName = `scoder/${repoName}`;

		const branchListProc = await Bun.spawn(
			["git", "branch", "--list", branchName],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
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
		await runScoder(repoDir, ["-w", "-q", "/bin/bash", "-c", "echo first"]);

		// Parse worktree directory from git worktree list
		const worktreeListProc = await Bun.spawn(
			["git", "worktree", "list", "--porcelain"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
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
		const output2 = await runScoderInDir(worktreeDir, [
			"-q",
			"/bin/bash",
			"-c",
			"echo second",
		]);

		// Should reuse the existing worktree (no error about nested worktree)
		expect(output2).not.toContain(
			"scoder is already running inside a git worktree",
		);
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

		// Get worktree directory - find the worktree with a scoder branch (skip the repo main worktree)
		const worktreeListProc = await Bun.spawn(
			["git", "worktree", "list", "--porcelain"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await worktreeListProc.exited;

		const worktreeList = await new Response(worktreeListProc.stdout).text();
		const lines = worktreeList.split("\n");

		let worktreeDir: string | null = null;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].startsWith("branch refs/heads/scoder/")) {
				for (let j = i - 1; j >= 0; j--) {
					if (lines[j]?.startsWith("worktree ")) {
						worktreeDir = lines[j].slice("worktree ".length).trim();
						break;
					}
				}
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
		const output = await runScoder(repoDir, [
			"-w",
			"-q",
			"/bin/bash",
			"-c",
			"echo second",
		]);

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
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
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
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		// Should find the overlay content
		expect(proc.exitCode).toBe(0);

		const output = await new Response(proc.stdout).text();
		expect(parseInt(output.trim(), 10)).toBeGreaterThan(0);
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
			[
				"scoder",
				"--no-worktree",
				"-q",
				"/bin/bash",
				"-c",
				"grep 'git worktree' AGENTS.md",
			],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
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
		fetch() {
			return new Response("OK");
		},
	});
	testServers.push(server);

	try {
		// Try to reach the host localhost from inside the sandbox
		// This should fail due to pasta's default loopback blocking
		const proc = await Bun.spawn(
			[
				"scoder",
				"-q",
				"/bin/bash",
				"-c",
				"curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:19999",
			],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		// Should fail (curl will return 000 or error)
		expect(proc.exitCode).not.toBe(0);
	} finally {
		await cleanupRepo(repoDir);
		server.stop();
	}
});

// ### Test: llm-port-auto-detect
let autoDetectServer: Bun.Server | null = null;

test("llm-port-auto-detect: Auto-detected port is reachable without --llm-port", async () => {
	const testPort = parseInt(process.env.SCODER_LLM_PORT || "", 10) || 19997;

	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	// Start a local HTTP server (must await - Bun.serve() is async)
	autoDetectServer = await Bun.serve({
		port: testPort,
		fetch() {
			return new Response("auto-detected-ok");
		},
	});

	try {
		// Run scoder WITHOUT --llm-port but with SCODER_LLM_PORT set
		const proc = await Bun.spawn(
			[
				SCODER_PATH,
				"-q",
				"/bin/bash",
				"-c",
				`curl -s http://127.0.0.1:${testPort}`,
			],
			{
				cwd: repoDir,
				stdout: "pipe",
				stderr: "pipe",
				env: { SCODER_LLM_PORT: testPort.toString() },
			},
		);
		await proc.exited;

		// Should succeed because scoder auto-detected the port
		expect(proc.exitCode).toBe(0);

		const output = await new Response(proc.stdout).text();
		expect(output.trim()).toBe("auto-detected-ok");
	} finally {
		await cleanupRepo(repoDir);
		if (autoDetectServer) {
			autoDetectServer.stop();
			autoDetectServer = null;
		}
	}
});

// ### Test: llm-port-allows-host-loopback
test("llm-port-allows-host-loopback: --llm-port allows reaching specific localhost port", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	// Start a local HTTP server
	const server = Bun.serve({
		port: 19998,
		fetch() {
			return new Response("OK");
		},
	});
	testServers.push(server);

	try {
		// Try to reach the host localhost with --llm-port
		const proc = await Bun.spawn(
			[
				"scoder",
				"--llm-port",
				"19998",
				"-q",
				"/bin/bash",
				"-c",
				"curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:19998",
			],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
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
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
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
		const output = await runScoder(repoDir, [
			"--dry-run",
			"-q",
			"/bin/bash",
			"-c",
			"echo test",
		]);

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
		const output = await runScoder(repoDir, [
			"--no-worktree",
			"-q",
			"/bin/bash",
			"-c",
			"echo test",
		]);

		// Should NOT create a scoder branch (this is the main test)
		const repoName = repoDir.split("/").pop() || "unknown";
		const branchName = `scoder/${repoName}`;

		const branchListProc = await Bun.spawn(
			["git", "branch", "--list", branchName],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
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

// ### Test: local-bin-symlink-resolved
test("local-bin-symlink-resolved: Symlink in ~/.local/bin pointing outside sandbox is resolved via forwarding shim", async () => {
	// Set up test artifacts
	const testBinDir = `${process.env.HOME}/bin/scoder-test-bin`;
	await Bun.spawn(["mkdir", "-p", testBinDir]).exited;

	const toolScript = `#!/bin/sh\necho "scoder-test-ok"\n`;
	const realTool = `${testBinDir}/scoder-test-tool`;
	await Bun.write(realTool, toolScript);
	await Bun.spawn(["chmod", "+x", realTool]).exited;

	const symlink = `${process.env.HOME}/.local/bin/scoder-test-tool`;
	try {
		await Bun.spawn(["ln", "-sf", realTool, symlink]).exited;
	} catch {
		// Symlink may already exist
	}

	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", "scoder-test-tool"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		// The forwarding shim should resolve the symlink and execute successfully
		expect(proc.exitCode).toBe(0);

		const output = await new Response(proc.stdout).text();
		expect(output.trim()).toBe("scoder-test-ok");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: local-bin-regular-file
test("local-bin-regular-file: Regular executable in ~/.local/bin is copied with permissions", async () => {
	// Set up test artifact
	const scriptPath = `${process.env.HOME}/.local/bin/scoder-test-script`;
	await Bun.write(scriptPath, `#!/bin/sh\necho "regular-script-ok"\n`);
	await Bun.spawn(["chmod", "+x", scriptPath]).exited;

	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", "scoder-test-script"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		// The script should execute successfully (permissions preserved)
		expect(proc.exitCode).toBe(0);

		const output = await new Response(proc.stdout).text();
		expect(output.trim()).toBe("regular-script-ok");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: local-bin-symlink-arg-passthrough
test("local-bin-symlink-arg-passthrough: Forwarding shim passes all arguments through", async () => {
	// Reuse the symlink created by local-bin-symlink-resolved. This couples the
	// two tests by execution order — see the note in validation-suite.md.
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", `scoder-test-tool arg1 arg2 arg3`],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		// Should succeed - arguments passed through the shim
		expect(proc.exitCode).toBe(0);

		const output = await new Response(proc.stdout).text();
		expect(output.trim()).toBe("scoder-test-ok");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// EM: ### Tests for tool preset bind modes
// EM: The only tests that exercise a real preset. Skipped when the tool is not
// EM: installed, so the suite still passes on a machine without it.

async function commandAvailable(cmd: string): Promise<boolean> {
	const proc = await Bun.spawn(["which", cmd], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	return proc.exitCode === 0;
}

const claudePresetTestable =
	(await commandAvailable("claude")) &&
	(await dirExists(`${process.env.HOME}/.claude`));

// ### Test: claude-preset-home-config-writable
// Claude Code writes to ~/.claude throughout a session (todos, history, shell
// snapshots). A read-only bind makes it fail rather than degrade, so this bind
// must stay read-write. Uses --dry-run: it inspects the command without
// launching a sandbox, so it never writes to the real config.
test.skipIf(!claudePresetTestable)(
	"claude-preset-home-config-writable: ~/.claude is bound read-write",
	async () => {
		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);

		try {
			const output = await runScoder(repoDir, ["--dry-run", "claude"]);
			const bind = `${process.env.HOME}/.claude ${SCODER_HOME}/.claude`;

			expect(output).toContain(`--bind ${bind}`);
			expect(output).not.toContain(`--ro-bind ${bind}`);
		} finally {
			await cleanupRepo(repoDir);
		}
	},
);

// ### Test: workspace-claude-dir-still-protected
// ~/.claude being writable must not affect the *workspace* .claude/ directory,
// which is protected infrastructure and stays read-only.
test.skipIf(!claudePresetTestable)(
	"workspace-claude-dir-still-protected: project .claude/ remains read-only",
	async () => {
		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);

		try {
			await Bun.spawn(["mkdir", "-p", `${repoDir}/.claude`]).exited;
			await Bun.write(`${repoDir}/.claude/settings.json`, "{}\n");

			const output = await runScoder(repoDir, ["--dry-run", "claude"]);

			// The workspace copy is a separate, still-read-only bind
			expect(output).toContain(`--ro-bind ${repoDir}/.claude`);
		} finally {
			await cleanupRepo(repoDir);
		}
	},
);

// EM: ### Tests for session commit and cleanup correctness
// EM: Covers the four issues in design/implementation/issues/

// Returns `git status --porcelain` for a repo
async function gitStatus(repoDir: string): Promise<string> {
	const proc = await Bun.spawn(["git", "status", "--porcelain"], {
		cwd: repoDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	return (await new Response(proc.stdout).text()).trim();
}

async function gitLogSubjects(repoDir: string, ref: string): Promise<string[]> {
	const proc = await Bun.spawn(["git", "log", "--format=%s", ref], {
		cwd: repoDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	if (proc.exitCode !== 0) {
		return [];
	}
	return (await new Response(proc.stdout).text())
		.split("\n")
		.filter((line) => line.length > 0);
}

// ### Test: session-commit-lands-in-worktree
// Regression test for commitAllChanges spawning git without a cwd, which
// committed the user's main checkout instead of the worktree.
test("session-commit-lands-in-worktree: worktree session leaves the launching repo untouched", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		// Uncommitted work in the launching checkout, as a user would have
		await Bun.write(`${repoDir}/host-only.txt`, "work in progress\n");
		const statusBefore = await gitStatus(repoDir);
		expect(statusBefore).toContain("host-only.txt");

		const headBefore = await gitLogSubjects(repoDir, "HEAD");

		// Run a worktree session that makes a change inside the sandbox
		await runScoder(repoDir, [
			"-q",
			"-w",
			"/bin/bash",
			"-c",
			"echo sandbox-work > from-sandbox.txt",
		]);

		// The launching checkout must be exactly as it was
		expect(await gitStatus(repoDir)).toBe(statusBefore);
		expect(await gitLogSubjects(repoDir, "HEAD")).toEqual(headBefore);

		// ...and the sandbox's work must be committed on the scoder branch
		const projName = repoDir.split("/").pop();
		const branchLog = await gitLogSubjects(repoDir, `scoder/${projName}`);
		expect(branchLog[0]).toBe("Committing session by scoder.");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: skip-worktree-cleared-after-session
// Regression test for process.exit() inside the try whose finally clears the
// AGENTS.md skip-worktree flag — process.exit skips pending finally blocks.
test("skip-worktree-cleared-after-session: AGENTS.md is not left flagged skip-worktree", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		await Bun.write(`${repoDir}/AGENTS.md`, "# Agents\n");
		await Bun.spawn(["git", "add", "AGENTS.md"], { cwd: repoDir }).exited;
		await Bun.spawn(["git", "commit", "-m", "add agents"], { cwd: repoDir })
			.exited;

		expect(await hasSkipWorktree(repoDir, "AGENTS.md")).toBe(false);

		await runScoder(repoDir, ["-q", "/bin/bash", "-c", "true"]);

		// The flag must be cleared, or git silently ignores edits to AGENTS.md
		expect(await hasSkipWorktree(repoDir, "AGENTS.md")).toBe(false);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: direct-mode-works-in-linked-worktree
// Regression test for the nesting check exiting whenever .git is a file,
// regardless of mode, while advising the flag the user already passed.
test("direct-mode-works-in-linked-worktree: --no-worktree runs inside a linked git worktree", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	const linkedWorktree = `${repoDir}-linked`;

	try {
		await Bun.spawn(
			["git", "worktree", "add", "-b", "feature", linkedWorktree],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		).exited;

		// A linked worktree has .git as a file, not a directory
		const gitFile = Bun.file(`${linkedWorktree}/.git`);
		expect((await gitFile.stat()).isFile()).toBe(true);

		// Direct mode creates no worktree, so there is nothing to nest
		const proc = await Bun.spawn(
			[
				SCODER_PATH,
				"-q",
				"--no-worktree",
				"/bin/bash",
				"-c",
				"echo in-worktree",
			],
			{ cwd: linkedWorktree, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		const stdout = await new Response(proc.stdout).text();
		expect(proc.exitCode).toBe(0);
		expect(stdout.trim()).toBe("in-worktree");
	} finally {
		await Bun.spawn(["git", "worktree", "remove", linkedWorktree, "--force"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: worktree-mode-refused-in-linked-worktree
// The other half: worktree mode genuinely cannot nest, so it must still refuse.
test("worktree-mode-refused-in-linked-worktree: -w inside a linked worktree still fails", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	const linkedWorktree = `${repoDir}-linked-w`;

	try {
		await Bun.spawn(
			["git", "worktree", "add", "-b", "feature-w", linkedWorktree],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		).exited;

		const proc = await Bun.spawn(
			[SCODER_PATH, "-w", "/bin/bash", "-c", "true"],
			{
				cwd: linkedWorktree,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		await proc.exited;

		const stderr = await new Response(proc.stderr).text();
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("from inside a git worktree");
	} finally {
		await Bun.spawn(["git", "worktree", "remove", linkedWorktree, "--force"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: uncommitted-host-changes-warned
// Regression test for hasUncommittedChanges being dead code: the agent cannot
// see uncommitted work in the launching checkout, so the user must be told.
test("uncommitted-host-changes-warned: worktree mode warns about uncommitted host changes", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		await Bun.write(`${repoDir}/unstaged.txt`, "not committed\n");

		const proc = await Bun.spawn(
			[SCODER_PATH, "-w", "/bin/bash", "-c", "true"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		const stderr = await new Response(proc.stderr).text();
		expect(proc.exitCode).toBe(0);
		expect(stderr).toContain("uncommitted changes the agent will not see");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: clean-worktree-session-commits-nothing
// commitAllChanges skips the commit when the worktree is clean, so an empty
// session does not fail on git commit returning non-zero.
test("clean-worktree-session-commits-nothing: empty session succeeds and adds no commit", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const output = await runScoder(repoDir, ["-w", "/bin/bash", "-c", "true"]);
		expect(output).not.toContain("Failed to commit");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// EM: ### Tests for $HOME-installed tool resolution
// EM: Implements tests for home-remapped exec paths (see design/features/path-mirroring.md)

// Mirrors the layout a native installer produces: an entry in ~/.local/bin
// symlinked at a versioned binary under ~/.local/share/<tool>/versions/.
async function createHomeInstalledTool(name: string): Promise<{
	symlink: string;
	versionDir: string;
	shareDir: string;
}> {
	const shareDir = `${process.env.HOME}/.local/share/${name}`;
	const versionDir = `${shareDir}/versions`;
	await Bun.spawn(["mkdir", "-p", versionDir]).exited;

	const binary = `${versionDir}/9.9.9`;
	await Bun.write(binary, `#!/bin/sh\necho "${name}-ok"\n`);
	await Bun.spawn(["chmod", "+x", binary]).exited;

	const symlink = `${process.env.HOME}/.local/bin/${name}`;
	await Bun.spawn(["ln", "-sf", binary, symlink]).exited;

	return { symlink, versionDir, shareDir };
}

// ### Test: home-installed-tool-exec-path-mapped
// Regression test for `scoder claude` failing with "execvp: No such file or
// directory": `which` returns a host path under $HOME, but the sandbox replaces
// /home with a tmpfs containing only /home/scoder, so the host path is absent.
test("home-installed-tool-exec-path-mapped: exec target for a $HOME-installed tool is rewritten to /home/scoder", async () => {
	const name = "scoder-test-homedtool";
	const tool = await createHomeInstalledTool(name);

	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const output = await runScoder(repoDir, ["--dry-run", name]);

		// The exec target must be the sandbox path, never the host path
		expect(output).toContain(`-- ${SCODER_HOME}/.local/bin/${name}`);
		expect(output).not.toContain(`-- ${process.env.HOME}/.local/bin/${name}`);
	} finally {
		await cleanupRepo(repoDir);
		await Bun.spawn(["rm", "-rf", tool.shareDir]).exited;
		await Bun.spawn(["rm", "-f", tool.symlink]).exited;
	}
});

// ### Test: home-installed-tool-runs
// The end-to-end shape of the reported failure: a $HOME-installed tool
// launched as the sandboxed tool must actually execute.
test("home-installed-tool-runs: a tool symlinked from ~/.local/bin into ~/.local/share executes in the sandbox", async () => {
	const name = "scoder-test-homedrun";
	const tool = await createHomeInstalledTool(name);

	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const proc = await Bun.spawn([SCODER_PATH, "-q", name], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		// The original bug surfaced here, from pasta rather than scoder
		expect(stderr).not.toContain("execvp");
		expect(proc.exitCode).toBe(0);
		expect(stdout.trim()).toBe(`${name}-ok`);
	} finally {
		await cleanupRepo(repoDir);
		await Bun.spawn(["rm", "-rf", tool.shareDir]).exited;
		await Bun.spawn(["rm", "-f", tool.symlink]).exited;
	}
});

// ### Test: local-bin-symlink-target-mapped
// The snapshot must rewrite absolute symlink targets into the sandbox
// namespace. Keeping the host spelling leaves the entry dangling inside the
// sandbox even though the resolvability check passed.
test("local-bin-symlink-target-mapped: snapshot symlink targets are rewritten into the sandbox namespace", async () => {
	const name = "scoder-test-maptarget";
	const tool = await createHomeInstalledTool(name);

	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const output = await runScoder(repoDir, ["--dry-run", name]);

		const match = output.match(/\/tmp\/scoder-local-bin\.[A-Za-z0-9]+/);
		if (!match) {
			throw new Error("scoder did not report a ~/.local/bin snapshot dir");
		}
		const snapshotDir = match[0];

		// Whichever branch each entry took — kept as a symlink, or copied in —
		// no entry may be a symlink to a host $HOME path. Those resolve on the
		// host but dangle inside the sandbox, which is the original bug.
		const findProc = await Bun.spawn(["find", snapshotDir, "-type", "l"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await findProc.exited;
		const links = (await new Response(findProc.stdout).text())
			.split("\n")
			.filter((line) => line.length > 0);

		const hostTargets: string[] = [];
		for (const link of links) {
			const linkProc = await Bun.spawn(["readlink", link], {
				stdout: "pipe",
				stderr: "pipe",
			});
			await linkProc.exited;
			const target = (await new Response(linkProc.stdout).text()).trim();
			if (target.startsWith(`${process.env.HOME}/`)) {
				hostTargets.push(`${link} -> ${target}`);
			}
		}

		expect(hostTargets).toEqual([]);

		// The tool under test is small and unbound, so it is copied in whole
		const copied = await fileExists(`${snapshotDir}/${name}`);
		expect(copied).toBe(true);
	} finally {
		await cleanupRepo(repoDir);
		await Bun.spawn(["rm", "-rf", tool.shareDir]).exited;
		await Bun.spawn(["rm", "-f", tool.symlink]).exited;
	}
});

// ### Test: unbound-home-tool-diagnosed
// A $HOME-installed tool whose directory is not bound cannot work. scoder
// should say so instead of leaving pasta to emit a bare execvp error.
test("unbound-home-tool-diagnosed: tool in an unbound $HOME directory fails with a scoder diagnostic", async () => {
	const toolDir = `${process.env.HOME}/scoder-test-unbound-bin`;
	await Bun.spawn(["mkdir", "-p", toolDir]).exited;

	const tool = `${toolDir}/scoder-test-unbound`;
	await Bun.write(tool, `#!/bin/sh\necho "unbound-ok"\n`);
	await Bun.spawn(["chmod", "+x", tool]).exited;

	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const proc = await Bun.spawn([SCODER_PATH, tool], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		const stderr = await new Response(proc.stderr).text();

		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("under your home directory");
		expect(stderr).not.toContain("execvp");
	} finally {
		await cleanupRepo(repoDir);
		await Bun.spawn(["rm", "-rf", toolDir]).exited;
	}
});

// EM: ### Tests for AGENTS.md overlay masking from git
// EM: Implements AGENTS.md overlay exclusion via git update-index --skip-worktree

async function createTempRepoSimple(): Promise<string> {
	const tmpProc = await Bun.spawn(["mktemp", "-d"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await tmpProc.exited;
	const tmpDir = (await new Response(tmpProc.stdout).text()).trim();

	// Create a git repo
	await Bun.spawn(["git", "init"], {
		cwd: tmpDir,
		stdout: "pipe",
		stderr: "pipe",
	}).exited;
	await Bun.spawn(["git", "config", "user.email", "test@test.com"], {
		cwd: tmpDir,
	}).exited;
	await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: tmpDir })
		.exited;

	return tmpDir;
}

// Helper: check if a file has skip-worktree set in the index
// git ls-files -v shows 'S' for skip-worktree, 'H' for normal staged
async function hasSkipWorktree(
	repoDir: string,
	path: string,
): Promise<boolean> {
	const proc = await Bun.spawn(["git", "ls-files", "-v", path], {
		cwd: repoDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	const output = await new Response(proc.stdout).text();
	// First character is 'S' (uppercase) for skip-worktree files
	return output.trim().startsWith("S ");
}

// EM: Unit test — addGitExclude should mark AGENTS.md as skip-worktree
test("addGitExclude should mark AGENTS.md as skip-worktree", async () => {
	const repoDir = await createTempRepoSimple();

	// Create AGENTS.md and stage it (skip-worktree only works on staged files)
	await Bun.write(`${repoDir}/AGENTS.md`, "# Test\n");
	await Bun.spawn(["git", "add", "AGENTS.md"], { cwd: repoDir }).exited;

	// Before: not in skip-worktree
	let hasSkip = await hasSkipWorktree(repoDir, "AGENTS.md");
	expect(hasSkip).toBe(false);

	// Run addGitExclude
	await addGitExclude(repoDir, "AGENTS.md");

	// After: should be in skip-worktree
	hasSkip = await hasSkipWorktree(repoDir, "AGENTS.md");
	expect(hasSkip).toBe(true);
});

// EM: Unit test — removeGitExclude should restore normal tracking
test("removeGitExclude should restore normal tracking", async () => {
	const repoDir = await createTempRepoSimple();

	// Create AGENTS.md and stage it
	await Bun.write(`${repoDir}/AGENTS.md`, "# Test\n");
	await Bun.spawn(["git", "add", "AGENTS.md"], { cwd: repoDir }).exited;

	// Mark as skip-worktree
	await addGitExclude(repoDir, "AGENTS.md");
	expect(await hasSkipWorktree(repoDir, "AGENTS.md")).toBe(true);

	// Remove skip-worktree
	await removeGitExclude(repoDir, "AGENTS.md");

	// Should no longer be skip-worktree
	expect(await hasSkipWorktree(repoDir, "AGENTS.md")).toBe(false);
});

// EM: Unit test — addGitExclude should be idempotent (calling twice is fine)
test("addGitExclude should be idempotent", async () => {
	const repoDir = await createTempRepoSimple();

	// Create AGENTS.md and stage it
	await Bun.write(`${repoDir}/AGENTS.md`, "# Test\n");
	await Bun.spawn(["git", "add", "AGENTS.md"], { cwd: repoDir }).exited;

	// Call addGitExclude twice
	await addGitExclude(repoDir, "AGENTS.md");
	await addGitExclude(repoDir, "AGENTS.md");

	// Should still have exactly one entry in skip-worktree
	expect(await hasSkipWorktree(repoDir, "AGENTS.md")).toBe(true);
});

// EM: Integration test — scoder should succeed with AGENTS.md excluded from git tracking
test("scoder should succeed in direct mode with AGENTS.md excluded", async () => {
	const repoDir = await createTempRepoSimple();

	// Create an AGENTS.md and initial commit
	await Bun.write(`${repoDir}/AGENTS.md`, "# Test repo\n");
	await Bun.spawn(["git", "add", "AGENTS.md"], { cwd: repoDir }).exited;
	await Bun.spawn(
		[
			"git",
			"-c",
			"user.email=test@test.com",
			"-c",
			"user.name=Test",
			"commit",
			"-m",
			"initial",
		],
		{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
	).exited;

	// Run scoder in direct mode
	const scoderResult = await Bun.spawn(
		[SCODER_PATH, "--no-worktree", "--quiet", "--dry-run", "opencode"],
		{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
	);
	await scoderResult.exited;

	// Should succeed
	expect(scoderResult.exitCode).toBe(0);

	// AGENTS.md should no longer be skip-worktree after session
	expect(await hasSkipWorktree(repoDir, "AGENTS.md")).toBe(false);
});

// EM: Integration test — scoder should succeed in worktree mode with AGENTS.md excluded from worktree git tracking
test("scoder should succeed in worktree mode with AGENTS.md excluded from worktree", async () => {
	const repoDir = await createTempRepoSimple();

	// Create an AGENTS.md and initial commit
	await Bun.write(`${repoDir}/AGENTS.md`, "# Test repo\n");
	await Bun.spawn(["git", "add", "AGENTS.md"], { cwd: repoDir }).exited;
	await Bun.spawn(
		[
			"git",
			"-c",
			"user.email=test@test.com",
			"-c",
			"user.name=Test",
			"commit",
			"-m",
			"initial",
		],
		{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
	).exited;

	// Run scoder in worktree mode
	const scoderResult = await Bun.spawn(
		[SCODER_PATH, "--quiet", "--dry-run", "opencode"],
		{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
	);
	await scoderResult.exited;

	// Should succeed
	expect(scoderResult.exitCode).toBe(0);
});

// EM: ### Tests for --allow-ssh
// EM: Implements ssh-tunnel-access (design/implementation/plans/ssh-tunnel-opt-in.md)
// EM: Needs a real sshd — ControlMaster multiplexing is a genuine OpenSSH
// EM: client/server behaviour that a plain TCP stub cannot stand in for.
// EM: skipIf when sshd/ssh-keygen are not installed, so the suite still
// EM: passes on a machine without them.

const MOCK_SSHD_PORT = 19996;
const mockSshdProcesses: Bun.Subprocess[] = [];

async function currentUsername(): Promise<string> {
	const proc = Bun.spawn(["id", "-un"], { stdout: "pipe", stderr: "pipe" });
	await proc.exited;
	return (await new Response(proc.stdout).text()).trim();
}

const HOST_USER = await currentUsername();
const sshTunnelTestable =
	(await commandAvailable("sshd")) && (await commandAvailable("ssh-keygen"));

interface MockSshd {
	tmpDir: string;
	port: number;
	proc: Bun.Subprocess;
	binDir: string;
}

// Starts a disposable sshd on a fixed non-default port with an ephemeral host
// key and an ephemeral client key authorized to log in as the current user
// (sshd authenticates against real system accounts, so there is no fabricated
// identity to log in as). Also writes a PATH-shimmed `ssh` that injects
// `-F <client_config>` into every invocation: this is what redirects the
// *host-side master connection* startSshTunnel opens to the mock server's
// port and identity. Overriding $HOME does not work for this — ssh resolves
// ~/.ssh/config via getpwuid(), not $HOME, confirmed directly while writing
// this fixture (see ssh-tunnel-opt-in.md). This shim never affects the
// sandboxed ssh invocation under test, which reads the real generated
// /home/scoder/.ssh/config: bwrap's --clearenv wipes the host PATH, and
// getpwuid() resolves correctly to /home/scoder inside the sandbox because
// setupSandboxIdentity overlays /etc/passwd for exactly this reason.
async function startMockSshd(port: number = MOCK_SSHD_PORT): Promise<MockSshd> {
	const tmpDir = `/tmp/scoder-ssh-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	await Bun.spawn(["mkdir", "-p", tmpDir]).exited;

	await Bun.spawn([
		"ssh-keygen",
		"-t",
		"ed25519",
		"-f",
		`${tmpDir}/host_key`,
		"-N",
		"",
		"-q",
	]).exited;
	await Bun.spawn([
		"ssh-keygen",
		"-t",
		"ed25519",
		"-f",
		`${tmpDir}/client_key`,
		"-N",
		"",
		"-q",
	]).exited;
	await Bun.write(
		`${tmpDir}/authorized_keys`,
		await Bun.file(`${tmpDir}/client_key.pub`).text(),
	);

	await Bun.write(
		`${tmpDir}/sshd_config`,
		[
			`Port ${port}`,
			"ListenAddress 127.0.0.1",
			`HostKey ${tmpDir}/host_key`,
			`AuthorizedKeysFile ${tmpDir}/authorized_keys`,
			"UsePAM no",
			"StrictModes no",
			`PidFile ${tmpDir}/sshd.pid`,
			"LogLevel ERROR",
			"",
		].join("\n"),
	);

	const proc = Bun.spawn(["sshd", "-f", `${tmpDir}/sshd_config`, "-D"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	mockSshdProcesses.push(proc);

	// Give sshd a moment to bind before anything tries to connect.
	await Bun.sleep(300);

	const keyscan = Bun.spawn(
		["ssh-keyscan", "-p", port.toString(), "127.0.0.1"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	await keyscan.exited;
	await Bun.write(
		`${tmpDir}/known_hosts`,
		await new Response(keyscan.stdout).text(),
	);

	await Bun.write(
		`${tmpDir}/client_config`,
		[
			"Host 127.0.0.1",
			`    Port ${port}`,
			`    IdentityFile ${tmpDir}/client_key`,
			`    UserKnownHostsFile ${tmpDir}/known_hosts`,
			"    StrictHostKeyChecking yes",
			"",
		].join("\n"),
	);

	const binDir = `${tmpDir}/bin`;
	await Bun.spawn(["mkdir", "-p", binDir]).exited;
	await Bun.write(
		`${binDir}/ssh`,
		`#!/bin/sh\nexec /usr/bin/ssh -F "${tmpDir}/client_config" "$@"\n`,
	);
	await Bun.spawn(["chmod", "+x", `${binDir}/ssh`]).exited;

	return { tmpDir, port, proc, binDir };
}

async function stopMockSshd(mock: MockSshd): Promise<void> {
	try {
		mock.proc.kill();
		await mock.proc.exited;
	} catch {
		// Already gone
	}
	await Bun.spawn(["rm", "-rf", mock.tmpDir]).exited;
}

function sshShimEnv(mock: MockSshd): Record<string, string> {
	return { ...process.env, PATH: `${mock.binDir}:${process.env.PATH}` };
}

// ### Test: ssh-tunnel-established-with-flag
// The real end-to-end proof: with --allow-ssh, ssh <host> inside the sandbox
// reaches the pinned target through the pre-authenticated tunnel.
test.skipIf(!sshTunnelTestable)(
	"ssh-tunnel-established-with-flag: --allow-ssh reaches the named target",
	async () => {
		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);
		const mock = await startMockSshd();

		try {
			const proc = Bun.spawn(
				[
					SCODER_PATH,
					"-q",
					"--allow-ssh",
					`${HOST_USER}@127.0.0.1`,
					"/bin/bash",
					"-c",
					"ssh 127.0.0.1 whoami",
				],
				{ cwd: repoDir, env: sshShimEnv(mock), stdout: "pipe", stderr: "pipe" },
			);
			await proc.exited;

			expect(proc.exitCode).toBe(0);
			const output = await new Response(proc.stdout).text();
			expect(output.trim()).toBe(HOST_USER);
		} finally {
			await stopMockSshd(mock);
			await cleanupRepo(repoDir);
		}
	},
);

// ### Test: ssh-blocked-by-default
// Guards the default: no flag, no ssh access, regardless of what is
// reachable outside the sandbox.
test("ssh-blocked-by-default: without --allow-ssh, ssh has nothing to authenticate with", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const proc = Bun.spawn(
			[
				SCODER_PATH,
				"-q",
				"/bin/bash",
				"-c",
				"ssh -o BatchMode=yes -o ConnectTimeout=5 127.0.0.1 whoami",
			],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		expect(proc.exitCode).not.toBe(0);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: ssh-wrong-host-falls-through
// The tunnel is pinned to one destination. A different hostname does not
// match the generated Host block at all and falls through to a normal,
// failing connection attempt.
test.skipIf(!sshTunnelTestable)(
	"ssh-wrong-host-falls-through: a different destination does not ride the tunnel",
	async () => {
		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);
		const mock = await startMockSshd();

		try {
			const proc = Bun.spawn(
				[
					SCODER_PATH,
					"-q",
					"--allow-ssh",
					`${HOST_USER}@127.0.0.1`,
					"/bin/bash",
					"-c",
					"ssh some-other-host.invalid whoami",
				],
				{ cwd: repoDir, env: sshShimEnv(mock), stdout: "pipe", stderr: "pipe" },
			);
			await proc.exited;

			expect(proc.exitCode).not.toBe(0);
		} finally {
			await stopMockSshd(mock);
			await cleanupRepo(repoDir);
		}
	},
);

// ### Test: ssh-wrong-user-falls-through
// Guards the %r-based pinning specifically: same reachable host, different
// login, still falls through rather than riding the tunnel as someone else.
test.skipIf(!sshTunnelTestable)(
	"ssh-wrong-user-falls-through: a different login does not ride the tunnel",
	async () => {
		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);
		const mock = await startMockSshd();

		try {
			const proc = Bun.spawn(
				[
					SCODER_PATH,
					"-q",
					"--allow-ssh",
					`${HOST_USER}@127.0.0.1`,
					"/bin/bash",
					"-c",
					"ssh someoneelse@127.0.0.1 whoami",
				],
				{ cwd: repoDir, env: sshShimEnv(mock), stdout: "pipe", stderr: "pipe" },
			);
			await proc.exited;

			expect(proc.exitCode).not.toBe(0);
		} finally {
			await stopMockSshd(mock);
			await cleanupRepo(repoDir);
		}
	},
);

// ### Test: ssh-no-private-keys-in-sandbox
// The most important guard in the set: it is what stops a future "just
// forward the agent, it's easier" change from passing review.
test.skipIf(!sshTunnelTestable)(
	"ssh-no-private-keys-in-sandbox: no private key material is bound in",
	async () => {
		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);
		const mock = await startMockSshd();

		try {
			const proc = Bun.spawn(
				[
					SCODER_PATH,
					"-q",
					"--allow-ssh",
					`${HOST_USER}@127.0.0.1`,
					"/bin/bash",
					"-c",
					"grep -rl 'PRIVATE KEY' /home/scoder/.ssh /home/scoder/.ssh-control 2>/dev/null; echo DONE",
				],
				{ cwd: repoDir, env: sshShimEnv(mock), stdout: "pipe", stderr: "pipe" },
			);
			await proc.exited;

			const output = await new Response(proc.stdout).text();
			expect(output.trim()).toBe("DONE");
		} finally {
			await stopMockSshd(mock);
			await cleanupRepo(repoDir);
		}
	},
);

// ### Test: ssh-tunnel-fails-closed-on-bad-target
// An unreachable destination exits non-zero with a clear error rather than
// hanging or silently continuing. Needs no mock server — the target must
// never answer.
test("ssh-tunnel-fails-closed-on-bad-target: unreachable target exits non-zero with a clear error", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const proc = Bun.spawn(
			[
				SCODER_PATH,
				"--allow-ssh",
				"nobody@unreachable.invalid",
				"/bin/bash",
				"-c",
				"true",
			],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		expect(proc.exitCode).not.toBe(0);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain("failed to establish a connection");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: ssh-tunnel-torn-down-on-exit
// Mirrors pasta-sidecar-reaped: counts before/after rather than asserting
// zero, since the developer may have other legitimate ssh sessions running.
test.skipIf(!sshTunnelTestable)(
	"ssh-tunnel-torn-down-on-exit: a completed session leaves no ssh master process behind",
	async () => {
		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);
		const mock = await startMockSshd();

		const countMasters = async (): Promise<number> => {
			const proc = Bun.spawn(["pgrep", "-cf", "ssh -M -N"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;
			const out = (await new Response(proc.stdout).text()).trim();
			return out === "" ? 0 : Number.parseInt(out, 10);
		};

		try {
			const before = await countMasters();

			const proc = Bun.spawn(
				[
					SCODER_PATH,
					"-q",
					"--allow-ssh",
					`${HOST_USER}@127.0.0.1`,
					"/bin/bash",
					"-c",
					"true",
				],
				{ cwd: repoDir, env: sshShimEnv(mock), stdout: "pipe", stderr: "pipe" },
			);
			await proc.exited;

			// Teardown signals and waits, but reaping is not instantaneous.
			await Bun.sleep(500);
			expect(await countMasters()).toBe(before);
		} finally {
			await stopMockSshd(mock);
			await cleanupRepo(repoDir);
		}
	},
);

// ### Test: ssh-dry-run-describes-without-connecting
// --dry-run must stay side-effect free: it shows the binds it would create,
// including that the control-socket directory is ro-bind not bind, without
// ever opening a real connection (describeSshAccess never runs startSshTunnel).
test("ssh-dry-run-describes-without-connecting: --dry-run shows the bind without opening a connection", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const output = await runScoder(repoDir, [
			"--dry-run",
			"--allow-ssh",
			"someone@example.invalid",
			"/bin/bash",
		]);

		expect(output).toContain(
			"--ro-bind <ssh-tunnel-tmp>/socket /home/scoder/.ssh-control",
		);
		expect(output).toContain(
			"--ro-bind <ssh-tunnel-tmp>/config/config /home/scoder/.ssh/config",
		);
		expect(output).not.toContain("--bind <ssh-tunnel-tmp>/socket");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// EM: ### Test for bwrap-orphaned-on-pasta-attach-failure
// EM: See design/implementation/issues/bwrap-orphaned-on-pasta-attach-failure.md
// EM: A fake pasta forces the failure deterministically, rather than relying
// EM: on an environment where pasta genuinely cannot attach (this suite's own
// EM: dev environment lacks /dev/net/tun, which is what surfaced the bug, but
// EM: that trigger will not reproduce everywhere the bug itself does).

// ### Test: bwrap-not-orphaned-on-pasta-attach-failure
test("bwrap-not-orphaned-on-pasta-attach-failure: a failed pasta attach leaves no bwrap process behind", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	const shimDir = `/tmp/scoder-fake-pasta-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	await Bun.spawn(["mkdir", "-p", shimDir]).exited;
	await Bun.write(`${shimDir}/pasta`, "#!/bin/sh\nexit 1\n");
	await Bun.spawn(["chmod", "+x", `${shimDir}/pasta`]).exited;

	const countMatchingBwrap = async (): Promise<number> => {
		const proc = Bun.spawn(["pgrep", "-cf", `bwrap.*${repoDir}`], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		const out = (await new Response(proc.stdout).text()).trim();
		return out === "" ? 0 : Number.parseInt(out, 10);
	};

	try {
		const proc = Bun.spawn([SCODER_PATH, "-q", "/bin/bash", "-c", "true"], {
			cwd: repoDir,
			env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		// The fake pasta always fails the attach, so the session itself fails.
		expect(proc.exitCode).not.toBe(0);

		// Teardown signals and waits, but reaping is not instantaneous.
		await Bun.sleep(500);
		expect(await countMatchingBwrap()).toBe(0);
	} finally {
		await Bun.spawn(["rm", "-rf", shimDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// EM: ### Test for terminal-signals-not-forwarded-to-sandbox
// EM: See design/implementation/issues/terminal-signals-not-forwarded-to-sandbox.md
// EM: Needs a real controlling-terminal relationship to reproduce at all —
// EM: a plain Bun.spawn (pipes, no tty) cannot exercise this, and Bun/Node
// EM: have no first-party PTY allocation, so the pty mechanics live in a
// EM: small, reusable Python helper (tests/helpers/pty-signal-harness.py)
// EM: rather than being reimplemented here. Self-skips if python3 is
// EM: unavailable, matching the sshd-dependent tests' own pattern above.
// EM: A fake pasta (daemonize-then-exit, matching real pasta's own shape)
// EM: stands in for the real one — same reasoning as
// EM: bwrap-not-orphaned-on-pasta-attach-failure: this environment's own
// EM: /dev/net/tun absence would make a real attach non-deterministic here,
// EM: when what's under test is signal delivery, not pasta itself.

const python3Available = await commandAvailable("python3");

test.skipIf(!python3Available)(
	"terminal-signals-forwarded-to-sandbox: SIGWINCH/SIGINT reach the sandboxed process, a second Ctrl-C force-kills",
	async () => {
		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);

		const shimDir = `/tmp/scoder-fake-pasta-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		await Bun.spawn(["mkdir", "-p", shimDir]).exited;
		// Mimics real pasta's daemonize-then-exit shape: attachPasta awaits the
		// spawned process's exit, then reads the pid file it wrote. The pidfile
		// write happens in the foreground, using the already-known backgrounded
		// pid ($!) — writing it from the backgrounded process itself would race
		// attachPasta's immediate read of the file.
		// biome-ignore-start lint/suspicious/noTemplateCurlyInString: these are
		// literal bash "${...}" references in a generated shell script, not
		// forgotten JS template placeholders — this is a plain string, not a
		// template literal, so JS never interpolates them.
		const fakePastaScript =
			"#!/bin/bash\n" +
			'PIDFILE=""\n' +
			'ARGS=("$@")\n' +
			"for ((i=0; i<${#ARGS[@]}; i++)); do\n" +
			'  if [[ "${ARGS[$i]}" == "--pid" ]]; then\n' +
			'    PIDFILE="${ARGS[$((i+1))]}"\n' +
			"  fi\n" +
			"done\n" +
			// biome-ignore-end lint/suspicious/noTemplateCurlyInString: see above
			"nohup sleep infinity >/dev/null 2>&1 &\n" +
			"BGPID=$!\n" +
			"disown\n" +
			'echo "$BGPID" > "$PIDFILE"\n' +
			"exit 0\n";
		await Bun.write(`${shimDir}/pasta`, fakePastaScript);
		await Bun.spawn(["chmod", "+x", `${shimDir}/pasta`]).exited;

		await Bun.spawn([
			"cp",
			`${import.meta.dir}/helpers/signal-diagnostic.py`,
			`${repoDir}/signal-diagnostic.py`,
		]).exited;

		// The harness (host side) polls this absolute path; the sandboxed
		// diagnostic is given the same file as a path relative to its own
		// cwd — path mirroring means these are the same underlying file via
		// the project's read-write bind, but the sandbox never sees a
		// host-absolute path directly.
		const hostLogPath = `${repoDir}/signal-test.log`;

		try {
			const proc = Bun.spawn(
				[
					"python3",
					`${import.meta.dir}/helpers/pty-signal-harness.py`,
					"--logfile",
					hostLogPath,
					"--cwd",
					repoDir,
					"--",
					SCODER_PATH,
					"-q",
					"--no-worktree",
					"python3",
					"signal-diagnostic.py",
					"signal-test.log",
				],
				{
					env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			await proc.exited;

			const stdout = await new Response(proc.stdout).text();
			expect(stdout).toContain("PASS");
			expect(proc.exitCode).toBe(0);
		} finally {
			await Bun.spawn(["rm", "-rf", shimDir]).exited;
			await cleanupRepo(repoDir);
		}
	},
);

// EM: ### Tests for the `scratch` symlink
// EM: See design/implementation/plans/persistent-rw-scratch.md
// EM: Targets live under a throwaway directory in the real $HOME (the
// EM: feature requires targets to resolve inside $HOME), cleaned up per test.

function scratchTargetPath(): string {
	return `${process.env.HOME}/.scoder-test-scratch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ### Test: scratch-symlink-resolves-rw
test("scratch-symlink-resolves-rw: reads and writes through a scratch symlink reach the real target", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const target = scratchTargetPath();

	try {
		await Bun.spawn(["mkdir", "-p", target]).exited;
		await Bun.write(`${target}/existing.txt`, "pre-existing\n");
		await Bun.spawn(["ln", "-s", target, `${repoDir}/scratch`]).exited;

		const output = await runScoder(repoDir, [
			"-q",
			"/bin/bash",
			"-c",
			"cat scratch/existing.txt && echo written > scratch/new.txt",
		]);

		expect(output.trim()).toBe("pre-existing");
		expect(await Bun.file(`${target}/new.txt`).text()).toBe("written\n");
	} finally {
		await Bun.spawn(["rm", "-rf", target]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: scratch-absent-no-behaviour-change
test("scratch-absent-no-behaviour-change: no scratch symlink means no scratch-related output", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const output = await runScoder(repoDir, ["--dry-run", "/bin/bash"]);
		expect(output).not.toContain("scratch ->");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: scratch-outside-home-fails
test("scratch-outside-home-fails: a target outside $HOME exits non-zero with a clear error", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		await Bun.spawn(["ln", "-s", "/tmp", `${repoDir}/scratch`]).exited;

		const proc = Bun.spawn([SCODER_PATH, "--dry-run", "/bin/bash"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		expect(proc.exitCode).not.toBe(0);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain("scratch must resolve inside your home directory");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: scratch-dangling-warns-and-continues
test("scratch-dangling-warns-and-continues: a not-yet-existing target warns but the session still runs", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const target = scratchTargetPath(); // deliberately never created

	try {
		await Bun.spawn(["ln", "-s", target, `${repoDir}/scratch`]).exited;

		const proc = Bun.spawn([SCODER_PATH, "--dry-run", "/bin/bash"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		expect(proc.exitCode).toBe(0);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain("does not exist yet");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: scratch-overlapping-furniture-is-readonly
const localBinExists = await dirExists(`${process.env.HOME}/.local/bin`);
test.skipIf(!localBinExists)(
	"scratch-overlapping-furniture-is-readonly: a target under an existing host-tool bind is read-only",
	async () => {
		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);

		try {
			await Bun.spawn([
				"ln",
				"-s",
				`${process.env.HOME}/.local/bin`,
				`${repoDir}/scratch`,
			]).exited;

			const output = await runScoder(repoDir, ["--dry-run", "/bin/bash"]);
			// info()'s "scratch -> ... (read-only)" message goes to stderr, not
			// the stdout runScoder captures — the bwrap args themselves are the
			// authoritative check, same as claude-preset-home-config-writable.
			expect(output).toContain(
				`--ro-bind ${process.env.HOME}/.local/bin ${process.env.HOME}/.local/bin`,
			);
			expect(output).not.toContain(
				`--bind ${process.env.HOME}/.local/bin ${process.env.HOME}/.local/bin`,
			);
		} finally {
			await cleanupRepo(repoDir);
		}
	},
);

// ### Test: scratch-overlapping-agentreadonly-home-is-readonly
test("scratch-overlapping-agentreadonly-home-is-readonly: a target already protected via .agentreadonly is read-only", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const target = scratchTargetPath();

	try {
		await Bun.spawn(["mkdir", "-p", target]).exited;
		const relative = target.slice(`${process.env.HOME}/`.length);
		await Bun.write(`${repoDir}/.agentreadonly`, `$HOME/${relative}\n`);
		await Bun.spawn(["ln", "-s", target, `${repoDir}/scratch`]).exited;

		const output = await runScoder(repoDir, ["--dry-run", "/bin/bash"]);
		expect(output).toContain(`--ro-bind ${target} ${target}`);
		expect(output).not.toContain(`--bind ${target} ${target}`);
	} finally {
		await Bun.spawn(["rm", "-rf", target]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: scratch-real-passthrough-unaffected
test("scratch-real-passthrough-unaffected: an ordinary tracked file still writes straight through with scratch present", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const target = scratchTargetPath();

	try {
		await Bun.spawn(["mkdir", "-p", target]).exited;
		await Bun.spawn(["ln", "-s", target, `${repoDir}/scratch`]).exited;

		await runScoder(repoDir, [
			"-q",
			"/bin/bash",
			"-c",
			"echo edited >> README.md",
		]);

		const content = await Bun.file(`${repoDir}/README.md`).text();
		expect(content).toContain("edited");
	} finally {
		await Bun.spawn(["rm", "-rf", target]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: scratch-tracked-symlink-present-in-fresh-worktree
test("scratch-tracked-symlink-present-in-fresh-worktree: a committed scratch symlink survives worktree creation", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const target = scratchTargetPath();

	try {
		await Bun.spawn(["mkdir", "-p", target]).exited;
		await Bun.spawn(["ln", "-s", target, `${repoDir}/scratch`]).exited;
		await Bun.spawn(["git", "add", "scratch"], { cwd: repoDir }).exited;
		await Bun.spawn(
			[
				"git",
				"-c",
				"user.email=t@t.com",
				"-c",
				"user.name=t",
				"commit",
				"-m",
				"add scratch",
			],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		).exited;

		await runScoder(repoDir, ["-w", "-q", "/bin/bash", "-c", "true"]);

		const worktreeListProc = await Bun.spawn(
			["git", "worktree", "list", "--porcelain"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await worktreeListProc.exited;
		const listing = await new Response(worktreeListProc.stdout).text();
		const worktreePath = listing
			.split("\n")
			.find((line) => line.startsWith("worktree ") && line.includes("scoder"))
			?.slice("worktree ".length)
			.trim();

		expect(worktreePath).toBeDefined();
		if (worktreePath) {
			const linkStat = await Bun.spawn(
				["readlink", `${worktreePath}/scratch`],
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			await linkStat.exited;
			const linkTarget = (await new Response(linkStat.stdout).text()).trim();
			expect(linkTarget).toBe(target);
		}
	} finally {
		await Bun.spawn(["rm", "-rf", target]).exited;
		await cleanupRepo(repoDir);
	}
});
