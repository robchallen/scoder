import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScoderOptions } from "../types.ts";
import { error, info } from "../utils/logger.ts";
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
): Promise<LaunchResult> {
	const rendezvous = await mkdtemp(join(tmpdir(), "scoder-launch-"));
	const infoPath = join(rendezvous, "info");
	const blockPath = join(rendezvous, "block");
	const pidFile = join(rendezvous, "pasta.pid");

	let sidecar: PastaSidecar | null = null;

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
			proc.kill();
			await proc.exited;
			return { exitCode: 1 };
		}

		sidecar = await attachPasta(options, childPid, pidFile);
		if (!sidecar) {
			// attachPasta has already explained why. Do not release the tool into
			// a namespace with no route out.
			proc.kill();
			await proc.exited;
			return { exitCode: 1 };
		}

		// Release the sandbox. The shim owns fd 9, so this is a plain write to
		// the fifo rather than anything fd-based on our side.
		await Bun.write(blockPath, "go\n");

		const exitCode = await proc.exited;
		return { exitCode };
	} finally {
		// pasta lives outside the sandbox, so bwrap's --die-with-parent does not
		// reap it. Every exit path has to come through here.
		await stopPasta(sidecar);
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
