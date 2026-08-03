import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindMount } from "../types.ts";

// EM: Sandbox user identity
// EM: Implements the NSS half of path-mirroring's home remapping
//
// EM: Setting HOME is not enough. Anything resolving the current user through
// EM: getpwuid()/getgrgid() rather than $HOME reads /etc/passwd and /etc/group,
// EM: and OpenSSH is the notable example — it locates ~/.ssh that way.
//
// EM: Bound from the host, those files resolve the sandbox uid to the developer's
// EM: own account: the home directory would be /home/<user>, which does not exist
// EM: inside the sandbox, and the group name would be the host's. Overlaying
// EM: single-entry files makes the sandbox identity self-consistent and stops the
// EM: host username leaking in through the group name.

const SANDBOX_USER = "scoder";
const SANDBOX_HOME = "/home/scoder";
const SANDBOX_SHELL = "/bin/bash";

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

	// username:password:UID:GID:GECOS:home:shell
	await Bun.write(
		passwdPath,
		`${SANDBOX_USER}:x:${uid}:${gid}:Sandbox User:${SANDBOX_HOME}:${SANDBOX_SHELL}\n`,
	);

	// groupname:password:GID:members
	await Bun.write(groupPath, `${SANDBOX_USER}:x:${gid}:\n`);

	return {
		dir,
		binds: [
			{ type: "ro-bind", source: passwdPath, dest: "/etc/passwd" },
			{ type: "ro-bind", source: groupPath, dest: "/etc/group" },
		],
	};
}
