import { readdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { getProjDir } from "../git/worktree.ts";
import { stageXpraDir } from "../sandbox/xpra.ts";
import type { BindMount, ToolBindSpec, ToolPreset } from "../types.ts";
import { error, info, warning } from "../utils/logger.ts";
import {
	getRealHome,
	isUnderAny,
	resolveHomePrefixes,
	toSandboxPath,
} from "../utils/paths.ts";
import { stageFile } from "../utils/session.ts";

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

// EM: .exited, not just the spawn: awaiting the Subprocess object resolves
// EM: the moment it is created, before mkdir has run, so any caller that
// EM: touches the directory on the next line (as seedVscodeSettingsFromHost
// EM: does with its cp) raced the mkdir it had just requested. The vscode
// EM: seed test caught this intermittently; awaiting exit makes it
// EM: deterministic for every preset.
async function ensureDir(path: string): Promise<void> {
	await Bun.spawn(["mkdir", "-p", path]).exited;
}

// ### Display mode — xpra (default) or the host's X session (--native-display)
//
// EM: Module-level rather than a parameter threaded through every preset's
// EM: configBinds/validate signature, because every other host fact these
// EM: functions consult (process.env.DISPLAY, process.cwd()) already arrives
// EM: this way. index.ts calls setNativeDisplay exactly once, before any
// EM: preset runs. The two branches it selects are the decision of
// EM: architecture/decision-records/0005-native-display-opt-out.md.
let nativeDisplayMode = false;

export function setNativeDisplay(on: boolean): void {
	nativeDisplayMode = on;
}

// ### guiDisplayBinds
// Shared between `rstudio` and `eclipse` — both are GUI apps needing a
// display. What they get is a *virtual* X server running inside the sandbox,
// whose windows xpra forwards to the host over a unix socket; see
// architecture/decision-records/0003-xpra-gui-isolation.md.
//
// EM: Named guiX11Binds until this changed, and the rename is the honest
// EM: description of what it now does: it no longer binds X11 at all. What it
// EM: used to bind, and deliberately — host /tmp/.X11-unix, the XAUTHORITY
// EM: cookie and its file, and DISPLAY — gave anything inside the sandbox the
// EM: same access to the user's real display as any of their own desktop
// EM: apps: reading the screen, and injecting synthetic input into other
// EM: windows via XTEST, which ADR 0002 verified directly is NOT blocked by
// EM: X11's own "untrusted" client mode. That was the one channel scoder
// EM: could not mediate once open. ADR 0002 accepted it because the
// EM: alternative (a nested X server inside the sandbox) looked like a whole
// EM: stack to assemble and needed inbound port forwarding that
// EM: buildPastaArgs does not do. xpra's seamless mode over a unix socket is
// EM: that option, made cheap: no window manager, no desktop session, no
// EM: ports. DISPLAY inside the sandbox is now set by xpra for its own
// EM: virtual display, so nothing here passes one in.
async function guiDisplayBinds(
	realHome: string,
	sandboxHome: string,
): Promise<ToolBindSpec> {
	const binds: BindMount[] = [];
	const dirs: string[] = [];
	const env: Record<string, string> = {};

	if (nativeDisplayMode) {
		// EM: --native-display (ADR 0005): the host's own X session, granted
		// EM: as it was before ADR 0003 withdrew it — and deliberately the
		// EM: same shape it had then, ported from git history with exactly
		// EM: one line NOT brought across: the old function also passed
		// EM: DBUS_SESSION_BUS_ADDRESS, which ADR 0004 has since made
		// EM: forbidden. A copy-paste would resurrect the hole's address;
		// EM: the tail below shares the xpra branch's env allowlist, and it
		// EM: says no.
		// EM:
		// EM: ro-bind, not bind: clients connect() to the socket *inodes*,
		// EM: whose permissions do not depend on writing to the directory —
		// EM: the shipping shape pre-xpra, and re-confirming it is a
		// EM: real-desktop checklist item rather than a reason to widen it
		// EM: now. Applied after builder's --tmpfs /tmp, so the mountpoint
		// EM: lands in the sandbox's own tmpfs rather than shadowing the
		// EM: host's /tmp — the same ordering rule the xpra dir bind below
		// EM: relies on.
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

		// EM: The cookie is bound as ONE FILE, never the directory around it.
		// EM: On GDM hosts the real spelling is commonly /run/user/<uid>/… —
		// EM: ADR 0005's named carve-out, and the reason it is named: a
		// EM: read-only copy of a file with no socket in it is not /run
		// EM: coming back, but only as long as it stays a file. The dest is
		// EM: normalised to $HOME so the sandbox sees one stable spelling
		// EM: whatever the host's happens to be.
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
	} else {
		// EM: The whole surface the GUI gets across the sandbox boundary: one
		// EM: directory, read-write because the server inside creates the socket
		// EM: and the client outside creates the mmap file. Source and dest are
		// EM: the same path deliberately — see xpraDir in src/sandbox/xpra.ts;
		// EM: mmap does not work otherwise, and without mmap the GUI is too laggy
		// EM: to use.
		const xpraDirPath = await stageXpraDir();
		binds.push({
			type: "bind",
			source: xpraDirPath,
			dest: xpraDirPath,
		});
	}

	// EM: XDG_RUNTIME_DIR is passed through; DBUS_SESSION_BUS_ADDRESS
	// EM: deliberately is not. The host's session bus went with --tmpfs /run,
	// EM: and nothing brings it back: see
	// EM: architecture/decision-records/0004-no-host-dbus.md. Forwarding the
	// EM: address without the socket would only point applications at a path
	// EM: that does not exist, which is worse than an unset variable — the
	// EM: unset one lets the session's *private* bus take over cleanly:
	// EM: xpra's --dbus-launch in the default mode, and in native mode the
	// EM: dbus-run-session / dbus-launch wrap the builder and entry point
	// EM: apply to the GUI program specifically (ADR 0005). The passed value
	// EM: names the sandbox's own fresh /run/user/<uid> on the /run tmpfs,
	// EM: never the host's.
	if (process.env.XDG_RUNTIME_DIR) {
		env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
	}

	// EM: Appearance settings the host desktop sets for GTK apps, inherited so
	// EM: a forwarded window behaves like a local one. Reported:
	// EM: GTK_OVERLAY_SCROLLING=0 is how KDE users stop GTK auto-hiding
	// EM: scrollbars, and without it a sandboxed IDE hides them while every
	// EM: other app on the desktop does not.
	// EM:
	// EM: An explicit allowlist, emphatically not a GTK_* passthrough.
	// EM: GTK_IM_MODULE must stay unset: entrypoint.sh relies on bwrap's
	// EM: --clearenv leaving it empty so that xpra's --input-method=keep
	// EM: leaves it alone, which is what stops Eclipse's SWT warning that
	// EM: GTK_IM_MODULE=xim "is unsupported and can cause graphical issues".
	// EM: A host that exports it would silently reintroduce exactly the bug
	// EM: that spelling was chosen to avoid.
	for (const name of ["GTK_OVERLAY_SCROLLING"]) {
		const value = process.env[name];
		if (value) {
			env[name] = value;
		}
	}

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

// ### managedProjectDir
// The host path of one project's scoder-managed state under a preset's
// root in ~/.local/share. Shared by the layout resolvers, which create and
// seed it, and by the presets' managedWorkspaceDir hooks, which only name
// it for --new-workspace — so the two can never disagree about the path.
async function managedProjectDir(
	rootDirname: string,
	hostProjectDir: string,
): Promise<string> {
	const projDir = await getProjDir(hostProjectDir);
	return `${getRealHome()}/.local/share/${rootDirname}/${projDir}`;
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

	const workspaceHostDir = await managedProjectDir(
		SCODER_ECLIPSE_WORKSPACES_DIRNAME,
		hostProjectDir,
	);
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

// ### vscode
// EM: The vscode preset borrows eclipse's managed-workspace shape for the
// EM: opposite reason. Eclipse's managed dir protects the user's real
// EM: workspace from a destructive flag; vscode's exists because one running
// EM: Code instance per user-data-dir is a hard limit of the app itself —
// EM: the directory holds the singleton lock (`SingletonLock`, a
// EM: hostname-pid symlink), the IPC socket a second launch would hand its
// EM: windows off through, and the SQLite global state two live writers
// EM: would corrupt. Since scoder shares neither the PID nor the UTS
// EM: namespace (builder.ts unshares only user+net), a dir shared with the
// EM: host editor would let the sandboxed instance see the host's lock as
// EM: live and connect to it across the bind — the wrong instance opening
// EM: the file. So the sandbox gets its own user-data-dir, per project,
// EM: persisting across sessions (host-side, like eclipse's), seeded once
// EM: from the host's own settings.
// EM: See design/implementation/plans/vscode-preset.md.
const SCODER_VSCODE_USERDATA_DIRNAME = "scoder-vscode-userdata";

// EM: VS Code and VSCodium are one preset with two settings. VSCodium is
// EM: VS Code's open build: the same Electron app, CLI and flags, but its
// EM: own binary, config dir and extensions tree, so a session of one never
// EM: touches the other's state — including scoder's managed user-data-dir,
// EM: which gets a root of its own per flavour.
interface VscodeFlavor {
	/** Shown in messages. */
	name: string;
	/** The binary on PATH. */
	command: string;
	/** Host config dir under $HOME; its User/ is the one-time seed source. */
	hostConfigDir: string;
	/** Extensions tree under $HOME, bound read-only. */
	extensionsDir: string;
	/** scoder's managed per-project user-data-dir root in ~/.local/share. */
	userDataDirname: string;
	installHint: string;
}

const VSCODE: VscodeFlavor = {
	name: "VS Code",
	command: "code",
	hostConfigDir: ".config/Code",
	extensionsDir: ".vscode/extensions",
	userDataDirname: SCODER_VSCODE_USERDATA_DIRNAME,
	installHint: "Install VS Code: https://code.visualstudio.com/download",
};

const VSCODIUM: VscodeFlavor = {
	name: "VSCodium",
	command: "codium",
	hostConfigDir: ".config/VSCodium",
	extensionsDir: ".vscode-oss/extensions",
	userDataDirname: "scoder-vscodium-userdata",
	installHint: "Install VSCodium: https://vscodium.com/#install",
};

interface VscodeLayout {
	userDataHostDir: string;
	userDataSandboxDir: string;
}

// EM: Seed once on first creation, never clobbered again — the same
// EM: discipline as seedWorkspaceSettingsFromHost above, and the reason
// EM: eclipse's version says it cannot be a symlink applies verbatim here.
// EM: Only the files the user hand-wrote cross over: settings, keybindings,
// EM: snippets. Deliberately NOT copied: workspaceStorage and
// EM: globalStorage/state.vscdb (machine-scoped live state, not preference —
// EM: and a SQLite file that is mid-write whenever the host editor runs),
// EM: argv.json (a sandboxed session silently inheriting host Electron
// EM: switches is the failure mode this preset avoids everywhere else), and
// EM: anything secret-bearing — secret storage is deliberately in-memory per
// EM: design/features/secret-storage.md, and a copied token would sit in
// EM: plaintext in a dir bound into every future session of this project.
async function seedVscodeSettingsFromHost(
	hostUserDir: string,
	userDataHostDir: string,
): Promise<void> {
	const destUserDir = `${userDataHostDir}/User`;
	let seeded = false;

	for (const name of ["settings.json", "keybindings.json"]) {
		const src = `${hostUserDir}/${name}`;
		if (await fileExists(src)) {
			await ensureDir(destUserDir);
			await Bun.spawn(["cp", src, destUserDir]).exited;
			seeded = true;
		}
	}

	const snippetsDir = `${hostUserDir}/snippets`;
	if (await dirExists(snippetsDir)) {
		const destSnippets = `${destUserDir}/snippets`;
		await ensureDir(destSnippets);
		await Bun.spawn(["cp", "-r", `${snippetsDir}/.`, destSnippets]).exited;
		seeded = true;
	}

	if (seeded) {
		info(`Seeded VS Code settings from ${hostUserDir}`);
	}
}

// EM: Idempotent, like resolveEclipseLayout: both configBinds and
// EM: resolveArgs call it, and only the first caller finds the dir absent
// EM: and seeds it. projDir (repo root minus its leading /, or cwd outside
// EM: a repo) scopes one managed dir per project — two checkouts of the
// EM: same repo share it, which is right: same code, same settings.
async function resolveVscodeLayout(
	hostProjectDir: string,
	flavor: VscodeFlavor,
): Promise<VscodeLayout> {
	const realHome = getRealHome();
	const homePrefixes = await resolveHomePrefixes();
	const userDataHostDir = await managedProjectDir(
		flavor.userDataDirname,
		hostProjectDir,
	);
	const isNew = !(await dirExists(userDataHostDir));
	await ensureDir(userDataHostDir);
	if (isNew) {
		await seedVscodeSettingsFromHost(
			`${realHome}/${flavor.hostConfigDir}/User`,
			userDataHostDir,
		);
	}

	return {
		userDataHostDir,
		userDataSandboxDir: toSandboxPath(userDataHostDir, homePrefixes),
	};
}

// EM: VS Code ships as a snap on Ubuntu, and that build expects its own
// EM: confinement's runtime dirs — stacking our bwrap on top of snap's is a
// EM: support swamp (its launcher, its SNAP_* env, its mount layout) for no
// EM: isolation benefit over the .deb/tarball build, which runs fine. A
// EM: clear refusal beats a mysterious failure. Exported for unit testing:
// EM: the predicate over a path needs no snap installed to test.
export function isSnapInstall(resolvedPath: string): boolean {
	return resolvedPath.startsWith("/snap/");
}

// ### requireGuiDisplay
// [IMPLEMENTS](/design/features/xpra-gui-isolation.md)
// Shared by every GUI preset's validate(). In the default mode xpra's
// absence is a hard failure, never a fallback; under --native-display it
// preflights instead what that flag is about to grant, per ADR 0005.
//
// EM: Deliberately not "fall back to binding the host X socket if xpra is
// EM: missing". A security-motivated change that quietly degrades to the
// EM: mechanism it replaced is the worst available default: the user believes
// EM: they got isolation and did not, and nothing on screen looks different.
// EM: If an opt-out is ever wanted it should be an explicit flag that names
// EM: what it gives up, not something that happens by absence — which is what
// EM: --native-display now is, and why this branches on it rather than on
// EM: xpra's availability. The message shape matches the bwrap/pasta checks
// EM: in main() for the same reason.
async function requireGuiDisplay(): Promise<boolean> {
	if (nativeDisplayMode) {
		return requireHostX11();
	}
	if (await commandExists("xpra")) {
		return true;
	}
	error("xpra not found in PATH");
	error("GUI presets forward windows from a virtual display inside the");
	error("sandbox, rather than exposing the host's X server to it");
	error("run sudo scoder --install-dependencies");
	error(
		"or pass --native-display to use the host's X session (see its --help)",
	);
	return false;
}

// ### requireHostX11
// --native-display's preflight: fail up front and by name, because a native
// misfire without one surfaces as `cannot open display` in sandbox stderr
// or, with --ide, in the IDE's log on the host — host-visible and printed
// at startup since 2.7.0, but still a launch that quietly produced no
// window rather than a refusal that says why. ADR 0003's "failures get
// quieter" note applies with more force here, since there is no server log
// even to quiet into.
async function requireHostX11(): Promise<boolean> {
	if (!process.env.DISPLAY) {
		error("no DISPLAY in the environment");
		error("--native-display runs GUI presets on the host's own X session");
		error("and there is no session to join");
		return false;
	}
	if (!(await dirExists("/tmp/.X11-unix"))) {
		error("DISPLAY is set, but /tmp/.X11-unix does not exist");
		error("--native-display binds that socket directory into the sandbox;");
		error("there is nothing to bind");
		return false;
	}
	const xauthPath = process.env.XAUTHORITY || `${getRealHome()}/.Xauthority`;
	if (!(await fileExists(xauthPath))) {
		// EM: A warning, not an error: xhost-style access control needs no
		// EM: cookie at all, and the pre-xpra code treated the file as
		// EM: optional for the same reason. Warn rather than assume, though,
		// EM: because on a cookie-requiring server the failure this predicts
		// EM: is the quiet kind this function exists to prevent.
		warning(`no X authority file at ${xauthPath}`);
		warning(
			"if your X server restricts clients by cookie, the GUI will not open",
		);
	}
	return true;
}

// ### jetbrains
// EM: JetBrains IDEs, the vscode pattern in JetBrains' terms. One running
// EM: instance per config directory is a hard rule of theirs too (a second
// EM: launch hands off over the port file in the system directory), so the
// EM: sandbox gets a managed per-project copy rather than the host's dirs:
// EM: config seeded once from the host's newest product directory, the
// EM: system directory (caches and indexes, expensive to rebuild) persisted
// EM: beside it, plugins read-only from the host. JetBrains redirects all
// EM: of these through an idea.properties file named by <PRODUCT>_PROPERTIES,
// EM: which scoder stages — the analogue of vscode's --user-data-dir.
// EM: Generic over the product; only WebStorm is registered, because only
// EM: WebStorm has been tried. Another product is one more JetBrainsProduct.
interface JetBrainsProduct {
	name: string;
	command: string;
	/** Versioned dir prefix under ~/.config/JetBrains, e.g. "WebStorm". */
	dirPrefix: string;
	/** Env var the launcher reads for an extra idea.properties. */
	propertiesEnv: string;
	/** scoder's managed root in ~/.local/share. */
	managedDirname: string;
	installHint: string;
}

const WEBSTORM: JetBrainsProduct = {
	name: "WebStorm",
	command: "webstorm",
	dirPrefix: "WebStorm",
	propertiesEnv: "WEBSTORM_PROPERTIES",
	managedDirname: "scoder-webstorm",
	installHint: "Install WebStorm: https://www.jetbrains.com/webstorm/download/",
};

// EM: Runtime files, not settings: copying them would hand the sandbox a
// EM: stale lock or port that points at a host instance.
const JETBRAINS_SEED_EXCLUDE = [".lock", "port", "port.lock", ".port"];

/** Where the staged idea.properties lands inside the sandbox. */
const JETBRAINS_PROPERTIES_DEST = "/tmp/scoder-idea.properties";

// ### newestJetBrainsDir
// The host's newest versioned directory for a product under `parent`
// (WebStorm2025.2 over WebStorm2024.3), or null.
async function newestJetBrainsDir(
	parent: string,
	prefix: string,
): Promise<string | null> {
	let names: string[];
	try {
		names = await readdir(parent);
	} catch {
		return null;
	}
	const versions = names
		.filter((n) => n.startsWith(prefix) && /^\d/.test(n.slice(prefix.length)))
		.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
	return versions[0] ?? null;
}

interface JetBrainsLayout {
	managedHostDir: string;
	configHostDir: string;
	systemHostDir: string;
	pluginsHostDir: string | null;
}

// ### resolveJetBrainsLayout
// Idempotent like resolveVscodeLayout: creates the managed dir and seeds
// config/ only the first time.
async function resolveJetBrainsLayout(
	hostProjectDir: string,
	product: JetBrainsProduct,
): Promise<JetBrainsLayout> {
	const realHome = getRealHome();
	const managedHostDir = await managedProjectDir(
		product.managedDirname,
		hostProjectDir,
	);
	const configHostDir = `${managedHostDir}/config`;
	const systemHostDir = `${managedHostDir}/system`;
	const version = await newestJetBrainsDir(
		`${realHome}/.config/JetBrains`,
		product.dirPrefix,
	);

	if (!(await dirExists(configHostDir))) {
		await ensureDir(configHostDir);
		if (version) {
			const source = `${realHome}/.config/JetBrains/${version}`;
			await Bun.spawn(["cp", "-a", `${source}/.`, configHostDir]).exited;
			for (const name of JETBRAINS_SEED_EXCLUDE) {
				await Bun.spawn(["rm", "-rf", `${configHostDir}/${name}`]).exited;
			}
			info(`Seeded ${product.name} settings from ${source}`);
		}
	}
	await ensureDir(systemHostDir);

	const plugins = version
		? `${realHome}/.local/share/JetBrains/${version}`
		: null;
	return {
		managedHostDir,
		configHostDir,
		systemHostDir,
		pluginsHostDir: plugins && (await dirExists(plugins)) ? plugins : null,
	};
}

// ### jetbrainsPreset
function jetbrainsPreset(product: JetBrainsProduct): ToolPreset {
	return {
		description: product.name,
		command: product.command,
		gui: true,
		managedWorkspaceDir: (hostProjectDir) =>
			managedProjectDir(product.managedDirname, hostProjectDir),
		configBinds: async (realHome, sandboxHome) => {
			const binds: BindMount[] = [];
			const dirs: string[] = [];
			const gui = await guiDisplayBinds(realHome, sandboxHome);
			binds.push(...(gui.binds ?? []));
			dirs.push(...(gui.dirs ?? []));

			const homePrefixes = await resolveHomePrefixes();
			const layout = await resolveJetBrainsLayout(process.cwd(), product);
			const managedSandboxDir = toSandboxPath(
				layout.managedHostDir,
				homePrefixes,
			);
			pushIntermediateDirs(
				dirs,
				sandboxHome,
				managedSandboxDir.slice(sandboxHome.length + 1),
			);
			binds.push({
				type: "bind",
				source: layout.managedHostDir,
				dest: managedSandboxDir,
			});

			let pluginsSandboxDir: string | null = null;
			if (layout.pluginsHostDir) {
				pluginsSandboxDir = toSandboxPath(layout.pluginsHostDir, homePrefixes);
				pushIntermediateDirs(
					dirs,
					sandboxHome,
					pluginsSandboxDir.slice(sandboxHome.length + 1),
				);
				binds.push({
					type: "ro-bind",
					source: layout.pluginsHostDir,
					dest: pluginsSandboxDir,
				});
			}

			// EM: idea.trust.all.projects: the "Trust this project?" dialog
			// EM: protects the user's real machine from an untrusted folder;
			// EM: inside scoder that is already answered — vscode's
			// EM: --disable-workspace-trust, for the same reason.
			const properties = [
				`idea.config.path=${toSandboxPath(layout.configHostDir, homePrefixes)}`,
				`idea.system.path=${toSandboxPath(layout.systemHostDir, homePrefixes)}`,
				`idea.log.path=${toSandboxPath(layout.systemHostDir, homePrefixes)}/log`,
				...(pluginsSandboxDir
					? [`idea.plugins.path=${pluginsSandboxDir}`]
					: []),
				"idea.trust.all.projects=true",
				"",
			].join("\n");
			const staged = await stageFile(JETBRAINS_PROPERTIES_DEST);
			await Bun.write(staged, properties);
			binds.push({
				type: "ro-bind",
				source: staged,
				dest: JETBRAINS_PROPERTIES_DEST,
			});

			// EM: The install's own bin/idea.properties, shadowed with the
			// EM: original plus these overrides (a later key wins in a
			// EM: properties file). Load-bearing: the native launcher
			// EM: (bin/webstorm is an ELF since 2024-ish) ignores
			// EM: <PRODUCT>_PROPERTIES — reported, with the env var and file
			// EM: both present in the sandbox, as Help → diagnostics showing
			// EM: the default ~/.config/JetBrains config dir, a fresh
			// EM: first-run wizard and trust dialog every session, and MCP
			// EM: settings lost at exit. Every launcher reads bin/idea.properties;
			// EM: the env var is kept for webstorm.sh. The host file is untouched.
			const launcher = await resolveCommandPath(product.command);
			if (launcher) {
				let binDir = dirname(launcher);
				try {
					binDir = dirname(await realpath(launcher));
				} catch {
					// EM: unresolvable symlink; the which-spelling's dir it is.
				}
				const installProps = `${binDir}/idea.properties`;
				let original = "";
				try {
					original = await Bun.file(installProps).text();
				} catch {
					// EM: No such file: the overrides alone.
				}
				const dest = toSandboxPath(installProps, homePrefixes);
				const shadow = await stageFile(dest);
				await Bun.write(
					shadow,
					`${original}${original.endsWith("\n") || original === "" ? "" : "\n"}# scoder overrides\n${properties}`,
				);
				binds.push({ type: "ro-bind", source: shadow, dest });
			}

			// EM: The licence-agreement and usage-statistics answers live
			// EM: outside every product's config dir, shared by all JetBrains
			// EM: IDEs: the EULA in Java's user preferences, the data-sharing
			// EM: consent in consentOptions. Reported: with config, licence and
			// EM: plugins all carried over, both dialogs still appeared on every
			// EM: start. Read-only from the host, where the user has already
			// EM: answered them: the sandbox sees the same answers and cannot
			// EM: change them. Existence-gated, nothing created.
			for (const rel of [
				".java/.userPrefs/jetbrains",
				".local/share/JetBrains/consentOptions",
			]) {
				const source = `${realHome}/${rel}`;
				if (await dirExists(source)) {
					pushIntermediateDirs(dirs, sandboxHome, rel);
					binds.push({
						type: "ro-bind",
						source,
						dest: `${sandboxHome}/${rel}`,
					});
				}
			}

			const piSpec = await piConfigBinds(realHome, sandboxHome);
			return {
				binds: [...binds, ...(piSpec.binds ?? [])],
				dirs: [...dirs, ...(piSpec.dirs ?? [])],
				env: { ...gui.env, [product.propertiesEnv]: JETBRAINS_PROPERTIES_DEST },
			};
		},
		validate: async () => {
			const path = await resolveCommandPath(product.command);
			if (!path) {
				error(`${product.command} not found in PATH`);
				error(product.installHint);
				return false;
			}
			let real = path;
			try {
				real = await realpath(path);
			} catch {
				// EM: unresolvable symlink; the which-spelling still decides.
			}
			if (isSnapInstall(path) || isSnapInstall(real)) {
				error(`the ${product.name} snap is not supported as a scoder preset`);
				error("  install the tarball build instead");
				return false;
			}
			return await requireGuiDisplay();
		},
		// EM: Fill-if-empty, as rstudio and vscode: open the project unless
		// EM: the user named something to open.
		resolveArgs: async (_host, sandboxProjectDir, existingArgs) =>
			existingArgs.length > 0 ? existingArgs : [sandboxProjectDir],
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

		gui: true,

		// EM: An R session in the sandbox registers itself with MCP, so that a
		// EM: `pi` running alongside it can drive the live R session rather
		// EM: than a separate one. btw::btw_mcp_session() has to run from
		// EM: .Rprofile, which R evaluates top to bottom — hence prepend.
		// EM:
		// EM: As an overlay rather than a committed file: the alternative is
		// EM: adding these lines to the .Rprofile of every project that might
		// EM: ever be opened in a sandbox, where they are noise for everyone
		// EM: not using scoder, and keeping them in step by hand when the
		// EM: project's own .Rprofile changes. The overlay re-renders from the
		// EM: host file whenever it changes, so neither problem arises.
		// EM:
		// EM: Guarded on interactive(): .Rprofile is also read by Rscript and
		// EM: by R CMD check, where starting an MCP session would be wrong and
		// EM: possibly fatal to a build.
		fileOverlays: async (hostProjectDir, sandboxProjectDir) => [
			{
				label: ".Rprofile",
				source: `${hostProjectDir}/.Rprofile`,
				dest: `${sandboxProjectDir}/.Rprofile`,
				injection: [
					"# Injected by scoder inside the sandbox; not part of the project.",
					'if (interactive() && requireNamespace("btw", quietly = TRUE)) {',
					"  btw::btw_mcp_session()",
					"}",
				].join("\n"),
				position: "prepend" as const,
			},
		],

		configBinds: async (realHome, sandboxHome) => {
			// EM: RStudio Desktop is a GUI app and needs a display. It gets a
			// EM: virtual X server running inside the sandbox, whose windows
			// EM: xpra forwards to the host over a unix socket — see
			// EM: architecture/decision-records/0003-xpra-gui-isolation.md and
			// EM: guiDisplayBinds for the shared display/DRI mechanics.
			// EM:
			// EM: Until 2.6.0 this bound the host's real X11 socket and
			// EM: XAUTHORITY instead, which ADR 0002 accepted knowing that it
			// EM: let anything in the sandbox read the screen and inject
			// EM: synthetic input into other windows. 0003 supersedes that.
			const display = await guiDisplayBinds(realHome, sandboxHome);
			const binds: BindMount[] = [...display.binds];
			const dirs: string[] = [...display.dirs];
			const env: Record<string, string> = { ...display.env };

			// EM: Reported: most menu items greyed out except cut/copy/paste,
			// EM: and only the window manager's own close button quits RStudio.
			// EM: RStudio Desktop is Electron/Chromium-based (confirmed by the
			// EM: "ozone/platform/x11" string in the original X11 error), and
			// EM: Electron apps on Linux commonly use D-Bus / xdg-desktop-portal
			// EM: for native file dialogs, single-instance activation, and
			// EM: session/quit integration — degrading rather than crashing when
			// EM: unavailable, which matches the symptom.
			// EM:
			// EM: The fix at the time was to pass the *host's* bus address
			// EM: through, and it worked. It was never the only option, which
			// EM: nobody noticed for a year: what Electron needs is *a* session
			// EM: bus, not the user's. Under a GUI preset xpra now starts one
			// EM: private to the sandbox, and the menus are fine with no host
			// EM: bus reachable at all — measured, finally, against a real
			// EM: RStudio. See
			// EM: architecture/decision-records/0004-no-host-dbus.md.
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

			// EM: RStudio Desktop is Electron, so its renderer is Chromium,
			// EM: and RSTUDIO_CHROMIUM_ARGUMENTS is RStudio's own documented
			// EM: way to pass Chromium flags to it. Forwarded rather than set,
			// EM: because the value that helps depends on the host's GPU and
			// EM: on what is wrong — see "RStudio's wheel scrolling" in
			// EM: design/features/xpra-gui-isolation.md. Without this the
			// EM: variable cannot reach RStudio at all: the sandbox runs
			// EM: --clearenv, so nothing the user exports survives unless it
			// EM: is named somewhere.
			if (process.env.RSTUDIO_CHROMIUM_ARGUMENTS) {
				env.RSTUDIO_CHROMIUM_ARGUMENTS = process.env.RSTUDIO_CHROMIUM_ARGUMENTS;
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
			return await requireGuiDisplay();
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

		gui: true,

		// EM: Requires the seeq12/eclipse-import-projects-plugin fork at
		// EM: https://github.com/robchallen/eclipse-import-projects-plugin
		// EM: (>= 2.0.0) to already be installed into the host Eclipse from
		// EM: its own p2 update site — scoder does not vendor, inject, or
		// EM: otherwise manage the plugin itself. See
		// EM: design/implementation/plans/eclipse-preset.md for why an
		// EM: earlier version tried to and what that cost.
		configBinds: async (realHome, sandboxHome) => {
			// EM: Eclipse's UI is SWT/GTK, not Electron, but it is the same
			// EM: class of display-needing desktop app as rstudio and gets the
			// EM: same treatment: a virtual X server inside the sandbox, with
			// EM: xpra forwarding its windows out. See
			// EM: architecture/decision-records/0003-xpra-gui-isolation.md,
			// EM: Design Decision 3 in eclipse-preset.md, and guiDisplayBinds
			// EM: for the shared display/DRI mechanics.
			// EM:
			// EM: NOT independently verified for Eclipse specifically, before
			// EM: or after this change: this project has no host with GTK
			// EM: installed and a real X session to confirm it against, and
			// EM: the xpra spike used xclock.
			const display = await guiDisplayBinds(realHome, sandboxHome);
			const binds: BindMount[] = [...display.binds];
			const dirs: string[] = [...display.dirs];
			const env: Record<string, string> = { ...display.env };

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
		// EM: Only scoder's own workspace under
		// EM: ~/.local/share/scoder-eclipse-workspaces — never ~/.eclipse,
		// EM: which may be the host install's own configuration. The project
		// EM: is imported in place (-importProject), so its files are not in
		// EM: here; what goes is Eclipse's .metadata: preferences, launch
		// EM: configurations, breakpoints, local history.
		managedWorkspaceDir: (hostProjectDir) =>
			managedProjectDir(SCODER_ECLIPSE_WORKSPACES_DIRNAME, hostProjectDir),

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
			return await requireGuiDisplay();
		},
	},

	// EM: VS Code. Every decision here — why a managed per-project
	// EM: user-data-dir rather than binding the host's, why extensions bind
	// EM: read-only, why no password-store flag, why ideShutdown is absent —
	// EM: carries its evidence in
	// EM: design/implementation/plans/vscode-preset.md; the short version is
	// EM: on the vscode helper block above.
	vscode: vscodeFamilyPreset(VSCODE),
	vscodium: vscodeFamilyPreset(VSCODIUM),
	webstorm: jetbrainsPreset(WEBSTORM),
};

// ### vscodeFamilyPreset
// The vscode preset, for either flavour (VS Code or VSCodium).
function vscodeFamilyPreset(flavor: VscodeFlavor): ToolPreset {
	return {
		description: flavor.name,
		// EM: The binary is `code`; the preset key is what users type.
		command: flavor.command,
		// EM: The whole managed user-data-dir: settings, UI state, the
		// EM: remembered prompts, workspace storage. Extensions live in the
		// EM: host's extensions tree and ~/.continue is the host's own,
		// EM: so neither is touched.
		managedWorkspaceDir: (hostProjectDir) =>
			managedProjectDir(flavor.userDataDirname, hostProjectDir),
		// EM: No ideShutdown: that field records measurements, not priors
		// EM: (see ide-shutdown-presets-record-measured-signals), and vscode
		// EM: has none yet. The expected shape is TERM/process-first —
		// EM: children-first would signal Electron's renderer and GPU
		// EM: helpers out from under the main process and lose its
		// EM: save-on-exit — but the plan's checklist item 6 converts that
		// EM: prior into a value here only once measured on a real desktop.
		gui: true,
		configBinds: async (realHome, sandboxHome) => {
			const binds: BindMount[] = [];
			const dirs: string[] = [];

			const gui = await guiDisplayBinds(realHome, sandboxHome);
			binds.push(...(gui.binds ?? []));
			dirs.push(...(gui.dirs ?? []));

			// EM: The managed user-data-dir, read-write at its mirrored
			// EM: path; creation and one-time seeding happen host-side in
			// EM: resolveVscodeLayout.
			const layout = await resolveVscodeLayout(process.cwd(), flavor);
			pushIntermediateDirs(
				dirs,
				sandboxHome,
				layout.userDataSandboxDir.slice(sandboxHome.length + 1),
			);
			binds.push({
				type: "bind",
				source: layout.userDataHostDir,
				dest: layout.userDataSandboxDir,
			});

			// EM: The whole shared extensions tree, read-only, existence-
			// EM: gated like eclipse's SDK homes: installing and updating
			// EM: extensions happens on the host, where it cannot surprise a
			// EM: running session. The accepted cost — "Install" inside the
			// EM: sandbox writes to tmpfs and vanishes — is the plan's
			// EM: decision 3, to be revisited on real experience.
			const extensionsDir = `${realHome}/${flavor.extensionsDir}`;
			if (await dirExists(extensionsDir)) {
				pushIntermediateDirs(dirs, sandboxHome, flavor.extensionsDir);
				binds.push({
					type: "ro-bind",
					source: extensionsDir,
					dest: `${sandboxHome}/${flavor.extensionsDir}`,
				});
			}

			// EM: The Continue extension keeps its whole state outside the
			// EM: user-data-dir, at ~/.continue: config.yaml (models and
			// EM: their API keys), chat sessions, the codebase index, logs.
			// EM: Read-write, because Continue writes sessions and its index
			// EM: there throughout a session; ro would break it, and tmpfs
			// EM: would show a blank, unconfigured Continue every launch.
			// EM: Existence-gated like the extensions tree: a user without
			// EM: Continue gets nothing created on their behalf. Its API
			// EM: keys become readable by the agent, the same exposure
			// EM: scoder's own API-key env passthrough already accepts.
			const continueDir = `${realHome}/.continue`;
			if (await dirExists(continueDir)) {
				dirs.push(`${sandboxHome}/.continue`);
				binds.push({
					type: "bind",
					source: continueDir,
					dest: `${sandboxHome}/.continue`,
				});
			}

			// EM: pi's own config so the integrated terminal can run scoder,
			// EM: for the same reason rstudio asks for it.
			const piSpec = await piConfigBinds(realHome, sandboxHome);
			// EM: gui.env carried through, not just its binds: under
			// EM: --native-display it holds DISPLAY and XAUTHORITY, and the
			// EM: sandbox runs --clearenv, so dropping it left `code` with the
			// EM: X socket and cookie bound but no way to name them — reported
			// EM: as VS Code never appearing, with an empty log (see
			// EM: vscode-preset-native-display-gets-display-env).
			return {
				binds: [...binds, ...(piSpec.binds ?? [])],
				dirs: [...dirs, ...(piSpec.dirs ?? [])],
				env: { ...gui.env },
			};
		},
		validate: async () => {
			const codePath = await resolveCommandPath(flavor.command);
			if (!codePath) {
				error(`${flavor.command} not found in PATH`);
				error(flavor.installHint);
				return false;
			}
			// EM: The which-spelling catches /snap/bin/code directly; the
			// EM: realpath catches a symlink from elsewhere into the snap.
			let codeReal = codePath;
			try {
				codeReal = await realpath(codePath);
			} catch {
				// EM: unresolvable symlink; the which-spelling still decides.
			}
			if (isSnapInstall(codePath) || isSnapInstall(codeReal)) {
				error(`the ${flavor.name} snap is not supported as a scoder preset`);
				error(`  found ${codePath}`);
				error("  its build expects snap's own confinement at runtime;");
				error("  install the .deb, .rpm or tarball build instead");
				return false;
			}
			return await requireGuiDisplay();
		},
		resolveArgs: async (
			_hostProjectDir: string,
			sandboxProjectDir: string,
			existingArgs: string[],
			_dependencyDirs: string[],
		) => {
			// EM: process.cwd(), not hostProjectDir — the layout must be the
			// EM: dir configBinds actually bound, and that identity is the
			// EM: launch project in both modes (eclipse's resolveEclipseLayout
			// EM: makes the same choice for the same reason: a throwaway
			// EM: worktree path must not fork a new per-session settings dir).
			const layout = await resolveVscodeLayout(process.cwd(), flavor);
			const scoderArgs = [
				"--user-data-dir",
				layout.userDataSandboxDir,
				"--extensions-dir",
				`${getRealHome()}/${flavor.extensionsDir}`,
				// EM: The sandboxed install is disposable; auto-update
				// EM: half-upgrading it mid-session or nagging across its
				// EM: tmpfs serves nothing — updates belong to the host
				// EM: install the extensions were read from.
				"--disable-updates",
				// EM: Workspace trust protects the user's real machine from
				// EM: untrusted folders; inside scoder that question is
				// EM: already answered, and a fresh user-data-dir has no
				// EM: trust state — without this every session would open
				// EM: the project in restricted mode and run nothing.
				"--disable-workspace-trust",
				// EM: Load-bearing for the entry point, not a debugging aid.
				// EM: `code` is a CLI launcher, not the app: it spawns the
				// EM: Electron main `detached: true` with `stdio: 'ignore'`
				// EM: and exits at once (src/vs/code/node/cli.ts). Reported
				// EM: as an IDE log that stayed empty — and worse, $! named a
				// EM: process already gone, so the entry point saw the IDE
				// EM: as finished: no ENTER prompt when pi exited, and the
				// EM: namespace reaper then killed the real window, unsaved
				// EM: work and all. --verbose is the one switch that makes
				// EM: the CLI pipe the app's stdout/stderr through and wait
				// EM: for its exit (Linux; same source). The app stays the
				// EM: CLI's child — detached only means its own session — so
				// EM: the children-first `pkill -P` shutdown still reaches
				// EM: it. Cost: verbose-level output in the log.
				"--verbose",
				// EM: Trial: secrets in memory for the session, explicitly, so
				// EM: VS Code never asks the keyring and the create-keyring
				// EM: dialog never appears. The same behaviour as its own
				// EM: fallback (secret-storage.md option A), minus the prompt.
				"--use-inmemory-secretstorage",
			];
			// EM: rstudio's fill-if-empty semantics: the user's own args pass
			// EM: through untouched, and the project dir is added only when
			// EM: there was nothing to open at all. Distinguishing
			// EM: flag-values from folder arguments would be fragile —
			// EM: `--install-extension ext.id` has a value that is not a
			// EM: folder — so the presence of any arg suppresses the fill.
			if (existingArgs.length > 0) {
				return [...scoderArgs, ...existingArgs];
			}
			return [...scoderArgs, sandboxProjectDir];
		},
	};
}

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
