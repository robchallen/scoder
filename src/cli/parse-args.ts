import { ScoderOptions } from "../types.ts";

const USAGE = `scoder 2.1.0
Sandboxed runner for coding tools using bubblewrap and pasta.

Usage:
  scoder [options] <tool> [tool-args...]

Supported tools (with built-in presets):
   opencode        OpenCode AI coding assistant
   claude          Claude Code
   copilot         GitHub Copilot CLI
   pi              Pi Coding Agent

Any other command can be run by name (no preset, generic sandbox).

Options:
   -h, --help              Show this help and exit
   -V, --version           Show version and exit
   -q, --quiet             Suppress informational output
   -w, --worktree          Enable git worktree isolation
       --no-worktree       Run directly in current directory (no worktree) (default)
       --llm-port PORTS    Allow localhost TCP access to these comma-separated ports
                            instead of the auto-detected default on 11434
       --dry-run           Print the bwrap command without executing

Setup (run once, requires sudo):
  sudo scoder --configure-apparmor
                          Install AppArmor profile to allow bwrap to create
                          user namespaces (required on Ubuntu 24.04+)
  sudo scoder --install-dependencies
                          uses apt to install packages bubblewrap, passt
`;

const VERSION = "2.1.0";

interface ParseResult {
  options: ScoderOptions;
  toolName: string | null;
  toolArgs: string[];
  showHelp: boolean;
  showVersion: boolean;
  error?: string;
}

export function parseArgs(args: string[]): ParseResult {
  const options: ScoderOptions = {
    quiet: false,
    dryRun: false,
    llmPorts: [],
    configureAppArmor: false,
    installDependencies: false,
    worktree: false,
  };

  let toolName: string | null = null;
  let toolArgs: string[] = [];
  let showHelp = false;
  let showVersion = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      showHelp = true;
      break;
    }

    if (arg === "-V" || arg === "--version") {
      showVersion = true;
      break;
    }

    if (arg === "-q" || arg === "--quiet") {
      options.quiet = true;
      i++;
      continue;
    }

    if (arg === "-w" || arg === "--worktree") {
      options.worktree = true;
      i++;
      continue;
    }

    if (arg === "--no-worktree") {
      options.worktree = false;
      i++;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      i++;
      continue;
    }

    if (arg === "--configure-apparmor") {
      options.configureAppArmor = true;
      i++;
      continue;
    }

    if (arg === "--install-dependencies") {
      options.installDependencies = true;
      i++;
      continue;
    }

    if (arg.startsWith("--llm-port=")) {
      const portStr = arg.slice("--llm-port=".length);
      const ports = parsePorts(portStr);
      if (ports === null) {
        return {
          options,
          toolName: null,
          toolArgs: [],
          showHelp: false,
          showVersion: false,
          error: "--llm-port must be a comma-separated list of integers between 1 and 65535",
        };
      }
      options.llmPorts = ports;
      i++;
      continue;
    }

    if (arg === "--llm-port") {
      if (i + 1 >= args.length) {
        return {
          options,
          toolName: null,
          toolArgs: [],
          showHelp: false,
          showVersion: false,
          error: "--llm-port requires a port number",
        };
      }
      const ports = parsePorts(args[i + 1]);
      if (ports === null) {
        return {
          options,
          toolName: null,
          toolArgs: [],
          showHelp: false,
          showVersion: false,
          error: "--llm-port must be a comma-separated list of integers between 1 and 65535",
        };
      }
      options.llmPorts = ports;
      i += 2;
      continue;
    }

    if (arg.startsWith("-")) {
      return {
        options,
        toolName: null,
        toolArgs: [],
        showHelp: false,
        showVersion: false,
        error: `unknown option: ${arg}`,
      };
    }

    toolName = arg;
    toolArgs = args.slice(i + 1);
    break;
  }

  return {
    options,
    toolName,
    toolArgs,
    showHelp,
    showVersion,
  };
}

function parsePorts(portStr: string): number[] | null {
  const ports = portStr.split(",");
  const result: number[] = [];

  for (const port of ports) {
    const num = parseInt(port, 10);
    if (isNaN(num) || num < 1 || num > 65535) {
      return null;
    }
    result.push(num);
  }

  return result;
}

export function printUsage(): void {
  console.log(USAGE);
}

export function printVersion(): void {
  console.log(`scoder ${VERSION}`);
}
