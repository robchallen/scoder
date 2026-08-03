import { unlink } from "node:fs/promises";
import type { ScoderOptions } from "../types.ts";
import { error, warning } from "../utils/logger.ts";

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
const EXIT_POLL_MS = 20;

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
	if (options.llmPorts.length > 0) {
		for (const port of options.llmPorts) {
			args.push("--tcp-ns", port.toString());
		}
	} else {
		args.push("--tcp-ns", "none");
	}

	args.push("--udp-ns", "none");

	return args;
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
	const args = [...buildPastaArgs(options, pidFile), childPid.toString()];

	const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	await proc.exited;

	if (proc.exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
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

	if (isAlive(sidecar.pid)) {
		signal(sidecar.pid, "SIGTERM");

		if (!(await waitForExit(sidecar.pid, TERM_GRACE_MS))) {
			signal(sidecar.pid, "SIGKILL");

			if (!(await waitForExit(sidecar.pid, KILL_GRACE_MS))) {
				warning(`pasta ${sidecar.pid} survived SIGKILL and is still running`);
			}
		}
	}

	try {
		await unlink(sidecar.pidFile);
	} catch {
		// Never created, or already cleaned up
	}
}

/** Signal 0 tests for existence without delivering anything. */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function signal(pid: number, sig: "SIGTERM" | "SIGKILL"): void {
	try {
		process.kill(pid, sig);
	} catch {
		// Exited between the liveness check and the signal
	}
}

async function waitForExit(pid: number, budgetMs: number): Promise<boolean> {
	const deadline = Date.now() + budgetMs;

	while (Date.now() < deadline) {
		if (!isAlive(pid)) {
			return true;
		}
		await Bun.sleep(EXIT_POLL_MS);
	}

	return !isAlive(pid);
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
