import { realpath } from "node:fs/promises";

// EM: Path translation between the host and sandbox namespaces
// EM: Implements the home-canonicalization half of the path-mirroring feature
//
// EM: The sandbox no longer remaps $HOME onto a separate synthetic path — its
// EM: own $HOME is the real host $HOME, bound at the same path on both sides.
// EM: toSandboxPath's job is now narrower: collapse the different spellings a
// EM: host path can have for "home" (the raw $HOME value, and its
// EM: symlink-resolved form when they differ) onto the one spelling that is
// EM: actually bound into the sandbox.

function stripTrailingSlashes(path: string): string {
	return path.replace(/\/+$/, "");
}

// ### getRealHome
// The host home directory, without a trailing slash.
export function getRealHome(): string {
	return stripTrailingSlashes(process.env.HOME || "/home/user");
}

// ### resolveHomePrefixes
// Every host path prefix that should be treated as "the home directory".
// $HOME may itself be a symlink (network homes commonly are), in which case
// `which` and `realpath` return the resolved form while $HOME does not, so
// both spellings have to map into the sandbox.
export async function resolveHomePrefixes(): Promise<string[]> {
	const home = getRealHome();
	const prefixes = [home];

	try {
		const resolved = stripTrailingSlashes(await realpath(home));
		if (resolved !== home) {
			prefixes.push(resolved);
		}
	} catch {
		// Home is unreadable — the unresolved spelling is all we have
	}

	return prefixes;
}

// ### toSandboxPath
// Map a host path into the sandbox namespace.
//
// Every path is mirrored at its own real location (see path-mirroring) —
// including home paths, now that the sandbox's $HOME is the real host
// $HOME rather than a separate synthetic one. The only rewriting left is
// canonicalization: a path spelled via a symlinked $HOME's resolved form
// is rewritten onto the raw $HOME spelling, since that's the one actually
// bound into the sandbox.
export function toSandboxPath(
	hostPath: string,
	realHomes: string | string[],
): string {
	const canonicalHome = getRealHome();
	const homes = (Array.isArray(realHomes) ? realHomes : [realHomes])
		.map(stripTrailingSlashes)
		.filter((home) => home.length > 0)
		// Longest first, so a home nested inside another still maps correctly
		.sort((a, b) => b.length - a.length);

	for (const home of homes) {
		if (hostPath === home) {
			return canonicalHome;
		}
		if (hostPath.startsWith(`${home}/`)) {
			return `${canonicalHome}${hostPath.slice(home.length)}`;
		}
	}

	return hostPath;
}

// ### isUnderAny
// True if `path` is one of `prefixes` or sits beneath one of them.
export function isUnderAny(path: string, prefixes: string[]): boolean {
	for (const prefix of prefixes) {
		const clean = stripTrailingSlashes(prefix);
		if (clean.length === 0) {
			continue;
		}
		if (path === clean || path.startsWith(`${clean}/`)) {
			return true;
		}
	}
	return false;
}
