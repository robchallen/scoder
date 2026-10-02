import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { BindMount } from "../types.ts";
import { info, warning } from "../utils/logger.ts";
import { stageFile } from "../utils/session.ts";

// EM: Live file overlays
// EM: Implements live-file-overlays — a host file, plus sandbox-only content,
// EM: bound read-only inside, and re-rendered whenever the host file changes.
//
// EM: Both halves of this already existed separately and neither was enough on
// EM: its own. The AGENTS.md overlay composed a file with injected content but
// EM: rendered it exactly once, so editing AGENTS.md on the host did nothing
// EM: until the session was restarted — which, for the file whose entire job
// EM: is telling the agent how to behave, is the wrong way round. The
// EM: resolv.conf snapshot refreshed on change but injects nothing. This is
// EM: the two put together, and generic because the shape recurs: the
// EM: motivating second case is an R project's .Rprofile, which needs
// EM: `btw::btw_mcp_session()` prepended so an RStudio session registers
// EM: itself with MCP, without that having to be committed to every project
// EM: that might one day be opened in a sandbox.

/**
 * A host file presented inside the sandbox with extra content, kept in step
 * with the host while the session runs.
 */
export interface LiveOverlay {
	/** Named in log lines when the file changes. */
	label: string;
	/**
	 * Host file supplying the base content. Need not exist — a missing
	 * source renders as the injection alone, and the overlay starts
	 * tracking it if it appears later.
	 */
	source: string;
	/** Sandbox path the rendered file is bound at, read-only. */
	dest: string;
	/** Sandbox-only content. */
	injection: string;
	/**
	 * Which side of the source content the injection goes. AGENTS.md appends,
	 * so the project's own instructions lead; an .Rprofile prepends, because R
	 * runs the file top to bottom and a session registration wants to happen
	 * before anything the project does.
	 */
	position: "prepend" | "append";
}

// ### renderOverlay
// Compose the staged file from the host source and the injection. Returns
// true if the result differs from what was there before.
//
// EM: Always rendered from the source, never by editing the previous render.
// EM: That is the one invariant that matters here: appending to the last
// EM: output would duplicate the injection on every refresh, and the bug
// EM: would not show up until the host file was edited twice.
export async function renderOverlay(overlay: LiveOverlay): Promise<boolean> {
	const staged = await stageFile(overlay.dest);

	let base = "";
	try {
		base = await Bun.file(overlay.source).text();
	} catch {
		// No such file on the host. The injection stands alone, which is what
		// a project with no AGENTS.md or no .Rprofile should see.
	}

	// EM: The separating newline is added only when the base has content, so a
	// EM: missing source does not produce a file that starts with a blank line
	// EM: — which matters for .Rprofile, where the injected call should be the
	// EM: first thing R evaluates.
	const rendered =
		overlay.position === "append"
			? base
				? `${base}\n${overlay.injection}`
				: overlay.injection
			: base
				? `${overlay.injection}\n${base}`
				: overlay.injection;

	let previous: string | null = null;
	try {
		previous = await Bun.file(staged).text();
	} catch {
		// First render.
	}
	if (previous === rendered) {
		return false;
	}

	await Bun.write(staged, rendered);
	return true;
}

// ### overlayBinds
// Render each overlay and return the read-only binds that present them.
export async function setupOverlays(
	overlays: LiveOverlay[],
): Promise<BindMount[]> {
	const binds: BindMount[] = [];

	for (const overlay of overlays) {
		await renderOverlay(overlay);
		binds.push({
			type: "ro-bind",
			source: await stageFile(overlay.dest),
			dest: overlay.dest,
		});
	}

	return binds;
}

// ### ensureOverlaySources
// Create any missing host source file, empty, before bwrap binds over it.
//
// EM: Not optional, and not merely tidy. A bind needs a mountpoint, and if the
// EM: host file does not exist bwrap creates one itself inside what is a
// EM: read-write bind of the user's own project directory — so the file
// EM: appears on the host either way. The difference is the mode: bwrap
// EM: creates it `-r--r--r--`, verified directly, leaving the user an empty
// EM: read-only .Rprofile in their project that they cannot edit without
// EM: chmod. Creating it here instead gives it ordinary permissions and makes
// EM: a visible side effect on the user's project a deliberate act rather
// EM: than a consequence of how bwrap happens to work.
//
// EM: Called from launchSandbox rather than at setup time, so that --dry-run
// EM: — which must not touch the user's project — never reaches it.
export async function ensureOverlaySources(
	overlays: LiveOverlay[],
): Promise<void> {
	for (const overlay of overlays) {
		if (await Bun.file(overlay.source).exists()) {
			continue;
		}
		try {
			await Bun.write(overlay.source, "");
			info(`Created empty ${overlay.source} for the sandbox overlay`);
		} catch {
			// EM: Not fatal. bwrap will make its own mountpoint, which is the
			// EM: behaviour this improves on rather than depends on; a project
			// EM: directory we cannot write to is unusual but not a reason to
			// EM: refuse the session.
		}
	}
}

export interface OverlayWatcher {
	stop(): void;
}

// EM: Polled rather than watched with inotify, deliberately. inotify
// EM: instances are a per-*user* kernel resource — fs.inotify.max_user_instances
// EM: defaults to 128 and is shared with the user's entire desktop — and this
// EM: project has already had one report of that budget being exhausted, by
// EM: RStudio, with baffling symptoms (see xpra-gui-isolation's inotify
// EM: section, where xpra's own usage was cut from 8 instances to 1). Spending
// EM: more of it to notice an edit a second sooner would be a poor trade.
// EM:
// EM: Two seconds, matching the resolv.conf watcher this is modelled on: a
// EM: human editing AGENTS.md will not notice the delay, and the cost is one
// EM: stat and at most one small read per file per tick.
const POLL_MS =
	Number.parseInt(process.env.SCODER_OVERLAY_POLL_MS || "", 10) || 2000;

// A source file as seen through the two facts the watcher can observe: the
// identity of the file occupying the path, and whether that path still names
// the file the sandbox bind was grafted onto.
interface TrackedSource {
	overlay: LiveOverlay;
	/** `dev:ino` captured at watcher start — the file the bind is attached to. */
	boundKey: string | null;
	/** Once detached, always detached: nothing can reattach a bind mid-session. */
	detached: boolean;
}

// ### startOverlayWatcher
// Re-render the overlays whenever their host sources change, for as long as
// the session runs.
export function startOverlayWatcher(
	overlays: LiveOverlay[],
	pollMs = POLL_MS,
): OverlayWatcher {
	let stopped = false;

	// EM: A bind grafts onto the file occupying the destination path when
	// EM: bwrap sets it up — onto the file object, not onto the name. A
	// EM: rename-save deletes that entry and installs a new file under the
	// EM: old name, and the graft dies with the old entry: inside the
	// EM: sandbox the file then shows the raw host content with scoder's
	// EM: section missing, for the rest of the session, with no way to
	// EM: reattach from outside the mount namespace. VS Code's atomic save,
	// EM: vim's default backup mode, `sed -i` and `git checkout` all save
	// EM: this way, so it had to be assumed. The response chosen (2.7.0) is
	// EM: to detect and say so loudly rather than re-present; the schemes
	// EM: that do survive renames each mutate the user's project file or
	// EM: hide the agent's writes from the host, and the reasoning lives in
	// EM: design/implementation/issues/agents-md-does-not-update-as-
	// EM: expected.md.
	// EM:
	// EM: dev+ino is sampled here, after bwrap has started, so the file the
	// EM: stat finds is the file the bind grafted onto. `Bun.write`
	// EM: truncates in place — the ordinary re-render is inode-stable and
	// EM: must never trip this — so only replaced or vanished files change
	// EM: the key.
	const tracked: TrackedSource[] = overlays.map((overlay) => {
		let boundKey: string | null = null;
		try {
			const st = statSync(overlay.source);
			boundKey = `${st.dev}:${st.ino}`;
		} catch {
			// EM: Absent at startup — the source is optional. The first file
			// EM: that appears is adopted quietly rather than accused of
			// EM: having replaced something.
		}
		return { overlay, boundKey, detached: false };
	});

	const loop = (async () => {
		while (!stopped) {
			await Bun.sleep(pollMs);
			if (stopped) {
				return;
			}

			for (const source of tracked) {
				const { overlay } = source;
				let key: string | null;
				try {
					const st = await stat(overlay.source);
					key = `${st.dev}:${st.ino}`;
				} catch {
					key = null;
				}

				if (!source.detached) {
					if (source.boundKey === null && key !== null) {
						source.boundKey = key;
					} else if (source.boundKey !== null && key !== source.boundKey) {
						source.detached = true;
						if (key === null) {
							warning(
								`${overlay.label} was deleted on the host, and its sandbox bind goes with it — inside the sandbox ${overlay.label} is now gone, scoder's instructions included. Putting the file back will not reattach the bind; restart the session.`,
							);
						} else {
							warning(
								`${overlay.label} was replaced on the host — how editors and git save (write a temp file, rename over the original). The bind is attached to the previous file, so inside the sandbox ${overlay.label} now shows the edits without scoder's instructions. Restart the session to restore them.`,
							);
						}
					}
				}

				// EM: Rendering continues either way — the staged file is
				// EM: the starting point after a restart, and keeping it
				// EM: current costs one small read per tick. The "updated in
				// EM: the sandbox" claim, however, is only true while the
				// EM: bind is alive, so it is withheld once detached.
				if ((await renderOverlay(overlay)) && !source.detached) {
					info(`${overlay.label} changed on the host — updated in the sandbox`);
				}
			}
		}
	})();

	return {
		stop(): void {
			stopped = true;
			// Deliberately not awaited, for the same reason the resolv.conf
			// watcher is not: the loop's next wake-up sees `stopped` and
			// returns, and there is no process or sidecar here to coordinate
			// a teardown with.
			void loop;
		},
	};
}
