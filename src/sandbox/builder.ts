import { BindMount, GitWorktreeInfo, ScoderOptions } from "../types.ts";
import { info } from "../utils/logger.ts";
import {
  setupProtection,
  getAgentsMdOverlayBind,
  setupAgentsSnapshot,
  setupResolvConf,
  ProtectionConfig,
} from "../git/protection.ts";
import { isInGitRepo, getGitCommonDir } from "../git/worktree.ts";

const SCODER_HOME = "/home/scoder";

export interface SandboxConfig {
  worktreeInfo: GitWorktreeInfo | null;
  sandboxProjDir: string;
  options: ScoderOptions;
  toolBinds: BindMount[];
  toolDirs: string[];
  toolBin: string;
  toolArgs: string[];
  protectionConfig?: ProtectionConfig;
}

// ### buildBwrapCommand
// [IMPLEMENTS](/design/features/sandbox-isolation.md)
// [IMPLEMENTS](/design/features/network-isolation.md)
// [IMPLEMENTS](/design/features/path-mirroring.md)
// [IMPLEMENTS](/design/features/host-tool-binding.md)
export async function buildBwrapCommand(
  config: SandboxConfig
): Promise<string[]> {
  const {
    worktreeInfo,
    sandboxProjDir,
    options,
    toolBinds,
    toolDirs,
    toolBin,
    toolArgs,
    protectionConfig,
  } = config;

  const realHome = process.env.HOME || "/home/user";
  const cmd: string[] = [
    "bwrap",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--unshare-user",
    "--uid",
    process.getuid?.().toString() || "1000",
    "--gid",
    process.getgid?.().toString() || "1000",
  ];

  if (await dirExists("/lib64")) {
    cmd.push("--ro-bind", "/lib64", "/lib64");
  }

  if ((await dirExists("/sbin")) && !(await isSymlink("/sbin"))) {
    cmd.push("--ro-bind", "/sbin", "/sbin");
  }

  if (await dirExists("/sys")) {
    cmd.push("--ro-bind", "/sys", "/sys");
  }

  if (await dirExists("/run")) {
    cmd.push("--ro-bind", "/run", "/run");
  }

  cmd.push("--ro-bind", "/etc", "/etc");

  cmd.push(
    "--dev-bind",
    "/dev",
    "/dev",
    "--tmpfs",
    "/dev/shm",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/home",
    "--dir",
    SCODER_HOME,
    "--dir",
    `${SCODER_HOME}/.local`,
    "--dir",
    `${SCODER_HOME}/.local/share`,
    "--dir",
    `${SCODER_HOME}/.config`,
    "--dir",
    `${SCODER_HOME}/.cache`
  );

  cmd.push("--dir", sandboxProjDir);

  for (const dir of toolDirs) {
    cmd.push("--dir", dir);
  }

  for (const bind of toolBinds) {
    cmd.push(`--${bind.type}`, bind.source, bind.dest);
  }

  const extraBinds = await buildExtraBinds(realHome, SCODER_HOME);
  for (const bind of extraBinds) {
    cmd.push(`--${bind.type}`, bind.source, bind.dest);
  }

  if (worktreeInfo) {
    cmd.push("--bind", worktreeInfo.worktreeDir, sandboxProjDir);
    cmd.push("--bind", worktreeInfo.gitDir, worktreeInfo.gitDir);
  } else {
    cmd.push("--bind", process.cwd(), sandboxProjDir);
    if (await isInGitRepo()) {
      try {
        const gitDir = await getGitCommonDir();
        cmd.push("--bind", gitDir, gitDir);
      } catch {
        // Ignore if gitDir not found
      }
    }
  }

  if (protectionConfig?.dirs) {
    for (const dir of protectionConfig.dirs) {
      cmd.push("--dir", dir);
    }
  }

  if (protectionConfig) {
    for (const bind of protectionConfig.safeBinds) {
      cmd.push(`--${bind.type}`, bind.source, bind.dest);
    }
  }

  const sandboxPath = await buildSandboxPath(sandboxProjDir, SCODER_HOME);

  cmd.push(
    "--chdir",
    sandboxProjDir,
    "--new-session",
    "--die-with-parent",
    "--clearenv",
    "--setenv",
    "PATH",
    sandboxPath,
    "--setenv",
    "HOME",
    SCODER_HOME,
    "--setenv",
    "USER",
    "scoder",
    "--setenv",
    "LOGNAME",
    "scoder",
    "--setenv",
    "TERM",
    process.env.TERM || "xterm-256color",
    "--setenv",
    "LANG",
    process.env.LANG || "C.UTF-8"
  );

  const passThrough = [
    "EDITOR",
    "VISUAL",
    "NO_COLOR",
    "FORCE_COLOR",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_MODEL",
    "COPILOT_PROVIDER_TYPE",
    "COPILOT_PROVIDER_BASE_URL",
    "COPILOT_PROVIDER_API_KEY",
    "COPILOT_MODEL",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "AZURE_OPENAI_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "CLOUDFLARE_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "ZAI_API_KEY",
    "OPENCODE_API_KEY",
    "HF_TOKEN",
    "FIREWORKS_API_KEY",
    "TOGETHER_API_KEY",
    "KIMI_API_KEY",
    "MINIMAX_API_KEY",
    "XIAOMI_API_KEY",
    "AZURE_OPENAI_BASE_URL",
    "AZURE_OPENAI_RESOURCE_NAME",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
    "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_REGION",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "PI_SKIP_VERSION_CHECK",
    "PI_OFFLINE",
  ];

  for (const envVar of passThrough) {
    if (process.env[envVar]) {
      cmd.push("--setenv", envVar, process.env[envVar]!);
    }
  }

  cmd.push(
    "pasta",
    "--quiet",
    "--foreground",
    "--config-net",
    "--dhcp-dns",
    "--no-map-gw",
    "--tcp-ports",
    "none"
  );

  if (options.llmPorts.length > 0) {
    for (const port of options.llmPorts) {
      cmd.push("--tcp-ns", port.toString());
    }
  } else {
    cmd.push("--tcp-ns", "none");
  }

  cmd.push("--udp-ns", "none", "--", toolBin, ...toolArgs);

  return cmd;
}

// ### buildExtraBinds
// [IMPLEMENTS](/design/features/host-tool-binding.md)
async function buildExtraBinds(
  realHome: string,
  sandboxHome: string
): Promise<BindMount[]> {
  const binds: BindMount[] = [];

  const localBinDir = `${realHome}/.local/bin`;
  if (await dirExists(localBinDir)) {
    binds.push({
      type: "ro-bind",
      source: localBinDir,
      dest: `${sandboxHome}/.local/bin`,
    });
  }

  const gitconfigPath = `${realHome}/.gitconfig`;
  if (await fileExists(gitconfigPath)) {
    binds.push({
      type: "ro-bind",
      source: gitconfigPath,
      dest: `${sandboxHome}/.gitconfig`,
    });
  }

  const rDir = `${realHome}/R`;
  if (await dirExists(rDir)) {
    binds.push({
      type: "ro-bind",
      source: rDir,
      dest: `${sandboxHome}/R`,
    });
  }

  const rprofilePath = `${realHome}/.Rprofile`;
  if (await fileExists(rprofilePath)) {
    binds.push({
      type: "ro-bind",
      source: rprofilePath,
      dest: `${sandboxHome}/.Rprofile`,
    });
  }

  const m2Dir = `${realHome}/.m2`;
  if (await dirExists(m2Dir)) {
    binds.push({
      type: "ro-bind",
      source: m2Dir,
      dest: `${sandboxHome}/.m2`,
    });
  }

  const miseShareDir = `${realHome}/.local/share/mise`;
  if (await dirExists(miseShareDir)) {
    binds.push({
      type: "ro-bind",
      source: miseShareDir,
      dest: `${sandboxHome}/.local/share/mise`,
    });
  }

  const miseConfigDir = `${realHome}/.config/mise`;
  if (await dirExists(miseConfigDir)) {
    binds.push({
      type: "ro-bind",
      source: miseConfigDir,
      dest: `${sandboxHome}/.config/mise`,
    });
  }

  const miseShimsDir = `${realHome}/.local/share/mise/shims`;
  if (await dirExists(miseShimsDir)) {
    binds.push({
      type: "ro-bind",
      source: miseShimsDir,
      dest: `${sandboxHome}/.local/share/mise/shims`,
    });
  }

  const rustupDir = `${realHome}/.rustup`;
  if (await dirExists(rustupDir)) {
    binds.push({
      type: "ro-bind",
      source: rustupDir,
      dest: `${sandboxHome}/.rustup`,
    });
  }

  const cargoBinDir = `${realHome}/.cargo/bin`;
  if (await dirExists(cargoBinDir)) {
    binds.push({
      type: "ro-bind",
      source: cargoBinDir,
      dest: `${sandboxHome}/.cargo/bin`,
    });
  }

  const npmrcPath = `${realHome}/.npmrc`;
  if (await fileExists(npmrcPath)) {
    binds.push({
      type: "ro-bind",
      source: npmrcPath,
      dest: `${sandboxHome}/.npmrc`,
    });
  }

  const pypircPath = `${realHome}/.pypirc`;
  if (await fileExists(pypircPath)) {
    binds.push({
      type: "ro-bind",
      source: pypircPath,
      dest: `${sandboxHome}/.pypirc`,
    });
  }

  return binds;
}

async function buildSandboxPath(
  sandboxProjDir: string,
  sandboxHome: string
): Promise<string> {
  const paths = [
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/usr/sbin",
    "/bin",
    "/sbin",
    `${sandboxHome}/.local/bin`,
  ];

  if (sandboxProjDir) {
    if (await dirExists(`${sandboxProjDir}/.venv/bin`)) {
      paths.unshift(`${sandboxProjDir}/.venv/bin`);
    }

    if (await dirExists(`${sandboxProjDir}/node_modules/.bin`)) {
      paths.unshift(`${sandboxProjDir}/node_modules/.bin`);
    }

    if (
      (await dirExists(`${sandboxProjDir}/bin`)) &&
      (await fileExists(`${sandboxProjDir}/go.mod`))
    ) {
      paths.unshift(`${sandboxProjDir}/bin`);
    }
  }

  return paths.join(":");
}

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

async function isSymlink(path: string): Promise<boolean> {
  try {
    const stat = await Bun.file(path).stat();
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}
