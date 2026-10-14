---
name: configure-scoder-sandbox
description: 'Use when the user asks to configure scoder for a project, set up or change `.sandbox/` (env, readonly, readwrite, ports, skills), choose which agent skills a project gets, edit the scoder recipes, connect the agent to an IDE or a host MCP server, or when the session''s AGENTS.md says it is a scoder configure session. Also use when a build or tool fails inside a scoder sandbox because a path, port or environment variable it needs was not granted.'
license: MIT
allowed-tools: Read Bash Grep Glob Write Edit
---

# Configuring a scoder sandbox

scoder runs a project in a sandbox that sees only what the project's
`.sandbox/` grants. This skill is how you set that up with the user: look
at the project, ask what you cannot see, write the **minimal** config, and
explain each line. In a **configure session** (`scoder --configure`), the
`.sandbox/` you edit is a working copy, and so is the recipes directory
`~/.config/scoder/recipes/`: when the session ends, scoder lists each
changed file in one line and applies the lot only if the user accepts
(backing the recipes up first), then starts a normal session. So be
complete, but never quietly generous.

scoder will not bind files that don't exist, but a grant needs to cover
files that already exist AND files that are likely to exist in a project of this
nature in the future (as described in the recipes). An example is `$HOME/.Rprofile`
which may not exist when the sandbox is configured but must be bound if it is
later created. In this case the grant is needed even if the file is missing.

## The files

All in `.sandbox/` at the project root; one entry per line, `#` comments.

| File | Grants |
|---|---|
| `env` | host environment variable **names** passed in when set (`NAME`, or a pattern like `PI_*`). Never values. |
| `readonly` | project-relative paths kept read-only (`.github/`, lockfiles); and `$HOME/...` paths bound read-only (a directory or a single file). |
| `readwrite` | `$HOME/...` directories bound read-write (created if missing). Nothing outside `$HOME`. |
| `ports` | host loopback ports forwarded into the sandbox (a service running on the host). |
| `skills` | regular expressions matched against whole skill names: which of the machine's skills the session's agent gets. Missing: `.*`, all of them. |

Plus `.mcp.json` (the agent's MCP servers), reviewed the same way.

Always bound, never list them: system directories, the project, git,
`~/.gitconfig`, `~/.config/gh`, worktrunk config, fonts, themes, icons,
GTK config, `mimeapps.list`, and the agent's/IDE's own config. Everything
else — toolchains, caches, `~/.local/bin` entries — only if granted here,
and skills only if `skills` selects them.

Grants under `~/.local/bin` go in `readonly`, one per entry:
`$HOME/.local/bin/<tool>` (or the bare directory for all of it). In this
session `~/.local/bin` is visible whole, read-only, so you can inspect it;
other `$HOME` paths are visible only if already granted — ask the user, or
rely on scoder checking on the host that each `readonly` path exists.

**Skills.** scoder finds every skill on the machine — the project's
`.agents/skills`, `.claude/skills`, `.github/skills`, ... and the user's
`~/.agents/skills`, `~/.claude/skills`, `~/.copilot/skills`,
`~/.config/opencode/skills`, `~/.pi/agent/skills` — a project skill
shadowing a user one of the same name. `skills` picks from them, and the
picked ones are bound where the session's agent reads skills. The full
list is at the end of this file ("Skills on this machine"), and in this
session every one of them is available to read. Prefer a few precise
patterns (from the matching recipes, and what the user asks for) to `.*`.
scoder's own skills are always included.

Leave `.sandbox/version` alone (scoder writes it when the changes are
applied).

## Procedure

0. **Commit first.** `.sandbox/` belongs in version control. If it (or
   `.mcp.json`) has uncommitted changes, ask the user to commit them — or
   offer to — before you change anything, so this session's changes can
   be reviewed and undone on their own.
1. **Read the recipes.** Read **every** markdown file in
   `~/.config/scoder/recipes/` — scoder's starter recipes plus any the user
   has written (their own defaults and rules, e.g. which MCP servers or
   skills to turn on for which kind of project). Formats vary; read them as
   prose. The user's own recipes take precedence over the starter ones.
   Each has *When to use*, *Env*, *Ports*, *Read-only binds*, *Read-write
   binds*, *Skills* and *MCP servers* sections. If the user wants to
   change a recipe, or record a new one (say, a set of skills for a kind
   of work), edit or add the file there.
2. **Look at the project before asking.** Build files (`pom.xml`,
   `build.gradle*`, `package.json`, `pyproject.toml`/`uv.lock`,
   `DESCRIPTION`/`*.Rproj`, `Cargo.toml`), lockfiles, an existing
   `.sandbox/` and `.mcp.json`. Decide which recipes apply (several → the
   polyglot recipe).
3. **Ask only what you cannot see**, briefly and together: which IDE (if
   any) they will use with `--ide`; local model or other host services
   (and their ports); which providers/credentials the session needs (names
   only); directories outside the project the work needs, and whether
   read-only (dependencies, references) or read-write (caches, output).
4. **Resolve before granting.** For tools in `~/.local/bin`, check whether
   each entry is a symlink (`ls -l ~/.local/bin/<tool>`, `readlink -f`) and
   grant the entry plus what it needs to run (e.g. a uv tool needs
   `$HOME/.local/share/uv/tools` and `$HOME/.local/share/uv/python`) —
   not the whole directory to be safe. Check each `$HOME/...` path exists.
5. **Write the minimal config** — the base recipe plus the matching ones,
   nothing redundant, nothing already always bound. Keep existing entries
   unless they are clearly wrong; say so if you remove one.
6. **Explain each entry** as you add it, in one line: what it is for, and
   for read-write paths and ports, what it opens up.
7. **MCP servers**: add the matching entries to `.mcp.json` (merge, never
   overwrite), using the setups below; walk the user through any host-side
   step (installing an extension on the host, creating a token).
8. **Finish** by summarising the files you changed, and tell the user to
   exit the session: scoder will list the changes, ask, and start a normal
   session with the result. Remind them to commit `.sandbox/` (and
   `.mcp.json`) afterwards, so the configuration travels with the project
   and the next change shows up as a diff.

## MCP servers

### Known working setups

The entries below are from setups that worked. Adjust names, ports and
tokens; confirm ports against what the IDE's settings show.

#### RStudio: btw

The R side is automatic. Inside the sandbox, scoder overlays the project's
`.Rprofile` with:

```r
if (interactive() && requireNamespace("btw", quietly = TRUE)) {
  btw::btw_mcp_session()
}
```

so every interactive R session in the IDE registers itself with
[mcptools](https://posit-dev.github.io/mcptools/). The agent side runs btw's
MCP server, which connects to that live session. Needs the `btw` package installed in your R
library (`~/R` is bound read-only).

```json
{
  "mcpServers": {
    "r-btw": {
      "type": "stdio",
      "command": "Rscript",
      "args": [
        "-e",
        "btw::btw_mcp_server(tools=btw::btw_tools(c('cran','docs','pkg','env','run','sessioninfo','ide')))"
      ],
      "env": {},
      "directTools": true
    }
  }
}
```

#### VS Code, VSCodium: vscode-mcp-server

The [vscode-mcp-server](https://github.com/Romixof/vscode-mcp-server)
extension runs an MCP server inside the editor. Install it on the host
(the extensions directory is read-only in the sandbox) using the "Install from VSIX..." option, then configure its
API token in the sandboxed editor's settings — they live in scoder's
managed per-project user-data-dir, so set them once per project (or put
them in your host settings before the project's first session, when they
are seeded).

```json
{
  "mcpServers": {
    "vscode-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@next",
        "http://localhost:3400/mcp",
        "--header",
        "Authorization:Bearer <api-token>"
      ],
      "directTools": true
    }
  }
}
```

The api token sits in the project's MCP config, readable by the agent — which
is the point: it is the agent's key to the editor, not a host credential.

It must match whatever is configured in the "vscode-mcp-server" configuration
settings in vscode (search the setting menu for `@ext:Romixo.vscode-mcp-server`
and particularly `vscode-mcp-server.auth.apiKey` and `vscode-mcp-server.auth.mode`).

#### Positron: vscode-mcp-server and btw

Needs the same configuration as both vscode and Rstudio to allow for both
environment access as well as ide interaction. The `btw` "ide" option is Rstudio
specific so not enabled for positron.

```json
{
  "mcpServers": {
    "r-btw": {
      "type": "stdio",
      "command": "Rscript",
      "args": [
        "-e",
        "btw::btw_mcp_server(tools=btw::btw_tools(c('cran','docs','pkg','env','run','sessioninfo')))"
      ],
      "env": {},
      "directTools": true
    },
    "vscode-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@next",
        "http://localhost:3400/mcp",
        "--header",
        "Authorization:Bearer <api-token>"
      ],
      "directTools": true
    }
  }
}
```

#### Eclipse: AssistAI

Control of eclipse by an agent is achieved with the [AssistAI plugin](https://marketplace.eclipse.org/content/assistai-eclipse-ide-mcp-server-ai-agents).
This is installed as normal through its update site and configured through
`Window > Preferences... > AssistAI` where an API token should be generated.

**Finding the port and token yourself** — you usually need not ask the user.
AssistAI keeps its settings in an Eclipse preferences file:

```
cat ~/.eclipse/.metadata/.plugins/org.eclipse.core.runtime/.settings/com.github.gradusnikov.eclipse.plugin.assistai.main.prefs | grep AssistAIMcpHttpToken=
```

If it is not there, look for the same relative path
(`.metadata/.plugins/org.eclipse.core.runtime/.settings/com.github.gradusnikov.eclipse.plugin.assistai.main.prefs`)
under scoder's managed workspace,
`~/.local/share/scoder-eclipse-workspaces/<project>/`. The file says whether
HTTP MCP is enabled, which port it uses (8124 by default) and the generated
token. If HTTP MCP is off or there is no token yet, ask the user to enable it
and generate one under `Window > Preferences... > AssistAI`.

For working in the IDE, the Eclipse-specific endpoints are the useful ones:
`eclipse-ide`, `eclipse-coder`, `eclipse-runner`, `eclipse-context` and
`eclipse-pde` (the others — search, time, webpage reader, git,
memory — duplicate tools you likely have already). After writing the config,
check each endpoint answers an MCP `initialize` call before telling the user
it is set up.

Each endpoint needs an entry like the following:

```json
{
  "mcpServers": {
    "eclipse-ide": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:8124/mcp/eclipse-ide",
        "--allow-http",
        "--header",
        "Authorization:Bearer <api-token>"
      ],
      "directTools": true
    },
    ... more servers ...
  }
}
```

The default set of published MCP endpoints are:

```
http://localhost:8124/mcp/eclipse-ide
http://localhost:8124/mcp/duck-duck-search
http://localhost:8124/mcp/time
http://localhost:8124/mcp/webpage-reader
http://localhost:8124/mcp/memory
http://localhost:8124/mcp/eclipse-coder
http://localhost:8124/mcp/eclipse-runner
http://localhost:8124/mcp/eclipse-context
http://localhost:8124/mcp/eclipse-git
http://localhost:8124/mcp/eclipse-pde
```

#### WebStorm: built-in MCP server

WebStorm has an MCP server built in (Settings → Tools → MCP Server). Its
settings persist in scoder's managed per-project config, so enable it once
per project. Depending on the settings selected there, there is the option to
pick different transports, and copy the configuration but the `.mcp.json` is
as follows:

```json
{
  "mcpServers": {
    "webstorm": {
      "type": "sse",
      "url": "http://127.0.0.1:64542/sse",
      "headers": {
        "IJ_MCP_SERVER_PROJECT_PATH": "<project-path>"
      },
      "directTools": true
    }
  }
}
```

Use the port shown in WebStorm's MCP Server settings. `<project-path>` is
the project's real absolute path — paths inside the sandbox mirror the
host's, so it is the same path on both sides.

#### JupyterLab: jupyter-ai

With `scoder <agent> --ide jupyterlab`, the server runs in this sandbox and
the sandbox's `AGENTS.md` note gives its URL, token and jupyter-ai's MCP
endpoint (`http://localhost:3001/mcp`, when jupyter-ai is installed —
`uv tool install jupyterlab --with jupyter-ai --force`, on the host).
Kernels run here too, so code executed through it stays sandboxed. Do not
point an agent at a Jupyter running **on the host** (a `.sandbox/ports`
forward): its kernels would execute on the host, outside the sandbox.

```json
{
  "mcpServers": {
    "jupyter": {
      "command": "npx",
      "args": ["-y", "mcp-remote@next", "http://localhost:3001/mcp"],
      "directTools": true
    }
  }
}
```


                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        
