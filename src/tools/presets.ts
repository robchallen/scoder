import type { BindMount, ToolPreset } from "../types.ts";
import { error, warning } from "../utils/logger.ts";

// EM: Tool preset system for opencode, claude, copilot, and pi
// EM: Implements tool-presets feature with tool-specific config/data bindings

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

async function ensureDir(path: string): Promise<void> {
  await Bun.spawn(["mkdir", "-p", path]);
}

// ### TOOL_PRESETS
// [IMPLEMENTS](/design/features/tool-presets.md)
// EM: Mapping of tool names to preset configurations for sandboxing
export const TOOL_PRESETS: Record<string, ToolPreset> = {
  opencode: {
    description: "OpenCode",

    configBinds: async (realHome, sandboxHome) => {
      const binds: BindMount[] = [];
      const dirs: string[] = [];

      const configDir = `${realHome}/.config/opencode`;
      if (await dirExists(configDir)) {
        dirs.push(`${sandboxHome}/.config/opencode`);
        binds.push({
          type: "ro-bind",
          source: configDir,
          dest: `${sandboxHome}/.config/opencode`,
        });
      }

      const dataDir = `${realHome}/.local/share/opencode`;
      await ensureDir(dataDir);
      dirs.push(`${sandboxHome}/.local/share/opencode`);
      binds.push({
        type: "bind",
        source: dataDir,
        dest: `${sandboxHome}/.local/share/opencode`,
      });

      const cacheDir = `${realHome}/.cache/opencode`;
      await ensureDir(cacheDir);
      dirs.push(`${sandboxHome}/.cache/opencode`);
      binds.push({
        type: "bind",
        source: cacheDir,
        dest: `${sandboxHome}/.cache/opencode`,
      });

      return { binds, dirs };
    },

    validate: async () => {
      const exists = await commandExists("opencode");
      if (!exists) {
        error("opencode not found in PATH");
        error("Install: https://opencode.ai");
        return false;
      }
      return true;
    },
  },

  claude: {
    description: "Claude Code",

    configBinds: async (realHome, sandboxHome) => {
      const binds: BindMount[] = [];
      const dirs: string[] = [];

      // Read-write: Claude Code writes here throughout a session (todos,
      // history, shell snapshots, statsig state). A read-only bind makes it
      // fail in many flows rather than degrade. Note this is a host-visible
      // write path — see design/implementation/debt/rw-config-mounts-limited-escape.md
      const claudeDir = `${realHome}/.claude`;
      if (await dirExists(claudeDir)) {
        dirs.push(`${sandboxHome}/.claude`);
        binds.push({
          type: "bind",
          source: claudeDir,
          dest: `${sandboxHome}/.claude`,
        });
      } else {
        warning("Claude config not found at ~/.claude/");
        warning("Run 'claude' once first to initialize");
      }

      const configClaudeJson = `${realHome}/.claude.json`;
      if (await fileExists(configClaudeJson)) {
        binds.push({
          type: "ro-bind",
          source: configClaudeJson,
          dest: `${sandboxHome}/.claude.json`,
        });
      }

      const configClaudeDir = `${realHome}/.config/claude`;
      if (await dirExists(configClaudeDir)) {
        dirs.push(`${sandboxHome}/.config/claude`);
        binds.push({
          type: "ro-bind",
          source: configClaudeDir,
          dest: `${sandboxHome}/.config/claude`,
        });
      }

      // The native installer puts the versioned binary here and symlinks
      // ~/.local/bin/claude at it. Without this bind that symlink dangles
      // inside the sandbox. Read-only, so the sandbox cannot self-update
      // the host's installation.
      const claudeDataDir = `${realHome}/.local/share/claude`;
      if (await dirExists(claudeDataDir)) {
        dirs.push(`${sandboxHome}/.local/share/claude`);
        binds.push({
          type: "ro-bind",
          source: claudeDataDir,
          dest: `${sandboxHome}/.local/share/claude`,
        });
      }

      return { binds, dirs };
    },

    validate: async () => {
      const claudeExists = await commandExists("claude");
      if (!claudeExists) {
        error("claude not found in PATH");
        error("Install: npm install -g @anthropic-ai/claude-code");
        return false;
      }

      const nodeExists = await commandExists("node");
      if (!nodeExists) {
        error("node not found in PATH (required by Claude Code)");
        return false;
      }

      return true;
    },
  },

  copilot: {
    description: "GitHub Copilot CLI",

    configBinds: async (realHome, sandboxHome) => {
      const binds: BindMount[] = [];
      const dirs: string[] = [];

      const copilotDir = `${realHome}/.config/github-copilot`;
      if (await dirExists(copilotDir)) {
        dirs.push(`${sandboxHome}/.config/github-copilot`);
        binds.push({
          type: "bind",
          source: copilotDir,
          dest: `${sandboxHome}/.config/github-copilot`,
        });
      }

      const copilotHomeDir = `${realHome}/.copilot`;
      if (await dirExists(copilotHomeDir)) {
        dirs.push(`${sandboxHome}/.copilot`);
        binds.push({
          type: "bind",
          source: copilotHomeDir,
          dest: `${sandboxHome}/.copilot`,
        });
      }

      const copilotCacheDir = `${realHome}/.cache/copilot`;
      if (await dirExists(copilotCacheDir)) {
        dirs.push(`${sandboxHome}/.cache/copilot`);
        binds.push({
          type: "bind",
          source: copilotCacheDir,
          dest: `${sandboxHome}/.cache/copilot`,
        });
      }

      const dataDir = `${realHome}/.local/share/github-copilot`;
      await ensureDir(dataDir);
      dirs.push(`${sandboxHome}/.local/share/github-copilot`);
      binds.push({
        type: "bind",
        source: dataDir,
        dest: `${sandboxHome}/.local/share/github-copilot`,
      });

      return { binds, dirs };
    },

    validate: async () => {
      const copilotExists = await commandExists("copilot");
      if (!copilotExists) {
        error("copilot not found in PATH");
        error("Install: npm install -g @github/copilot");
        error("    or:  brew install copilot-cli");
        return false;
      }

      const nodeExists = await commandExists("node");
      if (!nodeExists) {
        error("node not found in PATH (required by Copilot CLI)");
        return false;
      }

      return true;
    },
  },

  pi: {
    description: "Pi Coding Agent",

    configBinds: async (realHome, sandboxHome) => {
      const binds: BindMount[] = [];
      const dirs: string[] = [];

      const piDir = `${realHome}/.pi/agent`;
      if (await dirExists(piDir)) {
        dirs.push(`${sandboxHome}/.pi/agent`);
        binds.push({
          type: "bind",
          source: piDir,
          dest: `${sandboxHome}/.pi/agent`,
        });
      }

      const dataDir = `${realHome}/.local/share/pi`;
      await ensureDir(dataDir);
      dirs.push(`${sandboxHome}/.local/share/pi`);
      binds.push({
        type: "bind",
        source: dataDir,
        dest: `${sandboxHome}/.local/share/pi`,
      });

      const cacheDir = `${realHome}/.cache/pi`;
      await ensureDir(cacheDir);
      dirs.push(`${sandboxHome}/.cache/pi`);
      binds.push({
        type: "bind",
        source: cacheDir,
        dest: `${sandboxHome}/.cache/pi`,
      });

      return { binds, dirs };
    },

    validate: async () => {
      const piExists = await commandExists("pi");
      if (!piExists) {
        error("pi not found in PATH");
        error("Install: https://pi.dev");
        return false;
      }
      return true;
    },
  },
};

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const proc = await Bun.spawn(["which", cmd], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}
