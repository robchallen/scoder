import { readdir, readFile, rm, stat } from "node:fs/promises";
import { error, info } from "../utils/logger.ts";
import {
	getRealHome,
	resolveHomePrefixes,
	toSandboxPath,
} from "../utils/paths.ts";

// EM: --new-workspace
// EM: Deletes a preset's scoder-managed per-project state (eclipse's
// EM: workspace, vscode's user-data-dir) before setup, so the preset's own
// EM: first-run path re-creates and re-seeds it from the host's settings.
// EM: Deleting is the whole mechanism: both layout resolvers already treat a
// EM: missing directory as a new project, so there is no separate "reset"
// EM: code path to drift from the real one.

// ### isManagedWorkspacePath
// The guard before an rm -rf: the path must sit strictly below one of
// scoder's own roots in ~/.local/share (scoder-<something>/<project...>).
// A preset hook that ever returned the root itself, $HOME, or the user's
// own config would be refused here rather than deleted.
export function isManagedWorkspacePath(dir: string, realHome: string): boolean {
	const prefix = `${realHome}/.local/share/`;
	if (!dir.startsWith(prefix) || dir.includes("/../") || dir.endsWith("/..")) {
		return false;
	}
	const [root, ...rest] = dir.slice(prefix.length).split("/");
	return root.startsWith("scoder-") && rest.filter(Boolean).length > 0;
}

// ### processesUsing
// Pids of live processes with the directory in their argv — how both
// presets name it (`-data DIR`, `--user-data-dir DIR`). Works across the
// sandbox boundary because scoder does not unshare the PID namespace (ADR
// 0001): a sandboxed IDE is an ordinary host process here. Both spellings
// are checked, since the sandbox sees the raw-$HOME one.
async function processesUsing(dirs: string[]): Promise<number[]> {
	const pids: number[] = [];
	const matches = (arg: string) =>
		dirs.some(
			(dir) =>
				arg === dir || arg.startsWith(`${dir}/`) || arg.endsWith(`=${dir}`),
		);

	for (const entry of await readdir("/proc")) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || pid === process.pid) {
			continue;
		}
		try {
			const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
			if (cmdline.split("\0").some(matches)) {
				pids.push(pid);
			}
		} catch {
			// EM: Exited mid-scan, or another user's process: not ours.
		}
	}
	return pids;
}

// ### resetManagedWorkspace
// Delete one preset's managed directory. Returns false when the session
// must not go ahead (the directory is in use, or the path failed the guard).
export async function resetManagedWorkspace(
	presetName: string,
	dir: string,
	dryRun: boolean,
): Promise<boolean> {
	const realHome = getRealHome();
	if (!isManagedWorkspacePath(dir, realHome)) {
		error(`--new-workspace: refusing to delete ${dir}`);
		error(
			`it is not under a scoder-managed directory in ${realHome}/.local/share`,
		);
		return false;
	}

	if (!(await stat(dir).catch(() => null))) {
		info(
			`--new-workspace: ${presetName} has no workspace for this project yet; it starts fresh anyway`,
		);
		return true;
	}

	const sandboxDir = toSandboxPath(dir, await resolveHomePrefixes());
	const users = await processesUsing([...new Set([dir, sandboxDir])]);
	if (users.length > 0) {
		// EM: Deleting under a live IDE corrupts more than it resets: the
		// EM: running instance keeps writing (VS Code's SQLite state,
		// EM: Eclipse's .metadata) into a tree that is half gone.
		error(`--new-workspace: ${presetName}'s workspace is in use: ${dir}`);
		error(`by pid ${users.join(", ")} — close that session first`);
		return false;
	}

	if (dryRun) {
		info(`--new-workspace: would delete ${presetName}'s workspace ${dir}`);
		return true;
	}

	await rm(dir, { recursive: true, force: true });
	info(
		`--new-workspace: deleted ${presetName}'s workspace ${dir}; it is re-created from your host settings`,
	);
	return true;
}
