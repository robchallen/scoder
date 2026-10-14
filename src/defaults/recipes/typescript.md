# TypeScript / JavaScript (Node)

## When to use

The project has `package.json` (and usually `tsconfig.json`).

## Env

`NODE_OPTIONS` only if the project relies on it.

## Ports

A dev server the user runs **on the host** and wants the agent to reach —
its port (e.g. `5173`, `3000`). A dev server started *inside* the sandbox
needs no port entry.

## Read-only binds

The lockfile (`package-lock.json`, `pnpm-lock.yaml` or `yarn.lock`) as a
project-relative line. `$HOME/.npmrc` if the project installs from a
private registry.

## Read-write binds

The package manager's cache, if installs are slow without it:

```
$HOME/.npm
```

(`$HOME/.cache/pnpm` or `$HOME/.yarn` for those managers.) Also helps
`npx`-launched MCP bridges, which otherwise re-download every session.

## Skills

```
typescript.*|node.*|npm.*|vitest.*|jest.*
```

## MCP servers

With `--ide vscode` / `vscodium`: vscode-mcp-server — see the
"VS Code, VSCodium" setup under MCP servers in the
`configure-scoder-sandbox` skill.
