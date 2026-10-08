import { chmod } from "node:fs/promises";
import type { BindMount } from "../types.ts";
import { warning } from "../utils/logger.ts";
import { stageFile } from "../utils/session.ts";

// EM: SCODER_BROWSER: the browser the sandbox opens links with
// EM: A command line (`google-chrome --incognito --no-first-run`) that every
// EM: "open this URL" path inside the sandbox should end up running — so a
// EM: link from VS Code, RStudio, R's browseURL or a CLI tool opens a
// EM: browser started the way the user chose, typically one with no profile
// EM: and no sign-in prompts.
// EM:
// EM: Setting BROWSER alone is not enough, measured against xdg-utils'
// EM: xdg-open: with no desktop environment detected (the sandbox clears
// EM: XDG_CURRENT_DESKTOP) its generic path tries the x-scheme-handler from
// EM: mimeapps.list *before* $BROWSER, and the host's mimeapps.list is bound
// EM: in — so the host's default browser would win, started without the
// EM: user's flags. Hence three pieces: a wrapper script, BROWSER pointing at
// EM: it (Python's webbrowser and similar read BROWSER first), and a
// EM: mimeapps.list whose web defaults name a desktop entry for the wrapper,
// EM: every other association of the host's kept as it is.

/** Where the wrapper lands inside the sandbox — its own tmpfs /tmp. */
export const BROWSER_DEST = "/tmp/scoder-browser";
const DESKTOP_ID = "scoder-browser.desktop";
const WEB_TYPES = [
	"x-scheme-handler/http",
	"x-scheme-handler/https",
	"text/html",
];

export interface BrowserSetup {
	binds: BindMount[];
	dirs: string[];
	env: Record<string, string>;
}

// ### browserSetup
// Stage the wrapper, desktop entry and mimeapps.list for a SCODER_BROWSER
// command. Null when the command is empty.
export async function browserSetup(
	command: string,
	realHome: string,
	sandboxHome: string,
): Promise<BrowserSetup | null> {
	const words = command.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return null;
	}
	if (!Bun.which(words[0])) {
		warning(
			`SCODER_BROWSER: ${words[0]} not found in PATH; links will fail to open`,
		);
	}

	// EM: Each word single-quoted: SCODER_BROWSER is split on whitespace and
	// EM: nothing more, so a `$` or `;` in it stays a literal argument rather
	// EM: than becoming shell inside the sandbox.
	const wrapper = await stageFile(BROWSER_DEST);
	await Bun.write(
		wrapper,
		`#!/bin/sh\nexec ${words.map(shellQuote).join(" ")} "$@"\n`,
	);
	await chmod(wrapper, 0o755);

	const applicationsDir = `${sandboxHome}/.local/share/applications`;
	const desktopDest = `${applicationsDir}/${DESKTOP_ID}`;
	const desktop = await stageFile(desktopDest);
	await Bun.write(
		desktop,
		[
			"[Desktop Entry]",
			"Type=Application",
			"Name=scoder browser",
			`Exec=${BROWSER_DEST} %u`,
			`MimeType=${WEB_TYPES.join(";")};`,
			"NoDisplay=true",
			"",
		].join("\n"),
	);

	const mimeappsDest = `${sandboxHome}/.config/mimeapps.list`;
	const mimeapps = await stageFile(mimeappsDest);
	let hostMimeapps = "";
	try {
		hostMimeapps = await Bun.file(`${realHome}/.config/mimeapps.list`).text();
	} catch {
		// EM: No host file: the staged one holds just the web defaults.
	}
	await Bun.write(mimeapps, withWebDefaults(hostMimeapps, DESKTOP_ID));

	return {
		// EM: Bound after buildExtraBinds' host mimeapps.list, so this mount
		// EM: lands on top of it at the same path.
		binds: [
			{ type: "ro-bind", source: wrapper, dest: BROWSER_DEST },
			{ type: "ro-bind", source: desktop, dest: desktopDest },
			{ type: "ro-bind", source: mimeapps, dest: mimeappsDest },
		],
		dirs: [applicationsDir],
		env: { BROWSER: BROWSER_DEST },
	};
}

// ### withWebDefaults
// The host's mimeapps.list with the web types' defaults replaced by
// `desktopId` under [Default Applications]; every other line kept.
export function withWebDefaults(content: string, desktopId: string): string {
	const lines = content.split("\n");
	const out: string[] = [];
	let section = "";
	let wroteDefaults = false;
	const ours = WEB_TYPES.map((type) => `${type}=${desktopId}`);

	for (const line of lines) {
		const header = line.match(/^\s*\[(.+)\]\s*$/);
		if (header) {
			section = header[1];
			out.push(line);
			if (section === "Default Applications") {
				out.push(...ours);
				wroteDefaults = true;
			}
			continue;
		}
		const key = line.split("=")[0]?.trim();
		if (section === "Default Applications" && WEB_TYPES.includes(key)) {
			continue;
		}
		out.push(line);
	}

	if (!wroteDefaults) {
		if (out.length > 0 && out[out.length - 1] !== "") {
			out.push("");
		}
		out.push("[Default Applications]", ...ours, "");
	}
	return out.join("\n");
}

function shellQuote(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}
