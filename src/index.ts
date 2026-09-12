#!/usr/bin/env bun

// EM: Main orchestration entry point for scoder sandbox runner
// EM: Implements dry-run-mode, sandbox-isolation, and git-worktree-isolation features
// EM: Coordinates CLI parsing, tool preset selection, sandbox construction, and session management

import { rm } from "node:fs/promises";
import { configureAppArmor } from "./cli/apparmor.ts";
import { parseArgs, printUsage, printVersion } from "./cli/parse-args.ts";
import {
	addGitExclude,
	appendAgentPort,
	getAgentPortsBind,
	getAgentsMdOverlayBind,
	type ProtectionConfig,
	readAgentPorts,
	removeGitExclude,
	setupAgentsSnapshot,
	setupLocalBinSnapshot,
	setupProtection,
	setupResolvConf,
	setupScratchLink,
} from "./git/protection.ts";
import {
	commitAllChanges,
	getCommitCount,
	getDiffStat,
	getProjDir,
	hasUncommittedChanges,
	setupGitWorktree,
} from "./git/worktree.ts";
import { buildBwrapCommand, collectBindDests } from "./sandbox/builder.ts";
import {
	getSandboxGid,
	getSandboxUid,
	type SandboxIdentity,
	setupSandboxIdentity,
} from "./sandbox/identity.ts";
import { describeLaunch, launchSandbox } from "./sandbox/launch.ts";
import {
	describeSshAccess,
	type SshTunnel,
	startSshTunnel,
	stopSshTunnel,
} from "./sandbox/ssh.ts";
import { TOOL_PRESETS } from "./tools/presets.ts";
import type { BindMount, GitWorktreeInfo } from "./types.ts";
import {
	checkBwrapUserns,
	commandExists,
	detectDefaultLlmPort,
} from "./utils/checks.ts";
import {
	getRealHome,
	isUnderAny,
	resolveHomePrefixes,
	toSandboxPath,
} from "./utils/paths.ts";

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

	const { options, toolName } = result;
	let toolArgs = result.toolArgs;

	// EM: Nested sandbox detection - refuse if already in a worktree or running in scoder
	const gitDir = GIT_DIR;
	let gitDirStat: import("node:fs").Stats | undefined;
	try {
		gitDirStat = await Bun.file(gitDir).stat();
	} catch {
		// File doesn't exist or can't be read
	}
	// EM: Only worktree mode is affected — direct mode creates no worktree, so
	// EM: there is nothing to nest and the suggested remedy would be a no-op.
	if (gitDirStat?.isFile() && options.worktree) {
		const gitContent = await Bun.file(gitDir).text();
		if (gitContent.startsWith("gitdir:")) {
			error("scoder cannot create a worktree from inside a git worktree");
			error(
				"The nested worktree's git directory would be unreachable in the sandbox",
			);
			error(
				"Use --no-worktree to run scoder directly in the current directory",
			);
			process.exit(1);
		}
	}

	// EM: Allow --no-worktree mode when inside nested scoder sandbox
	if (process.env.SCODER_SANDBOX === "1" && options.worktree) {
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

	if (options.ide && options.ide === toolName) {
		error("--ide must be different from the primary tool");
		process.exit(1);
	}

	let toolDescription = toolName;
	let toolBinds: BindMount[] = [];
	let toolDirs: string[] = [];
	let toolEnv: Record<string, string> | undefined;

	// EM: realHome is needed for both preset binds and tool path translation
	const realHome = getRealHome();
	const preset = TOOL_PRESETS[toolName];

	if (preset) {
		toolDescription = preset.description;

		const valid = await preset.validate();
		if (!valid) {
			process.exit(1);
		}

		const bindSpec = await preset.configBinds(realHome, SCODER_HOME);
		toolBinds = bindSpec.binds;
		toolDirs = bindSpec.dirs;
		toolEnv = bindSpec.env;
	}

	// EM: --ide: a companion IDE (must have a registered preset — an
	// EM: unregistered tool has no way to get the binds it would need, e.g.
	// EM: X11 access, and would just fail silently in the background) whose
	// EM: binds/dirs/env are merged into the one sandbox alongside the
	// EM: primary tool's own. See design/features/ide-companion.md.
	const idePreset = options.ide ? TOOL_PRESETS[options.ide] : undefined;
	let hostIdeBin: string | null = null;
	let ideBin: string | undefined;
	let ideArgs: string[] = [];

	if (options.ide) {
		if (!idePreset) {
			error(`no preset registered for --ide ${options.ide}`);
			error("Only tools with a registered preset can be a companion IDE");
			process.exit(1);
		}

		const ideValid = await idePreset.validate();
		if (!ideValid) {
			process.exit(1);
		}

		// EM: Deduplicated, not just concatenated: an IDE preset can itself
		// EM: include another tool's own binds (rstudio includes pi's, since
		// EM: pi can also run in its embedded terminal), so the exact same
		// EM: entry can legitimately come from both the primary tool's own
		// EM: preset and the IDE's — harmless to bwrap either way (a repeated
		// EM: bind is a no-op), but a clean merge is worth it over leaving
		// EM: literal duplicate --dir/--bind flags in the built command.
		const ideBindSpec = await idePreset.configBinds(realHome, SCODER_HOME);
		toolBinds = dedupeBinds([...toolBinds, ...ideBindSpec.binds]);
		toolDirs = [...new Set([...toolDirs, ...ideBindSpec.dirs])];
		toolEnv = { ...toolEnv, ...ideBindSpec.env };

		hostIdeBin = await which(options.ide);
		if (!hostIdeBin) {
			error(`${options.ide} not found in PATH`);
			process.exit(1);
		}
	}

	// EM: Resolve the tool on the host, where it actually exists...
	const hostToolBin = await which(toolName);
	if (!hostToolBin) {
		error(`${toolName} not found in PATH`);
		process.exit(1);
	}

	// EM: ...then translate it into the sandbox namespace before it becomes the
	// EM: exec target. The sandbox replaces /home with a tmpfs holding only
	// EM: /home/scoder, so a host path under $HOME does not exist inside it.
	const homePrefixes = await resolveHomePrefixes();
	const toolBin = toSandboxPath(hostToolBin, homePrefixes);
	if (hostIdeBin) {
		ideBin = toSandboxPath(hostIdeBin, homePrefixes);
	}

	let worktreeInfo: GitWorktreeInfo | null = null;
	let protectionConfig: ProtectionConfig | undefined;
	let sandboxProjDir = "";
	let identity: SandboxIdentity | undefined;
	let sshTunnel: SshTunnel | null = null;

	const uid = getSandboxUid();
	const gid = getSandboxGid();

	if (options.worktree) {
		worktreeInfo = await setupGitWorktree(true);
		if (!worktreeInfo) {
			error("failed to set up git worktree");
			process.exit(1);
		}

		// EM: The worktree is checked out from a commit, so uncommitted work in
		// EM: the user's checkout is invisible to the agent. Warn rather than
		// EM: refuse — the user may not need those changes in the session.
		if (await hasUncommittedChanges(worktreeInfo.sourceRepoRoot)) {
			warning("Your checkout has uncommitted changes the agent will not see");
			warning(
				`The session starts from ${worktreeInfo.sourceRefLabel} in ${worktreeInfo.worktreeDir}`,
			);
			warning("Commit or stash them first if the agent needs them");
		}

		sandboxProjDir = `${SCODER_HOME}/${worktreeInfo.projDir}`;
		protectionConfig = await setupProtection(
			worktreeInfo.worktreeDir,
			sandboxProjDir,
		);

		const agentsSnapshotBind = await setupAgentsSnapshot();
		if (agentsSnapshotBind && protectionConfig) {
			protectionConfig.safeBinds.push(agentsSnapshotBind);
		}

		const localBinBind = await setupLocalBinSnapshot(
			toolBinds.map((bind) => bind.dest),
		);
		if (localBinBind && protectionConfig) {
			protectionConfig.safeBinds.push(localBinBind);
		}

		const resolvConfBind = await setupResolvConf();
		if (resolvConfBind && protectionConfig) {
			protectionConfig.safeBinds.push(resolvConfBind);
		}

		// EM: passwd/group describing only the sandbox user. Pushed here so the
		// EM: binds are applied after the read-only /etc bind.
		identity = await setupSandboxIdentity(uid, gid);
		if (protectionConfig) {
			protectionConfig.safeBinds.push(...identity.binds);
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

		const localBinBind = await setupLocalBinSnapshot(
			toolBinds.map((bind) => bind.dest),
		);
		if (localBinBind && protectionConfig) {
			protectionConfig.safeBinds.push(localBinBind);
		}

		const resolvConfBind = await setupResolvConf();
		if (resolvConfBind && protectionConfig) {
			protectionConfig.safeBinds.push(resolvConfBind);
		}

		// EM: passwd/group describing only the sandbox user. Pushed here so the
		// EM: binds are applied after the read-only /etc bind.
		identity = await setupSandboxIdentity(uid, gid);
		if (protectionConfig) {
			protectionConfig.safeBinds.push(...identity.binds);
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

	// EM: Independent of worktree vs. direct mode, so set up once here.
	// EM: Only when the user passed no args of their own — an explicit
	// EM: argument (e.g. a specific file to open) always wins.
	if (preset?.resolveArgs && toolArgs.length === 0) {
		const hostProjectDir =
			options.worktree && worktreeInfo
				? worktreeInfo.worktreeDir
				: process.cwd();
		toolArgs = await preset.resolveArgs(hostProjectDir, sandboxProjDir);
	}

	// EM: Same reasoning, for the companion IDE's own argv.
	if (idePreset?.resolveArgs) {
		const hostProjectDir =
			options.worktree && worktreeInfo
				? worktreeInfo.worktreeDir
				: process.cwd();
		ideArgs = await idePreset.resolveArgs(hostProjectDir, sandboxProjDir);
	}

	// EM: Independent of worktree vs. direct mode, so set up once here rather
	// EM: than duplicated into both branches above.
	if (options.sshTarget) {
		const sshHomeBindConflict = protectionConfig?.safeBinds.some(
			(bind) =>
				bind.dest === `${SCODER_HOME}/.ssh` ||
				bind.dest.startsWith(`${SCODER_HOME}/.ssh/`),
		);
		if (sshHomeBindConflict) {
			error(
				".agentreadonly binds $HOME/.ssh, which conflicts with --allow-ssh — use one or the other",
			);
			process.exit(1);
		}

		const sshAccess = options.dryRun
			? describeSshAccess(options.sshTarget)
			: await startSshTunnel(options.sshTarget);

		if (!sshAccess) {
			// startSshTunnel has already explained why.
			process.exit(1);
		}

		if (protectionConfig) {
			protectionConfig.safeBinds.push(...sshAccess.binds);
			protectionConfig.dirs?.push(...sshAccess.dirs);
		}
		sshTunnel = sshAccess.tunnel;
	}

	// EM: Same reasoning as the ssh block above — independent of worktree vs.
	// EM: direct mode, so set up once here.
	if (protectionConfig) {
		const projectRoot =
			options.worktree && worktreeInfo
				? worktreeInfo.worktreeDir
				: process.cwd();

		// EM: .agentports replaces --llm-port entirely: read what's already
		// EM: configured, then (outside --dry-run, which must stay side-effect
		// EM: free) let the LLM auto-detect probe seed it additively on a hit.
		// EM: readAgentPorts throws rather than exiting itself (see its own
		// EM: comment) — this is the one caller for which exiting is correct,
		// EM: since nothing is running yet.
		try {
			options.openPorts = await readAgentPorts(projectRoot);
		} catch (err) {
			error(`${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}

		if (!options.dryRun) {
			const detectedPort = await detectDefaultLlmPort();
			if (detectedPort && !options.openPorts.includes(detectedPort)) {
				await appendAgentPort(projectRoot, detectedPort);
				options.openPorts.push(detectedPort);
			}
		}

		const agentPortsBind = await getAgentPortsBind(
			projectRoot,
			sandboxProjDir,
			options.dryRun,
		);
		if (agentPortsBind) {
			protectionConfig.safeBinds.push(agentPortsBind);
		}

		await setupScratchLink(projectRoot, protectionConfig);
	}

	const config = {
		worktreeInfo,
		sandboxProjDir,
		options,
		toolBinds,
		toolDirs,
		toolBin,
		toolArgs,
		toolEnv,
		ideBin,
		ideArgs,
		protectionConfig,
	};

	const bwrapCmd = await buildBwrapCommand(config);

	// EM: Pre-flight the exec target(s). A tool installed under $HOME only
	// EM: works if its directory is bound into the sandbox; without this check
	// EM: the failure surfaces as a bare "execvp: No such file or directory"
	// EM: from pasta — for --ide, that would otherwise show up as the IDE
	// EM: silently failing in its background job, with no diagnostic at all.
	const bindDests = collectBindDests(bwrapCmd);
	const toolReachable = checkExecTargetReachable(
		toolName,
		toolBin,
		hostToolBin,
		bindDests,
		realHome,
		options.dryRun,
	);
	if (!toolReachable && !options.dryRun) {
		process.exit(1);
	}

	if (options.ide && ideBin && hostIdeBin) {
		const ideReachable = checkExecTargetReachable(
			options.ide,
			ideBin,
			hostIdeBin,
			bindDests,
			realHome,
			options.dryRun,
		);
		if (!ideReachable && !options.dryRun) {
			process.exit(1);
		}
	}

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
		// EM: Dry-run mode outputs both stages without executing. Printing only
		// EM: the bwrap command would no longer describe what actually runs.
		// EM: Implements HAS_FEATURE: dry-run-mode
		const stages = describeLaunch(bwrapCmd, options);

		info("Dry run — would execute, in order:");
		console.log("");
		info("1. sandbox (blocks until pasta has attached):");
		printBwrapCommand(stages.sandbox);
		console.log("");
		info("2. network sidecar, attached to the sandbox's netns:");
		printBwrapCommand(stages.pasta);
		console.log("");
		process.exit(0);
	}

	// EM: Mask AGENTS.md overlay from git so the agent can use git freely inside the sandbox
	// EM: Implements AGENTS.md overlay exclusion via .git/info/exclude
	const repoRoot =
		options.worktree && worktreeInfo ? worktreeInfo.worktreeDir : process.cwd();
	await addGitExclude(repoRoot, "AGENTS.md");

	let exitCode = 0;

	try {
		// EM: Two stages: bwrap creates the namespaces and waits, pasta attaches
		// EM: to the netns from outside, then the tool is released. See
		// EM: src/sandbox/launch.ts and ADR 0001.
		const result = await launchSandbox(
			bwrapCmd,
			options,
			toolDescription,
			repoRoot,
		);
		exitCode = result.exitCode;

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
	} finally {
		// EM: Restore normal git tracking for AGENTS.md after session.
		// EM: process.exit() must stay OUTSIDE this try — it terminates the
		// EM: process synchronously and pending finally blocks do not run.
		await removeGitExclude(repoRoot, "AGENTS.md");

		// EM: Remove the passwd/group overlay files
		if (identity) {
			await rm(identity.dir, { recursive: true, force: true });
		}

		// EM: ssh runs outside the sandbox, like pasta — nothing in the
		// EM: sandbox's own lifecycle reaps it.
		await stopSshTunnel(sshTunnel);
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

		await commitAllChanges(
			worktreeInfo.worktreeDir,
			"Committing session by scoder.",
		);

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

// ### checkExecTargetReachable
// Shared between the primary tool and (if present) the --ide companion:
// a $HOME-installed binary only resolves inside the sandbox if its
// directory is among the command's bind destinations. Reports the same
// diagnostic either way, naming whichever tool actually has the problem.
function checkExecTargetReachable(
	name: string,
	sandboxBin: string,
	hostBin: string,
	bindDests: string[],
	realHome: string,
	dryRun: boolean,
): boolean {
	if (sandboxBin === hostBin || isUnderAny(sandboxBin, bindDests)) {
		return true;
	}

	const report = dryRun ? warning : error;
	const hostDir = hostBin.slice(0, hostBin.lastIndexOf("/"));
	report(`${name} is installed at ${hostBin}, under your home directory`);
	report(
		"The sandbox uses an ephemeral home, and that directory is not bound into it",
	);
	report(`Fix: install ${name} system-wide, or bind its directory by adding`);
	report(`     ${hostDir.replace(realHome, "$HOME")}/ to .agentreadonly`);
	return false;
}

// Two binds are the same entry if type, source, and dest all match — the
// only way a duplicate can arise here (a preset shared between the primary
// tool and an --ide companion, e.g. piConfigBinds) produces an exact
// duplicate, not a near-miss, so this is deliberately simple rather than a
// general-purpose overlap check.
function dedupeBinds(binds: BindMount[]): BindMount[] {
	const seen = new Set<string>();
	return binds.filter((bind) => {
		const key = `${bind.type}\0${bind.source}\0${bind.dest}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
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
