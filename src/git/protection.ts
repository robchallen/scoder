import {
	realpath as fsRealpath,
	mkdir,
	readdir,
	readlink,
	stat,
} from "node:fs/promises";
import type { BindMount } from "../types.ts";
import { error, info } from "../utils/logger.ts";
import {
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

	if (agentreadonlyExists) {
		safeBinds.push({
			type: "ro-bind",
			source: agentreadonlyPath,
			dest: `${sandboxProjDir}/.agentreadonly`,
		});
	}

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

	const sandboxSection = `## scoder sandbox

This section is injected by scoder inside the sandbox and is not part of the repository.

- You are running inside a scoder sandbox.
- \`/home/scoder\` is an ephemeral sandbox home. Other paths in your context may be stale if they refer to the host's home path. Always use paths relative to $HOME.
${sourceDir.startsWith("/tmp/scoder/") ? "- This checkout is an isolated git worktree managed by scoder.\n- Commit after all changes otherwise your edits will be lost.\n" : ""}- Locally hosted HTTP MCP servers may not be available.
- You cannot edit files like \`AGENTS.md\` or \`.agents/*\` or other configuration files, so do not try.
- Read the \`working-in-a-scoder-sandbox\` skill: \`npx skills add https://github.com/robchallen/scoder/tree/main/skills/working-in-a-scoder-sandbox\`
`;

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
