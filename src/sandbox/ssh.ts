import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { hostname, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { BindMount } from "../types.ts";
import { error, warning } from "../utils/logger.ts";
import { terminateProcess } from "../utils/process.ts";

// EM: The ssh ControlMaster tunnel sidecar
// EM: Implements ssh-tunnel-access via a single pre-authenticated ssh
// EM: connection, opened outside the sandbox and multiplexed in via one
// EM: bound unix socket. See design/implementation/plans/ssh-tunnel-opt-in.md.
//
// EM: Runs OUTSIDE the sandbox, like pasta (src/sandbox/pasta.ts). Its
// EM: lifetime is independent of the sandbox: bwrap's --die-with-parent does
// EM: not reap it, so scoder must stop it explicitly on exit.
//
// EM: No SSH_AUTH_SOCK, no agent, no known_hosts, no host ~/.ssh. The sandbox
// EM: only ever sees the one already-authenticated connection scoder opened,
// EM: and only for the exact user@host it was asked for — anything else
// EM: falls through to a normal, failing ssh connection attempt.

const SCODER_HOME = "/home/scoder";
const CONTROL_DIR_DEST = `${SCODER_HOME}/.ssh-control`;
const SSH_CONFIG_DEST = `${SCODER_HOME}/.ssh/config`;
const SSH_DIR_DEST = `${SCODER_HOME}/.ssh`;

/** Bound wait for the master to report itself ready, or to give up. */
const MASTER_READY_TIMEOUT_MS = 10_000;
const MASTER_READY_POLL_MS = 200;

/** Grace periods for shutting the master down, before escalating. */
const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 500;

export interface SshTarget {
	user: string;
	host: string;
}

/** A running ssh master connection, host-side. */
export interface SshTunnel {
	pid: number;
	tempDir: string;
	controlPath: string;
	target: SshTarget;
}

export interface SshAccess {
	binds: BindMount[];
	dirs: string[];
	/** null when produced by describeSshAccess — there is nothing to tear down. */
	tunnel: SshTunnel | null;
}

// ### parseSshTarget
// The CLI already validated the shape (exactly one "@", both sides non-empty).
export function parseSshTarget(raw: string): SshTarget {
	const at = raw.indexOf("@");
	return { user: raw.slice(0, at), host: raw.slice(at + 1) };
}

// ### startSshTunnel
// [IMPLEMENTS](/design/features/ssh-tunnel-access.md)
// Opens the master connection and waits, bounded, for it to become ready.
// Returns null (having reported ssh's stderr) if the master exits first or
// the wait times out — the caller treats null as fatal, not a warning, since
// the destination was named explicitly on the command line.
export async function startSshTunnel(raw: string): Promise<SshAccess | null> {
	const target = parseSshTarget(raw);
	await warnIfLoopback(target);

	const tempDir = await mkdtemp(join(tmpdir(), "scoder-ssh-"));
	const socketDir = join(tempDir, "socket");
	const configDir = join(tempDir, "config");
	await mkdir(socketDir);
	await mkdir(configDir);

	const controlPath = join(socketDir, controlSocketName(target));
	const configPath = join(configDir, "config");
	await Bun.write(configPath, buildSshConfig(target));

	const proc = Bun.spawn(
		[
			"ssh",
			"-M",
			"-N",
			"-o",
			`ControlPath=${controlPath}`,
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=10",
			`${target.user}@${target.host}`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);

	const ready = await waitForMasterReady(proc, controlPath, target);

	if (!ready) {
		const stderrText = await new Response(proc.stderr).text();
		if (proc.exitCode === null) {
			proc.kill();
			await proc.exited;
		}
		await rm(tempDir, { recursive: true, force: true });

		error(`--allow-ssh ${raw} failed to establish a connection`);
		if (stderrText.trim()) {
			error(stderrText.trim());
		}
		error("refusing to start without the ssh access you asked for");
		return null;
	}

	return {
		binds: [
			{ type: "ro-bind", source: socketDir, dest: CONTROL_DIR_DEST },
			{ type: "ro-bind", source: configPath, dest: SSH_CONFIG_DEST },
		],
		dirs: [SSH_DIR_DEST],
		tunnel: { pid: proc.pid, tempDir, controlPath, target },
	};
}

// ### describeSshAccess
// The binds a live tunnel would produce, without opening a connection. Used
// by --dry-run, which must stay side-effect free: launchSandbox only ever
// runs pasta for real, never under --dry-run, and a real ssh connection as a
// dry-run side effect would be a worse regression than an accurate preview.
export function describeSshAccess(_raw: string): SshAccess {
	const placeholder = "<ssh-tunnel-tmp>";

	return {
		binds: [
			{
				type: "ro-bind",
				source: `${placeholder}/socket`,
				dest: CONTROL_DIR_DEST,
			},
			{
				type: "ro-bind",
				source: `${placeholder}/config/config`,
				dest: SSH_CONFIG_DEST,
			},
		],
		dirs: [SSH_DIR_DEST],
		tunnel: null,
	};
}

// ### stopSshTunnel
// Ask the master to exit gracefully, then escalate like stopPasta does. Safe
// to call more than once and safe when the tunnel is null.
export async function stopSshTunnel(tunnel: SshTunnel | null): Promise<void> {
	if (!tunnel) {
		return;
	}

	try {
		const exitProc = Bun.spawn(
			[
				"ssh",
				"-O",
				"exit",
				"-S",
				tunnel.controlPath,
				`${tunnel.target.user}@${tunnel.target.host}`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		await exitProc.exited;
	} catch {
		// Fall through to signal-based teardown below.
	}

	const exited = await terminateProcess(
		tunnel.pid,
		TERM_GRACE_MS,
		KILL_GRACE_MS,
	);
	if (!exited) {
		warning(`ssh tunnel ${tunnel.pid} survived SIGKILL and is still running`);
	}

	await rm(tunnel.tempDir, { recursive: true, force: true });
}

function controlSocketName(target: SshTarget): string {
	return `${target.user}@${target.host}:22.sock`;
}

/** Bound for a fallback connection attempt inside the sandbox to fail by. */
const SANDBOX_FALLBACK_CONNECT_TIMEOUT_S = 5;

// EM: BatchMode and ConnectTimeout are global (Host *) rather than scoped to
// EM: the pinned Host block, so a mismatched destination that doesn't match
// EM: that block at all still fails fast: BatchMode alone suppresses
// EM: interactive prompts but does not bound a slow DNS lookup or TCP
// EM: connect, which is otherwise exactly the kind of hang a fallback
// EM: connection attempt should never produce.
//
// EM: ControlPath is token-templated (%r@%h:%p), not literal, and the Host
// EM: block matches only the one pinned hostname. That combination is what
// EM: makes a wrong user OR a wrong host fall through to a normal, failing
// EM: connection attempt instead of silently riding the tunnel — see Design
// EM: Decision 1 in the plan doc.
function buildSshConfig(target: SshTarget): string {
	return `Host *
	BatchMode yes
	ConnectTimeout ${SANDBOX_FALLBACK_CONNECT_TIMEOUT_S}

Host ${target.host}
	User ${target.user}
	ControlPath ${CONTROL_DIR_DEST}/%r@%h:%p.sock
	ControlMaster no
`;
}

// ### waitForMasterReady
// Races the master becoming reachable via `-O check` against the master
// process exiting first (the ADR-0001-style bounded-wait lesson: an
// unreachable host must not hang the session indefinitely).
async function waitForMasterReady(
	proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
	controlPath: string,
	target: SshTarget,
): Promise<boolean> {
	const deadline = Date.now() + MASTER_READY_TIMEOUT_MS;

	while (Date.now() < deadline) {
		if (proc.exitCode !== null) {
			return false;
		}

		const check = Bun.spawn(
			[
				"ssh",
				"-O",
				"check",
				"-S",
				controlPath,
				`${target.user}@${target.host}`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		await check.exited;

		if (check.exitCode === 0) {
			return true;
		}

		await Bun.sleep(MASTER_READY_POLL_MS);
	}

	return false;
}

// ### warnIfLoopback
// A target that resolves to the machine scoder itself runs on turns
// --allow-ssh into an unsandboxed shell back onto the host. Warned, not
// blocked: blocking would also rule out the one legitimate reason to point
// at loopback, which is testing against a local mock sshd.
async function warnIfLoopback(target: SshTarget): Promise<void> {
	const localAddrs = new Set<string>([
		"127.0.0.1",
		"::1",
		"localhost",
		hostname(),
	]);

	for (const addrs of Object.values(networkInterfaces())) {
		for (const addr of addrs ?? []) {
			localAddrs.add(addr.address);
		}
	}

	let resolved = target.host;
	try {
		resolved = (await lookup(target.host)).address;
	} catch {
		// Leave resolved as the literal host — still checked against the set above.
	}

	if (localAddrs.has(target.host) || localAddrs.has(resolved)) {
		warning(
			`--allow-ssh target ${target.user}@${target.host} resolves to this machine`,
		);
		warning(
			"the sandbox boundary does not apply to a connection back to its own host",
		);
	}
}
