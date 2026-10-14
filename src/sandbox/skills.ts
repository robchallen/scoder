import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { CONFIG_DIR, readConfigText } from "../git/sandbox-config.ts";
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
// The markdown appended to the configure skill: every skill on the machine.
export function candidateList(candidates: SkillCandidate[]): string {
	const rows = candidates.map(
		(c) =>
			`| \`${c.name}\` | ${c.origin} | ${c.description.replace(/\|/g, "\\|")} |`,
	);
	return [
		"## Skills on this machine",
		"",
		"Generated by scoder for this configure session: every skill found in",
		"the project's and the user's skill directories. `.sandbox/skills`",
		"selects from these by name.",
		"",
		"| Name | Found in | Description |",
		"| --- | --- | --- |",
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
		const text = await Bun.file(file).text();
		const m = text.match(/^description:\s*['"]?(.*?)['"]?\s*$/m);
		const d = m?.[1] ?? "";
		return d.length > 140 ? `${d.slice(0, 137)}...` : d;
	} catch {
		return "";
	}
}

// Copy a skill directory, dereferencing symlinks inside it.
async function copyDir(src: string, dest: string): Promise<void> {
	await mkdir(dest, { recursive: true });
	await Bun.spawn(["cp", "-rL", `${src}/.`, dest], {
		stdout: "ignore",
		stderr: "ignore",
	}).exited;
}
