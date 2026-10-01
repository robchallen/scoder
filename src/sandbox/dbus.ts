import { readDbusAllowlist } from "../git/protection.ts";
import { commandExists } from "../utils/checks.ts";
import { error, info, warning } from "../utils/logger.ts";
import { terminateProcess } from "../utils/process.ts";
import { stageDir } from "../utils/session.ts";

// EM: The D-Bus filtering proxy
// EM: Implements dbus-isolation; see design/implementation/plans/dbus-proxy.md
//
// EM: xdg-dbus-proxy sits between the sandbox and the host's session bus,
// EM: forwarding only calls to names an allowlist admits. The sandbox gets the
// EM: proxy's socket; it never sees the host's.
//
// EM: A fourth member of the family pasta, the ssh tunnel and the xpra client
// EM: already belong to: a host-side process bwrap's --die-with-parent does not
// EM: reap, so it is terminated explicitly in launchSandbox's finally. It
// EM: differs from the other three in starting *before* bwrap, because the
// EM: socket has to exist for the bind.
//
// EM: The namespace reaper does not cover it, deliberately: the proxy runs on
// EM: the host, outside the sandbox's mount namespace, which is the whole
// EM: point of it.

const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 500;

/** Where the proxy's socket appears inside the sandbox. */
export function dbusSocketDest(uid: string): string {
	return `/run/user/${uid}/bus`;
}

/** A running proxy, host-side. */
export interface DbusProxy {
	pid: number;
	socketPath: string;
}

// ### stageDbusDir
// Host directory holding the proxy socket, under the session root.
//
// EM: Not self-mirrored, unlike the xpra directory: the sandbox-side path is
// EM: scoder's to choose, because DBUS_SESSION_BUS_ADDRESS is set to match.
// EM: Only xpra's mmap file needed both sides to agree on a path.
export async function stageDbusDir(): Promise<string> {
	return stageDir("/dbus");
}

// ### buildDbusProxyArgs
// [IMPLEMENTS](/design/features/dbus-isolation.md)
// The proxy's argv. Split out so --dry-run can describe it without starting
// anything, as buildPastaArgs and buildXpraClientArgs are.
export function buildDbusProxyArgs(
	hostBus: string,
	socketPath: string,
	allowed: string[],
	readyFd: number,
): string[] {
	return [
		"xdg-dbus-proxy",
		`--fd=${readyFd}`,
		hostBus,
		socketPath,
		// EM: Everything after --filter is denied unless named. Order matters:
		// EM: xdg-dbus-proxy applies options positionally to the socket that
		// EM: precedes them.
		"--filter",
		// EM: Logged because a refused call has no symptom of its own — it
		// EM: presents as a menu that does nothing, which is the same class of
		// EM: problem as the xpra scroll bug that took a dozen rounds to find.
		// EM: Without this there is nothing to look at when a user asks why.
		"--log",
		...allowed.map((name) => `--talk=${name}`),
	];
}

// ### startDbusProxy
// Start the proxy and wait for it to report readiness. Returns null, having
// explained why, if it cannot be started.
//
// EM: Readiness comes from the proxy itself writing to --fd, not from polling
// EM: for the socket as waitForXpraSocket has to. Cheaper and exact: there is
// EM: no window in which the socket exists but the proxy is not yet serving
// EM: it.
export async function startDbusProxy(
	hostBus: string,
	socketPath: string,
	allowed: string[],
): Promise<DbusProxy | null> {
	// EM: fd 3, the same convention wrapWithFdShim uses for bwrap's --info-fd.
	// EM: Bun.spawn's stdio is a fixed 3-tuple, so a fourth descriptor has to
	// EM: be opened by a shell wrapper rather than passed directly — the same
	// EM: constraint and the same workaround.
	const args = buildDbusProxyArgs(hostBus, socketPath, allowed, 3);
	const shim = 'exec 3>"$1"; shift; exec "$@"';
	const readyPath = `${socketPath}.ready`;

	await Bun.write(readyPath, "");
	const proc = Bun.spawn(["bash", "-c", shim, "_", readyPath, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});

	// EM: Bounded, for the reason every wait in this project is bounded: an
	// EM: unbounded one turns a failed launch into a silent hang.
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) {
			const stderr = (await new Response(proc.stderr).text()).trim();
			error(`xdg-dbus-proxy exited before it was ready: ${stderr}`);
			return null;
		}
		if ((await Bun.file(readyPath).size) > 0) {
			info(`D-Bus filtered: ${allowed.length} service(s) allowed`);
			return { pid: proc.pid, socketPath };
		}
		await Bun.sleep(50);
	}

	error("xdg-dbus-proxy did not report readiness within 10s");
	proc.kill();
	return null;
}

// ### stopDbusProxy
// Terminate the proxy. Safe to call more than once.
export async function stopDbusProxy(proxy: DbusProxy | null): Promise<void> {
	if (!proxy) {
		return;
	}
	if (!(await terminateProcess(proxy.pid, TERM_GRACE_MS, KILL_GRACE_MS))) {
		warning(`xdg-dbus-proxy ${proxy.pid} survived SIGKILL`);
	}
}

// ### setupDbus
// Start the proxy for a project, or return null when there is nothing to
// proxy. Never throws: no bus is a normal outcome, not a failure.
export async function setupDbus(
	projectRoot: string,
	uid: string,
): Promise<DbusProxy | null> {
	const hostBus = process.env.DBUS_SESSION_BUS_ADDRESS;
	if (!hostBus) {
		// EM: Silent. A build machine has no session bus and nothing about
		// EM: that is degraded; warning here would cry wolf on every headless
		// EM: run.
		return null;
	}

	if (!(await commandExists("xdg-dbus-proxy"))) {
		// EM: Warned, not fatal, and emphatically not a fallback to binding
		// EM: the host socket. xpra's rule — never silently degrade to the
		// EM: mechanism you replaced — applies to the *fallback*; the
		// EM: conclusion differs only because a display is mandatory for a GUI
		// EM: preset and a session bus is not.
		warning("xdg-dbus-proxy not found — the sandbox will have no D-Bus");
		warning("run sudo scoder --install-dependencies");
		return null;
	}

	const allowed = await readDbusAllowlist(projectRoot, false);
	if (allowed.length === 0) {
		info("D-Bus allowlist is empty — the sandbox will have no D-Bus");
		return null;
	}

	const dir = await stageDbusDir();
	return startDbusProxy(hostBus, `${dir}/bus`, allowed);
}
