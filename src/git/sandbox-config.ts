import { mkdir, rename } from "node:fs/promises";
import defaultEnv from "../defaults/env" with { type: "text" };
import defaultPorts from "../defaults/ports" with { type: "text" };
import defaultReadme from "../defaults/README.md" with { type: "text" };
import defaultReadonly from "../defaults/readonly" with { type: "text" };
import defaultReadwrite from "../defaults/readwrite" with { type: "text" };
import { STARTER_RECIPES } from "../recipes.ts";
import { info, warning } from "../utils/logger.ts";
import { getRealHome } from "../utils/paths.ts";

// EM: The .sandbox/ project configuration directory
// EM: Implements sandbox-config-directory
//
// EM: One directory replaces the three dotfiles scoder used to scatter in
// EM: every project root. The tidiness is the smaller half of it: binding the
// EM: *directory* read-only, rather than each file individually, deletes a bug
// EM: class outright. A bind needs a source, so under the old scheme a file
// EM: that did not exist got no bind and was therefore writable from inside
// EM: the sandbox — found and fixed twice, with three regression tests to
// EM: show for it. A file created inside a bound directory is covered the
// EM: moment it exists, with nothing to remember.

/** Project-relative directory holding every scoder configuration file. */
export const CONFIG_DIR = ".sandbox";

/**
 * Project-relative paths of each configuration file, and the legacy dotfile
 * each one replaces.
 */
export const CONFIG_FILES: Record<
	string,
	{ path: string; legacy: string | null }
> = {
	readonly: { path: `${CONFIG_DIR}/readonly`, legacy: ".agentreadonly" },
	readwrite: { path: `${CONFIG_DIR}/readwrite`, legacy: ".agentreadwrite" },
	ports: { path: `${CONFIG_DIR}/ports`, legacy: ".agentports" },
	env: { path: `${CONFIG_DIR}/env`, legacy: null },
};

// EM: The shipped defaults, embedded at build time like entrypoint.sh: the
// EM: compiled single-file binary carries them, with no asset path to find at
// EM: runtime. They are the only defaults scoder has — every reader below that
// EM: finds a file missing falls back to these, not to a literal of its own.
const DEFAULT_FILES: Record<string, string> = {
	"README.md": defaultReadme,
	env: defaultEnv,
	readonly: defaultReadonly,
	readwrite: defaultReadwrite,
	ports: defaultPorts,
};

// ### defaultConfigText
// The shipped default content of one configuration file.
export function defaultConfigText(file: keyof typeof CONFIG_FILES): string {
	return DEFAULT_FILES[file] ?? "";
}

// ### parseEnvNames
// The names in an env file: one per line, blank lines and # comments
// skipped, anything that is not a valid variable name warned about and
// dropped, duplicates removed.
export function parseEnvNames(content: string, label: string): string[] {
	const names: string[] = [];
	for (const rawLine of content.split("\n")) {
		const name = rawLine.split("#")[0]?.trim() ?? "";
		if (name === "") {
			continue;
		}
		// EM: `*` is a wildcard (PI_*, *_API_KEY), expanded against the host
		// EM: environment by expandEnvNames. A line of nothing but `*` would
		// EM: pass the whole host environment, undoing the point of the file.
		if (/^\**$/.test(name)) {
			warning(
				`${label}: ignoring "${rawLine.trim()}" — a pattern must name something; list variables or prefixes (e.g. PI_*)`,
			);
			continue;
		}
		if (!/^[A-Za-z_*][A-Za-z0-9_*]*$/.test(name)) {
			warning(
				`${label}: ignoring "${rawLine.trim()}" — not an environment variable name or pattern`,
			);
			continue;
		}
		if (!names.includes(name)) {
			names.push(name);
		}
	}
	return names;
}

// EM: Never matched by a pattern, only by naming them exactly: variables that
// EM: would break the sandbox (PATH, HOME, LD_*), are scoder's own (SCODER_*),
// EM: or point at host resources the sandbox deliberately cannot reach — the
// EM: display, the session bus, the ssh agent. A broad pattern like XDG_* or
// EM: *_ADDRESS would otherwise carry them in by accident.
const PATTERN_EXCLUDED_NAMES = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PWD",
	"OLDPWD",
	"DISPLAY",
	"XAUTHORITY",
	"WAYLAND_DISPLAY",
	"DBUS_SESSION_BUS_ADDRESS",
	"XDG_RUNTIME_DIR",
	"SSH_AUTH_SOCK",
]);
const PATTERN_EXCLUDED_PREFIXES = ["LD_", "SCODER_"];

// ### expandEnvNames
// Resolve an env file's entries against an environment: exact names as they
// are, each pattern replaced by the matching names present in `env` — less
// the excluded names and any in `alreadySet` (variables scoder sets itself).
// Returns the names, and for each pattern what it matched, for the startup
// report.
export function expandEnvNames(
	entries: string[],
	env: Record<string, string | undefined>,
	alreadySet: Set<string> = new Set(),
): { names: string[]; matches: Map<string, string[]> } {
	const names: string[] = [];
	const matches = new Map<string, string[]>();
	const add = (name: string) => {
		if (!names.includes(name)) {
			names.push(name);
		}
	};

	for (const entry of entries) {
		if (!entry.includes("*")) {
			add(entry);
			continue;
		}
		const re = new RegExp(`^${entry.split("*").map(escapeRegExp).join(".*")}$`);
		const matched = Object.keys(env)
			.filter(
				(name) =>
					env[name] !== undefined &&
					re.test(name) &&
					!PATTERN_EXCLUDED_NAMES.has(name) &&
					!PATTERN_EXCLUDED_PREFIXES.some((p) => name.startsWith(p)) &&
					!alreadySet.has(name),
			)
			.sort();
		matches.set(entry, matched);
		for (const name of matched) {
			add(name);
		}
	}
	return { names, matches };
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ### readConfigText
// One configuration file's content as the session will use it: the
// project's own `.sandbox/` copy, else the user's `~/.config/scoder/` one,
// else the shipped default.
//
// EM: The fallbacks exist for --dry-run, which writes nothing and so never
// EM: creates the project's copy: it still previews exactly what a real run
// EM: would apply. On a real run prepareConfigDir has already filled the
// EM: project's copy, and the first branch is the only one taken.
export async function readConfigText(
	projectRoot: string,
	file: keyof typeof CONFIG_FILES,
): Promise<string> {
	const leaf = CONFIG_FILES[file].path.slice(CONFIG_DIR.length + 1);
	for (const path of [
		configPath(projectRoot, file),
		`${userConfigDir()}/${leaf}`,
	]) {
		if (await fileExists(path)) {
			return await Bun.file(path).text();
		}
	}
	return defaultConfigText(file);
}

// ### userConfigDir
// The user's own defaults, `$XDG_CONFIG_HOME/scoder` (normally
// `~/.config/scoder`). Copied into a project's `.sandbox/` file by file,
// for whatever the project does not already have.
export function userConfigDir(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	const base = xdg?.startsWith("/") ? xdg : `${getRealHome()}/.config`;
	return `${base}/scoder`;
}

// ### seedRecipes
// Copy each starter recipe missing from the user's config directory, by
// file name. Never overwrites: a user's edits, and their own recipes beside
// these, stand. Returns the directory.
export async function seedRecipes(): Promise<string> {
	const dir = userConfigDir();
	await mkdir(dir, { recursive: true });
	for (const [name, content] of Object.entries(STARTER_RECIPES)) {
		const path = `${dir}/${name}`;
		if (!(await fileExists(path))) {
			await Bun.write(path, content);
			info(`Added starter recipe ${path}`);
		}
	}
	return dir;
}

// ### configPath
// Absolute path of a configuration file within a project.
export function configPath(
	projectRoot: string,
	file: keyof typeof CONFIG_FILES,
): string {
	return `${projectRoot}/${CONFIG_FILES[file].path}`;
}

// ### prepareConfigDir
// Create `.sandbox/`, migrating any legacy dotfiles into it.
//
// EM: Called before anything reads configuration, so that every later code
// EM: path sees one layout and none of them has to know both.
//
// EM: The migration is automatic and unconditional — no flag, no prompt. The
// EM: alternatives are all worse at the scale this project is at: hard-failing
// EM: breaks every existing project on upgrade; reading both layouts leaves a
// EM: compatibility shim that outlives everyone and a window where two sources
// EM: of truth disagree; and a command the user has to discover means the
// EM: legacy files are silently ignored until they find it — which for
// EM: `.agentreadonly` means protections quietly stop applying, a security
// EM: regression presented as an upgrade.
export async function prepareConfigDir(
	projectRoot: string,
	dryRun = false,
): Promise<void> {
	const dir = `${projectRoot}/${CONFIG_DIR}`;
	const existed = await dirExists(dir);

	// EM: A warning rather than a refusal. `.sandbox` is a generic name, unlike
	// EM: `.agentreadonly`, so a project may plausibly already have one — a
	// EM: test fixture area, a build scratch directory. Refusing would block a
	// EM: session over a directory that is probably fine; saying so is enough
	// EM: to explain an otherwise baffling read-only build failure.
	if (existed && !(await looksLikeOurs(dir))) {
		warning(`${CONFIG_DIR}/ already exists and has none of scoder's files`);
		warning("It will be bound read-only in the sandbox and written into");
	}

	await mkdir(dir, { recursive: true });

	for (const [name, { path, legacy }] of Object.entries(CONFIG_FILES)) {
		const to = `${projectRoot}/${path}`;

		if (!legacy) {
			continue;
		}
		const from = `${projectRoot}/${legacy}`;
		if (!(await fileExists(from))) {
			continue;
		}
		// EM: Never overwrite, never merge. Two configuration files that
		// EM: disagree, reconciled by a tool, is how a project ends up with a
		// EM: protection list nobody wrote. The new one wins and the legacy one
		// EM: is left where it is, reported rather than deleted.
		if (await fileExists(to)) {
			warning(`${legacy} ignored — ${path} already exists`);
			continue;
		}

		try {
			// EM: rename, not copy-then-unlink: a copy that fails partway and
			// EM: still removes the original loses the user's configuration.
			// EM: rename is atomic within a filesystem, and both paths are
			// EM: inside the project.
			await rename(from, to);
			info(`Migrated ${legacy} to ${path}`);
		} catch (err) {
			warning(`could not migrate ${legacy} to ${path}: ${err}`);
			warning(`scoder will use ${path}'s default until it is moved`);
		}
		void name;
	}

	// EM: No longer seeded from ~/.config/scoder file by file (retired with
	// EM: --configure, design/features/configure-mode.md): a project's
	// EM: env/readonly/readwrite/ports are written by a configure session,
	// EM: which an interactive start triggers when any is missing. Until then
	// EM: readConfigText falls back to the shipped base defaults. What is
	// EM: still seeded: the recipes the configure skill reads, into
	// EM: ~/.config/scoder, and this directory's README.
	// EM: Not under --dry-run, which must not create configuration files.
	if (dryRun) {
		return;
	}
	await seedRecipes();
	if (!(await fileExists(`${dir}/README.md`))) {
		await Bun.write(`${dir}/README.md`, defaultReadme);
	}
}

// ### looksLikeOurs
// Whether a pre-existing `.sandbox/` holds anything scoder put there.
async function looksLikeOurs(dir: string): Promise<boolean> {
	if (await fileExists(`${dir}/README.md`)) {
		return true;
	}
	for (const { path } of Object.values(CONFIG_FILES)) {
		const leaf = path.slice(CONFIG_DIR.length + 1);
		if (await fileExists(`${dir}/${leaf}`)) {
			return true;
		}
	}
	return false;
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
