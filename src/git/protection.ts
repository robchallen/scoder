import {
	cp,
	realpath as fsRealpath,
	mkdir,
	readdir,
	readlink,
	stat,
} from "node:fs/promises";
import type { LiveOverlay } from "../sandbox/overlays.ts";
import { renderOverlay } from "../sandbox/overlays.ts";
import type { BindMount } from "../types.ts";
import { error, info } from "../utils/logger.ts";
import {
	getRealHome,
	isUnderAny,
	resolveHomePrefixes,
	toSandboxPath,
} from "../utils/paths.ts";
import { sessionPath, stageDir, stageFile } from "../utils/session.ts";
import { CONFIG_DIR, CONFIG_FILES, configPath } from "./sandbox-config.ts";

// EM: Infrastructure protection via .sandbox/readonly and AGENTS.md overlay
// EM: Implements infrastructure-protection, agents-md-overlay, and agents-skills-snapshot features

const DEFAULT_PROTECTED = [
	".github/",
	".claude/",
	"opencode.json",
	".gitignore",
	"package-lock.json",
	"poetry.lock",
	"Cargo.lock",
	"pnpm-lock.yaml",
	"yarn.lock",
	"mise.toml",
];

// Sandbox destinations that scoder itself unconditionally binds — every
// fixed infra bind under $HOME, whether host-tool-wide (buildExtraBinds'
// own list in src/sandbox/builder.ts) or a preset's own top-level dir
// (`.claude`/`.claude.json`, `.copilot`) — plus the agent-skills snapshot.
// Shared by both `.sandbox/readonly`'s and `.sandbox/readwrite`'s HOME-bind
// overlap checks: a `.sandbox/readonly` entry landing here would fight a
// bind a tool actually needs read-write access to (`.claude`, `.copilot`);
// a `.sandbox/readwrite` entry here would silently upgrade a bind scoder
// placed there for an unrelated reason. Parameterized by realHome, not a
// fixed literal: the sandbox's own $HOME is the real host $HOME (see
// path-mirroring), which varies by user and by test.
//
// Deliberately NOT the bare namespace umbrellas a dynamic, per-preset
// sub-path lives under (`.cache`, `.config`, `.local` as bare entries) —
// those are never themselves bound, just scaffolded empty by builder.ts's
// own --dir list; only specific sub-paths under them are (`.cache/pi`,
// `.config/mise`, `.local/bin`, and similar, varying by which preset is
// active). Reported directly: `$HOME/.local/share/fonts` was rejected
// outright because it nested under the bare `.local` entry this list
// used to carry, even though nothing was bound at that bare path at the
// time. Blocking a bare umbrella protects nothing real, since a bind
// landing under it doesn't collide with anything scoder itself put
// there; only the exact fixed destinations below do — fonts has since
// become one of them (buildExtraBinds now binds it by default, read-only,
// the actual fix the user wanted), so it now correctly *is* in this list.
// Must be kept in sync with buildExtraBinds, same caveat
// sandboxMountPrefixes above already carries for a different check.
function fixedBindDestinations(realHome: string): string[] {
	return [
		`${realHome}/.agents`,
		`${realHome}/.cargo/bin`,
		`${realHome}/.claude`,
		`${realHome}/.claude.json`,
		`${realHome}/.config/gh`,
		`${realHome}/.config/mimeapps.list`,
		`${realHome}/.config/mise`,
		`${realHome}/.config/worktrunk/config.toml`,
		`${realHome}/.copilot`,
		`${realHome}/.gitconfig`,
		`${realHome}/.local/bin`,
		`${realHome}/.local/share/fonts`,
		`${realHome}/.local/share/mise`,
		`${realHome}/.m2`,
		`${realHome}/.npmrc`,
		`${realHome}/.pypirc`,
		`${realHome}/.Rprofile`,
		`${realHome}/.rustup`,
		`${realHome}/R`,
	];
}

// Sandbox destinations that are always bind-mounted, used to resolve symlinks
// in ~/.local/bin at snapshot time. If a symlink target maps under one of these
// it is sandbox-resolvable and the symlink is kept (with its target rewritten
// into the sandbox namespace); otherwise the target binary is copied in.
//
// This list must mirror buildExtraBinds in src/sandbox/builder.ts exactly. A
// prefix that is NOT actually bound makes the check claim resolvability it
// cannot deliver, producing a dangling symlink inside the sandbox — which is
// why the entries are the precise bound paths rather than their parents.
// Preset-specific destinations are dynamic and passed in separately. The
// worktree tree itself isn't listed here — isSandboxResolvable short-circuits
// on it directly via isWorktreeMountPath, since (unlike this fixed list) its
// location is user/project-dependent.
function sandboxMountPrefixes(realHome: string): string[] {
	return [
		`${realHome}/.local/bin`,
		`${realHome}/.local/share/mise`,
		`${realHome}/.config/mise`,
		`${realHome}/.config/gh`,
		`${realHome}/.cargo/bin`,
		`${realHome}/.rustup`,
		`${realHome}/R`,
		`${realHome}/.Rprofile`,
		`${realHome}/.m2`,
		`${realHome}/.npmrc`,
		`${realHome}/.pypirc`,
		`${realHome}/.gitconfig`,
	];
}

// ### isWorktreeMountPath
// True if `path` sits under $HOME/**/worktrees/**, the fixed shape every
// scoder worktree lives under (see getWorktreesParentDir in
// src/git/worktree.ts). A heuristic, not an exact membership check against
// the current session's own worktree — used only where that's the right
// trade-off: symlink-resolvability guessing in isSandboxResolvable, and the
// AGENTS.md overlay's "this is a worktree" note.
function isWorktreeMountPath(path: string, realHome: string): boolean {
	return path.startsWith(`${realHome}/`) && path.includes("/worktrees/");
}

// Ceiling on copying an unresolvable symlink target into the snapshot. Some
// tools ship hundreds of megabytes in a single binary (Claude Code's native
// installer is ~275 MB), and copying that on every launch of an unrelated tool
// is not worth it. Oversized targets keep a sandbox-mapped symlink instead,
// which resolves only if something binds the target directory.
const MAX_LOCAL_BIN_COPY_BYTES = 64 * 1024 * 1024;

export interface ProtectionConfig {
	protectedPaths: string[];
	safeBinds: BindMount[];
	/** Host path of the rendered AGENTS.md overlay. */
	agentsMdOverlay?: string;
	/**
	 * Files presented inside the sandbox with sandbox-only content added,
	 * kept in step with the host while the session runs. See
	 * src/sandbox/overlays.ts.
	 */
	overlays: LiveOverlay[];
	dirs?: string[];
	// The sandbox-side destinations of every .sandbox/readonly $HOME/... entry
	// — a distinct list, not just whatever of safeBinds happens to look
	// like one, so a preset's prepareCommand (see ToolPreset) can treat
	// each as its own project to import without guessing which safeBinds
	// entries are dependency-project-shaped and which are unrelated
	// infrastructure (agents/.local/bin snapshots, resolv.conf, etc.).
	dependencyDirs: string[];
}

// ### setupProtection
// [IMPLEMENTS](/design/features/infrastructure-protection.md)
export async function setupProtection(
	sourceDir: string,
	sandboxProjDir: string,
): Promise<ProtectionConfig> {
	const protectedPaths: string[] = [];
	const safeBinds: BindMount[] = [];
	const dirs: string[] = [];
	const dependencyDirs: string[] = [];
	const agentreadonlyPath = configPath(sourceDir, "readonly");
	const agentreadonlyExists = await fileExists(agentreadonlyPath);

	if (agentreadonlyExists) {
		const content = await Bun.file(agentreadonlyPath).text();
		const lines = content.split("\n");

		for (const line of lines) {
			if (line.trim() === "" || line.trim().startsWith("#")) {
				continue;
			}

			if (line.startsWith("$HOME/")) {
				await registerAgentreadonlyHomeBind(
					line,
					safeBinds,
					dirs,
					dependencyDirs,
				);
				continue;
			}

			const localMatches = await findProtectedPaths(sourceDir, line.trim());
			for (const match of localMatches) {
				appendUniquePath(protectedPaths, match);
			}
		}
	} else {
		protectedPaths.push(...DEFAULT_PROTECTED);
		// EM: Default .sandbox/readonly created with protected infrastructure paths
		await Bun.write(agentreadonlyPath, `${DEFAULT_PROTECTED.join("\n")}\n`);
	}

	for (const path of protectedPaths) {
		const cleanPath = path.endsWith("/") ? path.slice(0, -1) : path;
		if (cleanPath === "") continue;

		const src = `${sourceDir}/${cleanPath}`;
		const dest = `${sandboxProjDir}/${cleanPath}`;

		if (await fileOrDirExists(src)) {
			safeBinds.push({
				type: "ro-bind",
				source: src,
				dest,
			});
			info(`Protecting ${cleanPath} (read-only)`);
		}
	}

	// EM: No self-protection bind here any more. getConfigDirBind binds the
	// EM: whole of .sandbox/ read-only, which covers this file — and covers it
	// EM: whether or not it existed when the bind list was built. Under the old
	// EM: per-file scheme that distinction was a bug twice over: a missing
	// EM: source gets no bind at all, so a freshly written default stayed part
	// EM: of the read-write project bind and the sandbox could edit the very
	// EM: file saying what it was not allowed to touch.

	// EM: Rendered here so the file exists before bwrap binds it; the watcher
	// EM: started in launchSandbox keeps it in step thereafter.
	const agentsOverlay = await _setupAgentsMdOverlay(sourceDir, sandboxProjDir);
	await renderOverlay(agentsOverlay);
	const overlays: LiveOverlay[] = [agentsOverlay];
	const agentsMdOverlay = sessionPath(agentsOverlay.dest);

	return {
		protectedPaths,
		safeBinds,
		agentsMdOverlay,
		overlays,
		dirs,
		dependencyDirs,
	};
}

async function registerAgentreadonlyHomeBind(
	homePathExpr: string,
	binds: BindMount[],
	dirs: string[],
	dependencyDirs: string[],
): Promise<void> {
	const realHome = getRealHome();
	const relativePath = homePathExpr.slice("$HOME/".length);
	const sourcePath = `${realHome}/${relativePath}`;

	const sourceReal = await realpath(sourcePath);

	if (!sourceReal || !(await fileOrDirExists(sourceReal))) {
		error(
			`.sandbox/readonly HOME bind must reference an existing file or directory: ${homePathExpr}`,
		);
		process.exit(1);
	}

	if (sourceReal !== realHome && !sourceReal.startsWith(`${realHome}/`)) {
		error(`.sandbox/readonly HOME bind escapes HOME: ${homePathExpr}`);
		process.exit(1);
	}

	const sandboxDest = `${realHome}/${relativePath}`;

	for (const fixedDest of fixedBindDestinations(realHome)) {
		if (pathsOverlap(sandboxDest, fixedDest)) {
			error(
				`.sandbox/readonly HOME bind overlaps reserved sandbox path: ${homePathExpr}`,
			);
			process.exit(1);
		}
	}

	// EM: Ancestors only, not sandboxDest itself: unlike .sandbox/readwrite's
	// EM: own equivalent loop, where every entry is always a directory (an
	// EM: existing --dir scaffold at the leaf is harmless, since it's just
	// EM: getting bind-mounted over by another directory), .sandbox/readonly
	// EM: HOME binds can reference a FILE too (fileOrDirExists, not
	// EM: dirExists, is the existence check below). Reported directly:
	// EM: `$HOME/.private/apis/secrets.prop` (a file) failed with
	// EM: `bwrap: Can't create file at .../secrets.prop: Is a directory` —
	// EM: the old version of this loop pushed a --dir for the leaf
	// EM: unconditionally, so bwrap scaffolded an empty directory exactly
	// EM: where the --ro-bind below then needed a file mountpoint instead.
	if (sandboxDest !== realHome) {
		const rel = sandboxDest.slice(`${realHome}/`.length);
		const parts = rel.split("/");
		let currentPath = realHome;
		for (const part of parts.slice(0, -1)) {
			currentPath = `${currentPath}/${part}`;
			if (!dirs.includes(currentPath)) {
				dirs.push(currentPath);
			}
		}
	}

	binds.push({
		type: "ro-bind",
		source: sourceReal,
		dest: sandboxDest,
	});
	dependencyDirs.push(sandboxDest);

	info(`Binding ${homePathExpr} to ${sandboxDest} (read-only)`);
}

function pathsOverlap(left: string, right: string): boolean {
	const l = left.endsWith("/") ? left.slice(0, -1) : left;
	const r = right.endsWith("/") ? right.slice(0, -1) : right;

	return l === r || l.startsWith(`${r}/`) || r.startsWith(`${l}/`);
}

const AGENT_READWRITE_FILE = CONFIG_FILES.readwrite.path;
const AGENT_READWRITE_HEADER = `# ${CONFIG_FILES.readwrite.path} — $HOME/... directories bound read-write into the sandbox, one per line\n`;

// ### setupReadWriteAccess
// [IMPLEMENTS](/design/features/agent-readwrite.md)
// .sandbox/readwrite lists $HOME/... directories to bind read-write into the
// sandbox — a persistent cache, analysis output, or any other directory
// outside the project tree that needs to survive session restarts.
// Replaces the earlier `scratch` symlink convention (see
// design/features/agent-readwrite.md's History section): one file can
// list any number of directories, each validated the same way
// .sandbox/readonly's own $HOME/... lines already are (must resolve inside
// $HOME, cannot escape it via a symlink), rather than one symlink per
// area and no format validation on where it's allowed to point.
export async function setupReadWriteAccess(
	sourceDir: string,
	sandboxProjDir: string,
	protectionConfig: ProtectionConfig,
	dryRun: boolean,
): Promise<void> {
	const path = `${sourceDir}/${AGENT_READWRITE_FILE}`;

	if (!(await fileExists(path))) {
		// EM: Still skipped under --dry-run, which must not create real files.
		if (dryRun) {
			return;
		}
		await Bun.write(path, AGENT_READWRITE_HEADER);
	}

	// EM: No per-file bind any more. The whole of .sandbox/ is bound read-only
	// EM: by getConfigDirBind, which covers this file whether or not it
	// EM: existed when the bind list was built — the property that removed the
	// EM: "a missing source gets no bind, so the freshly created default is
	// EM: writable from inside the session that created it" bug, found and
	// EM: fixed twice under the old layout.

	const content = await Bun.file(path).text();
	const realHome = getRealHome();

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) {
			continue;
		}

		if (!line.startsWith("$HOME/")) {
			error(
				`${AGENT_READWRITE_FILE} entries must start with $HOME/ (nothing outside $HOME is allowed): "${line}"`,
			);
			process.exit(1);
		}

		await registerReadWriteHomeBind(line, realHome, protectionConfig, dryRun);
	}
}

async function registerReadWriteHomeBind(
	homePathExpr: string,
	realHome: string,
	protectionConfig: ProtectionConfig,
	dryRun: boolean,
): Promise<void> {
	const relativePath = homePathExpr.slice("$HOME/".length);
	const sourcePath = `${realHome}/${relativePath}`;

	// EM: Unlike .sandbox/readonly's HOME binds, a missing target is created
	// EM: rather than treated as an error — the stated use cases
	// EM: ($HOME/.cache/<tool>, a fresh analysis-output directory) are
	// EM: commonly directories that don't exist yet on a machine's first
	// EM: run, and there is no "protect existing infrastructure"
	// EM: reasoning here working against that, unlike the read-only case.
	// EM: Skipped under --dry-run, which must stay side-effect free — the
	// EM: entry still shows up in the preview, best-effort resolved.
	if (!dryRun && !(await fileOrDirExists(sourcePath))) {
		try {
			await mkdir(sourcePath, { recursive: true });
		} catch (err) {
			error(`Failed to create ${homePathExpr}: ${err}`);
			process.exit(1);
		}
		info(`Created ${homePathExpr} (did not exist yet)`);
	}

	const sourceReal = await realpath(sourcePath);

	if (sourceReal !== realHome && !sourceReal.startsWith(`${realHome}/`)) {
		error(`${AGENT_READWRITE_FILE} entry escapes HOME: ${homePathExpr}`);
		process.exit(1);
	}

	for (const fixedDest of fixedBindDestinations(realHome)) {
		if (pathsOverlap(sourceReal, fixedDest)) {
			error(
				`${AGENT_READWRITE_FILE} entry overlaps a fixed scoder bind: ${homePathExpr}`,
			);
			process.exit(1);
		}
	}

	// EM: dependencyDirs is exactly the set of .sandbox/readonly $HOME/...
	// EM: entries' own sandbox destinations (see
	// EM: registerAgentreadonlyHomeBind above) — reused here, not
	// EM: duplicated, to catch the same path listed in both files with
	// EM: directly opposite intents (protect vs. open for writing).
	if (
		protectionConfig.dependencyDirs.some((dest) =>
			pathsOverlap(sourceReal, dest),
		)
	) {
		error(
			`${homePathExpr} is listed in both ${CONFIG_FILES.readonly.path} and ${AGENT_READWRITE_FILE} — pick one`,
		);
		process.exit(1);
	}

	protectionConfig.dirs = protectionConfig.dirs || [];
	if (sourceReal !== realHome) {
		const rel = sourceReal.slice(`${realHome}/`.length);
		const parts = rel.split("/");
		let currentPath = realHome;
		for (const part of parts) {
			currentPath = `${currentPath}/${part}`;
			if (!protectionConfig.dirs.includes(currentPath)) {
				protectionConfig.dirs.push(currentPath);
			}
		}
	}

	protectionConfig.safeBinds.push({
		type: "bind",
		source: sourceReal,
		dest: sourceReal,
	});

	info(`Binding ${homePathExpr} to ${sourceReal} (read-write)`);
}

const AGENT_PORTS_FILE = CONFIG_FILES.ports.path;
const AGENT_PORTS_HEADER = `# ${CONFIG_FILES.ports.path} — ports forwarded from host loopback into the sandbox, one per line\n`;

const DBUS_FILE = CONFIG_FILES.dbus.path;

// EM: Provisional, and labelled as such in the file it writes. The plan calls
// EM: for deriving this by observation — run the proxy with --log, use both
// EM: IDEs, read off what they actually ask for — because the cost of
// EM: guessing wrong is specific: D-Bus passthrough exists in scoder at all
// EM: because RStudio's menus came up greyed out without it, so a list that
// EM: does not restore that reintroduces the original bug while claiming to
// EM: improve security.
// EM:
// EM: Deliberately absent: org.freedesktop.secrets (the keyring, i.e. every
// EM: stored credential) and org.freedesktop.systemd1 (starting units outside
// EM: the sandbox, i.e. an escape). Neither should ever be added by default;
// EM: a project that genuinely needs one can say so in its own file.
const DEFAULT_DBUS_ALLOW = [
	"org.freedesktop.Notifications",
	"org.freedesktop.portal.Desktop",
	"org.freedesktop.portal.Documents",
];

const DBUS_HEADER = `# ${DBUS_FILE} — D-Bus services the sandbox may talk to, one per line
#
# Everything not listed here is refused: the sandbox sees those services as
# simply absent. A refused call has no symptom of its own, so if something in
# a GUI quietly does nothing, look at /tmp/scoder-dbus.log inside the sandbox
# for a *HIDDEN* line naming what was asked for, and add it here.
#
# Read once at startup. The proxy cannot reload its filter, so an edit takes
# effect on the next session, not this one.
#
# Two names are deliberately not here and should not be added lightly:
#   org.freedesktop.secrets   — the keyring: every credential you have stored
#   org.freedesktop.systemd1  — starting units outside the sandbox: an escape
`;

// ### readDbusAllowlist
// [IMPLEMENTS](/design/features/dbus-isolation.md)
// Bus names the sandbox may talk to. Writes the default on first run.
export async function readDbusAllowlist(
	projectRoot: string,
	dryRun: boolean,
): Promise<string[]> {
	const path = `${projectRoot}/${DBUS_FILE}`;

	if (!(await fileExists(path))) {
		if (!dryRun) {
			await Bun.write(path, `${DBUS_HEADER}${DEFAULT_DBUS_ALLOW.join("\n")}\n`);
		}
		return [...DEFAULT_DBUS_ALLOW];
	}

	const names: string[] = [];
	for (const raw of (await Bun.file(path).text()).split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) {
			continue;
		}
		// EM: Validated rather than passed through, because a malformed name
		// EM: becomes a --talk= argument and xdg-dbus-proxy's own complaint
		// EM: about it would surface as a proxy that failed to start, with the
		// EM: real cause two layers away.
		if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_-]*)+$/.test(line)) {
			error(`${DBUS_FILE} has an invalid bus name: "${line}"`);
			error(
				"Each line must be a D-Bus well-known name, e.g. org.example.Service",
			);
			process.exit(1);
		}
		names.push(line);
	}
	return names;
}

// ### readAgentPorts
// [IMPLEMENTS](/design/features/network-isolation.md)
// Reads and validates .sandbox/ports: one port per line, blank lines and #
// comments (leading or trailing) skipped. Missing file -> []. A malformed
// line throws rather than silently skipping — this is host-loopback network
// exposure, not a workspace-protection list, so a config file that could
// silently mean less than it looks like is the wrong failure mode here.
//
// Throws rather than calling process.exit itself, deliberately: this is also
// called on every tick of the live-reload watcher in launch.ts, mid-session,
// long after the sandbox is up. process.exit() there would kill the whole
// scoder process from inside a background poll loop, skipping launchSandbox's
// finally block entirely — no stopPasta, no bwrap teardown. The watcher
// catches the throw and just warns, keeping the last-known-good config
// running; only the startup caller in index.ts, where nothing is running
// yet, treats it as fatal and exits.
export async function readAgentPorts(projectRoot: string): Promise<number[]> {
	const path = `${projectRoot}/${AGENT_PORTS_FILE}`;

	if (!(await fileExists(path))) {
		return [];
	}

	const content = await Bun.file(path).text();
	const ports: number[] = [];

	for (const rawLine of content.split("\n")) {
		const trimmed = rawLine.split("#")[0]?.trim() ?? "";

		if (trimmed === "") {
			continue;
		}

		if (!/^\d+$/.test(trimmed)) {
			throw new Error(
				`${AGENT_PORTS_FILE} has an invalid line: "${rawLine.trim()}" — each line must be a single port number between 1 and 65535`,
			);
		}

		const port = Number.parseInt(trimmed, 10);
		if (port < 1 || port > 65535) {
			throw new Error(
				`${AGENT_PORTS_FILE} has a port out of range: "${rawLine.trim()}" — each line must be a single port number between 1 and 65535`,
			);
		}

		if (!ports.includes(port)) {
			ports.push(port);
		}
	}

	return ports;
}

// ### appendAgentPort
// Appends `port` if not already present, creating the file if missing.
// Never reorders or removes existing entries — the same shape of thing
// setupProtection already does for a missing .sandbox/readonly (seeding a
// default), just additive to an existing file too, not only when absent.
export async function appendAgentPort(
	projectRoot: string,
	port: number,
): Promise<void> {
	const path = `${projectRoot}/${AGENT_PORTS_FILE}`;
	const existingPorts = await readAgentPorts(projectRoot);

	if (existingPorts.includes(port)) {
		return;
	}

	const alreadyExists = await fileExists(path);
	const line = `${port}\n`;

	if (alreadyExists) {
		const content = await Bun.file(path).text();
		const needsNewline = content.length > 0 && !content.endsWith("\n");
		await Bun.write(path, content + (needsNewline ? "\n" : "") + line);
	} else {
		await Bun.write(path, AGENT_PORTS_HEADER + line);
	}

	info(`Added ${port} to ${AGENT_PORTS_FILE}`);
}

// ### getAgentPortsBind
// .sandbox/ports is always read-only inside the sandbox, unconditionally — the
// same self-protection .sandbox/readonly already gives itself, not routed
// through the .sandbox/readonly protected-paths mechanism.
//
// If it doesn't exist yet, it is created first (header comment only) rather
// than left unbound: a missing source path gets no bind mount at all, which
// leaves that path part of the regular read-write project bind — letting the
// sandboxed agent create .sandbox/ports itself, with whatever ports it likes
// taking effect, completely unprotected, from that point on. Creating it
// before buildBwrapCommand runs closes this within the very same session
// that finds it missing, not just from the next run onward.
//
// Skipped under --dry-run, which never actually runs anything inside the
// sandbox — there is nothing for the gap above to expose — and must stay
// side-effect free, same as the auto-detect-and-append step.
export async function getConfigDirBind(
	projectRoot: string,
	sandboxProjDir: string,
	dryRun: boolean,
): Promise<BindMount | null> {
	// EM: Writing the ports default and binding the directory are now separate
	// EM: concerns, which they were not when this function *was* the ports
	// EM: bind. Gating the bind on that one file's existence meant a project
	// EM: with a readwrite file but no ports file got no bind at all — caught
	// EM: by agentreadwrite-self-protected-readonly rather than reasoned out.
	const portsPath = `${projectRoot}/${AGENT_PORTS_FILE}`;
	if (!dryRun && !(await fileExists(portsPath))) {
		await Bun.write(portsPath, AGENT_PORTS_HEADER);
	}

	// EM: dirExists, not fileExists: Bun.file(path).exists() answers "is there
	// EM: a regular file here" and is false for a directory — the same trap
	// EM: that made waitForXpraSocket never fire on a unix socket.
	const dir = `${projectRoot}/${CONFIG_DIR}`;
	if (!(await dirExists(dir))) {
		return null;
	}

	// EM: The directory, not the file. One bind covers every configuration
	// EM: file, including ones written later in the session and ones that do
	// EM: not exist yet — which is what makes the whole directory
	// EM: self-protecting with nothing to remember. It must come after the
	// EM: project bind, since it is nested inside it; safeBinds are emitted in
	// EM: order and after the worktree bind, so that holds.
	// EM:
	// EM: Read-only constrains the sandbox, not scoder: the host writes
	// EM: through the same inodes, so appendAgentPort adding an auto-detected
	// EM: port from outside still reaches the sandbox.
	return {
		type: "ro-bind",
		source: `${projectRoot}/${CONFIG_DIR}`,
		dest: `${sandboxProjDir}/${CONFIG_DIR}`,
	};
}

async function findProtectedPaths(
	worktreeDir: string,
	pattern: string,
): Promise<string[]> {
	try {
		const cleanPattern = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;

		const proc = await Bun.spawn(
			["find", cleanPattern, "-maxdepth", "100", "-prune"],
			{
				cwd: worktreeDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		await proc.exited;

		if (proc.exitCode !== 0) {
			return [];
		}

		const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
		const output = new TextDecoder().decode(stdoutBytes);

		const paths = output
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => line.replace(/^\.\//, ""))
			.sort();

		return [...new Set(paths)];
	} catch {
		return [];
	}
}

// ### _setupAgentsMdOverlay
// [IMPLEMENTS](/design/features/agents-md-overlay.md)
// [IMPLEMENTS](/design/features/live-file-overlays.md)
//
// EM: Returns a LiveOverlay rather than writing a file once, so that editing
// EM: AGENTS.md on the host takes effect in a running session. It previously
// EM: rendered exactly once at startup, which for the file whose entire
// EM: purpose is telling the agent how to behave is the wrong way round: the
// EM: moment you most want to correct an agent's instructions is while it is
// EM: working, and the only remedy was to restart the session.
async function _setupAgentsMdOverlay(
	sourceDir: string,
	sandboxProjDir: string,
): Promise<LiveOverlay> {
	const agentsSrc = `${sourceDir}/AGENTS.md`;
	const realHome = getRealHome();

	// EM: Deliberately says nothing about paths differing inside and outside,
	// EM: because they do not — path-mirroring binds the project and $HOME at
	// EM: their real paths, so there is one path space and nothing to
	// EM: translate. An earlier version described "sandbox paths" as distinct
	// EM: from host ones, which was true when the sandbox remapped $HOME and
	// EM: has been actively misleading since it stopped: it invites an agent
	// EM: to look for a translation that does not exist. Reported as exactly
	// EM: that — lines that are at best unnecessary and at worst confusing.
	// EM:
	// EM: What survives is the distinction that is still real and still
	// EM: actionable: an MCP server reached over localhost http is running
	// EM: OUTSIDE the sandbox, so the read-only binds and the ephemeral home
	// EM: do not apply to it, while a stdio one runs inside and they do.
	let sandboxSection = `## scoder sandbox

This section is injected by scoder inside the sandbox and is not part of the repository.

- You are running inside a scoder sandbox.
- Your \`$HOME\` is \`${realHome}\`, the real host home directory.
- \`stdio\` MCP servers run inside the sandbox and are subject to its restrictions; \`localhost\` http ones run outside it and are not, so they can reach files you cannot.
- You cannot edit files like \`AGENTS.md\` or \`.agents/*\` or other configuration files, so do not try. Ask the user to edit them instead.
- Read the \`working-in-a-scoder-sandbox\` skill: \`npx skills add https://github.com/robchallen/scoder/tree/main/skills/working-in-a-scoder-sandbox\`
`;

	if (isWorktreeMountPath(sourceDir, realHome)) {
		sandboxSection = `${sandboxSection}
- This checkout is an isolated git worktree managed by scoder, at \`${sourceDir}\`.
- Commit after all changes otherwise your edits will be lost.
`;
	}

	info("Overlaying sandbox AGENTS.md");

	return {
		label: "AGENTS.md",
		source: agentsSrc,
		dest: `${sandboxProjDir}/AGENTS.md`,
		injection: sandboxSection,
		// EM: Appended, so the project's own instructions are what the agent
		// EM: reads first and scoder's notes about the sandbox follow them.
		position: "append",
	};
}

// ### getAgentsMdOverlayBind
// [IMPLEMENTS](/design/features/agents-md-overlay.md)
export function getAgentsMdOverlayBind(
	overlayFile: string,
	sandboxProjDir: string,
): BindMount | null {
	if (!overlayFile) {
		return null;
	}

	return {
		type: "ro-bind",
		source: overlayFile,
		dest: `${sandboxProjDir}/AGENTS.md`,
	};
}

// EM: ### addGitExclude
// [IMPLEMENTS](/design/features/agents-md-overlay.md)
// Mark AGENTS.md as skip-worktree so git ignores the overlay modification.
// Uses git update-index which properly handles both worktrees and regular repos.
export async function addGitExclude(
	repoDir: string,
	pattern: string,
): Promise<void> {
	const proc = await Bun.spawn(
		["git", "update-index", "--skip-worktree", pattern],
		{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
	);
	await proc.exited;
}

// EM: ### removeGitExclude
// [IMPLEMENTS](/design/features/agents-md-overlay.md)
// Restore normal git tracking for the previously excluded file.
export async function removeGitExclude(
	repoDir: string,
	pattern: string,
): Promise<void> {
	const proc = await Bun.spawn(
		["git", "update-index", "--no-skip-worktree", pattern],
		{ cwd: repoDir, stdout: "pipe", stderr: "pipe" },
	);
	await proc.exited;
}

async function safeCopyDirRecursive(
	src: string,
	dest: string,
	visited: Set<string> = new Set(),
): Promise<void> {
	let realSrc: string;
	try {
		realSrc = await fsRealpath(src);
	} catch {
		return;
	}

	if (visited.has(realSrc)) {
		return;
	}
	visited.add(realSrc);

	let srcStat: import("node:fs").Stats | undefined;
	try {
		srcStat = await stat(realSrc);
	} catch {
		visited.delete(realSrc);
		return;
	}

	if (srcStat.isDirectory()) {
		await mkdir(dest, { recursive: true });
		const entries = await readdir(realSrc, { withFileTypes: true });
		for (const entry of entries) {
			const entrySrc = `${realSrc}/${entry.name}`;
			const entryDest = `${dest}/${entry.name}`;
			await safeCopyDirRecursive(entrySrc, entryDest, visited);
		}
	} else if (srcStat.isFile()) {
		const lastSlash = dest.lastIndexOf("/");
		if (lastSlash !== -1) {
			const parentDir = dest.slice(0, lastSlash);
			await mkdir(parentDir, { recursive: true });
		}
		await Bun.write(dest, Bun.file(realSrc));
	}

	visited.delete(realSrc);
}

// ### setupLocalBinSnapshot
// [IMPLEMENTS](/design/features/local-bin-resolution.md)
export async function setupLocalBinSnapshot(
	extraSandboxPrefixes: string[] = [],
): Promise<BindMount | null> {
	const realHome = getRealHome();
	const localBinSrc = `${realHome}/.local/bin`;

	if (!(await fileOrDirExists(localBinSrc))) {
		return null;
	}

	const snapshotDir = await stageDir(`${realHome}/.local/bin`);
	const sandboxPrefixes = [
		...sandboxMountPrefixes(realHome),
		...extraSandboxPrefixes,
	];
	const homePrefixes = await resolveHomePrefixes();

	try {
		await resolveLocalBinEntries(
			localBinSrc,
			snapshotDir,
			sandboxPrefixes,
			homePrefixes,
			realHome,
		);
	} catch (err) {
		error(`Failed to snapshot ~/.local/bin: ${err}`);
		error(
			"scoder copies ~/.local/bin at startup so symlinked tools resolve in the sandbox",
		);
		process.exit(1);
	}

	info(`Resolving ~/.local/bin in ${snapshotDir}`);

	return {
		type: "ro-bind",
		source: snapshotDir,
		dest: `${realHome}/.local/bin`,
	};
}

// ### resolveLocalBinEntries
// Walk ~/.local/bin and copy entries into snapshotDir. Regular files get their
// exec bits preserved. A symlink is kept as a symlink when its target maps to
// something actually bound into the sandbox; otherwise the target binary is
// copied in, unless it exceeds MAX_LOCAL_BIN_COPY_BYTES.
async function resolveLocalBinEntries(
	srcDir: string,
	destDir: string,
	sandboxPrefixes: string[],
	homePrefixes: string[],
	realHome: string,
): Promise<void> {
	const entries = await readdir(srcDir, { withFileTypes: true });

	for (const entry of entries) {
		const src = `${srcDir}/${entry.name}`;
		const dest = `${destDir}/${entry.name}`;

		try {
			if (entry.isSymbolicLink()) {
				await copySymlinkEntry(
					entry.name,
					src,
					dest,
					sandboxPrefixes,
					homePrefixes,
					realHome,
				);
			} else if (entry.isFile()) {
				await copyExecutable(src, dest);
			} else {
				await cp(src, dest, {
					recursive: true,
					dereference: true,
				});
			}
			// Directories inside ~/.local/bin are copied (usually contain libraries)
		} catch {
			// Broken symlink or unreadable file — skip silently
		}
	}
}

// ### copySymlinkEntry
// Reproduce one ~/.local/bin symlink inside the snapshot.
async function copySymlinkEntry(
	name: string,
	src: string,
	dest: string,
	sandboxPrefixes: string[],
	homePrefixes: string[],
	realHome: string,
): Promise<void> {
	const target = await readlink(src);
	const targetReal = await realpath(target);
	const sandboxTarget = toSandboxPath(targetReal, homePrefixes);

	await ensureParentDir(dest);

	if (isSandboxResolvable(sandboxTarget, sandboxPrefixes, realHome)) {
		// Target is bound into the sandbox. Keep the symlink, but point it at the
		// sandbox path — the host spelling does not exist inside the sandbox.
		// Relative targets already resolve within the snapshot, so leave them be.
		const linkTarget = target.startsWith("/") ? sandboxTarget : target;
		await Bun.spawn(["ln", "-sf", linkTarget, dest]).exited;
		info(`Symlink OK: ${name} → ${linkTarget}`);
		return;
	}

	const st = await stat(targetReal);

	if (st.size > MAX_LOCAL_BIN_COPY_BYTES) {
		// Too big to copy on every launch. Keep a mapped symlink so the entry
		// still works if the target directory happens to be bound.
		await Bun.spawn(["ln", "-sf", sandboxTarget, dest]).exited;
		info(
			`Symlink unresolved: ${name} → ${targetReal} (${Math.round(st.size / 1024 / 1024)} MB, not copied)`,
		);
		return;
	}

	// Target is not reachable inside the sandbox — copy it in.
	const data = await Bun.file(targetReal).arrayBuffer();
	await Bun.write(dest, data);
	if (st.mode & 0o111) {
		await Bun.spawn(["chmod", "+x", dest]).exited;
	}
	info(`Copied target: ${name} → ${targetReal}`);
}

// ### copyExecutable
// Copy a regular file into the snapshot, preserving its executable bit.
async function copyExecutable(src: string, dest: string): Promise<void> {
	const data = await Bun.file(src).arrayBuffer();
	await ensureParentDir(dest);
	await Bun.write(dest, data);

	const st = await stat(src);
	if (st.mode & 0o111) {
		await Bun.spawn(["chmod", "+x", dest]).exited;
	}
}

async function ensureParentDir(path: string): Promise<void> {
	const lastSlash = path.lastIndexOf("/");
	if (lastSlash !== -1) {
		await mkdir(path.slice(0, lastSlash), { recursive: true });
	}
}

// ### isSandboxResolvable
// Check whether an already-sandbox-mapped path will be populated inside the
// sandbox, by testing it against the set of destinations that get bound.
function isSandboxResolvable(
	sandboxPath: string,
	sandboxPrefixes: string[],
	realHome: string,
): boolean {
	if (isWorktreeMountPath(sandboxPath, realHome)) {
		return true; // worktree mount, mirrored at its real path
	}

	return isUnderAny(sandboxPath, sandboxPrefixes);
}

// [IMPLEMENTS](/design/features/agents-skills-snapshot.md)
export async function setupAgentsSnapshot(): Promise<BindMount | null> {
	const realHome = getRealHome();
	const agentsSrc = `${realHome}/.agents`;

	if (!(await fileOrDirExists(agentsSrc))) {
		return null;
	}

	const snapshotDir = await stageDir(`${realHome}/.agents`);

	try {
		await safeCopyDirRecursive(agentsSrc, snapshotDir);
	} catch (err) {
		error(`Failed to snapshot ~/.agents: ${err}`);
		error(
			"scoder copies ~/.agents at startup so symlinked skills resolve in the sandbox",
		);
		process.exit(1);
	}

	info(`Snapshotting ${agentsSrc} to ${snapshotDir}`);

	return {
		type: "ro-bind",
		source: snapshotDir,
		dest: `${realHome}/.agents`,
	};
}

// ### resolveResolvConfSource
// Picks which real host file the DNS snapshot should track: plain
// /etc/resolv.conf, unless it's just a systemd-resolved stub (a loopback
// nameserver), in which case the *real* upstream config systemd-resolved
// itself maintains is used instead. Re-run on every refresh tick as well
// as at initial snapshot time — which one is authoritative can only be
// determined by reading /etc/resolv.conf's own current content, not
// assumed once and cached.
async function resolveResolvConfSource(): Promise<string | null> {
	try {
		const content = await Bun.file("/etc/resolv.conf").text();

		if (
			content.includes("nameserver 127.") ||
			content.includes("nameserver ::1")
		) {
			const systemdResolv = "/run/systemd/resolve/resolv.conf";
			if (await fileExists(systemdResolv)) {
				return systemdResolv;
			}
		}

		return "/etc/resolv.conf";
	} catch {
		return null;
	}
}

export async function setupResolvConf(): Promise<BindMount | null> {
	const resolvSrc = await resolveResolvConfSource();
	if (!resolvSrc) {
		return null;
	}

	const snapshotFile = await stageFile("/etc/resolv.conf");

	try {
		const content = await Bun.file(resolvSrc).text();
		await Bun.write(snapshotFile, content);
	} catch {
		return null;
	}

	return {
		type: "ro-bind",
		source: snapshotFile,
		dest: "/etc/resolv.conf",
	};
}

// ### refreshResolvConfSnapshot
// [IMPLEMENTS](/design/features/network-isolation.md)
// Re-reads the real host DNS config and rewrites it into the
// already-bound snapshot file if it changed — no remount, no pasta
// involvement, unlike .sandbox/ports' own live-reload: /etc/resolv.conf
// inside the sandbox is a --ro-bind of this exact host file (not a copy
// captured once and detached from it), so overwriting its content on
// the host is visible inside the sandbox immediately. Fixes a real,
// reported gap: a power-state event (suspend/resume) that changes the
// host's own DNS server left the sandbox's one-time snapshot pointing
// at a now-unreachable server for the rest of the session, with no way
// to recover short of a full restart — confirmed directly that pasta's
// own routing stayed healthy throughout (a raw-IP curl worked
// throughout), isolating the problem to this snapshot specifically, not
// pasta's own reattach-on-.sandbox/ports-change mechanism.
//
// Returns true if the file's content actually changed, so the caller
// can log it — same shape as the .sandbox/ports watcher's own "only log on
// an actual change" behaviour.
export async function refreshResolvConfSnapshot(
	snapshotFile: string,
): Promise<boolean> {
	const resolvSrc = await resolveResolvConfSource();
	if (!resolvSrc) {
		return false;
	}

	try {
		const newContent = await Bun.file(resolvSrc).text();
		const oldContent = await Bun.file(snapshotFile).text();

		if (newContent === oldContent) {
			return false;
		}

		await Bun.write(snapshotFile, newContent);
		return true;
	} catch {
		return false;
	}
}

async function dirExists(path: string): Promise<boolean> {
	try {
		return (await Bun.file(path).stat()).isDirectory();
	} catch {
		return false;
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		return await Bun.file(path).exists();
	} catch {
		return false;
	}
}

async function fileOrDirExists(path: string): Promise<boolean> {
	try {
		await Bun.file(path).stat();
		return true;
	} catch {
		return false;
	}
}

async function realpath(path: string): Promise<string> {
	try {
		const proc = await Bun.spawn(["realpath", path], {
			stdout: "pipe",
			stderr: "pipe",
		});

		await proc.exited;

		if (proc.exitCode !== 0) {
			return path;
		}

		const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
		return new TextDecoder().decode(stdoutBytes).trim();
	} catch {
		return path;
	}
}

function appendUniquePath(array: string[], value: string): void {
	if (!array.includes(value)) {
		array.push(value);
	}
}
