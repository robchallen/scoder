import type { ScoderOptions } from "../types.ts";

// EM: CLI argument parsing for scoder command-line interface
// EM: Implements dry-run-mode and tool preset selection
// EM: Host-loopback port access is configured via .agentports, not a flag —
// EM: see src/git/protection.ts and design/implementation/plans/agentports.md

const USAGE = `scoder 2.3.1
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
       --allow-ssh USER@HOST  Open a single pre-authenticated ssh connection to
                            USER@HOST outside the sandbox, and expose only
                            that one connection inside it
       --ide NAME          Launch NAME (must have a registered preset) as a
                            companion IDE inside the same sandbox: NAME runs
                            in the background, the primary tool in the
                            foreground, and both must exit before scoder
                            shuts down. e.g. scoder pi --ide rstudio
       --dry-run           Print the bwrap command without executing

Setup (run once, requires sudo):
  sudo scoder --configure-apparmor
                          Install AppArmor profile to allow bwrap to create
                          user namespaces (required on Ubuntu 24.04+)
  sudo scoder --install-dependencies
                          uses apt to install packages bubblewrap, passt
`;

const VERSION = "2.3.1";

interface ParseResult {
	options: ScoderOptions;
	toolName: string | null;
	toolArgs: string[];
	showHelp: boolean;
	showVersion: boolean;
	error?: string;
}

export function parseArgs(args: string[]): ParseResult {
	// EM: Parse command line arguments into ScoderOptions and tool specification
	const options: ScoderOptions = {
		quiet: false,
		dryRun: false,
		openPorts: [],
		configureAppArmor: false,
		installDependencies: false,
		worktree: false,
		sshTarget: null,
		ide: null,
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

		if (arg.startsWith("--allow-ssh=")) {
			const target = arg.slice("--allow-ssh=".length);
			if (!isValidSshTarget(target)) {
				return {
					options,
					toolName: null,
					toolArgs: [],
					showHelp: false,
					showVersion: false,
					error: "--allow-ssh must be in the form user@host",
				};
			}
			options.sshTarget = target;
			i++;
			continue;
		}

		if (arg === "--allow-ssh") {
			if (i + 1 >= args.length || !isValidSshTarget(args[i + 1])) {
				return {
					options,
					toolName: null,
					toolArgs: [],
					showHelp: false,
					showVersion: false,
					error: "--allow-ssh must be in the form user@host",
				};
			}
			options.sshTarget = args[i + 1];
			i += 2;
			continue;
		}

		if (arg.startsWith("--ide=")) {
			options.ide = arg.slice("--ide=".length);
			i++;
			continue;
		}

		if (arg === "--ide") {
			if (i + 1 >= args.length) {
				return {
					options,
					toolName: null,
					toolArgs: [],
					showHelp: false,
					showVersion: false,
					error: "--ide requires a tool name",
				};
			}
			options.ide = args[i + 1];
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
		// EM: --ide is scoder's own flag, not the wrapped tool's — support it
		// EM: on either side of the tool name (`scoder pi --ide rstudio` was
		// EM: the requested usage) by scanning the tool's own argv for it,
		// EM: rather than only accepting --ide before the tool name the way
		// EM: --allow-ssh and the rest do. Everything else after the tool
		// EM: name is the tool's own argv, untouched, exactly as before.
		const extracted = extractIdeFlag(args.slice(i + 1));
		if (extracted.error) {
			return {
				options,
				toolName: null,
				toolArgs: [],
				showHelp: false,
				showVersion: false,
				error: extracted.error,
			};
		}
		if (extracted.value !== null) {
			options.ide = extracted.value;
		}
		toolArgs = extracted.remaining;
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

interface ExtractedIdeFlag {
	value: string | null;
	remaining: string[];
	error: string | null;
}

// EM: Pulls a trailing --ide/--ide=NAME out of what would otherwise become
// EM: the wrapped tool's own argv, leaving everything else in its original
// EM: order and untouched — the wrapped tool never sees --ide itself.
function extractIdeFlag(args: string[]): ExtractedIdeFlag {
	const remaining: string[] = [];
	let value: string | null = null;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg.startsWith("--ide=")) {
			value = arg.slice("--ide=".length);
			continue;
		}

		if (arg === "--ide") {
			if (i + 1 >= args.length) {
				return {
					value: null,
					remaining: [],
					error: "--ide requires a tool name",
				};
			}
			value = args[i + 1];
			i++;
			continue;
		}

		remaining.push(arg);
	}

	return { value, remaining, error: null };
}

// EM: Shape validation only — a plausible "user@host", not proof it resolves.
// EM: Splitting into { user, host } happens in src/sandbox/ssh.ts.
function isValidSshTarget(target: string | undefined): target is string {
	if (!target) {
		return false;
	}

	const parts = target.split("@");
	return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
}

export function printUsage(): void {
	console.log(USAGE);
}

export function printVersion(): void {
	console.log(`scoder ${VERSION}`);
}
