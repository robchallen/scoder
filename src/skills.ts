import configureSkill from "../skills/configure-scoder-sandbox/SKILL.md" with {
	type: "text",
};
import workingSkill from "../skills/working-in-a-scoder-sandbox/SKILL.md" with {
	type: "text",
};

// EM: scoder's own skills, carried in the binary and added to every
// EM: session's staged skills directory, wherever the agent reads skills
// EM: (src/sandbox/skills.ts). Both, always: the configure skill also holds
// EM: the per-IDE MCP setups an agent needs in an ordinary session, and the
// EM: list of every skill on the machine.
export const SCODER_SKILLS: { name: string; text: string }[] = [
	{ name: "working-in-a-scoder-sandbox", text: workingSkill },
	{ name: "configure-scoder-sandbox", text: configureSkill },
];
