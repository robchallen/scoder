import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { getProjDir } from "../git/worktree.ts";
import type { BindMount, ToolBindSpec, ToolPreset } from "../types.ts";
import { error, warning } from "../utils/logger.ts";
import {
	getRealHome,
	resolveHomePrefixes,
	toSandboxPath,
} from "../utils/paths.ts";

// EM: Tool preset system for opencode, claude, copilot, and pi
// EM: Implements tool-presets feature with tool-specific config/data bindings

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

async function ensureDir(path: string): Promise<void> {
	await Bun.spawn(["mkdir", "-p", path]);
}

// EM: ### Eclipse preset support
// EM: See design/implementation/plans/eclipse-preset.md for the full
// EM: investigation this is built on. Kept together, ahead of TOOL_PRESETS,
// EM: since configBinds/prepareCommand/resolveArgs all need the exact same
// EM: computed layout and must never disagree with each other about it.

const ECLIPSE_JAR_NAME = "com.seeq.eclipse.importprojects_1.4.0.jar";
// EM: Pinned, not "whatever's newest" — the plugin's own master branch is
// EM: ahead of this exact build in a way that silently breaks it (a
// EM: renamed CLI flag). Re-verify by hand, the same way, before ever
// EM: bumping this. See Design Decision 2 in eclipse-preset.md.
const ECLIPSE_JAR_SHA256 =
	"133c61b284c61b889836560c06619e1ff3619080b733537f4137d1accb28ab2d";
const ECLIPSE_JAR_PATH = new URL(
	`../../assets/eclipse/${ECLIPSE_JAR_NAME}`,
	import.meta.url,
).pathname;
// EM: The bundle's own symbolic name and version, as recorded in its
// EM: MANIFEST.MF — needed verbatim for the bundles.info entry below, not
// EM: derivable from ECLIPSE_JAR_NAME by convention alone.
const ECLIPSE_JAR_SYMBOLIC_NAME = "com.seeq.eclipse.importprojects";
const ECLIPSE_JAR_BUNDLE_VERSION = "1.4.0";

interface EclipseLayout {
	sandboxEclipseBin: string;
	hostInstallDir: string;
	sandboxInstallDir: string;
	workspaceHostDir: string;
	workspaceSandboxDir: string;
	configHostDir: string;
	configSandboxDir: string;
	// EM: True once an existing ~/.eclipse/<app>_<version>_<hash> directory
	// EM: was found on the host — see Decision 5 in eclipse-preset.md. When
	// EM: true, no -configuration flag is passed at all: it's bound in at
	// EM: the identical mirrored path, and Eclipse's own default resolution
	// EM: finds it exactly the way it would outside the sandbox.
	reuseHostConfig: boolean;
}

// ### javaStringHashCode
// Reproduces java.lang.String#hashCode() exactly: s[0]*31^(n-1) + ... +
// s[n-1], computed with 32-bit wraparound (Math.imul does the wraparound
// multiply; `| 0` keeps the running total a 32-bit signed int, matching
// Java's int arithmetic). Needed to compute the same
// ~/.eclipse/<app>_<version>_<hash> directory name Equinox's own
// getInstallDirHash() would — see eclipse-preset.md's "The ~/.eclipse/<hash>
// fallback" section for the citation.
function javaStringHashCode(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = Math.imul(31, h) + s.charCodeAt(i);
	}
	return h | 0;
}

// ### pushIntermediateDirs
// bwrap's --dir does not create intermediate path segments on its own (see
// registerAgentreadonlyHomeBind in src/git/protection.ts, which has the
// same requirement) — every level from sandboxHome down to the leaf has to
// be its own --dir. Harmless to re-push a segment builder.ts's own fixed
// --dir list (or another preset) already declared; bwrap tolerates a
// repeated --dir the same way it tolerates a repeated bind.
function pushIntermediateDirs(
	dirs: string[],
	sandboxHome: string,
	relPath: string,
): void {
	let current = sandboxHome;
	for (const part of relPath.split("/").filter(Boolean)) {
		current = `${current}/${part}`;
		if (!dirs.includes(current)) {
			dirs.push(current);
		}
	}
}

// ### resolveEclipseLayout
// Computes every path the eclipse preset's three hooks (configBinds,
// prepareCommand, resolveArgs) need to agree on. Called independently from
// each of them rather than threaded through as shared state — ToolPreset's
// hooks are plain functions with no shared closure over per-launch state —
// but every input is either fixed (the host's own filesystem) or derived
// purely from hostProjectDir, so recomputing it is deterministic and safe
// to call more than once per launch.
async function resolveEclipseLayout(
	hostProjectDir: string,
): Promise<EclipseLayout | null> {
	const hostEclipseBin = await resolveCommandPath("eclipse");
	if (!hostEclipseBin) {
		return null;
	}

	const realHome = getRealHome();
	const homePrefixes = await resolveHomePrefixes();
	const sandboxEclipseBin = toSandboxPath(hostEclipseBin, homePrefixes);

	// EM: Eclipse's plugins/ dir sits alongside the real executable, not
	// EM: the symlink `which` may have found (e.g. /etc/alternatives/eclipse
	// EM: or a distro's own indirection) — resolve through it. See the
	// EM: "Locating the Eclipse installation's own directory" open question
	// EM: in eclipse-preset.md: confirmed for a plain /opt install, not
	// EM: independently verified for a distro-packaged one.
	let hostInstallDir: string;
	try {
		hostInstallDir = dirname(await realpath(hostEclipseBin));
	} catch {
		hostInstallDir = dirname(hostEclipseBin);
	}
	const sandboxInstallDir = toSandboxPath(hostInstallDir, homePrefixes);

	const projDir = await getProjDir(hostProjectDir);
	const workspaceHostDir = `${realHome}/.local/share/scoder-eclipse-workspaces/${projDir}`;
	await ensureDir(workspaceHostDir);
	const workspaceSandboxDir = toSandboxPath(workspaceHostDir, homePrefixes);

	// EM: Equinox's own getInstallDirHash() hashes the install dir's
	// EM: *canonical* path, falling back to the absolute path only if that
	// EM: can't be resolved — mirrored here for the same reason: this hash
	// EM: has to land on the exact directory name a real, native Eclipse
	// EM: run against this same install would use.
	let canonicalInstallDir: string;
	try {
		canonicalInstallDir = await realpath(hostInstallDir);
	} catch {
		canonicalInstallDir = hostInstallDir;
	}
	const hashStr = Math.abs(javaStringHashCode(canonicalInstallDir)).toString();

	// EM: Matched by hash suffix alone, not by reconstructing the full
	// EM: <app>_<version>_<hash> name from .eclipseproduct — the hash is
	// EM: the only part that's actually load-bearing for correctness (it's
	// EM: what ties the directory to this specific install path); getting
	// EM: an app id or version string wrong would otherwise risk missing a
	// EM: real, existing directory for no good reason.
	const eclipseUserDir = `${realHome}/.eclipse`;
	let reuseDirName: string | null = null;
	if (await dirExists(eclipseUserDir)) {
		const entries = await readdir(eclipseUserDir);
		reuseDirName = entries.find((name) => name.endsWith(`_${hashStr}`)) ?? null;
	}

	let configHostDir: string;
	let reuseHostConfig: boolean;
	if (reuseDirName) {
		configHostDir = `${eclipseUserDir}/${reuseDirName}`;
		reuseHostConfig = true;
	} else {
		// EM: Keyed by the install's own hash, not by project — matching
		// EM: Eclipse's real granularity (this is per-install runtime state,
		// EM: not per-project), and so shared correctly across every scoder
		// EM: project that happens to use the same Eclipse install.
		configHostDir = `${realHome}/.local/share/scoder-eclipse-config/${hashStr}`;
		await ensureDir(configHostDir);
		reuseHostConfig = false;
	}
	const configSandboxDir = toSandboxPath(configHostDir, homePrefixes);

	return {
		sandboxEclipseBin,
		hostInstallDir,
		sandboxInstallDir,
		workspaceHostDir,
		workspaceSandboxDir,
		configHostDir,
		configSandboxDir,
		reuseHostConfig,
	};
}

// EM: The -configuration flag is included only in the fallback case — when
// EM: reusing the host's own directory, passing no flag at all is the
// EM: point (see Decision 5): Eclipse's own default resolution finds it.
function eclipseConfigArgs(layout: EclipseLayout): string[] {
	return layout.reuseHostConfig
		? []
		: ["-configuration", layout.configSandboxDir];
}

// ### ensureEclipseBundlesInfo
// Registers the vendored plugin with Equinox's simpleconfigurator by
// editing `bundles.info` directly, entirely on the host side (plain file
// I/O, no bwrap involved) — NOT by injecting the jar into the install's
// own plugins/ dir, which was tried first and confirmed broken: a real
// installer-owned install's plugins/ directory is genuinely read-only
// (not just made so by scoder), and bwrap's --ro-bind needs to *create* a
// destination node for a file that doesn't already exist there, which
// fails with exactly the reported "Read-only file system" once the
// parent has already been mounted read-only (by builder.ts's own
// wholesale /opt bind, applied well before any preset's own binds run).
// The earlier "verified" claim in eclipse-preset.md tested a subtly
// different scenario — binding a new source *over an already-existing*
// destination file — not creating a brand-new one; corrected there.
//
// bundles.info is Equinox's own definitive bundle list (modern Eclipse
// installs use org.eclipse.equinox.simpleconfigurator, not a long
// per-bundle osgi.bundles= line) — confirmed directly, headlessly, no GTK
// needed: an empty/partial bundles.info in the configuration area does
// NOT fall back to merging with the install's own default list (an
// earlier attempt with *only* this plugin's own line in an otherwise
// empty bundles.info failed with "Unresolved requirement: Require-Bundle:
// org.eclipse.ui" — org.eclipse.ui and the rest of the normal bundle set
// were simply never loaded). So the full base list has to be present in
// whichever bundles.info Equinox actually reads, not just our own
// addition to it.
//
// The referenced jar path is a sandbox-only path (see configBinds), so
// when reusing the user's own real ~/.eclipse/<hash> directory (Decision
// 5), this writes that same sandbox-only reference into their real,
// native config. Confirmed directly this is benign: a bundles.info entry
// whose location doesn't resolve is silently skipped by Equinox (no
// error, no effect on any other bundle) — it would only matter if the
// user ran this exact plugin's own application natively, which isn't a
// real workflow. Left in place rather than cleaned up afterward: there's
// no reliable "scoder is done with this install" signal to clean up on,
// and every future scoder launch rewrites this same entry idempotently
// anyway.
async function ensureEclipseBundlesInfo(
	configHostDir: string,
	hostInstallDir: string,
	sandboxJarPath: string,
): Promise<void> {
	const bundlesInfoDir = `${configHostDir}/org.eclipse.equinox.simpleconfigurator`;
	const bundlesInfoPath = `${bundlesInfoDir}/bundles.info`;

	let baseContent: string;
	if (await fileExists(bundlesInfoPath)) {
		baseContent = await Bun.file(bundlesInfoPath).text();
	} else {
		const installDefault = `${hostInstallDir}/configuration/org.eclipse.equinox.simpleconfigurator/bundles.info`;
		if (!(await fileExists(installDefault))) {
			warning(
				"eclipse: no bundles.info found (install or reused config dir) — plugin auto-import will not be available",
			);
			return;
		}
		baseContent = await Bun.file(installDefault).text();
	}

	const ourLine = `${ECLIPSE_JAR_SYMBOLIC_NAME},${ECLIPSE_JAR_BUNDLE_VERSION},file:${sandboxJarPath},4,true`;
	const lines = baseContent
		.split("\n")
		.filter(
			(line) =>
				line.trim() !== "" && !line.startsWith(`${ECLIPSE_JAR_SYMBOLIC_NAME},`),
		);
	lines.push(ourLine);

	await ensureDir(bundlesInfoDir);
	await Bun.write(bundlesInfoPath, `${lines.join("\n")}\n`);
}

// ### verifyEclipseJar
// The vendored jar gets injected into a real Eclipse install's own plugins/
// dir (see the eclipse preset's configBinds) — worth confirming its bytes
// still match the pinned, hand-verified sha256 before trusting it, rather
// than assuming a file at a fixed repo path was never modified or
// corrupted since vendoring.
async function verifyEclipseJar(): Promise<boolean> {
	try {
		const bytes = await Bun.file(ECLIPSE_JAR_PATH).arrayBuffer();
		const digest = createHash("sha256")
			.update(Buffer.from(bytes))
			.digest("hex");
		return digest === ECLIPSE_JAR_SHA256;
	} catch {
		return false;
	}
}

// ### TOOL_PRESETS
// [IMPLEMENTS](/design/features/tool-presets.md)
// EM: Mapping of tool names to preset configurations for sandboxing
export const TOOL_PRESETS: Record<string, ToolPreset> = {
	opencode: {
		description: "OpenCode",

		configBinds: async (realHome, sandboxHome) => {
			const binds: BindMount[] = [];
			const dirs: string[] = [];

			const configDir = `${realHome}/.config/opencode`;
			if (await dirExists(configDir)) {
				dirs.push(`${sandboxHome}/.config/opencode`);
				binds.push({
					type: "ro-bind",
					source: configDir,
					dest: `${sandboxHome}/.config/opencode`,
				});
			}

			const dataDir = `${realHome}/.local/share/opencode`;
			await ensureDir(dataDir);
			dirs.push(`${sandboxHome}/.local/share/opencode`);
			binds.push({
				type: "bind",
				source: dataDir,
				dest: `${sandboxHome}/.local/share/opencode`,
			});

			const cacheDir = `${realHome}/.cache/opencode`;
			await ensureDir(cacheDir);
			dirs.push(`${sandboxHome}/.cache/opencode`);
			binds.push({
				type: "bind",
				source: cacheDir,
				dest: `${sandboxHome}/.cache/opencode`,
			});

			return { binds, dirs };
		},

		validate: async () => {
			const exists = await commandExists("opencode");
			if (!exists) {
				error("opencode not found in PATH");
				error("Install: https://opencode.ai");
				return false;
			}
			return true;
		},
	},

	claude: {
		description: "Claude Code",

		configBinds: async (realHome, sandboxHome) => {
			const binds: BindMount[] = [];
			const dirs: string[] = [];

			// Read-write: Claude Code writes here throughout a session (todos,
			// history, shell snapshots, statsig state). A read-only bind makes it
			// fail in many flows rather than degrade. Note this is a host-visible
			// write path — see design/implementation/debt/rw-config-mounts-limited-escape.md
			const claudeDir = `${realHome}/.claude`;
			if (await dirExists(claudeDir)) {
				dirs.push(`${sandboxHome}/.claude`);
				binds.push({
					type: "bind",
					source: claudeDir,
					dest: `${sandboxHome}/.claude`,
				});
			} else {
				warning("Claude config not found at ~/.claude/");
				warning("Run 'claude' once first to initialize");
			}

			const configClaudeJson = `${realHome}/.claude.json`;
			if (await fileExists(configClaudeJson)) {
				binds.push({
					type: "ro-bind",
					source: configClaudeJson,
					dest: `${sandboxHome}/.claude.json`,
				});
			}

			const configClaudeDir = `${realHome}/.config/claude`;
			if (await dirExists(configClaudeDir)) {
				dirs.push(`${sandboxHome}/.config/claude`);
				binds.push({
					type: "ro-bind",
					source: configClaudeDir,
					dest: `${sandboxHome}/.config/claude`,
				});
			}

			// The native installer puts the versioned binary here and symlinks
			// ~/.local/bin/claude at it. Without this bind that symlink dangles
			// inside the sandbox. Read-only, so the sandbox cannot self-update
			// the host's installation.
			const claudeDataDir = `${realHome}/.local/share/claude`;
			if (await dirExists(claudeDataDir)) {
				dirs.push(`${sandboxHome}/.local/share/claude`);
				binds.push({
					type: "ro-bind",
					source: claudeDataDir,
					dest: `${sandboxHome}/.local/share/claude`,
				});
			}

			return { binds, dirs };
		},

		validate: async () => {
			const claudeExists = await commandExists("claude");
			if (!claudeExists) {
				error("claude not found in PATH");
				error("Install: npm install -g @anthropic-ai/claude-code");
				return false;
			}

			const nodeExists = await commandExists("node");
			if (!nodeExists) {
				error("node not found in PATH (required by Claude Code)");
				return false;
			}

			return true;
		},
	},

	copilot: {
		description: "GitHub Copilot CLI",

		configBinds: async (realHome, sandboxHome) => {
			const binds: BindMount[] = [];
			const dirs: string[] = [];

			const copilotDir = `${realHome}/.config/github-copilot`;
			if (await dirExists(copilotDir)) {
				dirs.push(`${sandboxHome}/.config/github-copilot`);
				binds.push({
					type: "bind",
					source: copilotDir,
					dest: `${sandboxHome}/.config/github-copilot`,
				});
			}

			const copilotHomeDir = `${realHome}/.copilot`;
			if (await dirExists(copilotHomeDir)) {
				dirs.push(`${sandboxHome}/.copilot`);
				binds.push({
					type: "bind",
					source: copilotHomeDir,
					dest: `${sandboxHome}/.copilot`,
				});
			}

			const copilotCacheDir = `${realHome}/.cache/copilot`;
			if (await dirExists(copilotCacheDir)) {
				dirs.push(`${sandboxHome}/.cache/copilot`);
				binds.push({
					type: "bind",
					source: copilotCacheDir,
					dest: `${sandboxHome}/.cache/copilot`,
				});
			}

			const dataDir = `${realHome}/.local/share/github-copilot`;
			await ensureDir(dataDir);
			dirs.push(`${sandboxHome}/.local/share/github-copilot`);
			binds.push({
				type: "bind",
				source: dataDir,
				dest: `${sandboxHome}/.local/share/github-copilot`,
			});

			return { binds, dirs };
		},

		validate: async () => {
			const copilotExists = await commandExists("copilot");
			if (!copilotExists) {
				error("copilot not found in PATH");
				error("Install: npm install -g @github/copilot");
				error("    or:  brew install copilot-cli");
				return false;
			}

			const nodeExists = await commandExists("node");
			if (!nodeExists) {
				error("node not found in PATH (required by Copilot CLI)");
				return false;
			}

			return true;
		},
	},

	pi: {
		description: "Pi Coding Agent",

		configBinds: piConfigBinds,

		validate: async () => {
			const piExists = await commandExists("pi");
			if (!piExists) {
				error("pi not found in PATH");
				error("Install: https://pi.dev");
				return false;
			}
			return true;
		},
	},

	rstudio: {
		description: "RStudio Desktop",

		configBinds: async (realHome, sandboxHome) => {
			const binds: BindMount[] = [];
			const dirs: string[] = [];
			const env: Record<string, string> = {};

			// EM: RStudio Desktop is a GUI app — it needs a live connection to
			// EM: the host's X server. Verified directly (see
			// EM: architecture/decision-records/0002-rstudio-x11-access.md): an empty
			// EM: --tmpfs /tmp sandbox has no /tmp/.X11-unix at all, and a
			// EM: client fails with "unable to open display" until this socket
			// EM: directory is bound in and DISPLAY is set; if the host X
			// EM: session uses cookie-based auth (the common case for a real
			// EM: desktop session), XAUTHORITY and its backing file are needed
			// EM: too, or the client is refused with "Authorization required,
			// EM: but no authorization protocol specified".
			// EM:
			// EM: This is a deliberate, accepted relaxation of the sandbox's
			// EM: isolation, not an oversight: exposing the host's real X11
			// EM: socket gives anything inside the sandbox the same access any
			// EM: of the user's own desktop apps have to that X display,
			// EM: including XTEST-based synthetic input injection into other
			// EM: windows on it — verified directly to NOT be blocked by
			// EM: X11's own "untrusted" auth mechanism (the same one `ssh -X`
			// EM: relies on), so it is not a mitigation to lean on. Accepted
			// EM: because the threat model here is accidents, not a dedicated
			// EM: adversary — a VM or container is the right answer for the
			// EM: latter, and is deliberately not what this is.
			if (await dirExists("/tmp/.X11-unix")) {
				binds.push({
					type: "ro-bind",
					source: "/tmp/.X11-unix",
					dest: "/tmp/.X11-unix",
				});
			}

			if (process.env.DISPLAY) {
				env.DISPLAY = process.env.DISPLAY;
			}

			// EM: Reported: most menu items greyed out except cut/copy/paste,
			// EM: and only the window manager's own close button quits RStudio.
			// EM: RStudio Desktop is Electron/Chromium-based (confirmed by the
			// EM: "ozone/platform/x11" string in the original X11 error), and
			// EM: Electron apps on Linux commonly use D-Bus / xdg-desktop-portal
			// EM: for native file dialogs, single-instance activation, and
			// EM: session/quit integration — degrading rather than crashing when
			// EM: unavailable, which matches the symptom. Passing these through
			// EM: is a reasonable, well-motivated fix, not a verified one: this
			// EM: project has no real RStudio Desktop install or desktop D-Bus
			// EM: session to confirm it against directly, unlike the X11
			// EM: mechanics above. No extra bind needed for the socket itself —
			// EM: confirmed directly that bwrap's --ro-bind recurses into a
			// EM: nested mount stacked on its source (built one and tested it),
			// EM: so /run/user/<uid> — a separate tmpfs on a real systemd-managed
			// EM: desktop — is already reachable through the existing wholesale
			// EM: --ro-bind /run /run once these env vars tell RStudio where to
			// EM: look.
			if (process.env.XDG_RUNTIME_DIR) {
				env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
			}
			if (process.env.DBUS_SESSION_BUS_ADDRESS) {
				env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
			}

			// EM: Reported: mcptools::mcp_session() (bridging RStudio's R console
			// EM: to pi, e.g. via --ide) fails with "Socket directory
			// EM: /run/user/<uid>/mcptools is a symlink; refusing to use it."
			// EM: mcptools defaults its socket dir to $XDG_RUNTIME_DIR/mcptools —
			// EM: /run/user/<uid> — which is read-only inside the sandbox
			// EM: (--ro-bind, not --bind) regardless of what's already there on
			// EM: the host: even with nothing at that path at all, mcptools'
			// EM: own mkdir() would still fail there. Unconditional, not
			// EM: gated on any host env var: this is a fixed, always-writable
			// EM: location inside the sandbox (a fresh --tmpfs /tmp), not a
			// EM: value passed through from the host, and it is set once here
			// EM: for the whole sandbox — RStudio and pi (and anything pi
			// EM: spawns, e.g. its own MCP server child process) all inherit
			// EM: this same bwrap-level --setenv, whether pi is the primary
			// EM: tool or rstudio is --ide's companion. Harmless if mcptools
			// EM: is never used at all — an unused env var pointing at an
			// EM: always-writable path. No new bind needed: mcptools creates
			// EM: the directory itself (dir.create(..., recursive = TRUE)) the
			// EM: first time either side needs it.
			env.MCPTOOLS_SOCKET_DIR = "/tmp/mcptools";

			const xauthPath = process.env.XAUTHORITY || `${realHome}/.Xauthority`;
			if (await fileExists(xauthPath)) {
				const sandboxXauthPath = `${sandboxHome}/.Xauthority`;
				binds.push({
					type: "ro-bind",
					source: xauthPath,
					dest: sandboxXauthPath,
				});
				env.XAUTHORITY = sandboxXauthPath;
			}

			// RStudio writes here throughout a session (preferences, recent
			// files, environment/history state) — same reasoning as Claude
			// Code's primary .claude dir: a read-only bind makes it fail or
			// silently lose state rather than degrade gracefully. Created if
			// missing rather than warn-and-skip (unlike Claude's ~/.claude):
			// RStudio's first run in practice *is* this sandboxed session,
			// there is no meaningful "run it natively first" step to ask for.
			const configDir = `${realHome}/.config/rstudio`;
			await ensureDir(configDir);
			dirs.push(`${sandboxHome}/.config/rstudio`);
			binds.push({
				type: "bind",
				source: configDir,
				dest: `${sandboxHome}/.config/rstudio`,
			});

			const dataDir = `${realHome}/.local/share/rstudio`;
			await ensureDir(dataDir);
			dirs.push(`${sandboxHome}/.local/share/rstudio`);
			binds.push({
				type: "bind",
				source: dataDir,
				dest: `${sandboxHome}/.local/share/rstudio`,
			});

			// pi runs inside RStudio's own embedded terminal — give it the
			// exact same config/data/cache access it gets as scoder's own
			// top-level tool, not a separate, drifting copy of the same list.
			const piBindSpec = await piConfigBinds(realHome, sandboxHome);
			binds.push(...piBindSpec.binds);
			dirs.push(...piBindSpec.dirs);

			return { binds, dirs, env };
		},

		validate: async () => {
			const exists = await commandExists("rstudio");
			if (!exists) {
				error("rstudio not found in PATH");
				error("Install: https://posit.co/download/rstudio-desktop/");
				return false;
			}
			return true;
		},

		// EM: RStudio Desktop does not inherit the launching process's cwd for
		// EM: its initial R session — with no argument it reopens whatever
		// EM: project it last had open, or falls back to $HOME, which in a
		// EM: fresh sandbox is always the case. Passing a .Rproj file
		// EM: explicitly is RStudio's own documented, reliable way to choose a
		// EM: project. A bare directory argument is also documented to work
		// EM: as a fallback when there's no .Rproj — used here, but not
		// EM: independently verified against a real RStudio Desktop install
		// EM: in this project, unlike the X11 mechanics in configBinds above.
		// EM: An explicit argument from the user always wins outright — this
		// EM: only fills in a default when there isn't one, unlike eclipse's
		// EM: own resolveArgs, which always prepends its fixed flags.
		resolveArgs: async (hostProjectDir, sandboxProjectDir, existingArgs) => {
			if (existingArgs.length > 0) {
				return existingArgs;
			}

			let entries: string[];
			try {
				entries = await readdir(hostProjectDir);
			} catch {
				return [sandboxProjectDir];
			}

			const rprojFiles = entries
				.filter((name) => name.endsWith(".Rproj"))
				.sort();

			if (rprojFiles.length === 0) {
				return [sandboxProjectDir];
			}
			if (rprojFiles.length > 1) {
				warning(
					`Multiple .Rproj files found in ${hostProjectDir}; using ${rprojFiles[0]}`,
				);
			}
			return [`${sandboxProjectDir}/${rprojFiles[0]}`];
		},
	},

	eclipse: {
		description: "Eclipse IDE",

		configBinds: async (realHome, sandboxHome) => {
			const binds: BindMount[] = [];
			const dirs: string[] = [];
			const env: Record<string, string> = {};

			// EM: Eclipse's UI is SWT/GTK, not Electron — the same class of
			// EM: X11-needing desktop app as rstudio (see
			// EM: architecture/decision-records/0002-rstudio-x11-access.md for
			// EM: the verified X11-socket/XAUTHORITY mechanics this mirrors),
			// EM: but NOT independently re-verified for Eclipse specifically:
			// EM: this project has no host with GTK installed and a real X
			// EM: session to confirm it against. See Design Decision 3 in
			// EM: eclipse-preset.md.
			if (await dirExists("/tmp/.X11-unix")) {
				binds.push({
					type: "ro-bind",
					source: "/tmp/.X11-unix",
					dest: "/tmp/.X11-unix",
				});
			}

			if (process.env.DISPLAY) {
				env.DISPLAY = process.env.DISPLAY;
			}
			if (process.env.XDG_RUNTIME_DIR) {
				env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
			}
			if (process.env.DBUS_SESSION_BUS_ADDRESS) {
				env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
			}

			const xauthPath = process.env.XAUTHORITY || `${realHome}/.Xauthority`;
			if (await fileExists(xauthPath)) {
				const sandboxXauthPath = `${sandboxHome}/.Xauthority`;
				binds.push({
					type: "ro-bind",
					source: xauthPath,
					dest: sandboxXauthPath,
				});
				env.XAUTHORITY = sandboxXauthPath;
			}

			const layout = await resolveEclipseLayout(process.cwd());
			if (!layout) {
				warning("eclipse install not found — workspace/config binds skipped");
				return { binds, dirs, env };
			}

			// EM: Whole install dir, defensively, read-only — in case it
			// EM: isn't already covered by builder.ts's own wholesale /opt
			// EM: bind (e.g. an install extracted directly under $HOME).
			// EM: Harmless overlap when it already is covered: a repeated
			// EM: mount over the same path is a no-op to bwrap.
			binds.push({
				type: "ro-bind",
				source: layout.hostInstallDir,
				dest: layout.sandboxInstallDir,
			});

			// EM: The vendored plugin jar, bound read-only at a fixed sandbox
			// EM: path that's always freely creatable (under /home/scoder,
			// EM: fresh tmpfs — never under any wholesale read-only system
			// EM: bind) — NOT injected into the install's own plugins/ dir,
			// EM: which genuinely cannot work: see ensureEclipseBundlesInfo's
			// EM: own comment for why, and what registers it with Equinox
			// EM: instead. Its sha256 is re-checked in validate()
			// EM: (verifyEclipseJar) — see assets/eclipse/PROVENANCE.md.
			const sandboxJarPath = `${sandboxHome}/.local/share/scoder-eclipse-plugin/${ECLIPSE_JAR_NAME}`;
			pushIntermediateDirs(
				dirs,
				sandboxHome,
				".local/share/scoder-eclipse-plugin",
			);
			binds.push({
				type: "ro-bind",
				source: ECLIPSE_JAR_PATH,
				dest: sandboxJarPath,
			});
			await ensureEclipseBundlesInfo(
				layout.configHostDir,
				layout.hostInstallDir,
				sandboxJarPath,
			);

			const projDir = await getProjDir(process.cwd());
			pushIntermediateDirs(
				dirs,
				sandboxHome,
				`.local/share/scoder-eclipse-workspaces/${projDir}`,
			);
			binds.push({
				type: "bind",
				source: layout.workspaceHostDir,
				dest: layout.workspaceSandboxDir,
			});

			if (layout.reuseHostConfig) {
				pushIntermediateDirs(
					dirs,
					sandboxHome,
					layout.configHostDir.slice(realHome.length + 1),
				);
			} else {
				const hashPart = layout.configHostDir.split("/").pop() ?? "";
				pushIntermediateDirs(
					dirs,
					sandboxHome,
					`.local/share/scoder-eclipse-config/${hashPart}`,
				);
			}
			binds.push({
				type: "bind",
				source: layout.configHostDir,
				dest: layout.configSandboxDir,
			});

			return { binds, dirs, env };
		},

		// EM: The unconditional, every-launch pre-launch step that makes the
		// EM: dynamic workspace generation work — see Design points 4/5 in
		// EM: eclipse-preset.md. Idempotent by construction (the plugin's own
		// EM: project.isOpen() branch), so re-running this on every launch,
		// EM: against the same persisted workspace, is safe.
		prepareCommand: async (
			hostProjectDir,
			sandboxProjectDir,
			dependencyDirs,
		) => {
			const layout = await resolveEclipseLayout(hostProjectDir);
			if (!layout) {
				error("eclipse install could not be located for the prepare step");
				return null;
			}

			const args = [
				"-nosplash",
				"-clean",
				...eclipseConfigArgs(layout),
				"-application",
				"com.seeq.eclipse.importprojects.headlessimport",
				"-data",
				layout.workspaceSandboxDir,
				"-import",
				sandboxProjectDir,
				...dependencyDirs.flatMap((dir) => ["-import", dir]),
			];

			return { bin: layout.sandboxEclipseBin, args };
		},

		// EM: Unlike rstudio's own resolveArgs, these flags are always
		// EM: prepended, whatever the user passed — the workspace/config
		// EM: paths are intrinsically tied to project identity, not
		// EM: something a user would reasonably want to override. See
		// EM: Design point 6 in eclipse-preset.md.
		resolveArgs: async (hostProjectDir, _sandboxProjectDir, existingArgs) => {
			const layout = await resolveEclipseLayout(hostProjectDir);
			if (!layout) {
				return existingArgs;
			}

			return [
				...eclipseConfigArgs(layout),
				"-data",
				layout.workspaceSandboxDir,
				...existingArgs,
			];
		},

		validate: async () => {
			const exists = await commandExists("eclipse");
			if (!exists) {
				error("eclipse not found in PATH");
				error("Install: https://www.eclipse.org/downloads/");
				return false;
			}

			// EM: The vendored jar gets injected into the (otherwise
			// EM: untouched) install's own plugins/ dir — worth checking its
			// EM: integrity against the pinned sha256 on every run, not just
			// EM: trusting whatever happens to be on disk at that path. See
			// EM: assets/eclipse/PROVENANCE.md.
			if (!(await verifyEclipseJar())) {
				error(`vendored ${ECLIPSE_JAR_NAME} is missing or does not match`);
				error(`its expected sha256 (${ECLIPSE_JAR_SHA256})`);
				return false;
			}

			return true;
		},
	},
};

// ### piConfigBinds
// Shared between the `pi` preset and `rstudio` (pi runs inside RStudio's
// embedded terminal, and needs the identical access it would get as
// scoder's own top-level tool — see the rstudio preset above).
async function piConfigBinds(
	realHome: string,
	sandboxHome: string,
): Promise<ToolBindSpec> {
	const binds: BindMount[] = [];
	const dirs: string[] = [];

	const piDir = `${realHome}/.pi/agent`;
	if (await dirExists(piDir)) {
		dirs.push(`${sandboxHome}/.pi/agent`);
		binds.push({
			type: "bind",
			source: piDir,
			dest: `${sandboxHome}/.pi/agent`,
		});
	}

	const dataDir = `${realHome}/.local/share/pi`;
	await ensureDir(dataDir);
	dirs.push(`${sandboxHome}/.local/share/pi`);
	binds.push({
		type: "bind",
		source: dataDir,
		dest: `${sandboxHome}/.local/share/pi`,
	});

	const cacheDir = `${realHome}/.cache/pi`;
	await ensureDir(cacheDir);
	dirs.push(`${sandboxHome}/.cache/pi`);
	binds.push({
		type: "bind",
		source: cacheDir,
		dest: `${sandboxHome}/.cache/pi`,
	});

	return { binds, dirs };
}

async function resolveCommandPath(cmd: string): Promise<string | null> {
	try {
		const proc = await Bun.spawn(["which", cmd], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		if (proc.exitCode !== 0) {
			return null;
		}
		const out = (await new Response(proc.stdout).text()).trim();
		return out || null;
	} catch {
		return null;
	}
}

async function commandExists(cmd: string): Promise<boolean> {
	return (await resolveCommandPath(cmd)) !== null;
}
