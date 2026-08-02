import { realpath } from "node:fs/promises";

// EM: Path translation between the host and sandbox namespaces
// EM: Implements the home-remapping half of the path-mirroring feature

const SCODER_HOME = "/home/scoder";

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
// Paths outside the home directory are mirrored at their real location
// (see path-mirroring) and returned unchanged. Paths under the home
// directory are rewritten onto /home/scoder, because the sandbox replaces
// /home with a tmpfs containing only the ephemeral scoder home.
export function toSandboxPath(
	hostPath: string,
	realHomes: string | string[],
): string {
	const homes = (Array.isArray(realHomes) ? realHomes : [realHomes])
		.map(stripTrailingSlashes)
		.filter((home) => home.length > 0)
		// Longest first, so a home nested inside another still maps correctly
		.sort((a, b) => b.length - a.length);

	for (const home of homes) {
		if (hostPath === home) {
			return SCODER_HOME;
		}
		if (hostPath.startsWith(`${home}/`)) {
			return `${SCODER_HOME}${hostPath.slice(home.length)}`;
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
