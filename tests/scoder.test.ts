#!/usr/bin/env bun
/// <reference types="bun" />

// EM: Validation test suite for scoder sandbox runner
// EM: Implements tests for all sandbox mechanics described in design/test-scripts/validation-suite.md

// Import test utilities from bun:test
import { afterAll, expect, test } from "bun:test";
import { readdirSync, readlinkSync, statSync } from "node:fs";
import { removeStaleXpraPin } from "../src/cli/dependencies.ts";
import {
	addGitExclude,
	refreshResolvConfSnapshot,
	removeGitExclude,
	setupResolvConf,
} from "../src/git/protection.ts";
import {
	expandEnvNames,
	parseEnvNames,
	prepareConfigDir,
	userConfigDir,
} from "../src/git/sandbox-config.ts";
import {
	getWorktreesParentDir,
	relocateWorktree,
} from "../src/git/worktree.ts";
import { withWebDefaults } from "../src/sandbox/browser.ts";
import type { XpraWrap } from "../src/sandbox/builder.ts";
import {
	buildDevLayer,
	buildEntrypointInvocation,
	collectBindDests,
	DEFAULT_IDE_SHUTDOWN,
	detectHostTty,
} from "../src/sandbox/builder.ts";
import { getSandboxUsername } from "../src/sandbox/identity.ts";
import {
	restoreTerminal,
	TERMINAL_RESTORE_SEQUENCE,
} from "../src/sandbox/launch.ts";
import { renderOverlay, startOverlayWatcher } from "../src/sandbox/overlays.ts";
import { isIpv6RoutabilityFailure } from "../src/sandbox/pasta.ts";
import {
	isManagedWorkspacePath,
	resetManagedWorkspace,
} from "../src/tools/new-workspace.ts";
import { isSnapInstall, TOOL_PRESETS } from "../src/tools/presets.ts";
import type { IdeShutdown } from "../src/types.ts";
import {
	BWRAP_SELF_TEST,
	isUsernsRefusal,
	servesOpenAiModels,
} from "../src/utils/checks.ts";
import { getRealHome } from "../src/utils/paths.ts";
import { sessionPath } from "../src/utils/session.ts";
import {
	meetsXpraMinimum,
	parseXpraVersion,
} from "../src/utils/xpra-version.ts";

// ### Constants
const TEST_BASE = "/tmp/scoder-test-repos";
// EM: Every scoder run in this file, spawned or in-process, reads its user
// EM: defaults from here rather than the developer's real ~/.config/scoder:
// EM: scoder creates that directory on first use, and a suite run must
// EM: neither do so in someone's home nor pick up their edited env list.
// EM: Under TEST_BASE, so the normal cleanup removes it.
process.env.XDG_CONFIG_HOME = `${TEST_BASE}/xdg-config`;
// The sandbox's own $HOME is the real host $HOME now (see path-mirroring) —
// no more separate /home/scoder namespace. Kept as its own named constant
// (rather than inlining getRealHome() everywhere below) so every assertion
// that cares about "the sandbox's home" reads the same way it did before
// the rename, just pointed at the real value now.
const SANDBOX_HOME = getRealHome();
const SANDBOX_USERNAME = getSandboxUsername();

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

// ### removeSessionRoot
// Tests that pass SCODER_KEEP_SESSION_TMP so they can inspect staged files
// after scoder has exited own the cleanup scoder skipped for them. Takes any
// path under the root and removes the root itself, so a caller can hand over
// whatever path it happened to match.
async function removeSessionRoot(pathUnderRoot: string): Promise<void> {
	const root = pathUnderRoot.match(/^\/tmp\/scoder-[0-9a-f]{8}/)?.[0];
	if (root) {
		await Bun.spawn(["rm", "-rf", root]).exited;
	}
}

async function runScoderInDir(runDir: string, args: string[]): Promise<string> {
	const proc = await Bun.spawn([SCODER_PATH, ...args], {
		env: process.env,
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
// Worktrees for temp repos land here: TEST_BASE ("/tmp/scoder-test-repos")
// is not under $HOME, so projDir for /tmp/scoder-test-repos/repo-X is
// "tmp/scoder-test-repos/repo-X" (its leading slash stripped, per
// getProjDir), and getWorktreesParentDir(realHome, projDir) is
// $HOME/<dirname(projDir)>/worktrees/<basename(projDir)> — dirname(projDir)
// is the same "tmp/scoder-test-repos" for every test repo, so this prefix
// (down to but not including the varying "/repo-X/scoder" leaf) covers all
// of them.
// Unlike the old /tmp/scoder/... location, no real project's worktrees can
// plausibly land under this prefix — it would require a real checkout
// literally at ~/tmp/scoder-test-repos/... — so the old "never remove
// wholesale" collision risk no longer applies, but the scoping is kept
// anyway since there's no reason to widen it.
const TEST_WORKTREE_BASE = `${SANDBOX_HOME}/tmp/scoder-test-repos/worktrees`;

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

// ### Test: resolvconf-refresh-detects-and-corrects-a-stale-snapshot
// Regression test: reported directly, a host power-state event
// (suspend/resume) that changed the host's own DNS server left the
// sandbox's one-time /etc/resolv.conf snapshot pointing at a
// now-unreachable server for the rest of the session, confirmed to be
// unrecoverable by an .sandbox/ports edit (which only reattaches pasta,
// never touching this separately-bound snapshot). refreshResolvConfSnapshot
// (src/git/protection.ts) now re-reads the real host DNS config and
// rewrites the snapshot in place if it changed — no pasta/bwrap
// involvement, since /etc/resolv.conf inside the sandbox is a --ro-bind
// of this exact file, not a detached copy.
//
// Corrupts the snapshot itself, rather than the real host
// /etc/resolv.conf (never safe to touch in a test — it's the actual
// system file), to prove the diff-and-rewrite logic: any mismatch
// between the snapshot and the real source gets corrected, which is the
// same code path a genuine host DNS change would take.
test("resolvconf-refresh-detects-and-corrects-a-stale-snapshot: a diverged snapshot is rewritten back to the real host config", async () => {
	const bind = await setupResolvConf();
	if (!bind) {
		// No /etc/resolv.conf readable at all on this host — nothing to test.
		return;
	}

	try {
		const realContent = await Bun.file(bind.source).text();

		const unchanged = await refreshResolvConfSnapshot(bind.source);
		expect(unchanged).toBe(false);
		expect(await Bun.file(bind.source).text()).toBe(realContent);

		await Bun.write(bind.source, "nameserver 203.0.113.1\n");
		const changed = await refreshResolvConfSnapshot(bind.source);
		expect(changed).toBe(true);
		expect(await Bun.file(bind.source).text()).toBe(realContent);
	} finally {
		await Bun.spawn(["rm", "-f", bind.source]).exited;
	}
});

// ### Test: home-isolation
// EM: The sandbox no longer remaps $HOME to a separate synthetic path — its
// EM: own $HOME is the real host $HOME, bound at the same path both sides.
// EM: See path-mirroring / getRealHome in src/utils/paths.ts.
test("home-isolation: $HOME inside the sandbox is the real host $HOME", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const output = await runScoder(repoDir, [
			"-q",
			"/bin/bash",
			"-c",
			"echo $HOME",
		]);
		expect(output.trim()).toBe(SANDBOX_HOME);
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
// way. /etc is bound read-only from the host, so without the passwd/group
// overlay (setupSandboxIdentity) the sandbox uid would resolve through
// whatever the host's own database happens to have for it. The identity the
// overlay describes is the real one now (getSandboxUsername/getRealHome),
// not a synthetic "scoder" user — it has to be, since --setenv HOME and the
// real, unmapped $HOME bind already commit to the real identity elsewhere.
test("sandbox-identity-consistent: passwd and group describe the real sandbox identity", async () => {
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

		expect(user).toBe(SANDBOX_USERNAME);
		expect(group).toBe(SANDBOX_USERNAME);
		// The path OpenSSH would use to find ~/.ssh
		expect(home).toBe(SANDBOX_HOME);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: session-temp-root-cleaned
// Everything a session stages — the passwd/group overlay, the AGENTS.md
// overlay, the ~/.local/bin and ~/.agents snapshots, resolv.conf, ssh's
// control dir and config, the launch fifos — lives under one
// /tmp/scoder-<id> root that must not survive the run.
//
// EM: This counts session roots rather than the /tmp/scoder-identity-* dirs
// EM: it used to, because there is no longer a per-concern temp dir to count:
// EM: that is the point of the refactor. The invariant is stronger than
// EM: before — it now covers every staged artifact at once, including the
// EM: ~/.local/bin snapshot that was never cleaned up at all and reached
// EM: 374 MB a time (scoder-local-bin-staging-dirs-leak-into-tmp).
//
// EM: The glob is anchored to exactly 8 hex characters so it matches session
// EM: roots only. /tmp is full of other scoder-prefixed things, including
// EM: this suite's own /tmp/scoder-test-repos, and a bare scoder-* count
// EM: would fold them in and never change.
test("session-temp-root-cleaned: no session temp root survives a session", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	const countSessionRoots = async (): Promise<number> => {
		const proc = Bun.spawn(
			[
				"bash",
				"-c",
				"ls -d /tmp/scoder-* 2>/dev/null | grep -cE '/scoder-[0-9a-f]{8}$'",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;
		// grep -c exits 1 with a count of 0 when nothing matches.
		return Number.parseInt((await new Response(proc.stdout).text()).trim(), 10);
	};

	try {
		const before = await countSessionRoots();
		await runScoder(repoDir, ["-q", "/bin/bash", "-c", "true"]);
		expect(await countSessionRoots()).toBe(before);

		// EM: --dry-run is checked explicitly, not incidentally: it stages
		// EM: real files and then exits through process.exit(), above the
		// EM: finally that clears them, and it is the path the leak issue
		// EM: measured ~40 abandoned snapshot dirs from in one test run.
		await runScoder(repoDir, ["--dry-run", "/bin/bash", "-c", "true"]);
		expect(await countSessionRoots()).toBe(before);
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
// ### Test: dev-owned-by-outer-layer
// Regression test for /dev exposure and for pty allocation, which are one
// decision. An early --dev-bind /dev /dev gave the sandbox the host's whole
// real /dev; narrowing that to a fixed list of individual --dev-binds made pty
// allocation impossible (openat("/dev/ptmx") and openat("/dev/pts/ptmx") both
// ENOENT, openpty() failing outright, confirmed directly inside a live
// sandbox), which is what deadlocked Eclipse's and RStudio's terminal panes.
// The sandbox is now two bwrap layers: an outer one owning only /dev, built by
// bwrap's own --dev (same small node set, on a private tmpfs, plus a fresh
// devpts instance), and an inner one carrying every other isolation decision
// over it via a recursive --dev-bind /dev /dev. See
// design/implementation/issues/eclipse-rstudio-embedded-terminal-deadlocks.md.
test("dev-owned-by-outer-layer: /dev comes from bwrap's own --dev in an outer layer, not from hand-bound host device nodes", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const output = await runScoder(repoDir, [
			"--dry-run",
			"--no-worktree",
			"/bin/bash",
		]);

		const boundary = output.indexOf("-- bwrap");
		expect(boundary).toBeGreaterThan(-1);
		const outer = output.slice(0, boundary);
		const inner = output.slice(boundary);

		expect(outer).toContain("--dev /dev");
		// Ordering is load-bearing: --dev mounts a fresh tmpfs over /dev, so
		// the root bind that carries the host's own /dev must precede it.
		expect(outer.indexOf("--bind / /")).toBeLessThan(
			outer.indexOf("--dev /dev"),
		);

		// The inner layer takes that synthetic /dev wholesale — recursively, so
		// the outer's devpts instance comes with it.
		expect(inner).toContain("--dev-bind /dev /dev");
		expect(inner).toContain("--tmpfs /dev/shm");

		// The hand-bound pty nodes are exactly what could not work.
		expect(output).not.toContain("--dev-bind /dev/ptmx");
		expect(output).not.toContain("--dev-bind /dev/pts /dev/pts");
		// And the host's real /dev is never bound wholesale.
		expect(output).not.toContain("--dev-bind /dev /dev /dev");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: dev-layer-leaves-isolation-to-inner
// The outer layer owns /dev and nothing else: it binds the real root straight
// through and must not take the network namespace, because pasta cannot attach
// to a netns created by a bwrap invoked with --dev (confirmed directly on a
// real host: "Couldn't switch to pasta namespaces: Operation not permitted").
// --info-fd and --block-fd stay on the inner layer for the same reason — the
// pid the outer layer would publish sits outside the netns pasta attaches to.
test("dev-layer-leaves-isolation-to-inner: namespaces, fds and confinement all belong to the inner layer", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const output = await runScoder(repoDir, [
			"--dry-run",
			"--no-worktree",
			"/bin/bash",
		]);

		const boundary = output.indexOf("-- bwrap");
		const outer = output.slice(0, boundary);
		const inner = output.slice(boundary);

		expect(outer).not.toContain("--unshare-net");
		expect(outer).not.toContain("--info-fd");
		expect(outer).not.toContain("--block-fd");
		expect(inner).toContain("--unshare-net");
		expect(inner).toContain("--info-fd 3");
		expect(inner).toContain("--block-fd 9");

		// Both layers, or the inner one survives the outer's death.
		expect(outer).toContain("--die-with-parent");
		expect(inner).toContain("--die-with-parent");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: dev-layer-hoists-preset-device-binds
// --dev replaces /dev wholesale, so a device node a preset binds from /dev has
// to exist in the outer layer's /dev for the inner bind to resolve at all. The
// preset's own gating still decides whether the sandbox gets it: the bind stays
// on the inner layer too.
test("dev-layer-hoists-preset-device-binds: /dev/dri is exposed by the outer layer as well as bound by the inner one", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("rstudio");

	try {
		const output = await runScoder(repoDir, ["--dry-run", "rstudio"], {
			PATH: `${fakeBinDir}:${process.env.PATH}`,
		});

		const boundary = output.indexOf("-- bwrap");
		const outer = output.slice(0, boundary);
		const inner = output.slice(boundary);

		if (await dirExists("/dev/dri")) {
			expect(outer).toContain("--dev-bind-try /dev/dri /dev/dri");
			expect(inner).toContain("--dev-bind /dev/dri /dev/dri");
		} else {
			expect(output).not.toContain("/dev/dri");
		}
	} finally {
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: bind-dests-ignore-outer-layer
// collectBindDests feeds checkExecTargetReachable, which asks whether a tool's
// own directory is bound into the sandbox. The outer layer binds the real root
// at "/" on purpose; counting that would make every path look bound and
// silently disable the check.
test("bind-dests-ignore-outer-layer: the outer layer's root bind is not a sandbox bind destination", () => {
	const inner = ["bwrap", "--ro-bind", "/usr", "/usr", "--", "/bin/bash"];
	const composed = [...buildDevLayer("1000", "1000", inner), "--", ...inner];

	expect(composed).toContain("--bind");
	expect(collectBindDests(composed)).toEqual(["/usr"]);
	// An unwrapped command still works, so the helper stays usable on its own.
	expect(collectBindDests(inner)).toEqual(["/usr"]);
});

// ### Test: dev-layer-hoists-only-nodes-under-dev
// The inner layer's own wholesale bind of /dev is not a node to hoist, and a
// bind that merely mentions /dev outside it is not one either.
test("dev-layer-hoists-only-nodes-under-dev: /dev itself and non-device binds are left alone", () => {
	const inner = [
		"bwrap",
		"--dev-bind",
		"/dev",
		"/dev",
		"--dev-bind",
		"/dev/dri",
		"/dev/dri",
		"--ro-bind",
		"/dev/null",
		"/home/u/devnull",
	];
	const layer = buildDevLayer("1000", "1000", inner);

	expect(layer).toContain("--dev-bind-try");
	expect(layer.join(" ")).toContain("--dev-bind-try /dev/dri /dev/dri");
	expect(layer.join(" ")).not.toContain("--dev-bind-try /dev /dev");
	expect(layer.join(" ")).not.toContain("/home/u/devnull");
});

// ### Test: dev-tty-is-the-users-terminal
// EM: --new-session leaves the sandbox no controlling terminal, so /dev/tty
// EM: failed with ENXIO and OSC 52 copies written to it (pi's) vanished. The
// EM: outer layer binds the user's actual pty at /dev/tty — after --dev,
// EM: which would otherwise cover it — and only when there is a terminal.
// EM: TIOCSTI stays refused (the kernel allows it only on the caller's
// EM: controlling tty); measured by hand under bwrap, see builder.ts.
test("dev-tty-is-the-users-terminal: the outer layer binds the host pty at /dev/tty when there is one, and detection prefers stdout", async () => {
	const layer = buildDevLayer("1000", "1000", [], "/dev/pts/7").join(" ");
	expect(layer).toContain("--dev-bind /dev/pts/7 /dev/tty");
	expect(layer.indexOf("--dev /dev")).toBeLessThan(
		layer.indexOf("--dev-bind /dev/pts/7 /dev/tty"),
	);
	expect(buildDevLayer("1000", "1000", [], null).join(" ")).not.toContain(
		"/dev/tty",
	);

	const fds = (map: Record<number, string | null>) => (fd: number) =>
		map[fd] ?? null;
	expect(detectHostTty(fds({ 1: "/dev/pts/3", 0: "/dev/pts/9" }))).toBe(
		"/dev/pts/3",
	);
	expect(detectHostTty(fds({ 1: null, 2: "/dev/pts/4" }))).toBe("/dev/pts/4");
	expect(detectHostTty(fds({ 0: "/dev/tty2" }))).toBe("/dev/tty2");
	expect(detectHostTty(fds({ 1: "/tmp/not-a-tty" }))).toBeNull();
	expect(detectHostTty(fds({}))).toBeNull();

	// A real dry-run, under a pseudo-terminal and without one.
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	try {
		const underPty = Bun.spawn(
			["script", "-qec", `${SCODER_PATH} --dry-run -q /bin/bash`, "/dev/null"],
			{ cwd: repoDir, env: process.env, stdout: "pipe", stderr: "pipe" },
		);
		await underPty.exited;
		const ptyOut = (await new Response(underPty.stdout).text()).replace(
			/\r/g,
			"",
		);
		expect(flattenDryRun(ptyOut)).toMatch(
			/--dev-bind \/dev\/pts\/\d+ \/dev\/tty/,
		);

		const piped = await runScoder(repoDir, ["--dry-run", "-q", "/bin/bash"]);
		expect(piped).not.toMatch(/--dev-bind \S+ \/dev\/tty/);
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

		// EM: worktreeDir is already the sandbox path too — the worktree is
		// EM: bound at its own real, unmapped location, no separate sandbox
		// EM: spelling to translate to.
		await runScoder(repoDir, [
			"-w",
			"-q",
			"/bin/bash",
			"-c",
			`touch ${worktreeDir}/test-file.txt`,
		]);

		// File should exist now on the host worktree
		expect(await fileExists(testFilePath)).toBe(true);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: worktrees-parent-dir-bound-regardless-of-mode
// EM: The directory that will hold this project's worktree(s) is ensured
// EM: and bound writable on every session now, not just --worktree ones —
// EM: preparatory infrastructure for explicitly supporting multiple named
// EM: worktrees from within a direct-mode session in future. See
// EM: getWorktreesParentDir in src/git/worktree.ts and its call in
// EM: buildBwrapCommand (src/sandbox/builder.ts).
test("worktrees-parent-dir-bound-regardless-of-mode: a direct-mode session still ensures and binds the worktrees parent dir", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	// repoDir sits under TEST_BASE ("/tmp/scoder-test-repos"), not $HOME, so
	// its projDir (getProjDir) is "tmp/scoder-test-repos/<repo-name>" and its
	// worktrees-parent dir is
	// $HOME/tmp/scoder-test-repos/worktrees/<repo-name> — i.e.
	// TEST_WORKTREE_BASE (the shared prefix every test repo's worktree lands
	// under) plus this repo's own name.
	const repoName = repoDir.split("/").pop();
	const expectedParent = `${TEST_WORKTREE_BASE}/${repoName}`;

	try {
		// --dry-run stays side-effect free (same as getAgentPortsBind's
		// auto-detect step and describeSshAccess), so the real mkdir is
		// checked via an ordinary (non-dry-run) invocation instead. Its
		// preview is checked too, from the same run's stdout, to confirm the
		// bind is actually part of the built command.
		const proc = await Bun.spawn(
			[SCODER_PATH, "-q", "--no-worktree", "/bin/bash", "-c", "true"],
			{
				env: process.env,
				cwd: repoDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		await proc.exited;

		// The session itself may still fail later (pasta attaching), but the
		// worktrees-parent dir is created while building the bwrap command,
		// before that point is ever reached — same reasoning as
		// sandbox-readonly-created-default above.
		expect(await dirExists(expectedParent)).toBe(true);

		const dryRunOutput = await runScoder(repoDir, [
			"--dry-run",
			"--no-worktree",
			"/bin/bash",
		]);
		expect(dryRunOutput).toContain(
			`--bind ${expectedParent} ${expectedParent}`,
		);
	} finally {
		await cleanupRepo(repoDir);
		await Bun.spawn(["rm", "-rf", expectedParent]).exited;
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

// ### Test: empty-sandbox-readonly-allows-writes
test("empty-sandbox-readonly-allows-writes: Empty .sandbox/readonly removes default protection", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		// Create empty .sandbox/readonly
		await Bun.write(`${repoDir}/.sandbox/readonly`, "");

		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", "touch .github/test-file"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		// Should succeed because .sandbox/readonly is empty (no default protection)
		expect(proc.exitCode).toBe(0);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-readonly-protected
test("sandbox-readonly-protected: .sandbox/readonly is always mounted read-only", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		// Create .sandbox/readonly with some content
		await Bun.write(`${repoDir}/.sandbox/readonly`, "# test");

		// Try to modify .sandbox/readonly inside the sandbox
		const proc = await Bun.spawn(
			[
				"scoder",
				"-q",
				"/bin/bash",
				"-c",
				"echo '# modified' >> .sandbox/readonly",
			],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		// Should fail because .sandbox/readonly is bind-mounted read-only
		expect(proc.exitCode).not.toBe(0);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// EM: ### Tests for the missing-.sandbox/readonly escape
// EM: A missing source path gets no bind mount at all, which otherwise
// EM: leaves that path part of the regular read-write project bind —
// EM: letting the sandboxed agent create or edit .sandbox/readonly itself.
// EM: Same bug class as .sandbox/ports; see
// EM: design/implementation/plans/agentports.md.

// ### Test: sandbox-readonly-created-if-missing
test("sandbox-readonly-created-if-missing: a real session creates .sandbox/readonly with the default protected list", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const proc = Bun.spawn([SCODER_PATH, "-q", "/bin/bash", "-c", "true"], {
			env: process.env,
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		// The session itself may still fail later (pasta attaching), but the
		// file is created before that point is ever reached.
		const content = await Bun.file(`${repoDir}/.sandbox/readonly`).text();
		expect(content).toContain(".github/");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-readonly-missing-file-not-writable-from-sandbox
test("sandbox-readonly-missing-file-not-writable-from-sandbox: a session with no pre-existing .sandbox/readonly still protects it read-only", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const proc = Bun.spawn(
			[
				SCODER_PATH,
				"-q",
				"/bin/bash",
				"-c",
				"echo '# modified' >> .sandbox/readonly",
			],
			{
				env: process.env,
				cwd: repoDir,
				stdout: "pipe",
				stderr: "pipe",
			},
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

		const content = await Bun.file(`${repoDir}/.sandbox/readonly`).text();
		expect(content).not.toContain("modified");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-readonly-home-directory-readonly
test("sandbox-readonly-home-directory-readonly: .sandbox/readonly HOME bind is read-only", async () => {
	// Create a test directory in home
	const testHomeDir = `${process.env.HOME}/.scoder-test-home-bind`;
	await Bun.spawn(["mkdir", "-p", testHomeDir]).exited;

	// Create a test file in the directory first
	await Bun.write(`${testHomeDir}/test-read-file.txt`, "readable content");

	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		// Create .sandbox/readonly with HOME bind
		await Bun.write(
			`${repoDir}/.sandbox/readonly`,
			`$HOME/.scoder-test-home-bind/`,
		);

		// Try to write to the bind-mounted directory (use sandbox path, not host path)
		const testHomeSandbox = `${SANDBOX_HOME}/.scoder-test-home-bind`;
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

// ### Test: sandbox-readonly-home-file-bind-does-not-create-conflicting-dir
// Regression test: reported directly, an .sandbox/readonly $HOME/... entry
// pointing at a FILE (not a directory) failed with
// `bwrap: Can't create file at <path>: Is a directory`.
// fileOrDirExists (not dirExists) is the existence check
// registerAgentreadonlyHomeBind already used, so files were always meant
// to be supported — the bug was in the ancestor-`--dir` scaffold loop,
// which pushed a --dir entry for the leaf path too, not just its real
// ancestors. bwrap processes --dir before --ro-bind, so it scaffolded an
// empty directory exactly where the file needed a file mountpoint
// instead. Fixed by excluding the leaf from that loop — only true
// ancestors get a --dir entry now, matching how a --ro-bind of a
// directory never needed one for itself either (bwrap creates whatever
// mountpoint type matches the source automatically).
test("sandbox-readonly-home-file-bind-does-not-create-conflicting-dir: a file target binds without a bwrap directory-vs-file conflict", async () => {
	const testHomeDir = `${process.env.HOME}/.scoder-test-home-file-bind`;
	const testFile = `${testHomeDir}/nested/secret.txt`;
	await Bun.spawn(["mkdir", "-p", `${testHomeDir}/nested`]).exited;
	await Bun.write(testFile, "secret content\n");

	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		await Bun.write(
			`${repoDir}/.sandbox/readonly`,
			`$HOME/${testFile.slice(`${process.env.HOME}/`.length)}\n`,
		);

		// Structural check: the leaf itself must not get a --dir entry, only
		// its real ancestors — provable via --dry-run regardless of whether
		// this environment can complete a real launch.
		const output = await runScoder(repoDir, ["--dry-run", "/bin/bash"]);
		expect(output).toContain(`--dir ${testHomeDir}`);
		expect(output).toContain(`--dir ${testHomeDir}/nested`);
		expect(output).not.toContain(`--dir ${testFile}`);
		expect(output).toContain(`--ro-bind ${testFile} ${testFile}`);

		// Real launch: the actual bwrap error this bug produced happens
		// during mount setup, before pasta ever runs, so it's a valid check
		// independent of this environment's own missing /dev/net/tun.
		const proc = Bun.spawn([SCODER_PATH, "-q", "/bin/bash", "-c", "true"], {
			env: process.env,
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).not.toContain("Can't create file");
	} finally {
		await cleanupRepo(repoDir);
		await Bun.spawn(["rm", "-rf", testHomeDir]).exited;
	}
});

// ### Test: sandbox-readonly-home-directory-must-exist
test("sandbox-readonly-home-directory-must-exist: Non-existent HOME bind path fails with error", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		// Create .sandbox/readonly with non-existent path
		await Bun.write(
			`${repoDir}/.sandbox/readonly`,
			`$HOME/.non-existent-path/`,
		);

		// Should fail with error message
		const proc = await Bun.spawn(
			["scoder", "-q", "/bin/bash", "-c", "echo test"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		// Should fail because the referenced directory doesn't exist
		expect(proc.exitCode).not.toBe(0);

		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toMatch(/must reference an existing file or directory/);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-readonly-home-nested-namespace-path-allowed
// Regression test: reported directly, $HOME/.local/share/fonts was
// rejected outright with "overlaps reserved sandbox path" even though
// nothing was bound at the bare $HOME/.local umbrella it nested under at
// the time — only specific sub-paths under it were (.local/bin,
// .local/share/mise), neither of which fonts collided with.
// fixedBindDestinations (src/git/protection.ts) now lists only the exact
// fixed destinations, not the bare umbrellas they happen to live under.
// Uses $HOME/.local/share/icons rather than the originally reported
// .../fonts, since fonts has since become a fixed destination itself
// (buildExtraBinds now binds it by default — see
// sandbox-readonly-home-fonts-directory-now-redundant below) and so no
// longer illustrates "safely nested, not itself fixed."
test("sandbox-readonly-home-nested-namespace-path-allowed: $HOME/.local/share/icons is not rejected as a reserved path", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const iconsDir = `${process.env.HOME}/.local/share/icons`;
	const iconsDirPreexisted = await dirExists(iconsDir);

	try {
		if (!iconsDirPreexisted) {
			await Bun.spawn(["mkdir", "-p", iconsDir]).exited;
		}
		await Bun.write(
			`${repoDir}/.sandbox/readonly`,
			"$HOME/.local/share/icons\n",
		);

		const output = await runScoder(repoDir, ["--dry-run", "/bin/bash"]);
		expect(output).toContain(`--ro-bind ${iconsDir} ${iconsDir}`);
		expect(output).not.toContain("reserved sandbox path");
	} finally {
		if (!iconsDirPreexisted) {
			await Bun.spawn(["rm", "-rf", iconsDir]).exited;
		}
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-readonly-home-fonts-directory-now-redundant
// Fonts is now a fixed default bind (buildExtraBinds) — an .sandbox/readonly
// entry for the exact same path is therefore a redundant re-declaration
// of something scoder already handles, correctly rejected the same way
// $HOME/.claude or $HOME/.config already are.
test("sandbox-readonly-home-fonts-directory-now-redundant: $HOME/.local/share/fonts is rejected as a fixed destination", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fontsDir = `${process.env.HOME}/.local/share/fonts`;
	const fontsDirPreexisted = await dirExists(fontsDir);

	try {
		if (!fontsDirPreexisted) {
			await Bun.spawn(["mkdir", "-p", fontsDir]).exited;
		}
		await Bun.write(
			`${repoDir}/.sandbox/readonly`,
			"$HOME/.local/share/fonts\n",
		);

		const proc = Bun.spawn([SCODER_PATH, "--dry-run", "/bin/bash"], {
			env: process.env,
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		expect(proc.exitCode).not.toBe(0);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain("overlaps reserved sandbox path");
	} finally {
		if (!fontsDirPreexisted) {
			await Bun.spawn(["rm", "-rf", fontsDir]).exited;
		}
		await cleanupRepo(repoDir);
	}
});

// ### Test: worktrunk-worktree-path-pinned-to-sandbox-parent
// WORKTRUNK_WORKTREE_PATH overrides worktrunk's own worktree-path for this
// sandbox only, pinning it to the same parent scoder binds read-write, so a
// `wt switch --create` inside the sandbox lands next to scoder's own
// worktree instead of at worktrunk's default (a sibling of the repository,
// which is outside every bind — confirmed directly in a throwaway repo).
// Absolute rather than a relative template, because scoder computes the
// parent itself: that stays correct for a repository outside $HOME, whose
// worktrees scoder deliberately relocates under $HOME.
test("worktrunk-worktree-path-pinned-to-sandbox-parent: WORKTRUNK_WORKTREE_PATH points at the bound worktrees parent", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const repoName = repoDir.split("/").pop();

	try {
		const output = await runScoder(repoDir, [
			"--dry-run",
			"--no-worktree",
			"/bin/bash",
		]);

		expect(output).toContain(
			`--setenv WORKTRUNK_WORKTREE_PATH ${TEST_WORKTREE_BASE}/${repoName}/{{ branch | sanitize }}`,
		);
		// The same directory the sandbox binds writable, not some other one.
		expect(output).toContain(
			`--bind ${TEST_WORKTREE_BASE}/${repoName} ${TEST_WORKTREE_BASE}/${repoName}`,
		);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: worktrunk-user-config-bound-readonly
// worktrunk (`wt`) decides where a new worktree goes from worktree-path in
// its user config. Without that config inside the sandbox, `wt switch
// --create` falls back to worktrunk's own default — a sibling of the repo —
// which is outside every bind scoder sets up, so the new worktree is not
// writable (or even visible) from inside. Everything else worktrunk writes
// lives in the repo's own .git/wt/, already bound read-write, so this one
// file is the whole integration. Read-only: where worktrees go on the host
// is not something a sandboxed session should be able to rewrite. Created
// here if the host has none, same as the fonts test above.
// ### Test: worktree-relocated-to-current-layout
// relocateWorktree moves a worktree registered at a path the layout no
// longer produces — which is what every pre-2.3.3 session's worktree is,
// after the parent changed from repeating the whole relative projDir to
// just its basename. Uses plain git rather than a scoder launch: worktree
// mode cannot run inside a sandbox (the nesting guard refuses), and this is
// the one piece of the change that moves a user's directory, so it is
// checked rather than assumed. `git worktree move`, not `mv`: git rewrites
// both sides of its own bookkeeping, which a plain move would leave
// dangling — asserted here via `git worktree list`.
test("worktree-relocated-to-current-layout: an existing worktree is moved to the path the layout now gives", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const oldPath = `${repoDir}-old-layout/scoder`;
	const newPath = `${repoDir}-new-layout/scoder`;

	try {
		await Bun.spawn(["git", "worktree", "add", "-b", "scoder/x", oldPath], {
			cwd: repoDir,
			stdout: "ignore",
			stderr: "ignore",
		}).exited;

		const landed = await relocateWorktree(oldPath, newPath, repoDir);

		expect(landed).toBe(newPath);
		expect(await dirExists(newPath)).toBe(true);
		expect(await dirExists(oldPath)).toBe(false);

		// git's own bookkeeping followed the move, so the worktree is still
		// usable rather than merely present at the new path.
		const list = Bun.spawn(["git", "worktree", "list"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "ignore",
		});
		await list.exited;
		const listing = await new Response(list.stdout).text();
		expect(listing).toContain(newPath);
		expect(listing).not.toContain(oldPath);

		// Already where it belongs: a second call is a no-op, not a move.
		expect(await relocateWorktree(newPath, newPath, repoDir)).toBe(newPath);
	} finally {
		await Bun.spawn(["rm", "-rf", `${repoDir}-old-layout`]).exited;
		await Bun.spawn(["rm", "-rf", `${repoDir}-new-layout`]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: worktrees-parent-dir-layout
// The layout is a contract with worktrunk, not just an internal detail: it
// is chosen so one `wt` worktree-path template,
// "{{ repo_path }}/../worktrees/{{ repo }}/{{ branch | sanitize }}", puts
// worktrunk's worktrees in the same directory scoder binds read-write, with
// no hardcoded path segments and at any repository depth. Verified against
// `wt step eval` when it was chosen; pinned here because the live worktree
// tests cannot run inside a sandbox (the nesting guard refuses), so this is
// the only check of the rule that runs everywhere.
test("worktrees-parent-dir-layout: the parent is <dirname>/worktrees/<basename>, matching worktrunk's template", () => {
	const home = "/home/u";

	expect(getWorktreesParentDir(home, "Git/scoder")).toBe(
		"/home/u/Git/worktrees/scoder",
	);
	// Any depth, not just repositories one level down.
	expect(getWorktreesParentDir(home, "Git/sub/proj")).toBe(
		"/home/u/Git/sub/worktrees/proj",
	);
	// A repository outside $HOME keeps its path under $HOME (leading slash
	// stripped by getProjDir) so the sandbox can still bind it.
	expect(getWorktreesParentDir(home, "srv/code/proj")).toBe(
		"/home/u/srv/code/worktrees/proj",
	);
	// Never the project's own real location, which the sandbox maps at its
	// real path — that collision is the whole reason for the detour.
	expect(getWorktreesParentDir(home, "Git/scoder")).not.toBe(
		"/home/u/Git/scoder",
	);
});

test("worktrunk-user-config-bound-readonly: ~/.config/worktrunk/config.toml is bound read-only when it exists", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const wtConfigDir = `${process.env.HOME}/.config/worktrunk`;
	const wtConfigPath = `${wtConfigDir}/config.toml`;
	const preexisted = await fileExists(wtConfigPath);

	try {
		if (!preexisted) {
			await Bun.spawn(["mkdir", "-p", wtConfigDir]).exited;
			await Bun.write(wtConfigPath, "# test\n");
		}

		const output = await runScoder(repoDir, [
			"--dry-run",
			"--no-worktree",
			"/bin/bash",
		]);

		expect(output).toContain(`--ro-bind ${wtConfigPath} ${wtConfigPath}`);
		// Never writable: a sandboxed session must not be able to change
		// where the host puts its worktrees.
		expect(output).not.toContain(`--bind ${wtConfigPath}`);
	} finally {
		if (!preexisted) {
			await Bun.spawn(["rm", "-rf", wtConfigDir]).exited;
		}
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-readonly-home-ancestor-of-fixed-bind-still-rejected
// The other half of the same fix: a bare umbrella is only safe to allow
// when nothing fixed lives under it. $HOME/.config is an ancestor of
// real fixed sub-binds (.config/mise, .config/gh — see buildExtraBinds
// in src/sandbox/builder.ts), so it must still be rejected — the overlap
// check is bidirectional (an .sandbox/readonly entry that is an ancestor OF
// a fixed destination collides just as much as one that is a descendant
// of it).
test("sandbox-readonly-home-ancestor-of-fixed-bind-still-rejected: $HOME/.config is still rejected", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const configDir = `${process.env.HOME}/.config`;
	const configDirPreexisted = await dirExists(configDir);

	try {
		// Must actually exist first, or the "must reference an existing
		// directory" check fires before the overlap check this test targets.
		if (!configDirPreexisted) {
			await Bun.spawn(["mkdir", "-p", configDir]).exited;
		}
		await Bun.write(`${repoDir}/.sandbox/readonly`, "$HOME/.config\n");

		const proc = Bun.spawn([SCODER_PATH, "--dry-run", "/bin/bash"], {
			env: process.env,
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		expect(proc.exitCode).not.toBe(0);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain("overlaps reserved sandbox path");
	} finally {
		if (!configDirPreexisted) {
			await Bun.spawn(["rm", "-rf", configDir]).exited;
		}
		await cleanupRepo(repoDir);
	}
});

// ### Test: fonts-directory-bound-readonly-by-default
// Added directly at the user's request, alongside .config/mimeapps.list
// below: GUI presets (rstudio, eclipse) need real host fonts to render
// text at all, not just cleanly. buildExtraBinds (src/sandbox/builder.ts)
// binds it unconditionally, like every other host-tool-binding entry, not
// gated behind a preset or an .sandbox/readonly entry — no config needed.
test("fonts-directory-bound-readonly-by-default: ~/.local/share/fonts is bound read-only when present", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fontsDir = `${process.env.HOME}/.local/share/fonts`;
	const fontsDirPreexisted = await dirExists(fontsDir);

	try {
		if (!fontsDirPreexisted) {
			await Bun.spawn(["mkdir", "-p", fontsDir]).exited;
		}

		const output = await runScoder(repoDir, ["--dry-run", "/bin/bash"]);
		expect(output).toContain(`--ro-bind ${fontsDir} ${fontsDir}`);
		expect(output).not.toContain(`--bind ${fontsDir} ${fontsDir}`);
	} finally {
		if (!fontsDirPreexisted) {
			await Bun.spawn(["rm", "-rf", fontsDir]).exited;
		}
		await cleanupRepo(repoDir);
	}
});

// ### Test: mimeapps-list-bound-readonly-by-default
// Same reasoning as fonts-directory-bound-readonly-by-default: desktop
// apps commonly consult mimeapps.list for file-type "open with"
// associations.
test("mimeapps-list-bound-readonly-by-default: ~/.config/mimeapps.list is bound read-only when present", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const mimeappsPath = `${process.env.HOME}/.config/mimeapps.list`;
	const mimeappsPreexisted = await Bun.file(mimeappsPath).exists();

	try {
		if (!mimeappsPreexisted) {
			await Bun.write(mimeappsPath, "[Default Applications]\n");
		}

		const output = await runScoder(repoDir, ["--dry-run", "/bin/bash"]);
		expect(output).toContain(`--ro-bind ${mimeappsPath} ${mimeappsPath}`);
		expect(output).not.toContain(`--bind ${mimeappsPath} ${mimeappsPath}`);
	} finally {
		if (!mimeappsPreexisted) {
			await Bun.spawn(["rm", "-f", mimeappsPath]).exited;
		}
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
			["scoder", "-q", "/bin/bash", "-c", `ls ${SANDBOX_HOME}/.agents 2>&1`],
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

// ### Test: run-is-a-tmpfs-not-the-host
// EM: The security claim of ADR 0004, asserted as a negative, which is the
// EM: half that matters — and, since the proxy was dropped, the only thing
// EM: standing between the sandbox and the host's session bus. --ro-bind /run /run handed the sandbox every
// EM: socket under it, and permission was no obstacle: entering a user
// EM: namespace changes how ids are *rendered*, not the credentials the
// EM: kernel checks, so a sandbox reaches whatever its user can reach.
// EM: Verified on a real host that /run/docker.sock (root:docker) and
// EM: /run/ssh-agent.sock (world-writable) both accepted connect() through
// EM: that bind. A Docker socket is root on the host by design; an ssh-agent
// EM: is the user's keys, which is what --allow-ssh exists to avoid handing
// EM: over.
// EM:
// EM: A future change could reinstate that bind for a plausible-sounding
// EM: reason — something under /run appears to be missing — and nothing would
// EM: look different from outside. Hence asserting it here.
test("run-is-a-tmpfs-not-the-host: the host's /run is never bound into the sandbox", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const output = await runScoder(repoDir, [
			"--dry-run",
			"--no-worktree",
			"/bin/bash",
		]);

		expect(output).toContain("--tmpfs /run");
		expect(output).not.toContain("--ro-bind /run /run");
		expect(output).not.toContain("--bind /run /run");

		// XDG_RUNTIME_DIR still has to exist for the applications that expect
		// it; it is now a writable tmpfs path rather than the host's
		// directory, with none of the host's sockets in it. Created 0700,
		// like pam_systemd makes the host's — a bare --dir gives 0755.
		expect(output).toMatch(/--dir \/run\/user /);
		expect(output).toMatch(/--perms 700 \\\n\s+--dir \/run\/user\/\d+/);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: no-host-dbus-address-in-the-sandbox
// EM: The positive half of run-is-a-tmpfs-not-the-host, and the one a
// EM: well-meaning change is most likely to undo. The host's session bus was
// EM: passed through for a year on the strength of a symptom — RStudio's
// EM: menus greyed out — that was never retested once xpra started providing
// EM: a private bus of its own. It turned out the application needed *a*
// EM: bus, not the user's, and ADR 0004 drops the host's entirely.
// EM:
// EM: Forwarding the address without the socket is worse than leaving it
// EM: unset, because it points applications at a path the tmpfs removed
// EM: instead of letting xpra's own bus take over. Asserted against a GUI
// EM: preset specifically: that is the code path that used to set it, and
// EM: the only one where anything would notice.
test("no-host-dbus-address-in-the-sandbox: the host's session bus address is never passed in", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("rstudio");

	try {
		const output = await runScoder(repoDir, ["--dry-run", "rstudio"], {
			PATH: `${fakeBinDir}:${process.env.PATH}`,
			DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
		});

		expect(output).not.toContain("DBUS_SESSION_BUS_ADDRESS");
		expect(output).not.toContain("/run/user/1000/bus");

		// XDG_RUNTIME_DIR still goes through: it names a directory the
		// sandbox has, and applications that use it for scratch space rather
		// than for the bus still need it.
		expect(output).toContain("XDG_RUNTIME_DIR");
	} finally {
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: legacy-config-migrated-automatically
// EM: The upgrade path. Automatic and unconditional, because every
// EM: alternative is worse at this project's scale: hard-failing breaks
// EM: existing projects, a read-both compat shim outlives everyone, and a
// EM: command the user has to discover means a legacy .agentreadonly is
// EM: silently ignored until they find it — protections quietly ceasing to
// EM: apply, which is a security regression presented as an upgrade.
test("legacy-config-migrated-automatically: .agent* files move into .sandbox/ on first run", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		await Bun.write(`${repoDir}/.agentreadonly`, ".github/\n");
		await Bun.write(`${repoDir}/.agentports`, "# mine\n11434\n");

		await prepareConfigDir(repoDir);

		// Moved, not copied: a legacy file left behind would be read by
		// nothing and would invite someone to edit the wrong one.
		expect(await fileExists(`${repoDir}/.agentreadonly`)).toBe(false);
		expect(await fileExists(`${repoDir}/.agentports`)).toBe(false);

		// Content preserved exactly — this is someone's protection list.
		expect(await Bun.file(`${repoDir}/.sandbox/readonly`).text()).toBe(
			".github/\n",
		);
		expect(await Bun.file(`${repoDir}/.sandbox/ports`).text()).toBe(
			"# mine\n11434\n",
		);
		expect(await fileExists(`${repoDir}/.sandbox/README.md`)).toBe(true);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: legacy-config-never-overwrites
// EM: Both layouts present means a half-finished migration, or two people
// EM: with different versions. The new file wins and the legacy one is left
// EM: alone — reconciling two configurations that disagree is how a project
// EM: ends up with a protection list nobody wrote.
test("legacy-config-never-overwrites: an existing .sandbox/ file is not replaced by its legacy counterpart", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		await Bun.write(`${repoDir}/.agentreadonly`, "legacy\n");
		await Bun.write(`${repoDir}/.sandbox/readonly`, "current\n");

		await prepareConfigDir(repoDir);

		expect(await Bun.file(`${repoDir}/.sandbox/readonly`).text()).toBe(
			"current\n",
		);
		// Left in place rather than deleted: scoder is rewriting someone's
		// repository here, and discarding a file it decided not to use would
		// be a step too far.
		expect(await fileExists(`${repoDir}/.agentreadonly`)).toBe(true);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: overlay-tracks-host-edits
// EM: The point of live-file-overlays. AGENTS.md used to be rendered once at
// EM: startup, so correcting an agent's instructions meant restarting its
// EM: session — for the one file whose entire purpose is telling the agent
// EM: how to behave, exactly backwards.
// EM:
// EM: Exercised against renderOverlay directly rather than through a running
// EM: sandbox: what is under test is the composition and the
// EM: change-detection, and the watcher that calls it is three lines around a
// EM: poll. A sandbox would add minutes and test bwrap instead.
test("overlay-tracks-host-edits: a host edit reaches the sandbox without the injection accumulating", async () => {
	const dir = `/tmp/scoder-overlay-test-${Date.now()}`;
	await Bun.spawn(["mkdir", "-p", dir]).exited;
	const source = `${dir}/AGENTS.md`;
	const overlay = {
		label: "AGENTS.md",
		source,
		dest: `${dir}/sandbox/AGENTS.md`,
		injection: "## scoder sandbox\ninjected",
		position: "append" as const,
	};

	try {
		await Bun.write(source, "project rules");
		expect(await renderOverlay(overlay)).toBe(true);

		const staged = sessionPath(overlay.dest);
		expect(await Bun.file(staged).text()).toBe(
			"project rules\n## scoder sandbox\ninjected",
		);

		// Unchanged host file: no rewrite, so the watcher stays quiet rather
		// than logging a change every tick.
		expect(await renderOverlay(overlay)).toBe(false);

		await Bun.write(source, "project rules, revised");
		expect(await renderOverlay(overlay)).toBe(true);
		expect(await Bun.file(staged).text()).toContain("revised");

		// EM: The invariant that matters. Rendering from the previous output
		// EM: rather than from the source would duplicate the injection on
		// EM: every refresh, and would not show up until the host file had
		// EM: been edited twice — so it is asserted after several rounds, not
		// EM: one.
		for (let i = 0; i < 4; i++) {
			await Bun.write(source, `project rules, revision ${i}`);
			await renderOverlay(overlay);
		}
		const final = await Bun.file(staged).text();
		expect(final.split("## scoder sandbox").length - 1).toBe(1);

		// A source that does not exist renders as the injection alone, which
		// is what a project with no AGENTS.md should see.
		await Bun.spawn(["rm", "-f", source]).exited;
		expect(await renderOverlay(overlay)).toBe(true);
		expect(await Bun.file(staged).text()).toBe("## scoder sandbox\ninjected");

		// ...and it starts tracking the file again if it appears later.
		await Bun.write(source, "created mid-session");
		expect(await renderOverlay(overlay)).toBe(true);
		expect(await Bun.file(staged).text()).toContain("created mid-session");
	} finally {
		await Bun.spawn(["rm", "-rf", dir]).exited;
	}
});

// ### Test: overlay-warns-when-a-host-save-detaches-the-bind
// EM: The gap the live overlay cannot close (2.7.0 decision, option "warn
// EM: only" of agents-md-does-not-update-as-expected): a bind grafts onto
// EM: the file at the destination path, so a save-by-rename — VS Code's
// EM: atomic save, vim's backup mode, `sed -i`, `git checkout` — installs a
// EM: new file under the old name and the sandbox silently loses scoder's
// EM: section for the rest of the session. No presentation scheme fixes
// EM: this without mutating the project file or losing agent writes, so
// EM: what is promised instead is detection: the watcher records which file
// EM: the bind is attached to and says so the moment the path names another
// EM: one. This is the mid-session rename no overlay test did before —
// EM: overlay-tracks-host-edits edits in place, which is precisely the
// EM: saving style that keeps the bind alive.
// EM:
// EM: Watcher-level rather than sandbox-level, same trade as the test above
// EM: it sits beside: what is under test is the inode bookkeeping and the
// EM: once-only warning, and the detach itself is a kernel mount fact the
// EM: bwrap harness would only re-prove.
test("overlay-warns-when-a-host-save-detaches-the-bind: a rename-save or delete mid-session warns once; in-place edits do not", async () => {
	const dir = `/tmp/scoder-overlay-detach-${Date.now()}`;
	await Bun.spawn(["mkdir", "-p", dir]).exited;
	const replaced = `${dir}/AGENTS.md`;
	const deleted = `${dir}/.Rprofile`;
	const overlays = [
		{
			label: "AGENTS.md",
			source: replaced,
			dest: `${dir}/sandbox/AGENTS.md`,
			injection: "## scoder sandbox",
			position: "append" as const,
		},
		{
			label: ".Rprofile",
			source: deleted,
			dest: `${dir}/sandbox/.Rprofile`,
			injection: "# injected",
			position: "prepend" as const,
		},
	];
	await Bun.write(replaced, "project rules");
	await Bun.write(deleted, "# project profile");

	// The logger writes straight to console.error; capture instead of mock.
	const lines: string[] = [];
	const realError = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.join(" "));
	};

	const watcher = startOverlayWatcher(overlays, 50);
	try {
		await Bun.sleep(150);

		// The saving style that keeps the bind alive: truncate-in-place is
		// inode-stable, so it refreshes quietly and is never "replaced".
		await Bun.write(replaced, "project rules, edited in place");
		await Bun.sleep(150);
		expect(lines.join("\n")).toContain("AGENTS.md changed on the host");
		expect(lines.join("\n")).not.toContain("replaced on the host");

		// The saving style that kills it: temp file, rename over the name.
		await Bun.write(`${dir}/tmp-save`, "saved by the editor");
		await Bun.spawn(["mv", `${dir}/tmp-save`, replaced]).exited;
		// ...and a plain delete, which takes the bind's mountpoint too.
		await Bun.spawn(["rm", "-f", deleted]).exited;
		await Bun.sleep(150);

		const warnings = lines.filter((l) => l.includes("scoder:"));
		expect(
			warnings.filter((l) => l.includes("AGENTS.md was replaced on the host"))
				.length,
		).toBe(1);
		expect(
			warnings.filter((l) => l.includes(".Rprofile was deleted on the host"))
				.length,
		).toBe(1);
		expect(warnings.find((l) => l.includes("replaced on the host"))).toContain(
			"Restart the session",
		);

		// Loud once, not every tick: the detach is permanent, so repeating
		// the sentence would be noise on a long session. Further in-place
		// edits on the replaced file also stop claiming "updated in the
		// sandbox" — after a detach that sentence is no longer true.
		const replacedWarns = warnings.filter((l) =>
			l.includes("replaced on the host"),
		).length;
		const updatedInfos = lines.filter((l) =>
			l.includes("updated in the sandbox"),
		).length;
		await Bun.write(replaced, "still editing, still detached");
		await Bun.sleep(150);
		expect(lines.filter((l) => l.includes("replaced on the host")).length).toBe(
			replacedWarns,
		);
		expect(
			lines.filter((l) => l.includes("updated in the sandbox")).length,
		).toBe(updatedInfos);
	} finally {
		watcher.stop();
		console.error = realError;
		await Bun.spawn(["rm", "-rf", dir]).exited;
	}
});

// ### Test: overlay-prepends-when-asked
// EM: An .Rprofile is the motivating case for prepend: R evaluates it top to
// EM: bottom, so a session registration has to run before anything the
// EM: project does. Appending would be silently useless.
test("overlay-prepends-when-asked: prepend puts the injection before the host content", async () => {
	const dir = `/tmp/scoder-overlay-pre-${Date.now()}`;
	await Bun.spawn(["mkdir", "-p", dir]).exited;
	const source = `${dir}/.Rprofile`;

	try {
		await Bun.write(source, "options(stringsAsFactors = FALSE)");
		const overlay = {
			label: ".Rprofile",
			source,
			dest: `${dir}/sandbox/.Rprofile`,
			injection: "if (interactive()) btw::btw_mcp_session()",
			position: "prepend" as const,
		};
		await renderOverlay(overlay);

		const text = await Bun.file(sessionPath(overlay.dest)).text();
		expect(text).toBe(
			"if (interactive()) btw::btw_mcp_session()\noptions(stringsAsFactors = FALSE)",
		);
		// No leading blank line when the source is absent — the injected call
		// must be the first thing R evaluates.
		await Bun.spawn(["rm", "-f", source]).exited;
		await renderOverlay(overlay);
		expect(await Bun.file(sessionPath(overlay.dest)).text()).toBe(
			"if (interactive()) btw::btw_mcp_session()",
		);
	} finally {
		await Bun.spawn(["rm", "-rf", dir]).exited;
	}
});

// ### Test: agents-md-overlay-states-real-home
// EM: Now that the sandbox's $HOME is the real host $HOME (no more separate
// EM: /home/scoder namespace), there's only one spelling to state — this
// EM: guards that the overlay says so, and that no stray /home/scoder
// EM: reference survives from the old wording. The stdio-vs-localhost MCP
// EM: transport distinction (sandboxed stdio server needs sandbox paths;
// EM: localhost-HTTP server running outside the sandbox needs the real host
// EM: path — still the same path now, but the distinction is about *where
// EM: the server runs*, not about two different path spellings) is still
// EM: worth its own line and still checked here. Uses --dry-run (no pasta
// EM: needed) since the overlay file is written before the dry-run branch,
// EM: same timing agentports's own auto-detect-skips-under-dry-run test
// EM: relies on.
test("agents-md-overlay-states-real-home: overlay states $HOME is the real host home, no /home/scoder reference", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	let overlayPath: string | undefined;

	try {
		// EM: SCODER_KEEP_SESSION_TMP because this test reads the staged
		// EM: overlay back off disk after scoder has exited, and --dry-run
		// EM: now clears its session root on the way out.
		const output = await runScoder(
			repoDir,
			["--dry-run", "--no-worktree", "/bin/bash"],
			{ SCODER_KEEP_SESSION_TMP: "1" },
		);

		const match = output.match(
			/--ro-bind (\/tmp\/scoder-[0-9a-f]{8}\/\S+) \S+\/AGENTS\.md/,
		);
		overlayPath = match?.[1];
		expect(overlayPath).toBeDefined();

		const content = await Bun.file(overlayPath ?? "").text();
		const realHome = process.env.HOME;
		expect(realHome).toBeTruthy();

		expect(content).toContain(
			`Your \`$HOME\` is \`${realHome}\`, the real host home directory`,
		);
		expect(content).not.toContain("/home/scoder");

		// EM: The overlay must not describe paths as differing inside and
		// EM: outside, because they do not — path-mirroring gives one path
		// EM: space. It did say so once, truthfully, back when the sandbox
		// EM: remapped $HOME; the wording outlived the behaviour and was
		// EM: reported as confusing. Asserted as a negative because that is
		// EM: the kind of claim that creeps back in.
		expect(content).not.toContain("sandbox paths");

		// Loosely, not word-for-word: only pins down that the distinction is
		// present at all (stdio MCP servers run inside the sandbox and need
		// sandbox paths; localhost-HTTP ones run outside and need the real
		// host path) — an earlier draft of this wording didn't have it, and
		// treated every MCP server as if it ran outside the sandbox, which
		// is wrong for the stdio case.
		expect(content).toContain("stdio");
		expect(content.toLowerCase()).toContain("localhost");
	} finally {
		if (overlayPath) {
			await removeSessionRoot(overlayPath);
		}
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

// EM: ### Tests for `.sandbox/ports`
// EM: See design/implementation/plans/agentports.md. Replaces the old
// EM: --llm-port flag entirely — llm-port-auto-detect and
// EM: llm-port-allows-host-loopback lived here before; their functional
// EM: coverage now lives in sandbox-ports-auto-detect-appends and
// EM: sandbox-ports-forwards-listed-port below.

// ### Test: llm-port-flag-removed
test("llm-port-flag-removed: --llm-port is an unknown option", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const proc = Bun.spawn([SCODER_PATH, "--llm-port", "8080", "/bin/bash"], {
			env: process.env,
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		expect(proc.exitCode).not.toBe(0);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain("unknown option: --llm-port");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-ports-forwards-listed-port
test("sandbox-ports-forwards-listed-port: a port listed in .sandbox/ports is reachable without any flag", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	const server = Bun.serve({
		port: 19998,
		fetch() {
			return new Response("OK");
		},
	});
	testServers.push(server);

	try {
		await Bun.write(`${repoDir}/.sandbox/ports`, "19998\n");

		const proc = Bun.spawn(
			[
				SCODER_PATH,
				"-q",
				"/bin/bash",
				"-c",
				"curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:19998",
			],
			{
				env: process.env,
				cwd: repoDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		await proc.exited;

		expect(proc.exitCode).toBe(0);
		const output = await new Response(proc.stdout).text();
		expect(output.trim()).toBe("200");
	} finally {
		await cleanupRepo(repoDir);
		server.stop();
	}
});

// ### Test: sandbox-ports-malformed-line-fails
test("sandbox-ports-malformed-line-fails: a non-numeric line exits 1 naming the bad line", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		await Bun.write(`${repoDir}/.sandbox/ports`, "11434\nnotaport\n");

		const proc = Bun.spawn([SCODER_PATH, "--dry-run", "/bin/bash"], {
			env: process.env,
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		expect(proc.exitCode).not.toBe(0);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain('.sandbox/ports has an invalid line: "notaport"');
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-ports-is-readonly
test("sandbox-ports-is-readonly: --dry-run shows a ro-bind for .sandbox/ports, not a bind", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		await Bun.write(`${repoDir}/.sandbox/ports`, "8080\n");

		const output = await runScoder(repoDir, ["--dry-run", "/bin/bash"]);
		// EM: repoDir (under TEST_BASE, "/tmp/scoder-test-repos") is not under
		// EM: $HOME, so it's mirrored unchanged at its own real path — no
		// EM: sandbox-home prefix, now that $HOME isn't a separate namespace.
		expect(output).toContain(
			`--ro-bind ${repoDir}/.sandbox ${repoDir}/.sandbox`,
		);
		expect(output).not.toContain(
			`--bind ${repoDir}/.sandbox/ports ${repoDir}/.sandbox/ports`,
		);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-ports-auto-detect-appends
test("sandbox-ports-auto-detect-appends: an auto-detected port is written to .sandbox/ports, once", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const testPort = 19997;

	const server = await Bun.serve({
		port: testPort,
		fetch() {
			return new Response("auto-detected-ok");
		},
	});
	testServers.push(server);

	try {
		const first = await Bun.spawn(
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
				env: { ...process.env, SCODER_LLM_PORT: testPort.toString() },
			},
		);
		await first.exited;

		expect(first.exitCode).toBe(0);
		const output = await new Response(first.stdout).text();
		expect(output.trim()).toBe("auto-detected-ok");

		const afterFirst = await Bun.file(`${repoDir}/.sandbox/ports`).text();
		expect(afterFirst.trim()).toBe(testPort.toString());

		// Second run: the port is already listed, so it must not duplicate.
		const second = await Bun.spawn(
			[SCODER_PATH, "-q", "/bin/bash", "-c", "true"],
			{
				cwd: repoDir,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, SCODER_LLM_PORT: testPort.toString() },
			},
		);
		await second.exited;
		expect(second.exitCode).toBe(0);

		const afterSecond = await Bun.file(`${repoDir}/.sandbox/ports`).text();
		expect(afterSecond.trim()).toBe(testPort.toString());
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-ports-auto-detect-skips-under-dry-run
test("sandbox-ports-auto-detect-skips-under-dry-run: --dry-run with a detectable port does not write .sandbox/ports", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const testPort = 19996;

	const server = await Bun.serve({
		port: testPort,
		fetch() {
			return new Response("ok");
		},
	});
	testServers.push(server);

	try {
		const proc = Bun.spawn([SCODER_PATH, "--dry-run", "/bin/bash"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, SCODER_LLM_PORT: testPort.toString() },
		});
		await proc.exited;
		expect(proc.exitCode).toBe(0);

		expect(await fileExists(`${repoDir}/.sandbox/ports`)).toBe(false);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-ports-not-created-under-dry-run
test("sandbox-ports-not-created-under-dry-run: --dry-run with no .sandbox/ports does not create one", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const output = await runScoder(repoDir, ["--dry-run", "/bin/bash"]);
		expect(output).not.toContain(".sandbox/ports");
		expect(await fileExists(`${repoDir}/.sandbox/ports`)).toBe(false);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// EM: ### Test for the missing-.sandbox/ports escape
// EM: A missing source path gets no bind mount at all, which otherwise
// EM: leaves that path part of the regular read-write project bind — letting
// EM: the sandboxed agent create .sandbox/ports itself, with whatever ports it
// EM: likes, unprotected, from that point on.

// ### Test: sandbox-ports-created-if-missing
test("sandbox-ports-created-if-missing: a real session creates .sandbox/ports with a header comment", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const proc = Bun.spawn([SCODER_PATH, "-q", "/bin/bash", "-c", "true"], {
			env: process.env,
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		// The session itself may still fail later (pasta attaching), but the
		// file is created before that point is ever reached.
		const content = await Bun.file(`${repoDir}/.sandbox/ports`).text();
		expect(content).toContain("# .sandbox/ports");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-ports-missing-file-not-writable-from-sandbox
test("sandbox-ports-missing-file-not-writable-from-sandbox: a session with no pre-existing .sandbox/ports still protects it read-only", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const proc = Bun.spawn(
			[SCODER_PATH, "-q", "/bin/bash", "-c", "echo 1234 > .sandbox/ports"],
			{
				env: process.env,
				cwd: repoDir,
				stdout: "pipe",
				stderr: "pipe",
			},
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

		const content = await Bun.file(`${repoDir}/.sandbox/ports`).text();
		expect(content).not.toContain("1234");
		expect(content).toContain("# .sandbox/ports");
	} finally {
		await cleanupRepo(repoDir);
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

// ### Test: pasta-ipv6-routability-failure-detected-for-retry
// Regression test: reported directly, pasta refused to attach at all
// ("No routable interface for IPv6: IPv6 is disabled" / "Couldn't switch
// to pasta namespaces: ...") on a host with IPv6 unavailable.
// --config-net's own dual-stack auto-detection apparently treats IPv6
// being unavailable as fatal rather than something to skip gracefully.
//
// isIpv6RoutabilityFailure (src/sandbox/pasta.ts) detects this exact
// failure from pasta's own stderr so attachPasta can retry once with
// --ipv4-only — deliberately not predicted ahead of time by reading a
// sysctl (net.ipv6.conf.all.disable_ipv6, tried first): that missed a
// real case reported directly, where IPv6 was disabled via the
// ipv6.disable=1 kernel boot parameter rather than the per-sysctl
// toggle, so /proc/sys/net/ipv6 doesn't exist at all and the sysctl read
// silently (and wrongly) reported "not disabled". Trusting pasta's own
// authoritative determination, after the fact, covers every route to
// this failure without needing to enumerate them.
test("pasta-ipv6-routability-failure-detected-for-retry: matches pasta's real error text, not unrelated failures", () => {
	expect(
		isIpv6RoutabilityFailure(
			"pasta: No routable interface for IPv6: IPv6 is disabled\nCouldn't switch to pasta namespaces: No child processes",
		),
	).toBe(true);
	expect(
		isIpv6RoutabilityFailure(
			"Failed to open() /dev/net/tun: No such file or directory",
		),
	).toBe(false);
	expect(isIpv6RoutabilityFailure("")).toBe(false);
});

// ### Test: dry-run-redacts-sensitive-env-vars
// Regression test: reported directly, --dry-run's own preview printed
// several real API keys/tokens in cleartext (COPILOT_GITHUB_TOKEN,
// DEEPSEEK_API_KEY, and others from builder.ts's passThrough list),
// pasted directly into a chat log by a user who had no reason to expect
// a *preview* to expose live secrets. printBwrapCommand (src/index.ts)
// now redacts any --setenv value whose name matches a substring
// heuristic (token/key/secret/password/credential, case-insensitive) —
// deliberately a heuristic, not an exact match against passThrough's
// own list, so a newly added provider env var is covered automatically
// rather than needing a second, separately-maintained list here.
test("dry-run-redacts-sensitive-env-vars: real secret values never appear in the preview", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		// EM: Passthrough is now whatever .sandbox/env lists, and the shipped
		// EM: default comments the API keys out, so the test names its own.
		await Bun.write(
			`${repoDir}/.sandbox/env`,
			"DEEPSEEK_API_KEY\nGITHUB_TOKEN\nEDITOR\n",
		);
		const output = await runScoder(repoDir, ["--dry-run", "-q", "/bin/bash"], {
			DEEPSEEK_API_KEY: "sk-should-not-appear",
			GITHUB_TOKEN: "ghp-should-not-appear",
			EDITOR: "should-still-appear",
		});

		expect(output).not.toContain("sk-should-not-appear");
		expect(output).not.toContain("ghp-should-not-appear");
		expect(output).toContain("--setenv DEEPSEEK_API_KEY <redacted>");
		expect(output).toContain("--setenv GITHUB_TOKEN <redacted>");
		expect(output).toContain("--setenv EDITOR should-still-appear");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: env-file-controls-passthrough
// EM: .sandbox/env replaces builder.ts's old hardcoded list: a name passes
// EM: through only if it is listed and set on the host. Commented names and
// EM: unlisted ones do not; a line that is not a variable name is warned
// EM: about and skipped, not fatal.
test("env-file-controls-passthrough: only names listed in .sandbox/env reach the sandbox, and a bad line is skipped with a warning", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		await Bun.write(
			`${repoDir}/.sandbox/env`,
			"# comment\nSCODER_T_LISTED\n# SCODER_T_COMMENTED\nSCODER_T_TRAILING # why\nnot a name\n",
		);
		const run = await runScoderRaw(repoDir, ["--dry-run", "/bin/bash"], {
			SCODER_T_LISTED: "v1",
			SCODER_T_TRAILING: "v2",
			SCODER_T_COMMENTED: "no",
			SCODER_T_UNLISTED: "no",
		});
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("--setenv SCODER_T_LISTED v1");
		expect(run.stdout).toContain("--setenv SCODER_T_TRAILING v2");
		expect(run.stdout).not.toContain("SCODER_T_COMMENTED");
		expect(run.stdout).not.toContain("SCODER_T_UNLISTED");
		expect(run.stderr).toContain('ignoring "not a name"');
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: user-config-seeds-project-sandbox-dir
// EM: The two-level copy: shipped defaults -> ~/.config/scoder (only the
// EM: files missing there) -> .sandbox/ (only the files missing there).
// EM: Nothing is ever overwritten at either level. In-process, with
// EM: XDG_CONFIG_HOME pointed at a fresh directory for this test alone.
test("user-config-seeds-project-sandbox-dir: defaults fill ~/.config/scoder, which fills .sandbox/, and neither level overwrites an existing file", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const savedXdg = process.env.XDG_CONFIG_HOME;
	const xdg = `${TEST_BASE}/xdg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

	try {
		process.env.XDG_CONFIG_HOME = xdg;
		const userDir = userConfigDir();
		expect(userDir).toBe(`${xdg}/scoder`);
		await Bun.write(`${userDir}/env`, "MY_OWN_VAR\n");
		await Bun.write(`${userDir}/extra-note`, "copied too\n");
		await Bun.write(`${repoDir}/.sandbox/ports`, "# project's own\n8080\n");

		await prepareConfigDir(repoDir);

		// User level: the edited file kept, the missing ones written from
		// the shipped defaults (byte-identical to src/defaults/).
		expect(await Bun.file(`${userDir}/env`).text()).toBe("MY_OWN_VAR\n");
		for (const name of ["README.md", "readonly", "readwrite", "ports"]) {
			expect(await Bun.file(`${userDir}/${name}`).text()).toBe(
				await Bun.file(`${import.meta.dir}/../src/defaults/${name}`).text(),
			);
		}
		// Project level: every user file the project lacked, the user's own
		// edits included; the project's existing file untouched.
		expect(await Bun.file(`${repoDir}/.sandbox/env`).text()).toBe(
			"MY_OWN_VAR\n",
		);
		expect(await Bun.file(`${repoDir}/.sandbox/extra-note`).text()).toBe(
			"copied too\n",
		);
		expect(await Bun.file(`${repoDir}/.sandbox/ports`).text()).toBe(
			"# project's own\n8080\n",
		);
		expect(await Bun.file(`${repoDir}/.sandbox/readonly`).text()).toBe(
			await Bun.file(`${userDir}/readonly`).text(),
		);

		// A later user-level edit does not reach a project that already has
		// the file: the project's copy is the one in force.
		await Bun.write(`${userDir}/env`, "CHANGED_LATER\n");
		await prepareConfigDir(repoDir);
		expect(await Bun.file(`${repoDir}/.sandbox/env`).text()).toBe(
			"MY_OWN_VAR\n",
		);
	} finally {
		process.env.XDG_CONFIG_HOME = savedXdg;
		await Bun.spawn(["rm", "-rf", xdg]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: user-config-dry-run-writes-nothing-but-previews-it
// EM: --dry-run writes no configuration at either level, yet previews what
// EM: a real run would apply: with no .sandbox/env yet, the user's env
// EM: list decides the passthrough.
test("user-config-dry-run-writes-nothing-but-previews-it: --dry-run creates no config files and still uses the user's env list", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const xdg = `${TEST_BASE}/xdg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

	try {
		await Bun.write(`${xdg}/scoder/env`, "SCODER_T_FROM_USER\n");
		const run = await runScoderRaw(repoDir, ["--dry-run", "/bin/bash"], {
			XDG_CONFIG_HOME: xdg,
			SCODER_T_FROM_USER: "u1",
		});
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("--setenv SCODER_T_FROM_USER u1");
		expect(readdirSync(`${xdg}/scoder`)).toEqual(["env"]);
		for (const name of ["env", "readonly", "readwrite", "ports"]) {
			expect(await fileExists(`${repoDir}/.sandbox/${name}`)).toBe(false);
		}
	} finally {
		await Bun.spawn(["rm", "-rf", xdg]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: env-flag-sets-value-in-sandbox-only
// EM: --env NAME=VALUE sets NAME for this session's sandbox: split at the
// EM: first "=" (so values may contain "=" or be empty), pushed after the
// EM: .sandbox/env passthrough so bwrap's last-wins --setenv makes it win,
// EM: warned about only when it overrides a variable scoder sets itself,
// EM: and still redacted in the --dry-run preview when the name looks secret.
test("env-flag-sets-value-in-sandbox-only: --env values reach the sandbox, win over the passthrough, and warn only when overriding scoder's own", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		// MY_SETTING, not MY_KEY: a name containing "key" is redacted in
		// the preview, which would hide the values compared here.
		await Bun.write(`${repoDir}/.sandbox/env`, "MY_SETTING\n");
		const run = await runScoderRaw(
			repoDir,
			[
				"--dry-run",
				"--env",
				"MY_SETTING=xyz",
				"--env=URLISH=a=b=c",
				"--env",
				"EMPTY_ONE=",
				"--env",
				"MY_API_KEY=sekrit-value",
				"--env",
				"HOME=/elsewhere",
				"/bin/bash",
			],
			{ MY_SETTING: "from-host" },
		);
		expect(run.code).toBe(0);
		const flat = flattenDryRun(run.stdout);
		const passed = flat.indexOf("--setenv MY_SETTING from-host");
		const oneOff = flat.indexOf("--setenv MY_SETTING xyz");
		expect(passed).toBeGreaterThan(-1);
		expect(oneOff).toBeGreaterThan(passed);
		expect(flat).toContain("--setenv URLISH a=b=c");
		expect(flat).toMatch(/--setenv EMPTY_ONE\s/);
		expect(flat).toContain("--setenv MY_API_KEY <redacted>");
		expect(flat).not.toContain("sekrit-value");
		expect(flat.lastIndexOf("--setenv HOME /elsewhere")).toBeGreaterThan(
			flat.lastIndexOf(`--setenv HOME ${SANDBOX_HOME}`),
		);
		expect(run.stderr).toContain(
			"--env HOME overrides the value scoder sets itself",
		);
		expect(run.stderr).not.toContain("--env MY_SETTING overrides");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: env-flag-cannot-override-entrypoint-interface
// EM: The entry point's variables (HARNESS_ARGC, IDE_ARGC, ...) are its
// EM: internal interface, pushed after --env so a typed value can never
// EM: break a companion-IDE launch: the last --setenv for each is scoder's.
test("env-flag-cannot-override-entrypoint-interface: the entry point's own variables are set after --env, so they win", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");
	const rstudioDir = await createFakeToolDir("rstudio");

	try {
		const run = await runScoderRaw(
			repoDir,
			[
				"--dry-run",
				"--no-worktree",
				"--env",
				"IDE_ARGC=99",
				"pi",
				"--ide",
				"rstudio",
			],
			{ PATH: `${piDir}:${rstudioDir}:${process.env.PATH}` },
		);
		expect(run.code).toBe(0);
		const flat = flattenDryRun(run.stdout);
		const settings = [...flat.matchAll(/--setenv IDE_ARGC (\S+)/g)].map(
			(m) => m[1],
		);
		expect(settings[0]).toBe("99");
		expect(settings.at(-1)).not.toBe("99");
	} finally {
		await Bun.spawn(["rm", "-rf", piDir, rstudioDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: env-flag-rejects-malformed-and-stays-out-of-tool-argv
// EM: A malformed spec is an error naming the expected shape, not a silent
// EM: no-op. After the tool name --env is the tool's own argument, as with
// EM: --allow-ssh: `docker run --env` and friends must keep working.
test("env-flag-rejects-malformed-and-stays-out-of-tool-argv: bad --env specs fail clearly, and after the tool name --env is the tool's", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");
	const env = { PATH: `${piDir}:${process.env.PATH}` };

	try {
		for (const bad of [
			["--env", "NOEQUALS"],
			["--env", "1BAD=x"],
			["--env", "=x"],
			["--env"],
		]) {
			const run = await runScoderRaw(
				repoDir,
				["--dry-run", ...bad, ...(bad.length === 1 ? [] : ["pi"])],
				env,
			);
			expect(run.code).not.toBe(0);
			expect(run.stderr).toContain("--env must be NAME=VALUE");
		}

		const after = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "pi", "--env", "FOO=bar"],
			env,
		);
		expect(after.code).toBe(0);
		const flat = flattenDryRun(after.stdout);
		expect(flat).not.toContain("--setenv FOO");
		expect(flat).toMatch(new RegExp(`-- ${piDir}/pi\\s+--env FOO=bar\n`));
	} finally {
		await Bun.spawn(["rm", "-rf", piDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: browser-mimeapps-web-defaults-rewritten
// EM: The staged mimeapps.list is the host's, with only the web types'
// EM: defaults pointed at scoder's browser entry: xdg-open consults these
// EM: before $BROWSER, so leaving the host's in place would launch the host
// EM: default without SCODER_BROWSER's flags. Every other line survives.
test("browser-mimeapps-web-defaults-rewritten: web defaults replaced, other associations and sections kept, section added when missing", () => {
	const host = [
		"[Default Applications]",
		"x-scheme-handler/https=google-chrome.desktop",
		"text/plain=gedit.desktop",
		"text/html=firefox.desktop",
		"",
		"[Added Associations]",
		"x-scheme-handler/https=firefox.desktop;",
		"",
	].join("\n");
	const out = withWebDefaults(host, "scoder-browser.desktop");
	expect(out).toContain("x-scheme-handler/http=scoder-browser.desktop");
	expect(out).toContain("x-scheme-handler/https=scoder-browser.desktop");
	expect(out).toContain("text/html=scoder-browser.desktop");
	expect(out).toContain("text/plain=gedit.desktop");
	expect(out).not.toContain("google-chrome.desktop");
	expect(out).not.toContain("text/html=firefox.desktop");
	// Added Associations is not where defaults live: left alone.
	expect(out).toContain(
		"[Added Associations]\nx-scheme-handler/https=firefox.desktop;",
	);

	const fresh = withWebDefaults("", "scoder-browser.desktop");
	expect(fresh).toContain("[Default Applications]");
	expect(fresh).toContain("x-scheme-handler/https=scoder-browser.desktop");
});

// ### Test: browser-env-stages-wrapper-and-binds
// EM: SCODER_BROWSER in a dry-run: BROWSER points at the wrapper, the
// EM: wrapper, desktop entry and staged mimeapps.list are bound, and the
// EM: mimeapps bind comes after the host's own so it is the one mounted.
// EM: Unset, nothing of it appears.
test("browser-env-stages-wrapper-and-binds: SCODER_BROWSER sets BROWSER and binds the wrapper and a mimeapps.list over the host's", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeHome = `/tmp/scoder-brw-home-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const kept: string[] = [];

	try {
		await Bun.write(
			`${fakeHome}/.config/mimeapps.list`,
			"[Default Applications]\n",
		);
		const run = await runScoderRaw(repoDir, ["--dry-run", "/bin/bash"], {
			HOME: fakeHome,
			SCODER_BROWSER: "sh --incognito",
			SCODER_KEEP_SESSION_TMP: "1",
		});
		expect(run.code).toBe(0);
		const flat = flattenDryRun(run.stdout);
		expect(flat).toContain("--setenv BROWSER /tmp/scoder-browser");
		const wrapper = flat.match(
			/--ro-bind (\/tmp\/scoder-[0-9a-f]{8}\/tmp\/scoder-browser) \/tmp\/scoder-browser/,
		);
		expect(wrapper).not.toBeNull();
		kept.push(wrapper![1]);
		expect(await Bun.file(wrapper![1]).text()).toBe(
			"#!/bin/sh\nexec 'sh' '--incognito' \"$@\"\n",
		);
		expect(flat).toContain(
			`${fakeHome}/.local/share/applications/scoder-browser.desktop`,
		);
		const mimeDest = `${fakeHome}/.config/mimeapps.list`;
		const hostBind = flat.indexOf(`--ro-bind ${mimeDest} ${mimeDest}`);
		const ours = flat.search(
			new RegExp(`--ro-bind /tmp/scoder-[0-9a-f]{8}${mimeDest} ${mimeDest}`),
		);
		expect(hostBind).toBeGreaterThan(-1);
		expect(ours).toBeGreaterThan(hostBind);

		const unset = await runScoder(repoDir, ["--dry-run", "/bin/bash"], {
			HOME: fakeHome,
		});
		expect(unset).not.toContain("scoder-browser");
		expect(unset).not.toContain("--setenv BROWSER");
	} finally {
		for (const path of kept) {
			await removeSessionRoot(path);
		}
		await Bun.spawn(["rm", "-rf", fakeHome]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: dev-console-is-dev-null
// EM: bwrap's --dev binds the host terminal at /dev/console when stdout is
// EM: a tty, and syslog(LOG_CONS) falls back to /dev/console with no
// EM: /dev/log — which is how RStudio's rsession errors reached pi's
// EM: terminal (measured: python's syslog with LOG_CONS under bwrap printed
// EM: `ident[pid]: msg` to the pty; with this bind, nothing). The bind must
// EM: follow the inner layer's --dev-bind /dev /dev, or that remounts over it.
test("dev-console-is-dev-null: /dev/console inside the sandbox is /dev/null, bound after /dev itself", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const flat = flattenDryRun(
			await runScoder(repoDir, ["--dry-run", "/bin/bash"]),
		);
		const devBind = flat.indexOf("--dev-bind /dev /dev");
		const consoleBind = flat.indexOf("--dev-bind /dev/null /dev/console");
		expect(devBind).toBeGreaterThan(-1);
		expect(consoleBind).toBeGreaterThan(devBind);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: scoder-skill-injected-into-agents-snapshot
// EM: The skill used to be fetched by the agent with `npx skills add`, which
// EM: cannot work inside: ~/.agents is a read-only snapshot. scoder now adds
// EM: its own copy to the snapshot — even when the host has no ~/.agents —
// EM: unless the user installed one, which wins. The host is never written.
test("scoder-skill-injected-into-agents-snapshot: the bundled skill is added to the ~/.agents snapshot unless the user has their own", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const bundled = await Bun.file(
		`${import.meta.dir}/../skills/working-in-a-scoder-sandbox/SKILL.md`,
	).text();
	const homes: string[] = [];
	const kept: string[] = [];
	const snapshotSkill = (flat: string, home: string) => {
		const m = flat.match(
			new RegExp(
				`--ro-bind (/tmp/scoder-[0-9a-f]{8}${home}/\\.agents) ${home}/\\.agents`,
			),
		);
		expect(m).not.toBeNull();
		kept.push(m![1]);
		return `${m![1]}/skills/working-in-a-scoder-sandbox/SKILL.md`;
	};

	try {
		// No ~/.agents on the host at all.
		const bare = `/tmp/scoder-skillhome-${Date.now()}-a`;
		homes.push(bare);
		await Bun.write(`${bare}/.placeholder`, "");
		const run1 = await runScoderRaw(repoDir, ["--dry-run", "/bin/bash"], {
			HOME: bare,
			SCODER_KEEP_SESSION_TMP: "1",
		});
		expect(run1.code).toBe(0);
		expect(
			await Bun.file(snapshotSkill(flattenDryRun(run1.stdout), bare)).text(),
		).toBe(bundled);
		expect(await dirExists(`${bare}/.agents`)).toBe(false);

		// The user's own copy wins.
		const own = `/tmp/scoder-skillhome-${Date.now()}-b`;
		homes.push(own);
		await Bun.write(
			`${own}/.agents/skills/working-in-a-scoder-sandbox/SKILL.md`,
			"mine",
		);
		const run2 = await runScoderRaw(repoDir, ["--dry-run", "/bin/bash"], {
			HOME: own,
			SCODER_KEEP_SESSION_TMP: "1",
		});
		expect(
			await Bun.file(snapshotSkill(flattenDryRun(run2.stdout), own)).text(),
		).toBe("mine");
	} finally {
		for (const path of kept) await removeSessionRoot(path);
		await Bun.spawn(["rm", "-rf", ...homes]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: scoder-skill-bound-for-claude-code
// EM: Claude Code reads ~/.claude/skills, bound read-write from the host, so
// EM: the skill is a staged copy bound read-only over it — after the
// EM: ~/.claude bind, or that would cover it — and skipped when the user's
// EM: own SKILL.md is there. (An empty leftover mountpoint is not "own".)
test("scoder-skill-bound-for-claude-code: claude sessions get the skill bound over ~/.claude/skills unless the user has their own", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const claudeBin = await createFakeToolDir("claude");
	const home = `/tmp/scoder-claudeskill-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const dest = `${home}/.claude/skills/working-in-a-scoder-sandbox`;
	const env = { PATH: `${claudeBin}:${process.env.PATH}`, HOME: home };

	try {
		await Bun.write(`${home}/.claude/settings.json`, "{}");
		// A leftover empty mountpoint from an earlier session.
		await Bun.spawn(["mkdir", "-p", dest]).exited;
		const flat = flattenDryRun(
			await runScoder(repoDir, ["--dry-run", "--no-worktree", "claude"], env),
		);
		const claudeBind = flat.indexOf(`--bind ${home}/.claude ${home}/.claude`);
		const skillBind = flat.search(
			new RegExp(`--ro-bind /tmp/scoder-[0-9a-f]{8}${dest} ${dest}`),
		);
		expect(claudeBind).toBeGreaterThan(-1);
		expect(skillBind).toBeGreaterThan(claudeBind);

		await Bun.write(`${dest}/SKILL.md`, "mine");
		const own = flattenDryRun(
			await runScoder(repoDir, ["--dry-run", "--no-worktree", "claude"], env),
		);
		expect(own).not.toMatch(new RegExp(`--ro-bind \\S+ ${dest}`));

		// A symlinked ~/.claude/skills (commonly to ~/.agents/skills): no
		// bind. Reported: bwrap could not make the mountpoint through it, so
		// the session failed to launch.
		await Bun.spawn(["rm", "-rf", `${home}/.claude/skills`]).exited;
		await Bun.write(`${home}/.agents/skills/.keep`, "");
		await Bun.spawn([
			"ln",
			"-s",
			`${home}/.agents/skills`,
			`${home}/.claude/skills`,
		]).exited;
		const linked = flattenDryRun(
			await runScoder(repoDir, ["--dry-run", "--no-worktree", "claude"], env),
		);
		expect(linked).not.toMatch(new RegExp(`--ro-bind \\S+ ${dest}`));
	} finally {
		await Bun.spawn(["rm", "-rf", home, claudeBin]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: agents-md-overlay-names-companion-ide
// EM: With --ide, the AGENTS.md overlay tells the agent which IDE is beside
// EM: it and to offer an MCP connection once; without --ide it says nothing
// EM: of the sort. The overlay no longer tells the agent to `npx skills add`.
test("agents-md-overlay-names-companion-ide: --ide adds the MCP offer line naming the IDE; no --ide, no line", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");
	const rstudioDir = await createFakeToolDir("rstudio");
	const env = {
		PATH: `${piDir}:${rstudioDir}:${process.env.PATH}`,
		SCODER_KEEP_SESSION_TMP: "1",
	};
	const kept: string[] = [];
	const overlayText = async (stdout: string) => {
		const m = flattenDryRun(stdout).match(
			new RegExp(
				`--ro-bind (/tmp/scoder-[0-9a-f]{8}${repoDir}/AGENTS\\.md) ${repoDir}/AGENTS\\.md`,
			),
		);
		expect(m).not.toBeNull();
		kept.push(m![1]);
		return Bun.file(m![1]).text();
	};

	try {
		const withIde = await overlayText(
			(
				await runScoderRaw(
					repoDir,
					["--dry-run", "--no-worktree", "pi", "--ide", "rstudio"],
					env,
				)
			).stdout,
		);
		expect(withIde).toContain(
			"The user has launched RStudio Desktop alongside you",
		);
		expect(withIde).toContain("`--ide rstudio`");
		expect(withIde).not.toContain("npx skills add");

		const without = await overlayText(
			(await runScoderRaw(repoDir, ["--dry-run", "--no-worktree", "pi"], env))
				.stdout,
		);
		expect(without).not.toContain("alongside you");
		expect(without).toContain("working-in-a-scoder-sandbox");
	} finally {
		for (const path of kept) await removeSessionRoot(path);
		await Bun.spawn(["rm", "-rf", piDir, rstudioDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: llm-probe-requires-openai-models-list
// EM: The extra probe ports (11435) are forwarded only when they answer
// EM: GET /v1/models like an OpenAI-compatible server — an open port alone
// EM: is too weak a sign off Ollama's own 11434. Anything else, including a
// EM: listener that never answers, is a no.
test("llm-probe-requires-openai-models-list: /v1/models must return 200 with a data array; anything else, or no answer, is rejected", async () => {
	const serve = (handler: (req: Request) => Response | Promise<Response>) =>
		Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
	const ok = serve(() =>
		Response.json({ object: "list", data: [{ id: "m" }] }),
	);
	const html = serve(() => new Response("<html>hi</html>"));
	const noData = serve(() => Response.json({ models: [] }));
	const unauthorized = serve(() => new Response("no", { status: 401 }));
	const hang = serve(() => new Promise<Response>(() => {}));
	const servers = [ok, html, noData, unauthorized, hang];

	try {
		expect(await servesOpenAiModels(ok.port)).toBe(true);
		expect(await servesOpenAiModels(html.port)).toBe(false);
		expect(await servesOpenAiModels(noData.port)).toBe(false);
		expect(await servesOpenAiModels(unauthorized.port)).toBe(false);
		const closed = serve(() => new Response(""));
		const closedPort = closed.port;
		closed.stop(true);
		expect(await servesOpenAiModels(closedPort)).toBe(false);
		const started = Date.now();
		expect(await servesOpenAiModels(hang.port)).toBe(false);
		expect(Date.now() - started).toBeLessThan(3000);
	} finally {
		for (const server of servers) server.stop(true);
	}
});

// ### Test: env-wildcards-expand-and-exclude
// EM: `*` in .sandbox/env expands against the host environment. A pattern
// EM: adds names, never the excluded ones (display, bus, ssh agent, PATH,
// EM: HOME, LD_*, SCODER_*) nor ones scoder already set — naming one of those
// EM: exactly still works. A bare `*` is refused: it would pass everything.
test("env-wildcards-expand-and-exclude: PI_* and *_API_KEY expand; excluded and scoder-set names are never matched; bare * refused", () => {
	const env = {
		PI_FOO: "1",
		PI_BAR: "2",
		PI_SET_BY_SCODER: "3",
		MY_API_KEY: "k",
		XDG_DATA_DIRS: "/usr/share",
		XDG_RUNTIME_DIR: "/run/user/1",
		DBUS_SESSION_BUS_ADDRESS: "unix:path=/x",
		SCODER_LLM_PORT: "1",
		LD_PRELOAD: "evil.so",
		SHELL: "/bin/bash",
		HOME: "/home/u",
	};
	const { names, matches } = expandEnvNames(
		["EDITOR", "PI_*", "*_API_KEY", "XDG_*", "*_ADDRESS", "S*", "LD_*", "HOME"],
		env,
		new Set(["PI_SET_BY_SCODER"]),
	);
	expect(names).toEqual([
		"EDITOR",
		"PI_BAR",
		"PI_FOO",
		"MY_API_KEY",
		"XDG_DATA_DIRS",
		"HOME",
	]);
	expect(matches.get("PI_*")).toEqual(["PI_BAR", "PI_FOO"]);
	expect(matches.get("*_ADDRESS")).toEqual([]);
	expect(matches.get("S*")).toEqual([]);
	expect(matches.get("LD_*")).toEqual([]);

	const parsed = parseEnvNames("PI_*\n*\n**\nPI-*\n*_TOKEN\n", "test env");
	expect(parsed).toEqual(["PI_*", "*_TOKEN"]);
});

// ### Test: env-wildcards-in-session
// EM: The user-facing shape: PI_* in .sandbox/env passes every PI_ variable
// EM: on the host, and start-up names what each pattern matched.
test("env-wildcards-in-session: a PI_* line passes the host's PI_ variables and reports them", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		await Bun.write(`${repoDir}/.sandbox/env`, "PI_*\nNOTHING_MATCHES_*\n");
		const run = await runScoderRaw(repoDir, ["--dry-run", "/bin/bash"], {
			PI_ALPHA: "a1",
			PI_BETA: "b2",
		});
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("--setenv PI_ALPHA a1");
		expect(run.stdout).toContain("--setenv PI_BETA b2");
		expect(run.stderr).toContain(".sandbox/env PI_* passes PI_ALPHA, PI_BETA");
		expect(run.stderr).toContain(
			".sandbox/env NOTHING_MATCHES_* matches nothing set on this host",
		);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: terminal-restored-after-exit
// EM: After the sandbox exits, a real terminal is put back: alternate screen
// EM: left, cursor shown, mouse and bracketed paste off, attributes reset,
// EM: screen cleared without touching scrollback (ESC[2J, not ESC[3J) — and
// EM: nothing at all is written to a pipe, or with SCODER_KEEP_SCREEN set.
test("terminal-restored-after-exit: a tty gets the restore sequence and a scrollback-preserving clear; pipes and SCODER_KEEP_SCREEN get nothing", () => {
	const written: string[] = [];
	const tty = { isTTY: true, write: (c: string) => written.push(c) };
	const pipe = { isTTY: false, write: (c: string) => written.push(c) };

	expect(restoreTerminal(pipe, {})).toBe(false);
	expect(restoreTerminal(tty, { SCODER_KEEP_SCREEN: "1" })).toBe(false);
	expect(written).toEqual([]);

	expect(restoreTerminal(tty, {})).toBe(true);
	expect(written).toEqual([TERMINAL_RESTORE_SEQUENCE]);
	for (const seq of [
		"\x1b[?1049l",
		"\x1b[?25h",
		"\x1b[?2004l",
		"\x1b[H\x1b[2J",
	]) {
		expect(TERMINAL_RESTORE_SEQUENCE).toContain(seq);
	}
	expect(TERMINAL_RESTORE_SEQUENCE).not.toContain("\x1b[3J");
});

// ### Test: jupyterlab-preset-layout
// EM: JupyterLab runs inside the sandbox and opens SCODER_BROWSER's wrapper
// EM: itself; ~/.jupyter (host-executed config) is read-only; only kernels/
// EM: of the host data dir is bound, so host servers' runtime tokens and the
// EM: notebook-trust secret stay out — of the binds and of the one-time
// EM: seed; lab settings and data persist per project; a GUI primary's
// EM: output goes to the session log. Throwaway HOME.
test("jupyterlab-preset-layout: launch args, read-only config and kernels, per-project seeded state, host runtime and trust secret kept out", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const binDir = await createFakeToolDir("jupyter-lab");
	const home = `/tmp/scoder-jlhome-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const data = `${home}/.local/share/jupyter`;
	const managed = `${home}/.local/share/scoder-jupyterlab/${repoDir.slice(1)}`;
	const env = {
		PATH: `${binDir}:${process.env.PATH}`,
		HOME: home,
		SCODER_BROWSER: "sh --incognito",
	};

	try {
		await Bun.write(
			`${home}/.jupyter/jupyter_server_config.py`,
			"# host config\n",
		);
		await Bun.write(`${home}/.jupyter/lab/user-settings/theme.json`, "{}");
		await Bun.write(`${data}/kernels/py/kernel.json`, "{}");
		await Bun.write(`${data}/runtime/jpserver-1.json`, '{"token":"HOSTTOKEN"}');
		await Bun.write(`${data}/notebook_secret`, "HOSTSECRET");
		await Bun.write(`${data}/jupyter_ai/config.json`, '{"model":"m"}');

		const run = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "jupyterlab"],
			env,
		);
		expect(run.code).toBe(0);
		const flat = flattenDryRun(run.stdout);

		const args = flat.match(/--IdentityProvider\.token=([0-9a-f]{48})/);
		expect(args).not.toBeNull();
		expect(flat).toContain("--ip=127.0.0.1");
		expect(flat).toContain("--port=8888");
		expect(flat).toContain("--ServerApp.browser=/tmp/scoder-browser %s");
		expect(flat).toContain("--ServerApp.use_redirect_file=False");
		expect(flat).toContain("--setenv BROWSER /tmp/scoder-browser");

		expect(flat).toContain(`--ro-bind ${home}/.jupyter ${home}/.jupyter`);
		expect(flat).toContain(`--ro-bind ${data}/kernels ${data}/kernels`);
		expect(flat).toContain(`--bind ${managed} ${managed}`);
		expect(flat).not.toMatch(new RegExp(`--(ro-)?bind ${data} `));
		expect(flat).not.toContain("HOSTTOKEN");
		expect(flat).toContain(
			`--setenv JUPYTERLAB_SETTINGS_DIR ${managed}/settings`,
		);
		expect(flat).toContain(`--setenv JUPYTER_DATA_DIR ${managed}/data`);
		expect(flat).toContain(
			`--setenv JUPYTER_PATH ${home}/.local/share/jupyter`,
		);
		expect(flat).toContain("--setenv HARNESS_LOG /tmp/scoder-xpra.log");

		expect(await fileExists(`${managed}/settings/theme.json`)).toBe(true);
		expect(
			await Bun.file(`${managed}/data/jupyter_ai/config.json`).text(),
		).toBe('{"model":"m"}');
		expect(await dirExists(`${managed}/data/runtime`)).toBe(false);
		expect(await dirExists(`${managed}/data/kernels`)).toBe(false);
		expect(await fileExists(`${managed}/data/notebook_secret`)).toBe(false);

		const noBrowser = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "jupyterlab"],
			{
				...env,
				SCODER_BROWSER: "",
			},
		);
		expect(noBrowser.code).not.toBe(0);
		expect(noBrowser.stderr).toContain("needs SCODER_BROWSER");
	} finally {
		await Bun.spawn(["rm", "-rf", home, binDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: jupyterlab-companion-note-gives-url-and-token
// EM: With `--ide jupyterlab` beside an agent, the AGENTS.md note names the
// EM: server URL with the session's token (the same one Jupyter is started
// EM: with) and jupyter-ai's MCP endpoint, so the agent can set up MCP.
test("jupyterlab-companion-note-gives-url-and-token: AGENTS.md carries the server URL, the launch token and the MCP endpoint", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");
	const jlDir = await createFakeToolDir("jupyter-lab");
	const kept: string[] = [];

	try {
		const run = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "pi", "--ide", "jupyterlab"],
			{
				PATH: `${piDir}:${jlDir}:${process.env.PATH}`,
				SCODER_BROWSER: "sh",
				SCODER_KEEP_SESSION_TMP: "1",
			},
		);
		expect(run.code).toBe(0);
		const flat = flattenDryRun(run.stdout);
		const token = flat.match(/--IdentityProvider\.token=([0-9a-f]{48})/)?.[1];
		expect(token).toBeDefined();
		const overlay = flat.match(
			new RegExp(
				`--ro-bind (/tmp/scoder-[0-9a-f]{8}${repoDir}/AGENTS\\.md) ${repoDir}/AGENTS\\.md`,
			),
		);
		expect(overlay).not.toBeNull();
		kept.push(overlay![1]);
		const text = await Bun.file(overlay![1]).text();
		expect(text).toContain(`http://127.0.0.1:8888/lab?token=${token}`);
		expect(text).toContain("http://localhost:3001/mcp");
		// A companion's output already goes to the log; no HARNESS_LOG for pi.
		expect(flat).not.toContain("--setenv HARNESS_LOG");
	} finally {
		for (const path of kept) await removeSessionRoot(path);
		await Bun.spawn(["rm", "-rf", piDir, jlDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: gui-primary-output-goes-to-log
// EM: The entry point's HARNESS_LOG contract: with it set, the primary
// EM: tool's stdout and stderr land in the file, not the terminal, and its
// EM: stdin is /dev/null; without it, the tool keeps the terminal.
test("gui-primary-output-goes-to-log: HARNESS_LOG sends the primary tool's output to the file; unset, it stays on the terminal", async () => {
	const dir = `/tmp/scoder-harnesslog-${Date.now()}`;
	const log = `${dir}/gui.log`;
	await Bun.write(`${dir}/.keep`, "");
	const tool = [
		"bash",
		"-c",
		'echo to-stdout; echo to-stderr >&2; read -t 1 x && echo "stdin:$x"; true',
	];

	try {
		const withLog = Bun.spawn(["bash", ENTRYPOINT_SRC, ...tool], {
			env: {
				...process.env,
				HARNESS_ARGC: String(tool.length),
				IDE_ARGC: "0",
				HARNESS_LOG: log,
			},
			stdin: new Blob(["typed\n"]),
			stdout: "pipe",
			stderr: "pipe",
		});
		await withLog.exited;
		const out = await new Response(withLog.stdout).text();
		const err = await new Response(withLog.stderr).text();
		const logged = await Bun.file(log).text();
		expect(out).not.toContain("to-stdout");
		expect(err).not.toContain("to-stderr");
		expect(err).toContain("going to its log");
		expect(logged).toContain("to-stdout");
		expect(logged).toContain("to-stderr");
		expect(logged).not.toContain("stdin:typed");

		const plain = Bun.spawn(["bash", ENTRYPOINT_SRC, ...tool], {
			env: { ...process.env, HARNESS_ARGC: String(tool.length), IDE_ARGC: "0" },
			stdout: "pipe",
			stderr: "pipe",
		});
		await plain.exited;
		expect(await new Response(plain.stdout).text()).toContain("to-stdout");
	} finally {
		await Bun.spawn(["rm", "-rf", dir]).exited;
	}
});

// ### Test: xpra-version-floor
// EM: 6.5.4 broke wheel scrolling; 6.5.5 fixed it, so scoder needs >= 6.5.5
// EM: rather than pinning 6.5.3. Parsed from `xpra --version` and dpkg
// EM: spellings alike.
test("xpra-version-floor: 6.5.5 and newer pass, 6.5.4 and older are refused, unparseable output is null", () => {
	const ok = (v: string) => meetsXpraMinimum(parseXpraVersion(v) as number[]);
	expect(ok("xpra v6.5.5-r0")).toBe(true);
	expect(ok("6.5.5-r0-1")).toBe(true);
	expect(ok("xpra v6.6.0-r0")).toBe(true);
	expect(ok("xpra v7.0")).toBe(true);
	expect(ok("xpra v6.5.4-r0")).toBe(false);
	expect(ok("xpra v6.5.3-r0")).toBe(false);
	expect(ok("xpra v5.0.12")).toBe(false);
	expect(parseXpraVersion("no version here")).toBeNull();
});

// ### Test: stale-xpra-pin-removed
// EM: The 6.5.3 pin earlier scoder versions wrote would hold a machine below
// EM: the floor forever, so --install-dependencies removes it — but only a
// EM: pin scoder wrote; someone's own is reported and left alone.
test("stale-xpra-pin-removed: scoder's old pin file is deleted, a foreign one is kept", async () => {
	const dir = `/tmp/scoder-pin-${Date.now()}`;
	const ours = `${dir}/ours.pref`;
	const theirs = `${dir}/theirs.pref`;
	try {
		await Bun.write(
			ours,
			"# Written by scoder --install-dependencies. Safe to delete\nPackage: xpra\n",
		);
		await Bun.write(theirs, "Package: xpra\nPin: version 6.5.2*\n");
		expect(await removeStaleXpraPin(ours)).toBe(true);
		expect(await fileExists(ours)).toBe(false);
		expect(await removeStaleXpraPin(theirs)).toBe(true);
		expect(await fileExists(theirs)).toBe(true);
		expect(await removeStaleXpraPin(`${dir}/missing.pref`)).toBe(true);
	} finally {
		await Bun.spawn(["rm", "-rf", dir]).exited;
	}
});

// ### Test: bwrap-self-test-is-nested
// EM: The start-up self-test runs bwrap inside bwrap, as a session does —
// EM: on Ubuntu 26.04 a single bwrap succeeded while the nested one every
// EM: session needs was refused — and recognises both ways bwrap reports a
// EM: refused user namespace.
test("bwrap-self-test-is-nested: the self-test nests bwrap, and both refusal messages are recognised", () => {
	expect(BWRAP_SELF_TEST.filter((a) => a === "bwrap").length).toBe(2);
	expect(BWRAP_SELF_TEST).toContain("--dev");
	expect(isUsernsRefusal("bwrap: setting up uid map: Permission denied")).toBe(
		true,
	);
	expect(
		isUsernsRefusal(
			"bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.",
		),
	).toBe(true);
	expect(isUsernsRefusal("bwrap: Can't find source path /nope")).toBe(false);
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

// ### Test: uv-tool-environments-bound
// EM: `uv tool install` puts a symlink in ~/.local/bin pointing into
// EM: ~/.local/share/uv/tools/<tool>/bin, whose scripts' interpreter is the
// EM: venv's python, itself a link into ~/.local/share/uv/python. Neither
// EM: was bound, and the launcher was copied rather than linked — reported as
// EM: `hf: cannot execute: required file not found`. Both trees are bound
// EM: read-only now, and the symlink survives into the snapshot as a link.
test("uv-tool-environments-bound: uv tools and managed pythons are bound read-only, and ~/.local/bin links into them stay links", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const home = `/tmp/scoder-uvhome-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const tools = `${home}/.local/share/uv/tools`;
	const pythons = `${home}/.local/share/uv/python`;
	const kept: string[] = [];

	try {
		await Bun.write(`${pythons}/cpython-3.12/bin/.keep`, "");
		await Bun.write(`${tools}/huggingface-hub/bin/hf`, "#!/bin/sh\necho hf\n");
		await Bun.spawn(["chmod", "+x", `${tools}/huggingface-hub/bin/hf`]).exited;
		await Bun.spawn(["mkdir", "-p", `${home}/.local/bin`]).exited;
		await Bun.spawn([
			"ln",
			"-s",
			`${tools}/huggingface-hub/bin/hf`,
			`${home}/.local/bin/hf`,
		]).exited;

		const run = await runScoderRaw(repoDir, ["--dry-run", "/bin/bash"], {
			HOME: home,
			SCODER_KEEP_SESSION_TMP: "1",
		});
		expect(run.code).toBe(0);
		const flat = flattenDryRun(run.stdout);
		expect(flat).toContain(`--ro-bind ${tools} ${tools}`);
		expect(flat).toContain(`--ro-bind ${pythons} ${pythons}`);

		const snapshot = flat.match(
			new RegExp(
				`--ro-bind (/tmp/scoder-[0-9a-f]{8}${home}/\\.local/bin) ${home}/\\.local/bin`,
			),
		);
		expect(snapshot).not.toBeNull();
		kept.push(snapshot![1]);
		expect(readlinkSync(`${snapshot![1]}/hf`)).toBe(
			`${tools}/huggingface-hub/bin/hf`,
		);
		expect(run.stderr).not.toContain("Copied target: hf");
	} finally {
		for (const path of kept) await removeSessionRoot(path);
		await Bun.spawn(["rm", "-rf", home]).exited;
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
			const bind = `${process.env.HOME}/.claude ${SANDBOX_HOME}/.claude`;

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

// EM: ### Tests for the rstudio preset
// EM: See architecture/decision-records/0002-rstudio-x11-access.md. Unlike the
// EM: claude-preset tests above (skip-if-not-installed, since a fake claude
// EM: binary wouldn't prove anything about claude's own behaviour), what's
// EM: under test here is scoder's OWN bind/env computation in
// EM: presets.ts — a fake `rstudio` executable is a faithful stand-in for
// EM: that purpose, and keeps these tests deterministic on a machine
// EM: without RStudio Desktop installed (effectively every CI/dev box).
// EM: The dry-run tests below use a throwaway temp directory prepended to
// EM: PATH rather than ~/.local/bin — dry-run never execs the target, so
// EM: the fake binary's own sandbox-reachability is irrelevant, and this
// EM: avoids touching the real home directory at all. Only the one real
// EM: end-to-end test needs the fake binary to actually be reachable
// EM: *inside* a running sandbox, so that one alone uses ~/.local/bin,
// EM: mirroring local-bin-symlink-resolved's own precedent, with careful
// EM: cleanup.

async function createFakeToolDir(name: string): Promise<string> {
	const dir = `/tmp/scoder-fake-tool-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	await Bun.spawn(["mkdir", "-p", dir]).exited;
	await Bun.write(`${dir}/${name}`, "#!/bin/sh\ntrue\n");
	await Bun.spawn(["chmod", "+x", `${dir}/${name}`]).exited;
	return dir;
}

// ### Test: gui-preset-binds-xpra-socket-not-host-x11
// EM: The actual security claim of xpra-gui-isolation, asserted as a
// EM: negative — and the negative half is the point. A future change could
// EM: silently reintroduce host X11 access (a preset gaining a convenience
// EM: bind, someone "fixing" a display problem the quick way) and everything
// EM: would still work, just without the isolation. Nothing else would catch
// EM: that: the window looks identical either way.
// EM:
// EM: DISPLAY is set in the environment here deliberately, because that is the
// EM: case where a regression is most likely — a host with a real X session,
// EM: where passing it through would "work".
test("gui-preset-binds-xpra-socket-not-host-x11: a GUI preset gets the xpra socket and no host X11 access", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("rstudio");

	try {
		const output = await runScoder(repoDir, ["--dry-run", "rstudio"], {
			PATH: `${fakeBinDir}:${process.env.PATH}`,
			DISPLAY: ":42",
		});

		// The one channel the GUI gets across the boundary, read-write so the
		// in-sandbox server can create its socket in it.
		// EM: Source and dest identical — the mirroring mmap depends on.
		expect(output).toMatch(/--bind (\/tmp\/scoder-[0-9a-f]{8}\/xpra) \1(?= )/);
		expect(output).toMatch(
			/--setenv XPRA_SOCKET \/tmp\/scoder-[0-9a-f]{8}\/xpra\/xpra\.sock/,
		);
		expect(output).toMatch(
			/--setenv XPRA_MMAP \/tmp\/scoder-[0-9a-f]{8}\/xpra\/mmap/,
		);

		// None of what ADR 0002 accepted and 0003 withdrew.
		expect(output).not.toContain("/tmp/.X11-unix");
		expect(output).not.toContain("XAUTHORITY");
		expect(output).not.toContain(".Xauthority");
		expect(output).not.toContain("--setenv DISPLAY");
	} finally {
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: rstudio-preset-binds-config-dirs
test("rstudio-preset-binds-config-dirs: rstudio's own config/data dirs are bound read-write", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("rstudio");

	try {
		const output = await runScoder(repoDir, ["--dry-run", "rstudio"], {
			PATH: `${fakeBinDir}:${process.env.PATH}`,
		});

		const configBind = `${process.env.HOME}/.config/rstudio ${SANDBOX_HOME}/.config/rstudio`;
		expect(output).toContain(`--bind ${configBind}`);
		expect(output).not.toContain(`--ro-bind ${configBind}`);

		const dataBind = `${process.env.HOME}/.local/share/rstudio ${SANDBOX_HOME}/.local/share/rstudio`;
		expect(output).toContain(`--bind ${dataBind}`);
		expect(output).not.toContain(`--ro-bind ${dataBind}`);
	} finally {
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: rstudio-preset-binds-dev-dri-when-present
// Regression test: reported directly, RStudio Desktop (Electron/Chromium)
// showed a white window then crashed with SIGILL ("Illegal instruction
// (core dumped)") once /dev was narrowed to a fixed list of real device
// nodes that never included /dev/dri — Chromium's GPU process, unable to
// open a DRM render node, hits an internal CHECK() failure rather than
// falling back to software rendering. guiDisplayBinds (src/tools/presets.ts,
// shared with eclipse) now binds it via --dev-bind (not --ro-bind — only
// --dev-bind grants real device-node access) when it exists on the host.
test("rstudio-preset-binds-dev-dri-when-present: /dev/dri is dev-bound when it exists on the host, absent otherwise", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("rstudio");

	try {
		const output = await runScoder(repoDir, ["--dry-run", "rstudio"], {
			PATH: `${fakeBinDir}:${process.env.PATH}`,
		});

		if (await dirExists("/dev/dri")) {
			expect(output).toContain("--dev-bind /dev/dri /dev/dri");
		} else {
			expect(output).not.toContain("/dev/dri");
		}
	} finally {
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: rstudio-preset-includes-pi-config
test("rstudio-preset-includes-pi-config: pi's data/cache dirs are bound, same as pi's own top-level preset", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("rstudio");

	try {
		const output = await runScoder(repoDir, ["--dry-run", "rstudio"], {
			PATH: `${fakeBinDir}:${process.env.PATH}`,
		});

		expect(output).toContain(
			`--bind ${process.env.HOME}/.local/share/pi ${SANDBOX_HOME}/.local/share/pi`,
		);
		expect(output).toContain(
			`--bind ${process.env.HOME}/.cache/pi ${SANDBOX_HOME}/.cache/pi`,
		);
	} finally {
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// EM: rstudio-preset-binds-xauthority-when-present and
// EM: rstudio-preset-skips-xauthority-when-absent lived here. Both asserted
// EM: the shape of the XAUTHORITY passthrough — that the cookie file was
// EM: bound and the env var pointed at the sandbox copy rather than the host
// EM: path. There is no XAUTHORITY passthrough any more (ADR 0003), and
// EM: gui-preset-binds-xpra-socket-not-host-x11 above now asserts its absence,
// EM: which is the invariant worth holding. Removed rather than adapted:
// EM: there is nothing left for them to test.

// ### Test: rstudio-resolveargs-picks-rproj-file
test("rstudio-resolveargs-picks-rproj-file: rstudio is launched with the project's .Rproj file", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("rstudio");
	await Bun.write(`${repoDir}/myproject.Rproj`, "Version: 1.0\n");

	try {
		const output = await runScoder(
			repoDir,
			["--dry-run", "--no-worktree", "rstudio"],
			{ PATH: `${fakeBinDir}:${process.env.PATH}` },
		);

		// EM: repoDir is not under $HOME, so it's mirrored unchanged at its
		// EM: own real path — no sandbox-home prefix.
		expect(output).toContain(
			`-- bash /tmp/scoder-entrypoint.sh ${fakeBinDir}/rstudio ${repoDir}/myproject.Rproj`,
		);
	} finally {
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: rstudio-resolveargs-falls-back-to-project-dir
test("rstudio-resolveargs-falls-back-to-project-dir: with no .Rproj file, rstudio is launched with the project directory", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("rstudio");

	try {
		const output = await runScoder(
			repoDir,
			["--dry-run", "--no-worktree", "rstudio"],
			{ PATH: `${fakeBinDir}:${process.env.PATH}` },
		);

		expect(output).toContain(
			`-- bash /tmp/scoder-entrypoint.sh ${fakeBinDir}/rstudio ${repoDir}\n`,
		);
	} finally {
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: rstudio-resolveargs-does-not-override-explicit-args
test("rstudio-resolveargs-does-not-override-explicit-args: an explicit argument is left untouched even with a .Rproj file present", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("rstudio");
	await Bun.write(`${repoDir}/myproject.Rproj`, "Version: 1.0\n");

	try {
		const output = await runScoder(
			repoDir,
			["--dry-run", "--no-worktree", "rstudio", "somefile.R"],
			{ PATH: `${fakeBinDir}:${process.env.PATH}` },
		);

		expect(output).toContain(
			`-- bash /tmp/scoder-entrypoint.sh ${fakeBinDir}/rstudio somefile.R\n`,
		);
		expect(output).not.toContain(".Rproj");
	} finally {
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: vscode-preset-launch-args-and-binds
// EM: The preset's whole launch contract in one dry-run: the managed
// EM: per-project user-data-dir bound read-write at its mirrored path,
// EM: the pinned flags ahead of the project argument, the host's
// EM: extensions tree read-only, and — the secret-storage policy as a
// EM: regression guard (option A, design/features/secret-storage.md) —
// EM: no password-store flag. A future "fix" for the keyring prompt
// EM: that persists tokens to disk has to change this test, which is
// EM: the point: that trade should be visible, not reflexive.
test("vscode-preset-launch-args-and-binds: managed user-data-dir rw, pinned flags, extensions ro, no password-store flag", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("code");
	// EM: repoDir is not under $HOME, so its projDir is just its own path
	// EM: minus the leading slash — and unique per run, which is what makes
	// EM: deleting the managed dir in the finally clause unconditionally
	// EM: safe: it cannot pre-date this test.
	const managedDir = `${SANDBOX_HOME}/.local/share/scoder-vscode-userdata/${repoDir.slice(1)}`;
	const vscodeDir = `${SANDBOX_HOME}/.vscode`;
	const extensionsDir = `${vscodeDir}/extensions`;
	const vscodePreExisted = await dirExists(vscodeDir);
	const extensionsPreExisted = await dirExists(extensionsDir);

	try {
		if (!extensionsPreExisted) {
			await Bun.spawn(["mkdir", "-p", extensionsDir]).exited;
		}

		const output = await runScoder(
			repoDir,
			["--dry-run", "--no-worktree", "vscode"],
			{ PATH: `${fakeBinDir}:${process.env.PATH}` },
		);

		// EM: The rendered command continues long lines with `\`, so the
		// EM: exec argv arrives one-argument-per-line; flattened back to
		// EM: one line so the assertion can be exact rather than a chain of
		// EM: indexOf comparisons — a reordering fails on the whole line.
		const flat = output.replace(/\\\n\s+/g, "");

		// Read-write (the app writes its singleton lock, IPC socket and
		// state into it every second), and source == dest: the mirroring
		// the whole path-mirroring design relies on.
		expect(flat).toContain(`--bind ${managedDir} ${managedDir}`);

		// scoder's pinned flags first, user's args (none here), then the
		// project dir — the trailing \n pins that the project dir is the
		// last argument, i.e. the fill fired.
		expect(flat).toContain(
			`-- bash /tmp/scoder-entrypoint.sh ${fakeBinDir}/code` +
				` --user-data-dir ${managedDir}` +
				` --extensions-dir ${extensionsDir}` +
				` --disable-updates --disable-workspace-trust --verbose --use-inmemory-secretstorage ${repoDir}\n`,
		);

		expect(flat).toContain(`--ro-bind ${extensionsDir} ${extensionsDir}`);

		expect(flat).not.toContain("--password-store");
		// Trial branch: in-memory secrets are now pinned explicitly.
		expect(flat).toContain("--use-inmemory-secretstorage");
	} finally {
		if (!extensionsPreExisted) {
			await Bun.spawn(["rm", "-rf", extensionsDir]).exited;
			if (!vscodePreExisted) {
				await Bun.spawn(["rm", "-rf", vscodeDir]).exited;
			}
		}
		await Bun.spawn(["rm", "-rf", managedDir]).exited;
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: vscode-settings-seeded-once-and-never-again
// EM: The persistence guarantee that motivated the whole managed-dir
// EM: design (an ephemeral copy was the fallback the user rejected), plus
// EM: the seed contract: hand-written settings cross over once, live state
// EM: never. Runs with HOME pointed at a throwaway directory — deliberate:
// EM: the seed source is `~/.config/Code/User`, which on a developer
// EM: desktop is someone's real settings; writing a test sentinel there,
// EM: even guarded, is not acceptable. With HOME overridden, everything
// EM: the preset touches — seed source, managed dir, extensions gate —
// EM: lives inside the throwaway, and nothing real is at risk. The dry-run
// EM: path only assembles a command and stages host-side dirs, all of
// EM: which honor $HOME.
test("vscode-settings-seeded-once-and-never-again: settings copy on first creation, then the managed dir is never touched again", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("code");
	const fakeHome = `/tmp/scoder-vscode-fake-home-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const hostUserDir = `${fakeHome}/.config/Code/User`;
	const managedDir = `${fakeHome}/.local/share/scoder-vscode-userdata/${repoDir.slice(1)}`;

	try {
		await Bun.write(`${hostUserDir}/settings.json`, '{"theme":"first"}');
		await Bun.write(`${hostUserDir}/keybindings.json`, "[]");
		await Bun.write(`${hostUserDir}/snippets/markdown.json-code`, "snip");
		// EM: Live state, not preference: must NOT cross into the managed
		// EM: dir even at seed time.
		await Bun.write(`${hostUserDir}/globalStorage/state.vscdb`, "NOT-COPIED");
		await Bun.write(
			`${hostUserDir}/workspaceStorage/x/state.vscdb`,
			"NOT-COPIED",
		);

		const env = { PATH: `${fakeBinDir}:${process.env.PATH}`, HOME: fakeHome };
		await runScoder(repoDir, ["--dry-run", "--no-worktree", "vscode"], env);

		expect(await Bun.file(`${managedDir}/User/settings.json`).text()).toBe(
			'{"theme":"first"}',
		);
		expect(await fileExists(`${managedDir}/User/keybindings.json`)).toBe(true);
		expect(
			await Bun.file(`${managedDir}/User/snippets/markdown.json-code`).text(),
		).toBe("snip");
		expect(await dirExists(`${managedDir}/User/globalStorage`)).toBe(false);
		expect(await dirExists(`${managedDir}/User/workspaceStorage`)).toBe(false);

		// EM: The "never again" half, which is the actual persistence
		// EM: promise: a session's own edits to its settings (simulated
		// EM: here; really made by the sandboxed editor) survive the next
		// EM: launch, even though the host source has since changed. A
		// EM: re-seed would silently discard one session's work.
		await Bun.write(
			`${managedDir}/User/settings.json`,
			'{"theme":"session-edit"}',
		);
		await Bun.write(`${hostUserDir}/settings.json`, '{"theme":"host-change"}');

		await runScoder(repoDir, ["--dry-run", "--no-worktree", "vscode"], env);

		expect(await Bun.file(`${managedDir}/User/settings.json`).text()).toBe(
			'{"theme":"session-edit"}',
		);
		// EM: And nothing ever copies back: the host's real settings are
		// EM: not the sandbox's to write.
		expect(await Bun.file(`${hostUserDir}/settings.json`).text()).toBe(
			'{"theme":"host-change"}',
		);
	} finally {
		await Bun.spawn(["rm", "-rf", fakeHome]).exited;
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: vscode-preset-binds-continue-when-present
// EM: Continue keeps config, sessions and its index at ~/.continue, outside
// EM: the user-data-dir: bound read-write when it exists, and never created
// EM: when it does not. A throwaway HOME, so neither half depends on, or
// EM: touches, the developer's real ~/.continue.
test("vscode-preset-binds-continue-when-present: ~/.continue is bound read-write when it exists, absent otherwise", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("code");
	const fakeHome = `/tmp/scoder-vscode-fake-home-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const env = { PATH: `${fakeBinDir}:${process.env.PATH}`, HOME: fakeHome };

	try {
		await Bun.write(`${fakeHome}/.placeholder`, "");
		const without = flattenDryRun(
			await runScoder(repoDir, ["--dry-run", "--no-worktree", "vscode"], env),
		);
		expect(without).not.toContain("/.continue");
		expect(await dirExists(`${fakeHome}/.continue`)).toBe(false);

		await Bun.write(`${fakeHome}/.continue/config.yaml`, "models: []\n");
		const withIt = flattenDryRun(
			await runScoder(repoDir, ["--dry-run", "--no-worktree", "vscode"], env),
		);
		expect(withIt).toContain(
			`--bind ${fakeHome}/.continue ${fakeHome}/.continue`,
		);
		expect(withIt).not.toContain(`--ro-bind ${fakeHome}/.continue`);
	} finally {
		await Bun.spawn(["rm", "-rf", fakeHome, fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: new-workspace-path-guard
// EM: The check standing between a preset hook and rm -rf: strictly below
// EM: a scoder-<name> root in ~/.local/share, never the root itself, never
// EM: anything else in $HOME, never a path that climbs out with "..".
test("new-workspace-path-guard: only paths strictly inside a scoder-managed root are deletable", () => {
	const home = "/home/u";
	const ok = [
		"/home/u/.local/share/scoder-vscode-userdata/home/u/proj",
		"/home/u/.local/share/scoder-eclipse-workspaces/tmp/repo",
	];
	const refused = [
		"/home/u/.local/share/scoder-vscode-userdata",
		"/home/u/.local/share/scoder-vscode-userdata/",
		"/home/u/.local/share/Code/User",
		"/home/u/.eclipse/123/configuration",
		"/home/u",
		"/home/u/.local/share/scoder-x/../../../.ssh",
		"/home/other/.local/share/scoder-vscode-userdata/p",
	];
	for (const dir of ok) {
		expect(isManagedWorkspacePath(dir, home)).toBe(true);
	}
	for (const dir of refused) {
		expect(isManagedWorkspacePath(dir, home)).toBe(false);
	}
});

// ### Test: new-workspace-reseeds-vscode-from-host
// EM: The point of the flag end to end: a session's edits to its managed
// EM: settings are what the seed-once rule protects, and --new-workspace is
// EM: the deliberate way past it. Delete (in-process: a real launch needs
// EM: bwrap) then a dry-run setup: the user-data-dir comes back seeded from
// EM: the host's *current* settings, not the session's edit. Throwaway HOME.
test("new-workspace-reseeds-vscode-from-host: after a reset the managed user-data-dir is re-seeded from the host's current settings", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("code");
	const fakeHome = `/tmp/scoder-newws-home-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const hostSettings = `${fakeHome}/.config/Code/User/settings.json`;
	const managedDir = `${fakeHome}/.local/share/scoder-vscode-userdata/${repoDir.slice(1)}`;
	const env = { PATH: `${fakeBinDir}:${process.env.PATH}`, HOME: fakeHome };
	const savedHome = process.env.HOME;

	try {
		await Bun.write(hostSettings, '{"theme":"first"}');
		await runScoder(repoDir, ["--dry-run", "--no-worktree", "vscode"], env);
		await Bun.write(`${managedDir}/User/settings.json`, '{"theme":"session"}');
		await Bun.write(hostSettings, '{"theme":"host-now"}');

		// --dry-run reports, and deletes nothing.
		const dry = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "vscode", "--new-workspace"],
			env,
		);
		expect(dry.code).toBe(0);
		expect(dry.stderr).toContain(
			`would delete vscode's workspace ${managedDir}`,
		);
		expect(await Bun.file(`${managedDir}/User/settings.json`).text()).toBe(
			'{"theme":"session"}',
		);

		process.env.HOME = fakeHome;
		expect(await resetManagedWorkspace("vscode", managedDir, false)).toBe(true);
		process.env.HOME = savedHome;
		expect(await dirExists(managedDir)).toBe(false);

		await runScoder(repoDir, ["--dry-run", "--no-worktree", "vscode"], env);
		expect(await Bun.file(`${managedDir}/User/settings.json`).text()).toBe(
			'{"theme":"host-now"}',
		);
	} finally {
		process.env.HOME = savedHome;
		await Bun.spawn(["rm", "-rf", fakeHome, fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: new-workspace-refuses-while-in-use
// EM: Deleting under a live IDE half-destroys a tree it is still writing.
// EM: The stand-in "IDE" is any process naming the directory in its argv,
// EM: the way both presets launch (-data DIR, --user-data-dir DIR).
test("new-workspace-refuses-while-in-use: a process with the workspace in its argv blocks the reset, and nothing is deleted", async () => {
	const fakeHome = `/tmp/scoder-newws-home-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const managedDir = `${fakeHome}/.local/share/scoder-eclipse-workspaces/tmp/proj`;
	const savedHome = process.env.HOME;
	await Bun.write(`${managedDir}/.metadata/.lock`, "");
	// EM: Two commands, so bash stays the process (a lone `sleep` would be
	// EM: exec'd in its place, taking the argv with it), and the reset only
	// EM: runs once the kernel shows the directory in its cmdline.
	const holder = Bun.spawn([
		"bash",
		"-c",
		"sleep 30; true",
		"_",
		"-data",
		managedDir,
	]);
	for (let tries = 0; tries < 100; tries++) {
		const cmdline = await Bun.file(`/proc/${holder.pid}/cmdline`)
			.text()
			.catch(() => "");
		if (cmdline.includes(managedDir)) {
			break;
		}
		await Bun.sleep(10);
	}

	try {
		process.env.HOME = fakeHome;
		expect(await resetManagedWorkspace("eclipse", managedDir, false)).toBe(
			false,
		);
		expect(await dirExists(managedDir)).toBe(true);

		holder.kill();
		await holder.exited;
		expect(await resetManagedWorkspace("eclipse", managedDir, false)).toBe(
			true,
		);
		expect(await dirExists(managedDir)).toBe(false);
	} finally {
		process.env.HOME = savedHome;
		holder.kill();
		await Bun.spawn(["rm", "-rf", fakeHome]).exited;
	}
});

// ### Test: new-workspace-needs-a-managed-preset
test("new-workspace-needs-a-managed-preset: --new-workspace with no eclipse or vscode in the session is a named error", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");

	try {
		const run = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "--new-workspace", "pi"],
			{ PATH: `${piDir}:${process.env.PATH}` },
		);
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain(
			"--new-workspace only applies to a session running a preset with a managed workspace",
		);
		expect(run.stderr).toContain("eclipse, vscode");
	} finally {
		await Bun.spawn(["rm", "-rf", piDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: vscodium-preset-uses-its-own-paths
// EM: VSCodium is the vscode preset with VSCodium's paths: `codium`, a seed
// EM: from ~/.config/VSCodium/User, extensions from ~/.vscode-oss, and a
// EM: managed user-data-dir root of its own — nothing of VS Code's is read
// EM: or bound. Throwaway HOME holding both editors' state to tell apart.
test("vscodium-preset-uses-its-own-paths: codium, ~/.config/VSCodium seed, ~/.vscode-oss extensions, its own managed dir, none of VS Code's", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("codium");
	const fakeHome = `/tmp/scoder-codium-home-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const managedDir = `${fakeHome}/.local/share/scoder-vscodium-userdata/${repoDir.slice(1)}`;
	const extensionsDir = `${fakeHome}/.vscode-oss/extensions`;

	try {
		await Bun.write(
			`${fakeHome}/.config/VSCodium/User/settings.json`,
			'{"from":"codium"}',
		);
		await Bun.write(
			`${fakeHome}/.config/Code/User/settings.json`,
			'{"from":"code"}',
		);
		await Bun.write(`${extensionsDir}/.placeholder`, "");
		await Bun.write(`${fakeHome}/.vscode/extensions/.placeholder`, "");

		const output = await runScoder(
			repoDir,
			["--dry-run", "--no-worktree", "vscodium"],
			{
				PATH: `${fakeBinDir}:${process.env.PATH}`,
				HOME: fakeHome,
			},
		);
		const flat = flattenDryRun(output);

		expect(flat).toContain(`--bind ${managedDir} ${managedDir}`);
		expect(flat).toContain(`--ro-bind ${extensionsDir} ${extensionsDir}`);
		// Joined without the wrap padding, as vscode-user-args does.
		expect(output.replace(/\\\n\s+/g, "")).toContain(
			`-- bash /tmp/scoder-entrypoint.sh ${fakeBinDir}/codium` +
				` --user-data-dir ${managedDir}` +
				` --extensions-dir ${extensionsDir}`,
		);
		expect(await Bun.file(`${managedDir}/User/settings.json`).text()).toBe(
			'{"from":"codium"}',
		);
		expect(flat).not.toContain(`${fakeHome}/.vscode/`);
		expect(flat).not.toContain("scoder-vscode-userdata");
		expect(
			await dirExists(`${fakeHome}/.local/share/scoder-vscode-userdata`),
		).toBe(false);
	} finally {
		await Bun.spawn(["rm", "-rf", fakeHome, fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: webstorm-preset-managed-per-project-layout
// EM: The JetBrains pattern: config seeded once from the host's newest
// EM: product dir (lock/port files left behind), system dir persisted beside
// EM: it, plugins from the matching host dir read-only, all named by a staged
// EM: idea.properties the launcher finds through WEBSTORM_PROPERTIES, with
// EM: project trust pre-answered. Throwaway HOME with two versions present.
test("webstorm-preset-managed-per-project-layout: seeds from the newest WebStorm dir once, binds plugins ro, and points WEBSTORM_PROPERTIES at the staged layout", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("webstorm");
	const fakeHome = `/tmp/scoder-ws-home-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const managed = `${fakeHome}/.local/share/scoder-webstorm/${repoDir.slice(1)}`;
	const plugins = `${fakeHome}/.local/share/JetBrains/WebStorm2025.2`;
	const env = {
		PATH: `${fakeBinDir}:${process.env.PATH}`,
		HOME: fakeHome,
		SCODER_KEEP_SESSION_TMP: "1",
	};
	const kept: string[] = [];

	try {
		await Bun.write(
			`${fakeHome}/.config/JetBrains/WebStorm2024.3/options/ui.xml`,
			"old",
		);
		await Bun.write(
			`${fakeHome}/.config/JetBrains/WebStorm2025.2/options/ui.xml`,
			"new",
		);
		await Bun.write(`${fakeHome}/.config/JetBrains/WebStorm2025.2/.lock`, "");
		await Bun.write(
			`${fakeHome}/.config/JetBrains/WebStorm2025.2/port`,
			"6942",
		);
		await Bun.write(`${plugins}/some-plugin/lib.jar`, "");
		// Cross-product answers to the EULA and usage-stats dialogs.
		await Bun.write(
			`${fakeHome}/.java/.userPrefs/jetbrains/privacy_policy/prefs.xml`,
			"<map/>",
		);
		await Bun.write(
			`${fakeHome}/.local/share/JetBrains/consentOptions/accepted`,
			"rsch.send.usage.stat:1.1:0:1",
		);
		// The install's own properties, which the native launcher reads.
		await Bun.write(
			`${fakeBinDir}/idea.properties`,
			"idea.max.intellisense.filesize=2500\n",
		);

		const run = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "webstorm"],
			env,
		);
		expect(run.code).toBe(0);
		const flat = flattenDryRun(run.stdout);

		expect(flat).toContain(`--bind ${managed} ${managed}`);
		expect(flat).toContain(`--ro-bind ${plugins} ${plugins}`);
		const prefs = `${fakeHome}/.java/.userPrefs/jetbrains`;
		const consent = `${fakeHome}/.local/share/JetBrains/consentOptions`;
		expect(flat).toContain(`--ro-bind ${prefs} ${prefs}`);
		expect(flat).toContain(`--ro-bind ${consent} ${consent}`);
		expect(flat).toContain(
			"--setenv WEBSTORM_PROPERTIES /tmp/scoder-idea.properties",
		);
		expect(flat).toContain(
			`-- bash /tmp/scoder-entrypoint.sh ${fakeBinDir}/webstorm ${repoDir}\n`,
		);

		expect(await Bun.file(`${managed}/config/options/ui.xml`).text()).toBe(
			"new",
		);
		expect(await fileExists(`${managed}/config/.lock`)).toBe(false);
		expect(await fileExists(`${managed}/config/port`)).toBe(false);
		expect(await dirExists(`${managed}/system`)).toBe(true);

		const props = flat.match(
			/--ro-bind (\/tmp\/scoder-[0-9a-f]{8}\/tmp\/scoder-idea\.properties) \/tmp\/scoder-idea\.properties/,
		);
		expect(props).not.toBeNull();
		kept.push(props![1]);
		const text = await Bun.file(props![1]).text();
		expect(text).toContain(`idea.config.path=${managed}/config`);
		expect(text).toContain(`idea.system.path=${managed}/system`);
		expect(text).toContain(`idea.plugins.path=${plugins}`);
		expect(text).toContain("idea.trust.all.projects=true");

		// Shadowed install file: original first, overrides after, bound over
		// the install's own path (the native launcher ignores the env var).
		const installProps = `${fakeBinDir}/idea.properties`;
		const shadow = flat.match(
			new RegExp(
				`--ro-bind (/tmp/scoder-[0-9a-f]{8}${installProps}) ${installProps}`,
			),
		);
		expect(shadow).not.toBeNull();
		const shadowText = await Bun.file(shadow![1]).text();
		expect(shadowText.startsWith("idea.max.intellisense.filesize=2500\n")).toBe(
			true,
		);
		expect(shadowText.indexOf("idea.config.path=")).toBeGreaterThan(
			shadowText.indexOf("idea.max.intellisense.filesize"),
		);
		expect(await Bun.file(installProps).text()).toBe(
			"idea.max.intellisense.filesize=2500\n",
		);

		// Seed once: a session's own settings edit survives a host change.
		await Bun.write(`${managed}/config/options/ui.xml`, "session-edit");
		await Bun.write(
			`${fakeHome}/.config/JetBrains/WebStorm2025.2/options/ui.xml`,
			"host-later",
		);
		const again = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "webstorm"],
			env,
		);
		const props2 = flattenDryRun(again.stdout).match(
			/--ro-bind (\/tmp\/scoder-[0-9a-f]{8}\/tmp\/scoder-idea\.properties)/,
		);
		if (props2) kept.push(props2[1]);
		expect(await Bun.file(`${managed}/config/options/ui.xml`).text()).toBe(
			"session-edit",
		);
	} finally {
		for (const path of kept) {
			await removeSessionRoot(path);
		}
		await Bun.spawn(["rm", "-rf", fakeHome, fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: positron-preset-uses-its-own-paths
// EM: Positron is the vscode preset with Positron's paths: `positron`, a
// EM: seed from ~/.config/Positron/User, extensions from ~/.positron, and a
// EM: managed user-data-dir root of its own — nothing of VS Code's is read
// EM: or bound. Throwaway HOME holding both editors' state to tell apart.
test("positron-preset-uses-its-own-paths: positron, ~/.config/Positron seed, ~/.positron extensions, its own managed dir, none of VS Code's", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("positron");
	const fakeHome = `/tmp/scoder-positron-home-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const managedDir = `${fakeHome}/.local/share/scoder-positron-userdata/${repoDir.slice(1)}`;
	const extensionsDir = `${fakeHome}/.positron/extensions`;

	try {
		await Bun.write(
			`${fakeHome}/.config/Positron/User/settings.json`,
			'{"from":"positron"}',
		);
		await Bun.write(
			`${fakeHome}/.config/Code/User/settings.json`,
			'{"from":"code"}',
		);
		await Bun.write(`${extensionsDir}/.placeholder`, "");
		await Bun.write(`${fakeHome}/.vscode/extensions/.placeholder`, "");

		const output = await runScoder(
			repoDir,
			["--dry-run", "--no-worktree", "positron"],
			{
				PATH: `${fakeBinDir}:${process.env.PATH}`,
				HOME: fakeHome,
			},
		);
		const flat = flattenDryRun(output);

		expect(flat).toContain(`--bind ${managedDir} ${managedDir}`);
		expect(flat).toContain(`--ro-bind ${extensionsDir} ${extensionsDir}`);
		// Joined without the wrap padding, as vscode-user-args does.
		expect(output.replace(/\\\n\s+/g, "")).toContain(
			`-- bash /tmp/scoder-entrypoint.sh ${fakeBinDir}/positron` +
				` --user-data-dir ${managedDir}` +
				` --extensions-dir ${extensionsDir}`,
		);
		expect(await Bun.file(`${managedDir}/User/settings.json`).text()).toBe(
			'{"from":"positron"}',
		);
		expect(flat).not.toContain(`${fakeHome}/.vscode/`);
		expect(flat).not.toContain("scoder-vscode-userdata");
		expect(
			await dirExists(`${fakeHome}/.local/share/scoder-vscode-userdata`),
		).toBe(false);
	} finally {
		await Bun.spawn(["rm", "-rf", fakeHome, fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: webstorm-preset-managed-per-project-layout
// EM: The JetBrains pattern: config seeded once from the host's newest
// EM: product dir (lock/port files left behind), system dir persisted beside
// EM: it, plugins from the matching host dir read-only, all named by a staged
// EM: idea.properties the launcher finds through WEBSTORM_PROPERTIES, with
// EM: project trust pre-answered. Throwaway HOME with two versions present.
test("webstorm-preset-managed-per-project-layout: seeds from the newest WebStorm dir once, binds plugins ro, and points WEBSTORM_PROPERTIES at the staged layout", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("webstorm");
	const fakeHome = `/tmp/scoder-ws-home-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const managed = `${fakeHome}/.local/share/scoder-webstorm/${repoDir.slice(1)}`;
	const plugins = `${fakeHome}/.local/share/JetBrains/WebStorm2025.2`;
	const env = {
		PATH: `${fakeBinDir}:${process.env.PATH}`,
		HOME: fakeHome,
		SCODER_KEEP_SESSION_TMP: "1",
	};
	const kept: string[] = [];

	try {
		await Bun.write(
			`${fakeHome}/.config/JetBrains/WebStorm2024.3/options/ui.xml`,
			"old",
		);
		await Bun.write(
			`${fakeHome}/.config/JetBrains/WebStorm2025.2/options/ui.xml`,
			"new",
		);
		await Bun.write(`${fakeHome}/.config/JetBrains/WebStorm2025.2/.lock`, "");
		await Bun.write(
			`${fakeHome}/.config/JetBrains/WebStorm2025.2/port`,
			"6942",
		);
		await Bun.write(`${plugins}/some-plugin/lib.jar`, "");
		// Cross-product answers to the EULA and usage-stats dialogs.
		await Bun.write(
			`${fakeHome}/.java/.userPrefs/jetbrains/privacy_policy/prefs.xml`,
			"<map/>",
		);
		await Bun.write(
			`${fakeHome}/.local/share/JetBrains/consentOptions/accepted`,
			"rsch.send.usage.stat:1.1:0:1",
		);
		// The install's own properties, which the native launcher reads.
		await Bun.write(
			`${fakeBinDir}/idea.properties`,
			"idea.max.intellisense.filesize=2500\n",
		);

		const run = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "webstorm"],
			env,
		);
		expect(run.code).toBe(0);
		const flat = flattenDryRun(run.stdout);

		expect(flat).toContain(`--bind ${managed} ${managed}`);
		expect(flat).toContain(`--ro-bind ${plugins} ${plugins}`);
		const prefs = `${fakeHome}/.java/.userPrefs/jetbrains`;
		const consent = `${fakeHome}/.local/share/JetBrains/consentOptions`;
		expect(flat).toContain(`--ro-bind ${prefs} ${prefs}`);
		expect(flat).toContain(`--ro-bind ${consent} ${consent}`);
		expect(flat).toContain(
			"--setenv WEBSTORM_PROPERTIES /tmp/scoder-idea.properties",
		);
		expect(flat).toContain(
			`-- bash /tmp/scoder-entrypoint.sh ${fakeBinDir}/webstorm ${repoDir}\n`,
		);

		expect(await Bun.file(`${managed}/config/options/ui.xml`).text()).toBe(
			"new",
		);
		expect(await fileExists(`${managed}/config/.lock`)).toBe(false);
		expect(await fileExists(`${managed}/config/port`)).toBe(false);
		expect(await dirExists(`${managed}/system`)).toBe(true);

		const props = flat.match(
			/--ro-bind (\/tmp\/scoder-[0-9a-f]{8}\/tmp\/scoder-idea\.properties) \/tmp\/scoder-idea\.properties/,
		);
		expect(props).not.toBeNull();
		kept.push(props![1]);
		const text = await Bun.file(props![1]).text();
		expect(text).toContain(`idea.config.path=${managed}/config`);
		expect(text).toContain(`idea.system.path=${managed}/system`);
		expect(text).toContain(`idea.plugins.path=${plugins}`);
		expect(text).toContain("idea.trust.all.projects=true");

		// Shadowed install file: original first, overrides after, bound over
		// the install's own path (the native launcher ignores the env var).
		const installProps = `${fakeBinDir}/idea.properties`;
		const shadow = flat.match(
			new RegExp(
				`--ro-bind (/tmp/scoder-[0-9a-f]{8}${installProps}) ${installProps}`,
			),
		);
		expect(shadow).not.toBeNull();
		const shadowText = await Bun.file(shadow![1]).text();
		expect(shadowText.startsWith("idea.max.intellisense.filesize=2500\n")).toBe(
			true,
		);
		expect(shadowText.indexOf("idea.config.path=")).toBeGreaterThan(
			shadowText.indexOf("idea.max.intellisense.filesize"),
		);
		expect(await Bun.file(installProps).text()).toBe(
			"idea.max.intellisense.filesize=2500\n",
		);

		// Seed once: a session's own settings edit survives a host change.
		await Bun.write(`${managed}/config/options/ui.xml`, "session-edit");
		await Bun.write(
			`${fakeHome}/.config/JetBrains/WebStorm2025.2/options/ui.xml`,
			"host-later",
		);
		const again = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "webstorm"],
			env,
		);
		const props2 = flattenDryRun(again.stdout).match(
			/--ro-bind (\/tmp\/scoder-[0-9a-f]{8}\/tmp\/scoder-idea\.properties)/,
		);
		if (props2) kept.push(props2[1]);
		expect(await Bun.file(`${managed}/config/options/ui.xml`).text()).toBe(
			"session-edit",
		);
	} finally {
		for (const path of kept) {
			await removeSessionRoot(path);
		}
		await Bun.spawn(["rm", "-rf", fakeHome, fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: rprofile-overlay-for-r-ides-only
// EM: The btw .Rprofile hook is shared by the R-capable IDEs, rstudio and
// EM: positron, as one function, and only they get it: a plain vscode
// EM: session must not have its project's .Rprofile rewritten.
test("rprofile-overlay-for-r-ides-only: positron and rstudio overlay .Rprofile with the btw session hook; vscode does not", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const binDirs: string[] = [];
	const kept: string[] = [];

	try {
		for (const [preset, bin] of [
			["positron", "positron"],
			["rstudio", "rstudio"],
			["vscode", "code"],
		]) {
			const binDir = await createFakeToolDir(bin);
			binDirs.push(binDir);
			const run = await runScoderRaw(
				repoDir,
				["--dry-run", "--no-worktree", preset],
				{
					PATH: `${binDir}:${process.env.PATH}`,
					SCODER_KEEP_SESSION_TMP: "1",
				},
			);
			expect(run.code).toBe(0);
			const flat = flattenDryRun(run.stdout);
			const bind = flat.match(
				new RegExp(
					`--ro-bind (/tmp/scoder-[0-9a-f]{8}${repoDir}/\\.Rprofile) ${repoDir}/\\.Rprofile`,
				),
			);
			const root = flat.match(/\/tmp\/scoder-[0-9a-f]{8}/);
			if (root) kept.push(root[0]);
			if (preset === "vscode") {
				expect(bind).toBeNull();
				continue;
			}
			expect(bind).not.toBeNull();
			const text = await Bun.file(bind![1]).text();
			expect(text).toContain("  btw::btw_mcp_session()\n");
			expect(text).toContain("if (interactive()");
		}
	} finally {
		for (const path of kept) {
			await removeSessionRoot(path);
		}
		await Bun.spawn(["rm", "-rf", ...binDirs]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: vscode-user-args-pass-through-untouched
// EM: scoder's flags go in front, but they never displace or reorder the
// EM: user's own, and any user arg at all suppresses the project-dir fill
// EM: (guessing which args are folders vs flag-values is fragile —
// EM: --install-extension takes a value that is not a folder).
test("vscode-user-args-pass-through-untouched: pinned flags prepend, user args follow verbatim, no project-dir fill", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("code");
	const managedDir = `${SANDBOX_HOME}/.local/share/scoder-vscode-userdata/${repoDir.slice(1)}`;

	try {
		const output = await runScoder(
			repoDir,
			[
				"--dry-run",
				"--no-worktree",
				"vscode",
				"--install-extension",
				"ms-python.python",
			],
			{ PATH: `${fakeBinDir}:${process.env.PATH}` },
		);

		// EM: Flattened line continuations, as in the first vscode test:
		// EM: the trailing \n here pins that ms-python.python is the last
		// EM: argument — i.e. the project-dir fill did NOT fire, because
		// EM: any user arg at all suppresses it.
		const flat = output.replace(/\\\n\s+/g, "");
		expect(flat).toContain(
			`-- bash /tmp/scoder-entrypoint.sh ${fakeBinDir}/code` +
				` --user-data-dir ${managedDir}` +
				` --extensions-dir ${SANDBOX_HOME}/.vscode/extensions` +
				` --disable-updates --disable-workspace-trust --verbose --use-inmemory-secretstorage` +
				` --install-extension ms-python.python\n`,
		);
	} finally {
		await Bun.spawn(["rm", "-rf", managedDir]).exited;
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: vscode-as-ide-companion
// EM: The companion path reuses the same preset, so the same flags must
// EM: show up when vscode is the --ide rather than the primary tool —
// EM: with pi as primary, which also gives the bind-merge its coverage.
test("vscode-as-ide-companion: --ide vscode gets its managed user-data-dir inside the shared sandbox", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");
	const codeDir = await createFakeToolDir("code");
	const managedDir = `${SANDBOX_HOME}/.local/share/scoder-vscode-userdata/${repoDir.slice(1)}`;

	try {
		const output = await runScoder(
			repoDir,
			["--dry-run", "--no-worktree", "pi", "--ide", "vscode"],
			{ PATH: `${piDir}:${codeDir}:${process.env.PATH}` },
		);

		expect(output).toContain(`--bind ${managedDir} ${managedDir}`);
		expect(output).toContain(`--user-data-dir ${managedDir}`);
		// The companion is a GUI preset: the shared sandbox runs under xpra.
		expect(output).toContain("--setenv XPRA_SOCKET ");
	} finally {
		await Bun.spawn(["rm", "-rf", managedDir]).exited;
		await Bun.spawn(["rm", "-rf", piDir, codeDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: vscode-preset-native-display-gets-display-env
// EM: Reported from the desktop: `scoder --native-display pi --ide vscode`
// EM: bound /tmp/.X11-unix and the cookie but set neither DISPLAY nor
// EM: XAUTHORITY, so `code` started into --clearenv with no display to
// EM: name and never appeared. The preset took guiDisplayBinds' binds and
// EM: dirs and dropped its env; rstudio and eclipse spread all three, which
// EM: is why their native tests never caught it.
test("vscode-preset-native-display-gets-display-env: under --native-display the vscode preset passes DISPLAY, XAUTHORITY and XDG_RUNTIME_DIR, not just the binds", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");
	const codeDir = await createFakeToolDir("code");
	const x11 = await createFakeX11HostState();
	const managedDir = `${SANDBOX_HOME}/.local/share/scoder-vscode-userdata/${repoDir.slice(1)}`;

	try {
		const output = await runScoder(
			repoDir,
			[
				"--native-display",
				"--dry-run",
				"--no-worktree",
				"pi",
				"--ide",
				"vscode",
			],
			{
				PATH: `${piDir}:${codeDir}:${process.env.PATH}`,
				DISPLAY: ":42",
				XAUTHORITY: x11.cookiePath,
				XDG_RUNTIME_DIR: "/run/user/4242",
			},
		);
		const flat = flattenDryRun(output);

		expect(flat).toContain("--ro-bind /tmp/.X11-unix /tmp/.X11-unix");
		expect(flat).toContain("--setenv DISPLAY :42");
		expect(flat).toContain(`--setenv XAUTHORITY ${SANDBOX_HOME}/.Xauthority`);
		expect(flat).toContain("--setenv XDG_RUNTIME_DIR /run/user/4242");
	} finally {
		await x11.cleanup();
		await Bun.spawn(["rm", "-rf", managedDir]).exited;
		await Bun.spawn(["rm", "-rf", piDir, codeDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: vscode-no-host-dbus-address
// EM: The ADR 0004 invariant re-asserted at the preset most likely to be
// EM: "fixed" with a bus passthrough — VS Code complains about no session
// EM: bus in exactly the way RStudio once did, and RStudio's symptom was
// EM: the one thing that kept the host bus alive for a year.
test("vscode-no-host-dbus-address: the vscode preset never passes the host's session bus in", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("code");
	const managedDir = `${SANDBOX_HOME}/.local/share/scoder-vscode-userdata/${repoDir.slice(1)}`;

	try {
		const output = await runScoder(
			repoDir,
			["--dry-run", "--no-worktree", "vscode"],
			{
				PATH: `${fakeBinDir}:${process.env.PATH}`,
				DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
			},
		);

		// EM: Only the absence half is asserted; the XDG_RUNTIME_DIR
		// EM: presence companion-assertion of the rstudio original is left
		// EM: there — it depends on the variable being set in the test
		// EM: environment at all (unset in this container, where the
		// EM: original fails on it too), and it is not this preset's
		// EM: behavior under test.
		expect(output).not.toContain("DBUS_SESSION_BUS_ADDRESS");
		expect(output).not.toContain("/run/user/1000/bus");
	} finally {
		await Bun.spawn(["rm", "-rf", managedDir]).exited;
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: is-snap-install-recognises-the-snap-spelling
// EM: Pure predicate over a resolved path: the refusal itself needs no
// EM: snap to test, and validate()'s wiring of it is exercised by the
// EM: dry-run tests above (every fake `code` there is not under /snap).
test("is-snap-install-recognises-the-snap-spelling: /snap paths reject, ordinary installs pass", () => {
	expect(isSnapInstall("/snap/bin/code")).toBe(true);
	expect(isSnapInstall("/snap/code/214/usr/share/code/code")).toBe(true);
	expect(isSnapInstall("/usr/bin/code")).toBe(false);
	expect(isSnapInstall("/home/user/.vscode/cli/code")).toBe(false);
});

// ### Test: gui-display-is-private-end-to-end
// EM: Replaces rstudio-x11-connectivity-end-to-end, whose premise this
// EM: change inverts. That test asserted a real X client inside the sandbox
// EM: reached a real X server *outside* it, which was the behaviour ADR 0002
// EM: accepted and 0003 withdraws. Reaching the host's display is now the
// EM: failure, so the assertion is turned around rather than dropped: the
// EM: client gets a display, it is xpra's own virtual one inside the sandbox,
// EM: and the host's is unreachable from there.
// EM:
// EM: Still the one test that actually launches the sandbox rather than
// EM: inspecting --dry-run output, and for the same reason: it proves the
// EM: preset's binds genuinely produce a working display, not just that the
// EM: right-looking flags appear in a command line that is never executed.
// EM: Uses the same daemonize-then-exit fake pasta shim as the rest of the
// EM: suite (this environment's missing /dev/net/tun makes a real attach
// EM: non-deterministic, and what is under test is the display, not pasta),
// EM: plus a real disposable Xvfb standing in for "the host's X server".
// EM:
// EM: The tool name looked up in TOOL_PRESETS must literally be "rstudio" for
// EM: the preset to apply at all, so this skips entirely when a real rstudio
// EM: is installed rather than shadowing a genuine local install even
// EM: temporarily.
// EM: The marker is what stops a crashed run from silently disabling this
// EM: test forever. The fake is written to ~/.local/bin/rstudio and removed in
// EM: `finally`, but a killed run (bun's own test timeout kills dangling
// EM: processes) can leave it there — and since the guard below runs at import
// EM: time, a leftover fake would read as "a real rstudio is installed" and
// EM: skip the test on every subsequent run. A silently skipping test is worse
// EM: than a failing one, so the guard identifies scoder's own leftovers and
// EM: ignores them.
const FAKE_RSTUDIO_MARKER = "# scoder test fake rstudio";

async function realRstudioInstalled(): Promise<boolean> {
	if (!(await commandAvailable("rstudio"))) {
		return false;
	}
	try {
		const own = await Bun.file(`${process.env.HOME}/.local/bin/rstudio`).text();
		return !own.includes(FAKE_RSTUDIO_MARKER);
	} catch {
		return true;
	}
}

const xpraTestToolsAvailable =
	(await commandAvailable("xpra")) &&
	(await commandAvailable("Xvfb")) &&
	(await commandAvailable("xdpyinfo")) &&
	!(await realRstudioInstalled());

test.skipIf(!xpraTestToolsAvailable)(
	"gui-display-is-private-end-to-end: a GUI program in the sandbox gets xpra's virtual display and cannot reach the host's",
	async () => {
		const display = ":89";
		const xvfbProc = Bun.spawn(
			["Xvfb", display, "-screen", "0", "1024x768x24"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		// Polled rather than slept: Xvfb's startup time is not a constant, and
		// a fixed wait is either too short on a loaded machine or wasted on an
		// idle one.
		for (let i = 0; i < 60; i++) {
			const up = await Bun.spawn(["xdpyinfo", "-display", display], {
				stdout: "ignore",
				stderr: "ignore",
			}).exited;
			if (up === 0) {
				break;
			}
			await Bun.sleep(250);
		}

		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);
		const shimDir = await createFakePastaShim(
			`/tmp/scoder-xpra-e2e-${Date.now()}.log`,
		);
		// Must be named exactly "rstudio" — that literal string is the
		// TOOL_PRESETS lookup key. In ~/.local/bin because this test really
		// launches the sandbox, so the exec target has to be genuinely
		// reachable inside it.
		const fakeRstudioPath = `${process.env.HOME}/.local/bin/rstudio`;

		try {
			// Runs as xpra's --start-child, so it sees the DISPLAY xpra set
			// for its own virtual server. Writes its findings into the repo
			// dir, which is bound read-write, because its stdout goes to the
			// xpra log inside the sandbox's own tmpfs and dies with it.
			await Bun.write(
				fakeRstudioPath,
				[
					"#!/bin/bash",
					FAKE_RSTUDIO_MARKER,
					`xdpyinfo > ${repoDir}/xpra-display.txt 2>&1`,
					// The host's display, explicitly — the thing that must fail.
					`DISPLAY=${display} xdpyinfo > ${repoDir}/host-display.txt 2>&1`,
					`echo $? > ${repoDir}/host-display.status`,
					// EM: Stays up briefly so the host-side client has a live
					// EM: server to attach to. Without this the program exits
					// EM: in milliseconds, --exit-with-children tears the
					// EM: server down and the socket is removed before
					// EM: attachXpraClient gets there — which looks exactly
					// EM: like the bug this test now guards against. A real
					// EM: IDE does not have that problem.
					"sleep 6",
				].join("\n"),
			);
			await Bun.spawn(["chmod", "+x", fakeRstudioPath]).exited;

			const started = Date.now();
			// EM: Not -q, unlike the other end-to-end cases: the assertion
			// EM: below is on scoder's own "GUI attached" line, which is an
			// EM: info() and so is exactly what -q suppresses.
			const proc = Bun.spawn([SCODER_PATH, "--no-worktree", "rstudio"], {
				cwd: repoDir,
				env: {
					...process.env,
					PATH: `${shimDir}:${process.env.PATH}`,
					DISPLAY: display,
					SCODER_KEEP_SESSION_TMP: "1",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;
			const elapsedMs = Date.now() - started;
			const stderr = await new Response(proc.stderr).text();
			// EM: The xpra server's own output is in the session log now, not
			// EM: the terminal (a GUI primary logs like a companion — see
			// EM: gui-primary-output-goes-to-log), so the server-side lines
			// EM: below are checked in scoder's stderr plus that log.
			const xpraLogPath = stderr.match(
				/xpra log on the host: (\/tmp\/scoder-[0-9a-f]{8}\/tmp\/scoder-xpra\.log)/,
			)?.[1];
			const xpraLog = xpraLogPath
				? await Bun.file(xpraLogPath)
						.text()
						.catch(() => "")
				: "";
			if (xpraLogPath) {
				await removeSessionRoot(xpraLogPath);
			}
			const serverOut = `${stderr}\n${xpraLog}`;

			// EM: Surfaced on failure rather than swallowed: everything this
			// EM: test depends on (bwrap, the pasta shim, xpra's own startup)
			// EM: reports through scoder's stderr, and without this a failure
			// EM: shows up only as a missing output file.
			if (!(await fileExists(`${repoDir}/xpra-display.txt`))) {
				throw new Error(
					`GUI program produced no output; scoder said:\n${stderr}`,
				);
			}

			// EM: The host-side half, and the reason this assertion exists at
			// EM: all: the first version of this test checked only the GUI
			// EM: program's own output, which is produced inside the sandbox
			// EM: and says nothing about whether the client ever attached. It
			// EM: passed for a fortnight against a waitForXpraSocket that
			// EM: could never succeed — Bun.file().exists() is false for a
			// EM: unix socket — so every run silently burned the full 30s
			// EM: timeout and forwarded no windows at all. Reported from a
			// EM: real Eclipse session, not caught here.
			// EM:
			// EM: The elapsed-time bound is the other half of that lesson. The
			// EM: symptom visible in this suite was a 32s runtime that nobody
			// EM: questioned, so the timeout is now something the test fails
			// EM: on rather than something it waits through.
			expect(stderr).toContain("GUI attached");
			expect(elapsedMs).toBeLessThan(25_000);

			// EM: mmap is what makes the GUI usable rather than merely
			// EM: correct, and it is invisible when it silently stops working
			// EM: — reported directly as both IDEs being "too laggy to be
			// EM: useable", with everything else looking fine. It only
			// EM: negotiates because the shared directory is bound at the same
			// EM: absolute path on both sides, which is a property a later
			// EM: change could easily undo while everything still ran. The
			// EM: server logs this line to its own output, which in
			// EM: XPRA_TARGET=harness mode is scoder's.
			expect(serverOut).toContain("mmap transfers");

			// EM: And the two things that keep this session's inotify
			// EM: footprint at 1 instance instead of 8, out of the 128 the
			// EM: kernel allows per *user* — the budget RStudio exhausted with
			// EM: `system error 24 (Too many open files)`.
			expect(serverOut).not.toContain("watching for applications menu");

			// EM: --input-method=keep rather than =none. `none` does not mean
			// EM: "no input method": xpra reads it as "fall back to xim" and
			// EM: sets GTK_IM_MODULE=xim, which Eclipse's SWT warns is
			// EM: unsupported. Asserted because the difference between the two
			// EM: spellings is invisible until an IDE complains.
			expect(serverOut).not.toContain("GTK_IM_MODULE=xim");

			// The GUI program got a display, and it is xpra's own virtual one
			// inside the sandbox — not the host's :89.
			const xpraDisplay = await Bun.file(`${repoDir}/xpra-display.txt`).text();
			expect(xpraDisplay).toContain("name of display:");
			expect(xpraDisplay).not.toContain(`name of display:    ${display}`);

			// And the host's is unreachable from in there. This is the whole
			// security claim of xpra-gui-isolation, end to end.
			const hostStatus = (
				await Bun.file(`${repoDir}/host-display.status`).text()
			).trim();
			expect(hostStatus).not.toBe("0");
		} finally {
			await Bun.spawn(["rm", "-rf", shimDir]).exited;
			await Bun.spawn(["rm", "-f", fakeRstudioPath]).exited;
			xvfbProc.kill(9);
			await xvfbProc.exited;
			await Bun.spawn(["rm", "-f", "/tmp/.X89-lock"]).exited;
			await cleanupRepo(repoDir);
		}
	},
	// EM: Well past bun's 5s default, which this test does not fit in and
	// EM: the X11 one it replaced did: the xpra server takes ~3s to create
	// EM: its socket (measured, and the reason waitForXpraSocket polls rather
	// EM: than assuming), on top of Xvfb starting and a real sandbox launch.
	60_000,
);

// EM: ### Tests for --native-display (ADR 0005)
// EM: The mirror image of the xpra tests above: there, host X11 access is
// EM: the thing asserted ABSENT; here it is the thing asserted present — but
// EM: only under the flag, which is exactly why both halves exist. The
// EM: default-mode tests (gui-preset-binds-xpra-socket-not-host-x11 above,
// EM: ide-flag-merges-companion-binds below) are the regression guard for
// EM: "xpra is still the default" and are deliberately not edited.
// EM:
// EM: Placed after FAKE_RSTUDIO_MARKER/realRstudioInstalled (module-level
// EM: const in skipIf guards would hit their TDZ earlier in the file), and
// EM: before the --ide tests it also depends on nothing.

function flattenDryRun(output: string): string {
	// printBwrapCommand breaks lines at every --flag (" \\\n  " between
	// them); assertions that span a flag and its operands need the command
	// on one line. The match starts at the backslash, so the space before
	// it survives and wrapped segments come back joined by two spaces —
	// assertions spanning a wrap must use \s+ for that reason (operands on
	// one printed line keep their single space).
	return output.replace(/\\\n\s+/g, " ");
}

async function runScoderRaw(
	repoDir: string,
	args: string[],
	env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = await Bun.spawn([SCODER_PATH, ...args], {
		cwd: repoDir,
		env: { ...process.env, ...env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	return { code, stdout, stderr };
}

// EM: The native grants are conditional on host state a headless CI
// EM: container does not have: a desktop has /tmp/.X11-unix and an xauth
// EM: cookie, and scoder refuses the flag without a DISPLAY (checked by its
// EM: own test). Synthesising the pieces rather than skipping keeps these
// EM: assertions running in CI; create-if-missing / remove-if-we-made-it
// EM: leaves a real desktop host running the suite untouched.
async function createFakeX11HostState(): Promise<{
	cookiePath: string;
	cleanup: () => Promise<void>;
}> {
	const createdX11Dir = !(await dirExists("/tmp/.X11-unix"));
	if (createdX11Dir) {
		await Bun.spawn(["mkdir", "-p", "/tmp/.X11-unix"]).exited;
	}
	const cookieDir = `/tmp/scoder-fake-xauth-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	await Bun.spawn(["mkdir", "-p", cookieDir]).exited;
	const cookiePath = `${cookieDir}/cookie`;
	await Bun.write(cookiePath, "fake-xauth-cookie\n");
	return {
		cookiePath,
		cleanup: async () => {
			await Bun.spawn(["rm", "-rf", cookieDir]).exited;
			if (createdX11Dir) {
				await Bun.spawn(["rm", "-rf", "/tmp/.X11-unix"]).exited;
			}
		},
	};
}

// ### Test: native-display-grants-host-x11-with-private-bus
// EM: The direct form (`scoder rstudio`, no --ide): the X11 grant comes back
// EM: exactly as ADR 0002 shipped it and ADR 0003 withdrew it — plus the one
// EM: thing that was never allowed then and still is not: no host session
// EM: bus (ADR 0004). The cookie bind is the single-file carve-out ADR 0005
// EM: names; the two XAUTHORITY tests ADR 0003 deleted asserted its absence,
// EM: this one asserts its presence, and only under the flag.
test("native-display-grants-host-x11-with-private-bus: the flag grants host X11 to a GUI preset, wraps the tool in dbus-run-session, and keeps every /run and bus invariant", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("rstudio");
	const x11 = await createFakeX11HostState();

	try {
		const output = await runScoder(
			repoDir,
			["--native-display", "--dry-run", "rstudio"],
			{
				PATH: `${fakeBinDir}:${process.env.PATH}`,
				DISPLAY: ":42",
				XAUTHORITY: x11.cookiePath,
			},
		);
		const flat = flattenDryRun(output);

		// The grant: socket directory and cookie, both read-only; the cookie
		// normalised to one stable spelling in the sandbox's $HOME whatever
		// the host's path is (the GDM /run/user case).
		expect(flat).toContain("--ro-bind /tmp/.X11-unix /tmp/.X11-unix");
		expect(flat).toContain(
			`--ro-bind ${x11.cookiePath} ${SANDBOX_HOME}/.Xauthority`,
		);
		expect(flat).toContain("--setenv DISPLAY :42");
		expect(flat).toContain(`--setenv XAUTHORITY ${SANDBOX_HOME}/.Xauthority`);

		// Direct form: the private session bus is a wrap of the exec vector,
		// never an environment grant — and its wrapper is present. A GUI
		// primary now runs through the entry point so its output goes to
		// the session log (HARNESS_LOG), with the wrap as its harness argv.
		expect(flat).toMatch(
			/-- bash \/tmp\/scoder-entrypoint\.sh dbus-run-session\s+--\s+\S*rstudio/,
		);
		expect(flat).toContain("--setenv HARNESS_LOG /tmp/scoder-ide.log");
		expect(flat).not.toContain("--setenv DBUS_SESSION_BUS_ADDRESS");

		// The /run invariant the whole plan started from: tmpfs still there,
		// fresh /run/user/<uid> still created, and with the test cookie under
		// /tmp not one host /run path enters the command — the named
		// carve-out is a single file, never a directory, and never here.
		expect(flat).toContain("--tmpfs /run");
		expect(flat).toMatch(/--dir \/run\/user\/\d+/);
		expect(flat).not.toMatch(/--ro-bind \/run\//);
		expect(flat).not.toMatch(/--bind \/run\//);

		// xpra is entirely out of this path: no socket dir, no env. The
		// entry point *is* used now — not for a bus (still the exec-vector
		// wrap above) but so a GUI primary's output goes to the session log
		// rather than the terminal; Decision 5's "direct form direct-execs"
		// gave way to that.
		expect(flat).not.toContain("XPRA_SOCKET");
		expect(flat).not.toContain("XPRA_MMAP");
		expect(flat).not.toMatch(/--bind \/tmp\/scoder-[0-9a-f]{8}\/xpra/);
		expect(flat).not.toContain("--setenv DBUS_BUS");
	} finally {
		await x11.cleanup();
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: native-display-companion-bus-is-env-knob-not-argv-wrap
// EM: The companion form (`scoder pi --ide rstudio`): the bus moves from the
// EM: exec vector into the entry point's DBUS_BUS knob, because the measured
// EM: ENTER-handshake signals $! directly and dbus-run-session forwards no
// EM: signals (orphaning the child) — $! has to stay the IDE's real pid for
// EM: the per-IDE shutdown values to keep meaning what they measured. The
// EM: harness's argv stays exactly as composed.
test("native-display-companion-bus-is-env-knob-not-argv-wrap: --ide with the flag sets DBUS_BUS, wraps nothing, and passes no bus address", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");
	const rstudioDir = await createFakeToolDir("rstudio");
	const x11 = await createFakeX11HostState();

	try {
		const output = await runScoder(
			repoDir,
			[
				"--native-display",
				"--dry-run",
				"--no-worktree",
				"pi",
				"--ide",
				"rstudio",
			],
			{
				PATH: `${piDir}:${rstudioDir}:${process.env.PATH}`,
				DISPLAY: ":42",
				XAUTHORITY: x11.cookiePath,
			},
		);
		const flat = flattenDryRun(output);

		expect(flat).toContain("--setenv DBUS_BUS ide");
		expect(flat).not.toContain("dbus-run-session");
		// pi alone in the harness vector: the bus did not prepend anything
		// to the primary tool's argv.
		expect(flat).toContain("--setenv HARNESS_ARGC 1");

		// The companion gets the same native X11 grant the direct form does,
		// and xpra nothing at all.
		expect(flat).toContain("--ro-bind /tmp/.X11-unix /tmp/.X11-unix");
		expect(flat).toContain("--setenv DISPLAY :42");
		expect(flat).not.toContain("XPRA_SOCKET");
		expect(flat).not.toContain("XPRA_TARGET");
		expect(flat).not.toContain("--setenv DBUS_SESSION_BUS_ADDRESS");
		expect(flat).toContain("--tmpfs /run");
	} finally {
		await x11.cleanup();
		await Bun.spawn(["rm", "-rf", piDir, rstudioDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: native-display-requires-a-gui-preset
// EM: Silently accepting a flag that widens access is worse than refusing
// EM: it: the flag exists to NAME what it gives up, so in a session with no
// EM: GUI in it there is nothing for it to mean.
test("native-display-requires-a-gui-preset: a non-GUI session with the flag is a named error", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("pi");

	try {
		const { code, stderr } = await runScoderRaw(
			repoDir,
			["--native-display", "--dry-run", "pi"],
			{ PATH: `${fakeBinDir}:${process.env.PATH}` },
		);

		expect(code).toBe(1);
		expect(stderr).toContain(
			"--native-display only applies to a session running a GUI preset",
		);
		expect(stderr).toContain("rstudio");
	} finally {
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: native-display-warns-calibrated-to-the-display
// EM: The warning is ADR 0005's pricing section rendered at run time, and
// EM: the price differs by what is behind DISPLAY: Xorg grants read+XTEST
// EM: over every window (measured, ADR 0002); under XWayland the compositor
// EM: isolates Wayland-native windows and the grant covers the X ones. An
// EM: empty WAYLAND_DISPLAY takes the Xorg wording — falsy is falsy for the
// EM: branch, and the test environment may legitimately carry either.
test("native-display-warns-calibrated-to-the-display: the grant is named on both Xorg and XWayland hosts", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const fakeBinDir = await createFakeToolDir("rstudio");
	const x11 = await createFakeX11HostState();

	try {
		const baseEnv = {
			PATH: `${fakeBinDir}:${process.env.PATH}`,
			DISPLAY: ":42",
			XAUTHORITY: x11.cookiePath,
		};

		const xorg = await runScoderRaw(
			repoDir,
			["--native-display", "--dry-run", "rstudio"],
			{ ...baseEnv, WAYLAND_DISPLAY: "" },
		);
		expect(xorg.code).toBe(0);
		expect(xorg.stderr).toContain(
			"the GUI runs on the host's own X session, not a private one",
		);
		expect(xorg.stderr).toContain(
			"inject input into every window on this X session",
		);

		const wayland = await runScoderRaw(
			repoDir,
			["--native-display", "--dry-run", "rstudio"],
			{ ...baseEnv, WAYLAND_DISPLAY: "wayland-0" },
		);
		expect(wayland.code).toBe(0);
		expect(wayland.stderr).toContain("XWayland");
		// The alternative is named in both spellings — the flag is an
		// opt-out, not a recommendation.
		expect(wayland.stderr).toContain(
			"xpra forwards only this session's windows",
		);
	} finally {
		await x11.cleanup();
		await Bun.spawn(["rm", "-rf", fakeBinDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: entrypoint-invocation-dbus-bus-knob
test("entrypoint-invocation-dbus-bus-knob: DBUS_BUS reaches the entry point only for the native companion form, and changes no argv", () => {
	const plain = buildEntrypointInvocation("pi", [], "rstudio", []);
	expect(plain.env.DBUS_BUS).toBeUndefined();

	const busied = buildEntrypointInvocation(
		"pi",
		[],
		"rstudio",
		[],
		DEFAULT_IDE_SHUTDOWN,
		undefined,
		"ide",
	);
	expect(busied.env.DBUS_BUS).toBe("ide");
	expect(busied.argv).toEqual(plain.argv);
});

// ### Test: entrypoint-log-host-visible
// EM: The log used to live only on the sandbox's private /tmp tmpfs — the
// EM: one file holding a misbehaving GUI's output, readable only from
// EM: inside the session whose GUI was misbehaving. Now it is a staged
// EM: file bound rw at the same sandbox dest: the same path inside, a real
// EM: path outside, and the startup banner names the host half. One log
// EM: per session shape (builder.ts, entrypointLogDest): xpra swallows the
// EM: IDE's output into its own log, so the xpra form stages only that.
test("entrypoint-log-host-visible: the session log is a staged file bound at its sandbox path and named on the host at startup", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");
	const rstudioDir = await createFakeToolDir("rstudio");
	const x11 = await createFakeX11HostState();
	const kept: string[] = [];

	try {
		// EM: The xpra form (GUI preset, no --native-display).
		const xpraRun = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "rstudio"],
			{
				PATH: `${rstudioDir}:${process.env.PATH}`,
				SCODER_KEEP_SESSION_TMP: "1",
			},
		);
		const flat = flattenDryRun(xpraRun.stdout);
		const bind = flat.match(
			/--bind (\/tmp\/scoder-[0-9a-f]{8}\/tmp\/scoder-xpra\.log) \/tmp\/scoder-xpra\.log/,
		);
		expect(bind).not.toBeNull();
		kept.push(bind![1]);
		// EM: Ordering is load-bearing: the bind must land on the sandbox's
		// EM: own tmpfs /tmp, not be shadowed by it.
		expect(flat.indexOf("--tmpfs /tmp")).toBeLessThan(flat.indexOf(bind![0]));
		// EM: Bound and staged, not just named in the command: the source
		// EM: exists for bwrap before bwrap runs.
		expect(await Bun.file(bind![1]).exists()).toBe(true);
		// EM: xpra's log covers the IDE too: no IDE-log bind. (The IDE_LOG
		// EM: env stays set — entrypoint.sh takes defaults for everything and
		// EM: ignores it under xpra — so the assertion is about the bind.)
		expect(flat).not.toMatch(/--bind \S+scoder-ide\.log/);
		expect(xpraRun.stderr).toContain("xpra log on the host:");
		expect(xpraRun.stderr).toContain("/tmp/scoder-xpra.log");

		// EM: The native companion form: no xpra, so the IDE log is the one.
		const nativeRun = await runScoderRaw(
			repoDir,
			[
				"--native-display",
				"--dry-run",
				"--no-worktree",
				"pi",
				"--ide",
				"rstudio",
			],
			{
				PATH: `${piDir}:${rstudioDir}:${process.env.PATH}`,
				DISPLAY: ":42",
				XAUTHORITY: x11.cookiePath,
				SCODER_KEEP_SESSION_TMP: "1",
			},
		);
		const nativeFlat = flattenDryRun(nativeRun.stdout);
		const ideBind = nativeFlat.match(
			/--bind (\/tmp\/scoder-[0-9a-f]{8}\/tmp\/scoder-ide\.log) \/tmp\/scoder-ide\.log/,
		);
		expect(ideBind).not.toBeNull();
		kept.push(ideBind![1]);
		expect(await Bun.file(ideBind![1]).exists()).toBe(true);
		expect(nativeFlat).not.toMatch(/--bind \S+scoder-xpra\.log/);
		expect(nativeRun.stderr).toContain("IDE log on the host:");

		// EM: And no log bind at all where there is no entry point: a plain
		// EM: CLI session stages neither name.
		const cliRun = await runScoder(
			repoDir,
			["--dry-run", "--no-worktree", "pi"],
			{
				PATH: `${piDir}:${process.env.PATH}`,
			},
		);
		expect(cliRun).not.toContain("scoder-ide.log");
		expect(cliRun).not.toContain("scoder-xpra.log");
	} finally {
		for (const path of kept) {
			await removeSessionRoot(path);
		}
		await x11.cleanup();
		await Bun.spawn(["rm", "-rf", piDir, rstudioDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: native-display-entrypoint-bus-beside-ide
// EM: The script-level contract of Decision 5: beside the IDE, not above
// EM: it. The bus address prefixes the IDE's launch line only (so the
// EM: harness stays bus-less and $! stays the IDE's real pid), and the
// EM: daemon is killed once the IDE is gone.
test("native-display-entrypoint-bus-beside-ide: the companion bus is an env prefix on the IDE's line, never an export and never a wrapper", async () => {
	const script = await Bun.file(ENTRYPOINT_SRC).text();

	// biome-ignore-start lint/suspicious/noTemplateCurlyInString: these are
	// literal bash "${...}" references from entrypoint.sh, not forgotten JS
	// template placeholders — plain strings, never interpolated.
	expect(script).toContain('DBUS_SESSION_BUS_ADDRESS="$BUS_ADDRESS"');
	expect(script).not.toContain("export DBUS_SESSION_BUS_ADDRESS");
	expect(script).toContain('kill "$BUS_PID"');
	// The measured no-signal-forwarding wrapper must not be *invoked*
	// here (the rationale comment names it, so presence is not the
	// test — being the start of a command line is) — that is the direct
	// form's mechanism only.
	expect(script).not.toMatch(/^\s*dbus-run-session/m);
	// biome-ignore-end lint/suspicious/noTemplateCurlyInString: see above
});

// ### Test: native-display-private-bus-runs-in-sandbox
// EM: The runtime half of the direct form, where the container allows it:
// EM: a real sandbox launch of a fake GUI tool through the dbus-run-session
// EM: wrap, asserting the child really got a private bus and that its exit
// EM: status survived the wrap (the property that makes the wrapper safe in
// EM: the direct form and, per the measurement, unsafe in the companion
// EM: one). DISPLAY :42 has no server — the fake never connects; what's
// EM: under test is the bus and the status, not the display round-trip,
// EM: which the real-desktop checklist carries.
test.skipIf(
	!(await commandAvailable("bwrap")) ||
		!(await commandAvailable("dbus-run-session")) ||
		(await realRstudioInstalled()),
)(
	"native-display-private-bus-runs-in-sandbox: the wrapped child gets a private bus and its exit status propagates",
	async () => {
		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);
		const shimDir = await createFakePastaShim(
			`/tmp/scoder-native-e2e-${Date.now()}.log`,
		);
		const x11 = await createFakeX11HostState();
		const fakeRstudioPath = `${process.env.HOME}/.local/bin/rstudio`;

		try {
			await Bun.write(
				fakeRstudioPath,
				[
					"#!/bin/bash",
					FAKE_RSTUDIO_MARKER,
					`echo "$DBUS_SESSION_BUS_ADDRESS" > ${repoDir}/dbus-env.txt`,
					`echo "display=$DISPLAY" > ${repoDir}/display.txt`,
					"exit 42",
				].join("\n"),
			);
			await Bun.spawn(["chmod", "+x", fakeRstudioPath]).exited;

			const { code } = await runScoderRaw(
				repoDir,
				["--native-display", "--no-worktree", "rstudio"],
				{
					PATH: `${shimDir}:${process.env.PATH}`,
					DISPLAY: ":42",
					XAUTHORITY: x11.cookiePath,
				},
			);

			// 42 travelled child -> dbus-run-session -> bwrap -> scoder.
			// The measurement, run through the real stack this time.
			expect(code).toBe(42);

			const busAddress = (await Bun.file(`${repoDir}/dbus-env.txt`)).text();
			const address = (await busAddress).trim();
			expect(address.length).toBeGreaterThan(0);
			expect(address).toStartWith("unix:");
			// Private: wherever it landed (the sandbox's own /run/user on the
			// tmpfs, or its /tmp fallback), it is a sandbox path — the host
			// session bus address was never passed in, and the container's
			// environment does not even have one to echo.
			expect(
				(address.includes("/tmp/") && address.includes("dbus")) ||
					address.includes("/run/user/"),
			).toBe(true);

			expect(await Bun.file(`${repoDir}/display.txt`).text()).toContain(
				"display=:42",
			);
		} finally {
			await Bun.spawn(["rm", "-f", fakeRstudioPath]).exited;
			await Bun.spawn(["rm", "-rf", shimDir]).exited;
			await x11.cleanup();
			await cleanupRepo(repoDir);
		}
	},
	30_000,
);

// EM: ### Tests for --ide (companion IDE alongside the primary tool)
// EM: See design/features/ide-companion.md. Uses fake pi/rstudio binaries
// EM: (same reasoning as the rstudio-preset dry-run tests above — what's
// EM: under test is scoder's own orchestration, not either real tool's
// EM: behaviour) except for the one real end-to-end test, which needs
// EM: genuinely separate foreground/background processes and so needs
// EM: ~/.local/bin, guarded against shadowing a real local install of
// EM: either tool.

// ### Test: ide-flag-merges-companion-binds
test("ide-flag-merges-companion-binds: --ide merges the companion's binds into the one sandbox, deduplicated", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");
	const rstudioDir = await createFakeToolDir("rstudio");

	try {
		const output = await runScoder(
			repoDir,
			["--dry-run", "--no-worktree", "pi", "--ide", "rstudio"],
			{ PATH: `${piDir}:${rstudioDir}:${process.env.PATH}` },
		);

		// The companion is a GUI preset, so its display bind is one of the
		// things that has to make it into the merged sandbox.
		expect(output).toContain("--setenv XPRA_SOCKET ");

		const piDataBind = `--bind ${process.env.HOME}/.local/share/pi ${SANDBOX_HOME}/.local/share/pi`;
		expect(output).toContain(piDataBind);
		// pi's own preset and rstudio's (which also includes pi's binds, so
		// pi works from RStudio's embedded terminal too) both contribute
		// this exact entry — must appear once, not twice.
		expect(output.split(piDataBind).length - 1).toBe(1);
	} finally {
		await Bun.spawn(["rm", "-rf", piDir, rstudioDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: ide-flag-works-before-or-after-tool-name
test("ide-flag-works-before-or-after-tool-name: --ide is recognised whether it comes before or after the tool name", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");
	const rstudioDir = await createFakeToolDir("rstudio");
	const env = { PATH: `${piDir}:${rstudioDir}:${process.env.PATH}` };

	try {
		const idAfter = await runScoder(
			repoDir,
			["--dry-run", "--no-worktree", "pi", "--ide", "rstudio"],
			env,
		);
		const idBefore = await runScoder(
			repoDir,
			["--dry-run", "--ide", "rstudio", "--no-worktree", "pi"],
			env,
		);

		// Not a full-output comparison — each run's temp file names (the
		// local-bin snapshot, the AGENTS.md overlay, ...) are freshly
		// randomised, so the two outputs are never byte-identical even for
		// the same flags. What --ide's position must not change is whether
		// the companion's own binds and the background/foreground wrapper
		// are present at all.
		for (const output of [idAfter, idBefore]) {
			expect(output).toContain("--setenv XPRA_SOCKET ");
			expect(output).toContain("--setenv XPRA_TARGET ide");
			expect(output).toContain("/tmp/scoder-entrypoint.sh");
		}
	} finally {
		await Bun.spawn(["rm", "-rf", piDir, rstudioDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: bind-preset-adds-paths-without-launching
// EM: --bind is --ide's merge without --ide's process: the bound preset's
// EM: config binds join the sandbox, and the exec target stays the primary
// EM: tool alone, with no entry point. Accepted on either side of the tool
// EM: name. A throwaway HOME, so ~/.claude here is a fixture, never the
// EM: developer's own.
test("bind-preset-adds-paths-without-launching: --bind claude adds Claude Code's binds to pi's sandbox, before or after the tool name, and launches only pi", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");
	const fakeHome = `/tmp/scoder-bind-fake-home-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const env = { PATH: `${piDir}:${process.env.PATH}`, HOME: fakeHome };

	try {
		await Bun.write(`${fakeHome}/.claude/settings.json`, "{}");
		await Bun.write(`${fakeHome}/.claude.json`, "{}");

		const after = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "pi", "--bind", "claude"],
			env,
		);
		const before = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "--bind=claude", "pi"],
			env,
		);

		for (const run of [after, before]) {
			expect(run.code).toBe(0);
			const flat = flattenDryRun(run.stdout);
			expect(flat).toContain(`--bind ${fakeHome}/.claude ${fakeHome}/.claude`);
			expect(flat).toContain(
				`--ro-bind ${fakeHome}/.claude.json ${fakeHome}/.claude.json`,
			);
			// pi's own binds are still there: the bound preset adds, never
			// replaces.
			expect(flat).toContain(
				`--bind ${fakeHome}/.local/share/pi ${fakeHome}/.local/share/pi`,
			);
			// Only pi runs: no entry point, and --bind is not in pi's argv.
			expect(flat).not.toContain("scoder-entrypoint.sh");
			expect(flat).toContain(`-- ${piDir}/pi\n`);
			expect(run.stderr).toContain("Binding Claude Code's paths");
		}
	} finally {
		await Bun.spawn(["rm", "-rf", piDir, fakeHome]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: bind-flag-passes-through-non-preset-values
// EM: --bind is a common flag in other tools (`python -m http.server
// EM: --bind 0.0.0.0`), so after the tool name it is claimed only when its
// EM: value names a preset. Anything else is the tool's own argv, intact.
test("bind-flag-passes-through-non-preset-values: after the tool name, --bind with a non-preset value is left in the tool's argv", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");

	try {
		const run = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "pi", "--bind", "0.0.0.0", "--bind=::1"],
			{ PATH: `${piDir}:${process.env.PATH}` },
		);
		expect(run.code).toBe(0);
		// The printer wraps before every "--"-prefixed argument, hence \s+.
		expect(flattenDryRun(run.stdout)).toMatch(
			new RegExp(`-- ${piDir}/pi\\s+--bind 0\\.0\\.0\\.0\\s+--bind=::1\n`),
		);
		expect(run.stderr).not.toContain("Binding");
	} finally {
		await Bun.spawn(["rm", "-rf", piDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: bind-flag-refuses-gui-and-unknown-presets
// EM: Before the tool name nothing is ambiguous, so an unknown name is an
// EM: error, not a silent no-op. A GUI preset is refused at either
// EM: position: its binds include a display grant that only makes sense
// EM: with its GUI running, which is what --ide is for.
test("bind-flag-refuses-gui-and-unknown-presets: --bind names a GUI preset or no preset at all, and scoder says so", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");
	const env = { PATH: `${piDir}:${process.env.PATH}` };

	try {
		const gui = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "pi", "--bind", "rstudio"],
			env,
		);
		expect(gui.code).not.toBe(0);
		expect(gui.stderr).toContain("--bind rstudio: rstudio is a GUI preset");
		expect(gui.stderr).toContain("use --ide rstudio");

		const unknown = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "--bind", "nosuchtool", "pi"],
			env,
		);
		expect(unknown.code).not.toBe(0);
		expect(unknown.stderr).toContain(
			"no preset registered for --bind nosuchtool",
		);
	} finally {
		await Bun.spawn(["rm", "-rf", piDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: scoder-bind-env-adds-presets
// EM: SCODER_BIND is --bind from the environment: names separated by commas
// EM: or spaces, added to any --bind flags (a preset named by both is bound
// EM: once), held to the same rules, and an error names SCODER_BIND rather
// EM: than a flag the user never typed. Throwaway HOME, as for --bind.
test("scoder-bind-env-adds-presets: SCODER_BIND binds the named presets alongside --bind, once each, and its errors name SCODER_BIND", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");
	const fakeHome = `/tmp/scoder-bind-fake-home-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	const env = { PATH: `${piDir}:${process.env.PATH}`, HOME: fakeHome };

	try {
		await Bun.write(`${fakeHome}/.claude/settings.json`, "{}");
		await Bun.write(`${fakeHome}/.copilot/config.json`, "{}");

		const run = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "--bind", "claude", "pi"],
			{ ...env, SCODER_BIND: "claude, copilot" },
		);
		expect(run.code).toBe(0);
		const flat = flattenDryRun(run.stdout);
		const claudeBind = `--bind ${fakeHome}/.claude ${fakeHome}/.claude`;
		expect(flat).toContain(claudeBind);
		expect(flat.split(claudeBind).length - 1).toBe(1);
		expect(flat).toContain(`--bind ${fakeHome}/.copilot ${fakeHome}/.copilot`);
		expect(flat).toContain(`-- ${piDir}/pi\n`);
		expect(run.stderr).toContain("Binding Claude Code's paths");
		expect(run.stderr).toContain("Binding GitHub Copilot CLI's paths");

		const gui = await runScoderRaw(
			repoDir,
			["--dry-run", "--no-worktree", "pi"],
			{ ...env, SCODER_BIND: "rstudio" },
		);
		expect(gui.code).not.toBe(0);
		expect(gui.stderr).toContain(
			"SCODER_BIND rstudio: rstudio is a GUI preset",
		);
	} finally {
		await Bun.spawn(["rm", "-rf", piDir, fakeHome]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: ide-must-differ-from-primary-tool
test("ide-must-differ-from-primary-tool: --ide naming the same tool as the primary fails clearly", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const rstudioDir = await createFakeToolDir("rstudio");

	try {
		const proc = await Bun.spawn(
			[
				SCODER_PATH,
				"-q",
				"--dry-run",
				"--no-worktree",
				"rstudio",
				"--ide",
				"rstudio",
			],
			{
				env: { ...process.env, PATH: `${rstudioDir}:${process.env.PATH}` },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		await proc.exited;

		expect(proc.exitCode).not.toBe(0);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain("--ide must be different from the primary tool");
	} finally {
		await Bun.spawn(["rm", "-rf", rstudioDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: ide-requires-registered-preset
test("ide-requires-registered-preset: --ide naming a tool with no preset fails clearly", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const piDir = await createFakeToolDir("pi");

	try {
		const proc = await Bun.spawn(
			[
				SCODER_PATH,
				"-q",
				"--dry-run",
				"--no-worktree",
				"pi",
				"--ide",
				"not-a-registered-preset",
			],
			{
				env: { ...process.env, PATH: `${piDir}:${process.env.PATH}` },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		await proc.exited;

		expect(proc.exitCode).not.toBe(0);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain(
			"no preset registered for --ide not-a-registered-preset",
		);
	} finally {
		await Bun.spawn(["rm", "-rf", piDir]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: ide-companion-background-then-primary-foreground-both-must-exit
// EM: The one real end-to-end test — proves the actual runtime property,
// EM: not just that the wrapper script looks right in --dry-run output:
// EM: the primary tool exits immediately, but scoder does not return until
// EM: the companion's own background job (an artificial sleep) has also
// EM: finished, and that job's own side effect (a marker file) is visible
// EM: afterward, proving it ran to completion rather than being cut short.
// EM: Also confirms scoder's own exit code is the primary tool's, not the
// EM: companion's, and that a "Waiting for attached IDE to close" notice
// EM: is printed when the primary tool (pi, here) exits well before the
// EM: IDE does — otherwise the wait blocks silently, indistinguishable
// EM: from a hang. Guarded against shadowing a real local pi/rstudio
// EM: install, same reasoning as the rstudio-x11-connectivity test above.
const ideE2eToolsAvailable =
	!(await commandAvailable("rstudio")) && !(await commandAvailable("pi"));

test.skipIf(!ideE2eToolsAvailable)(
	"ide-companion-background-then-primary-foreground-both-must-exit: scoder waits for both, reports the primary's exit code",
	async () => {
		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);
		const shimDir = await createFakePastaShim(
			`/tmp/scoder-ide-e2e-${Date.now()}.log`,
		);
		const fakeRstudioPath = `${process.env.HOME}/.local/bin/rstudio`;
		const fakePiPath = `${process.env.HOME}/.local/bin/pi`;

		try {
			await Bun.write(
				fakeRstudioPath,
				"#!/bin/bash\nsleep 2\ntouch ide-finished-marker\nexit 0\n",
			);
			await Bun.write(fakePiPath, "#!/bin/bash\necho pi-ran\nexit 7\n");
			await Bun.spawn(["chmod", "+x", fakeRstudioPath, fakePiPath]).exited;

			const start = Date.now();
			const proc = Bun.spawn(
				[
					SCODER_PATH,
					"-q",
					"--no-worktree",
					"/bin/bash",
					"-c",
					"sleep 300",
					"--ide",
					"rstudio",
				],
				{
					cwd: repoDir,
					env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			await proc.exited;
			const elapsedMs = Date.now() - start;

			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			expect(stdout).toContain("pi-ran");
			expect(stderr).toContain("Waiting for attached IDE to close");
			expect(proc.exitCode).toBe(7);
			expect(elapsedMs).toBeGreaterThanOrEqual(1900);
			expect(await fileExists(`${repoDir}/ide-finished-marker`)).toBe(true);
		} finally {
			await Bun.spawn(["rm", "-rf", shimDir]).exited;
			await Bun.spawn(["rm", "-f", fakeRstudioPath, fakePiPath]).exited;
			await cleanupRepo(repoDir);
		}
	},
);

// ### entrypointCommand
// The command and environment that bwrap would exec for an --ide session,
// runnable directly on the host.
//
// EM: The behaviour under test lives in src/sandbox/entrypoint.sh, which is a
// EM: real file rather than a generated string — so these tests run that exact
// EM: file, not a copy. Running it outside a sandbox is the point: the script
// EM: is plain bash, and a real IDE cannot be launched in CI. What bwrap adds
// EM: (the --setenv pairs, the read-only bind) is what `env` and the path
// EM: stand in for here.
const ENTRYPOINT_SRC = `${import.meta.dir}/../src/sandbox/entrypoint.sh`;

function entrypointCommand(
	toolBin: string,
	toolArgs: string[],
	ideBin: string,
	ideArgs: string[],
	ideShutdown?: IdeShutdown,
	xpra?: XpraWrap,
): { cmd: string[]; env: Record<string, string> } {
	const entry = buildEntrypointInvocation(
		toolBin,
		toolArgs,
		ideBin,
		ideArgs,
		ideShutdown,
		xpra,
	);
	return {
		cmd: ["bash", ENTRYPOINT_SRC, ...entry.argv],
		env: { ...process.env, ...entry.env } as Record<string, string>,
	};
}

// ### spawnWithDelayedEnter
// Spawns cmd with "\n" written to stdin after a short delay, rather than
// pre-supplied as a Blob. entrypoint.sh runs the IDE under `setsid` (see
// its own comment there), which adds real fork/exec latency before the
// IDE's own script starts running at all — a pre-buffered stdin Blob can
// be consumed by the wrapper's `read -r -t 1` loop before that finishes,
// racing the IDE's own startup. Confirmed directly: this raced a real test
// flaky (`ide-shutdown-process-first-leaves-children-alone`), and a delay
// here matches how a real user behaves anyway — nobody presses ENTER
// within milliseconds of the IDE launching.
function spawnWithDelayedEnter(
	cmd: string[],
	env?: Record<string, string>,
	delayMs = 300,
): ReturnType<typeof Bun.spawn> {
	const proc = Bun.spawn(cmd, {
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	(async () => {
		await Bun.sleep(delayMs);
		proc.stdin.write("\n");
		await proc.stdin.end();
	})();
	return proc;
}

// ### Test: sandbox-processes-reaped-when-session-dies
// EM: Regression test for a leak that produced seven accumulated RStudio
// EM: instances on one machine, each carrying an Electron stack, an rsession,
// EM: a Tomcat and a language server.
// EM:
// EM: scoder does not unshare the PID namespace — pasta attaches to the
// EM: network namespace from outside, see ADR 0001 — so bwrap's
// EM: --die-with-parent reaches only its own immediate child. entrypoint.sh
// EM: starts the companion under `setsid`, deliberately, so that an IDE
// EM: keeping its controlling terminal cannot write crash handlers into the
// EM: agent's session. A setsid process is reparented to init when its parent
// EM: dies, so it outlives the sandbox. Verified directly before the fix: a
// EM: setsid child wrote its marker file eight seconds after bwrap exited.
// EM:
// EM: Asserts that NOTHING remains in the sandbox's mount namespace, rather
// EM: than that one tracked pid is gone. That is the real contract, and the
// EM: difference is not academic: an earlier fix tracked the IDE's pid and
// EM: signalled its process group, which left xpra's Xvfb and its dbus-daemon
// EM: running every time, because xpra forks both into sessions of their own.
test.skipIf(
	!(await commandAvailable("bwrap")) || (await realRstudioInstalled()),
)(
	"sandbox-processes-reaped-when-session-dies: nothing outlives the sandbox",
	async () => {
		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);
		const shimDir = await createFakePastaShim(
			`/tmp/scoder-reap-e2e-${Date.now()}.log`,
		);
		// Long-lived on purpose: the point is that it is still running when
		// the session ends, which is exactly when the leak used to happen.
		// In ~/.local/bin because checkExecTargetReachable rejects an exec
		// target whose directory is not bound into the sandbox.
		const fakeIde = `${process.env.HOME}/.local/bin/rstudio`;
		await Bun.write(
			fakeIde,
			`#!/bin/sh\n${FAKE_RSTUDIO_MARKER}\nexec sleep 300\n`,
		);
		await Bun.spawn(["chmod", "+x", fakeIde]).exited;

		try {
			// Only the companion needs a preset, so the primary tool is just a
			// long-running shell and no second fake is needed.
			const proc = Bun.spawn(
				[
					SCODER_PATH,
					"-q",
					"--no-worktree",
					"/bin/bash",
					"-c",
					"sleep 300",
					"--ide",
					"rstudio",
				],
				{
					cwd: repoDir,
					env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);

			let sandboxNs = "";
			for (let i = 0; i < 300; i++) {
				sandboxNs = await findSandboxNamespace();
				if (sandboxNs) {
					break;
				}
				if (proc.exitCode !== null) {
					break;
				}
				await Bun.sleep(100);
			}
			if (!sandboxNs) {
				throw new Error(
					`no sandbox namespace appeared; scoder said:\n${await new Response(proc.stderr).text()}`,
				);
			}
			expect(pidsInNamespace(sandboxNs).length).toBeGreaterThan(0);

			// Two SIGINTs: the documented force-kill path, and how a user
			// actually abandons a session. A single one forwards into the
			// sandbox, after which the entrypoint waits for the IDE — which is
			// the whole point of a companion and would never return.
			//
			// Not SIGTERM or SIGKILL: scoder handles neither (FORWARDED_SIGNALS
			// covers SIGWINCH, SIGINT, SIGQUIT and SIGTSTP), so both terminate
			// it outright and no teardown runs at all. Those gaps are recorded
			// in the feature doc rather than pretended away here.
			proc.kill("SIGINT");
			await Bun.sleep(200);
			proc.kill("SIGINT");
			await proc.exited;

			for (let i = 0; i < 100 && pidsInNamespace(sandboxNs).length > 0; i++) {
				await Bun.sleep(100);
			}
			expect(pidsInNamespace(sandboxNs)).toEqual([]);
		} finally {
			await Bun.spawn(["rm", "-rf", shimDir]).exited;
			await Bun.spawn(["rm", "-f", fakeIde]).exited;
			await cleanupRepo(repoDir);
		}
	},
	60_000,
);

// ### pidsInNamespace
// Our own pids currently in the given mount namespace. Mirrors
// ourPidsInNamespace in src/sandbox/launch.ts; unreadable entries are skipped
// because /proc lists processes that are not ours.
function pidsInNamespace(nsId: string): number[] {
	const pids: number[] = [];
	const uid = process.getuid?.() ?? -1;
	for (const entry of readdirSync("/proc")) {
		const pid = Number.parseInt(entry, 10);
		if (Number.isNaN(pid) || pid === process.pid) {
			continue;
		}
		try {
			if (statSync(`/proc/${pid}`).uid !== uid) {
				continue;
			}
			if (readlinkSync(`/proc/${pid}/ns/mnt`) === nsId) {
				pids.push(pid);
			}
		} catch {
			// Not ours, or gone mid-scan.
		}
	}
	return pids;
}

// ### findSandboxNamespace
// The mount namespace of the fake IDE this test launched, found by its marker
// rather than by a pid the test could know in advance.
async function findSandboxNamespace(): Promise<string> {
	const uid = process.getuid?.() ?? -1;
	for (const entry of readdirSync("/proc")) {
		const pid = Number.parseInt(entry, 10);
		if (Number.isNaN(pid)) {
			continue;
		}
		try {
			if (statSync(`/proc/${pid}`).uid !== uid) {
				continue;
			}
			// EM: argv[0], not a substring of the whole command line. scoder
			// EM: nests two bwrap layers, and the outer one's argv contains
			// EM: the entire inner command — including this sleep — so a
			// EM: substring match returns the OUTER layer's namespace, which
			// EM: is not where the sandboxed processes live. That made this
			// EM: test pass against a deliberately broken reaper.
			const argv = (await Bun.file(`/proc/${pid}/cmdline`).text()).split("\0");
			if (argv[0] !== "sleep" || argv[1] !== "300") {
				continue;
			}
			const ns = readlinkSync(`/proc/${pid}/ns/mnt`);
			if (ns !== readlinkSync("/proc/self/ns/mnt")) {
				return ns;
			}
		} catch {
			// Not ours, or gone mid-scan.
		}
	}
	return "";
}

// ### Test: ide-companion-enter-requests-ide-shutdown
// EM: Reported directly: when the primary tool exits first, the terminal is
// EM: left showing whatever the agent's full-screen TUI last rendered, and
// EM: with several IDE windows open it is not obvious which one this terminal
// EM: is waiting on. ENTER now asks that IDE to close — which also identifies
// EM: it, since the window that disappears is the attached one. Exercises the
// EM: generated script directly rather than through a sandbox: the wrapper is
// EM: plain bash, and a real IDE cannot be launched in CI. The fake IDE forks
// EM: a child and waits on it, the shape of a launcher like Eclipse's around
// EM: its JVM — the child must be signalled too, or the JVM is orphaned and
// EM: its window stays on screen.
test("ide-companion-enter-requests-ide-shutdown: ENTER closes the IDE and its children, keeping the primary tool's exit code", async () => {
	const pidFile = `/tmp/scoder-ide-child-${Date.now()}.pid`;

	try {
		const { cmd, env } = entrypointCommand(
			"/bin/bash",
			["-c", "exit 7"],
			"/bin/bash",
			["-c", `sleep 120 & echo $! > ${pidFile}; wait`],
		);

		const start = Date.now();
		const proc = spawnWithDelayedEnter(cmd, env);
		await proc.exited;
		const elapsedMs = Date.now() - start;
		const stderr = await new Response(proc.stderr).text();

		// The primary tool's status, not the IDE's, even though the IDE was
		// signalled rather than left to finish.
		expect(proc.exitCode).toBe(7);
		// Nowhere near the IDE's own 120s: ENTER ended the wait.
		expect(elapsedMs).toBeLessThan(15000);
		expect(stderr).toContain("Waiting for attached IDE to close");
		expect(stderr).toContain("Asking bash to close");

		const childPid = (await Bun.file(pidFile).text()).trim();
		const stillAlive = await Bun.spawn(["kill", "-0", childPid], {
			stdout: "ignore",
			stderr: "ignore",
		}).exited;
		expect(stillAlive).not.toBe(0);
	} finally {
		await Bun.spawn(["rm", "-f", pidFile]).exited;
	}
});

// ### Test: ide-companion-waits-out-ide-without-stdin
// EM: The read loop is deliberately not gated on stdin being a tty — only the
// EM: prompt is — so a closed or /dev/null stdin must fall straight through to
// EM: the plain `wait` this did before, not spin on EOF or exit early.
test("ide-companion-waits-out-ide-without-stdin: with no stdin the wrapper waits for the IDE exactly as before", async () => {
	const { cmd, env } = entrypointCommand(
		"/bin/bash",
		["-c", "exit 5"],
		"/bin/bash",
		["-c", "sleep 2"],
	);

	const start = Date.now();
	const proc = Bun.spawn(cmd, {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	const elapsedMs = Date.now() - start;
	const stderr = await new Response(proc.stderr).text();

	expect(proc.exitCode).toBe(5);
	expect(elapsedMs).toBeGreaterThanOrEqual(1900);
	expect(stderr).toContain("Waiting for attached IDE to close");
	// No tty, so no prompt for a key nobody can press.
	expect(stderr).not.toContain("Press ENTER");
});

// ### Test: ide-companion-clears-screen-not-scrollback
// EM: The clear exists because the agent TUI's last frame otherwise sits there
// EM: looking live. Scrollback is deliberately kept (no ESC[3J) — the session
// EM: transcript is still worth having — and the escape is guarded on stderr
// EM: being a tty so a redirected IDE log never collects control codes.
test("ide-companion-clears-screen-not-scrollback: the wrapper clears the screen, guarded on a tty, and keeps scrollback", async () => {
	const script = await Bun.file(ENTRYPOINT_SRC).text();

	expect(script).toContain("[ -t 2 ] && printf '\\033[H\\033[2J' >&2");
	// EM: The escape itself, not the bare "[3J" an earlier version of this
	// EM: assertion used — the script's own comment explains why scrollback is
	// EM: kept and says "ESC[3J" in prose, which that looser form matched.
	expect(script).not.toContain("\\033[3J");
	expect(script).toContain("Press ENTER");
});

// ### Test: ide-companion-detached-from-controlling-terminal
// Reported directly: error output from the IDE appeared on the console
// mid-session despite the existing >"$IDE_LOG" 2>&1 redirect — a JVM's
// native crash handler or a GTK/X11 error dialog can write straight to
// /dev/tty (the controlling terminal) rather than its own inherited
// stdout/stderr, which redirecting fds 1 and 2 alone does not catch.
// setsid makes the IDE its own session leader with no controlling
// terminal at all, so a direct /dev/tty open from inside it fails
// instead of reaching the visible console — and stdin is also
// redirected from /dev/null, not left shared with the primary tool's
// own inherited stdin.
test("ide-companion-detached-from-controlling-terminal: the IDE is spawned under setsid with stdin from /dev/null", async () => {
	const script = await Bun.file(ENTRYPOINT_SRC).text();

	// EM: Both spawn sites, not just one: the script has a direct-exec branch
	// EM: and an xpra branch, and the detachment has to hold on both. An
	// EM: earlier draft detached only the direct one, which would have quietly
	// EM: reopened this for exactly the GUI presets the report came from.
	// biome-ignore-start lint/suspicious/noTemplateCurlyInString: these are
	// literal bash "${...}" references from entrypoint.sh, not forgotten JS
	// template placeholders — plain strings, never interpolated.
	expect(script).toContain(
		'setsid "${IDE_ARGV[@]}" </dev/null >"$XPRA_LOG" 2>&1 &',
	);
	expect(script).toContain(
		'setsid "${IDE_ARGV[@]}" </dev/null >"$IDE_LOG" 2>&1 &',
	);
	// biome-ignore-end lint/suspicious/noTemplateCurlyInString: see above
});

// ### Test: ide-shutdown-process-first-leaves-children-alone
// EM: Measured directly against the real IDEs, and the two want opposite
// EM: things. Eclipse's /opt/eclipse/eclipse is a thin launcher around the JVM
// EM: that actually owns the window, so the children must be signalled or the
// EM: JVM is orphaned and the window stays up. RStudio's own rsession is a
// EM: direct child, so signalling children first killed the user's R session
// EM: and left the IDE standing. Hence process-first must not touch children.
// EM: Uses spawnWithDelayedEnter, not a pre-buffered stdin Blob — see its
// EM: own comment: confirmed directly that a Blob races
// EM: entrypoint.sh's setsid fork/exec latency and flakes this
// EM: specific test (signal arrives before the fake IDE script has even
// EM: started, so the pid file it writes as its first statement never
// EM: gets there).
test("ide-shutdown-process-first-leaves-children-alone: a process-first preset signals only the IDE itself", async () => {
	const pidFile = `/tmp/scoder-ide-child-${Date.now()}-pf.pid`;
	let childPid = "";

	try {
		const { cmd, env } = entrypointCommand(
			"/bin/bash",
			["-c", "exit 4"],
			"/bin/bash",
			["-c", `sleep 120 & echo $! > ${pidFile}; trap 'exit 0' HUP; wait`],
			{ signal: "HUP", order: "process-first" },
		);

		const proc = spawnWithDelayedEnter(cmd, env);
		await proc.exited;
		const stderr = await new Response(proc.stderr).text();

		expect(proc.exitCode).toBe(4);
		expect(stderr).toContain("(SIGHUP)");

		childPid = (await Bun.file(pidFile).text()).trim();
		const childAlive = await Bun.spawn(["kill", "-0", childPid], {
			stdout: "ignore",
			stderr: "ignore",
		}).exited;
		expect(childAlive).toBe(0);
	} finally {
		if (childPid) {
			await Bun.spawn(["kill", "-9", childPid], { stderr: "ignore" }).exited;
		}
		await Bun.spawn(["rm", "-f", pidFile]).exited;
	}
});

// ### Test: ide-shutdown-presets-record-measured-signals
// EM: These two values are measurements, not preferences — pinned here so a
// EM: later tidy-up cannot quietly collapse them back to one shared default.
// EM: And the flip side, added with the vscode preset: a preset that has
// EM: not been measured records nothing, which is pinned too.
test("ide-shutdown-presets-record-measured-signals: measured presets keep their own shutdown specs, unmeasured ones record nothing", () => {
	expect(TOOL_PRESETS.rstudio?.ideShutdown).toEqual({
		signal: "HUP",
		order: "process-first",
	});
	expect(TOOL_PRESETS.eclipse?.ideShutdown).toEqual({
		signal: "TERM",
		order: "children-first",
	});
	// EM: vscode asserted ABSENT, not guessed: the field records
	// EM: measurements, and the plan's real-desktop checklist (item 6)
	// EM: has not run. The expected shape — TERM, process-first, since
	// EM: children-first would signal Electron's renderer and GPU helpers
	// EM: out from under the main process — lives as a comment on the
	// EM: preset; putting it here before it is measured would launder a
	// EM: prior into a pin, which is exactly what this test exists to
	// EM: prevent. It fails, loudly and by name, the day someone adds
	// EM: the value without the measurement.
	expect(TOOL_PRESETS.vscode?.ideShutdown).toBeUndefined();
	// The fallback for any preset that has not been measured.
	expect(DEFAULT_IDE_SHUTDOWN).toEqual({
		signal: "TERM",
		order: "children-first",
	});
});

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
			{
				env: process.env,
				cwd: linkedWorktree,
				stdout: "pipe",
				stderr: "pipe",
			},
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
				env: process.env,
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

// ### Test: worktree-mode-refuses-dirty-checkout
// Renamed from uncommitted-host-changes-warned: the agent cannot see
// uncommitted work in the launching checkout, so worktree mode now refuses
// outright rather than merely warning and starting a session that can't see
// it. Checked before setupGitWorktree runs, so no branch/worktree is
// created on a refused launch — no real sandbox is ever attempted, so this
// doesn't depend on pasta/bwrap actually working in the test environment.
test("worktree-mode-refuses-dirty-checkout: worktree mode refuses when the checkout has uncommitted changes", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		await Bun.write(`${repoDir}/unstaged.txt`, "not committed\n");

		const proc = await Bun.spawn(
			[SCODER_PATH, "-w", "/bin/bash", "-c", "true"],
			{
				env: process.env,
				cwd: repoDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		await proc.exited;

		const stderr = await new Response(proc.stderr).text();
		expect(proc.exitCode).not.toBe(0);
		expect(stderr).toContain("--worktree requires a clean checkout");

		const branchListProc = await Bun.spawn(
			["git", "worktree", "list", "--porcelain"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await branchListProc.exited;
		const worktreeList = await new Response(branchListProc.stdout).text();
		expect(worktreeList).not.toContain("scoder/");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: direct-mode-requires-git-repo
// Direct mode used to silently tolerate a non-git directory (git commands
// elsewhere just no-op or fall back without checking exit codes) — now
// refuses up front, the same way worktree mode always has, since there is
// otherwise no undo/audit trail for whatever the agent does there.
test("direct-mode-requires-git-repo: direct mode refuses outside a git repository", async () => {
	const plainDir = `${TEST_BASE}/non-git-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	await Bun.spawn(["mkdir", "-p", plainDir]).exited;

	try {
		const proc = await Bun.spawn(
			[SCODER_PATH, "--no-worktree", "/bin/bash", "-c", "true"],
			{
				env: process.env,
				cwd: plainDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		await proc.exited;

		const stderr = await new Response(proc.stderr).text();
		expect(proc.exitCode).not.toBe(0);
		expect(stderr).toContain("not inside a git repository");
	} finally {
		await Bun.spawn(["rm", "-rf", plainDir]).exited;
	}
});

// ### Test: worktree-mode-requires-git-repo
// Same requirement, worktree mode — already enforced by setupGitWorktree,
// covered here for parity with the direct-mode test above.
test("worktree-mode-requires-git-repo: worktree mode refuses outside a git repository", async () => {
	const plainDir = `${TEST_BASE}/non-git-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	await Bun.spawn(["mkdir", "-p", plainDir]).exited;

	try {
		const proc = await Bun.spawn(
			[SCODER_PATH, "-w", "/bin/bash", "-c", "true"],
			{
				env: process.env,
				cwd: plainDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		await proc.exited;

		const stderr = await new Response(proc.stderr).text();
		expect(proc.exitCode).not.toBe(0);
		expect(stderr).toContain("not inside a git repository");
	} finally {
		await Bun.spawn(["rm", "-rf", plainDir]).exited;
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

// ### Test: home-installed-tool-exec-path-resolved
// Regression test for `scoder claude` failing with "execvp: No such file or
// directory": `which` returns a host path under $HOME, and the sandbox
// replaces /home with a tmpfs — a $HOME-installed tool only resolves if its
// own directory (~/.local/bin, bound by buildExtraBinds) is actually among
// the sandbox's binds. The sandbox's $HOME is the real host $HOME now (no
// separate rewritten path — see path-mirroring), so the exec target is the
// same string on both sides; this just checks it appears as the built
// command's exec target.
test("home-installed-tool-exec-path-resolved: exec target for a $HOME-installed tool resolves inside the sandbox", async () => {
	const name = "scoder-test-homedtool";
	const tool = await createHomeInstalledTool(name);

	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const output = await runScoder(repoDir, ["--dry-run", name]);

		expect(output).toContain(`-- ${SANDBOX_HOME}/.local/bin/${name}`);
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
			env: process.env,
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
// The snapshot must copy in a symlink target that isn't reachable inside
// this session's sandbox, rather than leaving a dangling reference.
//
// This used to also sweep every symlink in the snapshot and assert none of
// them pointed at a literal `$HOME/...` string — back when the sandbox
// remapped $HOME onto a separate `/home/scoder` namespace, ANY symlink
// target still spelled as a raw `$HOME/...` path was necessarily a bug (the
// rewrite to the sandbox namespace had been skipped somewhere). Now that the
// sandbox's own $HOME is the real host $HOME (see path-mirroring), a
// symlink target under $HOME is not itself suspicious — real $HOME-relative
// entries in the machine's own ~/.local/bin (e.g. a genuinely installed
// `claude`) correctly keep their real $HOME-relative target, whether or not
// that target's directory happens to be bound into *this particular*
// session (it dangles harmlessly if not, same as it always could). That
// sweep is no longer a meaningful invariant, so it's dropped; the fixture
// tool below (small and never bound by any preset) is what still exercises
// the actual behaviour under test — it must be copied in whole, not left as
// a dangling symlink.
test("local-bin-symlink-target-mapped: an unresolvable symlink target is copied in, not left dangling", async () => {
	const name = "scoder-test-maptarget";
	const tool = await createHomeInstalledTool(name);

	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		// EM: As above — the snapshot is inspected after scoder exits, so the
		// EM: session root has to outlive the run.
		const output = await runScoder(repoDir, ["--dry-run", name], {
			SCODER_KEEP_SESSION_TMP: "1",
		});

		// EM: The snapshot now mirrors its sandbox destination under the
		// EM: session root, so it is matched by that shape rather than by the
		// EM: old flat /tmp/scoder-local-bin.XXXXXX prefix.
		const match = output.match(/\/tmp\/scoder-[0-9a-f]{8}\/\S*\/\.local\/bin/);
		if (!match) {
			throw new Error("scoder did not report a ~/.local/bin snapshot dir");
		}
		const snapshotDir = match[0];

		// The tool under test is small and unbound, so it is copied in whole
		const copied = await fileExists(`${snapshotDir}/${name}`);
		expect(copied).toBe(true);

		await removeSessionRoot(snapshotDir);
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
			env: process.env,
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
		{
			env: process.env,
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		},
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
		{
			env: process.env,
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		},
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
// $HOME/.ssh/config: bwrap's --clearenv wipes the host PATH, and
// getpwuid() resolves correctly to the sandbox's $HOME (the real host
// $HOME — see path-mirroring) because setupSandboxIdentity overlays
// /etc/passwd for exactly this reason.
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
			{
				env: process.env,
				cwd: repoDir,
				stdout: "pipe",
				stderr: "pipe",
			},
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
					`grep -rl 'PRIVATE KEY' ${SANDBOX_HOME}/.ssh ${SANDBOX_HOME}/.ssh-control 2>/dev/null; echo DONE`,
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
			{
				env: process.env,
				cwd: repoDir,
				stdout: "pipe",
				stderr: "pipe",
			},
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
			`--ro-bind <ssh-tunnel-tmp>/socket ${SANDBOX_HOME}/.ssh-control`,
		);
		expect(output).toContain(
			`--ro-bind <ssh-tunnel-tmp>/config/config ${SANDBOX_HOME}/.ssh/config`,
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

// ### Test: update-alternatives-state-mounted
// EM: See design/implementation/issues/update-alternatives-state-not-mounted.md.
// EM: The /etc/alternatives symlinks (bound as part of /etc) are enough to
// EM: *run* whichever alternative is selected, but update-alternatives' own
// EM: administrative state lives under /var/lib — unreachable before this
// EM: fix, since nothing bound any part of /var. Reported as an
// EM: alternatives-managed binary being "not found", though the binary
// EM: itself always ran fine; only update-alternatives' own view of it was
// EM: broken. Reuses createFakePastaShim (defined below, for the
// EM: .sandbox/ports live-reload tests) so the real scoder binary can run this
// EM: end-to-end, same reasoning as terminal-signals-forwarded-to-sandbox
// EM: above: this environment's own lack of /dev/net/tun would make a real
// EM: pasta attach non-deterministic here, when what's under test is a
// EM: filesystem bind, not pasta itself.
//
// EM: Self-skips if the host has no registered alternatives at all to probe
// EM: — asserts against the host's own real `update-alternatives --list`
// EM: output rather than just "did not error", so a regression that mounted
// EM: a stale or wrong path would still be caught.
const alternativesStateDir = (await dirExists("/var/lib/dpkg/alternatives"))
	? "/var/lib/dpkg/alternatives"
	: (await dirExists("/var/lib/alternatives"))
		? "/var/lib/alternatives"
		: null;
const alternativesUpdateAlternativesAvailable =
	alternativesStateDir !== null &&
	(await commandAvailable("update-alternatives"));

async function firstRegisteredAlternative(
	stateDir: string,
): Promise<string | null> {
	const proc = Bun.spawn(["ls", stateDir], { stdout: "pipe", stderr: "pipe" });
	await proc.exited;
	const names = (await new Response(proc.stdout).text())
		.trim()
		.split("\n")
		.filter((n) => n.length > 0)
		.sort();
	return names[0] ?? null;
}

test.skipIf(!alternativesUpdateAlternativesAvailable)(
	"update-alternatives-state-mounted: update-alternatives can list a registered alternative from inside the sandbox",
	async () => {
		if (!alternativesStateDir) {
			throw new Error("unreachable: guarded by skipIf");
		}
		const alternativeName =
			await firstRegisteredAlternative(alternativesStateDir);
		if (!alternativeName) {
			// Nothing registered on this host to probe against — same shape
			// of self-skip as claudePresetTestable/sshTunnelTestable above,
			// just decided at run time instead of module load time.
			return;
		}

		const hostListProc = Bun.spawn(
			["update-alternatives", "--list", alternativeName],
			{ stdout: "pipe", stderr: "pipe" },
		);
		await hostListProc.exited;
		const hostOutput = await new Response(hostListProc.stdout).text();

		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);
		const shimDir = await createFakePastaShim(
			`/tmp/scoder-ua-test-${Date.now()}.log`,
		);

		try {
			const proc = Bun.spawn(
				[
					SCODER_PATH,
					"-q",
					"--no-worktree",
					"/bin/bash",
					"-c",
					`update-alternatives --list ${alternativeName}`,
				],
				{
					cwd: repoDir,
					env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			await proc.exited;

			expect(proc.exitCode).toBe(0);
			const output = await new Response(proc.stdout).text();
			expect(output).toBe(hostOutput);
		} finally {
			await Bun.spawn(["rm", "-rf", shimDir]).exited;
			await cleanupRepo(repoDir);
		}
	},
);

// ### Test: opt-mounted
// EM: See design/implementation/issues/opt-not-mounted.md. /opt is the FHS
// EM: location for manually-installed, self-contained software — not under
// EM: /usr, so none of the other system binds reach it, and it is a common
// EM: /etc/alternatives target for exactly that kind of tool (an IDE, a
// EM: vendor-shipped JDK, a browser). A tool resolving correctly through
// EM: the alternatives symlink chain could still fail at the final hop if
// EM: /opt itself was never mounted — this was the actual root cause behind
// EM: the update-alternatives report above; both fixes landed together
// EM: since they surfaced from the same investigation.
//
// EM: No test fixture is written under /opt — on a real host that's root-
// EM: owned system state, and this suite otherwise never mutates anything
// EM: outside its own throwaway temp repos. Instead this compares `ls /opt`
// EM: run on the host directly against the same command run inside the
// EM: sandbox (reusing the fake pasta shim, same reasoning as
// EM: update-alternatives-state-mounted above) — a real content check, not
// EM: just "the bind flag is present in --dry-run", but with no mutation.
// EM: Self-skips if /opt does not exist on the host at all.
const optExists = await dirExists("/opt");

test.skipIf(!optExists)(
	"opt-mounted: /opt is visible inside the sandbox and matches the host",
	async () => {
		const hostLsProc = Bun.spawn(["ls", "/opt"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await hostLsProc.exited;
		const hostOutput = await new Response(hostLsProc.stdout).text();

		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);
		const shimDir = await createFakePastaShim(
			`/tmp/scoder-opt-test-${Date.now()}.log`,
		);

		try {
			const proc = Bun.spawn(
				[SCODER_PATH, "-q", "--no-worktree", "/bin/bash", "-c", "ls /opt"],
				{
					cwd: repoDir,
					env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			await proc.exited;

			expect(proc.exitCode).toBe(0);
			const output = await new Response(proc.stdout).text();
			expect(output).toBe(hostOutput);
		} finally {
			await Bun.spawn(["rm", "-rf", shimDir]).exited;
			await cleanupRepo(repoDir);
		}
	},
);

// EM: ### Tests for .sandbox/ports live-reload
// EM: See design/implementation/plans/agentports.md. A fake pasta that
// EM: mimics real pasta's daemonize-then-exit shape (writes its own pid to
// EM: --pid, then keeps running detached) lets the watcher's swap logic be
// EM: exercised deterministically, without needing a working /dev/net/tun —
// EM: same reasoning as the bwrap-orphan test above, applied to the success
// EM: path instead of the failure path. Verified manually against this exact
// EM: shim shape before being committed to the suite.
//
// EM: The pidfile write happens in the shim's foreground, using the
// EM: already-known backgrounded pid ($!) — writing it from the backgrounded
// EM: process itself would race attachPasta's immediate read of the file.

async function createFakePastaShim(
	logPath: string,
	failOnInvocation?: number,
): Promise<string> {
	const shimDir = `/tmp/scoder-fake-pasta-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	await Bun.spawn(["mkdir", "-p", shimDir]).exited;

	const failClause = failOnInvocation
		? `if [ "$COUNT" -eq ${failOnInvocation} ]; then exit 1; fi\n`
		: "";

	// biome-ignore-start lint/suspicious/noTemplateCurlyInString: these are
	// literal bash "${...}" references in a generated shell script, not
	// forgotten JS template placeholders — this is a plain string, not a
	// template literal, so JS never interpolates them.
	const script =
		"#!/bin/bash\n" +
		'PIDFILE=""\n' +
		'ARGS=("$@")\n' +
		"for ((i=0; i<${#ARGS[@]}; i++)); do\n" +
		'  if [[ "${ARGS[$i]}" == "--pid" ]]; then\n' +
		'    PIDFILE="${ARGS[$((i+1))]}"\n' +
		"  fi\n" +
		"done\n" +
		// biome-ignore-end lint/suspicious/noTemplateCurlyInString: see above
		`COUNT_FILE="${logPath}.count"\n` +
		'COUNT=$(( $(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1 ))\n' +
		'echo "$COUNT" > "$COUNT_FILE"\n' +
		`echo "$*" >> "${logPath}"\n` +
		failClause +
		"nohup sleep infinity >/dev/null 2>&1 &\n" +
		"BGPID=$!\n" +
		"disown\n" +
		'echo "$BGPID" > "$PIDFILE"\n' +
		"exit 0\n";

	await Bun.write(`${shimDir}/pasta`, script);
	await Bun.spawn(["chmod", "+x", `${shimDir}/pasta`]).exited;
	return shimDir;
}

// ### Test: sandbox-ports-live-reload-adds-port
test("sandbox-ports-live-reload-adds-port: editing .sandbox/ports mid-session reattaches with the new ports", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const logPath = `${repoDir}-pasta.log`;
	const shimDir = await createFakePastaShim(logPath);

	try {
		await Bun.write(`${repoDir}/.sandbox/ports`, "11434\n");

		const proc = Bun.spawn([SCODER_PATH, "-q", "/bin/bash", "-c", "sleep 3"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				PATH: `${shimDir}:${process.env.PATH}`,
				SCODER_AGENTPORTS_POLL_MS: "200",
			},
		});

		// Give the initial attach time to land before editing.
		await Bun.sleep(800);
		await Bun.write(`${repoDir}/.sandbox/ports`, "11434\n23119\n");

		await proc.exited;
		expect(proc.exitCode).toBe(0);

		const invocations = (await Bun.file(logPath).text())
			.trim()
			.split("\n")
			.filter((line) => line.length > 0);

		expect(invocations.length).toBe(2);
		expect(invocations[0]).toContain("--tcp-ns 11434");
		expect(invocations[0]).not.toContain("23119");
		expect(invocations[1]).toContain("--tcp-ns 11434");
		expect(invocations[1]).toContain("--tcp-ns 23119");
	} finally {
		await Bun.spawn(["pkill", "-f", shimDir]).exited;
		await Bun.spawn(["rm", "-rf", shimDir]).exited;
		await Bun.spawn(["rm", "-f", logPath, `${logPath}.count`]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-ports-live-reload-bad-edit-keeps-old-config
test("sandbox-ports-live-reload-bad-edit-keeps-old-config: a failed reattach falls back to the previous ports", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const logPath = `${repoDir}-pasta.log`;
	// Invocation 1 is the initial attach; invocation 2 is the watcher's first
	// reload attempt (forced to fail); invocation 3 is the restore attempt.
	const shimDir = await createFakePastaShim(logPath, 2);

	try {
		await Bun.write(`${repoDir}/.sandbox/ports`, "11434\n");

		const proc = Bun.spawn([SCODER_PATH, "-q", "/bin/bash", "-c", "sleep 3"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				PATH: `${shimDir}:${process.env.PATH}`,
				SCODER_AGENTPORTS_POLL_MS: "200",
			},
		});

		await Bun.sleep(800);
		await Bun.write(`${repoDir}/.sandbox/ports`, "11434\n23119\n");

		await proc.exited;
		expect(proc.exitCode).toBe(0);

		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain(
			"reload failed to attach — restoring the previous port configuration",
		);
		expect(stderr).toContain(
			"restored the previous .sandbox/ports configuration",
		);

		// Only the second invocation is forced to fail, so once the restore
		// (the third invocation) puts the watcher back on the old ports, the
		// next poll tick sees .sandbox/ports still asking for the new ones and
		// retries — which now succeeds. That retry-on-a-transient-failure
		// behaviour is correct, not a bug, so this only pins down the first
		// three invocations (the fail-then-restore sequence itself), not the
		// total count.
		const invocations = (await Bun.file(logPath).text())
			.trim()
			.split("\n")
			.filter((line) => line.length > 0);

		expect(invocations.length).toBeGreaterThanOrEqual(3);
		expect(invocations[0]).toContain("--tcp-ns 11434");
		expect(invocations[0]).not.toContain("23119");
		expect(invocations[1]).toContain("--tcp-ns 23119"); // the attempt that failed
		expect(invocations[2]).toContain("--tcp-ns 11434");
		expect(invocations[2]).not.toContain("23119"); // restored to the old list
	} finally {
		await Bun.spawn(["pkill", "-f", shimDir]).exited;
		await Bun.spawn(["rm", "-rf", shimDir]).exited;
		await Bun.spawn(["rm", "-f", logPath, `${logPath}.count`]).exited;
		await cleanupRepo(repoDir);
	}
});

// EM: ### Tests for `.sandbox/readwrite`
// EM: See design/features/agent-readwrite.md. Replaces the earlier
// EM: `scratch` symlink tests. Targets live under a throwaway directory in
// EM: the real $HOME (the feature requires targets to resolve inside
// EM: $HOME), cleaned up per test.

function readwriteTargetPath(): string {
	return `${process.env.HOME}/.scoder-test-readwrite-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ### Test: sandbox-readwrite-resolves-rw
test("sandbox-readwrite-resolves-rw: reads and writes through an .sandbox/readwrite entry reach the real target", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const target = readwriteTargetPath();
	const relative = target.slice(`${process.env.HOME}/`.length);

	try {
		await Bun.spawn(["mkdir", "-p", target]).exited;
		await Bun.write(`${target}/existing.txt`, "pre-existing\n");
		await Bun.write(`${repoDir}/.sandbox/readwrite`, `$HOME/${relative}\n`);

		const output = await runScoder(repoDir, [
			"-q",
			"/bin/bash",
			"-c",
			`cat ${target}/existing.txt && echo written > ${target}/new.txt`,
		]);

		expect(output.trim()).toBe("pre-existing");
		expect(await Bun.file(`${target}/new.txt`).text()).toBe("written\n");
	} finally {
		await Bun.spawn(["rm", "-rf", target]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-readwrite-created-if-missing
// Same bug class already fixed twice, for .sandbox/readonly and .sandbox/ports —
// a missing source path gets no bind mount at all, which would leave a
// freshly created default writable from inside the very session that
// finds it missing.
test("sandbox-readwrite-created-if-missing: a missing .sandbox/readwrite is created and protected in the same session", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		const proc = Bun.spawn(
			[
				SCODER_PATH,
				"-q",
				"/bin/bash",
				"-c",
				"echo modified >> .sandbox/readwrite",
			],
			{
				env: process.env,
				cwd: repoDir,
				stdout: "pipe",
				stderr: "pipe",
			},
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
		expect(proc.exitCode).not.toBe(0);

		const content = await Bun.file(`${repoDir}/.sandbox/readwrite`).text();
		expect(content).not.toContain("modified");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-readwrite-self-protected-readonly
test("sandbox-readwrite-self-protected-readonly: .sandbox/readwrite itself is always read-only inside the sandbox", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		await Bun.write(`${repoDir}/.sandbox/readwrite`, "");

		const output = await runScoder(repoDir, ["--dry-run", "/bin/bash"]);
		expect(output).toContain(
			// EM: The directory, not the file. Every config file is covered by
			// EM: the one .sandbox/ bind now, which is what removed the
			// EM: "missing file is writable" class this test was written for.
			`--ro-bind ${repoDir}/.sandbox ${repoDir}/.sandbox`,
		);
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-readwrite-missing-target-created
test("sandbox-readwrite-missing-target-created: a not-yet-existing target is created rather than left dangling", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const target = readwriteTargetPath(); // deliberately never created
	const relative = target.slice(`${process.env.HOME}/`.length);

	try {
		await Bun.write(`${repoDir}/.sandbox/readwrite`, `$HOME/${relative}\n`);

		const proc = Bun.spawn(
			["scoder", "-q", "--no-worktree", "/bin/bash", "-c", "true"],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;

		// The session itself may still fail later (pasta attaching), but the
		// target directory is created while building the bwrap command,
		// before that point is ever reached — same reasoning as
		// sandbox-readonly-created-default.
		expect(await dirExists(target)).toBe(true);
	} finally {
		await Bun.spawn(["rm", "-rf", target]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-readwrite-missing-target-not-created-under-dry-run
test("sandbox-readwrite-missing-target-not-created-under-dry-run: --dry-run stays side-effect free", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const target = readwriteTargetPath();
	const relative = target.slice(`${process.env.HOME}/`.length);

	try {
		await Bun.write(`${repoDir}/.sandbox/readwrite`, `$HOME/${relative}\n`);

		const output = await runScoder(repoDir, ["--dry-run", "/bin/bash"]);
		expect(output).toContain(`--bind ${target} ${target}`);
		expect(await dirExists(target)).toBe(false);
	} finally {
		await Bun.spawn(["rm", "-rf", target]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-readwrite-outside-home-rejected
test("sandbox-readwrite-outside-home-rejected: a line not starting with $HOME/ exits non-zero with a clear error", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);

	try {
		await Bun.write(`${repoDir}/.sandbox/readwrite`, "/tmp\n");

		const proc = Bun.spawn([SCODER_PATH, "--dry-run", "/bin/bash"], {
			env: process.env,
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		expect(proc.exitCode).not.toBe(0);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain("must start with $HOME/");
	} finally {
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-readwrite-escape-via-symlink-rejected
test("sandbox-readwrite-escape-via-symlink-rejected: a $HOME entry that resolves outside $HOME via a symlink is rejected", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const linkName = `.scoder-test-readwrite-escape-${Date.now()}`;
	const linkPath = `${process.env.HOME}/${linkName}`;

	try {
		await Bun.spawn(["ln", "-s", "/tmp", linkPath]).exited;
		await Bun.write(`${repoDir}/.sandbox/readwrite`, `$HOME/${linkName}\n`);

		const proc = Bun.spawn([SCODER_PATH, "--dry-run", "/bin/bash"], {
			env: process.env,
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		expect(proc.exitCode).not.toBe(0);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain("entry escapes HOME");
	} finally {
		await Bun.spawn(["rm", "-f", linkPath]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-readwrite-overlapping-fixed-bind-rejected
const localBinExists = await dirExists(`${process.env.HOME}/.local/bin`);
test.skipIf(!localBinExists)(
	"sandbox-readwrite-overlapping-fixed-bind-rejected: an entry matching a fixed scoder bind is a hard error",
	async () => {
		const repoDir = await createTempRepo();
		tempRepos.push(repoDir);

		try {
			await Bun.write(`${repoDir}/.sandbox/readwrite`, "$HOME/.local/bin\n");

			const proc = Bun.spawn([SCODER_PATH, "--dry-run", "/bin/bash"], {
				env: process.env,
				cwd: repoDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;

			expect(proc.exitCode).not.toBe(0);
			const stderr = await new Response(proc.stderr).text();
			expect(stderr).toContain("overlaps a fixed scoder bind");
		} finally {
			await cleanupRepo(repoDir);
		}
	},
);

// ### Test: sandbox-readwrite-nested-under-namespace-umbrella-allowed
// The one deliberate difference from .sandbox/readonly's own overlap check:
// nesting under a bare namespace umbrella (.cache, here) that is never
// actually populated by a real bind, just scaffolded empty by builder.ts's
// own --dir list, is allowed — this is the feature's own motivating use
// case ($HOME/.cache/<tool>).
test("sandbox-readwrite-nested-under-namespace-umbrella-allowed: $HOME/.cache/<tool> is not rejected", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const target = `${process.env.HOME}/.cache/.scoder-test-readwrite-${Date.now()}`;

	try {
		const relative = target.slice(`${process.env.HOME}/`.length);
		await Bun.write(`${repoDir}/.sandbox/readwrite`, `$HOME/${relative}\n`);

		const output = await runScoder(repoDir, ["--dry-run", "/bin/bash"]);
		expect(output).toContain(`--bind ${target} ${target}`);
	} finally {
		await Bun.spawn(["rm", "-rf", target]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-readwrite-overlapping-readonly-rejected
test("sandbox-readwrite-overlapping-readonly-rejected: the same $HOME path in both files is a hard error", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const target = readwriteTargetPath();

	try {
		await Bun.spawn(["mkdir", "-p", target]).exited;
		const relative = target.slice(`${process.env.HOME}/`.length);
		await Bun.write(`${repoDir}/.sandbox/readonly`, `$HOME/${relative}\n`);
		await Bun.write(`${repoDir}/.sandbox/readwrite`, `$HOME/${relative}\n`);

		const proc = Bun.spawn([SCODER_PATH, "--dry-run", "/bin/bash"], {
			env: process.env,
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;

		expect(proc.exitCode).not.toBe(0);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain(
			"is listed in both .sandbox/readonly and .sandbox/readwrite",
		);
	} finally {
		await Bun.spawn(["rm", "-rf", target]).exited;
		await cleanupRepo(repoDir);
	}
});

// ### Test: sandbox-readwrite-real-passthrough-unaffected
test("sandbox-readwrite-real-passthrough-unaffected: an ordinary tracked file still writes straight through with .sandbox/readwrite present", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const target = readwriteTargetPath();

	try {
		await Bun.spawn(["mkdir", "-p", target]).exited;
		const relative = target.slice(`${process.env.HOME}/`.length);
		await Bun.write(`${repoDir}/.sandbox/readwrite`, `$HOME/${relative}\n`);

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

// ### Test: sandbox-readwrite-survives-fresh-worktree
test("sandbox-readwrite-survives-fresh-worktree: a tracked .sandbox/readwrite still resolves rw after worktree creation", async () => {
	const repoDir = await createTempRepo();
	tempRepos.push(repoDir);
	const target = readwriteTargetPath();

	try {
		await Bun.spawn(["mkdir", "-p", target]).exited;
		const relative = target.slice(`${process.env.HOME}/`.length);
		await Bun.write(`${repoDir}/.sandbox/readwrite`, `$HOME/${relative}\n`);
		await Bun.spawn(["git", "add", ".sandbox/readwrite"], { cwd: repoDir })
			.exited;
		await Bun.spawn(
			[
				"git",
				"-c",
				"user.email=t@t.com",
				"-c",
				"user.name=t",
				"commit",
				"-m",
				"add .sandbox/readwrite",
			],
			{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
		).exited;

		const output = await runScoder(repoDir, ["-w", "--dry-run", "/bin/bash"]);
		expect(output).toContain(`--bind ${target} ${target}`);
	} finally {
		await Bun.spawn(["rm", "-rf", target]).exited;
		await cleanupRepo(repoDir);
	}
});
