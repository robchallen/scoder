import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindMount } from "../types.ts";
import { getRealHome } from "../utils/paths.ts";

// EM: Sandbox user identity
// EM: Implements the NSS half of path-mirroring's home handling
//
// EM: Setting HOME is not enough. Anything resolving the current user through
// EM: getpwuid()/getgrgid() rather than $HOME reads /etc/passwd and /etc/group,
// EM: and OpenSSH is the notable example — it locates ~/.ssh that way.
//
// EM: /etc is bound read-only from the host, so without this overlay the
// EM: sandbox's uid would resolve through whatever entry the host's own
// EM: passwd/group database happens to have for it (an LDAP-backed system, a
// EM: differing shell/GECOS, or no entry at all under sudo's re-mapped uid).
// EM: This overlay makes that resolution deterministic instead — but the
// EM: identity it describes is now the real one, not a synthetic "scoder"
// EM: user: the sandbox no longer remaps $HOME to a separate namespace, so
// EM: the username and home directory here must match the ones getRealHome()
// EM: and --setenv HOME already use, or getpwuid()-based tools like OpenSSH
// EM: would look for ~<user> under a name/home pair that doesn't resolve.

const SANDBOX_SHELL = "/bin/bash";

// ### getSandboxUsername
// The username the sandbox identity describes. SUDO_USER first, matching
// getSandboxUid/getSandboxGid's own SUDO_* precedence, so `sudo scoder`
// still describes the invoking user rather than root.
export function getSandboxUsername(): string {
	return (
		process.env.SUDO_USER || process.env.USER || process.env.LOGNAME || "user"
	);
}

export interface SandboxIdentity {
	binds: BindMount[];
	/** Temp directory holding the files; remove it at session end. */
	dir: string;
}

// ### getSandboxUid / getSandboxGid
// The ids the sandbox runs as, and which its passwd/group describe. Single
// source of truth: the bwrap --uid/--gid flags and the passwd entry must agree,
// or getpwuid() finds no match and NSS falls through to the host's answer.
//
// SUDO_* first, so `sudo scoder` maps to the invoking user rather than root.
export function getSandboxUid(): string {
	return process.env.SUDO_UID || process.getuid?.().toString() || "1000";
}

export function getSandboxGid(): string {
	return process.env.SUDO_GID || process.getgid?.().toString() || "1000";
}

// ### setupSandboxIdentity
// [IMPLEMENTS](/design/features/path-mirroring.md)
// Write single-entry passwd and group files describing only the sandbox user,
// and return them as read-only binds over /etc/passwd and /etc/group.
//
// These must be applied *after* the /etc read-only bind, which is why they are
// returned as binds rather than written into the base mount list.
export async function setupSandboxIdentity(
	uid: string,
	gid: string,
): Promise<SandboxIdentity> {
	// A unique directory per session: the previous fixed /tmp/bwrap_passwd_<uid>
	// collided between concurrent sessions and could be pre-created by another
	// user on a shared machine.
	const dir = await mkdtemp(join(tmpdir(), "scoder-identity-"));

	const passwdPath = join(dir, "passwd");
	const groupPath = join(dir, "group");
	const username = getSandboxUsername();
	const home = getRealHome();

	// username:password:UID:GID:GECOS:home:shell
	await Bun.write(
		passwdPath,
		`${username}:x:${uid}:${gid}:Sandbox User:${home}:${SANDBOX_SHELL}\n`,
	);

	// groupname:password:GID:members
	await Bun.write(groupPath, `${username}:x:${gid}:\n`);

	return {
		dir,
		binds: [
			{ type: "ro-bind", source: passwdPath, dest: "/etc/passwd" },
			{ type: "ro-bind", source: groupPath, dest: "/etc/group" },
		],
	};
}
