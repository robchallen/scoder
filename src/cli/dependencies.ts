import { unlink } from "node:fs/promises";
import { error, info, warning } from "../utils/logger.ts";
import {
	installedXpraVersion,
	meetsXpraMinimum,
	parseXpraVersion,
	XPRA_MIN_VERSION,
} from "../utils/xpra-version.ts";

// EM: --install-dependencies
// EM: Implements dependency-installation; see design/features/xpra-gui-isolation.md
//
// EM: bubblewrap and passt come straight from the distro. xpra cannot: checked
// EM: directly against all three archives, Ubuntu 24.04 (noble) universe ships
// EM: 3.1.5+dfsg1 — roughly five years old — and Ubuntu 26.04 (resolute) does
// EM: not package it at all, while the features this depends on (seamless mode
// EM: with --bind to an explicit socket path, --exit-with-children=yes) are
// EM: from the 6.x line. So this step grows a repository-setup stage before the
// EM: install.

const KEY_URL = "https://xpra.org/xpra.asc";
const KEY_PATH = "/usr/share/keyrings/xpra.asc";
const SOURCES_PATH = "/etc/apt/sources.list.d/xpra.sources";
const SOURCES_BASE =
	"https://raw.githubusercontent.com/Xpra-org/xpra/master/packaging/repos";

// EM: The three steps upstream's own get-xpra.sh performs for Debian/Ubuntu,
// EM: reimplemented rather than piped into a root shell.
//
// EM: Deliberate, and the one real decision in this file. `curl https://
// EM: xpra.org/get-xpra.sh | bash` under sudo hands a remote script
// EM: unreviewed root on the user's machine every time the command is run,
// EM: which is a materially different trust posture from `apt-get install`
// EM: against a repository that was configured once. scoder is a sandboxing
// EM: tool; having its own setup command be the least contained thing the
// EM: user runs all week would be an odd place to land. The Debian/Ubuntu
// EM: path is three commands and the other 85 lines of that script handle
// EM: distros scoder does not support anyway.
//
// EM: What this gives up: if upstream changes where the key or the .sources
// EM: files live, this breaks and their script would not. Hence naming the
// EM: exact URLs as constants above, and reporting the failing step rather
// EM: than a bare non-zero exit.
const DISTRO_PACKAGES = ["bubblewrap", "passt"];

// EM: Unpinned now. scoder used to pin xpra to exactly 6.5.3 (priority
// EM: 1001, to allow downgrading an existing 6.5.4), because 6.5.4 broke
// EM: wheel scrolling badly enough to make GUI presets unusable. 6.5.5 fixes
// EM: it, so the current release is installed and checked against
// EM: XPRA_MIN_VERSION instead, and the old pin file — which would otherwise
// EM: hold the machine at 6.5.3 forever — is removed if scoder wrote it.
const XPRA_PIN_PATH = "/etc/apt/preferences.d/scoder-xpra.pref";

// EM: --no-install-recommends, with xpra-x11 named explicitly to pull it back
// EM: in. The `xpra` metapackage Depends on client, client-gtk3, server and
// EM: codecs — all four wanted, since the server runs inside the sandbox and
// EM: the client outside it — but only Recommends xpra-x11, xpra-audio and
// EM: xpra-codecs-extras, and pulls xpra-html5 along for the ride. xpra-x11
// EM: is required (it is the seamless X11 server itself); the audio stack is
// EM: not, and during the spike it produced nothing but a steady stream of
// EM: pactl connection failures in the client log.
const XPRA_PACKAGES = ["xpra", "xpra-x11"];

interface OsRelease {
	id: string;
	codename: string;
}

// ### installDependencies
// [IMPLEMENTS](/design/features/xpra-gui-isolation.md)
// Install everything scoder needs, adding the upstream xpra repository first.
// Never returns — exits with the status the caller should.
export async function installDependencies(): Promise<never> {
	if (process.getuid?.() !== 0) {
		error("--install-dependencies must be run as root");
		error("Usage: sudo scoder --install-dependencies");
		process.exit(1);
	}

	const os = await readOsRelease();

	// EM: Not a hard failure. bubblewrap and passt are packaged essentially
	// EM: everywhere and are what the non-GUI majority of scoder needs; only
	// EM: the GUI presets want xpra. Refusing to install anything because the
	// EM: host is not Debian-derived would be a worse trade than installing
	// EM: what can be installed and saying plainly what was skipped.
	const canAddXpraRepo = os.id === "debian" || os.id === "ubuntu";

	if (canAddXpraRepo) {
		if (!(await addXpraRepository(os.codename))) {
			process.exit(1);
		}
	} else {
		warning(
			`xpra repository setup only covers debian and ubuntu, not '${os.id || "unknown"}'`,
		);
		warning("GUI presets (--ide rstudio, --ide eclipse) need xpra 6.x");
		warning("See https://xpra.org/ for this distribution's instructions");
	}

	const packages = canAddXpraRepo
		? [...DISTRO_PACKAGES, ...XPRA_PACKAGES]
		: DISTRO_PACKAGES;

	// EM: One apt-get transaction rather than one per package group, so a
	// EM: conflict is resolved against the whole set and a failure leaves
	// EM: nothing half-installed.
	info(`Installing: ${packages.join(" ")}`);
	const ok = await run([
		"apt-get",
		"install",
		"-y",
		"--no-install-recommends",
		...packages,
	]);
	if (!ok) {
		process.exit(1);
	}

	// EM: Checked after installing, not assumed: a repository that has not
	// EM: published 6.5.5 for this release yet would otherwise leave a broken
	// EM: xpra in place with a successful exit.
	if (canAddXpraRepo) {
		const version = await installedXpraVersion();
		const parsed = version ? parseXpraVersion(version) : null;
		if (!parsed || !meetsXpraMinimum(parsed)) {
			error(
				`installed xpra is ${version ?? "unreadable"}; scoder needs ${XPRA_MIN_VERSION} or newer`,
			);
			error("the xpra repository may not offer it for this release yet");
			process.exit(1);
		}
		info(`${version} installed`);
	}

	process.exit(0);
}

// ### addXpraRepository
// Key, sources file, `apt-get update`. Returns false having explained why.
async function addXpraRepository(codename: string): Promise<boolean> {
	if (!codename) {
		error("could not determine VERSION_CODENAME from /etc/os-release");
		error("cannot select an xpra repository without it");
		return false;
	}

	info(`Installing the xpra signing key to ${KEY_PATH}`);
	if (!(await run(["curl", "-fsSL", "-o", KEY_PATH, KEY_URL]))) {
		error(`could not download the xpra signing key from ${KEY_URL}`);
		return false;
	}

	// EM: The .sources file is per-codename and lives in upstream's git, not
	// EM: on xpra.org. A codename upstream does not publish (a very new or
	// EM: very old release, or a derivative whose VERSION_CODENAME is its own
	// EM: rather than the Ubuntu one it is built on) 404s here — which is the
	// EM: honest answer, and better than writing a sources file pointing at a
	// EM: suite that does not exist and letting `apt-get update` fail with it.
	const sourcesUrl = `${SOURCES_BASE}/${codename}/xpra.sources`;
	info(`Adding the xpra repository for '${codename}' to ${SOURCES_PATH}`);
	if (!(await run(["curl", "-fsSL", "-o", SOURCES_PATH, sourcesUrl]))) {
		error(`no xpra repository published for '${codename}'`);
		error(`looked for ${sourcesUrl}`);
		return false;
	}

	if (!(await run(["apt-get", "update"]))) {
		error("apt-get update failed after adding the xpra repository");
		return false;
	}

	return await removeStaleXpraPin();
}

// ### removeStaleXpraPin
// Delete the pin earlier scoder versions wrote, so apt can install a fixed
// xpra. Only a file scoder wrote: someone's own pin is reported, not removed.
export async function removeStaleXpraPin(
	path: string = XPRA_PIN_PATH,
): Promise<boolean> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return true;
	}
	const text = await file.text();
	if (!text.includes("Written by scoder --install-dependencies")) {
		warning(`${path} exists and was not written by scoder`);
		warning(
			`it may hold xpra below ${XPRA_MIN_VERSION}; check it if the install fails`,
		);
		return true;
	}
	try {
		await unlink(path);
		info(`Removed the old xpra 6.5.3 pin ${path} (6.5.5 fixes the scroll bug)`);
		return true;
	} catch (err) {
		error(`could not remove ${path}: ${err}`);
		return false;
	}
}

async function readOsRelease(): Promise<OsRelease> {
	try {
		const text = await Bun.file("/etc/os-release").text();
		const field = (name: string): string =>
			text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1].replace(/"/g, "") ??
			"";
		return { id: field("ID"), codename: field("VERSION_CODENAME") };
	} catch {
		return { id: "", codename: "" };
	}
}

// EM: stdio inherited, not captured: apt's progress output is the whole point
// EM: of watching this command run, and curl is quiet unless it fails.
async function run(cmd: string[]): Promise<boolean> {
	const proc = Bun.spawn(cmd, {
		stdout: "inherit",
		stderr: "inherit",
	});
	await proc.exited;
	return proc.exitCode === 0;
}
