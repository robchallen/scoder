#!/usr/bin/env bun

// EM: Main orchestration entry point for scoder sandbox runner
// EM: Implements dry-run-mode, sandbox-isolation, and git-worktree-isolation features
// EM: Coordinates CLI parsing, tool preset selection, sandbox construction, and session management

import { configureAppArmor } from "./cli/apparmor.ts";
import { installDependencies } from "./cli/dependencies.ts";
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
	setupReadWriteAccess,
	setupResolvConf,
} from "./git/protection.ts";
import {
	commitAllChanges,
	getCommitCount,
	getDiffStat,
	hasUncommittedChanges,
	isInGitRepo,
	setupGitWorktree,
} from "./git/worktree.ts";
import type { XpraWrap } from "./sandbox/builder.ts";
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
import { XPRA_SOCKET_DEST, xpraSocketHostPath } from "./sandbox/xpra.ts";
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
		await installDependencies();
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

		const bindSpec = await preset.configBinds(realHome, realHome);
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
		const ideBindSpec = await idePreset.configBinds(realHome, realHome);
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

	// EM: ...then canonicalize its home spelling before it becomes the exec
	// EM: target. The sandbox replaces /home with a tmpfs holding only the
	// EM: real $HOME, freshly created and empty until binds populate it — a
	// EM: host tool path spelled via a symlinked $HOME's resolved form needs
	// EM: rewriting onto the raw $HOME spelling actually bound in. See
	// EM: toSandboxPath in utils/paths.ts.
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
	let resolvConfSnapshotPath: string | null = null;

	const uid = getSandboxUid();
	const gid = getSandboxGid();

	if (options.worktree) {
		// EM: The worktree is checked out from a commit, so uncommitted work in
		// EM: the user's checkout would be invisible to the agent — refuse
		// EM: rather than silently starting a session that can't see it.
		// EM: Checked before setupGitWorktree runs (not after), so a doomed
		// EM: launch doesn't still leave a branch/worktree behind. Not-a-git-repo
		// EM: is still caught by setupGitWorktree's own check below:
		// EM: hasUncommittedChanges returns false (not true) for a non-repo cwd.
		if (await hasUncommittedChanges(process.cwd())) {
			error(
				"--worktree requires a clean checkout — you have uncommitted changes",
			);
			error(
				"Commit or stash them first, or drop --worktree to run in direct mode",
			);
			process.exit(1);
		}

		worktreeInfo = await setupGitWorktree(true);
		if (!worktreeInfo) {
			error("failed to set up git worktree");
			process.exit(1);
		}

		// EM: worktreeInfo.worktreeDir is already the worktree's own real,
		// EM: unmapped path (see getWorktreesParentDir in git/worktree.ts) —
		// EM: no remapping under $HOME, deliberately: with $HOME no longer a
		// EM: separate synthetic namespace, mapping it under $HOME/<projDir>
		// EM: would collide with the project's own real checkout at that same
		// EM: path.
		sandboxProjDir = worktreeInfo.worktreeDir;
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
			resolvConfSnapshotPath = resolvConfBind.source;
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
		// EM: Direct mode used to tolerate a non-git directory, silently: git
		// EM: commands elsewhere (addGitExclude/removeGitExclude for the
		// EM: AGENTS.md overlay mask, getProjDir's repo-root resolution) just
		// EM: no-op or fall back to cwd without checking exit codes, so nothing
		// EM: crashed — but there is no undo/audit trail for whatever the agent
		// EM: does, which cuts against the project's own "you can always
		// EM: review with git diff/status" safety story. Refuse up front
		// EM: instead, with the same wording setupGitWorktree already uses for
		// EM: the same requirement in worktree mode.
		if (!(await isInGitRepo())) {
			error("not inside a git repository");
			error("scoder must be run from within a git repo");
			process.exit(1);
		}

		const cwd = process.cwd();
		// EM: Mirrored at its own real path, same as toolBin above — a plain
		// EM: home-prefix concatenation would mis-map a project living
		// EM: outside $HOME (e.g. /opt/proj) onto a fabricated $HOME/opt/proj
		// EM: that has no relation to where it actually lives.
		sandboxProjDir = toSandboxPath(cwd, homePrefixes);
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
			resolvConfSnapshotPath = resolvConfBind.source;
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

	// EM: Independent of worktree vs. direct mode, so set up once here — see
	// EM: ProtectionConfig.dependencyDirs (protection.ts): the sandbox-side
	// EM: destinations of every .agentreadonly $HOME/... entry, as their
	// EM: own distinct list, so a preset's resolveArgs can import each as
	// EM: its own project (e.g. eclipse) without guessing which
	// EM: safeBinds entries are dependency-shaped.
	const dependencyDirs = protectionConfig?.dependencyDirs ?? [];

	// EM: Always called when present — unlike a plain default-when-empty,
	// EM: a preset may need its own fixed flags ahead of the user's own
	// EM: args on every launch (e.g. eclipse's -data/-importProject), not
	// EM: just when the user gave none at all. Each preset's own resolveArgs
	// EM: decides what to do with existingArgs — see types.ts.
	if (preset?.resolveArgs) {
		const hostProjectDir =
			options.worktree && worktreeInfo
				? worktreeInfo.worktreeDir
				: process.cwd();
		toolArgs = await preset.resolveArgs(
			hostProjectDir,
			sandboxProjDir,
			toolArgs,
			dependencyDirs,
		);
	}

	// EM: Same reasoning, for the companion IDE's own argv — existingArgs is
	// EM: always [] here, since there is no way for the user to supply the
	// EM: --ide companion's own arguments directly.
	if (idePreset?.resolveArgs) {
		const hostProjectDir =
			options.worktree && worktreeInfo
				? worktreeInfo.worktreeDir
				: process.cwd();
		ideArgs = await idePreset.resolveArgs(
			hostProjectDir,
			sandboxProjDir,
			ideArgs,
			dependencyDirs,
		);
	}

	// EM: Independent of worktree vs. direct mode, so set up once here rather
	// EM: than duplicated into both branches above.
	if (options.sshTarget) {
		const sshHomeBindConflict = protectionConfig?.safeBinds.some(
			(bind) =>
				bind.dest === `${realHome}/.ssh` ||
				bind.dest.startsWith(`${realHome}/.ssh/`),
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

		await setupReadWriteAccess(
			projectRoot,
			sandboxProjDir,
			protectionConfig,
			options.dryRun,
		);
	}

	// EM: Which program, if any, runs under an xpra server inside the sandbox.
	// EM: A GUI preset is a GUI preset whether it was named as the primary tool
	// EM: (`scoder rstudio`) or as the companion (`--ide rstudio`), so both are
	// EM: checked; the companion wins if somehow both are GUI, since that is
	// EM: the arrangement --ide exists for. Exactly one xpra server per
	// EM: session: a second would need a second socket and a second client, and
	// EM: nothing wants two GUI programs in one sandbox today.
	const xpra: XpraWrap | undefined = idePreset?.gui
		? { socket: XPRA_SOCKET_DEST, target: "ide" }
		: preset?.gui
			? { socket: XPRA_SOCKET_DEST, target: "harness" }
			: undefined;

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
		ideShutdown: idePreset?.ideShutdown,
		xpra,
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

	// EM: xpra is checked as well as, never instead of, the two above. The IDE
	// EM: is still exec'd inside the sandbox — all that changed is which layer
	// EM: execs it — and it remains by far the likelier of the two to fail
	// EM: this test, since it can live in /opt or under ~/.local. xpra comes
	// EM: from the upstream repo at /usr/bin/xpra, under the wholesale
	// EM: --ro-bind /usr, so checking it is cheap insurance rather than the
	// EM: interesting case.
	// EM:
	// EM: Worth more than a footnote because the failure mode gets *quieter*
	// EM: under xpra. An unreachable IDE used to mean bwrap could not exec it
	// EM: and said so on the console; now the server starts cleanly and fails
	// EM: to spawn its child, and that lands in the xpra log, which is
	// EM: deliberately redirected away from the console. This check stops
	// EM: being a nicer diagnostic than the eventual failure and becomes close
	// EM: to the only thing that will tell the user what went wrong.
	if (xpra) {
		const hostXpraBin = await which("xpra");
		if (hostXpraBin) {
			const xpraReachable = checkExecTargetReachable(
				"xpra",
				hostXpraBin,
				hostXpraBin,
				bindDests,
				realHome,
				options.dryRun,
			);
			if (!xpraReachable && !options.dryRun) {
				process.exit(1);
			}
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
			resolvConfSnapshotPath,
			xpra ? xpraSocketHostPath() : null,
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

		// EM: ssh runs outside the sandbox, like pasta — nothing in the
		// EM: sandbox's own lifecycle reaps it.
		await stopSshTunnel(sshTunnel);

		// EM: Nothing unstages /tmp/scoder-<id> here. utils/session.ts
		// EM: registers a process 'exit' handler for it, which covers this
		// EM: path and the two dozen process.exit() calls that never reach
		// EM: this finally at all.
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

// EM: Names that look sensitive enough to redact from --dry-run's own
// EM: printed preview — a substring heuristic, not an exact match against
// EM: builder.ts's own passThrough list: that list grows as new providers
// EM: are added, and a hardcoded exact-name list here would silently stop
// EM: covering a new one the moment it's added there. Reported directly:
// EM: --dry-run's preview printed several real API keys/tokens in
// EM: cleartext (COPILOT_GITHUB_TOKEN, DEEPSEEK_API_KEY, HF_TOKEN, and
// EM: others), pasted directly into a chat log by a user who had no
// EM: reason to expect a *preview* to expose live secrets — --dry-run's
// EM: own contract (side-effect free, safe to run to inspect what would
// EM: happen) implies it should be safe to run and share the output of,
// EM: which printing real secret values directly contradicts.
const SENSITIVE_ENV_VAR_PATTERN = /token|key|secret|password|credential/i;

function looksLikeSensitiveEnvVar(name: string): boolean {
	return SENSITIVE_ENV_VAR_PATTERN.test(name);
}

function printBwrapCommand(cmd: string[]): void {
	process.stdout.write(cmd[0]);

	for (let i = 1; i < cmd.length; i++) {
		const arg = cmd[i];
		const isSetenvValue =
			cmd[i - 2] === "--setenv" && looksLikeSensitiveEnvVar(cmd[i - 1] || "");
		const printed = isSetenvValue ? "<redacted>" : arg;

		if (arg?.startsWith("--")) {
			process.stdout.write(` \\\n  ${printed}`);
		} else if (arg) {
			process.stdout.write(` ${printed}`);
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
	// EM: bindDests is collected from the actual built command, including the
	// EM: wholesale /usr, /bin, /opt, etc. binds — so a system-installed tool
	// EM: is already covered by isUnderAny alone. A `sandboxBin === hostBin`
	// EM: shortcut used to also catch that case, back when only a path
	// EM: outside $HOME could produce that equality (toSandboxPath rewrote
	// EM: every $HOME path onto a separate namespace). Now that the sandbox's
	// EM: $HOME is the real $HOME (see path-mirroring), toSandboxPath is
	// EM: identity for $HOME paths too, so that shortcut would trivially
	// EM: "pass" a $HOME-installed tool whose own directory was never bound —
	// EM: exactly the unreachable case this check exists to catch. Removed;
	// EM: isUnderAny is the only correct test now.
	if (isUnderAny(sandboxBin, bindDests)) {
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
