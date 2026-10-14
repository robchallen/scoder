# scoder

Sandboxed runner for coding tools using bubblewrap (bwrap) and pasta.

Runs AI coding assistants and developer tools inside a constrained
environment so they cannot modify your host unexpectedly. By default changes
happen directly in your working directory; with `--worktree` they are isolated
on a separate git branch via a worktree.

## Supported tools

| Tool | Preset |
|------|--------|
| `opencode` | Config, data, cache bind-mounts |
| `claude` | Claude Code config bind-mount |
| `copilot` | GitHub Copilot CLI config + data |
| `pi` | Pi Coding Agent config + data |
| *(any)* | Generic sandbox |

| Tool | IDE |
|------|--------|
| `rstudio` | RStudio Desktop config + data, an xpra-forwarded window, and pi's own binds (see below) |
| `eclipse` | Eclipse IDE, an xpra-forwarded window, and a persisted per-project workspace (see below) |
| `vscode` | VS Code, an xpra-forwarded window, and a managed per-project user-data-dir (see below) |
| `vscodium` | VSCodium, set up exactly like `vscode` but with its own paths (see below) |
| `positron` | Positron (Posit's VS Code-based IDE), set up exactly like `vscode` with its own paths (see below) |
| `webstorm` | WebStorm, an xpra-forwarded window, and a managed per-project config and cache (see below) |
| `jupyterlab` | JupyterLab, served inside the sandbox and shown in a browser that also runs inside it (see below) |


GUI presets don't see the host's X server at all. Each runs under an
xpra server inside the sandbox, whose windows are forwarded to the
host over a dedicated unix socket — no host X socket, XAUTHORITY or
DISPLAY crosses the boundary (see
`design/features/xpra-gui-isolation.md`).

**`rstudio`**: If a `*.Rproj` file exists at the project root, `rstudio` opens it
automatically (RStudio Desktop doesn't otherwise pick up the sandbox's
working directory on its own); with none found, it opens the project
directory itself. Passing your own argument (e.g. a specific file)
always overrides this.

**`eclipse`** For scoder to work eclipse must have the import-projects plugin
installed. Scoder creates a persisted, dedicated workspace using the sandbox's
own project path, plus every included project in `.sandbox/readonly` —
so cross-project references resolve correctly, with no
separate step before the IDE opens. `$HOME/.eclipse` is bound in whole,
read-write, so your real preferences and configuration carry over rather
than diverging.

**Requires the
[import-projects plugin](https://github.com/robchallen/eclipse-import-projects-plugin)
installed into your Eclipse first** (`Help > Install New Software...`,
`>= 2.0.0`) — scoder does not install or vendor it. The first time a
project's sandbox workspace is created, scoder also seeds its preferences
from your most recently used real Eclipse workspace (JDT/formatter
settings, keybindings, etc. — instance-scope preferences that live per
workspace, not in `~/.eclipse`), so it isn't blank on first open. See
`design/implementation/plans/eclipse-preset.md` for the full
investigation.

**`vscode`** runs the `code` binary. VS Code supports exactly one running
instance per user-data-directory — that directory holds its singleton
lock, IPC socket and live state — so binding your real
`~/.config/Code` would let a sandboxed window hand itself to your host
editor (or corrupt shared state between two instances). Instead scoder
gives each project its own managed user-data-dir under
`~/.local/share/scoder-vscode-userdata/`, persisted across sessions and
seeded **once** on first use from your real `~/.config/Code/User`
(settings, keybindings, snippets — not live state, not secrets); what
you change in the sandbox stays yours, and nothing is ever copied back.
`~/.vscode/extensions` is bound read-only — install and update
extensions on the host, where the sandbox can't diverge mid-session.
`~/.continue` (the Continue extension's config, sessions and index) is
bound read-write when it exists.
Sign-ins don't persist across sessions: sandboxed secrets are
in-memory by design (see `design/features/secret-storage.md`). The snap
build is refused — install the .deb/.rpm/tarball. To start a project's
VS Code (or Eclipse) state over, see
[`--new-workspace`](#starting-a-projects-ide-state-over---new-workspace).
See `design/implementation/plans/vscode-preset.md` for the full
investigation.

**`vscodium`** is the same preset for VSCodium: it runs `codium`, seeds
from `~/.config/VSCodium/User`, binds `~/.vscode-oss/extensions`
read-only, and keeps its managed user-data-dirs under
`~/.local/share/scoder-vscodium-userdata/`. Nothing of VS Code's is read
or bound, so the two never share state.

**`positron`** is the same again for Positron: it runs `positron`, seeds
from `~/.config/Positron/User`, binds `~/.positron/extensions` read-only,
and keeps its managed user-data-dirs under
`~/.local/share/scoder-positron-userdata/`. `~/.positron-shared` (state
shared between running instances) is not bound. Like `rstudio`, it
overlays the project's `.Rprofile` inside the sandbox with a
`btw::btw_mcp_session()` call (interactive sessions only, when btw is
installed), so `pi` alongside it can drive the live R session.

**`webstorm`** follows the same pattern in JetBrains' terms. Each project
gets `~/.local/share/scoder-webstorm/<project>/`: its `config/` copied
**once** from your newest `~/.config/JetBrains/WebStorm*` (lock and port
files left out), and its `system/` (caches and indexes, kept so the project
isn't re-indexed every session). Plugins come read-only from the matching
`~/.local/share/JetBrains/WebStorm*` — install them on the host. scoder
points WebStorm at all of this by shadowing the install's own
`bin/idea.properties` inside the sandbox with a copy that adds its paths
(your installed file is untouched), and pre-answers the "Trust this
project?" question. Your answers to the licence-agreement and
usage-statistics dialogs are shared by all JetBrains IDEs and stored outside
the config dir, so they are bound read-only from your host
(`~/.java/.userPrefs/jetbrains`, `~/.local/share/JetBrains/consentOptions`). Your host WebStorm can run at the same time. WebStorm writes its
own `.idea/` into the project, as it always does. The snap build is
refused — use the tarball.

**`jupyterlab`** runs `jupyter-lab` (install it with `uv tool install
jupyterlab`, adding plugins with `--with`, e.g. `--with jupyter-ai`). The
server runs inside the sandbox, and so does the browser that shows it:
Jupyter opens your `SCODER_BROWSER` command (required for this preset) in
the sandbox, under xpra like the other GUI presets. Your host's browser is
never used — a page from the sandbox in your everyday browser would share
its `localhost` cookies and could reach host-only services. Nothing is
forwarded in or out; the server is on the sandbox's own
`127.0.0.1:8888` with a token per session. `~/.jupyter` is read-only
(its config runs as code on the host), host kernels are visible
read-only, and lab settings, layouts and Jupyter's data (jupyter-ai's
settings among them) persist per project under
`~/.local/share/scoder-jupyterlab/`, copied once from yours — never your
host's runtime files or notebook-trust secret. The server log goes to the
session log, not the terminal; Ctrl-C ends the session. With
`scoder pi --ide jupyterlab`, the agent is told the server URL, token and
jupyter-ai's MCP endpoint.

## How it works

### Default mode (direct)

1. **Must be in a git repo.** `scoder` refuses to run outside one — there is
   otherwise no undo/audit trail (`git diff`/`git status`) for whatever the
   tool does.
2. Runs the tool in a sandbox **directly in your current working directory**.
   Paths inside the sandbox mirror real absolute paths.
3. No git branch creation, no worktree isolation.
4. `.sandbox/readonly` protection still applies.
5. Starts the tool through `pasta`, which keeps outbound networking available
   while blocking host localhost services such as `127.0.0.1`.
6. No commit on exit — changes are immediate.

### Worktree mode (`-w` / `--worktree`)

1. **Must be in a git repo, with a clean checkout.** `scoder -w` refuses to
   run outside a git repo, and refuses if you have uncommitted changes —
   the worktree is checked out from a commit, so anything not committed
   would be invisible to the agent.
2. Creates a new branch (`scoder/<git-repo-name>`) and a git worktree at
   `$HOME/<parent-of-repo>/worktrees/<repo-path>/scoder` — a visible sibling
   of your project's own location, not a hidden temp path. If you launch
   `scoder` from that existing scoder worktree, it reuses it instead of
   trying to create a new one. Your original checkout is untouched.
3. Launches the tool inside a bubblewrap sandbox operating on the worktree,
   with the same path mirroring and `pasta` networking as direct mode.
4. On exit, commits changes, prints a summary and how to merge or discard.

### Sandbox properties

- **Ephemeral HOME** — a fresh, empty tmpfs each session, populated only by
  explicit binds (the project itself, a curated set of tool configs, and
  anything `.sandbox/readonly` adds). `$HOME` itself is your real home path,
  not a separate one — nothing here is a synthetic identity, but nothing
  persists in it either except what's actually bound in.
- **System read-only** — `/usr`, `/bin`, `/lib`, `/etc` are read-only.
- **Protected infrastructure** — `.github/`, `.claude/`, `opencode.json`,
   `.gitignore`, `package-lock.json`, `poetry.lock`, `Cargo.lock`, `pnpm-lock.yaml`, `yarn.lock`, `mise.toml`
   are read-only by default. The list lives in the project's `.sandbox/readonly`
   (written by a [configure session](#setting-up-a-project---configure),
   or the built-in default when absent);
   the whole `.sandbox/` directory is read-only inside the sandbox (outside
   a configure session, which edits a reviewed working copy).
- **Cleared environment** — the sandbox starts with no host environment
   variables except the names listed in `.sandbox/env` (see
   [environment passthrough](#environment-passthrough-sandboxenv))
   and the few scoder sets itself (see
   [environment variables](#environment-variables)).
- **No host session bus, no host `/run`** — `/run` is a fresh tmpfs, with
   `/run/user/<uid>` created mode `0700`; nothing in the sandbox can reach
   your desktop's D-Bus session or system bus, keyring included. GUI presets
   get a private session bus of their own.
- **Agent skills** — see [skills](#agent-skills-sandboxskills): the
  machine's skills that `.sandbox/skills` selects, plus scoder's own, are
  copied at start (symlinks resolved) and bound read-only where the agent
  reads skills.
- **Sandbox AGENTS.md notice** — the repository `AGENTS.md` seen inside the
  sandbox is overlaid with an extra scoder section so the agent knows it is
  running in an isolated worktree with an ephemeral home. The overlay is
  marked as `--skip-worktree` in git so the agent can use git freely
  (worktree operations, stash, etc.) without seeing a dirty working tree.
- **Tools are granted per project** — toolchains and caches in your home
  directory (`~/R` and `~/.Rprofile`, `~/.m2`, `~/.rustup` and
  `~/.cargo/bin`, mise, uv's tools and pythons, `.npmrc`, `.pypirc`) and
  entries in `~/.local/bin` are bound only when the project's
  `.sandbox/readonly` or `.sandbox/readwrite` lists them — usually written
  by a [configure session](#setting-up-a-project---configure) from your
  recipes. `~/.local/bin` is granted entry by entry
  (`$HOME/.local/bin/hf`), or whole (`$HOME/.local/bin`); the session's own
  tool is always there. A project whose config predates this (no
  `.sandbox/version`) gets a start-up message saying so.
- **Always bound** — `~/.gitconfig`, `~/.config/gh`, worktrunk's config,
  and the tool's and IDE's own config:
  - **Desktop integration**: `~/.local/share/fonts` and
    `~/.config/mimeapps.list` bound read-only, so GUI presets (`rstudio`,
    `eclipse`, `vscode`, `vscodium`, `positron`) render text with the host's real fonts and see
    the host's file-type "open with" associations
- **Minimal `/dev`** — individual real host device nodes only (`null`,
  `zero`, `full`, `urandom`, `random`, `tty`, `pts`, `ptmx`, `fd`), not
  the host's whole `/dev` (which would also expose every raw disk, TPM,
  USB, and other device node on the machine). `/dev/shm` is a fresh
  tmpfs. GUI presets (`rstudio`, `eclipse`, `vscode`, `vscodium`, `positron`) additionally bind
  `/dev/dri`
  for GPU rendering when it exists on the host — needed, not optional,
  for RStudio Desktop specifically (Chromium's GPU process crashes
  outright without it, rather than falling back to software rendering).
- **Clipboard: copy out from the terminal** — programs that copy with OSC 52
  (pi, Claude Code, vim, tmux) reach your terminal's clipboard: scoder binds
  your terminal at `/dev/tty` in the sandbox, which `--new-session` would
  otherwise leave unusable, without re-enabling keystroke injection. Your
  terminal must support OSC 52 (GNOME Terminal does not). `xclip`/`wl-copy`
  do not work yet; see `design/features/clipboard-sharing.md`.
- **Host localhost blocked** — tools run behind `pasta` with host localhost
  forwarding disabled, so host-local TCP services are not reachable
  from the sandbox while outbound networking stays available.
- **Persistent host-loopback ports** — an `.sandbox/ports` file at the project
  root lists ports forwarded into the sandbox (an MCP server, a local
  research-tool API, an LLM endpoint), live-reloaded if edited mid-session.
  If a local OpenAI-compatible API is listening on port `11434` (the Ollama
  default), or port `11435` serves an OpenAI-style `/v1/models`, it is
  auto-detected at startup and appended to `.sandbox/ports` automatically.
  Override the primary probed port with `SCODER_LLM_PORT`. See
  [persistent host-loopback ports](#persistent-host-loopback-ports-an-sandboxports-file)
  below.
- **No ssh access by default** — with `--allow-ssh user@host`, scoder opens a
  single pre-authenticated ssh connection to that one destination outside the
  sandbox and multiplexes only that connection in. See
  [ssh access](#ssh-access---allow-ssh) below.
- **No persistent read-write access outside the project by default** — an
  `.sandbox/readwrite` file at the project root lists `$HOME/...` directories
  to bind read-write, for a persistent cache or analysis output that
  survives session restarts. See
  [persistent read-write access](#persistent-read-write-access-an-sandboxreadwrite-file)
  below.

## Usage

```
scoder [options] <tool> [tool-args...]
```

### Examples

```bash
scoder opencode                   # sandbox opencode in current directory (direct mode)
scoder claude                     # sandbox claude code
scoder copilot                    # sandbox GitHub Copilot CLI
scoder vscode                     # sandbox VS Code (runs the `code` binary)
scoder -w opencode                # isolate changes on a scoder/<repo> branch
scoder pi --ide rstudio           # pi in the terminal, RStudio alongside it
scoder pi --bind claude           # pi, with Claude Code's config in reach
scoder --dry-run opencode         # show bwrap command without running
```

### Options

```
-h, --help              Show help
-V, --version           Show version
-q, --quiet             Suppress informational output
-w, --worktree          Enable git worktree isolation
    --no-worktree       Run directly in current directory (no worktree) (default)
    --allow-ssh USER@HOST  Open a single pre-authenticated ssh connection to
                         USER@HOST outside the sandbox, and expose only that
                         one connection inside it
    --ide NAME          Run preset NAME (rstudio, eclipse, vscode, vscodium,
                         positron, webstorm) as a
                         companion IDE in the same sandbox (see below)
    --bind NAME         Add CLI preset NAME's config binds without
                         launching it; repeatable (see below)
    --new-workspace     Reset this project's managed eclipse/vscode/vscodium/
                         positron/webstorm state
                         before launch (see below)
    --native-display    For a GUI preset, draw on the host's X session
                         directly instead of forwarding windows from a
                         private virtual display (see below)
    --env NAME=VALUE    Set NAME inside the sandbox for this session only;
                         repeatable (see below)
    --configure         Set up this project's .sandbox/ with the agent
                         first (see below)
    --dry-run           Print bwrap command without executing

Setup (run once, with sudo):
    --configure-apparmor    Install the AppArmor profile bwrap needs
                            (Ubuntu 24.04+)
    --install-dependencies  Install bubblewrap, passt and xpra
```

Scoder options normally come before the tool name — anything after it is
the tool's own argv, passed through unparsed: `scoder --allow-ssh
me@remote-host pi`, not `scoder pi --allow-ssh me@remote-host`. Three
are also recognised after it, since that is the natural place to type
them: `--ide`, `--new-workspace`, and `--bind` (the last only when its
value names a preset, so a tool's own `--bind 0.0.0.0` passes through).

### `.sandbox/readonly` file

Protecting workspace infrastructure files or directories can be modified with a
`.sandbox/readonly` file which is formatted like a `.gitignore` file and defines
what paths within the workspace an agent cannot modify (they can still be read).
An empty file will make all workspace files writeable.

Lines beginning with literal `$HOME/` are treated differently: they must point
to an existing directory under the real host home directory, and scoder will
bind that directory read-only into the sandbox at the same path — the
sandbox's own `$HOME` is your real home directory, not a separate one, so no
path rewriting happens. For example, `$HOME/Git/other-project` stays
`$HOME/Git/other-project` inside the sandbox too.

## ssh access (`--allow-ssh`)

By default the sandbox has no ssh access at all: no private keys, no
ssh-agent, nothing under `~/.ssh`. `--allow-ssh me@remote-host` opens a
single pre-authenticated ssh connection to that one destination *outside*
the sandbox, and multiplexes only that connection into it — the sandboxed
agent never sees a private key or an ssh-agent socket, and cannot choose a
different destination.

```bash
scoder --allow-ssh me@remote-host pi   # pi can run: ssh remote-host <command>
```

Inside the sandbox, `ssh remote-host` (and `ssh remote-host <command>`) works
exactly as it would outside it. Any other destination — a different host, a
different user, a different port — fails the way ssh always fails when it
has nothing to authenticate with, because it is not the connection scoder
opened.

**What the flag grants.** For the session's duration, the sandboxed agent can
run commands as **exactly the named user, on exactly the named host** —
nothing else. It cannot reach a different host, authenticate as a different
user, or extract the credentials that made the connection possible.

**This is still real exposure**, just a narrower one than forwarding an
ssh-agent would be: whatever `me@remote-host` can do, the sandboxed agent can
now do, for the session's duration. Use a narrowly-scoped remote account for
whatever administration task is intended, the same as you would running that
command by hand.

**Pointing `--allow-ssh` at the machine scoder itself runs on** (`localhost`,
`127.0.0.1`, or any address that resolves to this host) removes the sandbox
boundary for anything reachable that way — scoder warns when it detects
this, but does not block it, since the one legitimate reason to do it is
testing against a local server.

You must have connected to the target at least once before, outside scoder:
the master connection uses `BatchMode`, so it will not prompt to accept an
unfamiliar host key.



## A companion IDE (`--ide`)

`--ide NAME` launches `NAME` (must have a registered preset — `rstudio`,
`eclipse`, `vscode`, `vscodium`, `positron` and `webstorm`, following the same pattern as other tool presets)
as a companion alongside the primary tool, both inside the *same* sandbox:

```bash
scoder pi --ide rstudio     # rstudio in the background, pi in the foreground
scoder pi --ide eclipse     # eclipse in the background, pi in the foreground
scoder pi --ide vscode      # vscode in the background, pi in the foreground
```

This is `eclipse`'s actual intended use — its own dynamic-workspace
prepare step (see above) runs whether it's the primary tool or the `--ide`
companion.

`NAME` runs in the background, the primary tool in the foreground
(connected to your terminal, same as running it alone), and both must
exit before scoder shuts down — closing the primary tool alone leaves the
IDE running and scoder still waiting; closing the IDE alone leaves the
primary tool running as normal. `--ide` works either before or after the
primary tool's name (`scoder --ide rstudio pi` and `scoder pi --ide
rstudio` are equivalent).

Since both run in the same sandbox, this is the shape that makes bridging
an agent and an IDE via MCP (e.g. `pi` and RStudio via `btw`/`mcptools`)
actually safe: both processes share one project, one filesystem view, one
set of restrictions — nothing crosses the sandbox boundary at all, unlike
connecting to an IDE running natively on the host. The `rstudio` preset
also sets `MCPTOOLS_SOCKET_DIR` to a writable sandbox path, so
`mcptools::mcp_session()`/`mcp_server()` agree on a socket directory out
of the box. (mcptools' own default, `$XDG_RUNTIME_DIR/mcptools`, also works
now — `/run/user/<uid>` is a private, writable directory inside the
sandbox — which is why Positron needs no such setting.)

A companion IDE's output goes to a log file rather than your terminal.
scoder prints where at startup — for example `IDE log on the host:
/tmp/scoder-1a2b3c4d/tmp/scoder-ide.log` (or `xpra log on the host:` when
xpra is running, which carries the IDE's output too). It is the place to
look when an IDE window never appears. The file is removed when the
session ends; set `SCODER_KEEP_SESSION_TMP=1` to keep it.

**Why `eclipse` needs the import-projects plugin.** scoder gives each
project its own persistent Eclipse workspace (under
`~/.local/share/scoder-eclipse-workspaces/`) and seeds its *preferences*
from your most recent real workspace on first use — but a workspace starts
with no projects in it, and Eclipse itself has no command-line way to add
one. scoder launches Eclipse with `-data <managed workspace> -importProject
<project>`, plus one `-importProject` for each `$HOME/...` dependency in
`.sandbox/readonly`; `-importProject` is the
[import-projects plugin](https://github.com/robchallen/eclipse-import-projects-plugin)'s
flag, not Eclipse's. Without the plugin, Eclipse opens with the right
preferences and an empty workspace: you can import the project by hand
(it then stays in that workspace, which persists), but dependency projects
are no longer imported for you.

## IDE and host MCP servers

The simplest way to connect your agent to an IDE (or to an MCP service
running on the host) is to **ask the agent to help**, with the scoder skill
installed (see below). It writes the agent-side MCP config, merging into
your `.mcp.json`, and walks you through the parts only you can do: installing
the IDE extension on the host, creating an API token, adding a host port to
`.sandbox/ports`, and restarting the agent. The skill carries the known
working setups for RStudio and Positron (btw), VS Code, VSCodium and Positron
(vscode-mcp-server), Eclipse (AssistAI) and WebStorm (built in).

Two facts worth knowing either way. With `--ide`, the agent and the IDE
share one sandbox, so an IDE's MCP server is on the sandbox's own
`localhost` — no port forwarding. A server on the **host** needs its port
in `.sandbox/ports`.

### Installing the scoder skill

The skill (`skills/working-in-a-scoder-sandbox/` in this repository)
teaches an agent how a scoder sandbox behaves — what is read-only, how
worktrees work, how to set up MCP — so it can help instead of guessing.

Nothing to install: scoder carries it (and `configure-scoder-sandbox`) and
adds both to every session's skills, wherever the agent reads them —
nothing written to your real skill directories. A copy of your own with
the same name, if selected, is used instead.

With `--ide`, scoder also tells the agent (through the sandbox's
`AGENTS.md` note) which IDE is running beside it, and asks it to offer once
to set up an MCP connection if none is configured.

## Another preset's paths, without its tool (`--bind`)

`--bind NAME` adds preset `NAME`'s config binds to the sandbox without
launching `NAME` — for when one agent needs another's state (its skills,
sessions or config) or you want to use the SDK of another agent but only one
of them should run:

```bash
scoder pi --bind claude                   # pi runs; ~/.claude etc. are in its sandbox
scoder --bind claude --bind copilot pi    # repeatable, either side of the tool name
SCODER_BIND=claude,copilot scoder pi      # the same, from the environment
```

`SCODER_BIND` takes preset names separated by commas or spaces, and adds
to any `--bind` flags rather than replacing them — set it in your shell
profile for a binding you want in every session.

Only the preset's binds come along: its tool is not started, and it need
not even be installed. The binds are the preset's own, read-write ones
included — `--bind claude` gives the session the same read-write
`~/.claude` Claude Code itself gets, hooks and `settings.json` among it, so
whatever the agent writes there takes effect the next time you run
`claude` on the host (see `design/features/tool-presets.md`).

After the tool name, `--bind` is taken as scoder's only when its value is a
preset name, so a tool's own `--bind` (`scoder python3 -m http.server --bind
0.0.0.0`) passes through untouched. GUI presets (`rstudio`, `eclipse`,
`vscode`, `vscodium`, `positron`, `webstorm`) are refused: their binds include a display, which only makes
sense with the GUI running — use `--ide` for that.

## Starting a project's IDE state over (`--new-workspace`)

`eclipse`, `vscode`, `vscodium`, `positron` and `webstorm` keep per-project state between sessions in
directories scoder manages — an Eclipse workspace under
`~/.local/share/scoder-eclipse-workspaces/`, a VS Code user-data-dir under
`~/.local/share/scoder-vscode-userdata/` — seeded once from your host
settings and never re-seeded, so changes made inside the sandbox stick.
`--new-workspace` throws that state away for the current project before
launch, and it is re-created from your host settings as on a first run:

```bash
scoder eclipse --new-workspace
scoder pi --ide vscode --new-workspace     # works for the --ide companion too
```

What goes: Eclipse's `.metadata` (preferences, launch configurations,
breakpoints, local history — the project itself is imported in place, so
its files are untouched), or everything in the VS Code user-data-dir
(settings, UI state, remembered prompts). What stays: your host's own
`~/.eclipse`, `~/.config/Code`, `~/.vscode/extensions` and `~/.continue`.
It is refused while a session is still using that directory, and with
`--dry-run` it only reports what it would delete.

## Native display (`--native-display`)

GUI presets (`rstudio`, `eclipse`, `vscode`, `vscodium`, `positron`, `webstorm`, `jupyterlab`) normally run under an xpra server inside
the sandbox: their windows are forwarded to the host, and they never hold a
connection to the host's X session. That isolation has a usability cost —
xpra's translation has been reported to break hovers, popups and dialog
placement most notably in eclipse — and `--native-display` opts out of it:

```
scoder --native-display eclipse
SCODER_NATIVE_DISPLAY=1 scoder eclipse     # same thing
```

Read the warning this prints before using it: a sandboxed program on the
host's X session can read the screen and inject input into *other* windows
(on Xorg, every window; on a Wayland host, the X/XWayland ones — see
[ADR 0005](./architecture/decision-records/0005-native-display-opt-out.md)).
What does not change: the private session bus (the GUI gets its own, never
the host's), the `--tmpfs /run` boundary (the xauth cookie crosses as one
file, never a directory), and xpra as the default — the flag is per-run and
warned, and a repo can never carry the downgrade: it is not a `.sandbox/`
setting. It only applies to sessions that run a GUI preset, as harness or as
`--ide` companion; everywhere else it's a named error.

## Persistent host-loopback ports (an `.sandbox/ports` file)

A file named `.sandbox/ports` at the project root lists host-loopback ports
forwarded into the sandbox — an MCP server running outside it, a locally
hosted research-tool API (Zotero's, say), an LLM endpoint. No flag: the
file's presence and content is the entire mechanism, same as
`.sandbox/readonly` and `.sandbox/readwrite`.

```
# .sandbox/ports — one port per line, # comments allowed
11434   # ollama, auto-detected
23119   # zotero local api
```

- **Always read-only inside the sandbox**, like the rest of `.sandbox/` —
  only the host side can change it. A project without one forwards no
  ports (beyond an auto-detected local model).
- **A malformed line fails the session outright**, naming the bad line —
  this is network exposure, not a workspace-protection list, so a config
  file that could silently mean less than it looks like is the wrong
  failure mode.
- **Auto-detection persists automatically**: if a local OpenAI-compatible
  API is listening on port `11434` (override with `SCODER_LLM_PORT`), or
  port `11435` answers `GET /v1/models` with an OpenAI-style model list, it is
  appended to `.sandbox/ports` — additively, only once — so the next session,
  and every teammate's session, has it without anyone naming the port
  again. Skipped entirely under `--dry-run`.
- **Live-reloaded.** Editing `.sandbox/ports` while a session is running
  reattaches networking with the new port list, without restarting the
  session. A malformed or failing edit falls back to whatever was working
  before, rather than leaving the sandbox with no networking.
- **Tracked or gitignored, either works** — same trade-off as
  `.sandbox/readwrite`: tracked means a `-w`/`--worktree` session's fresh
  checkout carries it automatically, which is the recommended default for
  anything a whole project needs, not just one person's session.

## Persistent read-write access (an `.sandbox/readwrite` file)

A file named `.sandbox/readwrite` at the project root lists `$HOME/...`
directories to bind read-write into the sandbox — a persistent cache,
analysis output, or any other directory outside the project tree that
needs to survive session restarts. One line per directory, the same
`$HOME/...` line format `.sandbox/readonly` already uses for its own home
binds, just opening write access instead of read-only.

```
# .sandbox/readwrite — $HOME/... directories bound read-write into the sandbox, one per line
$HOME/.cache/my-cache
$HOME/analysis-output/figures
```

- **A missing target directory is created** (`mkdir -p`), not left as an
  error — unlike `.sandbox/readonly`'s own `$HOME/...` binds, which require
  the target to already exist. A fresh cache or output directory that
  doesn't exist yet on a machine's first run is the common case here, not
  an exception.
- **Must resolve inside your home directory.** A target outside `$HOME` —
  including via a symlink that escapes it — fails the session outright,
  with a clear error. Any line not starting with `$HOME/` is rejected the
  same way: nothing outside `$HOME` is supported at all.
- **Must not overlap a fixed scoder bind** (`~/.gitconfig`,
  `~/.config/gh`, a tool's own config, and similar) or an `.sandbox/readonly` `$HOME/...` entry —
  both are hard errors naming the conflicting path, rather than a silent
  downgrade to read-only.
- **Always read-only itself inside the sandbox**, like `.sandbox/readonly`
  and `.sandbox/ports` — only the host side can change which directories are
  listed.

**Tracked or gitignored, either works** — tracked is recommended: a
`-w`/`--worktree` session's fresh checkout then carries the file
automatically. Gitignored works too, but only in direct mode: a new
worktree checkout contains only tracked files, so an untracked
`.sandbox/readwrite` from your main checkout won't appear there on its own.

## Setting up a project (`--configure`)

```bash
scoder --configure claude     # or pi, opencode, copilot
```

starts the agent with the `configure-scoder-sandbox` skill to work out,
with you, what this project needs inside the sandbox — environment
variables, host ports, read-only and read-write paths, MCP servers — and
write `.sandbox/` (and `.mcp.json`). The agent edits working copies of
`.sandbox/` and of your recipes; when you exit, scoder lists each changed
file in one line, checks them, and applies them only if you say yes — the
recipes backed up first — then starts a normal session. Commit `.sandbox/`
before and after: it is meant to live in version control with the project.

An interactive start in a project whose `.sandbox/` lacks any of `env`,
`readonly`, `readwrite` or `ports` does this automatically. Scripts and
piped runs never do; they use the built-in defaults.

The agent works from your **recipes**: markdown files in
`~/.config/scoder/recipes/` (or `$XDG_CONFIG_HOME/scoder/recipes/`), any
number, any names, each with *When to use*, *Env*, *Ports*, *Read-only
binds*, *Read-write binds*, *Skills* and *MCP servers* sections. scoder writes a starter set
there (base, Java/Gradle, TypeScript, R, Python, polyglot, web search,
model hosting) and never overwrites a file you have edited — edit them, or
ask the agent to during `--configure`, to describe your machine.

## Agent skills (`.sandbox/skills`)

At start-up scoder finds every skill on the machine — in the project's
`.agents/skills`, `.claude/skills`, `.github/skills`, ... and your
`~/.agents/skills`, `~/.claude/skills`, `~/.copilot/skills`,
`~/.config/opencode/skills`, `~/.pi/agent/skills` — a project skill
shadowing one of yours with the same name. `.sandbox/skills` picks the
ones this project's sessions get: one regular expression per line, matched
against the whole skill name.

```
# .sandbox/skills
web-search
.*research.*
```

Without the file every skill is included (`.*`). The selection, plus
scoder's own skills, is bound read-only where the session's agent looks
for skills — `~/.claude/skills` for Claude Code, `~/.pi/agent/skills` for
pi, `~/.config/opencode/skills` for opencode, `~/.copilot/skills` for
Copilot, `~/.agents/skills` otherwise — and only for that agent, not for
presets added with `--bind`.

## Environment passthrough (`.sandbox/env`)

`.sandbox/env` lists, one per line, the host environment variables passed
into the sandbox (when set); nothing else is passed. A `*` makes a line a
pattern, so `PI_*` passes every `PI_` variable you have set:

```
# .sandbox/env
EDITOR
GH_TOKEN
ANTHROPIC_API_KEY
PI_*
*_API_KEY
```

Patterns only add names. They never match the variables that would break
the sandbox or reach host resources it deliberately cannot (`PATH`,
`HOME`, `USER`, `SHELL`, `LD_*`, `SCODER_*`, `DISPLAY`, `XAUTHORITY`,
`WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`,
`SSH_AUTH_SOCK`), nor anything scoder sets itself; name one of those
exactly if you really mean it. A line that is only `*` is refused. At
start-up scoder lists what each pattern matched — names only, never values.

The built-in default passes your shell/editor variables and `GH_TOKEN` /
`GITHUB_TOKEN` only, with the common provider API keys listed but
commented out — a configure session, or you, lists the ones a project
uses in its `.sandbox/env`. This replaces the
fixed list earlier versions passed unconditionally. `--dry-run` writes no
configuration files.

For a one-off value, `--env` sets a variable in this session's sandbox
only — nothing is written to `.sandbox/env`:

```bash
scoder --env MY_KEY=xyz pi
scoder --env DEBUG=1 --env LOG_LEVEL=trace pi    # repeatable
```

The value is everything after the first `=` (so it may contain `=`, or be
empty). It wins over the same name from `.sandbox/env`, and over a value
scoder sets itself (`HOME`, `PATH`, ...), with a warning in that case.
`--env` goes before the tool name — after it, it is the tool's own
argument. Like every value scoder passes into the sandbox, it is on
bwrap's command line, so other processes on the host can see it in the
process list while the session runs; `--dry-run` redacts names that look
secret.

## Environment variables

These change how scoder itself behaves. They are read from the environment
you start scoder in — none of them is passed into the sandbox (that is
`.sandbox/env`'s job).

**Behaviour**

| Variable | Effect |
|----------|--------|
| `SCODER_NATIVE_DISPLAY=1` | Same as `--native-display`. |
| `SCODER_BIND` | Same as `--bind`, for each preset named (comma- or space-separated, e.g. `claude,copilot`); added to any `--bind` flags. |
| `SCODER_LLM_PORT` | The host port probed for a local OpenAI-compatible API at startup (default `11434`, Ollama's). When something answers, the port is forwarded and appended to `.sandbox/ports`. Port `11435` is also probed, and taken only if it serves an OpenAI-style `/v1/models`. |
| `SCODER_KEEP_SCREEN` | Any non-empty value leaves the terminal as the tool left it on exit. By default scoder resets terminal modes (alternate screen, hidden cursor, mouse reporting, bracketed paste, raw input) and clears the screen, keeping scrollback. |
| `SCODER_KEEP_SESSION_TMP` | Any non-empty value keeps the session's temp root (`/tmp/scoder-<id>`) after exit instead of deleting it — the staged files scoder put in front of the sandbox, and the IDE/xpra log. Useful with `--dry-run` to inspect what it built. |
| `XDG_CONFIG_HOME` | Where the recipes live: `$XDG_CONFIG_HOME/scoder/`, else `~/.config/scoder/`. |

**GUI presets (xpra)**

| Variable | Effect |
|----------|--------|
| `SCODER_XPRA_SERVER_ARGS` | Extra flags appended to the `xpra start` run inside the sandbox, word-split. |
| `SCODER_XPRA_CLIENT_ARGS` | Extra flags for the host-side xpra client, split on whitespace (so a value cannot itself contain a space), e.g. `--encoding=rgb --video=no`. |
| `XPRA_*` | Any host variable starting `XPRA_` is forwarded to the xpra server in the sandbox. `XPRA_SCROLL_ENCODING` also applies to the host client, where scoder defaults it to `1`; set it to override. |
| `GTK_OVERLAY_SCROLLING` | Inherited by GUI presets, so `GTK_OVERLAY_SCROLLING=0` keeps scrollbars visible as on the rest of your desktop. |
| `RSTUDIO_CHROMIUM_ARGUMENTS` | Forwarded to RStudio, for Chromium flags (e.g. GPU workarounds). |
| `SCODER_BROWSER` | The browser links open in, inside the sandbox — a command line, e.g. `google-chrome --incognito --no-first-run --no-default-browser-check --disable-component-update`. Sets `BROWSER` and overrides the web-link defaults of your `mimeapps.list` there, so `xdg-open` (VS Code, RStudio, R's `browseURL`) and `$BROWSER` users all run it; your other file associations are kept. Split on whitespace only, so an argument cannot contain a space. |

**Timing** — mostly for the test suite; each is in milliseconds, default `2000`.

| Variable | Effect |
|----------|--------|
| `SCODER_AGENTPORTS_POLL_MS` | How often a running session re-reads `.sandbox/ports`. |
| `SCODER_RESOLVCONF_POLL_MS` | How often it checks the host's DNS configuration for changes. |
| `SCODER_OVERLAY_POLL_MS` | How often it checks `AGENTS.md` (and other overlaid files) for host edits. |
| `SCODER_DOUBLE_SIGINT_WINDOW_MS` | A second Ctrl-C within this window force-stops the session instead of passing the interrupt on again. |

**Read from your environment**, not settings: `DISPLAY`, `XAUTHORITY` and
`WAYLAND_DISPLAY` (for `--native-display`, and to pick the GUI backend);
`XDG_RUNTIME_DIR`, passed on to GUI presets; `HOME`, `USER`/`LOGNAME`,
`TERM` and `LANG`, which shape
the sandbox's own; and `SUDO_USER`/`SUDO_UID`/`SUDO_GID`, so that under
`sudo` the sandbox runs as you rather than as root.

**Set inside the sandbox** by scoder: `SCODER_SANDBOX=1` (a nested
`scoder -w` refuses to run; `--no-worktree` still works), `HOME`, `PATH`,
`USER`, `LOGNAME`, `TERM` and `LANG`, plus `MCPTOOLS_SOCKET_DIR` for
`rstudio`. Everything else in the sandbox's environment — `SHELL` and
`EDITOR` included — is there because `.sandbox/env` lists it.

## Worktrees inside a session (worktrunk)

Every session, direct or worktree mode, binds one directory read-write for
git worktrees: `$HOME/<parent-of-repo>/worktrees/<repo-name>/` — for
`~/Git/scoder` that is `~/Git/worktrees/scoder/`. scoder's own `-w`
worktree is the `scoder` leaf inside it. It is the **only** place a new
worktree can go from inside the sandbox: anywhere else is unbound, so a
worktree created there is unwritable, or gone at the end of the session.

[worktrunk](https://github.com/max-sixty/worktrunk) (`wt`) works out of the
box: scoder sets `WORKTRUNK_WORKTREE_PATH` in the sandbox to that directory
plus `{{ branch | sanitize }}`, so `wt switch --create feature/auth` lands
at `~/Git/worktrees/scoder/feature-auth`, overriding your own worktrunk
config for the session only (`~/.config/worktrunk/config.toml` is bound
read-only). Plain `git worktree add` works too, given a path under that
directory.

Worth knowing:

- **Don't name a branch `scoder`** (or anything that sanitizes to it): its
  worktree would collide with scoder's own.
- **Repos outside `$HOME`**: scoder still puts the worktrees directory under
  `$HOME` (`/srv/code/proj` → `~/srv/code/worktrees/proj/`) so it can be
  bound, which is not where your host-side worktrunk config would put them.
- **Remove worktrees with `wt remove` or `git worktree remove`**, not
  `rm -rf`, or git keeps a stale registration until `git worktree prune`.

## After a session

A GUI preset run as the tool itself (`scoder rstudio`, `scoder jupyterlab`)
sends its output to the session log, like a companion IDE, and scoder
prints where at start-up; the terminal just shows that line.

When the tool exits, scoder puts your terminal back — leaves any alternate
screen, shows the cursor, turns off mouse reporting and bracketed paste,
resets raw input (`stty sane`) — and clears the screen. Scrollback is kept,
and in worktree mode the session summary is printed after the clear. Set
`SCODER_KEEP_SCREEN=1` to skip it.

### Direct mode (default)

Changes are made directly to your working directory. No branch is created,
no cleanup is needed. The `.sandbox/readonly` protection still applies during
the session.

### Worktree mode (`-w` / `--worktree`)

Changes are committed to the `scoder/<repo-name>` branch. The worktree is at
`$HOME/<parent-of-repo>/worktrees/<repo-path>/scoder`.

From inside the sandbox, if you need to pick up the latest changes from `main`,
fetch and rebase or merge explicitly:

```bash
git fetch origin
git rebase origin/main
# or: git merge origin/main
```

This is more reliable than `git pull`, because the sandbox branch usually does
not have an upstream configured for that purpose.

From outside the sandbox, other sessions only see changes on the `scoder/*`
branch after they have been committed. Uncommitted edits exist only in the
worktree at `$HOME/<parent-of-repo>/worktrees/<repo-path>/scoder`.

When scoder exits it prints:

```
scoder: ====== Session Summary ======
scoder: Branch: scoder/<git-repo-name>
scoder: Worktree: <HOME>/<parent-of-repo>/worktrees/<repo-path>/scoder
scoder: To review:  git log scoder/<git-repo-name>
scoder: To merge:   git merge scoder/<git-repo-name>
scoder: To rebase:  git rebase scoder/<git-repo-name>
scoder: View diff:  git diff scoder/<git-repo-name>
scoder: To discard: git worktree remove <worktree-path> && git branch -D scoder/<git-repo-name>
```

## Requirements

- `bwrap` (bubblewrap)
- `pasta` (usually provided by the `passt` package)
- `git`
- `ssh` (OpenSSH client) — only needed for `--allow-ssh`
- `bun` (TypeScript runtime) - install via `curl -fsSL https://bun.sh/install | bash`
- `xpra` **6.5.5 or newer** on the host — only for GUI presets (`rstudio`,
  `eclipse`, `vscode`, `vscodium`, `positron`, `webstorm`, `jupyterlab`)
  without `--native-display`; `--install-dependencies` installs it from
  xpra's own repository. GUI sessions refuse an older xpra: 6.5.4 breaks
  mouse-wheel scrolling, and 6.5.5 fixes it
- The tool you want to sandbox (e.g. `opencode`, `copilot`, `claude`)
- Tool-specific prerequisites must already be set up (and installed globally):
  - `claude`: install via `npm install -g @anthropic-ai/claude-code`
  - `copilot`: install via `npm install -g @github/copilot` or `brew install copilot-cli`, run `gh auth login` first
  - `opencode`: install from https://opencode.ai
  - `pi`: install from https://pi.dev
  - `eclipse`: the [import-projects plugin](https://github.com/robchallen/eclipse-import-projects-plugin)
  - `vscode` / `vscodium` / `positron`: the .deb, .rpm or tarball build (not the snap)

## Install

Clone the repository and ensure bun is available:

```bash
git clone <repo-url>
cd scoder

# Install bun if not already available
curl -fsSL https://bun.sh/install | bash

# The scoder wrapper script will use bun automatically
./scoder --version
```

### AppArmor setup (Ubuntu 24.04+)

On Ubuntu 24.04 and newer, AppArmor restricts unprivileged user namespaces
by default. bubblewrap needs user namespaces to work, so you must install
an AppArmor profile to allow it:

```bash
sudo ./scoder --configure-apparmor
```

This installs a profile at `/etc/apparmor.d/bwrap` that grants bwrap the
`userns` permission (the same approach used by Chrome, Firefox, Flatpak,
and other sandboxed applications). You only need to run this once.

If you skip this step, scoder will detect the problem and tell you:

```
scoder: bwrap cannot create user namespaces
scoder: AppArmor is restricting unprivileged user namespaces on this system
scoder: Fix: sudo scoder --configure-apparmor
```

### Install dependencies

```bash
sudo ./scoder --install-dependencies
```

Installs `bubblewrap` and `passt` via apt, and adds xpra's own apt
repository (the distro's xpra is too old or absent) to install the current
`xpra`, checking it is at least 6.5.5. It also removes the xpra 6.5.3 pin
that earlier scoder versions wrote to `/etc/apt/preferences.d`, which would
otherwise hold xpra back.

## Development

```bash
bun test          # the validation suite (design/test-scripts/validation-suite.md)
./em check        # typecheck, lint/format, duplication
```
