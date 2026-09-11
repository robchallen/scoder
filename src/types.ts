export interface ScoderOptions {
	quiet: boolean;
	dryRun: boolean;
	openPorts: number[];
	configureAppArmor: boolean;
	installDependencies: boolean;
	worktree: boolean;
	sshTarget: string | null;
}

export interface ToolPreset {
	description: string;
	configBinds: (realHome: string, sandboxHome: string) => Promise<ToolBindSpec>;
	validate: () => Promise<boolean>;
	// Optional: lets a preset choose the tool's argv once the project
	// directory is known, rather than leaving the user to always pass it
	// explicitly. configBinds runs before sandboxProjDir exists, so this is
	// a separate hook rather than something configBinds itself could do.
	// Only called when the user passed no args of their own — an explicit
	// argument always wins.
	resolveArgs?: (
		hostProjectDir: string,
		sandboxProjectDir: string,
	) => Promise<string[]>;
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
