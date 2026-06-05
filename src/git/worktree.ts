import { error, info, warning, infoBlue } from "../utils/logger.ts";
import { GitWorktreeInfo } from "../types.ts";

export async function isInGitRepo(): Promise<boolean> {
  try {
    const proc = await Bun.spawn(
      ["git", "rev-parse", "--git-dir"],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: process.cwd(),
      }
    );

    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export async function getGitCommonDir(): Promise<string> {
  const proc = await Bun.spawn(
    ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error("Failed to get git common dir");
  }

  const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
  return new TextDecoder().decode(stdoutBytes).trim();
}

export async function getRepoRoot(): Promise<string> {
  const proc = await Bun.spawn(
    ["git", "rev-parse", "--show-toplevel"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error("Failed to get repo root");
  }

  const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
  return new TextDecoder().decode(stdoutBytes).trim();
}

export async function getCurrentBranch(): Promise<string | null> {
  const proc = await Bun.spawn(
    ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  await proc.exited;

  if (proc.exitCode !== 0) {
    return null;
  }

  const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
  return new TextDecoder().decode(stdoutBytes).trim();
}

export async function getHeadCommit(): Promise<string> {
  const proc = await Bun.spawn(
    ["git", "rev-parse", "HEAD"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error("Failed to get HEAD commit");
  }

  const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
  return new TextDecoder().decode(stdoutBytes).trim();
}

export async function hasBranch(branch: string): Promise<boolean> {
  const proc = await Bun.spawn(
    ["git", "branch", "--list", branch],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  await proc.exited;

  const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
  const output = new TextDecoder().decode(stdoutBytes);
  return output.length > 0;
}

export async function getWorktreeList(): Promise<string> {
  const proc = await Bun.spawn(
    ["git", "worktree", "list", "--porcelain"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  await proc.exited;

  if (proc.exitCode !== 0) {
    return "";
  }

  const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
  return new TextDecoder().decode(stdoutBytes);
}

export async function createWorktree(
  branch: string,
  worktreeDir: string,
  branchExists: boolean = false
): Promise<void> {
  const args = branchExists
    ? ["git", "worktree", "add", worktreeDir, branch]
    : ["git", "worktree", "add", "-b", branch, worktreeDir, "HEAD"];

  const proc = await Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  await proc.exited;

  if (proc.exitCode !== 0) {
    const stderrBytes = await new Response(proc.stderr).arrayBuffer();
    const stderr = new TextDecoder().decode(stderrBytes);
    throw new Error(`Failed to create git worktree: ${stderr}`);
  }
}

export async function commitAllChanges(message: string): Promise<void> {
  const addProc = await Bun.spawn(
    ["git", "add", "-A"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  await addProc.exited;

  if (addProc.exitCode !== 0) {
    throw new Error("Failed to stage changes");
  }

  const commitProc = await Bun.spawn(
    ["git", "commit", "-m", message],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  await commitProc.exited;

  if (commitProc.exitCode !== 0) {
    const stderrBytes = await new Response(commitProc.stderr).arrayBuffer();
    const stderr = new TextDecoder().decode(stderrBytes);
    throw new Error(`Failed to commit: ${stderr}`);
  }
}

export async function hasUncommittedChanges(
  repoDir: string
): Promise<boolean> {
  const proc = await Bun.spawn(
    ["git", "-C", repoDir, "status", "--porcelain"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  await proc.exited;

  if (proc.exitCode !== 0) {
    return false;
  }

  const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
  const output = new TextDecoder().decode(stdoutBytes);
  return output.trim().length > 0;
}

export async function getCommitCount(
  repoDir: string,
  baseCommit: string | null
): Promise<number> {
  if (!baseCommit) {
    return 0;
  }

  const proc = await Bun.spawn(
    ["git", "-C", repoDir, "rev-list", `${baseCommit}..HEAD`, "--count"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  await proc.exited;

  if (proc.exitCode !== 0) {
    return 0;
  }

  const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
  const output = new TextDecoder().decode(stdoutBytes).trim();
  return parseInt(output, 10) || 0;
}

export async function getDiffStat(
  repoDir: string,
  baseCommit: string | null
): Promise<string> {
  if (!baseCommit) {
    return "";
  }

  const proc = await Bun.spawn(
    ["git", "-C", repoDir, "diff", "--stat", baseCommit, "HEAD"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  await proc.exited;

  if (proc.exitCode !== 0) {
    return "";
  }

  const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
  return new TextDecoder().decode(stdoutBytes);
}

export async function setupGitWorktree(
  useWorktree: boolean
): Promise<GitWorktreeInfo | null> {
  if (!useWorktree) {
    return null;
  }

  if (!(await isInGitRepo())) {
    error("not inside a git repository");
    error("scoder must be run from within a git repo");
    process.exit(1);
  }

  const gitDir = await getGitCommonDir();
  const repoRoot = await getRepoRoot();
  const repoRootReal = await realpath(repoRoot);
  const sourceBranch = await getCurrentBranch();
  const sourceHead = await getHeadCommit();

  const projName = repoRoot.split("/").pop() || "unknown";
  const worktreeBranch = `scoder/${projName}`;

  let projDir: string;
  if (repoRoot.startsWith(process.env.HOME || "")) {
    projDir = repoRoot.slice((process.env.HOME || "").length + 1);
  } else {
    projDir = repoRoot.slice(1);
  }

  const worktreeDir = `/tmp/scoder/${projDir}`;
  const worktreeList = await getWorktreeList();

  let existingWorktree = await findWorktreeForBranch(
    worktreeList,
    worktreeBranch
  );

  if (
    existingWorktree &&
    (await realpath(existingWorktree)) === repoRootReal
  ) {
    info(`Already in scoder worktree: ${existingWorktree}`);

    return {
      worktreeDir: repoRootReal,
      worktreeBranch,
      baseCommit: sourceHead,
      gitDir,
      projDir,
      sourceRepoRoot: repoRootReal,
      sourceBranch: sourceBranch || null,
      sourceHead,
      sourceRefLabel: formatRefLabel(sourceBranch, sourceHead),
    };
  }

  if (existingWorktree) {
    let dirValid = false;
    try {
      const stat = await Bun.file(existingWorktree).stat();
      dirValid = stat.isDirectory();
    } catch {
      dirValid = false;
    }

    if (!dirValid) {
      info(`Stale worktree reference found, pruning...`);
      const pruneProc = await Bun.spawn(["git", "worktree", "prune"]);
      await pruneProc.exited;
      existingWorktree = null;
    }
  }

  const branchExists = await hasBranch(worktreeBranch);
  let isReused = false;

  if (!branchExists) {
    info(`Creating worktree branch: ${worktreeBranch}`);
    info(`Worktree path: ${worktreeDir}`);

    await createWorktree(worktreeBranch, worktreeDir, false);
    info("Worktree created successfully");
  } else if (!existingWorktree) {
    info(`Recreating missing worktree path: ${worktreeDir}`);
    await createWorktree(worktreeBranch, worktreeDir, true);
    info("Worktree recreated successfully");
    isReused = true;
  } else {
    isReused = true;
  }

  const finalWorktreeList = await getWorktreeList();
  const foundWorktreeDir = await findWorktreeForBranch(
    finalWorktreeList,
    worktreeBranch
  );

  if (!foundWorktreeDir) {
    error(
      `Failed to locate worktree for ${worktreeBranch} after setup.`
    );
    process.exit(1);
  }

  const worktreeDirReal = await realpath(foundWorktreeDir);

  return {
    worktreeDir: worktreeDirReal,
    worktreeBranch,
    baseCommit: isReused ? null : sourceHead,
    gitDir,
    projDir,
    sourceRepoRoot: repoRootReal,
    sourceBranch: sourceBranch || null,
    sourceHead,
    sourceRefLabel: formatRefLabel(sourceBranch, sourceHead),
  };
}

async function findWorktreeForBranch(
  worktreeList: string,
  branch: string
): Promise<string | null> {
  const lines = worktreeList.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === `branch refs/heads/${branch}`) {
      for (let j = i - 1; j >= 0; j--) {
        const prevLine = lines[j];
        if (prevLine && prevLine.startsWith("worktree ")) {
          return prevLine.slice("worktree ".length).trim();
        }
      }
    }
  }

  return null;
}

async function realpath(path: string): Promise<string> {
  const proc = await Bun.spawn(["realpath", path], {
    stdout: "pipe",
    stderr: "pipe",
  });

  await proc.exited;

  if (proc.exitCode !== 0) {
    return path;
  }

  const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
  return new TextDecoder().decode(stdoutBytes).trim();
}

function formatRefLabel(
  branch: string | null,
  head: string
): string {
  const shortHead = head.slice(0, 12);

  if (branch) {
    return `${branch}@${shortHead}`;
  }

  return `HEAD@${shortHead}`;
}

export async function getProjDir(cwd: string): Promise<string> {
  const realHome = process.env.HOME || "/home/user";
  let rootDir = cwd;

  try {
    if (await isInGitRepo()) {
      rootDir = await getRepoRoot();
    }
  } catch {
    // Ignore and use cwd
  }

  if (rootDir.startsWith(realHome)) {
    return rootDir.slice(realHome.length + 1);
  } else {
    return rootDir.slice(1);
  }
}
