import { TOOL_PRESETS } from "../tools/presets.ts";
import type { ScoderOptions } from "../types.ts";

// EM: CLI argument parsing for scoder command-line interface
// EM: Implements dry-run-mode and tool preset selection
// EM: Host-loopback port access is configured via .sandbox/ports, not a flag —
// EM: see src/git/protection.ts and design/implementation/plans/agentports.md

const USAGE = `scoder 2.3.3
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
                            GUI presets need xpra — their windows are
                            forwarded from a virtual display inside the
                            sandbox, not drawn on the host's X server;
                            --native-display opts out of that
       --native-display    For a session running a GUI preset, draw on the
                            host's X session directly instead of forwarding
                            windows from a private virtual display: sandboxed
                            programs can then read the screen and inject
                            input into OTHER windows on the display (ADR 0005).
                            xpra stays the default; this is the warned
                            opt-out for when xpra's translation costs more
                            than its isolation buys
       --bind NAME         Add preset NAME's config binds to the sandbox
                            without launching NAME, e.g. scoder pi --bind
                            claude puts ~/.claude and the rest of Claude
                            Code's paths in pi's sandbox. Repeatable. CLI
                            presets only — a GUI preset brings a display,
                            which is --ide's job
       --new-workspace     Delete this project's scoder-managed eclipse
                            workspace / vscode user-data-dir before launch,
                            so it is re-created fresh from your host
                            settings. Applies to eclipse and vscode, as the
                            tool or as --ide; refused while a session is
                            using it
       --dry-run           Print the bwrap command without executing

Setup (run once, requires sudo):
  sudo scoder --configure-apparmor
                          Install AppArmor profile to allow bwrap to create
                          user namespaces (required on Ubuntu 24.04+)
  sudo scoder --install-dependencies
                          uses apt to install bubblewrap and passt, and
                          adds the upstream xpra repository (needed by GUI
                          presets; the distro's own xpra is too old or
                          absent) before installing xpra and xpra-x11
`;

const VERSION = "2.3.3";

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
		newWorkspace: false,
		bind: [],
		nativeDisplay: false,
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

		// EM: --native-display is parsed before the tool name only, unlike
		// EM: --ide: it is a display grant the operator chooses, not the
		// EM: tool's business, and there is no `scoder rstudio --native-display`
		// EM: spelling — after the tool name it is the tool's own argv.
		if (arg === "--native-display") {
			options.nativeDisplay = true;
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

		if (arg === "--new-workspace") {
			options.newWorkspace = true;
			i++;
			continue;
		}

		if (arg.startsWith("--bind=")) {
			options.bind.push(arg.slice("--bind=".length));
			i++;
			continue;
		}

		if (arg === "--bind") {
			if (i + 1 >= args.length) {
				return {
					options,
					toolName: null,
					toolArgs: [],
					showHelp: false,
					showVersion: false,
					error: "--bind requires a preset name",
				};
			}
			options.bind.push(args[i + 1]);
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
		const extracted = extractScoderFlags(args.slice(i + 1));
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
		if (extracted.ide !== null) {
			options.ide = extracted.ide;
		}
		options.bind.push(...extracted.bind);
		options.newWorkspace ||= extracted.newWorkspace;
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

interface ExtractedScoderFlags {
	ide: string | null;
	newWorkspace: boolean;
	bind: string[];
	remaining: string[];
	error: string | null;
}

// EM: Pulls scoder's own trailing flags out of what would otherwise become
// EM: the wrapped tool's argv, leaving everything else in its original
// EM: order and untouched — the wrapped tool never sees them.
// EM:
// EM: The two are claimed on different terms. --ide is scoder's alone in
// EM: practice and is always taken. --bind is a common flag in its own
// EM: right (`python -m http.server --bind 0.0.0.0`, gunicorn, hugo), so
// EM: after the tool name it is taken only when its value names a
// EM: registered preset; anything else passes through to the tool as it
// EM: always has. Before the tool name there is no ambiguity to resolve,
// EM: so any value is accepted there and an unknown name is reported as
// EM: such in index.ts rather than silently handed to the tool.
function extractScoderFlags(args: string[]): ExtractedScoderFlags {
	const remaining: string[] = [];
	const bind: string[] = [];
	let ide: string | null = null;
	let newWorkspace = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg.startsWith("--ide=")) {
			ide = arg.slice("--ide=".length);
			continue;
		}

		if (arg === "--ide") {
			if (i + 1 >= args.length) {
				return {
					ide: null,
					newWorkspace: false,
					bind: [],
					remaining: [],
					error: "--ide requires a tool name",
				};
			}
			ide = args[i + 1];
			i++;
			continue;
		}

		// EM: Taken after the tool name too (`scoder eclipse
		// EM: --new-workspace` is the natural spelling); neither IDE has a
		// EM: flag of that name for it to shadow.
		if (arg === "--new-workspace") {
			newWorkspace = true;
			continue;
		}

		if (
			arg.startsWith("--bind=") &&
			isPresetName(arg.slice("--bind=".length))
		) {
			bind.push(arg.slice("--bind=".length));
			continue;
		}

		if (arg === "--bind" && isPresetName(args[i + 1])) {
			bind.push(args[i + 1]);
			i++;
			continue;
		}

		remaining.push(arg);
	}

	return { ide, newWorkspace, bind, remaining, error: null };
}

function isPresetName(name: string | undefined): name is string {
	return name !== undefined && Object.hasOwn(TOOL_PRESETS, name);
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
