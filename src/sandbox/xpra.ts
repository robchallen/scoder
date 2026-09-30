import { error, info, warning } from "../utils/logger.ts";
import { terminateProcess } from "../utils/process.ts";
import { sessionPath, stageDir } from "../utils/session.ts";

// EM: The xpra display sidecar
// EM: Implements xpra-gui-isolation: a GUI program in the sandbox draws on a
// EM: virtual X server that exists only inside the sandbox, and its windows are
// EM: forwarded to the host over a unix socket.
//
// EM: Deliberately shaped as pasta.ts's sibling, because it is one: a helper
// EM: process that lives OUTSIDE the sandbox, starts once the sandbox exists,
// EM: and is not covered by bwrap's --die-with-parent, so it must be reaped
// EM: explicitly or every GUI session leaks a client process. The --allow-ssh
// EM: tunnel is the third member of that family; all three share
// EM: terminateProcess.
//
// EM: What it replaces: binding the host's own /tmp/.X11-unix and XAUTHORITY
// EM: into the sandbox, which gave anything inside it the same access to the
// EM: user's real display as any of their own desktop apps — including reading
// EM: the screen and injecting synthetic input into other windows via XTEST,
// EM: verified directly NOT to be blocked by X11's "untrusted" mode. See
// EM: architecture/decision-records/0003-xpra-gui-isolation.md, superseding
// EM: 0002, which accepted that cost when the alternative looked expensive.

/** Grace periods for shutting the client down, before escalating. */
const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 500;

// EM: Sandbox-side paths, in the sandbox's own /tmp tmpfs. A bind's
// EM: mountpoint has to be created, and it cannot be created inside a
// EM: read-only bind, so /run — where an earlier version of this put the
// EM: socket — does not work: `bwrap: Can't mkdir /run/xpra: Read-only file
// EM: system`. That it appeared to work during development was an accident
// EM: worth recording: the xpra package itself ships /run/xpra (root:xpra,
// EM: drwxrwxr-t), so the mountpoint already existed on the machine it was
// EM: tried on, and would have existed on most machines with xpra installed
// EM: — failing only on the ones where systemd-tmpfiles had not run yet.
//
// EM: Short, and deliberately not under $HOME. A unix socket path is usable
// EM: to 107 bytes and fails at 108, and the host side is this path with the
// EM: session root prefixed: /tmp/scoder-<8 hex>/tmp/scoder-xpra/xpra.sock,
// EM: 49 bytes. A $HOME-based destination would have spent much of that
// EM: budget on the username.
export const XPRA_SOCKET_DIR_DEST = "/tmp/scoder-xpra";
export const XPRA_SOCKET_DEST = `${XPRA_SOCKET_DIR_DEST}/xpra.sock`;

// EM: How long to wait for the in-sandbox server to create its socket. The
// EM: spike measured ~3s on a warm machine, so this is not a formality: the
// EM: client is launched from outside and will always lose that race.
// EM: Bounded, for the same reason waitForChildPid is — an unbounded wait
// EM: turns a failed launch into a silent hang with nothing said.
const SOCKET_WAIT_MS = 30_000;
const SOCKET_POLL_MS = 100;

/** A running xpra client rendering a sandbox's windows on the host. */
export interface XpraSidecar {
	pid: number;
	socketPath: string;
}

// ### xpraSocketHostPath
// The host side of the socket the in-sandbox server binds. Mirrors the
// sandbox path under the session root, like every other staged artifact.
export function xpraSocketHostPath(): string {
	return sessionPath(XPRA_SOCKET_DEST);
}

// ### stageXpraSocketDir
// Create the directory the socket will appear in, for binding read-write at
// XPRA_SOCKET_DIR_DEST.
//
// EM: Read-write, unlike almost every other bind scoder makes: the server
// EM: inside the sandbox has to create the socket, and a socket is created by
// EM: the process that binds it. This is the entire surface the GUI gets —
// EM: one directory, which the host side only ever connects to.
export async function stageXpraSocketDir(): Promise<string> {
	return stageDir(XPRA_SOCKET_DIR_DEST);
}

// ### waitForXpraSocket
// Poll for the socket the in-sandbox server creates, bounded. Returns false
// having explained why.
export async function waitForXpraSocket(socketPath: string): Promise<boolean> {
	const deadline = Date.now() + SOCKET_WAIT_MS;

	while (Date.now() < deadline) {
		if (await Bun.file(socketPath).exists()) {
			return true;
		}
		await Bun.sleep(SOCKET_POLL_MS);
	}

	error(
		`xpra server did not create its socket within ${SOCKET_WAIT_MS / 1000}s`,
	);
	error(`expected it at ${socketPath}`);
	error("the GUI will not appear; see /tmp/scoder-xpra.log inside the sandbox");
	return false;
}

// ### buildXpraClientArgs
// [IMPLEMENTS](/design/features/xpra-gui-isolation.md)
// The host-side client's argv. Split out from attachXpraClient so --dry-run
// can describe it without starting anything, the same way buildPastaArgs is.
export function buildXpraClientArgs(socketPath: string): string[] {
	return [
		"xpra",
		"attach",
		`socket://${socketPath}`,
		// EM: The client is a helper the user did not ask for by name, so its
		// EM: own chatter should not land in the middle of their session.
		"--daemon=no",
		// EM: Off for the same reasons the server has them off. Audio: the
		// EM: stack is not wired through the sandbox and produced a steady
		// EM: stream of pactl connection failures. Printing: xpra proxies the
		// EM: host's printer list into the session, which is a capability
		// EM: channel this layer exists to close, not open — observed
		// EM: directly, the client tried to enumerate printers over the
		// EM: system bus unprompted during the end-to-end test.
		"--audio=no",
		"--speaker=no",
		"--microphone=no",
		"--printing=no",
		// EM: The one capability deliberately left ON. X11 passthrough gave the
		// EM: sandbox unrestricted clipboard access along with everything else;
		// EM: proxying it here is the same capability with a name and an off
		// EM: switch, so defaulting it on is not a regression. Worth exposing
		// EM: as a flag later.
		"--clipboard=yes",
	];
}

// ### attachXpraClient
// Start the host-side client once the socket exists. Returns null, having
// explained why, if the socket never appears or the client exits immediately.
export async function attachXpraClient(
	socketPath: string,
): Promise<XpraSidecar | null> {
	if (!(await waitForXpraSocket(socketPath))) {
		return null;
	}

	const proc = Bun.spawn(buildXpraClientArgs(socketPath), {
		env: xpraClientEnv(),
		stdout: "ignore",
		stderr: "pipe",
	});

	// EM: A short settle before declaring success. The failure this catches is
	// EM: the client exiting immediately on a display it cannot use (see
	// EM: xpraClientEnv), which otherwise surfaces as "scoder said the GUI was
	// EM: attached and no window ever appeared" — the client is a background
	// EM: process, so nothing else would report it.
	await Bun.sleep(500);
	if (proc.exitCode !== null) {
		const stderr = (await new Response(proc.stderr).text()).trim();
		error("xpra client exited immediately; the GUI will not appear");
		if (stderr) {
			error(stderr);
		}
		error(`backend tried: GDK_BACKEND=${xpraClientEnv().GDK_BACKEND}`);
		return null;
	}

	info("GUI attached — windows are forwarded from inside the sandbox");
	return { pid: proc.pid, socketPath };
}

// ### xpraClientEnv
// The client's environment, with the GDK backend decided rather than
// inherited.
//
// EM: Found the hard way, and worth the paragraph. xpra's client refuses to
// EM: start with `'client' failed to initialize Gtk, no display?` even with a
// EM: working DISPLAY, a valid XAUTHORITY, and Gtk.init_check() returning True
// EM: when called directly. The cause is in xpra/scripts/main.py:
// EM: set_gdk_backend() sets GDK_BACKEND=wayland whenever is_Wayland() is
// EM: true, and is_Wayland() keys off WAYLAND_DISPLAY merely being *set* —
// EM: whether or not a compositor is actually listening. A stale
// EM: WAYLAND_DISPLAY in the environment therefore forces a Wayland backend
// EM: that cannot initialize, and the resulting error blames the display
// EM: rather than the backend choice.
//
// EM: So the backend is chosen from what is actually reachable, not inherited
// EM: and hoped for: X11 when there is a DISPLAY, Wayland only when there is a
// EM: WAYLAND_DISPLAY and no DISPLAY to fall back to. attachXpraClient reports
// EM: which was tried if the client fails, because upstream's message will
// EM: not.
function xpraClientEnv(): Record<string, string> {
	const env: Record<string, string> = { ...process.env } as Record<
		string,
		string
	>;

	if (process.env.DISPLAY) {
		env.GDK_BACKEND = "x11";
	} else if (process.env.WAYLAND_DISPLAY) {
		env.GDK_BACKEND = "wayland";
	}

	return env;
}

// ### stopXpraClient
// Terminate the client. Safe to call more than once, and safe when the client
// has already exited.
//
// EM: Signalling and immediately checking liveness reports a false leak every
// EM: time, because the process has not been reaped yet — the same trap
// EM: stopPasta documents. So this waits for the exit, escalates to SIGKILL,
// EM: and only warns if the process outlives both.
export async function stopXpraClient(
	sidecar: XpraSidecar | null,
): Promise<void> {
	if (!sidecar) {
		return;
	}

	const exited = await terminateProcess(
		sidecar.pid,
		TERM_GRACE_MS,
		KILL_GRACE_MS,
	);
	if (!exited) {
		warning(`xpra client ${sidecar.pid} survived SIGKILL and is still running`);
	}
}
