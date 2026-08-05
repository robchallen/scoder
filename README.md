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

## How it works

### Default mode (direct)

1. Runs the tool in a sandbox **directly in your current working directory**.
   Paths inside the sandbox mirror real absolute paths.
2. No git branch creation, no worktree isolation.
3. `.agentreadonly` protection still applies.
4. Starts the tool through `pasta`, which keeps outbound networking available
   while blocking host localhost services such as `127.0.0.1`.
5. No commit on exit — changes are immediate.

### Worktree mode (`-w` / `--worktree`)

1. **Must be in a git repo.** `scoder -w` refuses to run outside one.
2. Creates a new branch (`scoder/<git-repo-name>`) and a git worktree
   in `/tmp/scoder/<git-repo-path>`. If you launch `scoder` from that
   existing scoder worktree, it reuses it instead of trying to create a new
   one. Your original checkout is untouched.
3. Launches the tool inside a bubblewrap sandbox operating on the worktree,
   with the same path mirroring and `pasta` networking as direct mode.
4. On exit, commits changes, prints a summary and how to merge or discard.

### Sandbox properties

- **Ephemeral HOME** — `/home/scoder` on tmpfs, fully isolated from your
  real home.
- **System read-only** — `/usr`, `/bin`, `/lib`, `/etc` are read-only.
- **Protected infrastructure** — `.github/`, `.claude/`, `opencode.json`,
   `.gitignore`, `package-lock.json`, `poetry.lock`, `Cargo.lock`, `pnpm-lock.yaml`, `yarn.lock`, `mise.toml`
   are read-only by default. List can be modified with a `.agentreadonly` file in the repository
   root. (`.agentreadonly` is always protected)
- **Agent skills snapshot** — `~/.agents` is copied at sandbox start and bound
  read-only into the sandbox, so symlinked skills resolve as a stable snapshot
  for the duration of the session.
- **Sandbox AGENTS.md notice** — the repository `AGENTS.md` seen inside the
  sandbox is overlaid with an extra scoder section so the agent knows it is
  running in an isolated worktree with an ephemeral home. The overlay is
  marked as `--skip-worktree` in git so the agent can use git freely
  (worktree operations, stash, etc.) without seeing a dirty working tree.
- **Tools** - executable directories and libraries are available read-only
  for R, Java (maven), Rust, and mise-en-place. Specifically:
  - **R**: `~/R` (user library) and `~/.Rprofile` are bound read-only, so
    R processes started inside the sandbox — including R MCP servers configured
    in the tool's config file — can access user-installed packages.
  - **Java/Maven**: `~/.m2` bound read-only
  - **Rust**: `~/.rustup` and `~/.cargo/bin` bound read-only
  - **mise**: `~/.local/share/mise` and `~/.config/mise` bound read-only
- **Full device access** — `/dev` is passed through from the host (full device
  passthrough via `--dev-bind /dev /dev`; `/dev/shm` is a fresh tmpfs).
- **Host localhost blocked** — tools run behind `pasta` with host localhost
  forwarding disabled, so host-local TCP services are not reachable
  from the sandbox while outbound networking stays available.
- **Localhost LLM exemption** — if a local OpenAI-compatible API is listening on
  port `11434` (the Ollama default) it is auto-detected at startup and that one
  port is forwarded into the sandbox. Override the probed port with
  `SCODER_LLM_PORT`, or name ports explicitly with `--llm-port=<ports>`.
- **No ssh access by default** — with `--allow-ssh user@host`, scoder opens a
  single pre-authenticated ssh connection to that one destination outside the
  sandbox and multiplexes only that connection in. See
  [ssh access](#ssh-access---allow-ssh) below.

## Usage

```
scoder [options] <tool> [tool-args...]
```

### Examples

```bash
scoder opencode                   # sandbox opencode in current directory (direct mode)
scoder claude                     # sandbox claude code
scoder copilot                    # sandbox GitHub Copilot CLI
scoder -w opencode                # isolate changes on a scoder/<repo> branch
scoder --llm-port=8080 claude     # allow access to a local LLM on port 8080
scoder --dry-run opencode         # show bwrap command without running
bun test                          # run the validation suite
```

### Options

```
-h, --help              Show help
-V, --version           Show version
-q, --quiet             Suppress informational output
-w, --worktree          Enable git worktree isolation
    --no-worktree       Run directly in current directory (no worktree) (default)
    --llm-port PORTS    Allow localhost TCP access to these comma-separated ports
                         instead of the auto-detected default on 11434
                         (override the probed port with SCODER_LLM_PORT)
    --allow-ssh USER@HOST  Open a single pre-authenticated ssh connection to
                         USER@HOST outside the sandbox, and expose only that
                         one connection inside it
    --dry-run           Print bwrap command without executing
```

Scoder options must come before the tool name, same as `--llm-port`:
`scoder --allow-ssh me@remote-host pi`, not `scoder pi --allow-ssh
me@remote-host` (anything after the tool name is passed to the tool
unparsed).

### `.agentreadonly` file

Protecting workspace infrastructure files or directories can be modified with a
`.agentreadonly` file which is formatted like a `.gitignore` file and defines
what paths within the workspace an agent cannot modify (they can still be read).
An empty file will make all workspace files writeable.

Lines beginning with literal `$HOME/` are treated differently: they must point
to an existing directory under the real host home directory, and scoder will
bind that directory read-only into the sandbox at the matching mirrored path
under `/home/scoder/`. For example, `$HOME/Git/other-project` becomes
`/home/scoder/Git/other-project`.

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

## After a session

### Direct mode (default)

Changes are made directly to your working directory. No branch is created,
no cleanup is needed. The `.agentreadonly` protection still applies during
the session.

### Worktree mode (`-w` / `--worktree`)

Changes are committed to the `scoder/<repo-name>` branch. The worktree is at
`/tmp/scoder/<git-repo-path>`.

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
worktree at `/tmp/scoder/<git-repo-path>`.

When scoder exits it prints:

```
scoder: ====== Session Summary ======
scoder: Branch: scoder/<git-repo-name>
scoder: Worktree: /tmp/scoder/<git-repo-path>
scoder: To review:  git log scoder/<git-repo-name>
scoder: To merge:   git merge scoder/<git-repo-name>
scoder: To rebase:  git rebase scoder/<git-repo-name>
scoder: View diff:  git diff scoder/<git-repo-name>
scoder: To discard: git worktree remove /tmp/scoder/<git-repo-path> && git branch -D scoder/<git-repo-name>
```

## Requirements

- `bwrap` (bubblewrap)
- `pasta` (usually provided by the `passt` package)
- `git`
- `ssh` (OpenSSH client) — only needed for `--allow-ssh`
- `bun` (TypeScript runtime) - install via `curl -fsSL https://bun.sh/install | bash`
- The tool you want to sandbox (e.g. `opencode`, `copilot`, `claude`)
- Tool-specific prerequisites must already be set up (and installed globally):
  - `claude`: install via `npm install -g @anthropic-ai/claude-code`
  - `copilot`: install via `npm install -g @github/copilot` or `brew install copilot-cli`, run `gh auth login` first
  - `opencode`: install from https://opencode.ai

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

Installs `bubblewrap` and `passt` via apt.
