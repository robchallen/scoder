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
recipes in `~/.config/scoder/`. The agent edits a working copy; when the
session ends scoder shows every change on the host, validates it, applies
it only if the user accepts, and then starts the normal session.

An interactive start in a project whose `.sandbox/` is missing any of
`env`, `readonly`, `readwrite` or `ports` runs configure first,
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
- **Recipes.** `~/.config/scoder/` (or `$XDG_CONFIG_HOME/scoder/`) is bound
  read-only. Any number of markdown files, any names; the skill reads them
  all. The starter set (`src/defaults/recipes/`) is written there by file
  name on each real run, never overwriting a file the user has.
  `--configure` never edits the recipes.
- **Note and prompt.** The AGENTS.md overlay says this is a configure
  session; the agent starts with a prompt to use the skill.
- **Review.** After the session: a line diff of every changed file in
  `.sandbox/` and of `.mcp.json`; validation (the port list parses,
  `readwrite` lines are under `$HOME`, `readonly` `$HOME` paths exist);
  then "Apply these changes? [y/N]". Invalid or declined: nothing applied
  and `.mcp.json` restored. Accepted: the working copy replaces
  `.sandbox/` (deleted files removed), any still-missing key file is
  written as an all-comment stub so the next start does not configure
  again, and the original command line is re-run without `--configure`.

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
`configure-relaunch-args`, `configure-skill-injected`,
`user-config-seeds-starter-recipes` — see
[validation-suite](../test-scripts/validation-suite.md) cases 138 and
165-171.

[HAS_FEATURE](./config-defaults.md)
[HAS_FEATURE](./agents-skills-snapshot.md)
[HAS_FEATURE](./agents-md-overlay.md)

[HAS_TEST](../test-scripts/validation-suite.md)
