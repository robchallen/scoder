export interface ScoderOptions {
	quiet: boolean;
	dryRun: boolean;
	openPorts: number[];
	configureAppArmor: boolean;
	installDependencies: boolean;
	worktree: boolean;
	sshTarget: string | null;
	ide: string | null;
	// EM: --new-workspace: delete the session's managed per-project state
	// EM: (eclipse workspace, vscode user-data-dir) before setup, so it is
	// EM: re-seeded fresh from the host.
	newWorkspace: boolean;
	// EM: --env NAME=VALUE (repeatable): set in this session's sandbox only,
	// EM: in the order given; a later --env for the same name wins.
	setEnv: Array<{ name: string; value: string }>;
	// EM: --bind NAME (repeatable): presets whose config binds join the
	// EM: sandbox without the preset's tool being launched.
	bind: string[];
	// EM: --native-display: GUI presets draw on the host's X session directly
	// EM: instead of under an xpra server. A warned opt-out (ADR 0005), not a
	// EM: fallback — the default stays xpra.
	nativeDisplay: boolean;
}

/**
 * How a companion IDE is asked to shut down when the primary tool exits
 * first and the user presses ENTER. Both fields are per-IDE because the
 * right answer is, empirically, not the same for two IDEs — see
 * design/features/ide-companion.md.
 */
export interface IdeShutdown {
	/** Signal name as kill(1) takes it, without the SIG prefix. */
	signal: string;
	/**
	 * "children-first" signals the process's direct children before the
	 * process itself — for a launcher that is a thin wrapper around the real
	 * application (Eclipse's is, around its JVM), signalling only the wrapper
	 * orphans the application and leaves its window on screen.
	 * "process-first" signals only the process, leaving its children for the
	 * application itself to shut down — RStudio's own R session is a direct
	 * child, and killing it out from under RStudio loses the session without
	 * closing the IDE.
	 */
	order: "children-first" | "process-first";
}

import type { LiveOverlay } from "./sandbox/overlays.ts";

export interface ToolPreset {
	description: string;
	configBinds: (realHome: string, sandboxHome: string) => Promise<ToolBindSpec>;
	validate: () => Promise<boolean>;
	// The binary this preset actually runs, when it differs from the
	// TOOL_PRESETS key the user types. Only the vscode preset needs it:
	// everyone calls the editor "vscode", but no binary of that name
	// exists — the real one is `code`.
	command?: string;
	// Optional: lets a preset choose the tool's final argv once the project
	// directory is known, rather than leaving the user to always pass it
	// explicitly. configBinds runs before sandboxProjDir exists, so this is
	// a separate hook rather than something configBinds itself could do.
	// Always called when present, with whatever args the user already gave
	// (possibly none) — unlike configBinds, which never sees user args at
	// all, this hook decides for itself whether to leave them untouched
	// (rstudio: only fills in a default when the user gave none), prepend
	// fixed flags ahead of them (eclipse: -data/-importProject must always
	// be present, whatever else the user passed), or something else
	// entirely. existingArgs is `[]` for the --ide companion, which has no
	// way for the user to supply its own args directly. dependencyDirs is
	// the sandbox-side destinations of every .sandbox/readonly $HOME/... entry
	// already resolved for this session (see ProtectionConfig.dependencyDirs)
	// — e.g. eclipse imports each of these as its own project, alongside
	// the main one, so cross-project references resolve inside the sandbox.
	resolveArgs?: (
		hostProjectDir: string,
		sandboxProjectDir: string,
		existingArgs: string[],
		dependencyDirs: string[],
	) => Promise<string[]>;
	// Only meaningful for a preset used as an --ide companion. Omitted means
	// the default (SIGTERM, children-first) in src/sandbox/builder.ts.
	ideShutdown?: IdeShutdown;
	// Files the preset wants presented inside the sandbox with sandbox-only
	// content added, kept in step with the host while the session runs — see
	// design/features/live-file-overlays.md. Separate from configBinds
	// because the project directory is not known when that runs, and these
	// are almost always project files.
	fileOverlays?: (
		hostProjectDir: string,
		sandboxProjectDir: string,
	) => Promise<LiveOverlay[]>;
	// True for a preset that opens windows. Such a preset runs under an xpra
	// server inside the sandbox, which forwards its windows to the host over a
	// unix socket rather than letting it reach the host's X server — see
	// design/features/xpra-gui-isolation.md. Read whether the preset is the
	// primary tool (`scoder rstudio`) or the companion (`--ide rstudio`),
	// which is why it lives here rather than alongside ideShutdown.
	gui?: boolean;
	// The per-project directory scoder keeps for this preset across
	// sessions (eclipse's managed workspace, vscode's user-data-dir), which
	// --new-workspace deletes so the next setup re-creates it from the host's
	// settings. Must only compute the path — never create or seed it — and
	// must name a directory scoder owns: never the user's own config.
	managedWorkspaceDir?: (hostProjectDir: string) => Promise<string>;
}

export interface ToolBindSpec {
	binds: BindMount[];
	dirs: string[];
	// Preset-specific env vars whose value cannot come from a blind host
	// passthrough (builder.ts's fixed passThrough list) — either because it
	// needs to point at a bind destination inside the sandbox rather than
	// the host's own value (e.g. XAUTHORITY), or because it's only
	// meaningful for the one preset that requested it, not every tool.
	env?: Record<string, string>;
}

export interface BindMount {
	type: "ro-bind" | "bind" | "dev-bind";
	source: string;
	dest: string;
}

export interface GitWorktreeInfo {
	worktreeDir: string;
	worktreeBranch: string;
	baseCommit: string | null;
	gitDir: string;
	projDir: string;
	sourceRepoRoot: string;
	sourceBranch: string | null;
	sourceHead: string;
	sourceRefLabel: string;
}

export interface BwrapConfig {
	cmd: string[];
	sandboxHome: string;
	sandboxProjDir: string;
}
