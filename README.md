# scoder

Sandboxed runner for coding tools using bubblewrap (bwrap).

Runs AI coding assistants and developer tools inside a constrained
environment so they cannot modify your host unexpectedly. Changes happen
on an isolated git branch via worktrees.

## Supported tools

| Tool | Preset | Defaults |
|------|--------|----------|
| `opencode` | Config, data, cache bind-mounts | network on, .git read-only |
| `gh` | GitHub CLI auth bind-mount | network on, .git writable |
| `claude` | Claude Code config bind-mount | network on, .git read-only |
| `copilot` | GitHub Copilot CLI config + data | network on, .git writable |
| *(any)* | Generic sandbox | network on, .git read-only |

## How it works

1. **Must be in a git repo.** `scoder` refuses to run outside one.
2. Creates a new branch (`scoder/<tool>/<date>-<id>`) and a git worktree
   in `/tmp`. Your original checkout is untouched.
3. Launches the tool inside a bubblewrap sandbox operating on the worktree.
   Paths inside the sandbox mirror real absolute paths.
4. On exit, prints a summary of changes and how to merge or discard.

### Sandbox properties

- **Ephemeral HOME** — `/home/scoder` on tmpfs, fully isolated from your
  real home. Tool configs are bind-mounted read-only from the real home
  as needed (per-tool presets).
- **System read-only** — `/usr`, `/bin`, `/lib`, `/etc` are read-only.
- **Protected infrastructure** — `.github/`, `.gitignore`, lockfiles are
  read-only by default.
- **Git protection** — the `.git` directory is read-only unless
  `--allow-git` is passed (or the tool preset enables it, like `gh`).

## Usage

```
scoder [options] <tool> [tool-args...]
```

### Examples

```bash
scoder opencode                   # sandbox opencode in current repo
scoder gh pr list                 # sandbox gh (network on, git writable)
scoder claude                     # sandbox claude code
scoder copilot                    # sandbox GitHub Copilot CLI
scoder -n opencode                # opencode with no network
scoder --allow-git opencode       # opencode with writable .git
scoder --dry-run opencode         # show bwrap command without running
scoder --validate                 # run built-in validation tests
```

### Options

```
-h, --help              Show help
-V, --version           Show version
-n, --no-net            Disable network access
-q, --quiet             Suppress informational output
    --validate          Run validation tests and exit
    --dry-run           Print bwrap command without executing
    --ro                Mount worktree read-only
    --rw                Mount worktree read-write (default)
    --allow-git         Allow write access to .git
    --allow-infra       Allow write access to all protected infra
    --allow-host-tools  Bind host dev tools (~/.local/bin, mise, cargo, etc)
    --restrict-dev      Restrict /dev to essential devices only
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SCODER_NET` | `on` | Default network mode |

## After a session

When scoder exits it prints:

```
scoder: ====== Session Summary ======
scoder: Branch: scoder/opencode/2026-03-10-a1b2c3
scoder: Worktree: /tmp/scoder-wt-a1b2c3
scoder: To review:  git log scoder/opencode/2026-03-10-a1b2c3
scoder: To merge:   git merge scoder/opencode/2026-03-10-a1b2c3
scoder: To discard: git worktree remove /tmp/scoder-wt-a1b2c3 && git branch -D scoder/opencode/2026-03-10-a1b2c3
```

## Requirements

- `bwrap` (bubblewrap)
- `git`
- The tool you want to sandbox (e.g. `opencode`, `gh`, `claude`)
- Tool-specific prerequisites must already be set up:
  - `gh`: run `gh auth login` first
  - `claude`: install via `npm install -g @anthropic-ai/claude-code`
  - `copilot`: install via `npm install -g @github/copilot` or `brew install copilot-cli`
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
