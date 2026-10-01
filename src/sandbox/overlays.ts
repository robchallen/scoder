import type { BindMount } from "../types.ts";
import { info } from "../utils/logger.ts";
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

// ### startOverlayWatcher
// Re-render the overlays whenever their host sources change, for as long as
// the session runs.
export function startOverlayWatcher(overlays: LiveOverlay[]): OverlayWatcher {
	let stopped = false;

	const loop = (async () => {
		while (!stopped) {
			await Bun.sleep(POLL_MS);
			if (stopped) {
				return;
			}

			for (const overlay of overlays) {
				if (await renderOverlay(overlay)) {
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
