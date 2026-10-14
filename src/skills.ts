import configureSkill from "../skills/configure-scoder-sandbox/SKILL.md" with {
	type: "text",
};
import workingSkill from "../skills/working-in-a-scoder-sandbox/SKILL.md" with {
	type: "text",
};

// EM: scoder's own skills, carried in the binary and injected into every
// EM: session — into the ~/.agents snapshot (setupAgentsSnapshot) and, for
// EM: Claude Code, mounted under ~/.claude/skills (the claude preset). Both,
// EM: always: the configure skill also holds the per-IDE MCP setups an agent
// EM: needs in an ordinary session, and its description only triggers on
// EM: configuring or connecting.
export const SCODER_SKILLS: { name: string; text: string }[] = [
	{ name: "working-in-a-scoder-sandbox", text: workingSkill },
	{ name: "configure-scoder-sandbox", text: configureSkill },
];
