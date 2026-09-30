import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { info } from "./logger.ts";

// EM: One temp root per scoder run, replacing the seven independently
// EM: created, independently (or never) cleaned up `/tmp/scoder-*.XXXXXX`
// EM: prefixes this project accumulated — see
// EM: design/implementation/issues/scoder-local-bin-staging-dirs-leak-into-tmp.md
// EM: for what "never" cost: a 374 MB `~/.local/bin` snapshot left behind by
// EM: every invocation, `--dry-run` included, with ~40 observed piling up
// EM: during a single test run.
//
// EM: Inside the root, a staged file's host path mirrors the sandbox-side
// EM: absolute path it will be bound at:
// EM:
// EM:   /tmp/scoder-<id>/etc/resolv.conf        -> /etc/resolv.conf
// EM:   /tmp/scoder-<id>/home/<user>/.agents    -> ~/.agents
// EM:
// EM: so `source = sessionPath(dest)` is an invariant one helper holds,
// EM: rather than each call site independently inventing both halves. It
// EM: also makes a live session inspectable in one place, shaped like the
// EM: sandbox it feeds, and means cleanup is one `rm -rf` that every future
// EM: staged artifact inherits by construction rather than by someone
// EM: remembering to add one.

// EM: Short deliberately, not a UUID. A unix socket path is usable to 107
// EM: bytes and fails at 108 (verified directly), and two of the things
// EM: staged here are sockets: ssh's ControlMaster socket under
// EM: ~/.ssh-control, and (planned) xpra's. A full 36-char UUID leaves only
// EM: ~18 bytes of headroom for a realistic $HOME-based destination, which
// EM: a longer username would spend; 8 hex characters leaves room to spare.
//
// EM: Prefixed rather than a bare id: it keeps the root identifiable as
// EM: scoder's among everything else in /tmp, which a bare hex directory
// EM: would not be — greppable when debugging, and the precondition for
// EM: any future reaper of roots left by killed sessions.
const SESSION_ID = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const SESSION_ROOT = `/tmp/scoder-${SESSION_ID}`;

export function sessionRoot(): string {
	return SESSION_ROOT;
}

// ### sessionPath
// The host path for something that will be bound at `dest` inside the
// sandbox. `dest` must be absolute; the result is the same path under this
// session's root.
export function sessionPath(dest: string): string {
	return `${SESSION_ROOT}${dest}`;
}

// ### hostScratchPath
// For the things that have no sandbox-side path to mirror because they are
// never bound in at all: the `--info-fd`/`--block-fd` fifos and pasta's pid
// file. They live under a reserved `.host/` subtree rather than being
// forced into a mirrored path they do not have.
export function hostScratchPath(...segments: string[]): string {
	return join(SESSION_ROOT, ".host", ...segments);
}

// ### stageDir
// Create (and return) the host directory staging whatever will be bound at
// `dest`. Callers bind `stageDir(dest) -> dest`.
export async function stageDir(dest: string): Promise<string> {
	const path = sessionPath(dest);
	await mkdir(path, { recursive: true });
	return path;
}

// ### stageFile
// The host path staging a file to be bound at `dest`, with its parent
// created. Does not create the file itself — the caller writes it.
export async function stageFile(dest: string): Promise<string> {
	const path = sessionPath(dest);
	await mkdir(dirname(path), { recursive: true });
	return path;
}

// ### stageHostScratchDir
// `hostScratchPath`, created.
export async function stageHostScratchDir(
	...segments: string[]
): Promise<string> {
	const path = hostScratchPath(...segments);
	await mkdir(path, { recursive: true });
	return path;
}

// ### cleanupSession
// Remove everything this run staged. Safe to call more than once, and safe
// to call when nothing was ever staged — the root may not exist.
//
// EM: `force` matters beyond convenience: --dry-run exits before most of a
// EM: session happens, so the root is frequently partial or absent, and a
// EM: cleanup that threw on that would reintroduce the leak it exists to
// EM: fix on exactly the path the original issue called out.
//
// EM: SCODER_KEEP_SESSION_TMP suppresses the removal. Staging is the part of
// EM: a session with no trace left afterwards — what scoder decided to put
// EM: in front of the sandbox is otherwise only visible while it is running,
// EM: and --dry-run in particular now clears up behind itself, so "run it
// EM: and look at what it built" stopped working without an opt-out. The
// EM: validation suite uses it for exactly that.
export async function cleanupSession(): Promise<void> {
	if (process.env.SCODER_KEEP_SESSION_TMP) {
		info(`Keeping session temp root ${SESSION_ROOT} (SCODER_KEEP_SESSION_TMP)`);
		return;
	}
	await rm(SESSION_ROOT, { recursive: true, force: true });
}
