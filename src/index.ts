#!/usr/bin/env bun

// EM: Main orchestration entry point for scoder sandbox runner
// EM: Implements dry-run-mode, sandbox-isolation, and git-worktree-isolation features
// EM: Coordinates CLI parsing, tool preset selection, sandbox construction, and session management

import { configureAppArmor } from "./cli/apparmor.ts";
import { parseArgs, printUsage, printVersion } from "./cli/parse-args.ts";
import {
	getAgentsMdOverlayBind,
	type ProtectionConfig,
	setupAgentsSnapshot,
	setupLocalBinSnapshot,
	setupProtection,
	setupResolvConf,
} from "./git/protection.ts";
import {
	commitAllChanges,
	getCommitCount,
	getDiffStat,
	getProjDir,
	setupGitWorktree,
} from "./git/worktree.ts";
import { buildBwrapCommand } from "./sandbox/builder.ts";
import { TOOL_PRESETS } from "./tools/presets.ts";
import type { BindMount, GitWorktreeInfo } from "./types.ts";
import {
	checkBwrapUserns,
	commandExists,
	detectDefaultLlmPort,
} from "./utils/checks.ts";

// EM: Nested sandbox detection - check if already in a worktree or running in scoder
const GIT_DIR = ".git";

import { error, info, infoBlue, setQuiet, warning } from "./utils/logger.ts";

const SCODER_HOME = "/home/scoder";

async function main(): Promise<void> {
	// EM: Parse command line arguments into ScoderOptions
	const args = Bun.argv.slice(2);
	const result = parseArgs(args);

	if (result.error) {
		error(result.error);
		console.error("Try 'scoder --help' for more information.");
		process.exit(1);
	}

	if (result.showHelp) {
		printUsage();
		process.exit(0);
	}

	if (result.showVersion) {
		printVersion();
		process.exit(0);
	}

	const { options, toolName, toolArgs } = result;

	// EM: Nested sandbox detection - refuse if already in a worktree or running in scoder
	const gitDir = GIT_DIR;
	let gitDirStat: import("node:fs").Stats | undefined;
	try {
		gitDirStat = await Bun.file(gitDir).stat();
	} catch {
		// File doesn't exist or can't be read
	}
	if (gitDirStat?.isFile()) {
		const gitContent = await Bun.file(gitDir).text();
		if (gitContent.startsWith("gitdir:")) {
			error("scoder is already running inside a git worktree");
			error("This creates a nested sandbox which bubblewrap cannot handle");
			error(
				"Use --no-worktree to run scoder directly in the current directory",
			);
			process.exit(1);
		}
	}

	// EM: Allow --no-worktree mode when inside nested scoder sandbox
	if (
		process.env.SCODER_SANDBOX === "1" &&
		options.worktree
	) {
		error("scoder cannot run inside an existing scoder sandbox");
		error("Use --no-worktree to run directly in the current directory");
		process.exit(1);
	}

	setQuiet(options.quiet);

	if (options.installDependencies) {
		if (process.getuid?.() !== 0) {
			error("--install-dependencies must be run as root");
			error("Usage: sudo scoder --install-dependencies");
			process.exit(1);
		}

		const installProc = await Bun.spawn([
			"apt",
			"install",
			"bubblewrap",
			"passt",
		]);

		await installProc.exited;
		process.exit(installProc.exitCode);
	}

	if (!(await commandExists("bwrap"))) {
		error("bubblewrap (bwrap) not found in PATH");
		error("run sudo scoder --install-dependencies");
		process.exit(1);
	}

	if (!(await commandExists("pasta"))) {
		error("pasta not found in PATH");
		error("run sudo scoder --install-dependencies");
		process.exit(1);
	}

	if (options.llmPorts.length === 0) {
		const detectedPort = await detectDefaultLlmPort();
		if (detectedPort) {
			options.llmPorts = [detectedPort];
		}
	}

	if (options.configureAppArmor) {
		await configureAppArmor();
		process.exit(0);
	}

	await checkBwrapUserns();

	if (!toolName) {
		error("no tool specified");
		console.error("Usage: scoder [options] <tool> [tool-args...]");
		process.exit(1);
	}

	let toolBin: string | null = null;
	let toolDescription = toolName;
	let toolBinds: BindMount[] = [];
	let toolDirs: string[] = [];

	const preset = TOOL_PRESETS[toolName];

	if (preset) {
		toolDescription = preset.description;

		const valid = await preset.validate();
		if (!valid) {
			process.exit(1);
		}

		const realHome = process.env.HOME || "/home/user";
		const sandboxHome = SCODER_HOME;

		const bindSpec = await preset.configBinds(realHome, sandboxHome);
		toolBinds = bindSpec.binds;
		toolDirs = bindSpec.dirs;
	}

	toolBin = await which(toolName);
	if (!toolBin) {
		error(`${toolName} not found in PATH`);
		process.exit(1);
	}

	let worktreeInfo: GitWorktreeInfo | null = null;
	let protectionConfig: ProtectionConfig | undefined;
	let sandboxProjDir = "";

	if (options.worktree) {
		worktreeInfo = await setupGitWorktree(true);

		sandboxProjDir = `${SCODER_HOME}/${worktreeInfo!.projDir}`;
		protectionConfig = await setupProtection(
			worktreeInfo!.worktreeDir,
			sandboxProjDir,
		);

		const agentsSnapshotBind = await setupAgentsSnapshot();
		if (agentsSnapshotBind && protectionConfig) {
			protectionConfig.safeBinds.push(agentsSnapshotBind);
		}

		const localBinBind = await setupLocalBinSnapshot();
		if (localBinBind && protectionConfig) {
			protectionConfig.safeBinds.push(localBinBind);
		}

		const resolvConfBind = await setupResolvConf();
		if (resolvConfBind && protectionConfig) {
			protectionConfig.safeBinds.push(resolvConfBind);
		}

		if (protectionConfig?.agentsMdOverlay && protectionConfig) {
			const agentsMdBind = getAgentsMdOverlayBind(
				protectionConfig.agentsMdOverlay,
				sandboxProjDir,
			);
			if (agentsMdBind) {
				protectionConfig.safeBinds.push(agentsMdBind);
			}
		}
	} else {
		const cwd = process.cwd();
		const projDir = await getProjDir(cwd);
		sandboxProjDir = `${SCODER_HOME}/${projDir}`;
		protectionConfig = await setupProtection(cwd, sandboxProjDir);

		const agentsSnapshotBind = await setupAgentsSnapshot();
		if (agentsSnapshotBind && protectionConfig) {
			protectionConfig.safeBinds.push(agentsSnapshotBind);
		}

		const localBinBind = await setupLocalBinSnapshot();
		if (localBinBind && protectionConfig) {
			protectionConfig.safeBinds.push(localBinBind);
		}

		const resolvConfBind = await setupResolvConf();
		if (resolvConfBind && protectionConfig) {
			protectionConfig.safeBinds.push(resolvConfBind);
		}

		if (protectionConfig?.agentsMdOverlay && protectionConfig) {
			const agentsMdBind = getAgentsMdOverlayBind(
				protectionConfig.agentsMdOverlay,
				sandboxProjDir,
			);
			if (agentsMdBind) {
				protectionConfig.safeBinds.push(agentsMdBind);
			}
		}
	}

	const config = {
		worktreeInfo,
		sandboxProjDir,
		options,
		toolBinds,
		toolDirs,
		toolBin,
		toolArgs,
		protectionConfig,
	};

	const bwrapCmd = await buildBwrapCommand(config);

	if (options.worktree && worktreeInfo) {
		info(`Agent working files can be found at:   ${worktreeInfo.worktreeDir}`);
		info(
			`and interim commits viewed with:       git diff ${worktreeInfo.worktreeBranch}`,
		);
	} else if (!options.worktree) {
		info(`Running in direct mode (no worktree isolation)`);
		info(`Working directory: ${process.cwd()}`);
	}

	if (options.dryRun) {
		// EM: Dry-run mode outputs bwrap command without executing
		// EM: Implements HAS_FEATURE: dry-run-mode
		info("Dry run — would execute:");
		console.log("");
		printBwrapCommand(bwrapCmd);
		console.log("");
		process.exit(0);
	}

	info(`Launching ${toolDescription} in sandbox...`);

	const proc = Bun.spawn(bwrapCmd, {
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	});

	const exitCode = await proc.exited;

	if (options.worktree && worktreeInfo && protectionConfig) {
		// EM: Commit changes and print session summary for worktree mode
		// EM: Implements git-worktree-isolation feature
		await printSessionSummary(worktreeInfo, protectionConfig.agentsMdOverlay);
	} else if (!options.worktree && protectionConfig) {
		// EM: Direct mode - no git worktree, changes are immediate
		if (protectionConfig.agentsMdOverlay) {
			await Bun.write(protectionConfig.agentsMdOverlay, "");
		}
		info("Direct mode session complete (no git worktree changes to commit)");
	}

	process.exit(exitCode);
}

async function printSessionSummary(
	worktreeInfo: GitWorktreeInfo,
	agentsMdOverlay?: string,
): Promise<void> {
	// EM: Print commit count, diffstat, and merge/discard commands after session
	try {
		if (agentsMdOverlay) {
			await Bun.write(agentsMdOverlay, "");
		}

		await commitAllChanges("Committing session by scoder.");

		console.log("");
		infoBlue("====== Session Summary ======");
		infoBlue(`Branch: ${worktreeInfo.worktreeBranch}`);
		infoBlue(`Worktree: ${worktreeInfo.worktreeDir}`);

		const commitCount = await getCommitCount(
			worktreeInfo.worktreeDir,
			worktreeInfo.baseCommit,
		);

		if (commitCount > 0) {
			infoBlue(`New commits: ${commitCount}`);

			const diffStat = await getDiffStat(
				worktreeInfo.worktreeDir,
				worktreeInfo.baseCommit,
			);

			if (diffStat) {
				infoBlue("Changes since base:");
				for (const line of diffStat.split("\n")) {
					if (line.trim()) {
						infoBlue(`  ${line}`);
					}
				}
			}
		} else {
			infoBlue("No changes were made");
		}

		printPostSessionCommands(worktreeInfo);
	} catch (err) {
		warning(`Failed to print session summary: ${err}`);
	}
}

function printPostSessionCommands(worktreeInfo: GitWorktreeInfo): void {
	info(`To review:  git log ${worktreeInfo.worktreeBranch}`);
	info(`To merge:   git merge ${worktreeInfo.worktreeBranch}`);
	info(`To rebase:  git rebase ${worktreeInfo.worktreeBranch}`);

	if (worktreeInfo.baseCommit) {
		info(
			`View diff:  git diff ${worktreeInfo.baseCommit}..${worktreeInfo.worktreeBranch}`,
		);
	} else {
		info(`View diff:  git diff ${worktreeInfo.worktreeBranch}`);
	}

	info(
		`To discard: git worktree remove ${worktreeInfo.worktreeDir} && git branch -D ${worktreeInfo.worktreeBranch}`,
	);
}

function printBwrapCommand(cmd: string[]): void {
	process.stdout.write(cmd[0]);

	for (let i = 1; i < cmd.length; i++) {
		const arg = cmd[i];

		if (arg?.startsWith("--")) {
			process.stdout.write(` \\\n  ${arg}`);
		} else if (arg) {
			process.stdout.write(` ${arg}`);
		}
	}

	console.log("");
}

async function which(cmd: string): Promise<string | null> {
	try {
		const proc = await Bun.spawn(["which", cmd], {
			stdout: "pipe",
			stderr: "pipe",
		});

		await proc.exited;

		if (proc.exitCode === 0) {
			const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
			return new TextDecoder().decode(stdoutBytes).trim();
		}

		return null;
	} catch {
		return null;
	}
}

main().catch((err) => {
	error(`Fatal error: ${err}`);
	process.exit(1);
});
