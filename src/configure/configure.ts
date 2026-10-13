import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { readAgentPorts } from "../git/protection.ts";
import {
	CONFIG_DIR,
	parseEnvNames,
	readConfigText,
} from "../git/sandbox-config.ts";
import { error, info } from "../utils/logger.ts";
import { getRealHome } from "../utils/paths.ts";
import { stageDir } from "../utils/session.ts";

// EM: --configure: an agent-guided session that sets up a project's
// EM: .sandbox/ (and .mcp.json) with the user. The agent edits a *working
// EM: copy* of .sandbox/ (bound read-write in place of the real, read-only
// EM: one); when the session ends, scoder — on the host — shows every change,
// EM: validates it with the same parsers a session uses, and applies it only
// EM: if the user accepts; then a normal session is launched. An agent gone
// EM: wrong, or a prompt injection reaching it, cannot widen the sandbox
// EM: without the user seeing exactly what changed.
// EM: See design/features/configure-mode.md.

/** The files whose absence makes an interactive start configure first. */
export const CONFIG_KEY_FILES = ["env", "readonly", "readwrite", "ports"];

// EM: .sandbox/version marks a config written for explicit grants (toolchain
// EM: paths granted per project rather than bound for everyone). A project
// EM: with config but no marker predates that, and is told so at start-up.
export const CONFIG_FORMAT_FILE = "version";
export const CONFIG_FORMAT = "2";

export const CONFIGURE_PROMPT =
	"This is a scoder configure session. Help me configure scoder's sandbox for this project using the configure-scoder-sandbox skill: read my recipes, look at the project, ask me what you cannot see, then write the minimal .sandbox/ files (and .mcp.json entries if needed). When you are done, tell me to exit so scoder can show me the changes.";

/** The line the sandbox's AGENTS.md note carries in a configure session. */
export const CONFIGURE_NOTE =
	"This is a scoder **configure** session. Use the `configure-scoder-sandbox` skill to help the user set up this project's `.sandbox/` files (and `.mcp.json`). `.sandbox/` is writable here — it is a working copy; when the session ends, scoder shows the user every change and applies it only if they accept.";

// ### missingKeyFiles
export async function missingKeyFiles(projectRoot: string): Promise<string[]> {
	const missing: string[] = [];
	for (const name of CONFIG_KEY_FILES) {
		if (!(await Bun.file(`${projectRoot}/${CONFIG_DIR}/${name}`).exists())) {
			missing.push(name);
		}
	}
	return missing;
}

// ### predatesExplicitGrants
// True for a project with .sandbox/ config files but no format marker.
export async function predatesExplicitGrants(
	projectRoot: string,
): Promise<boolean> {
	if (
		await Bun.file(
			`${projectRoot}/${CONFIG_DIR}/${CONFIG_FORMAT_FILE}`,
		).exists()
	) {
		return false;
	}
	return (await missingKeyFiles(projectRoot)).length < CONFIG_KEY_FILES.length;
}

// ### stageWorkingCopy
// A copy of the project's .sandbox/ in the session staging root, at the
// mirrored path, for binding read-write over the real one. Returns its path.
export async function stageWorkingCopy(projectRoot: string): Promise<string> {
	const staged = await stageDir(`${projectRoot}/${CONFIG_DIR}`);
	const real = `${projectRoot}/${CONFIG_DIR}`;
	for (const name of await listFiles(real)) {
		await Bun.write(`${staged}/${name}`, Bun.file(`${real}/${name}`));
	}
	return staged;
}

/** The project's .mcp.json content before the session, or null if absent. */
export async function readMcpJson(projectRoot: string): Promise<string | null> {
	const file = Bun.file(`${projectRoot}/.mcp.json`);
	return (await file.exists()) ? await file.text() : null;
}

export interface ReviewResult {
	changed: boolean;
	applied: boolean;
}

// ### reviewConfigure
// After the configure session: show the changes, validate, ask, apply or
// discard. `confirm` is injectable for tests; the default asks on the
// terminal.
export async function reviewConfigure(
	projectRoot: string,
	staged: string,
	mcpBefore: string | null,
	confirm: (question: string) => Promise<boolean> = askYesNo,
): Promise<ReviewResult> {
	const real = `${projectRoot}/${CONFIG_DIR}`;
	const mcpPath = `${projectRoot}/.mcp.json`;
	const mcpAfter = await readMcpJson(projectRoot);

	const names = [
		...new Set([...(await listFiles(real)), ...(await listFiles(staged))]),
	].sort();
	const changes: string[] = [];
	for (const name of names) {
		const before = await textOrNull(`${real}/${name}`);
		const after = await textOrNull(`${staged}/${name}`);
		if (before !== after) {
			changes.push(unifiedDiff(`${CONFIG_DIR}/${name}`, before, after));
		}
	}
	if (mcpAfter !== mcpBefore) {
		changes.push(unifiedDiff(".mcp.json", mcpBefore, mcpAfter));
	}

	if (changes.length === 0) {
		info("The configure session made no changes.");
		return { changed: false, applied: false };
	}

	console.error("");
	info("Changes from the configure session:");
	for (const change of changes) {
		console.error(change);
	}

	const problems = await validateConfig(dirname(staged));
	if (problems.length > 0) {
		error("These changes cannot be applied as they stand:");
		for (const problem of problems) {
			error(`  ${problem}`);
		}
		await restoreMcp(mcpPath, mcpBefore);
		info("Nothing applied. Run scoder --configure again to fix them.");
		return { changed: true, applied: false };
	}

	if (!(await confirm("Apply these changes? [y/N] "))) {
		await restoreMcp(mcpPath, mcpBefore);
		info("Discarded; .sandbox/ and .mcp.json are as they were.");
		return { changed: true, applied: false };
	}

	await applyWorkingCopy(staged, real);
	info(`Applied to ${real}${mcpAfter !== mcpBefore ? " and .mcp.json" : ""}.`);
	return { changed: true, applied: true };
}

// ### validateConfig
// The same rules a session applies, without exiting: a port list that
// parses, readwrite entries under $HOME, readonly $HOME entries that exist.
// Env names are only warned about, as in a session.
export async function validateConfig(root: string): Promise<string[]> {
	const problems: string[] = [];
	try {
		await readAgentPorts(root);
	} catch (err) {
		problems.push(err instanceof Error ? err.message : String(err));
	}
	parseEnvNames(await readConfigText(root, "env"), `${CONFIG_DIR}/env`);

	const realHome = getRealHome();
	for (const line of lines(await readConfigText(root, "readwrite"))) {
		if (!line.startsWith("$HOME/")) {
			problems.push(
				`${CONFIG_DIR}/readwrite: "${line}" must start with $HOME/`,
			);
		}
	}
	for (const line of lines(await readConfigText(root, "readonly"))) {
		if (
			line.startsWith("$HOME/") &&
			!(await pathExists(`${realHome}/${line.slice("$HOME/".length)}`))
		) {
			problems.push(`${CONFIG_DIR}/readonly: "${line}" does not exist`);
		}
	}
	return problems;
}

// ### applyWorkingCopy
// Make the real .sandbox/ match the working copy — files added, changed and
// removed — then make sure every key file exists, so the relaunched session
// does not start straight back into configure.
export async function applyWorkingCopy(
	staged: string,
	real: string,
): Promise<void> {
	await mkdir(real, { recursive: true });
	const kept = new Set(await listFiles(staged));
	for (const name of kept) {
		await Bun.write(`${real}/${name}`, Bun.file(`${staged}/${name}`));
	}
	for (const name of await listFiles(real)) {
		if (!kept.has(name)) {
			await rm(`${real}/${name}`);
		}
	}
	for (const name of CONFIG_KEY_FILES) {
		const path = `${real}/${name}`;
		if (!(await Bun.file(path).exists())) {
			await Bun.write(path, `# ${CONFIG_DIR}/${name} — nothing granted\n`);
		}
	}
	await Bun.write(`${real}/${CONFIG_FORMAT_FILE}`, `${CONFIG_FORMAT}\n`);
}

// ### relaunchArgs
// The command line to start the normal session with: this one, minus
// --configure. Handles both `bun run src/index.ts ...` and the compiled
// binary, whose argv[1] is its own embedded entry point.
export function relaunchArgs(
	argv: string[] = process.argv,
	execPath: string = process.execPath,
): string[] {
	const rest = argv.slice(1).filter((a) => a !== "--configure");
	if (rest[0]?.startsWith("/$bunfs/")) {
		rest.shift();
	}
	return [execPath, ...rest];
}

async function restoreMcp(path: string, before: string | null): Promise<void> {
	if (before === null) {
		await rm(path, { force: true });
	} else {
		await Bun.write(path, before);
	}
}

async function askYesNo(question: string): Promise<boolean> {
	const answer = prompt(question);
	return /^y(es)?$/i.test((answer ?? "").trim());
}

function lines(content: string): string[] {
	return content
		.split("\n")
		.map((l) => l.split("#")[0]?.trim() ?? "")
		.filter(Boolean);
}

async function listFiles(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir, { withFileTypes: true }))
			.filter((e) => e.isFile())
			.map((e) => e.name);
	} catch {
		return [];
	}
}

async function textOrNull(path: string): Promise<string | null> {
	const file = Bun.file(path);
	return (await file.exists()) ? await file.text() : null;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await Bun.file(path).stat();
		return true;
	} catch {
		return false;
	}
}

// A small line diff for the review: "-"/"+" lines with the file named; not a
// minimal diff, but exact and readable for config files this size.
function unifiedDiff(
	label: string,
	before: string | null,
	after: string | null,
): string {
	const out = [
		`--- ${before === null ? "/dev/null" : `a/${label}`}`,
		`+++ ${after === null ? "/dev/null" : `b/${label}`}`,
	];
	const a = before === null ? [] : before.replace(/\n$/, "").split("\n");
	const b = after === null ? [] : after.replace(/\n$/, "").split("\n");
	const inA = new Set(a);
	const inB = new Set(b);
	for (const line of a) {
		if (!inB.has(line)) out.push(`-${line}`);
	}
	for (const line of b) {
		if (!inA.has(line)) out.push(`+${line}`);
	}
	return out.join("\n");
}
