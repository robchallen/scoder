import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
	baselineDir,
	CONFIG_DIR,
	readConfigText,
} from "../git/sandbox-config.ts";
import { SCODER_SKILLS } from "../skills.ts";
import type { BindMount } from "../types.ts";
import { info, warning } from "../utils/logger.ts";
import { stageDir } from "../utils/session.ts";

// EM: Agent skills in the sandbox.
// EM: Every skill on the machine is a candidate: the project's own skill
// EM: directories first, then the user's, found with `find` (following
// EM: symlinks) and deduplicated by name — the first found wins, so a project
// EM: skill shadows a user one of the same name. .sandbox/skills, one regular
// EM: expression per line matched against the whole name, picks the ones
// EM: relevant to this project (the shipped default `.*` keeps them all).
// EM: The chosen skills are copied, symlinks resolved, into one staged
// EM: directory bound read-only where the session's agent reads user skills —
// EM: only there, so `--bind claude pi` gives pi its skills and Claude Code's
// EM: directory is left as the host has it. scoder's own skills are always
// EM: added (a user's skill of the same name wins). A configure session gets
// EM: every candidate, and the list, to choose from.
// EM: See design/features/agents-skills-snapshot.md.
// [IMPLEMENTS](/design/features/agents-skills-snapshot.md)

/**
 * Every directory each agent reads user-level skills from, relative to
 * $HOME, its own first. The skills are bound at the first; the rest are
 * hidden, so the agent sees each selected skill once and nothing else.
 */
export const AGENT_SKILLS_DIRS: Record<string, string[]> = {
	claude: [".claude/skills"],
	pi: [".pi/agent/skills", ".agents/skills"],
	opencode: [".config/opencode/skills", ".claude/skills", ".agents/skills"],
	copilot: [".copilot/skills", ".agents/skills"],
};
/** For any other tool: the cross-agent location. */
export const DEFAULT_SKILLS_DIRS = [".agents/skills"];

const PROJECT_SKILL_DIRS = [
	".agents/skills",
	".claude/skills",
	".github/skills",
	".opencode/skills",
	".pi/skills",
];
const HOME_SKILL_DIRS = [
	".agents/skills",
	".claude/skills",
	".copilot/skills",
	".config/opencode/skills",
	".pi/agent/skills",
];

export interface SkillCandidate {
	name: string;
	/** The skill directory, symlinks resolved. */
	dir: string;
	/** Where it was found: "project", "home", or "scoder". */
	origin: string;
	description: string;
}

// ### discoverSkills
// Every skill on the machine, deduplicated by name, project skills first.
export async function discoverSkills(
	projectRoot: string,
	realHome: string,
): Promise<SkillCandidate[]> {
	const roots = [
		...PROJECT_SKILL_DIRS.map((d) => ({
			dir: `${projectRoot}/${d}`,
			origin: "project",
		})),
		...HOME_SKILL_DIRS.map((d) => ({
			dir: `${realHome}/${d}`,
			origin: "home",
		})),
	];
	const found: SkillCandidate[] = [];
	const names = new Set<string>();
	const dirs = new Set<string>();
	for (const root of roots) {
		for (const skillFile of await findSkillFiles(root.dir)) {
			const name = basename(dirname(skillFile));
			let dir: string;
			try {
				dir = await realpath(dirname(skillFile));
			} catch {
				continue;
			}
			if (names.has(name) || dirs.has(dir)) {
				continue;
			}
			names.add(name);
			dirs.add(dir);
			found.push({
				name,
				dir,
				origin: root.origin,
				description: await readDescription(`${dir}/SKILL.md`),
			});
		}
	}
	return found;
}

// ### readSkillPatterns
// .sandbox/skills: one regular expression per line, # comments allowed,
// each matched against a whole skill name. A line that does not compile is
// warned about and skipped.
export async function readSkillPatterns(
	projectRoot: string,
): Promise<RegExp[]> {
	const patterns: RegExp[] = [];
	for (const line of skillPatternLines(
		await readConfigText(projectRoot, "skills"),
	)) {
		try {
			patterns.push(new RegExp(`^(?:${line})$`));
		} catch {
			warning(
				`${CONFIG_DIR}/skills: ignoring "${line}" — not a regular expression`,
			);
		}
	}
	return patterns;
}

/** The pattern lines of a skills file, for validation. */
export function skillPatternLines(content: string): string[] {
	return content
		.split("\n")
		.map((l) => l.replace(/(^|\s)#.*$/, "").trim())
		.filter(Boolean);
}

export function selectSkills(
	candidates: SkillCandidate[],
	patterns: RegExp[],
): SkillCandidate[] {
	return candidates.filter((c) => patterns.some((p) => p.test(c.name)));
}

// ### setupSkills
// Stage the selected skills (plus scoder's own) and bind them read-only at
// the agent's skills directory. `appendix` is added to a named skill's
// SKILL.md in the staged copy — how a configure session receives the
// candidate list.
export async function setupSkills(
	skills: SkillCandidate[],
	realHome: string,
	skillsDirs: string[],
	appendix?: { skill: string; text: string },
): Promise<BindMount[]> {
	const [skillsDirRel, ...others] = skillsDirs;
	// EM: Through a symlinked skills directory (~/.claude/skills ->
	// EM: ~/.agents/skills is common), bind at its target: bwrap cannot make
	// EM: a mountpoint through a link whose target is not mounted.
	const hostDir = `${realHome}/${skillsDirRel}`;
	let dest = hostDir;
	try {
		if ((await realpath(hostDir)) !== hostDir) {
			dest = await realpath(hostDir);
		}
	} catch {
		// absent: bwrap creates it
	}

	const staged = await stageDir(dest);
	for (const skill of skills) {
		await copyDir(skill.dir, `${staged}/${skill.name}`);
	}
	for (const skill of SCODER_SKILLS) {
		const file = `${staged}/${skill.name}/SKILL.md`;
		if (!(await Bun.file(file).exists())) {
			await Bun.write(file, skill.text);
		}
	}
	if (appendix) {
		const file = `${staged}/${appendix.skill}/SKILL.md`;
		await Bun.write(file, `${await Bun.file(file).text()}\n${appendix.text}`);
	}
	if (skills.length > 0) {
		info(`Skills (~/${skillsDirRel}): ${skills.map((s) => s.name).join(", ")}`);
	}
	const binds: BindMount[] = [{ type: "ro-bind", source: staged, dest }];

	// EM: The agent's other skill directories, hidden behind an empty one —
	// EM: only those that exist on the host, so nothing is created there
	// EM: (a `--bind claude` must not leave a skills directory in ~/.claude).
	for (const rel of others) {
		let other: string;
		try {
			other = await realpath(`${realHome}/${rel}`);
			if (!(await stat(other)).isDirectory()) continue;
		} catch {
			continue;
		}
		if (other === dest) continue;
		binds.push({
			type: "ro-bind",
			source: await stageDir(`/scoder-empty-skills${other}`),
			dest: other,
		});
	}
	return binds;
}

// ### candidateList
// The markdown appended to the configure skill in every session: every
// skill on the machine, and whether this session started with it — so an
// agent asked about a missing skill knows it exists and can be added.
// `selected` is undefined in a configure session, where all are bound.
export function candidateList(
	candidates: SkillCandidate[],
	selected?: SkillCandidate[],
): string {
	const inSession = selected && new Set(selected.map((s) => s.name));
	const rows = candidates.map(
		(c) =>
			`| \`${c.name}\` | ${c.origin} | ${inSession ? (inSession.has(c.name) ? "yes" : "no") : "yes"} | ${c.description.replace(/\|/g, "\\|")} |`,
	);
	return [
		"## Skills on this machine",
		"",
		"Generated by scoder at session start: every skill found in the",
		"project's and the user's skill directories, and whether this session",
		"has it. One marked *no* exists locally but `.sandbox/skills` (or the",
		"baseline's `skills`) does not select it: to add it, add a pattern",
		"matching its name — in a configure session directly, otherwise by",
		"telling the user the line to add on the host. It is then available",
		"after a skills reload, with no restart. (Changes made since start-up",
		"are not reflected in this table.)",
		"",
		"| Name | Found in | In this session | Description |",
		"| --- | --- | --- | --- |",
		...rows,
		"",
	].join("\n");
}

async function findSkillFiles(dir: string): Promise<string[]> {
	try {
		if (!(await stat(dir)).isDirectory()) return [];
	} catch {
		return [];
	}
	const proc = Bun.spawn(
		[
			"find",
			"-L",
			dir,
			"-mindepth",
			"2",
			"-maxdepth",
			"4",
			"-name",
			"SKILL.md",
			"-type",
			"f",
		],
		{ stdout: "pipe", stderr: "ignore" },
	);
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out.split("\n").filter(Boolean).sort();
}

async function readDescription(file: string): Promise<string> {
	try {
		const d = skillDescription(await Bun.file(file).text());
		return d.length > 300 ? `${d.slice(0, 297)}...` : d;
	} catch {
		return "";
	}
}

// ### skillDescription
// A SKILL.md's frontmatter `description`, as one line. Parsed as YAML, so
// block scalars (`description: >` folded, `|` literal) and quoted strings
// come out as their text; reported, a line-matching reader turned every
// `>` description into a bare ">". Frontmatter that is not valid YAML
// (unquoted colons are common) falls back to reading the field by hand,
// including its indented continuation lines.
export function skillDescription(text: string): string {
	const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
	let value: unknown;
	try {
		value = (Bun.YAML.parse(fm) as Record<string, unknown> | null)?.description;
	} catch {
		value = descriptionByHand(fm);
	}
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function descriptionByHand(fm: string): string {
	const lines = fm.split(/\r?\n/);
	const i = lines.findIndex((l) => /^description:/.test(l));
	if (i < 0) return "";
	const first = lines[i].replace(/^description:\s*/, "");
	const rest: string[] = [];
	for (const line of lines.slice(i + 1)) {
		if (!/^\s/.test(line) && line.trim() !== "") break;
		rest.push(line.trim());
	}
	const head = /^[>|][+-]?$/.test(first.trim()) ? "" : first;
	return [head, ...rest].join(" ").replace(/^\s*['"]|['"]\s*$/g, "");
}

// Copy a skill directory, dereferencing symlinks inside it.
async function copyDir(src: string, dest: string): Promise<void> {
	await mkdir(dest, { recursive: true });
	await Bun.spawn(["cp", "-rL", `${src}/.`, dest], {
		stdout: "ignore",
		stderr: "ignore",
	}).exited;
}

const SKILLS_POLL_MS =
	Number.parseInt(process.env.SCODER_SKILLS_POLL_MS || "", 10) || 2000;

// ### watchSkills
// Poll .sandbox/skills and the baseline's skills file; when either changes,
// re-discover and re-select, then make the staged directory (bound
// read-only into the sandbox, so its contents are live there) match:
// newly selected skills copied in, deselected ones removed. scoder's own
// skills are never removed. Returns a function that stops the watch; the
// timer does not keep scoder alive on its own.
export function watchSkills(
	projectRoot: string,
	realHome: string,
	staged: string,
	initial: SkillCandidate[],
): () => void {
	const files = [
		`${projectRoot}/${CONFIG_DIR}/skills`,
		`${baselineDir()}/skills`,
	];
	let current = new Map(initial.map((s) => [s.name, s]));
	let last: string | null = null;
	let busy = false;
	const signature = async () =>
		(
			await Promise.all(
				files.map(async (f) =>
					(await Bun.file(f).exists()) ? await Bun.file(f).text() : "",
				),
			)
		).join("\0");

	const tick = async () => {
		if (busy) return;
		busy = true;
		try {
			const sig = await signature();
			if (last === null) {
				last = sig;
				return;
			}
			if (sig === last) return;
			last = sig;
			const wanted = selectSkills(
				await discoverSkills(projectRoot, realHome),
				await readSkillPatterns(projectRoot),
			);
			const next = new Map(wanted.map((s) => [s.name, s]));
			const scoderNames = new Set(SCODER_SKILLS.map((s) => s.name));
			const added = wanted.filter((s) => !current.has(s.name));
			const removed = [...current.keys()].filter(
				(n) => !next.has(n) && !scoderNames.has(n),
			);
			for (const skill of added) {
				await rm(`${staged}/${skill.name}`, { recursive: true, force: true });
				await copyDir(skill.dir, `${staged}/${skill.name}`);
			}
			for (const name of removed) {
				await rm(`${staged}/${name}`, { recursive: true, force: true });
			}
			for (const skill of SCODER_SKILLS) {
				const file = `${staged}/${skill.name}/SKILL.md`;
				if (!(await Bun.file(file).exists())) {
					await Bun.write(file, skill.text);
				}
			}
			current = next;
			if (added.length + removed.length > 0) {
				info(
					`Skills updated${added.length ? ` +${added.map((s) => s.name).join(" +")}` : ""}${removed.length ? ` -${removed.join(" -")}` : ""} — reload the agent's skills to see them`,
				);
			}
		} catch (err) {
			warning(`Could not update skills: ${err}`);
		} finally {
			busy = false;
		}
	};

	void tick();
	const timer = setInterval(() => void tick(), SKILLS_POLL_MS);
	timer.unref();
	return () => clearInterval(timer);
}
