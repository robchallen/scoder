import { error, info, warning } from "../utils/logger.ts";

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

// EM: Pinned, not merely installed, and to an older release than the one the
// EM: repository offers. xpra 6.5.4 added a duplicate-scroll-suppression block
// EM: whose first line calls a method that does not exist on the client, so
// EM: every discrete scroll event raises an AttributeError and prints a
// EM: traceback on the client's UI thread. The effect is seconds of
// EM: unresponsiveness per wheel notch — bad enough to make a GUI preset
// EM: unusable, and reported as exactly that. Bisected to 6.5.4: 6.5.3 and
// EM: every earlier version checked do not contain the block at all, and
// EM: downgrading to 6.5.3 was confirmed to fix it on the reporting machine.
// EM: See design/implementation/issues/
// EM: xpra-client-crashes-on-every-discrete-scroll-event.md
//
// EM: A pin rather than a one-off version argument because an ordinary
// EM: `apt upgrade` would otherwise put 6.5.4 straight back, silently, and the
// EM: symptom gives no hint that xpra is involved. Priority 1001 is the
// EM: specific thing that makes this work: above 1000 is what permits apt to
// EM: *downgrade* an already-installed package, which a fresh scoder install
// EM: on an existing 6.5.4 system needs.
//
// EM: The package list is explicit rather than a `xpra*` glob so that
// EM: xpra-html5 is left alone — it versions independently (21-r1-1 here) and
// EM: a glob would pin it to a version that does not exist. Pinning a package
// EM: that is not installed is harmless; it only constrains it if it ever is.
const XPRA_VERSION = "6.5.3-r0-1";
const XPRA_PIN_PATH = "/etc/apt/preferences.d/scoder-xpra.pref";
const XPRA_PINNED_PACKAGES = [
	"xpra",
	"xpra-client",
	"xpra-client-gtk3",
	"xpra-server",
	"xpra-x11",
	"xpra-codecs",
	"xpra-codecs-extras",
	"xpra-common",
	"xpra-audio",
	"xpra-audio-server",
];

// EM: --no-install-recommends, with xpra-x11 named explicitly to pull it back
// EM: in. The `xpra` metapackage Depends on client, client-gtk3, server and
// EM: codecs — all four wanted, since the server runs inside the sandbox and
// EM: the client outside it — but only Recommends xpra-x11, xpra-audio and
// EM: xpra-codecs-extras, and pulls xpra-html5 along for the ride. xpra-x11
// EM: is required (it is the seamless X11 server itself); the audio stack is
// EM: not, and during the spike it produced nothing but a steady stream of
// EM: pactl connection failures in the client log.
const XPRA_PACKAGES = [`xpra=${XPRA_VERSION}`, `xpra-x11=${XPRA_VERSION}`];

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
	//
	// EM: --allow-downgrades because a machine that already has 6.5.4 needs
	// EM: exactly that, and apt refuses to go backwards without being told.
	info(`Installing: ${packages.join(" ")}`);
	const ok = await run([
		"apt-get",
		"install",
		"-y",
		"--no-install-recommends",
		"--allow-downgrades",
		...packages,
	]);

	process.exit(ok ? 0 : 1);
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

	return await writeXpraPin();
}

// ### writeXpraPin
// Hold xpra at a version whose scroll handling works. See XPRA_VERSION.
async function writeXpraPin(): Promise<boolean> {
	const pin = [
		"# Written by scoder --install-dependencies. Safe to delete, but read",
		"# this first.",
		"#",
		"# xpra 6.5.4 raises an AttributeError on every discrete mouse-wheel",
		"# event, because a block added in that release calls a client method",
		"# that does not exist. Each raise prints a traceback on the client's",
		"# UI thread, which stalls the GUI for seconds per notch and makes an",
		"# IDE unusable. 6.5.3 does not contain the block at all.",
		"#",
		"# Without this pin an ordinary `apt upgrade` restores 6.5.4 silently,",
		"# and nothing about the symptom suggests xpra is responsible.",
		"#",
		"# Priority above 1000 is what allows apt to downgrade an existing",
		"# install. Remove this file once upstream has fixed it:",
		"#   https://github.com/Xpra-org/xpra",
		"",
		`Package: ${XPRA_PINNED_PACKAGES.join(" ")}`,
		`Pin: version ${XPRA_VERSION}`,
		"Pin-Priority: 1001",
		"",
	].join("\n");

	info(`Pinning xpra to ${XPRA_VERSION} in ${XPRA_PIN_PATH}`);
	try {
		await Bun.write(XPRA_PIN_PATH, pin);
		return true;
	} catch (err) {
		error(`could not write ${XPRA_PIN_PATH}: ${err}`);
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
