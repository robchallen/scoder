export interface ScoderOptions {
	quiet: boolean;
	dryRun: boolean;
	llmPorts: number[];
	configureAppArmor: boolean;
	installDependencies: boolean;
	worktree: boolean;
	sshTarget: string | null;
}

export interface ToolPreset {
	description: string;
	configBinds: (realHome: string, sandboxHome: string) => Promise<ToolBindSpec>;
	validate: () => Promise<boolean>;
}

export interface ToolBindSpec {
	binds: BindMount[];
	dirs: string[];
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
