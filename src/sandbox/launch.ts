import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentPorts } from "../git/protection.ts";
import type { ScoderOptions } from "../types.ts";
import { error, info, warning } from "../utils/logger.ts";
import { terminateProcess } from "../utils/process.ts";
import { wrapWithFdShim } from "./builder.ts";
import {
	attachPasta,
	buildPastaArgs,
	type PastaSidecar,
	stopPasta,
} from "./pasta.ts";

// EM: Two-stage sandbox launch
// EM: Implements network-isolation and sandbox-isolation
//
// EM: Ordering is the whole point of this module:
// EM:   1. bwrap creates the namespaces and blocks before exec'ing the tool
// EM:   2. pasta attaches to the network namespace from outside
// EM:   3. the tool is released, with networking already up
//
// EM: Without step 2 preceding step 3 the tool would briefly see a dead
// EM: network, which for an agent that immediately calls an API is not benign.

/** How long to wait for bwrap to publish its child pid before giving up. */
const CHILD_PID_TIMEOUT_MS = 5000;
const CHILD_PID_POLL_MS = 25;

/** Grace periods for shutting a failed launch down, before escalating. */
const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 500;

/**
 * How often to re-read .agentports during a live session. Overridable so
 * tests don't have to wait out a multi-second interval to observe a reload.
 */
const AGENT_PORTS_POLL_MS =
	Number.parseInt(process.env.SCODER_AGENTPORTS_POLL_MS || "", 10) || 2000;

export interface LaunchResult {
	exitCode: number;
}

// ### launchSandbox
// [IMPLEMENTS](/design/features/sandbox-isolation.md)
// [IMPLEMENTS](/design/features/network-isolation.md)
// Run the sandbox with networking attached, and return the tool's exit code.
// Always tears the sidecar down, including on the failure paths.
export async function launchSandbox(
	bwrapCmd: string[],
	options: ScoderOptions,
	toolDescription: string,
	projectRoot: string,
): Promise<LaunchResult> {
	const rendezvous = await mkdtemp(join(tmpdir(), "scoder-launch-"));
	const infoPath = join(rendezvous, "info");
	const blockPath = join(rendezvous, "block");
	const pidFile = join(rendezvous, "pasta-0.pid");

	let sidecar: PastaSidecar | null = null;
	let portsWatcher: AgentPortsWatcher | null = null;

	try {
		// bwrap blocks reading this fifo until we release it
		await makeFifo(blockPath);
		await Bun.write(infoPath, "");

		info(`Launching ${toolDescription} in sandbox...`);

		const proc = Bun.spawn(wrapWithFdShim(bwrapCmd, infoPath, blockPath), {
			stdout: "inherit",
			stderr: "inherit",
			stdin: "inherit",
		});

		const childPid = await waitForChildPid(infoPath);
		if (childPid === null) {
			// Bounded deliberately: with no timeout the sandbox sits on --block-fd
			// forever and the session hangs with nothing said.
			error("bwrap did not report its child pid, so networking cannot attach");
			await killBwrapTree(proc, null);
			return { exitCode: 1 };
		}

		sidecar = await attachPasta(options, childPid, pidFile);
		if (!sidecar) {
			// attachPasta has already explained why. Do not release the tool into
			// a namespace with no route out.
			await killBwrapTree(proc, childPid);
			return { exitCode: 1 };
		}

		// Release the sandbox. The shim owns fd 9, so this is a plain write to
		// the fifo rather than anything fd-based on our side.
		await Bun.write(blockPath, "go\n");

		// From here on the ports watcher owns the sidecar's lifetime — it may
		// swap it out for a fresh one if .agentports changes mid-session.
		portsWatcher = startAgentPortsWatcher(
			projectRoot,
			options,
			childPid,
			rendezvous,
			sidecar,
		);

		const exitCode = await proc.exited;
		return { exitCode };
	} finally {
		// pasta lives outside the sandbox, so bwrap's --die-with-parent does not
		// reap it. Every exit path has to come through here.
		if (portsWatcher) {
			await portsWatcher.stop();
		} else {
			await stopPasta(sidecar);
		}
		await rm(rendezvous, { recursive: true, force: true });
	}
}

// ### describeLaunch
// The two stages as they would run, for --dry-run. Printing only the bwrap
// command would no longer describe what actually happens.
export function describeLaunch(
	bwrapCmd: string[],
	options: ScoderOptions,
): { sandbox: string[]; pasta: string[] } {
	const infoPath = "<rendezvous>/info";
	const blockPath = "<rendezvous>/block";

	return {
		sandbox: wrapWithFdShim(bwrapCmd, infoPath, blockPath),
		pasta: [
			...buildPastaArgs(options, "<rendezvous>/pasta.pid"),
			"<bwrap-child-pid>",
		],
	};
}

// ### killBwrapTree
// bwrap forks internally even without --unshare-pid: the pid Bun.spawn
// returns is only the outer setup process. A second, inner process — its
// child — is the one that actually holds the namespaces and blocks reading
// --block-fd. Killing only the outer pid reaps it cleanly but leaves the
// inner one running, reparented to pid 1, still blocked on a fifo nothing
// will ever write to. Confirmed directly with a process-tree trace — see
// design/implementation/issues/bwrap-orphaned-on-pasta-attach-failure.md.
//
// childPid is already known once bwrap has reported it (it is what pasta
// needed to attach to); the lookup fallback only matters for the rarer case
// where bwrap never reported one at all, and must run before the outer
// process is killed, since findChildPid searches by current ppid and the
// inner process's ppid changes once it is reparented.
async function killBwrapTree(
	proc: Bun.Subprocess<"inherit", "inherit", "inherit">,
	childPid: number | null,
): Promise<void> {
	const innerPid = childPid ?? (await findChildPid(proc.pid));

	proc.kill();
	await proc.exited;

	if (innerPid !== null) {
		await terminateProcess(innerPid, TERM_GRACE_MS, KILL_GRACE_MS);
	}
}

interface AgentPortsWatcher {
	/** Stops polling and tears down whichever sidecar is currently active. */
	stop(): Promise<void>;
}

// ### startAgentPortsWatcher
// [IMPLEMENTS](/design/features/network-isolation.md)
// Polls .agentports for the rest of the session and reloads pasta when it
// changes — the netns belongs to bwrap, not pasta (see ADR 0001), so a swap
// never touches the sandbox itself, only which ports are forwarded into it.
//
// Deliberately polling, not inotify/fs.watch: sidesteps a real class of bugs
// atomic-save editors cause for single-file watches (write-to-temp-then-
// rename changes the inode). A few seconds of reload latency is a fine trade
// for that; nothing here needs sub-second responsiveness.
//
// Sequential swap (stop the old sidecar, then attach the new one), not the
// zero-gap "attach new before stopping old" version considered during
// design: whether two pasta processes can be attached to one netns at once
// was never verified, so this takes the option that doesn't depend on the
// answer. If the new attach fails, it falls back to re-attaching the last
// known-good port list rather than leaving the sandbox with no networking —
// that fallback is a real (if brief) second gap on the failure path, not the
// common one.
function startAgentPortsWatcher(
	projectRoot: string,
	options: ScoderOptions,
	childPid: number,
	rendezvous: string,
	initialSidecar: PastaSidecar,
): AgentPortsWatcher {
	let current: PastaSidecar | null = initialSidecar;
	let currentPorts = options.openPorts;
	let stopped = false;
	let swapCount = 0;

	const loop = (async () => {
		while (!stopped) {
			await Bun.sleep(AGENT_PORTS_POLL_MS);
			if (stopped) {
				return;
			}

			let latestPorts: number[];
			try {
				latestPorts = await readAgentPorts(projectRoot);
			} catch (err) {
				warning(`Failed to re-read .agentports: ${err}`);
				continue;
			}

			if (portsEqual(latestPorts, currentPorts)) {
				continue;
			}

			info(
				`.agentports changed — reloading pasta with ports: ${latestPorts.join(", ") || "none"}`,
			);

			await stopPasta(current);
			swapCount++;
			const newSidecar = await attachPasta(
				{ ...options, openPorts: latestPorts },
				childPid,
				join(rendezvous, `pasta-${swapCount}.pid`),
			);

			if (newSidecar) {
				current = newSidecar;
				currentPorts = latestPorts;
				continue;
			}

			warning(
				".agentports reload failed to attach — restoring the previous port configuration",
			);
			swapCount++;
			const restored = await attachPasta(
				{ ...options, openPorts: currentPorts },
				childPid,
				join(rendezvous, `pasta-${swapCount}.pid`),
			);

			if (restored) {
				current = restored;
				warning("restored the previous .agentports configuration");
			} else {
				current = null;
				error(
					"failed to restore the previous .agentports configuration — the sandbox has no forwarded ports",
				);
			}
		}
	})();

	return {
		async stop(): Promise<void> {
			stopped = true;
			await loop;
			await stopPasta(current);
		},
	};
}

function portsEqual(a: number[], b: number[]): boolean {
	if (a.length !== b.length) {
		return false;
	}

	const sortedA = [...a].sort((x, y) => x - y);
	const sortedB = [...b].sort((x, y) => x - y);

	return sortedA.every((port, i) => port === sortedB[i]);
}

async function findChildPid(parentPid: number): Promise<number | null> {
	const proc = Bun.spawn(["pgrep", "-P", parentPid.toString()], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;

	const out = (await new Response(proc.stdout).text()).trim();
	if (!out) {
		return null;
	}

	const pid = Number.parseInt(out.split("\n")[0], 10);
	return Number.isNaN(pid) ? null : pid;
}

async function makeFifo(path: string): Promise<void> {
	const proc = Bun.spawn(["mkfifo", path], { stdout: "pipe", stderr: "pipe" });
	await proc.exited;

	if (proc.exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`Failed to create launch fifo: ${stderr.trim()}`);
	}
}

// ### waitForChildPid
// bwrap writes {"child-pid": N} to --info-fd once the namespaces exist. Poll
// for it rather than blocking, so a bwrap that dies during setup is noticed.
async function waitForChildPid(infoPath: string): Promise<number | null> {
	const deadline = Date.now() + CHILD_PID_TIMEOUT_MS;

	while (Date.now() < deadline) {
		try {
			const contents = await Bun.file(infoPath).text();
			const match = contents.match(/"child-pid":\s*(\d+)/);
			if (match?.[1]) {
				return Number.parseInt(match[1], 10);
			}
		} catch {
			// Not written yet
		}

		await Bun.sleep(CHILD_PID_POLL_MS);
	}

	return null;
}
