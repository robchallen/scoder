// EM: The xpra version floor
// EM: 6.5.4 raised an AttributeError on every discrete mouse-wheel event (a
// EM: scroll-suppression block calling a client method that does not exist),
// EM: stalling GUI presets for seconds per notch. scoder used to pin 6.5.3,
// EM: the last release without it; 6.5.5 fixes it upstream, so the pin gave
// EM: way to a floor. A floor, not "anything but 6.5.4": one rule, and older
// EM: 6.x releases have nothing this project needs that 6.5.5 lacks. See
// EM: design/implementation/issues/xpra-client-crashes-on-every-discrete-
// EM: scroll-event.md.

export const XPRA_MIN_VERSION = "6.5.5";

// ### parseXpraVersion
// `xpra v6.5.5-r0` (or a dpkg `6.5.5-r0-1`) → [6, 5, 5]; null if unparseable.
export function parseXpraVersion(text: string): number[] | null {
	const m = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

// ### meetsXpraMinimum
export function meetsXpraMinimum(version: number[]): boolean {
	const min = parseXpraVersion(XPRA_MIN_VERSION) as number[];
	for (let i = 0; i < min.length; i++) {
		if (version[i] !== min[i]) {
			return version[i] > min[i];
		}
	}
	return true;
}

// ### installedXpraVersion
// The xpra on PATH, as reported by `xpra --version`; null when absent or
// unreadable.
export async function installedXpraVersion(): Promise<string | null> {
	try {
		const proc = Bun.spawn(["xpra", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		return proc.exitCode === 0 ? out.trim() : null;
	} catch {
		return null;
	}
}
