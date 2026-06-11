#!/usr/bin/env bun

// EM: Validation test suite for scoder sandbox functionality
// EM: Implements HAS_TEST: validation-suite feature tests

import { $ } from "bun";

const SCODER_HOME = "/home/scoder";
const TEST_BASE = await mktemp("/tmp/scoder-test.XXXXXX");
let passed = 0;
let failed = 0;

interface TestCase {
	name: string;
	fn: () => Promise<boolean>;
}

const tests: TestCase[] = [
	// EM: home-isolation - verify sandbox HOME is /home/scoder
	{ name: "home-isolation", fn: testHomeIsolation },
	// EM: system-read-only - verify system directories are read-only
	{ name: "system-read-only", fn: testSystemReadOnly },
	// EM: worktree-writable - verify worktree is writable
	{ name: "worktree-writable", fn: testWorktreeWritable },
	// EM: github-protected - verify .github/ is protected
	{ name: "github-protected", fn: testGithubProtected },
	// EM: gitignore-protected - verify .gitignore is protected
	{ name: "gitignore-protected", fn: testGitignoreProtected },
	// EM: empty-agentreadonly-allows-writes - verify empty .agentreadonly removes protection
	{
		name: "empty-agentreadonly-allows-writes",
		fn: testEmptyAgentreadonlyAllowsWrites,
	},
	// EM: agentreadonly-protected - verify .agentreadonly itself is always protected
	{ name: "agentreadonly-protected", fn: testAgentreadonlyProtected },
	// EM: agentreadonly-home-directory-readonly - verify $HOME/ binds are read-only
	{
		name: "agentreadonly-home-directory-readonly",
		fn: testAgentreadonlyHomeDirectoryReadonly,
	},
	// EM: agentreadonly-home-directory-must-exist - verify $HOME/ paths must exist
	{
		name: "agentreadonly-home-directory-must-exist",
		fn: testAgentreadonlyHomeDirectoryMustExist,
	},
	// EM: worktree-branch-created - verify scoder branch is created
	{ name: "worktree-branch-created", fn: testWorktreeBranchCreated },
	// EM: existing-scoder-worktree-reused - verify worktree reuse works
	{
		name: "existing-scoder-worktree-reused",
		fn: testExistingScoderWorktreeReused,
	},
	// EM: worktree-recreated-if-missing - verify worktree recreation after reboot
	{ name: "worktree-recreated-if-missing", fn: testWorktreeRecreatedIfMissing },
	// EM: symlinked-agents-skills-available - verify symlinked skills work
	{
		name: "symlinked-agents-skills-available",
		fn: testSymlinkedAgentsSkillsAvailable,
	},
	// EM: sandbox-agents-md-overlay-visible - verify AGENTS.md overlay works
	{
		name: "sandbox-agents-md-overlay-visible",
		fn: testSandboxAgentsMdOverlayVisible,
	},
	// EM: agents-md-overlay-in-direct-mode - verify direct mode overlay
	{
		name: "agents-md-overlay-in-direct-mode",
		fn: testAgentsMdOverlayInDirectMode,
	},
	// EM: host-loopback-blocked - verify host localhost is blocked
	{ name: "host-loopback-blocked", fn: testHostLoopbackBlocked },
	// EM: llm-port-allows-host-loopback - verify --llm-port exception works
	{ name: "llm-port-allows-host-loopback", fn: testLlmPortAllowsHostLoopback },
	// EM: outbound-dns-works - verify DNS resolution works in sandbox
	{ name: "outbound-dns-works", fn: testOutboundDnsWorks },
	// EM: dry-run-uses-pasta - verify dry-run includes pasta
	{ name: "dry-run-uses-pasta", fn: testDryRunUsesPasta },
	// EM: no-worktree-mode - verify --no-worktree flag works
	{ name: "no-worktree-mode", fn: testNoWorktreeMode },
];

async function main(): Promise<void> {
	console.log("====== scoder validation tests ======\n");

	for (const test of tests) {
		try {
			console.log(`Test: ${test.name}`);
			const result = await test.fn();

			if (result) {
				console.log("  PASS\n");
				passed++;
			} else {
				console.log("  FAIL");
				// Print more details here or run it in a way we can see
				failed++;
			}
		} catch (err) {
			console.error(`  FAIL: ${err}\n`);
			failed++;
		}
	}

	if (failed === 0) {
		console.log(`All ${passed} tests passed`);
		await cleanup();
		process.exit(0);
	} else {
		console.error(`${failed} test(s) failed, ${passed} passed`);
		await cleanup();
		process.exit(1);
	}
}

async function testHomeIsolation(): Promise<boolean> {
	const repoDir = await createTestRepo("home-isolation");
	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"printf '%s\n' $HOME",
	]);
	return output.includes(SCODER_HOME);
}

async function testSystemReadOnly(): Promise<boolean> {
	const repoDir = await createTestRepo("system-readonly");
	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"touch /usr/bin/scoder-test 2>&1 || true",
	]);
	return (
		output.includes("Read-only") ||
		output.includes("Permission denied") ||
		output.includes("cannot touch")
	);
}

async function testWorktreeWritable(): Promise<boolean> {
	const repoDir = await createTestRepo("worktree-writable");
	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"touch newfile.txt && echo SUCCESS",
	]);
	return output.includes("SUCCESS");
}

async function testGithubProtected(): Promise<boolean> {
	const repoDir = await createTestRepo("github-protected");
	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"touch .github/test 2>&1 || true",
	]);
	return (
		output.includes("Read-only") ||
		output.includes("Permission denied") ||
		output.includes("cannot")
	);
}

async function testGitignoreProtected(): Promise<boolean> {
	const repoDir = await createTestRepo("gitignore-protected");
	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"echo 'test' >> .gitignore 2>&1 || true",
	]);
	return (
		output.includes("Read-only") ||
		output.includes("Permission denied") ||
		output.includes("cannot")
	);
}

async function testEmptyAgentreadonlyAllowsWrites(): Promise<boolean> {
	const repoDir = await createTestRepo("empty-agentreadonly");
	await $`touch ${repoDir}/.agentreadonly`;
	await $`git -C ${repoDir} add -A`.quiet();
	await $`git -C ${repoDir} commit -m "add agentreadonly"`.quiet();

	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"touch .github/test && echo SUCCESS",
	]);
	return output.includes("SUCCESS");
}

async function testAgentreadonlyProtected(): Promise<boolean> {
	const repoDir = await createTestRepo("agentreadonly-protected");
	await $`touch ${repoDir}/.agentreadonly`;
	await $`git -C ${repoDir} add -A`.quiet();
	await $`git -C ${repoDir} commit -m "add agentreadonly"`.quiet();

	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"echo 'test' >> .agentreadonly 2>&1 || true",
	]);
	return (
		output.includes("Read-only") ||
		output.includes("Permission denied") ||
		output.includes("cannot")
	);
}

async function testAgentreadonlyHomeDirectoryReadonly(): Promise<boolean> {
	const repoDir = await createTestRepo("agentreadonly-home-readonly");
	const fakeHome = `${TEST_BASE}/bind-home`;
	const referenceDir = `${fakeHome}/Git/other-project`;

	await $`mkdir -p ${referenceDir}`;
	await $`echo "reference-data" > ${referenceDir}/data.txt`;
	await $`echo '$HOME/Git/other-project' > ${repoDir}/.agentreadonly`;
	await $`git -C ${repoDir} add -A`.quiet();
	await $`git -C ${repoDir} commit -m "add home readonly bind"`.quiet();

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

	return (
		output.includes("reference-data") &&
		(output.includes("Read-only") ||
			output.includes("Permission denied") ||
			output.includes("cannot"))
	);
}

async function testAgentreadonlyHomeDirectoryMustExist(): Promise<boolean> {
	const repoDir = await createTestRepo("agentreadonly-home-missing");
	const fakeHome = `${TEST_BASE}/missing-bind-home`;

	await $`mkdir -p ${fakeHome}`;
	await $`echo '$HOME/Git/missing-project' > ${repoDir}/.agentreadonly`;
	await $`git -C ${repoDir} add -A`.quiet();
	await $`git -C ${repoDir} commit -m "add missing home readonly bind"`.quiet();

	const output = await runScoder(repoDir, ["-q", "-w", "/bin/true"], {
		HOME: fakeHome,
	});
	return output.includes("HOME bind must reference an existing directory");
}

// ### testWorktreeBranchCreated
// [HAS_TEST](/design/test-scripts/validation-suite.md)
async function testWorktreeBranchCreated(): Promise<boolean> {
	const repoDir = await createTestRepo("worktree-branch");
	await runScoder(repoDir, ["-q", "-w", "/bin/bash", "-c", "echo READY"]);

	const branches = await $`git -C ${repoDir} branch --list 'scoder/*'`.text();
	return branches.trim().length > 0;
}

// ### testExistingScoderWorktreeReused
// [HAS_TEST](/design/test-scripts/validation-suite.md)
async function testExistingScoderWorktreeReused(): Promise<boolean> {
	const repoDir = await createTestRepo("worktree-reuse");
	await runScoder(repoDir, ["-q", "-w", "/bin/bash", "-c", "echo READY"]);

	const branches = await $`git -C ${repoDir} branch --list 'scoder/*'`.text();
	const branchName = branches
		.trim()
		.split("\n")[0]
		?.replace(/^\*\?\s*/, "");

	if (!branchName) {
		return false;
	}

	const worktreeList =
		await $`git -C ${repoDir} worktree list --porcelain`.text();
	const worktreeLine = worktreeList
		.split("\n")
		.find(
			(line) => line.startsWith("worktree ") && line.includes("/tmp/scoder/"),
		);
	const worktreeDir = worktreeLine?.split(" ")[1];

	if (!worktreeDir) {
		return false;
	}

	await $`echo "dirty" > ${worktreeDir}/reuse.txt`;

	const output = await runScoderInDir(worktreeDir, [
		"--dry-run",
		"-w",
		"/bin/true",
	]);
	return (
		output.includes("Already in scoder worktree") &&
		!output.includes("uncommitted changes")
	);
}

// ### testWorktreeRecreatedIfMissing
// [HAS_TEST](/design/test-scripts/validation-suite.md)
async function testWorktreeRecreatedIfMissing(): Promise<boolean> {
	const repoDir = await createTestRepo("worktree-recreated");

	// Create a file to verify it appears in the worktree
	await $`echo "persisted_file" > ${repoDir}/test_file.txt`;
	await $`git -C ${repoDir} add test_file.txt`.quiet();
	await $`git -C ${repoDir} commit -m "add test_file"`.quiet();

	// Run scoder to generate the worktree
	await runScoder(repoDir, ["-q", "-w", "/bin/bash", "-c", "echo SETUP"]);

	// Find the worktree path
	const worktreeList =
		await $`git -C ${repoDir} worktree list --porcelain`.text();
	const worktreeLine = worktreeList
		.split("\n")
		.find(
			(line) => line.startsWith("worktree ") && line.includes("/tmp/scoder/"),
		);
	const worktreeDir = worktreeLine?.split(" ")[1];

	if (!worktreeDir) {
		return false;
	}

	// Simulate reboot / clearing of /tmp
	await $`rm -rf ${worktreeDir}`;

	// Run scoder again. It should detect the missing directory, prune the worktree, and recreate it.
	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"cat test_file.txt",
	]);
	return output.includes("persisted_file");
}

async function testSymlinkedAgentsSkillsAvailable(): Promise<boolean> {
	const repoDir = await createTestRepo("agents-skills");
	const fakeHome = `${TEST_BASE}/agents-home`;
	const skillTarget = `${TEST_BASE}/linked-skill`;

	await $`mkdir -p ${fakeHome}/.agents/skills`;
	await $`mkdir -p ${skillTarget}`;
	await $`echo -e "---\nname: linked-skill\ndescription: 'Test skill for validation.'\n---" > ${skillTarget}/SKILL.md`;
	await $`ln -s ${skillTarget} ${fakeHome}/.agents/skills/linked-skill`;

	const output = await runScoder(
		repoDir,
		[
			"-q",
			"-w",
			"/bin/bash",
			"-c",
			"test -f /home/scoder/.agents/skills/linked-skill/SKILL.md && echo SUCCESS",
		],
		{ HOME: fakeHome },
	);

	return output.includes("SUCCESS");
}

async function testSandboxAgentsMdOverlayVisible(): Promise<boolean> {
	const repoDir = await createTestRepo("agents-md-overlay");
	await $`echo "# Repo instructions" > ${repoDir}/AGENTS.md`;
	await $`git -C ${repoDir} add -A`.quiet();
	await $`git -C ${repoDir} commit -m "add agents instructions"`.quiet();

	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"grep -q 'Repo instructions' AGENTS.md && grep -q 'scoder sandbox' AGENTS.md && echo SUCCESS",
	]);

	if (!output.includes("SUCCESS")) {
		return false;
	}

	const hostContent = await Bun.file(`${repoDir}/AGENTS.md`).text();
	return !hostContent.includes("scoder sandbox");
}

async function testAgentsMdOverlayInDirectMode(): Promise<boolean> {
	const repoDir = await createTestRepo("agents-md-direct");
	await $`echo "# Repo instructions" > ${repoDir}/AGENTS.md`;
	await $`git -C ${repoDir} add -A`.quiet();
	await $`git -C ${repoDir} commit -m "add agents instructions"`.quiet();

	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"--no-worktree",
		"/bin/bash",
		"-c",
		"grep -q 'scoder sandbox' AGENTS.md && grep -q 'ephemeral sandbox home' AGENTS.md && echo SUCCESS",
	]);

	if (!output.includes("SUCCESS")) {
		return false;
	}

	const output2 = await runScoder(repoDir, [
		"-q",
		"-w",
		"--no-worktree",
		"/bin/bash",
		"-c",
		"grep -q 'isolated git worktree' AGENTS.md && echo 'HAS_WORKTREE_MSG' || echo 'NO_WORKTREE_MSG'",
	]);

	return output2.includes("NO_WORKTREE_MSG");
}

async function testHostLoopbackBlocked(): Promise<boolean> {
	const repoDir = await createTestRepo("loopback-blocked");

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch() {
			return new Response("SUCCESS");
		},
	});

	try {
		const port = server.port;
		const output = await runScoder(repoDir, [
			"-q",
			"-w",
			"/bin/bash",
			"-c",
			`curl -fsS --max-time 2 http://127.0.0.1:${port}/ 2>&1 || echo BLOCKED`,
		]);

		return output.includes("BLOCKED");
	} finally {
		server.stop();
	}
}

async function testLlmPortAllowsHostLoopback(): Promise<boolean> {
	const repoDir = await createTestRepo("llm-port");

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch() {
			return new Response("SUCCESS");
		},
	});

	try {
		const port = server.port;
		const output = await runScoder(repoDir, [
			"-q",
			"-w",
			`--llm-port=${port}`,
			"/bin/bash",
			"-c",
			`curl -fsS --max-time 2 http://127.0.0.1:${port}/`,
		]);

		return output.includes("SUCCESS");
	} finally {
		server.stop();
	}
}

async function testOutboundDnsWorks(): Promise<boolean> {
	const repoDir = await createTestRepo("outbound-dns");
	const output = await runScoder(repoDir, [
		"-q",
		"-w",
		"/bin/bash",
		"-c",
		"python3 -c 'import socket; socket.getaddrinfo(\"example.com\", 443)' && echo SUCCESS",
	]);
	return output.includes("SUCCESS");
}

async function testDryRunUsesPasta(): Promise<boolean> {
	const repoDir = await createTestRepo("dry-run");
	const output = await runScoder(repoDir, ["--dry-run", "/bin/true"]);
	return output.includes("pasta");
}

async function testNoWorktreeMode(): Promise<boolean> {
	const repoDir = await createTestRepo("no-worktree");

	const output = await runScoder(repoDir, [
		"--no-worktree",
		"--dry-run",
		"/bin/true",
	]);

	const branches = await $`git -C ${repoDir} branch --list 'scoder/*'`.text();

	return output.includes("direct mode") && branches.trim().length === 0;
}

async function createTestRepo(name: string): Promise<string> {
	const caseDir = `${TEST_BASE}/${name}`;
	const repoDir = `${caseDir}/repo`;

	await $`mkdir -p ${repoDir}`;
	await $`git -C ${repoDir} init -q`;
	await $`git -C ${repoDir} config user.email "test@scoder"`;
	await $`git -C ${repoDir} config user.name "scoder-test"`;
	await $`echo "test" > ${repoDir}/file.txt`;
	await $`mkdir -p ${repoDir}/.github`;
	await $`echo "workflow" > ${repoDir}/.github/ci.yml`;
	await $`echo "*.pyc" > ${repoDir}/.gitignore`;
	await $`echo "{}" > ${repoDir}/package-lock.json`;
	await $`git -C ${repoDir} add -A`.quiet();
	await $`git -C ${repoDir} commit -q -m "initial"`.quiet();

	return repoDir;
}

async function runScoder(
	repoDir: string,
	args: string[],
	env?: Record<string, string>,
): Promise<string> {
	try {
		const scoderScript = `${process.cwd()}/src/index.ts`;
		const proc = await Bun.spawn(["bun", "run", scoderScript, ...args], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...env },
		});

		await proc.exited;

		const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
		const stderrBytes = await new Response(proc.stderr).arrayBuffer();

		return (
			new TextDecoder().decode(stdoutBytes) +
			new TextDecoder().decode(stderrBytes)
		);
	} catch (err) {
		return String(err);
	}
}

async function runScoderInDir(runDir: string, args: string[]): Promise<string> {
	try {
		const scoderScript = `${process.cwd()}/src/index.ts`;
		const proc = await Bun.spawn(["bun", "run", scoderScript, ...args], {
			cwd: runDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		await proc.exited;

		const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
		const stderrBytes = await new Response(proc.stderr).arrayBuffer();

		return (
			new TextDecoder().decode(stdoutBytes) +
			new TextDecoder().decode(stderrBytes)
		);
	} catch (err) {
		return String(err);
	}
}

async function mktemp(pattern: string): Promise<string> {
	const proc = await $`mktemp -d ${pattern}`.quiet();
	const output = new TextDecoder().decode(proc.stdout);
	return output.trim();
}

async function cleanup(): Promise<void> {
	try {
		await $`rm -rf ${TEST_BASE}`.quiet();
	} catch {}
}

main().catch((err) => {
	console.error("Test suite failed:", err);
	process.exit(1);
});
