export interface ScoderOptions {
	quiet: boolean;
	dryRun: boolean;
	openPorts: number[];
	configureAppArmor: boolean;
	installDependencies: boolean;
	worktree: boolean;
	sshTarget: string | null;
	ide: string | null;
}

export interface ToolPreset {
	description: string;
	configBinds: (realHome: string, sandboxHome: string) => Promise<ToolBindSpec>;
	validate: () => Promise<boolean>;
	// Optional: lets a preset choose the tool's final argv once the project
	// directory is known, rather than leaving the user to always pass it
	// explicitly. configBinds runs before sandboxProjDir exists, so this is
	// a separate hook rather than something configBinds itself could do.
	// Always called when present, with whatever args the user already gave
	// (possibly none) — unlike configBinds, which never sees user args at
	// all, this hook decides for itself whether to leave them untouched
	// (rstudio: only fills in a default when the user gave none), prepend
	// fixed flags ahead of them (eclipse: -data/-configuration must always
	// be present, whatever else the user passed), or something else
	// entirely. existingArgs is `[]` for the --ide companion, which has no
	// way for the user to supply its own args directly.
	resolveArgs?: (
		hostProjectDir: string,
		sandboxProjectDir: string,
		existingArgs: string[],
	) => Promise<string[]>;
	// Optional: runs a separate, complete command inside the sandbox,
	// before the tool/IDE exec — for setup work that has to happen inside
	// the sandbox's own mount namespace (see eclipse-preset.md: a
	// dynamically-generated Eclipse workspace has to be built by a process
	// that sees the sandbox's own paths, not the host's). A failed prepare
	// step is a loud, whole-launch failure, not something folded silently
	// into configBinds or resolveArgs. dependencyDirs is the sandbox-side
	// destinations of every .agentreadonly $HOME/... entry already
	// resolved for this session (see ProtectionConfig.dependencyDirs) —
	// e.g. eclipse imports each of these as its own project, alongside the
	// main one, so cross-project references resolve inside the sandbox.
	prepareCommand?: (
		hostProjectDir: string,
		sandboxProjectDir: string,
		dependencyDirs: string[],
	) => Promise<{ bin: string; args: string[] } | null>;
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
