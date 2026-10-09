---
name: working-in-a-scoder-sandbox
description: 'Use when the current git branch matches `scoder/*`, when `$SCODER_SANDBOX` is `1`, or when the user says you are in a scoder sandbox or scoder worktree (including `--no-worktree` mode). Also use when the user wants to connect the agent to an IDE or MCP server inside a scoder session (RStudio/btw, VS Code, VSCodium, Positron, Eclipse, WebStorm, or a host MCP service), and if you hit an unexpected read-only filesystem error, a broken symlink, or a missing command on a machine that should have it — these are the practical signs of a scoder sandbox now that paths inside it look identical to a normal checkout. Do NOT use for generic Git advice outside scoder or for unrelated sandbox/container environments.'
license: MIT
allowed-tools: Read Bash Grep Glob
---

# Working in a scoder sandbox

scoder sandboxes are permissive by design: they protect against accidents,
not deliberate misuse, and keep a separation between what the agent sees and
what the user sees. This skill covers the behaviour that actually trips
agents up — detection, what's read-only, what to do when something is
missing, and how visibility/commits work — not a full description of scoder
(see the project's own `README.md`/`AGENTS.md` for that, if present).

## Detecting the sandbox

1. If `AGENTS.md` exists it also carries a live, per-session "you are in a
   scoder sandbox" notice injected at the top — if you see that, believe it.
2. `echo $SCODER_SANDBOX` — `1` means you are definitely inside a sandbox.
   This is the only reliable, cheap signal.
3. **Unexpected hard filesystem errors** are often the first real sign when
   1 and 2 are inconclusive (e.g. a sub-process cleared the env): a
   read-only-filesystem error writing somewhere that should be writable, a
   broken symlink pointing outside the project, or a command that "should"
   exist but isn't found. Don't assume the whole checkout is broken —
   suspect the sandbox first and re-check `$SCODER_SANDBOX`.

## What's read-only

- **System paths**: `/usr`, `/bin`, `/lib`, `/etc`, `/opt`, `/sys`, `/run` —
  always read-only. Installing or modifying anything here will fail.
- **Protected project files**: `.github/`, `.gitignore`, lockfiles,
  `.sandbox/readonly` itself, and anything else `.sandbox/readonly` lists, are
  read-only even though the rest of the project tree is writable. A repo
  can relax this (an empty `.sandbox/readonly` removes the defaults) but you
  can't relax it yourself from inside the sandbox.
- **`AGENTS.md`**: always read-only inside the sandbox (overlaid with the
  sandbox notice). Don't try to edit it — ask the user instead.
- **`.sandbox/ports`**: read-only. If you need a localhost port opened (e.g. a
  local LLM/MCP server), ask the user to add it to `.sandbox/ports` or restart
  scoder — you cannot add it yourself.
- **Most of `$HOME`**: only specific things are actually populated — the
  project itself, a curated set of tool configs (git, cargo/rustup, mise, R,
  Maven `.m2`, npm/pypi rc files), and whatever `.sandbox/readonly` explicitly
  adds. Everything else under `$HOME` that exists on the real host may
  simply not be there. An `.sandbox/readwrite` file, if the project has one,
  additionally opens specific `$HOME/...` directories read-write (a
  persistent cache or output location) — you can't add entries to it
  yourself, same as `.sandbox/readonly`.

## If a tool or dependency is missing

**Ask the user to install it — don't try to work around it yourself.**
Only a fixed, curated list of host tools/configs is bound into the sandbox;
anything outside that list (a package manager not in the list, a system
package, a global install) isn't there and can't be installed durably from
inside: system paths are read-only, and most of `$HOME` is a fresh,
per-session filesystem that discards anything you install into an
unbound location the moment the session ends. A `pip install --user` or
`npm install -g` that "succeeds" now may silently vanish next session.

Tell the user what's missing and ask them to install it on the host (or add
its directory via `.sandbox/readonly` if it already lives under their `$HOME`)
rather than spending effort installing it inside the sandbox.

## Networking

- Outbound internet works normally (DNS, API calls).
- Host loopback (`127.0.0.1`) is blocked by default. Only ports listed in
  `.sandbox/ports` are reachable — see above if you need one added.

## The display, if there is one

Only relevant when a GUI IDE is running alongside you (`--ide rstudio`,
`--ide eclipse`, or the IDE as the primary tool).

- **`$DISPLAY` is not the user's desktop.** It points at a virtual X server
  running inside this sandbox. Its windows are forwarded to the user's real
  screen by xpra, but the display itself is private: you cannot see, screenshot
  or send input to anything the user has open outside the sandbox, and nothing
  you run on it can. That is deliberate.
- **X clients you start will work**, and their windows will appear on the
  user's screen alongside the IDE's. Worth knowing before you launch one by
  accident.
- **The IDE's own output is not on the terminal.** It goes to
  `/tmp/scoder-ide.log`, and the xpra server's to `/tmp/scoder-xpra.log`. If
  the user reports the IDE misbehaving, read those rather than asking them to
  re-run it.
- **No window appeared at all?** The xpra server log is the place to look.
  The most common cause is the IDE binary not being reachable inside the
  sandbox — see "If a tool or dependency is missing" above.

## Worktree vs. direct mode

- **Direct mode (`--no-worktree`, default)**: you're in the user's actual checkout.
  Changes are immediate, no commit needed — but also no isolation, and no
  "undo" via worktree removal.
- **Worktree mode (`--worktree`)**: your working directory is a git
  worktree, not the user's real checkout — it lives under
  `$HOME/<parent-of-repo>/worktrees/<repo-name>/scoder`, on branch
  `scoder/<repo-name>`, started from whatever `HEAD` the user launched from
  (not necessarily `main`). Uncommitted edits are invisible to the user's own checkout
  and to `git log`/`git diff` run elsewhere — commit at meaningful
  checkpoints, not just at the end, so progress isn't lost or invisible.

- To pick up upstream changes, use `git fetch origin` then
  `git rebase origin/main` or `git merge origin/main` explicitly — don't
  rely on `git pull`, since the sandbox branch has no upstream configured
  for that. If a rebase/merge conflicts on a file `.sandbox/readonly` protects,
  you can't resolve it yourself (the sandbox copy is read-only) — tell the
  user.

## Where worktrees live, and making your own

Every session — worktree mode *or* direct mode — binds one directory
read-write for worktrees:

```
$HOME/<parent-of-repo>/worktrees/<repo-name>/
```

So a repo at `~/Git/scoder` gets `~/Git/worktrees/scoder/`, and scoder's own
worktree is the `scoder` leaf inside it: `~/Git/worktrees/scoder/scoder`.
It is a sibling of the real checkout, never nested under it, because the
sandbox maps the project at its real path and the two would collide.

**This is the only place a new worktree can go.** Anywhere else — including
git's own default of a sibling directory next to the repo — is outside every
bind, so the worktree is unwritable or invisible from inside the sandbox, and
gone entirely from the next session. Check with `mount` if unsure.

### Creating one with worktrunk (`wt`)

If `wt` is on `PATH`, `wt switch --create <branch>` already puts worktrees in
the right place: scoder sets `WORKTRUNK_WORKTREE_PATH` for the sandbox to
that bound parent plus `{{ branch | sanitize }}`, which overrides whatever
the user's own `~/.config/worktrunk/config.toml` says (that file is bound
read-only, so a host-side template still applies outside the sandbox). Check
with `echo $WORKTRUNK_WORKTREE_PATH`. Branch `feature/auth` therefore lands
at `<parent>/feature-auth` — `sanitize` turns `/` into `-`.

Plain `git worktree add` works too; just give it a path under that parent
yourself.

### Caveats worth knowing before you create one

- **Don't name a branch `scoder`.** Its worktree directory would be
  `<parent>/scoder` — exactly where scoder's own worktree lives. Same for a
  branch that sanitizes to `scoder`.
- **Only repos under `$HOME` line up on both sides.** For a repository
  outside `$HOME` (`/srv/code/proj`, say) scoder relocates the worktrees
  parent under `$HOME` anyway (`$HOME/srv/code/worktrees/proj/`) so the
  sandbox can bind it, while the host's own worktrunk config would resolve
  somewhere else entirely. Inside the sandbox
  `WORKTRUNK_WORKTREE_PATH` still points at the bound parent, so `wt` is
  correct here — but a worktree you create will not be where the user's
  host-side `wt list` expects it. Say so rather than assuming.
- **A worktree you create is yours, not the user's.** It is on a branch the
  user did not ask for, in a directory they may not look at. Tell them the
  path and branch, and don't leave work only there.
- **Removing one**: `wt remove` or `git worktree remove <path>`. Don't
  `rm -rf` it — that leaves a stale registration in the repo's git metadata,
  which the user then has to `git worktree prune` themselves.

## Connecting to an IDE or host MCP server

Users ask for this as "connect to my IDE", "set up MCP for RStudio/VS Code/
WebStorm", or "let the agent drive Eclipse". The setup is mostly a
conversation: you write the agent-side config, and walk the user through the
steps only they can do.

**What you can do** — write the agent's MCP config in the project
(`.mcp.json`, or whatever file this agent reads). **Merge, never overwrite**:
read the existing file first and add or update only the server entries you
are setting up; the user may have others, and the file may be committed.

**What only the user can do** — tell them, step by step:

- Install extensions/plugins **on the host**: the IDE's extensions directory
  is read-only in the sandbox, so an install from inside it vanishes at exit.
- Create or copy API tokens in the IDE's settings, then give you the token
  (or put it in the config themselves).
- For a server on the **host** (not inside the sandbox), add its port to
  `.sandbox/ports` — that file is read-only to you. Port-forwarded host
  services are reached at `localhost:<port>` as usual.
- Restart the agent session (or reload its MCP config) so the new server is
  picked up.

**Where IDE servers are reachable** — with `scoder <agent> --ide <ide>`, the
IDE runs in the *same* sandbox, so its server is on this sandbox's own
`localhost`: no port forwarding needed. Paths mirror the host's, so a
project path in a config is the same on both sides.

**`npx mcp-remote` bridges** download `mcp-remote` on every session unless
npm's cache persists. If start-up is slow, suggest the user add
`$HOME/.npm` to `.sandbox/readwrite`.

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
~/.eclipse/.metadata/.plugins/org.eclipse.core.runtime/.settings/com.github.gradusnikov.eclipse.plugin.assistai.main.prefs
```

If it is not there, look for the same relative path
(`.metadata/.plugins/org.eclipse.core.runtime/.settings/com.github.gradusnikov.eclipse.plugin.assistai.main.prefs`)
under scoder's managed workspace,
`~/.local/share/scoder-eclipse-workspaces/<project>/`. The file says whether
HTTP MCP is enabled, which port it uses (8124 by default) and the generated
token. If HTTP MCP is off or there is no token yet, ask the user to enable it
and generate one under `Window > Preferences... > AssistAI`.

For working in the IDE, the Eclipse-specific endpoints are the useful ones:
`eclipse-ide`, `eclipse-coder`, `eclipse-runner`, `eclipse-context`,
`eclipse-git` and `eclipse-pde` (the others — search, time, webpage reader,
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

## Troubleshooting

**Write failed with a read-only error** — check first whether the path is
one of the categories above (system path, `.sandbox/readonly`-protected,
`AGENTS.md`, `.sandbox/ports`) before assuming the whole worktree is broken.
Running a `mount` command will give you detailed info about what is and what is
not bound, and what is read only.

**A symlink outside the project is broken** — its target almost certainly
isn't bound into the sandbox. Common case: a skill/config directory
symlinked from somewhere not in the curated tool list. Ask the user to add
it via `.sandbox/readonly`, or for them to install/relocate it into a location that is
already bound.

**A command isn't found, or a tool behaves as if unconfigured** — see "If a
tool or dependency is missing" above.

**You need a localhost service reachable** — see "Networking" above; the
user has to add the port to `.sandbox/ports`, you can't.
