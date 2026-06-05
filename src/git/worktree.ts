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
  worktreeDir: string
): Promise<void> {
  const proc = await Bun.spawn(
    ["git", "worktree", "add", "-b", branch, worktreeDir, "HEAD"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

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

  const currentWorktreeDir = await findWorktreeForBranch(
    worktreeList,
    worktreeBranch
  );

  if (
    currentWorktreeDir &&
    (await realpath(currentWorktreeDir)) === repoRootReal
  ) {
    info(`Already in scoder worktree: ${currentWorktreeDir}`);

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

  if (!(await hasBranch(worktreeBranch))) {
    info(`Creating worktree branch: ${worktreeBranch}`);
    info(`Worktree path: ${worktreeDir}`);

    await createWorktree(worktreeBranch, worktreeDir);
    info("Worktree created successfully");
  } else {
    const existingWorktree = await findWorktreeForBranch(
      worktreeList,
      worktreeBranch
    );

    if (existingWorktree) {
      const worktreeDirReal = await realpath(existingWorktree);

      return {
        worktreeDir: worktreeDirReal,
        worktreeBranch,
        baseCommit: null,
        gitDir,
        projDir,
        sourceRepoRoot: repoRootReal,
        sourceBranch: sourceBranch || null,
        sourceHead,
        sourceRefLabel: formatRefLabel(sourceBranch, sourceHead),
      };
    }
  }

  const finalWorktreeList = await getWorktreeList();
  const foundWorktreeDir = await findWorktreeForBranch(
    finalWorktreeList,
    worktreeBranch
  );

  if (!foundWorktreeDir) {
    error(
      `Branch ${worktreeBranch} exists but is not a git worktree - you'll need to manually review it.`
    );
    info(`to review:   git diff ${worktreeBranch}`);
    info(`to delete:   git branch -D ${worktreeBranch}`);
    process.exit(1);
  }

  const worktreeDirReal = await realpath(foundWorktreeDir);

  return {
    worktreeDir: worktreeDirReal,
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
