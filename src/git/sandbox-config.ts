import { mkdir, rename } from "node:fs/promises";
import { info, warning } from "../utils/logger.ts";

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
	// EM: No legacy counterpart — this one is born in the new layout, which is
	// EM: why the migration landed first.
	dbus: { path: `${CONFIG_DIR}/dbus`, legacy: null },
};

const README = `# .sandbox

Configuration for scoder, which runs tools in a bubblewrap sandbox.

This whole directory is bound **read-only** inside the sandbox, so a tool
running in there can read these files but cannot change what it is allowed to
do. Edit them from outside.

- \`readonly\`  — paths kept read-only inside the sandbox
- \`readwrite\` — \`$HOME\` directories opened read-write
- \`ports\`     — localhost ports forwarded into the sandbox
- \`dbus\`      — D-Bus services the sandbox may talk to

scoder creates this directory and these files with sane defaults the first
time it runs in a project. Each file documents itself in its own comments.
`;

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
export async function prepareConfigDir(projectRoot: string): Promise<void> {
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

	if (!existed) {
		await Bun.write(`${dir}/README.md`, README);
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
