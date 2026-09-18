import { readdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { getProjDir } from "../git/worktree.ts";
import type { BindMount, ToolBindSpec, ToolPreset } from "../types.ts";
import { error, info, warning } from "../utils/logger.ts";
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

// ### guiX11Binds
// Shared between `rstudio` and `eclipse` — both are GUI apps needing a live
// connection to the host's X server (see
// architecture/decision-records/0002-rstudio-x11-access.md for the
// verified X11-socket/XAUTHORITY mechanics this covers; Design Decision 3
// in eclipse-preset.md applies the same access to Eclipse by direct
// analogy, not independently re-verified there). A deliberate, accepted
// relaxation of the sandbox's isolation, not an oversight — see that ADR
// for the full trade-off.
async function guiX11Binds(
	realHome: string,
	sandboxHome: string,
): Promise<ToolBindSpec> {
	const binds: BindMount[] = [];
	const dirs: string[] = [];
	const env: Record<string, string> = {};

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

	// EM: GPU render nodes. Reported directly: RStudio Desktop (Electron/
	// EM: Chromium) showed a white window then crashed with SIGILL
	// EM: ("Illegal instruction (core dumped)") after /dev was narrowed
	// EM: from a wholesale --dev-bind /dev /dev (which included /dev/dri
	// EM: incidentally, along with everything else) down to a short,
	// EM: explicit list of real device nodes that never included it —
	// EM: see design/features/sandbox-isolation.md's "History" for that
	// EM: change. Chromium's GPU process, unable to open a DRM render
	// EM: node, hits an internal CHECK()/NOTREACHED() failure rather than
	// EM: falling back to software rendering cleanly — release Chromium
	// EM: compiles a failed CHECK to a hardware trap instruction, which
	// EM: the OS reports as exactly this signal, not a graceful error
	// EM: message. `dev-bind`, not `ro-bind`: bwrap only grants actual
	// EM: device-node access through `--dev-bind` ("allowing device
	// EM: access", per its own --help text) — a plain bind mount does
	// EM: not. Gated on the node existing on the host, same as the X11
	// EM: socket above: a host with no GPU at all (or only a proprietary
	// EM: NVIDIA driver, whose separate /dev/nvidia* nodes this does not
	// EM: cover) has no /dev/dri to bind, and this preset cannot help
	// EM: that — Chromium is expected to fall back to software rendering
	// EM: in that case instead, not crash, since the difference between
	// EM: "no GPU at all" and "GPU present but access denied" is exactly
	// EM: what this fix targets.
	if (await dirExists("/dev/dri")) {
		binds.push({
			type: "dev-bind",
			source: "/dev/dri",
			dest: "/dev/dri",
		});
	}

	return { binds, dirs, env };
}

// EM: ### Eclipse preset support
// EM: See design/implementation/plans/eclipse-preset.md for the full
// EM: investigation, including a since-superseded approach (vendoring the
// EM: import-projects plugin jar, registering it via a scoder-private
// EM: bundles.info, and running its import as a separate headless
// EM: pre-launch stage) that this was simplified away from: the plugin is
// EM: now a prerequisite the user installs into their own Eclipse once,
// EM: the same way any other Eclipse feature is installed, and its own
// EM: -importProject/-importPreferences flags work directly on the normal
// EM: interactive launch (confirmed from the plugin's own current
// EM: README) — no separate headless stage needed at all. Kept together,
// EM: ahead of TOOL_PRESETS, since configBinds/resolveArgs both need the
// EM: exact same computed layout and must never disagree with each other
// EM: about it.

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

// ### findEclipseUiIdePrefs
// Locates org.eclipse.ui.ide.prefs, wherever Equinox's own default
// configuration-dir resolution actually put it. Deliberately not computed
// the way configBinds' own install-dir resolution is — replicating
// Equinox's exact hash-named-directory logic cost six rounds of bugs the
// first time this preset tried it (see "History" in eclipse-preset.md) —
// checked instead: the install dir's own configuration/ first (Equinox's
// own first choice when writable), then a glob under ~/.eclipse/*/configuration/
// for the hash-named fallback, whichever hash it actually used.
async function findEclipseUiIdePrefs(
	hostInstallDir: string,
	realHome: string,
): Promise<string | null> {
	const installCandidate = `${hostInstallDir}/configuration/.settings/org.eclipse.ui.ide.prefs`;
	if (await fileExists(installCandidate)) {
		return installCandidate;
	}

	const eclipseDir = `${realHome}/.eclipse`;
	if (!(await dirExists(eclipseDir))) {
		return null;
	}

	const proc = Bun.spawn(
		[
			"find",
			eclipseDir,
			"-maxdepth",
			"4",
			"-path",
			"*/configuration/.settings/org.eclipse.ui.ide.prefs",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	await proc.exited;
	if (proc.exitCode !== 0) {
		return null;
	}

	const output = await new Response(proc.stdout).text();
	const [first] = output.split("\n").filter(Boolean);
	return first ?? null;
}

// EM: Scoder's own managed-workspaces root — excluded when picking a
// EM: RECENT_WORKSPACES entry, see findMostRecentEclipseWorkspace.
const SCODER_ECLIPSE_WORKSPACES_DIRNAME = "scoder-eclipse-workspaces";

// ### findMostRecentEclipseWorkspace
// Reads RECENT_WORKSPACES from org.eclipse.ui.ide.prefs (Java Properties
// format — multiple workspace paths in one value, `\n`-escaped, most
// recent first) and returns the first entry that isn't itself one of
// scoder's own managed workspaces. Deliberately no project-matching
// against the other entries (e.g. searching each workspace's own
// .../.projects/<name>/.location for this project) — picking the most
// recently used *real* workspace, no other logic, was preferred over that
// complexity. The scoder-managed exclusion isn't project-matching, just a
// structural guard: ~/.eclipse is bound read-write at its own real path
// (see path-mirroring), so Eclipse running *inside* a previous scoder
// session already wrote its own workspace to the front of this same list —
// without excluding it, seeding a second project would silently copy from
// a first project's scoder workspace instead of the user's actual one, and
// each new project would drift further from it. Not independently verified
// against a real Eclipse install — this project has none — but this is
// Eclipse's own documented preference key and format.
async function findMostRecentEclipseWorkspace(
	hostInstallDir: string,
	realHome: string,
): Promise<string | null> {
	const prefsPath = await findEclipseUiIdePrefs(hostInstallDir, realHome);
	if (!prefsPath) {
		return null;
	}

	const content = await Bun.file(prefsPath).text();
	for (const line of content.split("\n")) {
		if (!line.startsWith("RECENT_WORKSPACES=")) {
			continue;
		}
		const value = line.slice("RECENT_WORKSPACES=".length).trim();
		const entries = value.split("\\n").filter(Boolean);
		return (
			entries.find(
				(entry) => !entry.includes(`/${SCODER_ECLIPSE_WORKSPACES_DIRNAME}/`),
			) ?? null
		);
	}

	return null;
}

// ### seedWorkspaceSettingsFromHost
// Copies every .metadata/.plugins/<plugin>/.settings/ directory from the
// user's own native workspace into the fresh scoder-managed one — whole
// directories, not a hand-picked plugin list, same reasoning as binding
// ~/.eclipse whole rather than one specific subdirectory. This preserves
// normal Eclipse preference-resolution semantics (an unset key still falls
// through to DefaultScope), unlike the earlier -importPreferences/
// .eclipse.epf mechanism, which required a full GUI restart and, confirmed
// directly, did not populate defaults for keys the export never wrote —
// see "History" in eclipse-preset.md. Only ever called once, from
// resolveEclipseLayout, the first time a project's own workspace directory
// is created — never overwrites, so preference edits made inside the
// sandbox afterward survive the next launch.
async function seedWorkspaceSettingsFromHost(
	hostWorkspaceDir: string,
	workspaceHostDir: string,
): Promise<void> {
	const pluginsDir = `${hostWorkspaceDir}/.metadata/.plugins`;
	if (!(await dirExists(pluginsDir))) {
		return;
	}

	const proc = Bun.spawn(
		[
			"find",
			pluginsDir,
			"-mindepth",
			"2",
			"-maxdepth",
			"2",
			"-type",
			"d",
			"-name",
			".settings",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	await proc.exited;
	if (proc.exitCode !== 0) {
		return;
	}

	const output = await new Response(proc.stdout).text();
	const settingsDirs = output.split("\n").filter(Boolean);

	for (const src of settingsDirs) {
		const pluginId = dirname(src).slice(pluginsDir.length + 1);
		const dest = `${workspaceHostDir}/.metadata/.plugins/${pluginId}/.settings`;
		await ensureDir(dest);
		await Bun.spawn(["cp", "-r", `${src}/.`, dest]).exited;
	}

	if (settingsDirs.length > 0) {
		info(`Seeded workspace preferences from ${hostWorkspaceDir}`);
	}
}

// ### resolveEclipseLayout
// Computes every path the eclipse preset's two hooks (configBinds,
// resolveArgs) need to agree on. Called independently from each of them
// rather than threaded through as shared state — ToolPreset's hooks are
// plain functions with no shared closure over per-launch state — but
// every input is either fixed (the host's own filesystem) or derived
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
	const workspaceHostDir = `${realHome}/.local/share/${SCODER_ECLIPSE_WORKSPACES_DIRNAME}/${projDir}`;
	const workspaceIsNew = !(await dirExists(workspaceHostDir));
	await ensureDir(workspaceHostDir);
	if (workspaceIsNew) {
		const hostWorkspaceDir = await findMostRecentEclipseWorkspace(
			hostInstallDir,
			realHome,
		);
		if (hostWorkspaceDir) {
			await seedWorkspaceSettingsFromHost(hostWorkspaceDir, workspaceHostDir);
		}
	}
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

		// EM: Measured directly against a running RStudio Desktop: SIGTERM to
		// EM: the main process does not close it, while SIGHUP, SIGINT and
		// EM: SIGUSR1 all do, cleanly. SIGHUP is the one picked — "the terminal
		// EM: this was attached to has gone away" is exactly what has happened,
		// EM: and unlike SIGINT it carries no risk of being read as "interrupt
		// EM: the running computation" by anything downstream.
		// EM:
		// EM: process-first, not children-first: rsession (the R session
		// EM: itself) is a direct child of the main process, so signalling
		// EM: children first killed the user's R session and left the IDE
		// EM: standing — also confirmed directly. RStudio shuts its own
		// EM: rsession down when it closes.
		ideShutdown: { signal: "HUP", order: "process-first" },

		configBinds: async (realHome, sandboxHome) => {
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
			// EM: latter, and is deliberately not what this is. See
			// EM: guiX11Binds for the shared X11/XAUTHORITY/DRI mechanics.
			const x11 = await guiX11Binds(realHome, sandboxHome);
			const binds: BindMount[] = [...x11.binds];
			const dirs: string[] = [...x11.dirs];
			const env: Record<string, string> = { ...x11.env };

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
			// EM: look. (XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS themselves
			// EM: already come from guiX11Binds above.)
			//
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
		resolveArgs: async (
			hostProjectDir,
			sandboxProjectDir,
			existingArgs,
			_dependencyDirs,
		) => {
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

		// EM: The default, stated explicitly because it is the opposite of
		// EM: rstudio's above and both were measured, not assumed: Eclipse
		// EM: closes on SIGTERM to the JVM, which is a child of the thin
		// EM: /opt/eclipse/eclipse launcher that is IDE_PID — signalling only
		// EM: the launcher orphans the JVM and leaves the window up. SIGHUP,
		// EM: SIGINT and SIGUSR1 do not close Eclipse at all.
		ideShutdown: { signal: "TERM", order: "children-first" },

		// EM: Requires the seeq12/eclipse-import-projects-plugin fork at
		// EM: https://github.com/robchallen/eclipse-import-projects-plugin
		// EM: (>= 2.0.0) to already be installed into the host Eclipse from
		// EM: its own p2 update site — scoder does not vendor, inject, or
		// EM: otherwise manage the plugin itself. See
		// EM: design/implementation/plans/eclipse-preset.md for why an
		// EM: earlier version tried to and what that cost.
		configBinds: async (realHome, sandboxHome) => {
			// EM: Eclipse's UI is SWT/GTK, not Electron — the same class of
			// EM: X11-needing desktop app as rstudio (see
			// EM: architecture/decision-records/0002-rstudio-x11-access.md for
			// EM: the verified X11-socket/XAUTHORITY mechanics this mirrors),
			// EM: but NOT independently re-verified for Eclipse specifically:
			// EM: this project has no host with GTK installed and a real X
			// EM: session to confirm it against. See Design Decision 3 in
			// EM: eclipse-preset.md, and guiX11Binds for the shared
			// EM: X11/XAUTHORITY/DRI mechanics.
			const x11 = await guiX11Binds(realHome, sandboxHome);
			const binds: BindMount[] = [...x11.binds];
			const dirs: string[] = [...x11.dirs];
			const env: Record<string, string> = { ...x11.env };

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
			if (layout.installUnderHome) {
				pushIntermediateDirs(
					dirs,
					sandboxHome,
					layout.sandboxInstallDir.slice(sandboxHome.length + 1),
				);
				binds.push({
					type: "bind",
					source: layout.hostInstallDir,
					dest: layout.sandboxInstallDir,
				});
			} else {
				binds.push({
					type: "ro-bind",
					source: layout.hostInstallDir,
					dest: layout.sandboxInstallDir,
				});
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
			// EM: This directory's own p2 profile registry records its
			// EM: bundle pool location as an absolute host path — a real
			// EM: bug back when scoder's $HOME was a separate /home/scoder
			// EM: namespace and needed a second, dual-path bind to also
			// EM: expose the directory at its own real location; now that
			// EM: the sandbox's $HOME is the real host $HOME, this one bind
			// EM: already resolves both. See eclipse-preset.md's "History".
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
				`.local/share/${SCODER_ECLIPSE_WORKSPACES_DIRNAME}/${projDir}`,
			);
			binds.push({
				type: "bind",
				source: layout.workspaceHostDir,
				dest: layout.workspaceSandboxDir,
			});

			return { binds, dirs, env };
		},

		// EM: Unlike rstudio's own resolveArgs, -data/-importProject are
		// always prepended, whatever the user passed — both intrinsically
		// tied to project identity, not something a user would reasonably
		// want to override. See Design points 4-6 in eclipse-preset.md.
		//
		// No -importPreferences / .eclipse.epf handling here — removed once
		// resolveEclipseLayout started seeding a fresh workspace's
		// preferences from the user's own native one directly (see
		// seedWorkspaceSettingsFromHost above), which needs no restart and
		// doesn't share -importPreferences' defaults-not-populated problem.
		// A user who still wants to hand-import a specific .epf file can —
		// it's just an ordinary project file scoder no longer touches.
		//
		// No separate headless pre-launch stage: the plugin's own
		// -importProject works directly on the normal interactive launch
		// (confirmed from the plugin's own current README — "When
		// launching Eclipse, add the -importProject ... command line
		// parameter... will ultimately place you in the IDE"), so there's
		// nothing a separate prepareCommand stage would add here. An
		// earlier version ran the plugin's own headless application as a
		// distinct pre-launch step instead — dropped once this was
		// confirmed, since it bought nothing beyond an extra JVM startup.
		resolveArgs: async (
			hostProjectDir,
			sandboxProjectDir,
			existingArgs,
			dependencyDirs,
		) => {
			const layout = await resolveEclipseLayout(hostProjectDir);
			if (!layout) {
				return existingArgs;
			}

			return [
				"-data",
				layout.workspaceSandboxDir,
				"-importProject",
				sandboxProjectDir,
				...dependencyDirs.flatMap((dir) => ["-importProject", dir]),
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
