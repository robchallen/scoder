import { mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProtectionConfig } from "../git/protection.ts";
import { defaultConfigText, parseEnvNames } from "../git/sandbox-config.ts";
import {
	getGitCommonDir,
	getProjDir,
	getWorktreesParentDir,
	isInGitRepo,
} from "../git/worktree.ts";
import type {
	BindMount,
	GitWorktreeInfo,
	IdeShutdown,
	ScoderOptions,
} from "../types.ts";
import { warning } from "../utils/logger.ts";
import { getRealHome } from "../utils/paths.ts";
import { stageFile } from "../utils/session.ts";
import entrypointScript from "./entrypoint.sh" with { type: "text" };
import {
	getSandboxGid,
	getSandboxUid,
	getSandboxUsername,
} from "./identity.ts";

// EM: How an --ide companion is asked to close when no preset says otherwise.
// EM: SIGTERM to the children before the process is what Eclipse needs (its
// EM: launcher is a stub around the JVM, which is the process that actually
// EM: has the window); confirmed directly. A preset whose IDE wants something
// EM: else says so via ToolPreset.ideShutdown.
// EM: Both logs are named at a fixed path inside the sandbox so the agent
// EM: can be told where to look without a search ("it's in
// EM: /tmp/scoder-ide.log, run tail"). They used to *only* live there — on
// EM: the sandbox's private /tmp tmpfs, invisible from outside, so when a
// EM: GUI misbehaved the one file holding its output could not be read from
// EM: the terminal the user was already sitting at. Each is now instead a
// EM: host file in the session staging root, bound rw at the same sandbox
// EM: dest (see stageEntrypointLog), so the path is the same inside the
// EM: sandbox and host-visible outside it — for the life of the session,
// EM: which is what the staging root's teardown gives; the log is a
// EM: live-tailing aid, and a post-mortem copy is what the user makes of it.
export const IDE_LOG_PATH = "/tmp/scoder-ide.log";
export const XPRA_LOG_PATH = "/tmp/scoder-xpra.log";

// ### entrypointLogDest
// Which of the two logs an entrypoint-wrapped session actually writes.
//
// EM: One file, not two: entrypoint.sh redirects the IDE into $XPRA_LOG
// EM: whenever an xpra server is running (its stdout is the server's
// EM: stdout), and into $IDE_LOG otherwise — the branches are
// EM: mutually exclusive, so binding anything else would stage a file
// EM: guaranteed to stay empty.
export function entrypointLogDest(xpra?: XpraWrap): string {
	return xpra ? XPRA_LOG_PATH : IDE_LOG_PATH;
}

export const DEFAULT_IDE_SHUTDOWN: IdeShutdown = {
	signal: "TERM",
	order: "children-first",
};

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
	// EM: design/features/ide-companion.md and src/sandbox/entrypoint.sh.
	ideBin?: string;
	ideArgs?: string[];
	ideShutdown?: IdeShutdown;
	// EM: Host path of the filtered D-Bus socket, when there is a session bus
	// EM: to proxy and a proxy to do it with.
	// EM: Set when this session runs a GUI preset, as either the primary tool
	// EM: or the --ide companion. See design/features/xpra-gui-isolation.md.
	xpra?: XpraWrap;
	// EM: --native-display (ADR 0005): which side's GUI program gets a
	// EM: private session bus in place of xpra's --dbus-launch. The harness
	// EM: form wraps its exec vector with dbus-run-session; the ide form
	// EM: hands DBUS_BUS to the entry point, which starts the bus BESIDE the
	// EM: IDE — a wrapper above $! is disqualifying there (measured:
	// EM: dbus-run-session forwards no signals and orphans its child, so the
	// EM: ENTER handshake's first press would kill the wrapper and orphan the
	// EM: IDE). The bus address never reaches this command's env: it is born
	// EM: inside the sandbox and dies there.
	nativeDBus?: "harness" | "ide";
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
		ideShutdown,
		xpra,
		nativeDBus,
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

	// EM: A tmpfs, not the host's /run. Binding it read-only handed the
	// EM: sandbox every socket under it, and permission was no obstacle:
	// EM: entering a user namespace changes how ids are *rendered*, not the
	// EM: credentials the kernel checks, so a sandbox reaches whatever its
	// EM: user can reach. Verified on a real host — /run/docker.sock
	// EM: (root:docker, and connect() succeeded) and /run/ssh-agent.sock
	// EM: (world-writable). A reachable Docker socket is root on the host by
	// EM: design; a reachable ssh-agent is the user's keys, which is exactly
	// EM: what --allow-ssh goes to the trouble of not handing over.
	// EM:
	// EM: The host's session bus goes with it, and nothing brings it back:
	// EM: see architecture/decision-records/0004-no-host-dbus.md. One thing
	// EM: does come back the other way — /run/user/<uid> becomes *writable*,
	// EM: which silences the steady stream of failures xpra, its Xvfb and
	// EM: dconf used to log against a read-only one.
	cmd.push("--tmpfs", "/run");
	// EM: --perms 700 matches what pam_systemd makes of the host's runtime
	// EM: directory, which is what the XDG spec mandates and what some of
	// EM: the tools putting sockets here (dbus, xpra, keyring helpers)
	// EM: expect to find. A bare --dir creates 0755 — and older bwrap
	// EM: builds left it at 0777&~umask, which on a umask-0033 machine is
	// EM: the 0744 XDG_RUNTIME_DIR someone reported. Nothing outside this
	// EM: private tmpfs can read it either way, so this is fidelity rather
	// EM: than exposure; the /run/user parent stays at the default 0755 to
	// EM: mirror the host. --perms applies only to a directory it creates,
	// EM: never one that already exists, hence creating the parent first.
	cmd.push("--dir", "/run/user");
	cmd.push("--perms", "700", "--dir", `/run/user/${uid}`);
	cmd.push(...(await runSymlinkDirs()));

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
	// EM: (.../worktrees/<basename(projDir)>/scoder), and bind mounts applied later at
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
		// EM: worktrunk's own worktree-path, pinned to this sandbox's
		// EM: worktrees parent so `wt switch --create` inside the sandbox
		// EM: lands in the one directory scoder binds read-write, next to
		// EM: scoder's own worktree. Without it worktrunk uses its default —
		// EM: a sibling of the repository — which is outside every bind, so
		// EM: the new worktree is unwritable or invisible. Confirmed
		// EM: directly, in a throwaway repo: the default put a branch at
		// EM: <repo>.feat-one, and this variable moved it to
		// EM: <parent>/feat-one.
		// EM:
		// EM: Set unconditionally: only worktrunk reads it, and it costs
		// EM: nothing on a host without worktrunk. It also overrides the
		// EM: user's own ~/.config/worktrunk/config.toml template (which is
		// EM: bound read-only, see buildExtraBinds) for the sandbox only,
		// EM: which is deliberate — scoder computes the parent itself, so
		// EM: this is exact even for a repository outside $HOME, where a
		// EM: relative host-side template ({{ repo_path }}/../worktrees/...)
		// EM: would resolve somewhere scoder binds nothing.
		"--setenv",
		"WORKTRUNK_WORKTREE_PATH",
		`${worktreesParentDir}/{{ branch | sanitize }}`,
	);

	// EM: Preset-specific env vars that can't come from the blind host
	// EM: passthrough below — e.g. rstudio's XAUTHORITY, which must point at
	// EM: the bind destination inside the sandbox, not the host's own path.
	if (toolEnv) {
		for (const [key, value] of Object.entries(toolEnv)) {
			cmd.push("--setenv", key, value);
		}
	}

	// EM: The host env vars a session may see: .sandbox/env's names, read by
	// EM: setupProtection. Formerly a list in this file; now a per-project
	// EM: file seeded from ~/.config/scoder/env, so adding a provider's key no
	// EM: longer needs a scoder release. Read-only inside the sandbox like the
	// EM: rest of .sandbox/, so an agent cannot widen its own environment.
	// EM: With no protectionConfig the shipped default applies.
	const passThrough =
		protectionConfig?.envPassThrough ??
		parseEnvNames(defaultConfigText("env"), "default env");

	for (const envVar of passThrough) {
		if (process.env[envVar]) {
			cmd.push("--setenv", envVar, process.env[envVar] || "");
		}
	}

	// EM: --env: one-off values for this session, pushed last among the
	// EM: session's own variables so bwrap's last-wins --setenv makes them
	// EM: override the passthrough, a preset's values and scoder's own fixed
	// EM: ones alike — an explicit, typed request is the strongest statement
	// EM: of intent there is. Overriding one scoder set itself (HOME, PATH,
	// EM: SCODER_SANDBOX...) is allowed but said out loud, since it can make
	// EM: the sandbox behave unlike the docs. The entry point's own
	// EM: variables are pushed after this, deliberately: they are its
	// EM: internal interface, not session environment, and a companion-IDE
	// EM: launch should not be breakable from the command line.
	const scoderSet = new Set<string>();
	for (let i = 0; i < cmd.length - 1; i++) {
		if (cmd[i] === "--setenv") {
			scoderSet.add(cmd[i + 1]);
		}
	}
	const fromPassThrough = new Set(passThrough.filter((n) => process.env[n]));
	for (const { name, value } of options.setEnv ?? []) {
		if (scoderSet.has(name) && !fromPassThrough.has(name)) {
			warning(`--env ${name} overrides the value scoder sets itself`);
		}
		cmd.push("--setenv", name, value);
	}

	// EM: `--` marks end-of-options, so a tool path beginning with `-` cannot be
	// EM: mistaken for a bwrap flag. Previously this separated pasta's options
	// EM: from the command; bwrap accepts it in the same role.
	// EM: --native-display's private session bus, harness form (ADR 0005):
	// EM: dbus-run-session starts a bus per command, its socket lands on the
	// EM: sandbox's own /tmp tmpfs, and its address exists only inside the
	// EM: sandbox — nothing here adds DBUS_SESSION_BUS_ADDRESS to the built
	// EM: command. Safe as an exec-vector wrapper because the child's exit
	// EM: status propagates (measured, dbus 1.16.2: child exit 42 -> runner
	// EM: exit 42) and Ctrl-C reaches everyone via installSignalForwarding's
	// EM: process-group kill, which no wrapper can stand in the way of. The
	// EM: ide form must NOT do this — the ENTER handshake signals $!
	// EM: directly, and the same build forwards no signals (measured); it
	// EM: gets DBUS_BUS below instead, with $! left as the IDE's real pid.
	const harnessBin = nativeDBus === "harness" ? "dbus-run-session" : toolBin;
	const harnessArgs =
		nativeDBus === "harness" ? ["--", toolBin, ...toolArgs] : toolArgs;

	// EM: The entry point is used whenever anything beyond "exec the tool"
	// EM: has to happen inside the sandbox — a companion IDE to background, or
	// EM: an xpra server to start. `scoder rstudio` with no --ide hits the
	// EM: second case alone, which is why this is not simply `if (ideBin)`.
	// EM: Native mode with no companion is deliberately NOT a third case:
	// EM: its whole bus mechanism is the exec-vector prepend above, so the
	// EM: direct-exec path still applies (plan native-display.md, Decision 5).
	if (ideBin || xpra) {
		const entry = buildEntrypointInvocation(
			harnessBin,
			harnessArgs,
			ideBin,
			ideArgs ?? [],
			ideShutdown ?? DEFAULT_IDE_SHUTDOWN,
			xpra,
			nativeDBus === "ide" ? "ide" : undefined,
		);
		for (const [name, value] of Object.entries(entry.env)) {
			cmd.push("--setenv", name, value);
		}
		// EM: After the --tmpfs /tmp above, so the mountpoint lands in the
		// EM: sandbox's own tmpfs rather than the host's /tmp. Read-only: see
		// EM: ENTRYPOINT_DEST for why that is sufficient.
		cmd.push("--ro-bind", await stageEntrypointScript(), ENTRYPOINT_DEST);
		// EM: The session's one log file (entrypointLogDest), rw-bound at its
		// EM: own sandbox path: the entrypoint keeps writing to the fixed
		// EM: name it has always used, and the same bytes appear on the host
		// EM: under the staging root — which is why the two startup messages
		// EM: in index.ts can print a path the user can actually open.
		const logDest = entrypointLogDest(xpra);
		cmd.push("--bind", await stageEntrypointLog(logDest), logDest);
		// EM: `bash <path>` rather than execing the script directly — the
		// EM: staged file is bound read-only with whatever mode it was
		// EM: written with, and naming the interpreter avoids depending on
		// EM: that mode carrying an executable bit through the bind.
		cmd.push("--", "bash", ENTRYPOINT_DEST, ...entry.argv);
	} else {
		cmd.push("--", harnessBin, ...harnessArgs);
	}

	// EM: Everything above is the INNER layer. Wrapping it in the outer /dev
	// EM: layer is the last step, so every bind, tmpfs, namespace and env
	// EM: decision in this function keeps applying to the sandbox the tool
	// EM: actually runs in.
	return [...buildDevLayer(uid, gid, cmd), "--", ...cmd];
}

// ### resolvConfDest
// Where a bind of the DNS snapshot has to land inside the sandbox.
//
// EM: Not always `/etc/resolv.conf`. On a systemd host that path is a symlink
// EM: to `/run/systemd/resolve/stub-resolv.conf`, and `/etc` is bound from
// EM: the host so the symlink comes with it. bwrap will not create a
// EM: mountpoint *through* a symlink — verified, including with the target's
// EM: parent directory scaffolded first, which was the obvious fix and does
// EM: not work. Binding at the resolved path instead means the host's own
// EM: symlink resolves to the snapshot, so nothing has to know whether this
// EM: machine uses systemd-resolved.
//
// EM: Reported immediately after `/run` became a tmpfs:
// EM: `bwrap: Can't create file at /etc/resolv.conf: No such file or
// EM: directory`. It had never arisen before because the symlink used to
// EM: resolve into the host's own `/run`, which was bound. Missed here
// EM: because this development container has a plain file at that path — the
// EM: single most likely difference between a container and a real desktop,
// EM: and not something `--dry-run` can show.
export async function resolvConfDest(): Promise<string> {
	try {
		const target = await realpath("/etc/resolv.conf");
		return target.startsWith("/run/") ? target : "/etc/resolv.conf";
	} catch {
		// Absent or dangling on the host; the plain path is the best guess and
		// the bind simply will not be added if there is nothing to snapshot.
		return "/etc/resolv.conf";
	}
}

// ### runSymlinkDirs
// `--dir` scaffolding for the resolv.conf destination when it lands in the
// new `/run` tmpfs, since a bind needs its parent to exist.
async function runSymlinkDirs(): Promise<string[]> {
	const dest = await resolvConfDest();
	return dest.startsWith("/run/") ? ["--dir", dirname(dest)] : [];
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
// EM: see guiDisplayBinds in src/tools/presets.ts) are hoisted up here as well:
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

// ### ENTRYPOINT_DEST
// Where entrypoint.sh is bound inside the sandbox.
//
// EM: In /tmp, which is the sandbox's own tmpfs, because bwrap has to be able
// EM: to create the mountpoint. An earlier version of this used
// EM: /run/scoder/entrypoint.sh, on the reasoning that /run is read-only and
// EM: /tmp is writable by the tool, so the entry point should not sit
// EM: somewhere the sandboxed process could replace it. That failed outright:
// EM: `bwrap: Can't mkdir parents for /run/scoder/entrypoint.sh: Read-only
// EM: file system`. A bind's mountpoint has to be created, and it cannot be
// EM: created inside a read-only bind — at any depth, for a file or a
// EM: directory.
//
// EM: The premise was also wrong. Verified directly: from inside the sandbox,
// EM: with /tmp fully writable, `rm` and `mv` on this path both fail with
// EM: EBUSY and a symlink over it fails with EEXIST. A bind mountpoint cannot
// EM: be removed or replaced by an unprivileged process in the namespace,
// EM: and --ro-bind makes the contents unwritable, so a writable parent
// EM: directory buys an attacker nothing here.
export const ENTRYPOINT_DEST = "/tmp/scoder-entrypoint.sh";

// ### stageEntrypointScript
// Write entrypoint.sh into the session temp root and return its host path,
// for binding at ENTRYPOINT_DEST.
//
// EM: The script is a real file in the repo, imported as text. Bun embeds a
// EM: `with { type: "text" }` import into the compiled binary (verified both
// EM: ways: `bun run` and `bun build --compile`), so there is no "find my own
// EM: files at runtime" problem to solve — which is what had previously kept
// EM: every generated script an inline TypeScript string. The editable,
// EM: shellcheck'able file and the single-binary distribution stop being in
// EM: tension.
export async function stageEntrypointScript(): Promise<string> {
	const path = await stageFile(ENTRYPOINT_DEST);
	await Bun.write(path, entrypointScript);
	return path;
}

// ### stageEntrypointLog
// Create the host file a log bind is written through, and return its host
// path (under the session staging root, mirroring the sandbox dest).
//
// EM: The file must exist before bwrap runs — a file bind whose source is
// EM: missing is an error, unlike a directory bind — but must stay empty:
// EM: the entrypoint truncates it with `>` anyway, and on the way the
// EM: staging root's teardown at session end takes the log with every
// EM: other staged artifact.
export async function stageEntrypointLog(dest: string): Promise<string> {
	const path = await stageFile(dest);
	if (!(await Bun.file(path).exists())) {
		await Bun.write(path, "");
	}
	return path;
}

// ### XpraWrap
// Which program in the sandbox gets an xpra server, and the socket its
// windows are forwarded over. Absent for a non-GUI session.
export interface XpraWrap {
	/** Path of the unix socket the server binds — identical on both sides. */
	socket: string;
	/** Path of the shared-memory file — identical on both sides, see xpraDir. */
	mmap: string;
	/** `scoder rstudio` wraps the primary tool; `--ide rstudio` the companion. */
	target: "harness" | "ide";
}

// ### buildEntrypointInvocation
// [IMPLEMENTS](/design/features/ide-companion.md)
// [IMPLEMENTS](/design/features/xpra-gui-isolation.md)
// The environment and argv for entrypoint.sh, which runs a companion IDE in
// the background, the primary tool in the foreground, and either of them under
// an xpra server. The behaviour itself, and the reasoning behind it, live in
// src/sandbox/entrypoint.sh — this assembles its inputs and nothing else.
//
// Settings go in named environment variables and arguments stay in argv. Two
// variable-length argv vectors cannot be split positionally without a count or
// a delimiter, and a delimiter would be a value some real argument could
// collide with; the counts are what make the split safe. Arguments are never
// interpolated into a string that is later parsed as shell, so a tool argument
// containing shell metacharacters cannot be reparsed as syntax.
//
// This replaced a scheme that passed IDE_LOG, IDE_SIG, IDE_ORDER and the count
// as bare positionals, which read `… _ /tmp/scoder-ide.log HUP process-first 2
// /opt/eclipse/eclipse …` in --dry-run output and explained nothing. As
// --setenv pairs they explain themselves, which is most of what offsets no
// longer printing the script itself.
export function buildEntrypointInvocation(
	toolBin: string,
	toolArgs: string[],
	ideBin: string | undefined,
	ideArgs: string[],
	ideShutdown: IdeShutdown = DEFAULT_IDE_SHUTDOWN,
	xpra?: XpraWrap,
	dbusBus?: "ide",
): { env: Record<string, string>; argv: string[] } {
	const ideArgv = ideBin ? [ideBin, ...ideArgs] : [];

	const env: Record<string, string> = {
		HARNESS_ARGC: (1 + toolArgs.length).toString(),
		IDE_ARGC: ideArgv.length.toString(),
		IDE_LOG: IDE_LOG_PATH,
		IDE_SIG: ideShutdown.signal,
		IDE_ORDER: ideShutdown.order,
	};

	// EM: Presence is the switch, like XPRA_SOCKET above: unset for every
	// EM: xpra session and every native non-GUI session, so the script's
	// EM: dbus block is a no-op there and --dry-run output stays honest
	// EM: about which path a session takes. This is the companion form of
	// EM: --native-display's private session bus (ADR 0005): the script
	// EM: starts `dbus-launch` beside the IDE and prefixes its address onto
	// EM: the IDE's launch line only, so $! remains the IDE's real pid and
	// EM: the measured per-IDE shutdown signals keep working — a
	// EM: dbus-run-session wrapper here would forward none of them
	// EM: (measured, dbus 1.16.2). Never set together with xpra: native
	// EM: mode and an xpra server are mutually exclusive per session.
	if (dbusBus) {
		env.DBUS_BUS = dbusBus;
	}

	// EM: Presence is the switch, so a non-GUI session sets nothing and the
	// EM: script takes the direct-exec path for both programs. Never set to an
	// EM: empty string: the script tests -n, so an empty value would read as
	// EM: "no xpra" anyway, but leaving the variables out entirely keeps
	// EM: --dry-run output honest about which path a session will take.
	if (xpra) {
		env.XPRA_SOCKET = xpra.socket;
		env.XPRA_MMAP = xpra.mmap;
		env.XPRA_TARGET = xpra.target;
		env.XPRA_LOG = XPRA_LOG_PATH;

		// EM: An escape hatch, and a deliberate one. Tuning a GUI session
		// EM: means trying an xpra flag and judging whether it feels better,
		// EM: which is a judgement only the person at the screen can make —
		// EM: and every round trip costs them a full IDE session. Forwarding
		// EM: the host's own XPRA_* variables and an extra-args string lets
		// EM: them try several in one sitting instead of waiting on a code
		// EM: change each time. XPRA_SCROLL_ENCODING is the live example: the
		// EM: client gates its scroll-delta encoding behind it, off by
		// EM: default in 6.5.4.
		// EM:
		// EM: Safe to forward wholesale because the sandbox is --clearenv'd,
		// EM: so nothing arrives here that the user did not deliberately set,
		// EM: and these only ever reach xpra. The entrypoint reads each with
		// EM: a `${VAR:-default}`, so a forwarded value wins over its own.
		for (const [name, value] of Object.entries(process.env)) {
			if (name.startsWith("XPRA_") && value) {
				env[name] = value;
			}
		}
		if (process.env.SCODER_XPRA_SERVER_ARGS) {
			env.XPRA_EXTRA_ARGS = process.env.SCODER_XPRA_SERVER_ARGS;
		}
	}

	return {
		env,
		argv: [toolBin, ...toolArgs, ...ideArgv],
	};
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

	// EM: GTK appearance. Reported: a GUI preset renders in the default white
	// EM: theme rather than the user's, which under a dark desktop is not a
	// EM: small difference. Themes come from several places and a GTK app
	// EM: needs both halves — the setting that names a theme, and the theme
	// EM: itself — so missing either leaves it on the default.
	// EM:
	// EM: The settings files matter most on KDE specifically, which is where
	// EM: this was reported: kde-gtk-config writes the chosen GTK theme into
	// EM: .config/gtk-3.0/settings.ini and .gtkrc-2.0, so without those the
	// EM: sandbox has no idea a theme was ever chosen. The theme and icon
	// EM: directories are then what those settings point at, for anything the
	// EM: user installed themselves; system-wide themes under /usr/share
	// EM: already arrive with the wholesale read-only /usr bind.
	// EM:
	// EM: .fonts and .icons are the pre-XDG locations, still used by plenty of
	// EM: installers, and cost nothing to include when absent.
	for (const relative of [
		".themes",
		".icons",
		".fonts",
		".local/share/themes",
		".local/share/icons",
		".config/gtk-3.0",
		".config/gtk-4.0",
	]) {
		const dir = `${realHome}/${relative}`;
		if (await dirExists(dir)) {
			binds.push({
				type: "ro-bind",
				source: dir,
				dest: `${sandboxHome}/${relative}`,
			});
		}
	}

	const gtkrcPath = `${realHome}/.gtkrc-2.0`;
	if (await fileExists(gtkrcPath)) {
		binds.push({
			type: "ro-bind",
			source: gtkrcPath,
			dest: `${sandboxHome}/.gtkrc-2.0`,
		});
	}

	// EM: worktrunk (`wt`) keeps its user config here — most importantly
	// EM: worktree-path, which decides where `wt switch --create` puts a new
	// EM: worktree. Without it the sandbox would use worktrunk's own default
	// EM: (a sibling of the repo), which lands outside every bind scoder set
	// EM: up and so appears read-only or missing inside the sandbox.
	// EM:
	// EM: This is the only host-level path worktrunk needs: everything else
	// EM: it writes — caches, logs, branch markers, trash — lives in the
	// EM: repository's own .git/wt/, already bound read-write (confirmed
	// EM: directly by tracing `wt config state get`). Gated on the config
	// EM: file existing rather than on the `wt` binary: a host with the
	// EM: binary and no config has nothing to bind, and a config with no
	// EM: binary costs nothing.
	// EM:
	// EM: Read-only, like every other entry here. One consequence worth
	// EM: knowing: worktrunk writes approvals for project hooks and aliases
	// EM: to ~/.config/worktrunk/approvals.toml, which is deliberately NOT
	// EM: bound — bwrap creates the parent directory on the sandbox's own
	// EM: tmpfs $HOME, so an approval granted inside a sandbox stays inside
	// EM: that session rather than becoming a standing host-side approval.
	const worktrunkConfigPath = `${realHome}/.config/worktrunk/config.toml`;
	if (await fileExists(worktrunkConfigPath)) {
		binds.push({
			type: "ro-bind",
			source: worktrunkConfigPath,
			dest: `${sandboxHome}/.config/worktrunk/config.toml`,
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
