import { mkdir, stat } from "node:fs/promises";
import { error, info, warning } from "../utils/logger.ts";
import { terminateProcess } from "../utils/process.ts";
import { sessionRoot } from "../utils/session.ts";

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

// EM: The one directory that crosses the boundary, bound at *the same
// EM: absolute path on both sides* — host `/tmp/scoder-<id>/xpra` is sandbox
// EM: `/tmp/scoder-<id>/xpra`. That is not tidiness, it is what makes mmap
// EM: work, and mmap is what makes the GUI usable:
// EM:
// EM: xpra's shared-memory transport has the client create the mmap file and
// EM: send the server its *path*. Across a namespace boundary where the two
// EM: sides see the same file under different names, the server cannot open
// EM: what the client names, so the negotiation fails and every pixel update
// EM: is encoded (h264/vp9/webp) and decoded instead of written to shared
// EM: memory. Reported directly: both IDEs worked but were "too laggy to be
// EM: useable", with scroll events visibly trailing. Verified directly that a
// EM: mirrored path fixes it — `enabled fast read mmap transfers using 2GB
// EM: shared memory area`, where the same session on a non-mirrored path said
// EM: `cannot access mmap file ... Read-only file system`.
// EM:
// EM: Self-mirroring is the degenerate case of the session-temp-root rule
// EM: (host path mirrors the sandbox path it is bound at) and of
// EM: path-mirroring, which this project is built on everywhere else. Under
// EM: the session root rather than a fixed path so two concurrent sessions
// EM: cannot collide on one socket.
// EM:
// EM: Still short: a unix socket path is usable to 107 bytes and fails at
// EM: 108, and `/tmp/scoder-<8 hex>/xpra/xpra.sock` is 35.
export function xpraDir(): string {
	return `${sessionRoot()}/xpra`;
}

// ### xpraSocketPath / xpraMmapPath
// Identical on the host and inside the sandbox — see xpraDir.
export function xpraSocketPath(): string {
	return `${xpraDir()}/xpra.sock`;
}

export function xpraMmapPath(): string {
	return `${xpraDir()}/mmap`;
}

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

// ### stageXpraDir
// Create the shared directory, for binding read-write at the same path.
//
// EM: Read-write, unlike almost every other bind scoder makes: the server
// EM: inside the sandbox creates the socket, and the client outside creates
// EM: the mmap file, so both sides write here. This is the entire surface the
// EM: GUI gets across the boundary — one directory.
export async function stageXpraDir(): Promise<string> {
	const path = xpraDir();
	await mkdir(path, { recursive: true });
	return path;
}

// ### waitForXpraSocket
// Poll for the socket the in-sandbox server creates, bounded. Returns false
// having explained why.
//
// EM: stat(), not Bun.file(path).exists(). Verified directly: `exists()`
// EM: reports **false** for a unix socket — it answers "is there a regular
// EM: file here", not "does this path exist" — so the version of this that
// EM: used it could never succeed, on any machine, and every GUI session
// EM: spent 30s timing out before reporting a socket that was sitting right
// EM: there. Reported from a real Eclipse session whose xpra log said
// EM: `created unix domain sockets: '/tmp/scoder-xpra/xpra.sock'` while
// EM: scoder was still waiting for it.
// EM:
// EM: isSocket() rather than a bare stat, so a leftover regular file at this
// EM: path cannot be mistaken for a live server.
export async function waitForXpraSocket(socketPath: string): Promise<boolean> {
	const deadline = Date.now() + SOCKET_WAIT_MS;

	while (Date.now() < deadline) {
		if (await isSocket(socketPath)) {
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

async function isSocket(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isSocket();
	} catch {
		return false;
	}
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
		// EM: Another capability not wanted here, and also a crash the
		// EM: sandbox would otherwise be one code path away from: xpra 6.5.4's
		// EM: webcam subsystem is what pulls in the import that made an
		// EM: earlier --mmap=no client die with `ModuleNotFoundError: No
		// EM: module named 'xpra.net.mmap.common'`. The package is fine and
		// EM: imports cleanly on its own; it is that subsystem's load path
		// EM: that breaks. Declining the capability avoids it entirely.
		"--webcam=no",
		// EM: The one capability deliberately left ON. X11 passthrough gave the
		// EM: sandbox unrestricted clipboard access along with everything else;
		// EM: proxying it here is the same capability with a name and an off
		// EM: switch, so defaulting it on is not a regression. Worth exposing
		// EM: as a flag later.
		"--clipboard=yes",
		// EM: The performance fix. Both sides name the same path, which is
		// EM: only possible because the directory is bound at the same path on
		// EM: both sides — see xpraDir.
		`--mmap=${xpraMmapPath()}`,
		// EM: The host-side half of the escape hatch described in
		// EM: buildEntrypointInvocation. The client already inherits the
		// EM: host's environment (see xpraClientEnv), so XPRA_* variables
		// EM: reach it without help; this is for flags, which do not.
		...extraClientArgs(),
	];
}

// ### extraClientArgs
// SCODER_XPRA_CLIENT_ARGS, split on whitespace.
//
// EM: Whitespace splitting means a flag value containing a space cannot be
// EM: passed this way. Accepted: this is a tuning hatch for things like
// EM: `--encoding=rgb --video=no`, not a general argv channel, and the
// EM: alternative is a quoting parser nobody asked for. Said here rather
// EM: than discovered.
function extraClientArgs(): string[] {
	const raw = process.env.SCODER_XPRA_CLIENT_ARGS;
	return raw ? raw.split(/\s+/).filter(Boolean) : [];
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

	// EM: Inert while mmap is in use — xpra 6.5.4 will not do both, verified
	// EM: directly — but it costs nothing and it is what makes the
	// EM: alternative transport a single flag away rather than four. See
	// EM: "Two transports, and they are mutually exclusive" in
	// EM: design/features/xpra-gui-isolation.md. A host-set value wins, so
	// EM: this can still be turned off.
	env.XPRA_SCROLL_ENCODING = process.env.XPRA_SCROLL_ENCODING ?? "1";

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
