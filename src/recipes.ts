import recipe_base from "./defaults/recipes/base.md" with { type: "text" };
import recipe_decision_model from "./defaults/recipes/decision-model.md" with {
	type: "text",
};
import recipe_java from "./defaults/recipes/java.md" with { type: "text" };
import recipe_models_aws from "./defaults/recipes/models-aws.md" with {
	type: "text",
};
import recipe_models_azure from "./defaults/recipes/models-azure.md" with {
	type: "text",
};
import recipe_models_gcp from "./defaults/recipes/models-gcp.md" with {
	type: "text",
};
import recipe_models_local from "./defaults/recipes/models-local.md" with {
	type: "text",
};
import recipe_polyglot from "./defaults/recipes/polyglot.md" with {
	type: "text",
};
import recipe_python from "./defaults/recipes/python.md" with { type: "text" };
import recipe_r from "./defaults/recipes/r.md" with { type: "text" };
import recipe_research_web_search from "./defaults/recipes/research-web-search.md" with {
	type: "text",
};
import recipe_typescript from "./defaults/recipes/typescript.md" with {
	type: "text",
};

// EM: The starter sandbox recipes, carried in the binary. Seeded into the
// EM: user's ~/.config/scoder/ by file name, never overwriting (their edits
// EM: stand); the configure-scoder-sandbox skill reads every markdown file
// EM: there. See design/features/configure-mode.md.
export const STARTER_RECIPES: Record<string, string> = {
	"base.md": recipe_base,
	"decision-model.md": recipe_decision_model,
	"java.md": recipe_java,
	"models-aws.md": recipe_models_aws,
	"models-azure.md": recipe_models_azure,
	"models-gcp.md": recipe_models_gcp,
	"models-local.md": recipe_models_local,
	"polyglot.md": recipe_polyglot,
	"python.md": recipe_python,
	"r.md": recipe_r,
	"research-web-search.md": recipe_research_web_search,
	"typescript.md": recipe_typescript,
};
