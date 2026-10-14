# Base: every project

## When to use

Always. Every project starts from this, then adds the recipes for its
languages and tools.

## Env

```
SHELL
EDITOR
VISUAL
NO_COLOR
FORCE_COLOR
GH_TOKEN
GITHUB_TOKEN
```

## Ports

None.

## Read-only binds

Project files the agent should not change — `.sandbox/readonly` lines,
relative to the project root:

```
.github/
.claude/
opencode.json
.gitignore
```

Add the project's lockfiles here (`package-lock.json`, `pnpm-lock.yaml`,
`yarn.lock`, `poetry.lock`, `uv.lock`, `Cargo.lock`, `mise.toml`) — only the
ones that exist.

## Read-write binds

None.

## Skills

`.sandbox/skills` — regular expressions matched against whole skill names,
chosen from the skills on this machine (listed at the end of the
`configure-scoder-sandbox` skill). scoder's own skills are always there.
Collect the patterns the other matching recipes give; add any skill the
user names. Only if the user wants every skill, `.*`.

## MCP servers

None.
