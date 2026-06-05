#!/usr/bin/env bun

import { parseArgs, printUsage, printVersion } from "./cli/parse-args.ts";
import { setQuiet, error, info, infoBlue, warning } from "./utils/logger.ts";
import {
  checkBwrapUserns,
  commandExists,
  detectDefaultLlmPort,
} from "./utils/checks.ts";
import { configureAppArmor } from "./cli/apparmor.ts";
import {
  setupGitWorktree,
  commitAllChanges,
  getCommitCount,
  getDiffStat,
  hasUncommittedChanges,
} from "./git/worktree.ts";
import { TOOL_PRESETS } from "./tools/presets.ts";
import { buildBwrapCommand } from "./sandbox/builder.ts";
import {
  setupProtection,
  getAgentsMdOverlayBind,
  setupAgentsSnapshot,
  setupResolvConf,
} from "./git/protection.ts";
import { GitWorktreeInfo, BindMount } from "./types.ts";

const SCODER_HOME = "/home/scoder";

async function main(): Promise<void> {
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
  let protectionConfig = undefined;

  if (options.worktree) {
    worktreeInfo = await setupGitWorktree(true);

    const sandboxProjDir = `${SCODER_HOME}/${worktreeInfo!.projDir}`;
    protectionConfig = await setupProtection(
      worktreeInfo!.worktreeDir,
      sandboxProjDir
    );

    const agentsSnapshotBind = await setupAgentsSnapshot();
    if (agentsSnapshotBind && protectionConfig) {
      protectionConfig.safeBinds.push(agentsSnapshotBind);
    }

    const resolvConfBind = await setupResolvConf();
    if (resolvConfBind && protectionConfig) {
      protectionConfig.safeBinds.push(resolvConfBind);
    }

    if (
      protectionConfig?.agentsMdOverlay &&
      protectionConfig
    ) {
      const agentsMdBind = getAgentsMdOverlayBind(
        protectionConfig.agentsMdOverlay,
        sandboxProjDir
      );
      if (agentsMdBind) {
        protectionConfig.safeBinds.push(agentsMdBind);
      }
    }
  } else {
    const cwd = process.cwd();
    protectionConfig = await setupProtection(cwd, cwd);

    const agentsSnapshotBind = await setupAgentsSnapshot();
    if (agentsSnapshotBind && protectionConfig) {
      protectionConfig.safeBinds.push(agentsSnapshotBind);
    }

    const resolvConfBind = await setupResolvConf();
    if (resolvConfBind && protectionConfig) {
      protectionConfig.safeBinds.push(resolvConfBind);
    }

    if (
      protectionConfig?.agentsMdOverlay &&
      protectionConfig
    ) {
      const agentsMdBind = getAgentsMdOverlayBind(
        protectionConfig.agentsMdOverlay,
        cwd
      );
      if (agentsMdBind) {
        protectionConfig.safeBinds.push(agentsMdBind);
      }
    }
  }

  const config = {
    worktreeInfo,
    options,
    toolBinds,
    toolDirs,
    toolBin,
    toolArgs,
    protectionConfig,
  };

  const bwrapCmd = await buildBwrapCommand(config);

  if (options.dryRun) {
    info("Dry run — would execute:");
    console.log("");
    printBwrapCommand(bwrapCmd);
    console.log("");
    process.exit(0);
  }

  info(`Launching ${toolDescription} in sandbox...`);

  if (options.worktree && worktreeInfo) {
    info(`Agent working files can be found at:   ${worktreeInfo.worktreeDir}`);
    info(`and interim commits viewed with:       git diff ${worktreeInfo.worktreeBranch}`);
  } else if (!options.worktree) {
    info(`Running in direct mode (no worktree isolation)`);
    info(`Working directory: ${process.cwd()}`);
  }

  const proc = Bun.spawn(bwrapCmd, {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  const exitCode = await proc.exited;

  if (options.worktree && worktreeInfo && protectionConfig) {
    await printSessionSummary(
      worktreeInfo,
      protectionConfig.agentsMdOverlay
    );
  } else if (!options.worktree && protectionConfig) {
    if (protectionConfig.agentsMdOverlay) {
      await Bun.write(protectionConfig.agentsMdOverlay, "");
    }
    info("Direct mode session complete (no git worktree changes to commit)");
  }

  process.exit(exitCode);
}

async function printSessionSummary(
  worktreeInfo: GitWorktreeInfo,
  agentsMdOverlay?: string
): Promise<void> {
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
      worktreeInfo.baseCommit
    );

    if (commitCount > 0) {
      infoBlue(`New commits: ${commitCount}`);

      const diffStat = await getDiffStat(
        worktreeInfo.worktreeDir,
        worktreeInfo.baseCommit
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
    info(`View diff:  git diff ${worktreeInfo.baseCommit}..${worktreeInfo.worktreeBranch}`);
  } else {
    info(`View diff:  git diff ${worktreeInfo.worktreeBranch}`);
  }

  info(`To discard: git worktree remove ${worktreeInfo.worktreeDir} && git branch -D ${worktreeInfo.worktreeBranch}`);
}

function printBwrapCommand(cmd: string[]): void {
  process.stdout.write(cmd[0]);

  for (let i = 1; i < cmd.length; i++) {
    const arg = cmd[i];

    if (arg && arg.startsWith("--")) {
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
