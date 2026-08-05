// EM: Process-liveness helpers shared by every sidecar that runs outside the
// EM: sandbox's own lifecycle — pasta, the ssh tunnel, and (on the failure
// EM: path) bwrap's own inner process. None of these are reaped by bwrap's
// EM: --die-with-parent, so each caller must signal and confirm exit itself.

const EXIT_POLL_MS = 20;

/** Signal 0 tests for existence without delivering anything. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function signalProcess(pid: number, sig: "SIGTERM" | "SIGKILL"): void {
	try {
		process.kill(pid, sig);
	} catch {
		// Exited between the liveness check and the signal
	}
}

async function waitForProcessExit(
	pid: number,
	budgetMs: number,
): Promise<boolean> {
	const deadline = Date.now() + budgetMs;

	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) {
			return true;
		}
		await Bun.sleep(EXIT_POLL_MS);
	}

	return !isProcessAlive(pid);
}

// ### terminateProcess
// SIGTERM, wait, escalate to SIGKILL, wait again. Returns true once the
// process is confirmed gone — false means it survived SIGKILL, which the
// caller should treat as worth a warning, not a retry.
export async function terminateProcess(
	pid: number,
	termGraceMs: number,
	killGraceMs: number,
): Promise<boolean> {
	if (!isProcessAlive(pid)) {
		return true;
	}

	signalProcess(pid, "SIGTERM");
	if (await waitForProcessExit(pid, termGraceMs)) {
		return true;
	}

	signalProcess(pid, "SIGKILL");
	return waitForProcessExit(pid, killGraceMs);
}
