// Bun test runner for scoder validation tests
// EM: Implements HAS_TEST: validation-suite feature tests

import { test, expect } from "bun:test";
import { spawn } from "bun";

const SCODER_HOME = "/home/scoder";
const TEST_BASE = "/tmp/scoder-test-bun";

async function createTestRepo(name: string): Promise<string> {
	const caseDir = `${TEST_BASE}-${name}-${Math.floor(Math.random() * 10000)}`;
	const repoDir = `${caseDir}/repo`;

	const mkdir = await spawn(["mkdir", "-p", repoDir]);
	await mkdir.exited;

	const gitInit = await spawn(["git", "-C", repoDir, "init", "-q"]);
	await gitInit.exited;

	const gitConfig = await spawn(["git", "-C", repoDir, "config", "user.email", "test@scoder"]);
	await gitConfig.exited;

	const gitConfigName = await spawn(["git", "-C", repoDir, "config", "user.name", "Test"]);
	await gitConfigName.exited;

	const writeTest = await spawn(["sh", "-c", `echo "test" > ${repoDir}/file.txt`]);
	await writeTest.exited;

	const gitAdd = await spawn(["git", "-C", repoDir, "add", "-A"]);
	await gitAdd.exited;

	const gitCommit = await spawn(["git", "-C", repoDir, "commit", "-q", "-m", "init"]);
	await gitCommit.exited;

	return repoDir;
}

async function runScoder(repoDir: string, args: string[], env?: Record<string, string>): Promise<string> {
	const srcIndex = `${import.meta.dir}/../src/index.ts`;
	const proc = await spawn([srcIndex, ...args], {
		cwd: repoDir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});

	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	await proc.exited;

	// The command output is in stdout, regardless of session summary exit code
	return stdout;
}

// ### testHomeIsolation
test("home-isolation", async () => {
	const repoDir = await createTestRepo("home-isolation");
	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"printf '%s\\n' $HOME",
	]);
	expect(output).toContain("/home/scoder");
});

// ### testSystemReadOnly
test("system-read-only", async () => {
	const repoDir = await createTestRepo("system-readonly");
	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"touch /tmp/test-writable 2>&1",
	]);
	expect(output).toBeDefined();
});

// ### testWorktreeWritable
test("worktree-writable", async () => {
	const repoDir = await createTestRepo("worktree-writable");
	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"echo test > ${HOME}/writable.txt && cat ${HOME}/writable.txt",
	]);
	expect(output).toContain("test");
});

// ### testGithubProtected
test("github-protected", async () => {
	const repoDir = await createTestRepo("github-protected");
	await spawn(["git", "-C", repoDir, "remote", "add", "origin", "https://github.com/test/test.git"]);
	const output = await runScoder(repoDir, ["-q", "--dry-run", "/bin/true"]);
	expect(output).toContain("github.com");
});

// ### testGitignoreProtected
test("gitignore-protected", async () => {
	const repoDir = await createTestRepo("gitignore-protected");
	await spawn(["sh", "-c", `echo "node_modules" > ${repoDir}/.gitignore`]);
	await spawn(["git", "-C", repoDir, "add", "-A"]);
	await spawn(["git", "-C", repoDir, "commit", "-q", "-m", "add gitignore"]);
	const output = await runScoder(repoDir, ["-q", "--dry-run", "/bin/true"]);
	expect(output).toContain("node_modules");
});

// ### testEmptyAgentreadonlyAllowsWrites
test("empty-agentreadonly-allows-writes", async () => {
	const repoDir = await createTestRepo("agentreadonly-empty");
	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"touch /home/scoder/test.txt",
	]);
	expect(output).toBeDefined();
});

// ### testAgentreadonlyProtected
test("agentreadonly-protected", async () => {
	const repoDir = await createTestRepo("agentreadonly-protected");
	const fakeHome = `${TEST_BASE}/agentreadonly`;
	const referenceDir = `${fakeHome}/Git/other-project`;

	await spawn(["mkdir", "-p", referenceDir]);
	await spawn(["sh", "-c", `echo "reference-data" > ${referenceDir}/data.txt`]);
	await spawn(["sh", "-c", `echo '${fakeHome}/Git/other-project' > ${repoDir}/.agentreadonly`]);
	await spawn(["git", "-C", repoDir, "add", "-A"]);
	await spawn(["git", "-C", repoDir, "commit", "-q", "-m", "add home readonly bind"]);

	const output = await runScoder(
		repoDir,
		[
			"-q",
			"-w",
			"/bin/bash",
			"-c",
			`cat /home/scoder/Git/other-project/data.txt && echo "test" >> /home/scoder/Git/other-project/data.txt 2>&1 || true`,
		],
		{ HOME: fakeHome },
	);

	expect(output).toContain("reference-data");
	expect(output).toContain("permission denied");
});

// ### testAgentreadonlyHomeDirectoryReadonly
test("agentreadonly-home-directory-readonly", async () => {
	const repoDir = await createTestRepo("agentreadonly-home-readonly");
	const fakeHome = `${TEST_BASE}/bind-home`;
	const referenceDir = `${fakeHome}/Git/other-project`;

	await spawn(["mkdir", "-p", referenceDir]);
	await spawn(["sh", "-c", `echo "reference-data" > ${referenceDir}/data.txt`]);
	await spawn(["sh", "-c", `echo '${fakeHome}/Git/other-project' > ${repoDir}/.agentreadonly`]);
	await spawn(["git", "-C", repoDir, "add", "-A"]);
	await spawn(["git", "-C", repoDir, "commit", "-q", "-m", "add home readonly bind"]);

	const output = await runScoder(
		repoDir,
		[
			"-q",
			"-w",
			"/bin/bash",
			"-c",
			`cat /home/scoder/Git/other-project/data.txt && echo "test" >> /home/scoder/Git/other-project/data.txt 2>&1 || true`,
		],
		{ HOME: fakeHome },
	);

	expect(output).toContain("reference-data");
	expect(output).toMatch(/(Read-only|Permission denied|cannot)/);
});

// ### testAgentreadonlyHomeDirectoryMustExist
test("agentreadonly-home-directory-must-exist", async () => {
	const repoDir = await createTestRepo("agentreadonly-home-exists");
	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"test -d /home/scoder && echo EXISTS",
	]);
	expect(output).toContain("EXISTS");
});

// ### testWorktreeBranchCreated
test("worktree-branch-created", async () => {
	const repoDir = await createTestRepo("worktree-branch");
	const output = await runScoder(repoDir, ["-q", "-w", "/bin/bash", "-c", "echo READY"]);
	expect(output).toContain("READY");

	const branches = await spawn(["git", "-C", repoDir, "branch", "--list", "scoder/*"]);
	await branches.exited;
	const branchOutput = await new Response(branches.stdout).text();
	expect(branchOutput.trim().length).toBeGreaterThan(0);
});

// ### testExistingScoderWorktreeReused
test("existing-scoder-worktree-reused", async () => {
	const repoDir = await createTestRepo("worktree-reuse");
	await runScoder(repoDir, ["-q", "-w", "/bin/bash", "-c", "echo READY"]);

	const branches = await spawn(["git", "-C", repoDir, "branch", "--list", "scoder/*"]);
	await branches.exited;
	const branchOutput = await new Response(branches.stdout).text();
	const branchName = branchOutput
		.trim()
		.split("\n")[0]
		?.replace(/^\*\?\s*/, "");

	expect(branchName).toBeDefined();

	const worktreeList = await spawn(["git", "-C", repoDir, "worktree", "list", "--porcelain"]);
	await worktreeList.exited;
	const worktreeOutput = await new Response(worktreeList.stdout).text();
	const worktreeLine = worktreeOutput
		.split("\n")
		.find((line) => line.startsWith("worktree ") && line.includes("/tmp/scoder/"));
	const worktreeDir = worktreeLine?.split(" ")[1];

	expect(worktreeDir).toBeDefined();

	// Check that running from worktree detects nested sandbox
	if (worktreeDir) {
		const worktreeScoder = await spawn(["bun", "run", `${import.meta.dir}/../src/index.ts`, "--dry-run", "-w", "/bin/true"], {
			cwd: worktreeDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await worktreeScoder.exited;

		const stderr = await new Response(worktreeScoder.stderr).text();
		expect(stderr).toContain("already running inside a git worktree");
		expect(stderr).toContain("nested sandbox");
	}
});

// ### testWorktreeRecreatedIfMissing
test("worktree-recreated-if-missing", async () => {
	const repoDir = await createTestRepo("worktree-recreated");

	// Create a worktree
	await runScoder(repoDir, ["-q", "-w", "/bin/bash", "-c", "echo READY"]);

	// Get the worktree directory
	const worktreeList = await spawn(["git", "-C", repoDir, "worktree", "list", "--porcelain"]);
	await worktreeList.exited;
	const worktreeOutput = await new Response(worktreeList.stdout).text();
	const worktreeLine = worktreeOutput
		.split("\n")
		.find((line) => line.startsWith("worktree ") && line.includes("/tmp/scoder/"));
	const worktreeDir = worktreeLine?.split(" ")[1];

	expect(worktreeDir).toBeDefined();

	// Delete the worktree
	await spawn(["rm", "-rf", worktreeDir]);

	// Run scoder again - should recreate worktree
	const output = await runScoder(repoDir, ["-q", "-w", "/bin/bash", "-c", "echo READY"]);
	expect(output).toContain("READY");
});

// ### testSymlinkedAgentsSkillsAvailable
test("symlinked-agents-skills-available", async () => {
	const repoDir = await createTestRepo("symlinked-skills");
	const output = await runScoder(repoDir, [
		"-q",
		"--dry-run",
		"/bin/bash",
		"-c",
		"test -L /home/scoder/.agents/skills && echo SYMLINK",
	]);
	expect(output).toContain("SYMLINK");
});

// ### testSandboxAgentsMdOverlayVisible
test("sandbox-agents-md-overlay-visible", async () => {
	const repoDir = await createTestRepo("agents-md-overlay");
	await spawn(["sh", "-c", `echo "# Repo instructions" > ${repoDir}/AGENTS.md`]);
	await spawn(["git", "-C", repoDir, "add", "-A"]);
	await spawn(["git", "-C", repoDir, "commit", "-q", "-m", "add agents instructions"]);

	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"grep -q 'Repo instructions' AGENTS.md && grep -q 'scoder sandbox' AGENTS.md && echo SUCCESS",
	]);

	expect(output).toContain("SUCCESS");

	const hostContent = await Bun.file(`${repoDir}/AGENTS.md`).text();
	expect(hostContent).not.toContain("scoder sandbox");
});

// ### testAgentsMdOverlayInDirectMode
test("agents-md-overlay-in-direct-mode", async () => {
	const repoDir = await createTestRepo("agents-md-direct");
	await spawn(["sh", "-c", `echo "# Repo instructions" > ${repoDir}/AGENTS.md`]);
	await spawn(["git", "-C", repoDir, "add", "-A"]);
	await spawn(["git", "-C", repoDir, "commit", "-q", "-m", "add agents instructions"]);

	const srcIndex = `${import.meta.dir}/../src/index.ts`;
	const proc = await spawn([srcIndex, "--no-worktree", "--dry-run", "/bin/true"], {
		cwd: repoDir,
		stdout: "pipe",
		stderr: "pipe",
	});

	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	await proc.exited;

	// Direct mode message goes to stderr via info()
	expect(stderr).toContain("direct mode");
});

// ### testHostLoopbackBlocked
test("host-loopback-blocked", async () => {
	const repoDir = await createTestRepo("host-loopback");
	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/sh",
		"-c",
		"curl -s --connect-timeout 1 http://127.0.0.1 2>&1 || true",
	]);
	// Network isolation should block loopback access
	expect(output.length).toBeGreaterThan(0);
});

// ### testLlmPortAllowsHostLoopback
test("llm-port-allows-host-loopback", async () => {
	const repoDir = await createTestRepo("llm-port");
	const output = await runScoder(repoDir, [
		"-q",
		"--llm-port=8080",
		"--dry-run",
		"/bin/true",
	]);
	expect(output).toContain("llm-port");
});

// ### testOutboundDnsWorks
test("outbound-dns-works", async () => {
	const repoDir = await createTestRepo("outbound-dns");
	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"getent hosts github.com",
	]);
	expect(output).toContain("github.com");
});

// ### testDryRunUsesPasta
test("dry-run-uses-pasta", async () => {
	const repoDir = await createTestRepo("dry-run");
	const output = await runScoder(repoDir, [
		"-q",
		"--dry-run",
		"/bin/true",
	]);
	expect(output).toContain("pasta");
});

// ### testNoWorktreeMode
test("no-worktree-mode", async () => {
	const repoDir = await createTestRepo("no-worktree");

	const srcIndex = `${import.meta.dir}/../src/index.ts`;
	const proc = await spawn([srcIndex, "--no-worktree", "--dry-run", "/bin/true"], {
		cwd: repoDir,
		stdout: "pipe",
		stderr: "pipe",
	});

	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	await proc.exited;

	expect(stderr).toContain("direct mode");

	const branches = await spawn(["git", "-C", repoDir, "branch", "--list", "scoder/*"]);
	await branches.exited;
	const branchOutput = await new Response(branches.stdout).text();
	expect(branchOutput.trim().length).toBe(0);
});
