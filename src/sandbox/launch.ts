import {
	closeSync,
	openSync,
	readdirSync,
	readlinkSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import {
	readAgentPorts,
	refreshResolvConfSnapshot,
} from "../git/protection.ts";
import type { ScoderOptions } from "../types.ts";
import { error, info, warning } from "../utils/logger.ts";
import { terminateProcess } from "../utils/process.ts";
import { stageHostScratchDir } from "../utils/session.ts";
import { wrapWithFdShim } from "./builder.ts";
import type { LiveOverlay, OverlayWatcher } from "./overlays.ts";
import { startOverlayWatcher } from "./overlays.ts";
import {
	attachPasta,
	buildPastaArgs,
	type PastaSidecar,
	stopPasta,
} from "./pasta.ts";
import type { XpraSidecar } from "./xpra.ts";
import { attachXpraClient, stopXpraClient } from "./xpra.ts";

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

// EM: Anything left inside the sandbox gets far longer than pasta or the ssh
// tunnel do, because these are applications with real shutdown work rather
// than sidecars: an IDE with unsaved editor state, an xpra server that stops
// its own Xvfb and removes its sockets.
const IDE_TERM_GRACE_MS = 5000;
const IDE_KILL_GRACE_MS = 2000;

/** Terminal-driven signals --new-session detaches the sandboxed process
 * from — see installSignalForwarding. */
const FORWARDED_SIGNALS = ["SIGWINCH", "SIGINT", "SIGQUIT", "SIGTSTP"] as const;

/** A second SIGINT within this window force-kills instead of forwarding
 * again. Overridable so tests don't have to wait out the real window. */
const DOUBLE_SIGINT_WINDOW_MS =
	Number.parseInt(process.env.SCODER_DOUBLE_SIGINT_WINDOW_MS || "", 10) || 2000;

/**
 * How often to re-read .agentports during a live session. Overridable so
 * tests don't have to wait out a multi-second interval to observe a reload.
 */
const AGENT_PORTS_POLL_MS =
	Number.parseInt(process.env.SCODER_AGENTPORTS_POLL_MS || "", 10) || 2000;

/**
 * How often to re-check the host's real DNS config during a live session.
 * Overridable so tests don't have to wait out a multi-second interval to
 * observe a refresh. A separate knob from AGENT_PORTS_POLL_MS, even though
 * both default to the same cadence — the two watchers poll unrelated
 * things (an intentional user edit vs. a host network change) and have no
 * reason to share a single tuning point.
 */
const RESOLVCONF_POLL_MS =
	Number.parseInt(process.env.SCODER_RESOLVCONF_POLL_MS || "", 10) || 2000;

/** A sandbox's mount namespace, pinned by an open fd — see captureSandboxNamespace. */
interface SandboxNamespace {
	id: string;
	fd: number;
}

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
	resolvConfSnapshotPath: string | null,
	// EM: Set for a GUI session, meaning a program inside the sandbox will
	// EM: start an xpra server and this is where its socket will appear. null
	// EM: for every non-GUI session, which is most of them.
	xpraSocketPath: string | null = null,
	// EM: Files whose host sources are watched for the life of the session.
	// EM: Empty for a session with no project overlay, which is only the
	// EM: degenerate case — AGENTS.md is always one of these.
	overlays: LiveOverlay[] = [],
): Promise<LaunchResult> {
	// EM: The one set of temp artifacts with no sandbox-side path to mirror:
	// EM: the --info-fd/--block-fd fifos and pasta's pid file are read by
	// EM: scoder and pasta on the host and are never bound in. They go under
	// EM: the session root's reserved .host/ subtree rather than being given
	// EM: an invented sandbox path they do not have.
	const rendezvous = await stageHostScratchDir("launch");
	const infoPath = join(rendezvous, "info");
	const blockPath = join(rendezvous, "block");
	const pidFile = join(rendezvous, "pasta-0.pid");

	let sandboxNs: SandboxNamespace | null = null;
	let sidecar: PastaSidecar | null = null;
	let xpraSidecar: XpraSidecar | null = null;
	let signalForwarder: SignalForwarder | null = null;
	let portsWatcher: AgentPortsWatcher | null = null;
	let resolvConfWatcher: ResolvConfWatcher | null = null;
	let overlayWatcher: OverlayWatcher | null = null;

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

		// Installed as soon as childPid is known, not just once the tool is
		// released: the double-Ctrl-C escape hatch should cover the pasta-attach
		// window too, not only the "tool is running" phase.
		signalForwarder = installSignalForwarding(proc, childPid);

		// EM: Captured here, while the sandbox is alive, because after it exits
		// EM: there is no process left to read the namespace from — and the
		// EM: survivors this exists to find have been reparented away by then.
		sandboxNs = captureSandboxNamespace(childPid);

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

		// Independent of the ports watcher — touches only the DNS snapshot
		// file, never pasta or the sidecar, so it has nothing to hand off
		// or coordinate with. Skipped entirely if setupResolvConf found
		// nothing to snapshot at launch (resolvConfSnapshotPath is null);
		// there's no file to refresh in that case either.
		if (resolvConfSnapshotPath) {
			resolvConfWatcher = startResolvConfWatcher(resolvConfSnapshotPath);
		}

		// EM: Started only after the sandbox is released, like the resolv.conf
		// EM: watcher: before that there is nothing reading these files, and a
		// EM: re-render racing bwrap's own bind setup would be pointless work
		// EM: at best.
		if (overlays.length > 0) {
			overlayWatcher = startOverlayWatcher(overlays);
		}

		// EM: After the sandbox is released, never before: the socket cannot
		// EM: exist until bwrap has finished setting the sandbox up and the
		// EM: server inside has started its virtual display. Measured at ~3s
		// EM: in the spike, so attachXpraClient waits rather than assuming.
		// EM:
		// EM: A failure here is deliberately NOT fatal. The sandbox is already
		// EM: running with the user's tool in it; tearing that down because a
		// EM: window did not appear would lose their session over the
		// EM: companion. attachXpraClient has already said what went wrong.
		if (xpraSocketPath) {
			xpraSidecar = await attachXpraClient(xpraSocketPath);
		}

		const exitCode = await proc.exited;
		return { exitCode };
	} finally {
		// Removing the listeners first, not last: once the tool has exited
		// there is nothing left to forward signals to, and a stray one
		// arriving mid-cleanup would just hit an already-gone process group.
		signalForwarder?.stop();
		resolvConfWatcher?.stop();
		overlayWatcher?.stop();

		// EM: Before pasta and before the sandbox finishes dying. The client
		// EM: renders the sandbox's windows, so leaving it up while the server
		// EM: inside goes away shows the user a frozen window for as long as
		// EM: shutdown takes. Same family as pasta and the ssh tunnel: it lives
		// EM: outside the sandbox, so --die-with-parent does not reap it.
		await stopXpraClient(xpraSidecar);

		if (sandboxNs) {
			await reapSandboxNamespace(sandboxNs);
			closeSync(sandboxNs.fd);
		}

		// pasta lives outside the sandbox, so bwrap's --die-with-parent does not
		// reap it. Every exit path has to come through here.
		if (portsWatcher) {
			await portsWatcher.stop();
		} else {
			await stopPasta(sidecar);
		}
		// EM: The rendezvous fifos go with the rest of the session root when
		// EM: the process exits; nothing outlives it that would care about
		// EM: them in between.
	}
}

// ### captureSandboxNamespace
// Record the sandbox's mount namespace, and pin it so its identity cannot be
// reused while we still intend to act on it.
//
// EM: The open fd is the load-bearing part. A namespace is freed once the
// last process leaves it, and the kernel is free to hand its inode number to
// the next one — so comparing recorded ids after the sandbox has emptied
// could, in principle, match an unrelated namespace and kill somebody else's
// processes. Holding an fd on /proc/<pid>/ns/mnt keeps the namespace alive
// and its id unique for as long as scoder cares. Verified that the link
// stays readable through the fd after every process in it has gone.
function captureSandboxNamespace(childPid: number): SandboxNamespace | null {
	try {
		const path = `/proc/${childPid}/ns/mnt`;
		return { id: readlinkSync(path), fd: openSync(path, "r") };
	} catch {
		// The sandbox died between being reported and being inspected.
		return null;
	}
}

// ### reapSandboxNamespace
// Terminate anything still running inside the sandbox after it has exited.
//
// EM: It can happen, and routinely did. scoder does not unshare the PID
// EM: namespace — pasta attaches to the network namespace from outside, see
// EM: ADR 0001 — so bwrap's --die-with-parent reaches only its own immediate
// EM: child, and entrypoint.sh starts the companion IDE under `setsid` so it
// EM: cannot write to the agent's terminal. A setsid process is reparented to
// EM: init when its parent dies. Verified directly: a setsid child outlived
// EM: bwrap. Reported as seven accumulated RStudio instances, each carrying an
// EM: Electron stack, an rsession, a Tomcat and a language server.
//
// EM: By namespace rather than by tracked pid, which an earlier version of
// EM: this did. A pid only reaches what it names and what shares its process
// EM: group, and that measurably was not enough: xpra forks its Xvfb and a
// EM: dbus-daemon into sessions of their own, so both survived every attempt
// EM: to signal the IDE, with or without a generous grace period. Membership
// EM: of the sandbox's mount namespace, by contrast, is exactly the property
// EM: "is part of this sandbox" — nothing else can be in it, and nothing in
// EM: it belongs to anyone else.
//
// EM: A no-op on the normal path: the entrypoint does not return until both
// EM: programs have exited, so there is usually nothing here and this costs
// EM: one scan of /proc.
async function reapSandboxNamespace(ns: SandboxNamespace): Promise<void> {
	const survivors = ourPidsInNamespace(ns.id);
	if (survivors.length === 0) {
		return;
	}

	warning(
		`${survivors.length} process(es) outlived the sandbox; shutting them down`,
	);
	for (const pid of survivors) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone.
		}
	}

	// EM: Generous, unlike the sidecars' 500ms: these are applications with
	// EM: real shutdown work — an IDE with unsaved editor state, an xpra
	// EM: server that stops its own Xvfb and removes its sockets.
	const deadline = Date.now() + IDE_TERM_GRACE_MS;
	while (Date.now() < deadline && ourPidsInNamespace(ns.id).length > 0) {
		await Bun.sleep(100);
	}

	for (const pid of ourPidsInNamespace(ns.id)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}

	// EM: Confirmed rather than assumed, the same way stopPasta and
	// EM: stopSshTunnel do it: signalling and checking immediately reports a
	// EM: false survivor every time, because the process has not been reaped
	// EM: yet. Anything still here after SIGKILL is a genuine leak and worth
	// EM: saying so, since the user is the only one who can act on it.
	const killDeadline = Date.now() + IDE_KILL_GRACE_MS;
	while (Date.now() < killDeadline && ourPidsInNamespace(ns.id).length > 0) {
		await Bun.sleep(100);
	}
	const stubborn = ourPidsInNamespace(ns.id);
	if (stubborn.length > 0) {
		warning(`sandbox processes survived SIGKILL: ${stubborn.join(", ")}`);
	}
}

// ### ourPidsInNamespace
// Every process of ours currently in the given mount namespace.
//
// EM: Restricted to our own uid so that a shared machine's other users are
// EM: never inspected or signalled, and skipping our own pid, which is in the
// EM: host's namespace anyway. Unreadable entries are skipped silently:
// EM: /proc is full of processes that are not ours, and a process exiting
// EM: mid-scan is normal rather than exceptional.
function ourPidsInNamespace(nsId: string): number[] {
	const pids: number[] = [];
	const uid = process.getuid?.() ?? -1;

	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return pids;
	}

	for (const entry of entries) {
		const pid = Number.parseInt(entry, 10);
		if (Number.isNaN(pid) || pid === process.pid) {
			continue;
		}
		try {
			if (statSync(`/proc/${pid}`).uid !== uid) {
				continue;
			}
			if (readlinkSync(`/proc/${pid}/ns/mnt`) === nsId) {
				pids.push(pid);
			}
		} catch {
			// Not ours to read, or gone between readdir and stat.
		}
	}

	return pids;
}

// ### describeLaunch// ### describeLaunch
// The two stages as they would run, for --dry-run. Printing only the bwrap
// command would no longer describe what actually happens.
//
// Always shows attachPasta's first-attempt args, never the --ipv4-only
// retry (see isIpv6RoutabilityFailure in pasta.ts) — that retry only
// happens after a real attach genuinely fails, which --dry-run,
// deliberately side-effect free, never does.
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

interface SignalForwarder {
	/** Removes the listeners this installed. Synchronous — nothing to await. */
	stop(): void;
}

// ### installSignalForwarding
// [IMPLEMENTS](/design/features/sandbox-isolation.md)
// bwrap's --new-session (see buildBwrapCommand) calls setsid() on the
// sandboxed process — a real security control: it is what blocks
// TIOCSTI-style terminal injection and other signal leakage between the
// sandbox and the session outside it. A side effect: the sandboxed process
// loses its controlling-terminal relationship entirely, so the kernel can no
// longer deliver any signal a terminal normally generates for it — SIGWINCH
// on resize, SIGINT/SIGQUIT/SIGTSTP on Ctrl-C/Ctrl-\/Ctrl-Z — since there is
// no foreground process group left for it to target. Confirmed directly:
// tcgetpgrp() on the inherited tty fd fails with ENOTTY from inside the
// sandbox once --new-session has run. See
// design/implementation/issues/terminal-signals-not-forwarded-to-sandbox.md.
//
// scoder's own process sits outside that detached session, so it still
// receives these signals normally, and relays them on with a plain kill() —
// which, unlike the kernel's tty-driven delivery, is gated only on
// permissions, not on any controlling-terminal relationship. This does not
// reopen what --new-session closed: that flag stops the sandboxed process
// from reaching things outside it; this is scoder, the trusted launcher,
// explicitly relaying a signal in, using a mechanism the sandboxed process
// has no way to trigger itself.
//
// Targets -childPid (the whole process group), not childPid alone:
// --new-session's setsid() makes it both session and process group leader
// (confirmed directly — pgid == sid == childPid), so this also reaches
// anything it forks internally, not just its own top-level process.
//
// This alone is not sufficient, though — see the trap in wrapWithFdShim
// (builder.ts). bwrap shares scoder's own process group by default, so a
// real Ctrl-C also lands on bwrap directly, at the same moment as on scoder.
// Without that trap, bwrap's own unhandled default disposition for
// INT/QUIT kills it, --die-with-parent reacts by SIGKILLing the sandboxed
// process, and that race wins every time — confirmed directly, forwarding
// without the trap hit ESRCH because the target was already gone by the
// time this code ran. The trap removes the race entirely rather than trying
// to win it.
//
// A second SIGINT within DOUBLE_SIGINT_WINDOW_MS force-kills the launch via
// killBwrapTree instead of forwarding again, in case the sandboxed tool
// doesn't exit on its own after the first one — a bug in that tool, not
// scoder, but the user still needs an escape hatch that doesn't depend on it
// working.
//
// Independently of forwarding, installing any handler at all fixes a
// separate, previously real gap: scoder's own process had no signal
// handlers of any kind, so an unhandled SIGINT hit Bun's default
// disposition — immediate termination, skipping launchSandbox's finally
// block entirely (confirmed directly: a try/finally around a plain
// Bun.sleep never reaches its finally on an unhandled SIGINT). That leaked
// the pasta sidecar on every Ctrl-C, the same leak class
// bwrap-orphaned-on-pasta-attach-failure fixed, just triggered a different
// way.
function installSignalForwarding(
	proc: Bun.Subprocess<"inherit", "inherit", "inherit">,
	childPid: number,
): SignalForwarder {
	let lastSigintAt: number | null = null;
	let forceKilling = false;

	function forward(signal: NodeJS.Signals): void {
		try {
			process.kill(-childPid, signal);
		} catch {
			// The sandboxed process may already be gone.
		}
	}

	function onSignal(signal: NodeJS.Signals): void {
		if (signal !== "SIGINT") {
			forward(signal);
			return;
		}

		const now = Date.now();
		if (lastSigintAt !== null && now - lastSigintAt < DOUBLE_SIGINT_WINDOW_MS) {
			if (!forceKilling) {
				forceKilling = true;
				warning("Second Ctrl-C — force-killing the sandbox");
				killBwrapTree(proc, childPid).catch(() => {});
			}
			return;
		}

		lastSigintAt = now;
		forward(signal);
	}

	for (const signal of FORWARDED_SIGNALS) {
		process.on(signal, onSignal);
	}

	return {
		stop(): void {
			for (const signal of FORWARDED_SIGNALS) {
				process.off(signal, onSignal);
			}
		},
	};
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

interface ResolvConfWatcher {
	/** Stops polling. Nothing to tear down beyond that — the snapshot file
	 * itself is cleaned up by launchSandbox's own rendezvous dir removal. */
	stop(): void;
}

// ### startResolvConfWatcher
// [IMPLEMENTS](/design/features/network-isolation.md)
// Polls the host's real DNS config for the rest of the session and
// rewrites the sandbox's already-bound snapshot file if it changed.
// Deliberately much simpler than startAgentPortsWatcher: this never
// touches pasta, the sidecar, or the sandbox's network namespace at
// all — only the plain host file /etc/resolv.conf is bind-mounted from
// inside the sandbox, so overwriting its content is visible immediately,
// with nothing to swap, restart, or fail over to.
//
// Deliberately polling, not inotify/fs.watch, same reasoning as
// startAgentPortsWatcher: sidesteps the write-to-temp-then-rename inode
// change atomic-save tooling can cause for a single-file watch (relevant
// here too — systemd-resolved and NetworkManager both rewrite
// /etc/resolv.conf via exactly that pattern on every network change,
// which is the actual event this watcher exists to catch).
function startResolvConfWatcher(snapshotFile: string): ResolvConfWatcher {
	let stopped = false;

	const loop = (async () => {
		while (!stopped) {
			await Bun.sleep(RESOLVCONF_POLL_MS);
			if (stopped) {
				return;
			}

			const changed = await refreshResolvConfSnapshot(snapshotFile);
			if (changed) {
				info("Host DNS configuration changed — refreshed inside the sandbox");
			}
		}
	})();

	return {
		stop(): void {
			stopped = true;
			// Deliberately not awaited: the loop's own next wake-up checks
			// `stopped` and returns immediately, and nothing here needs to
			// coordinate with anything else the way stopping the ports
			// watcher needs to wait for a pasta swap in flight — there is no
			// process or sidecar this watcher owns to tear down.
			void loop;
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
