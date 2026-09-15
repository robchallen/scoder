import { readdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { getProjDir } from "../git/worktree.ts";
import type { BindMount, ToolBindSpec, ToolPreset } from "../types.ts";
import { error, warning } from "../utils/logger.ts";
import {
	getRealHome,
	isUnderAny,
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
// EM: investigation, including a since-superseded approach (vendoring the
// EM: import-projects plugin jar and registering it via a scoder-private
// EM: bundles.info) that this was simplified away from once a proper p2
// EM: update site existed: the plugin is now a prerequisite the user
// EM: installs into their own Eclipse once, the same way any other
// EM: Eclipse feature is installed — scoder no longer vendors, binds, or
// EM: registers anything plugin-related at all. Kept together, ahead of
// EM: TOOL_PRESETS, since configBinds/prepareCommand/resolveArgs all need
// EM: the exact same computed layout and must never disagree with each
// EM: other about it.

// EM: The sandbox path an optional, project-supplied .eclipse.epf
// EM: (exported Eclipse preferences) is bound at — a fixed,
// EM: always-creatable location directly under /home/scoder/.local/share
// EM: (no extra --dir scaffolding needed: builder.ts's own fixed --dir
// EM: list already includes that directory). prepareCommand doesn't
// EM: receive sandboxHome as a parameter (unlike configBinds), so this is
// EM: hardcoded the same way builder.ts/index.ts already hardcode
// EM: SCODER_HOME, not derived per-call.
const ECLIPSE_SANDBOX_EPF_PATH = "/home/scoder/.local/share/scoder-eclipse.epf";

interface EclipseLayout {
	sandboxEclipseBin: string;
	hostInstallDir: string;
	sandboxInstallDir: string;
	// EM: Whether the install lives under $HOME — decides read-write vs.
	// EM: read-only for the install-dir bind (see configBinds) and whether
	// EM: it needs pushIntermediateDirs' --dir scaffolding at all.
	installUnderHome: boolean;
	workspaceHostDir: string;
	workspaceSandboxDir: string;
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
	const installUnderHome = isUnderAny(hostInstallDir, [realHome]);

	const projDir = await getProjDir(hostProjectDir);
	const workspaceHostDir = `${realHome}/.local/share/scoder-eclipse-workspaces/${projDir}`;
	await ensureDir(workspaceHostDir);
	const workspaceSandboxDir = toSandboxPath(workspaceHostDir, homePrefixes);

	return {
		sandboxEclipseBin,
		hostInstallDir,
		sandboxInstallDir,
		installUnderHome,
		workspaceHostDir,
		workspaceSandboxDir,
	};
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

		// EM: Requires the seeq12/eclipse-import-projects-plugin fork at
		// EM: https://github.com/robchallen/eclipse-import-projects-plugin
		// EM: (>= 2.0.0) to already be installed into the host Eclipse from
		// EM: its own p2 update site — scoder does not vendor, inject, or
		// EM: otherwise manage the plugin itself. See
		// EM: design/implementation/plans/eclipse-preset.md for why an
		// EM: earlier version tried to and what that cost.
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
				warning("eclipse install not found — workspace/install binds skipped");
				return { binds, dirs, env };
			}

			// EM: The install directory itself: read-write when it lives
			// EM: under $HOME (a personal install the user's own account
			// EM: already owns — Eclipse may need to write there, e.g. p2
			// EM: profile updates), read-only otherwise. The read-only case
			// EM: is defensive, not load-bearing in the common case: a
			// EM: system install under /opt or /usr is already covered by
			// EM: builder.ts's own wholesale binds, so this is a harmless
			// EM: repeat mount — it only matters for an install somewhere
			// EM: else read-only binds don't already reach.
			binds.push({
				type: layout.installUnderHome ? "bind" : "ro-bind",
				source: layout.hostInstallDir,
				dest: layout.sandboxInstallDir,
			});
			if (layout.installUnderHome) {
				pushIntermediateDirs(
					dirs,
					sandboxHome,
					layout.hostInstallDir.slice(realHome.length + 1),
				);
			}

			// EM: $HOME/.eclipse: Equinox's own per-user state, including
			// EM: instance preferences and (per-install, hash-named
			// EM: subdirectories under it) its own runtime configuration
			// EM: area when the install itself isn't directly writable —
			// EM: see "The ~/.eclipse/<hash> fallback" in
			// EM: eclipse-preset.md. Bound whole, read-write, if it exists,
			// EM: rather than computing which specific hash-named
			// EM: subdirectory matters or reconstructing Equinox's own
			// EM: resolution ourselves: at its own identically-mapped path,
			// EM: Eclipse's own default resolution finds whatever it would
			// EM: natively, with no explicit -configuration flag needed.
			const eclipseUserDir = `${realHome}/.eclipse`;
			if (await dirExists(eclipseUserDir)) {
				pushIntermediateDirs(dirs, sandboxHome, ".eclipse");
				binds.push({
					type: "bind",
					source: eclipseUserDir,
					dest: `${sandboxHome}/.eclipse`,
				});
			}

			// EM: A persisted, project-scoped workspace — see Design
			// EM: point 3 in eclipse-preset.md.
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

			// EM: An optional, project-supplied Eclipse preferences export
			// EM: (exported via File > Export > Preferences natively),
			// EM: imported via -importPreferences (see prepareCommand).
			// EM: Bound read-only at its own fixed sandbox path — not left
			// EM: at its in-project path, which would inherit the rest of
			// EM: the project tree's read-write bind.
			const epfHostPath = `${process.cwd()}/.eclipse.epf`;
			if (await fileExists(epfHostPath)) {
				binds.push({
					type: "ro-bind",
					source: epfHostPath,
					dest: ECLIPSE_SANDBOX_EPF_PATH,
				});
			}

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

			// EM: Recomputed independently here (same fileExists check
			// EM: configBinds already made) so this never passes
			// EM: -importPreferences a path that was never bound — mirrors
			// EM: how resolveEclipseLayout itself is independently
			// EM: recomputed by every hook rather than threaded through as
			// EM: shared state.
			const hasEpf = await fileExists(`${hostProjectDir}/.eclipse.epf`);

			const args = [
				"-nosplash",
				"-clean",
				"-application",
				"com.seeq.eclipse.importprojects.headlessimport",
				"-data",
				layout.workspaceSandboxDir,
				"-importProject",
				sandboxProjectDir,
				...dependencyDirs.flatMap((dir) => ["-importProject", dir]),
				...(hasEpf ? ["-importPreferences", ECLIPSE_SANDBOX_EPF_PATH] : []),
			];

			return { bin: layout.sandboxEclipseBin, args };
		},

		// EM: Unlike rstudio's own resolveArgs, -data is always prepended,
		// EM: whatever the user passed — the workspace path is intrinsically
		// EM: tied to project identity, not something a user would
		// EM: reasonably want to override. See Design point 6 in
		// EM: eclipse-preset.md.
		resolveArgs: async (hostProjectDir, _sandboxProjectDir, existingArgs) => {
			const layout = await resolveEclipseLayout(hostProjectDir);
			if (!layout) {
				return existingArgs;
			}

			return ["-data", layout.workspaceSandboxDir, ...existingArgs];
		},

		validate: async () => {
			const exists = await commandExists("eclipse");
			if (!exists) {
				error("eclipse not found in PATH");
				error("Install: https://www.eclipse.org/downloads/");
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
