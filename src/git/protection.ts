import { info, error, warning } from "../utils/logger.ts";
import { BindMount } from "../types.ts";

const DEFAULT_PROTECTED = [
  ".github/",
  ".claude/",
  "opencode.json",
  ".gitignore",
  "package-lock.json",
  "poetry.lock",
  "Cargo.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
  "mise.toml",
];

const RESERVED_SANDBOX_PATHS = [
  "/home/scoder/.agents",
  "/home/scoder/.cache",
  "/home/scoder/.cargo",
  "/home/scoder/.claude",
  "/home/scoder/.config",
  "/home/scoder/.copilot",
  "/home/scoder/.gitconfig",
  "/home/scoder/.local",
  "/home/scoder/.m2",
  "/home/scoder/.npmrc",
  "/home/scoder/.pypirc",
  "/home/scoder/.Rprofile",
  "/home/scoder/.rustup",
  "/home/scoder/R",
];

export interface ProtectionConfig {
  protectedPaths: string[];
  safeBinds: BindMount[];
  agentsMdOverlay?: string;
}

export async function setupProtection(
  sourceDir: string,
  sandboxProjDir: string
): Promise<ProtectionConfig> {
  const protectedPaths: string[] = [];
  const safeBinds: BindMount[] = [];
  let agentsMdOverlay: string | undefined;

  const agentreadonlyPath = `${sourceDir}/.agentreadonly`;
  const agentreadonlyExists = await fileExists(agentreadonlyPath);

  if (agentreadonlyExists) {
    const content = await Bun.file(agentreadonlyPath).text();
    const lines = content.split("\n");

    for (const line of lines) {
      if (line.trim() === "" || line.trim().startsWith("#")) {
        continue;
      }

      if (line.startsWith("$HOME/")) {
        await registerAgentreadonlyHomeBind(line, safeBinds);
        continue;
      }

      const localMatches = await findProtectedPaths(sourceDir, line.trim());
      for (const match of localMatches) {
        appendUniquePath(protectedPaths, match);
      }
    }
  } else {
    protectedPaths.push(...DEFAULT_PROTECTED);
    await Bun.write(agentreadonlyPath, DEFAULT_PROTECTED.join("\n") + "\n");
  }

  for (const path of protectedPaths) {
    const cleanPath = path.endsWith("/") ? path.slice(0, -1) : path;
    if (cleanPath === "") continue;

    const src = `${sourceDir}/${cleanPath}`;
    const dest = `${sandboxProjDir}/${cleanPath}`;

    if (await fileOrDirExists(src)) {
      safeBinds.push({
        type: "ro-bind",
        source: src,
        dest,
      });
      info(`Protecting ${cleanPath} (read-only)`);
    }
  }

  if (agentreadonlyExists) {
    safeBinds.push({
      type: "ro-bind",
      source: agentreadonlyPath,
      dest: `${sandboxProjDir}/.agentreadonly`,
    });
  }

  agentsMdOverlay = await setupAgentsMdOverlay(sourceDir, sandboxProjDir);

  return { protectedPaths, safeBinds, agentsMdOverlay };
}

async function registerAgentreadonlyHomeBind(
  homePathExpr: string,
  binds: BindMount[]
): Promise<void> {
  const realHome = process.env.HOME || "/home/user";
  const relativePath = homePathExpr.slice("$HOME/".length);
  const sourcePath = `${realHome}/${relativePath}`;

  const sourceReal = await realpath(sourcePath);

  if (!sourceReal || !(await fileOrDirExists(sourceReal))) {
    error(
      `.agentreadonly HOME bind must reference an existing directory: ${homePathExpr}`
    );
    process.exit(1);
  }

  if (
    sourceReal !== realHome &&
    !sourceReal.startsWith(`${realHome}/`)
  ) {
    error(`.agentreadonly HOME bind escapes HOME: ${homePathExpr}`);
    process.exit(1);
  }

  const sandboxDest = `/home/scoder/${relativePath}`;

  for (const reservedPath of RESERVED_SANDBOX_PATHS) {
    if (pathsOverlap(sandboxDest, reservedPath)) {
      error(
        `.agentreadonly HOME bind overlaps reserved sandbox path: ${homePathExpr}`
      );
      process.exit(1);
    }
  }

  await addScoderDirTree(sandboxDest, binds);
  binds.push({
    type: "ro-bind",
    source: sourceReal,
    dest: sandboxDest,
  });

  info(`Binding ${homePathExpr} to ${sandboxDest} (read-only)`);
}

async function addScoderDirTree(
  sandboxPath: string,
  binds: BindMount[]
): Promise<void> {
  const SCODER_HOME = "/home/scoder";

  if (sandboxPath === SCODER_HOME) {
    return;
  }

  const relativePath = sandboxPath.slice(`${SCODER_HOME}/`.length);
  const parts = relativePath.split("/");

  let currentPath = SCODER_HOME;
  for (const part of parts) {
    currentPath = `${currentPath}/${part}`
    if (!binds.some((b) => b.dest === currentPath)) {
      binds.push({
        type: "bind",
        source: currentPath,
        dest: currentPath,
      });
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const l = left.endsWith("/") ? left.slice(0, -1) : left;
  const r = right.endsWith("/") ? right.slice(0, -1) : right;

  return (
    l === r ||
    l.startsWith(`${r}/`) ||
    r.startsWith(`${l}/`)
  );
}

async function findProtectedPaths(
  worktreeDir: string,
  pattern: string
): Promise<string[]> {
  try {
    const cleanPattern = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;

    const proc = await Bun.spawn(
      [
        "find",
        cleanPattern,
        "-maxdepth",
        "100",
        "-prune",
      ],
      {
        cwd: worktreeDir,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    await proc.exited;

    if (proc.exitCode !== 0) {
      return [];
    }

    const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
    const output = new TextDecoder().decode(stdoutBytes);

    const paths = output
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.replace(/^\.\//, ""))
      .sort();

    return [...new Set(paths)];
  } catch {
    return [];
  }
}

async function setupAgentsMdOverlay(
  sourceDir: string,
  sandboxProjDir: string
): Promise<string | undefined> {
  const agentsSrc = `${sourceDir}/AGENTS.md`;
  const agentsMdExists = await fileExists(agentsSrc);

  const overlayFile = await createTempFile("scoder-agents-md");

  if (agentsMdExists) {
    const content = await Bun.file(agentsSrc).text();
    await Bun.write(overlayFile, content + "\n");
  } else {
    await Bun.write(overlayFile, "");
  }

  const sandboxSection = `## scoder sandbox

This section is injected by scoder inside the sandbox and is not part of the repository.

- You are running inside a scoder sandbox.
- \`/home/scoder\` is an ephemeral sandbox home. Other paths in your context may be stale if they refer to the host's home path. Always use paths relative to $HOME.
${sourceDir.startsWith("/tmp/scoder/") ? "- This checkout is an isolated git worktree managed by scoder.\n- Commit after all changes otherwise your edits will be lost.\n" : ""}- Locally hosted HTTP MCP servers may not be available.
- You cannot edit files like \`AGENTS.md\` or \`.agents/*\` or other configuration files, so do not try.
- Read the \`working-in-a-scoder-sandbox\` skill: \`npx skills add https://github.com/robchallen/scoder/tree/main/skills/working-in-a-scoder-sandbox\`
`;

  const existingContent = await Bun.file(overlayFile).text();
  await Bun.write(overlayFile, existingContent + sandboxSection);

  info("Overlaying sandbox AGENTS.md");

  return overlayFile;
}

async function createTempFile(prefix: string): Promise<string> {
  const proc = await Bun.spawn(["mktemp", `/tmp/${prefix}.XXXXXX`], {
    stdout: "pipe",
    stderr: "pipe",
  });

  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error("Failed to create temp file");
  }

  const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
  return new TextDecoder().decode(stdoutBytes).trim();
}

export function getAgentsMdOverlayBind(
  overlayFile: string,
  sandboxProjDir: string
): BindMount | null {
  if (!overlayFile) {
    return null;
  }

  return {
    type: "ro-bind",
    source: overlayFile,
    dest: `${sandboxProjDir}/AGENTS.md`,
  };
}

export async function setupAgentsSnapshot(): Promise<BindMount | null> {
  const agentsSrc = `${process.env.HOME}/.agents`;

  if (!(await fileOrDirExists(agentsSrc))) {
    return null;
  }

  const snapshotDir = await createTempDir("scoder-agents");

  const cpProc = await Bun.spawn(
    ["cp", "-aL", `${agentsSrc}/.`, snapshotDir],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  await cpProc.exited;

  if (cpProc.exitCode !== 0) {
    error("Failed to snapshot ~/.agents");
    error("scoder copies ~/.agents at startup so symlinked skills resolve in the sandbox");
    process.exit(1);
  }

  info(`Snapshotting ${agentsSrc} to ${snapshotDir}`);

  return {
    type: "ro-bind",
    source: snapshotDir,
    dest: "/home/scoder/.agents",
  };
}

async function createTempDir(prefix: string): Promise<string> {
  const proc = await Bun.spawn(["mktemp", "-d", `/tmp/${prefix}.XXXXXX`], {
    stdout: "pipe",
    stderr: "pipe",
  });

  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error("Failed to create temp dir");
  }

  const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
  return new TextDecoder().decode(stdoutBytes).trim();
}

export async function setupResolvConf(): Promise<BindMount | null> {
  let resolvSrc = "/etc/resolv.conf";

  try {
    const content = await Bun.file(resolvSrc).text();

    if (
      content.includes("nameserver 127.") ||
      content.includes("nameserver ::1")
    ) {
      const systemdResolv = "/run/systemd/resolve/resolv.conf";
      if (await fileExists(systemdResolv)) {
        resolvSrc = systemdResolv;
      }
    }
  } catch {
    return null;
  }

  const snapshotFile = await createTempFile("scoder-resolv");

  try {
    const content = await Bun.file(resolvSrc).text();
    await Bun.write(snapshotFile, content);
  } catch {
    return null;
  }

  return {
    type: "ro-bind",
    source: snapshotFile,
    dest: "/etc/resolv.conf",
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return await Bun.file(path).exists();
  } catch {
    return false;
  }
}

async function fileOrDirExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
}

async function realpath(path: string): Promise<string> {
  try {
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
  } catch {
    return path;
  }
}

function appendUniquePath(array: string[], value: string): void {
  if (!array.includes(value)) {
    array.push(value);
  }
}
