import recipe_base from "./defaults/recipes/base.md" with { type: "text" };
import recipe_java from "./defaults/recipes/java.md" with { type: "text" };
import recipe_polyglot from "./defaults/recipes/polyglot.md" with {
	type: "text",
};
import recipe_python from "./defaults/recipes/python.md" with { type: "text" };
import recipe_r from "./defaults/recipes/r.md" with { type: "text" };
import recipe_research from "./defaults/recipes/research.md" with {
	type: "text",
};
import recipe_typescript from "./defaults/recipes/typescript.md" with {
	type: "text",
};

// EM: The starter sandbox recipes, carried in the binary. Seeded into the
// EM: user's ~/.config/scoder/recipes/ by file name, never overwriting (their edits
// EM: stand); the configure-scoder-sandbox skill reads every markdown file
// EM: there. See design/features/configure-mode.md.
export const STARTER_RECIPES: Record<string, string> = {
	"base.md": recipe_base,
	"java.md": recipe_java,
	"polyglot.md": recipe_polyglot,
	"python.md": recipe_python,
	"r.md": recipe_r,
	"research.md": recipe_research,
	"typescript.md": recipe_typescript,
};
