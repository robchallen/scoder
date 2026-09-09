import {
	realpath as fsRealpath,
	lstat,
	mkdir,
	readdir,
	readlink,
	stat,
} from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import type { BindMount } from "../types.ts";
import { error, info, warning } from "../utils/logger.ts";
import {
	getRealHome,
	isUnderAny,
	resolveHomePrefixes,
	toSandboxPath,
} from "../utils/paths.ts";

// EM: Infrastructure protection via .agentreadonly and AGENTS.md overlay
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

const RESERVED_SANDBOX_PATHS = [
	"/home/scoder/.agents",
	"/home/scoder/.cache",
	"/home/scoder/.cargo",
	"/home/scoder/.claude",
	"/home/scoder/.config",
	"/home/scoder/.copilot",
	"/home/scoder/.gitconfig",
	"/home/scoder/.local",
	"/home/scoder/.local/share/mise",
	"/home/scoder/.m2",
	"/home/scoder/.npmrc",
	"/home/scoder/.pypirc",
	"/home/scoder/.Rprofile",
	"/home/scoder/.rustup",
	"/home/scoder/R",
];

// Sandbox destinations that are always bind-mounted, used to resolve symlinks
// in ~/.local/bin at snapshot time. If a symlink target maps under one of these
// it is sandbox-resolvable and the symlink is kept (with its target rewritten
// into the sandbox namespace); otherwise the target binary is copied in.
//
// This list must mirror buildExtraBinds in src/sandbox/builder.ts exactly. A
// prefix that is NOT actually bound makes the check claim resolvability it
// cannot deliver, producing a dangling symlink inside the sandbox — which is
// why the entries are the precise bound paths rather than their parents.
// Preset-specific destinations are dynamic and passed in separately.
const SANDBOX_MOUNT_PREFIXES = [
	"/tmp/scoder/", // worktree
	"/home/scoder/.local/bin",
	"/home/scoder/.local/share/mise",
	"/home/scoder/.config/mise",
	"/home/scoder/.config/gh",
	"/home/scoder/.cargo/bin",
	"/home/scoder/.rustup",
	"/home/scoder/R",
	"/home/scoder/.Rprofile",
	"/home/scoder/.m2",
	"/home/scoder/.npmrc",
	"/home/scoder/.pypirc",
	"/home/scoder/.gitconfig",
];

// Ceiling on copying an unresolvable symlink target into the snapshot. Some
// tools ship hundreds of megabytes in a single binary (Claude Code's native
// installer is ~275 MB), and copying that on every launch of an unrelated tool
// is not worth it. Oversized targets keep a sandbox-mapped symlink instead,
// which resolves only if something binds the target directory.
const MAX_LOCAL_BIN_COPY_BYTES = 64 * 1024 * 1024;

export interface ProtectionConfig {
	protectedPaths: string[];
	safeBinds: BindMount[];
	agentsMdOverlay?: string;
	dirs?: string[];
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
	const agentreadonlyPath = `${sourceDir}/.agentreadonly`;
	const agentreadonlyExists = await fileExists(agentreadonlyPath);

	if (agentreadonlyExists) {
		const content = await Bun.file(agentreadonlyPath).text();
		const lines = content.split("\n");

		for (const line of lines) {
			if (line.trim() === "" || line.trim().startsWith("#")) {
				continue;
			}

			if (line.startsWith("$HOME/")) {
				await registerAgentreadonlyHomeBind(line, safeBinds, dirs);
				continue;
			}

			const localMatches = await findProtectedPaths(sourceDir, line.trim());
			for (const match of localMatches) {
				appendUniquePath(protectedPaths, match);
			}
		}
	} else {
		protectedPaths.push(...DEFAULT_PROTECTED);
		// EM: Default .agentreadonly created with protected infrastructure paths
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

	// EM: Unconditional, not gated on agentreadonlyExists: by this point the
	// EM: file always exists, either it did already or the else branch above
	// EM: just wrote a default. Gating this on the pre-write flag left a
	// EM: freshly created default writable from inside the sandbox for that
	// EM: first session — a missing source path gets no bind mount at all,
	// EM: leaving .agentreadonly part of the regular read-write project bind.
	// EM: Same bug class as the .agentports fix; see
	// EM: design/implementation/plans/agentports.md.
	safeBinds.push({
		type: "ro-bind",
		source: agentreadonlyPath,
		dest: `${sandboxProjDir}/.agentreadonly`,
	});

	const agentsMdOverlay = await _setupAgentsMdOverlay(
		sourceDir,
		sandboxProjDir,
	);

	return { protectedPaths, safeBinds, agentsMdOverlay, dirs };
}

async function registerAgentreadonlyHomeBind(
	homePathExpr: string,
	binds: BindMount[],
	dirs: string[],
): Promise<void> {
	const realHome = process.env.HOME || "/home/user";
	const relativePath = homePathExpr.slice("$HOME/".length);
	const sourcePath = `${realHome}/${relativePath}`;

	const sourceReal = await realpath(sourcePath);

	if (!sourceReal || !(await fileOrDirExists(sourceReal))) {
		error(
			`.agentreadonly HOME bind must reference an existing directory: ${homePathExpr}`,
		);
		process.exit(1);
	}

	if (sourceReal !== realHome && !sourceReal.startsWith(`${realHome}/`)) {
		error(`.agentreadonly HOME bind escapes HOME: ${homePathExpr}`);
		process.exit(1);
	}

	const sandboxDest = `/home/scoder/${relativePath}`;

	for (const reservedPath of RESERVED_SANDBOX_PATHS) {
		if (pathsOverlap(sandboxDest, reservedPath)) {
			error(
				`.agentreadonly HOME bind overlaps reserved sandbox path: ${homePathExpr}`,
			);
			process.exit(1);
		}
	}

	const SCODER_HOME = "/home/scoder";
	if (sandboxDest !== SCODER_HOME) {
		const rel = sandboxDest.slice(`${SCODER_HOME}/`.length);
		const parts = rel.split("/");
		let currentPath = SCODER_HOME;
		for (const part of parts) {
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

	info(`Binding ${homePathExpr} to ${sandboxDest} (read-only)`);
}

function pathsOverlap(left: string, right: string): boolean {
	const l = left.endsWith("/") ? left.slice(0, -1) : left;
	const r = right.endsWith("/") ? right.slice(0, -1) : right;

	return l === r || l.startsWith(`${r}/`) || r.startsWith(`${l}/`);
}

const SCRATCH_LINK_NAME = "scratch";

// Real host paths mirroring buildExtraBinds in src/sandbox/builder.ts —
// what setupScratchLink treats as "already read-only furniture". Must be
// kept in sync with that function, same caveat SANDBOX_MOUNT_PREFIXES above
// already carries for a different check.
function furniturePaths(realHome: string): string[] {
	return [
		`${realHome}/.local/bin`,
		`${realHome}/.gitconfig`,
		`${realHome}/R`,
		`${realHome}/.Rprofile`,
		`${realHome}/.m2`,
		`${realHome}/.local/share/mise`,
		`${realHome}/.config/mise`,
		`${realHome}/.rustup`,
		`${realHome}/.cargo/bin`,
		`${realHome}/.npmrc`,
		`${realHome}/.pypirc`,
		`${realHome}/.config/gh`,
	];
}

// ### setupScratchLink
// [IMPLEMENTS](/design/features/persistent-scratch.md)
// A `scratch` symlink at the project root is the entire opt-in mechanism —
// no flag, no config. The symlink is never touched: its resolved target is
// mirrored at that target's own real absolute path (the same path-mirroring
// principle the project bind itself already relies on), so the symlink,
// completely unmodified, resolves inside the sandbox exactly the way it
// already does outside it.
export async function setupScratchLink(
	projectRoot: string,
	protectionConfig: ProtectionConfig,
): Promise<void> {
	const linkPath = `${projectRoot}/${SCRATCH_LINK_NAME}`;

	let linkStat: import("node:fs").Stats;
	try {
		linkStat = await lstat(linkPath);
	} catch {
		return; // No scratch symlink — nothing to do.
	}

	if (!linkStat.isSymbolicLink()) {
		return; // An unrelated file/dir named "scratch" — leave it alone.
	}

	const realHome = process.env.HOME || "/home/user";
	const target = await resolveScratchTarget(linkPath);

	if (target !== realHome && !target.startsWith(`${realHome}/`)) {
		error(`scratch must resolve inside your home directory, got: ${target}`);
		process.exit(1);
	}

	let targetStat: import("node:fs").Stats;
	try {
		targetStat = await stat(target);
	} catch {
		// Expected, valid state: the target hasn't been set up on this
		// machine yet (a fresh clone, a new colleague, CI). The dangling
		// symlink is left exactly as-is, inside and outside the sandbox
		// alike — that visible gap is the signal, not a bug to hide.
		warning(`scratch points at ${target}, which does not exist yet — skipping`);
		return;
	}

	if (!targetStat.isDirectory()) {
		error(`scratch must resolve to a directory, got a file: ${target}`);
		process.exit(1);
	}

	const readOnly = overlapsExistingReadOnlyBind(
		target,
		realHome,
		protectionConfig,
	);

	protectionConfig.dirs = protectionConfig.dirs || [];
	for (const dir of ancestorDirs(target)) {
		if (!protectionConfig.dirs.includes(dir)) {
			protectionConfig.dirs.push(dir);
		}
	}

	protectionConfig.safeBinds.push({
		type: readOnly ? "ro-bind" : "bind",
		source: target,
		dest: target,
	});

	info(`scratch -> ${target} (${readOnly ? "read-only" : "read-write"})`);
}

// ### resolveScratchTarget
// Computes the symlink's absolute target directly from its stored string,
// rather than requiring the target (or its ancestors) to already exist —
// realpath(1) fails outright when the target's own parent directories are
// also missing, which is exactly the "not set up on this machine yet" case
// this feature needs to handle gracefully rather than mis-resolve.
async function resolveScratchTarget(linkPath: string): Promise<string> {
	const rawTarget = await readlink(linkPath);

	return rawTarget.startsWith("/")
		? rawTarget
		: resolvePath(dirname(linkPath), rawTarget);
}

// ### overlapsExistingReadOnlyBind
// True if target is already covered by a read-only bind: an .agentreadonly
// $HOME/... entry (already in protectionConfig.safeBinds by the time this
// runs), or one of buildExtraBinds' fixed host-tool paths. Deliberately not
// exhaustive — it checks known sources, not every mechanism that might touch
// $HOME (e.g. the ~/.agents and ~/.local/bin snapshots bind from a temp copy,
// not the real path, so they can never appear here at all).
function overlapsExistingReadOnlyBind(
	target: string,
	realHome: string,
	protectionConfig: ProtectionConfig,
): boolean {
	for (const bind of protectionConfig.safeBinds) {
		if (bind.type === "ro-bind" && pathsOverlap(target, bind.source)) {
			return true;
		}
	}

	return furniturePaths(realHome).some((furniture) =>
		pathsOverlap(target, furniture),
	);
}

// Every ancestor directory of an absolute path, root-to-leaf's-parent.
// Excludes the path itself — the --bind at that final destination is what
// establishes it as a directory.
function ancestorDirs(absPath: string): string[] {
	const parts = absPath.split("/").filter(Boolean);
	const dirs: string[] = [];
	let current = "";

	for (let i = 0; i < parts.length - 1; i++) {
		current += `/${parts[i]}`;
		dirs.push(current);
	}

	return dirs;
}

const AGENT_PORTS_FILE = ".agentports";
const AGENT_PORTS_HEADER =
	"# .agentports — ports forwarded from host loopback into the sandbox, one per line\n";

// ### readAgentPorts
// [IMPLEMENTS](/design/features/network-isolation.md)
// Reads and validates .agentports: one port per line, blank lines and #
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
// setupProtection already does for a missing .agentreadonly (seeding a
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
// .agentports is always read-only inside the sandbox, unconditionally — the
// same self-protection .agentreadonly already gives itself, not routed
// through the .agentreadonly protected-paths mechanism.
//
// If it doesn't exist yet, it is created first (header comment only) rather
// than left unbound: a missing source path gets no bind mount at all, which
// leaves that path part of the regular read-write project bind — letting the
// sandboxed agent create .agentports itself, with whatever ports it likes
// taking effect, completely unprotected, from that point on. Creating it
// before buildBwrapCommand runs closes this within the very same session
// that finds it missing, not just from the next run onward.
//
// Skipped under --dry-run, which never actually runs anything inside the
// sandbox — there is nothing for the gap above to expose — and must stay
// side-effect free, same as the auto-detect-and-append step.
export async function getAgentPortsBind(
	projectRoot: string,
	sandboxProjDir: string,
	dryRun: boolean,
): Promise<BindMount | null> {
	const path = `${projectRoot}/${AGENT_PORTS_FILE}`;

	if (!(await fileExists(path))) {
		if (dryRun) {
			return null;
		}
		await Bun.write(path, AGENT_PORTS_HEADER);
	}

	return {
		type: "ro-bind",
		source: path,
		dest: `${sandboxProjDir}/${AGENT_PORTS_FILE}`,
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

async function _setupAgentsMdOverlay(
	sourceDir: string,
	_sandboxProjDir: string,
): Promise<string | undefined> {
	const agentsSrc = `${sourceDir}/AGENTS.md`;
	const agentsMdExists = await fileExists(agentsSrc);

	const overlayFile = await createTempFile("scoder-agents-md");

	if (agentsMdExists) {
		const content = await Bun.file(agentsSrc).text();
		await Bun.write(overlayFile, `${content}\n`);
	} else {
		await Bun.write(overlayFile, "");
	}

	const realHome = getRealHome();

	let sandboxSection = `## scoder sandbox

This section is injected by scoder inside the sandbox and is not part of the repository.

- You are running inside a scoder sandbox.
- \`/home/scoder\` is an ephemeral sandbox home — nothing here persists between sessions, and it is not a real host path.
- The host's real home directory is \`${realHome}\`.
- Wherever possible use relative paths to reference files that make no assumption on the home directory.
- \`localhost\` http MCP servers may be running outside the sandbox and operate on real host filesystem.
- \`stdio\` MCP servers run inside the sandbox and use sandbox paths.
- If you get errors when using MCP servers with file-path arguments, then use \`${realHome}/...\`, instead of \`/home/scoder/...\`
- You cannot edit files like \`AGENTS.md\` or \`.agents/*\` or other configuration files, so do not try. Ask the user to edit them instead.
- Read the \`working-in-a-scoder-sandbox\` skill: \`npx skills add https://github.com/robchallen/scoder/tree/main/skills/working-in-a-scoder-sandbox\`
`;

	if (sourceDir.startsWith("/tmp/scoder/")) {
		sandboxSection = `${sandboxSection}
- This checkout is an isolated git worktree managed by scoder.
- Commit after all changes otherwise your edits will be lost.
`;
	}

	const existingContent = await Bun.file(overlayFile).text();
	await Bun.write(overlayFile, existingContent + sandboxSection);

	info("Overlaying sandbox AGENTS.md");

	return overlayFile;
}

async function createTempFile(prefix: string): Promise<string> {
	const proc = await Bun.spawn(["mktemp", `/tmp/${prefix}.XXXXXX`], {
		stdout: "pipe",
		stderr: "pipe",
	});

	await proc.exited;

	if (proc.exitCode !== 0) {
		throw new Error("Failed to create temp file");
	}

	const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
	return new TextDecoder().decode(stdoutBytes).trim();
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
	const localBinSrc = `${process.env.HOME}/.local/bin`;

	if (!(await fileOrDirExists(localBinSrc))) {
		return null;
	}

	const snapshotDir = await createTempDir("scoder-local-bin");
	const sandboxPrefixes = [...SANDBOX_MOUNT_PREFIXES, ...extraSandboxPrefixes];
	const homePrefixes = await resolveHomePrefixes();

	try {
		await resolveLocalBinEntries(
			localBinSrc,
			snapshotDir,
			sandboxPrefixes,
			homePrefixes,
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
		dest: "/home/scoder/.local/bin",
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
				);
			} else if (entry.isFile()) {
				await copyExecutable(src, dest);
			}
			// Directories inside ~/.local/bin are silently skipped
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
): Promise<void> {
	const target = await readlink(src);
	const targetReal = await realpath(target);
	const sandboxTarget = toSandboxPath(targetReal, homePrefixes);

	await ensureParentDir(dest);

	if (isSandboxResolvable(sandboxTarget, sandboxPrefixes)) {
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
): boolean {
	if (sandboxPath.startsWith("/tmp/scoder/")) {
		return true; // worktree mount, mirrored at its real path
	}

	return isUnderAny(sandboxPath, sandboxPrefixes);
}

// [IMPLEMENTS](/design/features/agents-skills-snapshot.md)
export async function setupAgentsSnapshot(): Promise<BindMount | null> {
	const agentsSrc = `${process.env.HOME}/.agents`;

	if (!(await fileOrDirExists(agentsSrc))) {
		return null;
	}

	const snapshotDir = await createTempDir("scoder-agents");

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
		dest: "/home/scoder/.agents",
	};
}

async function createTempDir(prefix: string): Promise<string> {
	const proc = await Bun.spawn(["mktemp", "-d", `/tmp/${prefix}.XXXXXX`], {
		stdout: "pipe",
		stderr: "pipe",
	});

	await proc.exited;

	if (proc.exitCode !== 0) {
		throw new Error("Failed to create temp dir");
	}

	const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
	return new TextDecoder().decode(stdoutBytes).trim();
}

export async function setupResolvConf(): Promise<BindMount | null> {
	let resolvSrc = "/etc/resolv.conf";

	try {
		const content = await Bun.file(resolvSrc).text();

		if (
			content.includes("nameserver 127.") ||
			content.includes("nameserver ::1")
		) {
			const systemdResolv = "/run/systemd/resolve/resolv.conf";
			if (await fileExists(systemdResolv)) {
				resolvSrc = systemdResolv;
			}
		}
	} catch {
		return null;
	}

	const snapshotFile = await createTempFile("scoder-resolv");

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
