# scoder Roadmap

This document catalogues scoder's current functionality and identifies areas
for future development. It is intended as a reference for contributors and for
the author when prioritising improvements.

---

## Current Functionality

### Sandboxing

| Feature | Detail |
|---------|--------|
| Filesystem isolation | bubblewrap (`bwrap`) user-namespace sandbox |
| System paths | `/usr`, `/bin`, `/lib`, `/etc`, `/sys`, `/run` mounted read-only |
| Ephemeral HOME | `/home/scoder` on tmpfs — wiped on exit |
| Ephemeral `/tmp` | Fresh tmpfs per session |
| Device access | Full `/dev` passthrough; `/dev/shm` replaced with fresh tmpfs |
| Network | Full host network access (no restriction by default) |
| Working directory | Sandboxed tool lands in the project directory |

### Git Worktree Isolation

| Feature | Detail |
|---------|--------|
| Branch per project | `scoder/<git-repo-name>` — reused across sessions on the same repo |
| Worktree location | `/tmp/scoder/<git-repo-path>` — mirrors real path for git cross-references |
| Uncommitted changes guard | Exits with error if the host checkout has uncommitted changes |
| Session commit | On exit, all worktree changes are committed automatically |
| Session summary | Prints branch name, commit count, diffstat, and merge/discard instructions |
| Manual cleanup | Worktrees and branches are retained for review; user cleans up manually |

### Tool Presets

Each preset provides tool-specific config bind-mounts and prerequisite validation.

| Tool | Paths bound | Access |
|------|-------------|--------|
| `opencode` | `~/.config/opencode` | read-only |
| | `~/.local/share/opencode` | read-write |
| | `~/.cache/opencode` | read-write |
| `claude` | `~/.claude` | read-only |
| | `~/.config/claude` (if present) | read-only |
| `copilot` | `~/.config/gh` | read-only |
| | `~/.config/github-copilot` | read-write |
| | `~/.copilot` | read-write |
| | `~/.cache/copilot` | read-write |
| | `~/.local/share/github-copilot` | read-write |
| *(any command)* | Generic sandbox — no preset binds | — |

### Host Tool Bind-Mounts (all sessions)

Bound read-only when the path exists on the host:

| Path | Purpose |
|------|---------|
| `~/.local/bin` | User-installed binaries |
| `~/R`, `~/.Rprofile` | R user library and profile (supports R MCP servers) |
| `~/.m2` | Java/Maven local repository |
| `~/.rustup`, `~/.cargo/bin` | Rust toolchain and binaries |
| `~/.local/share/mise`, `~/.config/mise` | mise-en-place tool manager |
| `~/.npmrc`, `~/.pypirc` | Package manager credentials |

Worktree-local tool paths added to `PATH` automatically:

| Path | Added when |
|------|-----------|
| `<project>/.venv/bin` | `.venv/` exists in worktree |
| `<project>/node_modules/.bin` | `node_modules/.bin/` exists |
| `<project>/bin` | `bin/` exists alongside `go.mod` |

### Infrastructure Protection

Certain paths in the worktree are overlaid read-only to prevent accidental or
malicious modification by the sandboxed tool.

Default protected paths: `.github/`, `.opencode/`, `.claude/`, `opencode.json`,
`.gitignore`, `package-lock.json`, `poetry.lock`, `Cargo.lock`, `pnpm-lock.yaml`,
`yarn.lock`, `mise.toml`.

Customisable via `.agentreadonly` in the repository root (`.gitignore` syntax).
An empty `.agentreadonly` makes all workspace files writable. `.agentreadonly`
itself is always protected.

### Environment

| Variable | Value inside sandbox |
|----------|---------------------|
| `HOME` | `/home/scoder` |
| `USER`, `LOGNAME` | `scoder` |
| `PATH` | Constructed from system + worktree-local + host tool paths |
| `TERM`, `LANG` | Inherited from host |
| `EDITOR`, `VISUAL` | Passed through if set |
| `NO_COLOR`, `FORCE_COLOR` | Passed through if set |
| `ANTHROPIC_API_KEY` et al. | Common AI tool API keys passed through if set |

### CLI

| Flag | Effect |
|------|--------|
| `--dry-run` | Print the full bwrap command without executing |
| `--configure-apparmor` | Install AppArmor profile for bwrap (Ubuntu 24.04+, requires sudo) |
| `--install-dependencies` | Install `bubblewrap` via apt (requires sudo) |
| `--quiet` / `-q` | Suppress informational output |

### AppArmor Compatibility

Detects Ubuntu 24.04+ `kernel.apparmor_restrict_unprivileged_userns=1` and
provides actionable guidance. `--configure-apparmor` installs a minimal profile
granting `userns` permission to bwrap.

---

## Potential Future Extensions

These are not commitments — they are recorded here to inform future decisions.

### Network control
- **`--no-net` flag** — pass `--unshare-net` to bwrap to disable network
  access. Useful for offline coding tasks or tools that shouldn't phone home.
  (Was documented in v2.0.0 but never implemented; option parser entry and
  bwrap flag both missing.)

### Tool presets
- **`gh` preset** — GitHub CLI has a predictable config path (`~/.config/gh`).
  A preset would bind it read-only so `gh` commands work inside the sandbox
  without needing the copilot preset.
- **Additional AI tool presets** — as new AI coding assistants emerge, presets
  can be added following the three-function convention in `AGENTS.md`.

### Sandbox hardening
- **Restricted `/dev`** — bind only essential devices (`/dev/null`,
  `/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/tty`, `/dev/pts`,
  `/dev/fd`). Commented-out code for this already exists in the script.
- **Nested sandbox detection** — detect when scoder is run inside an existing
  scoder session (e.g., via `SCODER_SANDBOX=1` env var) and either refuse or
  adjust behaviour.

### Git lifecycle
- **Branch-per-session option** — restore the original `scoder/<tool>/<date>-<hex>`
  naming to isolate each run on its own branch, rather than reusing one branch
  per project.
- **Auto-cleanup on no changes** — optionally remove the worktree and branch if
  the session made no commits.

### Configuration
- **R environment variables** — pass through `R_LIBS`, `R_LIBS_USER`,
  `R_HOME` if set, and bind `~/.Renviron`, to support non-default R library
  configurations alongside the existing `~/R` bind.
- **Env var passthrough list** — make the set of passed-through variables
  configurable (e.g., additional API keys or tool-specific vars).

### Validation
- **Real-tool integration tests** — extend `tests/validate.sh` to optionally
  test with an actual tool preset rather than only with `/bin/bash`.
