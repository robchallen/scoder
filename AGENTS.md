# AGENTS.md

Instructions for AI coding agents working in this repository.

## Project Overview

scoder is a **single-file bash script** (~1000 lines) that sandboxes AI coding
tools (opencode, claude, copilot) using bubblewrap (bwrap) for filesystem
isolation and `pasta` for network isolation, with git worktree isolation.
There is no build system, no package manager, no compiled artifacts. The repo
also includes a separate validation script under
`tests/validate.sh`.

### Key Files

- `scoder` — the entire application (bash script, `chmod +x`)
- `tests/validate.sh` — developer-facing validation suite
- `README.md` — user-facing documentation
- `DESIGN.md` — architecture decisions, trade-offs, pitfalls — **keep in sync
  when making non-trivial changes**

## Build / Test / Lint Commands

```bash
# Run the repo validation suite (requires bwrap and pasta installed):
./tests/validate.sh

# Dry-run to inspect the bwrap command for a specific tool:
./scoder --dry-run opencode

# There is no build step — the script is the artifact.
# Install by copying:
install -m 755 scoder ~/.local/bin/scoder

# Lint with shellcheck (not configured in CI, but the script is compatible):
shellcheck scoder
```

The validation suite lives in `tests/validate.sh`. It creates temporary git
repos under `/tmp` and cleans up their worktrees and branches on exit. To test
a single aspect manually, run the script directly:

```bash
# Example: test HOME isolation manually
./scoder -q /bin/bash -c 'echo $HOME'   # should print /home/scoder
```

## Shell Dialect and Strict Mode

- Shebang: `#!/usr/bin/env bash`
- Strict mode: `set -euo pipefail` at line 7 — **all code must be safe under
  errexit + nounset + pipefail**

## Code Style

### Indentation and Formatting

- **4 spaces**, no tabs, everywhere
- Line length: aim for ~100 characters; no hard limit
- Section headers: `# ====== Section Name ======`
- Comments above code, not trailing (except brief inline annotations)

### Naming Conventions

| Scope | Style | Example |
|-------|-------|---------|
| Global/module variable | `UPPER_SNAKE_CASE` | `NET_MODE`, `TOOL_NAME`, `BWRAP_CMD` |
| Readonly constant | `readonly UPPER_SNAKE_CASE` | `readonly PROGRAM_NAME="scoder"` |
| Local variable | `local lower_snake_case` | `local real_home="${HOME}"` |
| Function | `lower_snake_case` | `setup_git_worktree`, `check_bwrap_userns` |
| Boolean flag | `0`/`1` integer | `QUIET=0`, `DRY_RUN=1` |
| Sentinel "unset" | `-1` | `ALLOW_GIT=-1` |

### Quoting and Variable Expansion

**Always** brace and double-quote variable expansions:

```bash
# Correct:
echo "${WORKTREE_DIR}"
if [[ -z "${TOOL_NAME}" ]]; then

# Wrong:
echo "$WORKTREE_DIR"
echo $WORKTREE_DIR
```

Use single quotes only for literal strings (heredoc delimiters, grep patterns):

```bash
cat <<'EOF'       # literal heredoc
EOF
grep -q 'pattern' # literal string
```

### Conditionals

- Use `[[ ... ]]` exclusively — never `[ ... ]`
- Use `command -v` to check for executables — never `which`
- Numeric: `[[ "${var}" -eq 0 ]]`
- String: `[[ "${var}" = "value" ]]`

### Arrays

Arrays are used extensively. Two critical safety rules:

```bash
# 1. Never expand an empty array under set -u (bash < 4.4 breaks):
if [[ ${#ARRAY[@]} -gt 0 ]]; then
    cmd "${ARRAY[@]}"
fi

# 2. Append with +=:
TOOL_BINDS+=(--ro-bind "${src}" "${dest}")
```

### Arithmetic

**Never** use `((var++))` — when var is 0, it evaluates to falsy and triggers
`set -e`. Always use:

```bash
var=$((var + 1))   # correct
# ((var++))        # WRONG — exits the script when var=0
```

### Error Handling

- `error()`, `warning()`, `info()`, `info_blue()` for output (all go to stderr)
- Pattern for fatal errors: `error "message"; exit 1`
- Guard cleanup functions with `set +e` at the top
- Use `|| true` to prevent errexit on non-critical commands
- Never `set -e` inside a cleanup/trap function

### Output Functions

```bash
error "message"      # red, always shown, to stderr
warning "message"    # yellow, always shown, to stderr
info "message"       # green, suppressed by --quiet, to stderr
info_blue "message"  # blue, suppressed by --quiet, to stderr
```

## Adding a New Tool Preset

Every tool preset requires exactly 3 functions plus a case entry:

```bash
# 1. Defaults — set TOOL_NET_DEFAULT, TOOL_ALLOW_GIT_DEFAULT, TOOL_DESCRIPTION
preset_newtool() {
    TOOL_DESCRIPTION="New Tool"
}

# 2. Config binds — populate TOOL_BINDS[] and TOOL_DIRS[]
preset_newtool_config_binds() {
    local real_home="${HOME}"
    local sand_home="/home/scoder"
    if [[ -d "${real_home}/.config/newtool" ]]; then
        TOOL_DIRS+=("${sand_home}/.config/newtool")
        TOOL_BINDS+=(--ro-bind "${real_home}/.config/newtool" "${sand_home}/.config/newtool")
    fi
}

# 3. Validate — check prerequisites, return 0 (ok) or 1 (fail)
preset_newtool_validate() {
    if ! command -v newtool >/dev/null 2>&1; then
        error "newtool not found in PATH"
        return 1
    fi
    return 0
}
```

Then add a case in the tool dispatcher (~line 772):

```bash
newtool)
    HAS_PRESET=1
    preset_newtool
    ;;
```

## Script Structure (execution order)

```
Option parsing  →  Early validation (bwrap exists, AppArmor)
  →  Special modes exit early (--configure-apparmor)
  →  Tool preset selection + defaults merge (user flags override presets)
  →  Git worktree creation (branch + /tmp dir)
  →  EXIT trap registered
  →  Tool config bind-mounts built
  →  Infrastructure protection overlays
  →  bwrap command array constructed
  →  bwrap launches pasta, which launches the tool in a network namespace
  →  EXIT trap triggers cleanup, which commits changes in worktree, and suggests next steps.
```

If `exec` used to trigger bwrap the cleanup script does not run.

## Git Conventions

- **Commit messages**: lowercase imperative verb, no prefix, no trailing period
  - `add DESIGN.md documenting architecture decisions`
  - `rewrite scoder v2.0.0: multi-tool sandbox with git worktree isolation`
  - `fix worktree branch naming for tool paths with slashes`
- Branch naming for scoder sessions: `scoder/<tool>/<YYYY-MM-DD>-<hex>`

## Common Pitfalls

1. `/sbin` is a symlink on some systems — check `[[ -d /sbin && ! -L /sbin ]]`
   before binding
2. `GIT_WORK_TREE` must **never** be set — it breaks worktree discovery
3. Worktree `.git` is a **file**, not a directory — don't treat it as one
4. `--ro-bind` overlays must come **after** the parent `--bind` in the bwrap
   command to take effect
5. AppArmor on Ubuntu 24.04+ blocks bwrap — see `check_bwrap_userns()` and
   `--configure-apparmor`
