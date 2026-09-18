import { unlink } from "node:fs/promises";
import type { ScoderOptions } from "../types.ts";
import { error, warning } from "../utils/logger.ts";
import { terminateProcess } from "../utils/process.ts";

// EM: The pasta network sidecar
// EM: Implements network-isolation via pasta attached to an existing netns
//
// EM: pasta runs OUTSIDE the sandbox and attaches to the network namespace
// EM: bwrap created. Its lifetime is therefore independent of the sandbox:
// EM: bwrap's --die-with-parent does not reap it, so it must be stopped
// EM: explicitly or every session leaks a pasta process.
//
// EM: Why not pasta's spawn mode, which would manage its own lifetime? Because
// EM: spawn mode creates a nested user namespace that overrides bwrap's --uid,
// EM: running the tool as root. See
// EM: architecture/decision-records/0001-sandbox-uid-and-networking-composition.md

/** Grace periods for shutting the sidecar down, before escalating. */
const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 500;

/** A running pasta process servicing a sandbox's network namespace. */
export interface PastaSidecar {
	pid: number;
	pidFile: string;
}

// ### buildPastaArgs
// [IMPLEMENTS](/design/features/network-isolation.md)
// Flags shared by every invocation. The target pid is appended by attachPasta,
// because pasta takes it as a trailing positional argument.
//
// Deliberately no --foreground: in attach mode pasta must outlive the call that
// starts it, so it can go on servicing the netns while scoder waits on the tool.
export function buildPastaArgs(
	options: ScoderOptions,
	pidFile: string,
): string[] {
	const args = [
		"pasta",
		"--quiet",
		"--config-net",
		"--dhcp-dns",
		"--no-map-gw",
		"--tcp-ports",
		"none",
		"--pid",
		pidFile,
	];

	// EM: Forward the named localhost ports in, and block host loopback otherwise
	if (options.openPorts.length > 0) {
		for (const port of options.openPorts) {
			args.push("--tcp-ns", port.toString());
		}
	} else {
		args.push("--tcp-ns", "none");
	}

	args.push("--udp-ns", "none");

	return args;
}

// ### isIpv6RoutabilityFailure
// True if pasta's own stderr blames a lack of IPv6 routability for its
// failure to attach — reported directly: "No routable interface for
// IPv6: IPv6 is disabled" followed by "Couldn't switch to pasta
// namespaces: ...". --config-net's own dual-stack auto-detection
// apparently treats IPv6 being unavailable as fatal rather than
// something to skip gracefully, unlike a merely-unconfigured/unrouted
// IPv6 address on an otherwise dual-stack-capable host.
//
// Deliberately checking pasta's own stderr after a failed attempt,
// rather than predicting the failure ahead of time by reading a sysctl
// (net.ipv6.conf.all.disable_ipv6, tried first — see git history): that
// prediction turned out to be unreliable in practice, missing at least
// one real case (IPv6 disabled via the ipv6.disable=1 kernel boot
// parameter rather than the per-sysctl toggle, under which
// /proc/sys/net/ipv6 does not exist at all, so the sysctl read silently
// — and wrongly — reported "not disabled"). Trusting pasta's own
// authoritative determination, after the fact, covers every route to
// this same failure without needing to enumerate them.
export function isIpv6RoutabilityFailure(stderr: string): boolean {
	return /no routable interface for ipv6/i.test(stderr);
}

// ### attachPasta
// [IMPLEMENTS](/design/features/network-isolation.md)
// Attach networking to an existing network namespace, identified by a process
// inside it. Returns null on failure — the caller must then abandon the sandbox
// rather than release a tool into a network-less namespace.
export async function attachPasta(
	options: ScoderOptions,
	childPid: number,
	pidFile: string,
): Promise<PastaSidecar | null> {
	const args = buildPastaArgs(options, pidFile);

	let proc = Bun.spawn([...args, childPid.toString()], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	let stderr = await new Response(proc.stderr).text();

	// EM: See isIpv6RoutabilityFailure — retried once, not predicted ahead
	// EM: of time, since pasta's own determination of whether IPv6 is
	// EM: viable is more reliable than anything scoder could check itself
	// EM: beforehand.
	if (proc.exitCode !== 0 && isIpv6RoutabilityFailure(stderr)) {
		warning(
			"pasta could not find a routable IPv6 interface — retrying with --ipv4-only",
		);
		proc = Bun.spawn([...args, "--ipv4-only", childPid.toString()], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		stderr = await new Response(proc.stderr).text();
	}

	if (proc.exitCode !== 0) {
		error(`pasta failed to attach to the sandbox: ${stderr.trim()}`);
		return null;
	}

	const pid = await readPidFile(pidFile);
	if (pid === null) {
		error("pasta attached but wrote no pid file, so it could not be tracked");
		error("Refusing to continue: the sidecar would be left running on exit");
		return null;
	}

	return { pid, pidFile };
}

// ### stopPasta
// Terminate the sidecar and remove its pid file. Safe to call more than once,
// and safe when pasta has already exited.
//
// Signalling and then immediately checking liveness reports a false leak every
// time, because the process has not been reaped yet. So this waits for the exit,
// escalates to SIGKILL if SIGTERM is ignored, and only warns if the process
// genuinely outlives both — which would mean a real leaked sidecar.
export async function stopPasta(sidecar: PastaSidecar | null): Promise<void> {
	if (!sidecar) {
		return;
	}

	const exited = await terminateProcess(
		sidecar.pid,
		TERM_GRACE_MS,
		KILL_GRACE_MS,
	);
	if (!exited) {
		warning(`pasta ${sidecar.pid} survived SIGKILL and is still running`);
	}

	try {
		await unlink(sidecar.pidFile);
	} catch {
		// Never created, or already cleaned up
	}
}

async function readPidFile(pidFile: string): Promise<number | null> {
	try {
		const contents = await Bun.file(pidFile).text();
		const pid = Number.parseInt(contents.trim(), 10);
		return Number.isNaN(pid) ? null : pid;
	} catch {
		return null;
	}
}
