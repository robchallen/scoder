// Bun's `with { type: "text" }` imports, which tsc has no built-in knowledge
// of. The script is a real, shellcheck'able file in the repo; Bun inlines its
// contents at build time, so the compiled single-file binary carries it with
// no runtime asset path to resolve.
declare module "*.sh" {
	const content: string;
	export default content;
}
