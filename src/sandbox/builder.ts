import { mkdir } from "node:fs/promises";
import type { ProtectionConfig } from "../git/protection.ts";
import {
	getGitCommonDir,
	getProjDir,
	getWorktreesParentDir,
	isInGitRepo,
} from "../git/worktree.ts";
import type { BindMount, GitWorktreeInfo, ScoderOptions } from "../types.ts";
import { getRealHome } from "../utils/paths.ts";
import {
	getSandboxGid,
	getSandboxUid,
	getSandboxUsername,
} from "./identity.ts";

// EM: Implements sandbox-isolation, network-isolation, path-mirroring, and host-tool-binding features
// EM: Constructs bwrap command with system mounts, binds, env vars, and pasta networking

export interface SandboxConfig {
	worktreeInfo: GitWorktreeInfo | null;
	sandboxProjDir: string;
	options: ScoderOptions;
	toolBinds: BindMount[];
	toolDirs: string[];
	toolBin: string;
	toolArgs: string[];
	toolEnv?: Record<string, string>;
	// EM: --ide: a companion IDE launched in the background, alongside the
	// EM: primary tool in the foreground, inside the same sandbox. See
	// EM: design/features/ide-companion.md and wrapWithIdeBackground below.
	ideBin?: string;
	ideArgs?: string[];
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
		options,
		toolBinds,
		toolDirs,
		toolBin,
		toolArgs,
		toolEnv,
		ideBin,
		ideArgs,
		protectionConfig,
	} = config;

	const realHome = getRealHome();
	const sandboxHome = realHome;
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
		// EM: the shell shim in wrapWithFdShim and reach this inner layer by
		// EM: plain inheritance through the outer one, which opens neither and
		// EM: closes neither — confirmed directly. They must stay on THIS layer:
		// EM: the pid the outer layer would report is this bwrap process itself,
		// EM: which sits outside the network namespace pasta has to attach to.
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

	// EM: /opt is the FHS location for manually-installed, self-contained
	// EM: software (IDEs, JDKs, browsers, most vendor-shipped dev tools) —
	// EM: not under /usr, so none of the binds above reach it. It is also a
	// EM: common target for /etc/alternatives entries (e.g.
	// EM: /etc/alternatives/idea -> /opt/idea-IC/bin/idea.sh), so a tool
	// EM: resolving correctly through the alternatives symlink can still fail
	// EM: at the final hop if /opt itself was never mounted.
	if (await dirExists("/opt")) {
		cmd.push("--ro-bind", "/opt", "/opt");
	}

	// EM: The symlinks under /etc/alternatives (bound as part of /etc above)
	// EM: are enough to *run* whichever alternative is currently selected, but
	// EM: update-alternatives itself keeps its actual administrative state
	// EM: (available choices, priorities, manual/auto mode) in /var/lib — not
	// EM: reachable at all, since nothing binds /var. Confirmed directly: with
	// EM: only /etc/alternatives, `java` runs fine but `update-alternatives
	// EM: --list java` fails with "no alternatives for java", which is what
	// EM: gets reported as an alternatives-managed tool being "not found" —
	// EM: the binary was never the problem. See
	// EM: design/implementation/issues/update-alternatives-state-not-mounted.md.
	// EM: Both paths are checked, not just one: dpkg-based systems (Debian,
	// EM: Ubuntu) use /var/lib/dpkg/alternatives; chkconfig-based ones (Fedora,
	// EM: RHEL, and derivatives) use /var/lib/alternatives directly. Read-only,
	// EM: like every other system path — a mutating update-alternatives command
	// EM: still correctly fails with "Read-only file system", confirmed
	// EM: directly, consistent with the rest of the sandbox being read-only
	// EM: outside the project tree.
	if (await dirExists("/var/lib/dpkg/alternatives")) {
		cmd.push(
			"--ro-bind",
			"/var/lib/dpkg/alternatives",
			"/var/lib/dpkg/alternatives",
		);
	}

	if (await dirExists("/var/lib/alternatives")) {
		cmd.push("--ro-bind", "/var/lib/alternatives", "/var/lib/alternatives");
	}

	// EM: A wholesale --dev-bind of /dev — safe here, and only here, because
	// EM: this is the inner of two bwrap layers and the /dev it binds is the
	// EM: outer layer's synthetic one (buildDevLayer below), never the host's
	// EM: real /dev with every raw disk, TPM and USB node on it.
	// EM:
	// EM: The bind is recursive, so it carries the outer layer's fresh devpts
	// EM: instance across with it: /dev/ptmx stays a symlink onto a real
	// EM: devpts, and pty allocation works. Binding individual device nodes
	// EM: here instead — what this did until 2.3.1 — cannot work, for two
	// EM: separate confirmed reasons: a bind of the devtmpfs /dev/ptmx node
	// EM: keeps its source dentry, so the kernel's ptmx open path
	// EM: (path_pts(), used by devpts_acquire()) looks for a "pts" sibling
	// EM: beside it on devtmpfs rather than in the sandbox, finds no devpts,
	// EM: and fails open() with ENOENT while stat() on the same path keeps
	// EM: succeeding; and the host's own devpts, bound in at /dev/pts, is
	// EM: mounted ptmxmode=000, so its internal ptmx node is unopenable by
	// EM: the sandbox uid. Eclipse's and RStudio's terminal panes deadlocked
	// EM: on exactly that. Binding the host's /dev/pts wholesale was also an
	// EM: isolation hole in its own right — the sandbox could see, and being
	// EM: the same uid open read/write, the user's own host terminals. See
	// EM: design/implementation/issues/eclipse-rstudio-embedded-terminal-deadlocks.md.
	cmd.push(
		"--dev-bind",
		"/dev",
		"/dev",
		// EM: A private /dev/shm rather than the outer layer's: shared memory
		// EM: is per-sandbox state, and bwrap's own --dev leaves only a plain
		// EM: directory there anyway.
		"--tmpfs",
		"/dev/shm",
		"--proc",
		"/proc",
		"--tmpfs",
		"/tmp",
		"--tmpfs",
		"/home",
		"--dir",
		sandboxHome,
		"--dir",
		`${sandboxHome}/.local`,
		"--dir",
		`${sandboxHome}/.local/share`,
		"--dir",
		`${sandboxHome}/.config`,
		"--dir",
		`${sandboxHome}/.cache`,
	);

	cmd.push("--dir", sandboxProjDir);

	for (const dir of toolDirs) {
		cmd.push("--dir", dir);
	}

	for (const bind of toolBinds) {
		cmd.push(`--${bind.type}`, bind.source, bind.dest);
	}

	const extraBinds = await buildExtraBinds(realHome, sandboxHome);
	for (const bind of extraBinds) {
		cmd.push(`--${bind.type}`, bind.source, bind.dest);
	}

	// EM: Ensured and bound writable on every session, worktree or direct mode
	// EM: alike — preparatory infrastructure for explicitly supporting multiple
	// EM: named worktrees from within a direct-mode session in future. Pushed
	// EM: before the project-dir bind below: in worktree mode that bind's
	// EM: destination nests inside this one
	// EM: (.../worktrees/<projDir>/scoder), and bind mounts applied later at
	// EM: an ancestor path hide whatever was already mounted at a path nested
	// EM: beneath it — confirmed directly while building the eclipse preset
	// EM: (see design/implementation/plans/eclipse-preset.md) — so the
	// EM: broader parent bind must come first.
	const worktreesProjDir =
		worktreeInfo?.projDir ?? (await getProjDir(process.cwd()));
	const worktreesParentDir = getWorktreesParentDir(realHome, worktreesProjDir);
	// EM: --dry-run must stay side-effect free, same as getAgentPortsBind's
	// EM: auto-detect-and-append step and describeSshAccess (see their own
	// EM: comments) — skip the real mkdir there, but still push the bind so
	// EM: the printed preview shows what a real launch would do.
	if (!options.dryRun) {
		await mkdir(worktreesParentDir, { recursive: true });
	}
	cmd.push("--bind", worktreesParentDir, worktreesParentDir);

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

	const sandboxPath = await buildSandboxPath(sandboxProjDir, sandboxHome);
	const sandboxUsername = getSandboxUsername();

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
		sandboxHome,
		"--setenv",
		"SCODER_SANDBOX",
		"1",
		"--setenv",
		"USER",
		sandboxUsername,
		"--setenv",
		"LOGNAME",
		sandboxUsername,
		"--setenv",
		"TERM",
		process.env.TERM || "xterm-256color",
		"--setenv",
		"LANG",
		process.env.LANG || "C.UTF-8",
	);

	// EM: Preset-specific env vars that can't come from the blind host
	// EM: passthrough below — e.g. rstudio's XAUTHORITY, which must point at
	// EM: the bind destination inside the sandbox, not the host's own path.
	if (toolEnv) {
		for (const [key, value] of Object.entries(toolEnv)) {
			cmd.push("--setenv", key, value);
		}
	}

	const passThrough = [
		"SHELL",
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
	if (ideBin) {
		cmd.push(
			"--",
			...wrapWithIdeBackground(toolBin, toolArgs, ideBin, ideArgs ?? []),
		);
	} else {
		cmd.push("--", toolBin, ...toolArgs);
	}

	// EM: Everything above is the INNER layer. Wrapping it in the outer /dev
	// EM: layer is the last step, so every bind, tmpfs, namespace and env
	// EM: decision in this function keeps applying to the sandbox the tool
	// EM: actually runs in.
	return [...buildDevLayer(uid, gid, cmd), "--", ...cmd];
}

// ### buildDevLayer
// [IMPLEMENTS](/design/features/sandbox-isolation.md)
// [IMPLEMENTS](/design/features/network-isolation.md)
// EM: The outer of the two bwrap layers. It owns exactly one thing — /dev —
// EM: and deliberately isolates nothing else: it binds the real root straight
// EM: through so the inner layer can still name host paths as bind sources,
// EM: and unshares only the user namespace it needs to mount anything at all.
// EM: Nothing but the inner bwrap ever executes in it.
//
// EM: Why two layers rather than one bwrap with --dev /dev, which would also
// EM: give a working devpts: pasta cannot attach to a network namespace
// EM: created by a bwrap invoked with --dev. Confirmed directly on a real
// EM: host, twice, with a prototype harness comparing the shapes side by side
// EM: (design/prototype/nested-bwrap-pasta.sh): the attach fails with
// EM: "Couldn't switch to pasta namespaces: Operation not permitted". No
// EM: mechanism for that has ever been established — lsns shows an identical,
// EM: single-layer namespace structure either way — so this splits the two
// EM: concerns instead of trying to reconcile them: --dev lives out here, and
// EM: --unshare-net lives on the inner layer, whose namespaces pasta attaches
// EM: to and which never sees --dev.
//
// EM: bwrap's --dev builds the same small node set the pre-2.3.1 fixed list
// EM: did (null, zero, full, random, urandom, tty, fd) on a private tmpfs, so
// EM: this is no less isolating than binding those nodes individually — plus
// EM: a fresh devpts instance at /dev/pts (ptmxmode=666) and /dev/ptmx as a
// EM: symlink to pts/ptmx, which is the part that makes ptys work.
//
// EM: Device binds contributed by presets (e.g. /dev/dri for the GUI ones,
// EM: see guiX11Binds in src/tools/presets.ts) are hoisted up here as well:
// EM: --dev replaces /dev wholesale, so a node the inner layer binds from
// EM: /dev must exist in THIS layer's /dev for the inner bind to resolve.
// EM: They stay on the inner layer too, where the preset's own gating still
// EM: decides whether the sandbox gets them at all.
export function buildDevLayer(
	uid: string,
	gid: string,
	innerCmd: string[],
): string[] {
	const layer = [
		"bwrap",
		"--unshare-user",
		"--uid",
		uid,
		"--gid",
		gid,
		// EM: The real root, bound through unchanged. This layer confines
		// EM: nothing; the inner one does all of it, from exactly the same
		// EM: host paths it bound before there was an outer layer at all.
		"--bind",
		"/",
		"/",
		// EM: Ordering is load-bearing: --dev mounts a fresh tmpfs over /dev,
		// EM: so it must come after the root bind (which carries the host's
		// EM: own /dev) and before any device bind into /dev.
		"--dev",
		"/dev",
	];

	for (const [src, dest] of collectDeviceBinds(innerCmd)) {
		// EM: --dev-bind-try, not --dev-bind: the inner layer's own bind of
		// EM: the same node is the authoritative one, so a node that vanished
		// EM: between the preset's existence check and launch should fail
		// EM: there, with the inner layer's error, not here.
		layer.push("--dev-bind-try", src, dest);
	}

	// EM: Without this the inner layer — and the tool inside it — survives
	// EM: the outer layer's death.
	layer.push("--die-with-parent");

	return layer;
}

// ### collectDeviceBinds
// Device nodes the inner layer binds from somewhere under /dev, which the
// outer layer therefore has to expose in its own synthetic /dev. The inner
// layer's own wholesale bind of /dev itself is not one of them.
function collectDeviceBinds(cmd: string[]): [string, string][] {
	const binds: [string, string][] = [];

	for (let i = 0; i < cmd.length; i++) {
		if (cmd[i] !== "--dev-bind" && cmd[i] !== "--dev-bind-try") {
			continue;
		}
		const src = cmd[i + 1];
		const dest = cmd[i + 2];
		if (src && dest?.startsWith("/dev/")) {
			binds.push([src, dest]);
		}
	}

	return binds;
}

// ### wrapWithIdeBackground
// [IMPLEMENTS](/design/features/ide-companion.md)
// Runs the companion IDE detached in the background and the primary tool
// in the foreground, in the same process group inside the sandbox — bwrap
// (and so scoder) does not return until BOTH have exited: confirmed
// directly that a backgrounded job in a non-interactive `bash -c` script
// shares the script's own process group (no separate job-control group,
// since that only applies to an interactive shell), so
// installSignalForwarding's existing process-group kill() already reaches
// both without any change there.
//
// The IDE's own stdout/stderr are redirected to a log file rather than left
// attached to the terminal — an Electron/GUI app's own console chatter
// would otherwise interleave with the primary tool's interactive session.
//
// Args are passed as positional parameters ("$@"), never interpolated into
// the script string, matching wrapWithFdShim's own convention: a tool
// argument containing spaces or shell metacharacters must never be
// reparsed as shell syntax. IDE_ARGC is how the one flat argv is split
// back into "the IDE's own argv" and "the primary tool's own argv" without
// a sentinel value that some real argument could theoretically collide
// with.
//
// If the primary tool exits first, the `wait` below can block for a while
// with no further output — indistinguishable from a hang unless something
// says so. `kill -0` right after the primary tool exits checks whether the
// IDE is still running at that moment (a benign race if it exits a moment
// later — the message is just slightly premature, not wrong) and prints a
// notice, styled like scoder's own info() (src/utils/logger.ts) so it
// reads as the same kind of message, before blocking on `wait`.
export function wrapWithIdeBackground(
	toolBin: string,
	toolArgs: string[],
	ideBin: string,
	ideArgs: string[],
): string[] {
	// biome-ignore-start lint/suspicious/noTemplateCurlyInString: this is a
	// literal bash "${...}" reference in a generated shell script, not a
	// forgotten JS template placeholder — this is a plain string, not a
	// template literal, so JS never interpolates it.
	const script =
		'IDE_LOG="$1"; shift; ' +
		'IDE_ARGC="$1"; shift; ' +
		"IDE_ARGV=(); " +
		'for ((i=0; i<IDE_ARGC; i++)); do IDE_ARGV+=("$1"); shift; done; ' +
		'"${IDE_ARGV[@]}" >"$IDE_LOG" 2>&1 & ' +
		"IDE_PID=$!; " +
		'"$@"; STATUS=$?; ' +
		'if kill -0 "$IDE_PID" 2>/dev/null; then ' +
		'echo "\x1b[0;32mscoder: Waiting for attached IDE to close...\x1b[0m" >&2; ' +
		"fi; " +
		'wait "$IDE_PID"; ' +
		'exit "$STATUS"';
	// biome-ignore-end lint/suspicious/noTemplateCurlyInString: see above
	return [
		"bash",
		"-c",
		script,
		"_",
		"/tmp/scoder-ide.log",
		(1 + ideArgs.length).toString(),
		ideBin,
		...ideArgs,
		toolBin,
		...toolArgs,
	];
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
//
// Only the inner layer counts. The outer /dev layer (buildDevLayer) binds the
// real root at "/" on purpose, and that bind populates nothing in the sandbox
// the tool actually runs in — counting it would make every path look bound and
// silently defeat checkExecTargetReachable in src/index.ts.
export function collectBindDests(cmd: string[]): string[] {
	const dests: string[] = [];

	for (let i = innerLayerStart(cmd); i < cmd.length; i++) {
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

// ### innerLayerStart
// Index of the inner bwrap layer's first argument in a composed command. The
// outer layer contains exactly one "--", which buildBwrapCommand follows
// immediately with the inner "bwrap" — anything else is a command that was
// never wrapped, and starts at 0.
function innerLayerStart(cmd: string[]): number {
	const sep = cmd.indexOf("--");
	return sep !== -1 && cmd[sep + 1] === "bwrap" ? sep + 1 : 0;
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
		// This kind of has to be read write if maven is to work
		// a bit like node_modules
		binds.push({
			type: "bind",
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

	// EM: GUI presets (rstudio, eclipse) need real fonts to render text at
	// EM: all, not just cleanly — and desktop apps commonly consult
	// EM: mimeapps.list for "open with" file-type associations. Read-only,
	// EM: like every other entry here: neither is something a sandboxed
	// EM: session should be able to change on the host.
	const fontsDir = `${realHome}/.local/share/fonts`;
	if (await dirExists(fontsDir)) {
		binds.push({
			type: "ro-bind",
			source: fontsDir,
			dest: `${sandboxHome}/.local/share/fonts`,
		});
	}

	const mimeappsPath = `${realHome}/.config/mimeapps.list`;
	if (await fileExists(mimeappsPath)) {
		binds.push({
			type: "ro-bind",
			source: mimeappsPath,
			dest: `${sandboxHome}/.config/mimeapps.list`,
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
