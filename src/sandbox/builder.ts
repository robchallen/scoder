import type { ProtectionConfig } from "../git/protection.ts";
import { getGitCommonDir, isInGitRepo } from "../git/worktree.ts";
import type { BindMount, GitWorktreeInfo, ScoderOptions } from "../types.ts";
import { getSandboxGid, getSandboxUid } from "./identity.ts";

// EM: Implements sandbox-isolation, network-isolation, path-mirroring, and host-tool-binding features
// EM: Constructs bwrap command with system mounts, binds, env vars, and pasta networking

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
// EM: Constructs the bwrap command: mounts, binds, env, namespaces and the tool.
// EM: Networking is no longer part of this command — pasta attaches to the
// EM: namespace afterwards, from outside. See src/sandbox/pasta.ts.
export async function buildBwrapCommand(
	config: SandboxConfig,
): Promise<string[]> {
	const {
		worktreeInfo,
		sandboxProjDir,
		toolBinds,
		toolDirs,
		toolBin,
		toolArgs,
		protectionConfig,
	} = config;

	const realHome = process.env.HOME || "/home/user";
	const uid = getSandboxUid();
	const gid = getSandboxGid();

	// EM: /etc/passwd and /etc/group are overlaid by setupSandboxIdentity, whose
	// EM: binds arrive via protectionConfig.safeBinds so they land after the
	// EM: read-only /etc bind below. See src/sandbox/identity.ts.

	// EM: Build system mounts - read-only bind host directories
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
		"--ro-bind",
		"/etc",
		"/etc",
		"--unshare-user",
		"--uid",
		uid.toString(),
		"--gid",
		gid.toString(),
		// EM: bwrap owns the network namespace too, so its uid mapping is the
		// EM: only one. pasta attaches to this netns from outside instead of
		// EM: creating its own — see ADR 0001.
		"--unshare-net",
		// EM: --info-fd publishes {"child-pid": N} so pasta knows what to attach
		// EM: to; --block-fd holds the exec until pasta has attached, so the tool
		// EM: never observes a window without networking. Both fds are opened by
		// EM: the shell shim in wrapWithFdShim.
		"--info-fd",
		"3",
		"--block-fd",
		"9",
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

	// EM: Add device, proc, tmpfs mounts for sandbox filesystem
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
		`${SCODER_HOME}/.cache`,
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
		// EM: Bind worktree at real absolute path for git cross-references (path-mirroring)
		cmd.push("--bind", worktreeInfo.worktreeDir, sandboxProjDir);
		cmd.push("--bind", worktreeInfo.gitDir, worktreeInfo.gitDir);
	} else {
		// EM: Direct mode - bind current directory instead of worktree
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
		"SCODER_SANDBOX",
		"1",
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
		process.env.LANG || "C.UTF-8",
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
		"COPILOT_GITHUB_TOKEN",
		"GH_TOKEN",
		"GITHUB_TOKEN",
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
		"BRAVE_SEARCH_API_KEY",
		"TAVILY_API_KEY",
		"SERPER_API_KEY",
		"EXA_API_KEY",
		"YOUCOM_API_KEY",
		"JINA_API_KEY",
		"FIRECRAWL_API_KEY",
		"PERPLEXITY_API_KEY",
	];

	for (const envVar of passThrough) {
		if (process.env[envVar]) {
			cmd.push("--setenv", envVar, process.env[envVar] || "");
		}
	}

	// EM: `--` marks end-of-options, so a tool path beginning with `-` cannot be
	// EM: mistaken for a bwrap flag. Previously this separated pasta's options
	// EM: from the command; bwrap accepts it in the same role.
	cmd.push("--", toolBin, ...toolArgs);

	return cmd;
}

// ### wrapWithFdShim
// [IMPLEMENTS](/design/features/network-isolation.md)
// Wrap a bwrap command so that --info-fd 3 and --block-fd 9 are open when it
// runs.
//
// Bun.spawn cannot supply these: its stdio is a fixed 3-tuple, and passing a
// fourth entry fails with "Bad file descriptor". A shell can open them itself.
//
// `exec` with only redirections applies them to the shim rather than replacing
// it; `exec "$@"` then becomes bwrap. The command is passed as real argv, never
// interpolated into the shell string, so arguments containing spaces survive.
//
// stdio 0/1/2 are left alone, since the sandboxed tool is usually interactive.
//
// `trap "" INT QUIT TSTP` before that exec is load-bearing, not optional: bwrap
// (Bun.spawn's direct child) shares scoder's own process group by default, so
// a real terminal's Ctrl-C/Ctrl-\/Ctrl-Z delivers the signal to bwrap directly
// too, at the same moment scoder's own handler receives its copy. bwrap has no
// handler of its own for these, so the kernel's default disposition applies —
// termination for INT/QUIT — and --die-with-parent (see buildBwrapCommand)
// reacts to that death by SIGKILLing the sandboxed process immediately. That
// races scoder's own JS-level forwarding (installSignalForwarding in
// launch.ts) and wins every time: confirmed directly, forwarding a real
// Ctrl-C without this trap left the sandboxed process already gone
// (ESRCH) by the time scoder's handler ran. Ignoring these in the shim
// fixes it: SIG_IGN persists across exec (unlike a handler, which resets to
// default), so bwrap's own process — and the sandboxed program after it —
// inherits the ignore and survives. The sandboxed program is still free to
// install its own real handler for any of these; ignoring is not a handler,
// and a process can always override its own inherited disposition via
// sigaction()/signal(). (Not true of a *shell's* `trap` builtin specifically
// — POSIX forbids a non-interactive shell from un-ignoring a signal that was
// already SIG_IGN on entry, which only matters if the sandboxed command
// happens to be a shell script relying on its own trap for one of these.)
export function wrapWithFdShim(
	cmd: string[],
	infoPath: string,
	blockPath: string,
): string[] {
	const shim =
		'trap "" INT QUIT TSTP; exec 3>"$1"; exec 9<>"$2"; shift 2; exec "$@"';
	return ["bash", "-c", shim, "_", infoPath, blockPath, ...cmd];
}

// ### collectBindDests
// Extract every bind destination from a built bwrap command. The command is
// the only place the full, dynamic bind set exists, so this is what lets
// callers check whether a sandbox path will actually be populated.
export function collectBindDests(cmd: string[]): string[] {
	const dests: string[] = [];

	for (let i = 0; i < cmd.length; i++) {
		const arg = cmd[i];
		if (arg === "--bind" || arg === "--ro-bind" || arg === "--dev-bind") {
			const dest = cmd[i + 2];
			if (dest) {
				dests.push(dest);
			}
		}
	}

	return dests;
}

// ### buildExtraBinds
// [IMPLEMENTS](/design/features/host-tool-binding.md)
async function buildExtraBinds(
	realHome: string,
	sandboxHome: string,
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

	const ghDir = `${realHome}/.config/gh`;
	if (await dirExists(ghDir)) {
		binds.push({
			type: "ro-bind",
			source: ghDir,
			dest: `${sandboxHome}/.config/gh`,
		});
	}

	return binds;
}

async function buildSandboxPath(
	sandboxProjDir: string,
	sandboxHome: string,
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
