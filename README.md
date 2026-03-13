# scoder

Sandboxed runner for coding tools using bubblewrap (bwrap).

Runs AI coding assistants and developer tools inside a constrained
environment so they cannot modify your host unexpectedly. Changes happen
on an isolated git branch via worktrees.

## Supported tools

| Tool | Preset |
|------|--------|
| `opencode` | Config, data, cache bind-mounts |
| `claude` | Claude Code config bind-mount |
| `copilot` | GitHub Copilot CLI config + data |
| *(any)* | Generic sandbox |

## How it works

1. **Must be in a git repo.** `scoder` refuses to run outside one.
2. Creates a new branch (`scoder/<git-repo-name>`) and a git worktree
   in `/tmp/scoder/<git-repo-path>`. Your original checkout is untouched.
3. Launches the tool inside a bubblewrap sandbox operating on the worktree.
   Paths inside the sandbox mirror real absolute paths.
4. On exit, prints a summary of changes and how to merge or discard.

### Sandbox properties

- **Ephemeral HOME** — `/home/scoder` on tmpfs, fully isolated from your
  real home.
- **System read-only** — `/usr`, `/bin`, `/lib`, `/etc` are read-only.
- **Protected infrastructure** — `.github/`, `.opencode/`, `.claude/`, `opencode.json`,
  `.gitignore`, `package-lock.json`, `poetry.lock`, `Cargo.lock`, `pnpm-lock.yaml`, `yarn.lock`, `mise.toml`
  are read-only by default. List can be modified with a `.agentreadonly` file in the repository
  root. (`.agentreadonly` is always protected)
- **Tools** - executable directories and libraries are available read-only
  for R, Java (maven), Rust, and mise-en-place.
- **Restricted device access** - Restrict /dev to essential devices only

## Usage

```
scoder [options] <tool> [tool-args...]
```

### Examples

```bash
scoder opencode                   # sandbox opencode in current repo
scoder claude                     # sandbox claude code
scoder copilot                    # sandbox GitHub Copilot CLI
scoder --dry-run opencode         # show bwrap command without running
scoder --validate                 # run built-in validation tests
```

### Options

```
-h, --help              Show help
-V, --version           Show version
-q, --quiet             Suppress informational output
    --validate          Run validation tests and exit
    --dry-run           Print bwrap command without executing
```

Protecting workspace infrastructure files or directories can be modified with a
`.agentreadonly` directory which is formatted like a `.gitignore` file and defines
what paths within the workspace an agent cannot modify, these can still be read.
An empty file will make all workspace files writeable.

## After a session

Changes made during the session will be available at the `/tmp/scoder/<git-repo-path>`
but also committed to the local branch. From there it can be rebased or merged into
your working branch. The emphemeral path will

When scoder exits it prints:

```
scoder: ====== Session Summary ======
scoder: Branch: scoder/<git-repo-name>
scoder: Worktree: /tmp/scoder/<git-repo-path>
scoder: To review:  git log scoder/<git-repo-name>
scoder: To merge:   git merge scoder/<git-repo-name>
scoder: To rebase:  git rebase main scoder/<git-repo-name>
scoder: To discard: git worktree remove /tmp/scoder/<git-repo-path> && git branch -D scoder/<git-repo-name>
```

## Requirements

- `bwrap` (bubblewrap)
- `git`
- The tool you want to sandbox (e.g. `opencode`, `copilot`, `claude`)
- Tool-specific prerequisites must already be set up (and installed globally):
  - `claude`: install via `npm install -g @anthropic-ai/claude-code`
  - `copilot`: install via `npm install -g @github/copilot` or `brew install copilot-cli`, run `gh auth login` first
  - `opencode`: install from https://opencode.ai

## Install

Copy or symlink the `scoder` script to somewhere in your PATH:

```bash
install -m 755 scoder ~/.local/bin/scoder
```

### AppArmor setup (Ubuntu 24.04+)

On Ubuntu 24.04 and newer, AppArmor restricts unprivileged user namespaces
by default. bubblewrap needs user namespaces to work, so you must install
an AppArmor profile to allow it:

```bash
sudo scoder --configure-apparmor
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
