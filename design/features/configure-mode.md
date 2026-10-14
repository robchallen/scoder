---
target-version: 2.8.0
status: implemented
tags: [feature, config, sandbox, skills]
---

# Configure Mode (`--configure`)

## Summary

`scoder --configure <agent>` starts an agent session whose job is to set
up the project's `.sandbox/` files (and `.mcp.json`) with the user, guided
by the bundled `configure-scoder-sandbox` skill and the user's markdown
recipes in `~/.config/scoder/recipes/`. The agent edits working copies of
`.sandbox/`, the user's baseline (`~/.config/scoder/sandbox/`) and the
recipes; when the session ends scoder lists each
changed file on the host, validates, applies only if the user accepts
(backing up the recipes first), and then starts the normal session.

An interactive start in a project whose `.sandbox/` is missing any of
`env`, `readonly`, `readwrite`, `ports` or `skills` runs configure first,
automatically.

## Motivation

What a project needs inside the sandbox — toolchain caches, a local model
port, MCP servers, API keys — differs by project and was either hard-coded
for everyone or left for the user to work out from the README. An agent
can look at the project and ask; the user's recipes say what their machine
has. The agent must not be able to widen its own sandbox unseen, so it
never writes the real files.

## Behavior

- **Which agents.** Presets with an initial-prompt form: claude
  (`claude "<p>"`), pi (`pi "<p>"`), opencode (`opencode --prompt "<p>"`),
  copilot (`copilot -i "<p>"`). `--configure` with any other tool is an
  error.
- **When automatic.** Not under `--dry-run`, not nested, only with a
  terminal on stdin and stdout, and only for an agent preset. Otherwise a
  session with missing files runs on the shipped base defaults, as before.
- **Direct mode.** A configure session always runs in the current
  checkout; it is configuring that checkout.
- **Working copy.** `.sandbox/` is copied into the session staging root
  and bound read-write at `.sandbox/`, in place of the usual read-only
  bind. `.mcp.json` is snapshotted before the session.
- **Baseline and recipes.** `~/.config/scoder/sandbox/` and
  `~/.config/scoder/recipes/` (under `$XDG_CONFIG_HOME` when set) are
  staged and bound read-write as working copies, so the agent can refine
  the user's machine-wide grants and recipes with them. The skill reads
  the baseline first and never repeats it in `.sandbox/`. Any number of markdown files, any names; the skill reads them
  all. The starter set (`src/defaults/recipes/`) is written there by file
  name on each real run, never overwriting a file the user has.
  `--configure` never edits the recipes.
- **Note and prompt.** The AGENTS.md overlay says this is a configure
  session; the agent starts with a prompt to use the skill.
- **Skills.** Every skill on the machine is bound, and the list is
  appended to the configure skill (see
  [agent skills](./agents-skills-snapshot.md)); the agent writes
  `.sandbox/skills`.
- **Version control.** `.sandbox/` is expected to be committed. The skill
  asks for a commit before changing it and reminds the user to commit
  after; the recipes, outside any repository, are backed up instead.
- **Review.** After the session: one line per added, removed or modified
  file in `.sandbox/`, the recipes and `.mcp.json` (with line counts);
  validation (the port list parses, `skills` patterns compile,
  `readwrite` lines are under `$HOME`, `readonly` `$HOME` paths exist);
  then "Apply these changes? [y/N]". Invalid or declined: nothing applied
  and `.mcp.json` restored. Accepted: the recipes are backed up
  (`recipes.bak-<timestamp>` beside them) and replaced by their working
  copy if they changed, and the baseline the same way; the working copy replaces
  `.sandbox/` (deleted files removed), any still-missing key file is
  written as an all-comment stub so the next start does not configure
  again, and the original command line is re-run without `--configure`.

## Explicit grants

What a configure session writes is what a session gets: toolchain paths
are no longer bound for everyone.

- **Granted, not implicit:** `~/.m2`, `~/R`, `~/.Rprofile`, `~/.rustup`,
  `~/.cargo/bin`, mise (`~/.local/share/mise`, its shims, `~/.config/mise`),
  uv's tools and pythons, `.npmrc`, `.pypirc` — each only via
  `.sandbox/readonly` or `readwrite`, and no longer refused there as an
  overlap with a fixed bind.
- **`~/.local/bin`** per entry (`$HOME/.local/bin/<name>`) or whole; the
  session's own tool and IDE, when installed there, are always included.
  Symlinks resolve into granted paths (e.g. a uv tool's venv).
- **Skills** are selected in `.sandbox/skills`, not granted in `readonly`
  (a `$HOME/.agents/...` line there is an error); see
  [agent skills](./agents-skills-snapshot.md).
- **Always bound:** system and sandbox mechanics, fonts, themes, icons, GTK
  config, `mimeapps.list`, `~/.gitconfig`, `~/.config/gh`, worktrunk config,
  the presets' own paths, and `--bind`.
- **Eclipse dependency projects.** A read-only `$HOME` grant is passed to
  `-importProject` only if a `.project` is found under it (`find`, hidden
  directories pruned, depth 4, first hit); a Maven/Gradle tree without one
  gets a message instead.
- **Format marker.** Applying a configure session writes
  `.sandbox/version`. A project with config files but no marker predates
  explicit grants and gets a start-up message to run `--configure`.

## Implementation

[IMPLEMENTED_BY](/src/configure/configure.ts)

Wiring is in `src/index.ts` (decision before the presets' `configBinds`,
review and relaunch after the session). `getConfigDirBind` takes the
working copy; `setupProtection` takes the session note. The skills are
embedded via `src/skills.ts`, the recipes via `src/recipes.ts`.

## Tests

`configure-flag-parsed`, `configure-session-dry-run`,
`configure-not-automatic-without-a-terminal`,
`configure-review-applies-only-on-confirm`, `configure-validate-and-apply`,
`configure-relaunch-args`, `configure-session-gets-every-skill-and-the-list`,
`configure-recipes-backed-up-and-applied`, `missing-skills-file-starts-configure`,
`user-config-seeds-starter-recipes`, `toolchain-paths-granted-not-implicit`,
`local-bin-granted-per-entry`,
`eclipse-imports-only-dirs-with-a-project-file`,
`config-predating-grants-warned` — see
[validation-suite](../test-scripts/validation-suite.md) cases 138 and
165-176.

[HAS_FEATURE](./config-defaults.md)
[HAS_FEATURE](./agents-skills-snapshot.md)
[HAS_FEATURE](./agents-md-overlay.md)

[HAS_TEST](../test-scripts/validation-suite.md)
