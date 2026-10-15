# scoder

Run AI coding agents (Claude Code, pi, opencode, Copilot CLI) and IDEs in a
sandbox on Linux, so they can work on your project without being able to
touch the rest of your machine.

Inside a scoder sandbox the agent can read and write your project, and
nothing else unless you say so:

- your home directory is empty apart from what is granted;
- the system is read-only;
- only the environment variables you list are passed in;
- services on your machine's `localhost` are unreachable, though the
  internet is not;
- infrastructure files (`.github/`, lockfiles, ...) are read-only.

What a project is granted lives in a small `.sandbox/` directory you commit
with it. The easiest way to write it is to let the agent do it with you:
`scoder --configure <agent>`.

This page is for using scoder. How it works, every option, and the design
behind it are in [DEVELOP.md](./DEVELOP.md).

## Installation

### Requirements

- **Linux** with user namespaces (Ubuntu 24.04+ needs one AppArmor step,
  below).
- **git** — scoder only runs inside a git repository, so there is always a
  `git diff` of what the agent did.
- **[Bun](https://bun.sh)** — `curl -fsSL https://bun.sh/install | bash`.
- The agent you want to run, installed and logged in as usual: `claude`,
  `pi`, `opencode` or `copilot`.

The sandbox itself needs `bubblewrap` and `passt` (for `pasta`), and the
GUI presets (RStudio, Eclipse, VS Code, ...) need `xpra` 6.5.5 or newer;
scoder installs all three for you (below).

### Get scoder

```bash
git clone https://github.com/robchallen/scoder.git
cd scoder
ln -s "$PWD/scoder" ~/.local/bin/scoder   # or anywhere on your PATH
scoder --version
```

`./scoder` runs the source with Bun. To get one self-contained executable
instead, run `bun run build`, which writes `dist/scoder`, and put that on
your `PATH`.

### Initial setup (once, with sudo)

```bash
sudo env "PATH=$PATH" scoder --install-dependencies   # bubblewrap, passt, xpra
sudo env "PATH=$PATH" scoder --configure-apparmor     # Ubuntu 24.04 and newer
```

> **Why `env "PATH=$PATH"`:** `sudo` resets `PATH`, so neither
> `~/.local/bin/scoder` nor Bun in `~/.bun/bin` is found: `sudo scoder`
> says "command not found", and `sudo ./scoder` says "bun is required".
> Passing your `PATH` through fixes both, as does giving `sudo` the full
> path of the compiled binary (`sudo ~/path/to/dist/scoder ...`).

`--install-dependencies` installs `bubblewrap` and `passt` with apt, and
`xpra` from xpra's own repository (the distribution's is too old).
`--configure-apparmor` installs an AppArmor profile that lets bubblewrap
create user namespaces, which Ubuntu 24.04+ otherwise forbids. If you
skip it, scoder tells you so the first time it runs.

## Configure a sandbox

### First run

```bash
cd ~/Git/my-project
scoder claude            # or: pi, opencode, copilot
```

In a project with no `.sandbox/` yet, an interactive start becomes a
**configure session** first. You can also start one at any time with
`scoder --configure claude`. In it the agent:

1. reads your [baseline](#sandbox-and-configscoder-files) and
   [recipes](#recipes) (the user files under `~/.config/scoder/`);
2. looks at the project (build files, lockfiles, an existing `.sandbox/`
   and `.mcp.json`);
3. asks only what it cannot see — which IDE, which model provider, which
   directories outside the project, which skills;
4. writes the minimal `.sandbox/` (and `.mcp.json` for MCP servers),
   explaining each line.

The agent works on copies. When you exit, scoder lists every file it
changed, one line each:

```
scoder: Changes from the configure session:
  added     .sandbox/env
  modified  .sandbox/readonly (+2 -0)
  modified  .mcp.json (+6 -0)
Apply these changes? [y/N]
```

Say yes and scoder applies them and starts the session you originally
asked for. Say no and nothing changes. The agent cannot widen its own
sandbox without you seeing exactly which files changed.

**Commit `.sandbox/`** (and `.mcp.json`) before and after: it is meant to
live in git with the project, so every later change is a reviewable diff.
The configure agent asks you to.

### Everyday use

```bash
scoder claude                 # run in the current checkout (changes are immediate)
scoder -w claude              # run on a scoder/<repo> branch in a separate worktree
scoder pi --ide rstudio       # an IDE alongside the agent, in the same sandbox
scoder --env DEBUG=1 pi       # set a variable for this session only
scoder --dry-run claude       # show what would run, start nothing
```

IDE presets are `rstudio`, `eclipse`, `vscode`, `vscodium`, `positron`,
`webstorm` and `jupyterlab`. They also run on their own (`scoder
rstudio`), in a window forwarded from inside the sandbox. Each has
prerequisites — Eclipse needs a plugin, VS Code must not be the snap
build — listed in [DEVELOP.md](./DEVELOP.md#tools-and-presets), along with
every other option.

### Changing a project's sandbox later

`.sandbox/` is **read-only inside the sandbox**, so an agent cannot change
its own limits. Either:

- run `scoder --configure <agent>` again and ask for the change; or
- edit the file on the host yourself; the agent in an ordinary session can
  tell you the exact line.

`ports` and `skills` take effect in the running session within a couple of
seconds. For skills, reload the agent's skills afterwards, e.g. `/reload`.
Everything else applies the next time you start scoder.

## `.sandbox` and `.config/scoder` files

A session's grants come from two layers, which are added together:

| Layer | Where | Holds |
|---|---|---|
| **Baseline** | `~/.config/scoder/sandbox/` | What **every** sandbox on this machine gets: your model provider keys, the usual protected files, skills you always want. A project cannot remove anything from it. |
| **Project** | `<project>/.sandbox/` | What this project adds: its toolchains, dependencies, caches, ports, skills. |

Both layers hold the same five files, one entry per line, with `#`
comments:

| File | Lists | Example |
|---|---|---|
| `env` | Host environment variable **names** to pass in (never values). `*` makes a pattern. | `ANTHROPIC_API_KEY`, `PI_*` |
| `readonly` | Project paths the agent may read but not change (`.gitignore`-style), and `$HOME/...` paths to make visible read-only. | `.github/`, `package-lock.json`, `$HOME/R` |
| `readwrite` | `$HOME/...` directories to make writable (created if missing). | `$HOME/.m2`, `$HOME/.cache/my-tool` |
| `ports` | Ports on your machine's `localhost` to forward in. | `11434` (a local model), `23119` (Zotero) |
| `skills` | Regular expressions picking which of your agent skills this project gets. | `zotero.*`, `latex` |

`~/.config/scoder` (or `$XDG_CONFIG_HOME/scoder`) also holds:

- **`recipes/`** — your [recipes](#recipes).
- **Backups** — `sandbox.bak-<date>` and `recipes.bak-<date>`, made before
  a configure session changes either.

A project may also have:

- **`.sandbox/version`** — written by scoder. Without it, scoder tells you
  the config predates explicit grants.
- **`.mcp.json`** — the agent's MCP servers, reviewed the same way in a
  configure session.

**Always available, never listed:** the project itself, your git and
`gh` config, fonts and desktop themes, and the agent's or IDE's own
config. **Never available unless granted:** everything else in your home
directory. That includes toolchains (`~/.m2`, `~/R`, mise, uv, rustup),
programs in `~/.local/bin` (granted one at a time, e.g.
`$HOME/.local/bin/hf`), ssh keys, and other projects.

**Skills.** scoder finds every skill on your machine. It looks in the
project's `.agents/skills`, `.claude/skills` and similar, and in your own
`~/.agents/skills`, `~/.claude/skills`, `~/.pi/agent/skills`, ...; a
project skill wins over one of yours with the same name. scoder then gives
the agent the ones `skills` selects, plus scoder's own two
(`working-in-a-scoder-sandbox`, `configure-scoder-sandbox`). The agent
also sees a list of every skill on the machine, so if you ask for one this
project doesn't have, it can tell you it exists and how to add it.

The baseline is created from scoder's defaults the first time you run it,
and never overwritten after that.

## Recipes

Recipes are what the configure agent knows about **your** machine and
**your** kinds of project. Each is a markdown file in
`~/.config/scoder/recipes/`, with any name and in any number, with these
sections:

- **When to use**
- **Env**
- **Ports**
- **Read-only binds**
- **Read-write binds**
- **Skills**
- **MCP servers**

They map onto the `.sandbox/` files and `.mcp.json`.

scoder writes a starter set the first time it runs: `base`, `java` (with
Gradle), `typescript`, `python`, `r`, `polyglot` and `research`. `base`
applies to every project, and asks about model providers, web search,
decision models, and local or cloud model hosting. It also asks, for each
choice, whether it belongs in your baseline or in the project. scoder never
overwrites a recipe you have changed.

Recipes are how you teach scoder once instead of every project, so it pays
to keep them true for your machine:

- **Edit them by hand.** They are prose, read by an agent, so write what
  you would tell a colleague — "my Java projects use `~/.m2` and
  `~/.gradle`", "always offer the Zotero MCP server for papers".
- **Or have the agent write them.** In a configure session the recipes,
  and your baseline, are writable working copies. Ask for something like:
  - "Turn what we just set up into a recipe for Quarto projects."
  - "Add the skills I use for grant writing to the research recipe."
  - "Put my OpenRouter key in my baseline so every project gets it."

  The changes are listed with the project's when you exit, and backed up
  before they are applied.

## Limitations

- **Linux only.** scoder is built on bubblewrap and pasta, which are Linux
  tools.
- **Not a security boundary against a determined attacker.** It keeps an
  agent from doing things you did not intend; it is not a hardened
  container. In particular, values passed with `--env` appear on
  bubblewrap's command line, visible to other processes on your machine.
- **Some changes need a restart.** `env`, `readonly`, `readwrite`, and a
  grant for a file that does not exist yet (such as `~/.Rprofile` before
  you create it), apply only from the next start. Skills are copied at
  start-up, so editing a skill's own files on the host is not seen until
  you restart.
- **Sign-ins inside IDEs don't persist**: secrets are kept in memory for
  the session only.
- **Clipboard**: copying out works from terminal programs that use OSC 52
  (pi, Claude Code, vim, tmux), in a terminal that supports it — GNOME
  Terminal does not. `xclip` and `wl-copy` do not work.
- **No accessibility in GUI presets**: screen readers and other assistive
  technology cannot see sandboxed IDE windows.
- **GUI windows go through xpra**, which can misplace hovers, popups and
  dialogs, especially in Eclipse. `--native-display` avoids it, but gives
  the program access to your whole X session; read its warning first.
- **IDE builds:** snap builds of VS Code, VSCodium, Positron and WebStorm
  are refused; use the .deb, .rpm or tarball. Eclipse needs the
  [import-projects plugin](https://github.com/robchallen/eclipse-import-projects-plugin).
- **No ssh** unless you pass `--allow-ssh user@host`, which opens one
  connection to that one destination.
- **Configure sessions are interactive.** Scripts and piped runs never start
  one; they run on the baseline plus whatever `.sandbox/` already has.
- Copilot may also read skills from `~/.claude/skills`, which scoder does
  not filter.

## Further reading

- [DEVELOP.md](./DEVELOP.md) covers how scoder works, every option and
  environment variable, the presets in detail, and development.
- [design/SCOPE.md](./design/SCOPE.md) indexes every feature's design
  document.
