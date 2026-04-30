# scoder Design Decisions & Architecture

This document records the design decisions, trade-offs, and technical
discoveries made during the v2.0.0 rewrite of scoder. It is intended as a
reference for future contributors and for the original author when returning
to the codebase after time away.

## Table of Contents

- [Goals and Non-Goals](#goals-and-non-goals)
- [Architecture Overview](#architecture-overview)
- [Sandboxing Strategy](#sandboxing-strategy)
- [Git Worktree Lifecycle](#git-worktree-lifecycle)
- [Tool Preset System](#tool-preset-system)
- [Path Mirroring](#path-mirroring)
- [Infrastructure Protection](#infrastructure-protection)
- [AppArmor Compatibility](#apparmor-compatibility)
- [Bash Pitfalls Encountered](#bash-pitfalls-encountered)
- [Decisions Explicitly Rejected](#decisions-explicitly-rejected)
- [Known Limitations and Future Work](#known-limitations-and-future-work)

---

## Goals and Non-Goals

### Goals

1. **Multi-tool sandboxing** — support opencode, claude, copilot, and
   arbitrary commands, each with sensible defaults.
2. **Git isolation** — all file changes happen on a disposable branch via
   git worktrees. The user's working tree is never modified.
3. **Minimal configuration** — no config files. Flags and environment
   variables only. Assume the user has already set up their tools (e.g.,
   `gh auth login`).
4. **Transparency** — the user should always know what happened. Print a
   session summary on exit with branch name, commit count, and merge/discard
   instructions.
5. **Single-file script** — no dependencies beyond bash, bwrap, and git.

### Non-Goals

- **Landlock/landrun support** — investigated and removed. The Landlock
  layer did not actually restrict anything useful in practice (the kernel
  enforcement was incomplete for our use case). Bubblewrap alone provides
  the necessary isolation.
- **Container-level isolation** — scoder is not a container runtime. It
  uses bwrap for filesystem namespacing, not for full process/network/cgroup
  isolation.
- **Config file format** — no `scoder.json`, `scoder.toml`, or similar.
  The tool should be opinionated and require zero configuration.
- **Automatic tool installation** — if a tool is missing, scoder prints an
  informative error with install instructions and exits.

---

## Architecture Overview

The script is structured in sequential phases:

```
Option parsing
  -> Early validation (bwrap exists, AppArmor check)
  -> Special modes (--configure-apparmor) exit early
  -> Tool preset selection and defaults merging
  -> Git worktree creation (branch + /tmp directory)
  -> EXIT trap registered for session summary
  -> Tool-specific config bind-mount setup
  -> Infrastructure protection overlays
  -> bwrap command array construction
  -> bwrap (in the shell process)
```

---

## Sandboxing Strategy

### Why Bubblewrap

Bubblewrap (`bwrap`) is a well-maintained, minimal sandboxing tool used by
Flatpak. It uses unprivileged user namespaces to create a restricted
filesystem view without requiring root. Key capabilities we use:

- `--bind` / `--ro-bind` — mount host paths into the sandbox, writable or
  read-only
- `--tmpfs` — ephemeral in-memory filesystems (for HOME, /tmp)
- `--dir` — create empty directories in the sandbox
- `--unshare-net` — network namespace isolation
- `--clearenv` / `--setenv` — environment variable control
- `--new-session` — new session ID (prevents signal leakage)
- `--die-with-parent` — kill sandbox if parent dies
- `--chdir` — set working directory

### Sandbox Shape

```
/usr, /bin, /lib, /etc, /sys, /run  → read-only from host
/dev                                → devtmpfs (or restricted subset)
/proc                               → procfs
/tmp                                → ephemeral tmpfs
/home/scoder                        → ephemeral tmpfs (sandbox HOME)
  └── .config/, .local/, .cache/    → empty dirs + selective bind-mounts
<worktree-real-path>                → bind from /tmp/scoder/<git-repo-path>
<git-dir-real-path>                 → bind from host .git (rw)
```

### Environment

The sandbox starts with `--clearenv` and explicitly sets:
- `PATH` — constructed from system paths + worktree-local tool paths
- `HOME` — `/home/scoder`
- `USER`, `LOGNAME` — `scoder`
- `TERM`, `LANG` — inherited from host
- `EDITOR`, `VISUAL`, `NO_COLOR`, `FORCE_COLOR` — passed through if set

`GIT_WORK_TREE` is intentionally **not** set. See [Path Mirroring](#path-mirroring).

### Agent Skills Snapshot

`~/.agents` is not bound directly. Instead, scoder copies it with
`cp -aL` to a temporary directory under `/tmp` and then bind-mounts that copy
read-only into `/home/scoder/.agents`.

This keeps agent skills usable when the host `~/.agents` tree contains
symlinked skills or symlinked subdirectories. The trade-off is that the
sandbox sees a startup-time snapshot rather than live updates made to
`~/.agents` after the session begins.

### Sandbox AGENTS.md Overlay

The workspace `AGENTS.md` visible inside the sandbox is also overlaid from a
temporary file under `/tmp`. scoder copies the repository `AGENTS.md` if one
exists, appends a short section explaining that the agent is inside a scoder
sandbox, and then bind-mounts that file read-only over `AGENTS.md` in the
worktree.

This keeps the repository copy untouched while giving the sandboxed agent
environment-specific instructions. The overlay must be applied after the main
worktree bind, just like the protected infrastructure read-only overlays.

---

## Git Worktree Lifecycle

### Why Worktrees

Git worktrees provide a lightweight way to check out a branch at a separate
path without cloning the entire repository. This gives us:

1. **Isolation** — changes happen in `/tmp`, not in the user's checkout.
2. **Branch tracking** — all changes land on a named branch that can be
   reviewed, merged, or discarded.
3. **No duplication** — the worktree shares the same `.git` object store
   as the main checkout.

### Lifecycle

1. **Create**: `git worktree add -b scoder/<git-repo-name> /tmp/scoder/<git-repo-path> HEAD`
2. **Use**: the tool operates on the worktree. If scoder is started from that
   worktree later, it reuses the current checkout instead of trying to set it
   up again. Commits go to the same branch. If the sandbox needs the latest
   changes from `main`, the intended flow is `git fetch origin` followed by
   `git rebase origin/main` (or `git merge origin/main`) from inside the
   sandbox worktree.
3. **Exit**: the EXIT trap commits changes, prints a summary (commit count, diffstat)
   and leaves the worktree + branch for the user to review or merge.
4. **Cleanup** (manual): `git worktree remove <path> && git branch -D <branch>`

### Branch Naming

Format: `scoder/<git-proj-name>`

scoder sessions always take place in the same branch and will reuse the same worktree if
it exists.

Other checkouts only observe changes on that branch when commits are created.
Uncommitted edits remain local to the `/tmp/scoder/...` worktree and are not
visible through the branch ref alone.

### Uncommitted Changes Warning

If the user has uncommitted changes in their working tree when starting
scoder, we exit with error. The one exception is when the current checkout is
already the repo's registered `scoder/<name>` worktree, in which case those
in-progress changes are the session state we want to continue using.

---

## Tool Preset System

### Design

Each supported tool has three functions:

- `preset_<tool>()` — sets default values
- `preset_<tool>_config_binds()` — populates `TOOL_BINDS[]` and `TOOL_DIRS[]`
  arrays with bind-mount specifications
- `preset_<tool>_validate()` — checks prerequisites (tool installed, etc.)

This convention-based dispatch (`"preset_${TOOL_NAME}_config_binds"`) avoids
the need for a registry or case statement for each operation.

### Per-Tool Details

| Tool | Config Paths | Notes |
|------|--------------|-------|
| opencode | `~/.config/opencode` (ro), `~/.local/share/opencode` (rw), `~/.cache/opencode` (rw) | Data/cache dirs created if missing |
| claude | `~/.claude` (ro), `~/.config/claude` (ro) | Both paths checked (location varies) |
| copilot | `~/.config/gh` (ro), `~/.config/github-copilot` (ro), `~/.local/share/github-copilot` (rw) | Config paths based on docs, not verified with real tool |

### Generic Commands

Any command not matching a preset name gets a generic sandbox: The validation tests use
`/bin/bash` this way.

---

## Path Mirroring

### The Problem

Git worktrees use a `.git` **file** (not directory) in the worktree root
that contains:

```
gitdir: /path/to/main/.git/worktrees/<name>
```

The main `.git/worktrees/<name>/gitdir` file points back:

```
/tmp/scoder/<git-repo-path>
```

Both paths must resolve correctly inside the sandbox. If we remapped the
worktree to a different path (e.g., `/home/scoder/workspace`), the cross-
references would break.

### The Solution

Mount everything at its **real absolute path**:

- The worktree at `/tmp/scoder/<git-repo-path>` is bound to `/home/scoder/<git-repo-path>`
- The `.git` directory at its real path is bound to that same path

This means git operations work correctly inside the sandbox without any
path translation.

### GIT_WORK_TREE Must Not Be Set

Setting `GIT_WORK_TREE` would override git's worktree detection (reading
the `.git` file) and cause confusion about which working tree to use. We
rely entirely on git's built-in worktree discovery.

---

## Infrastructure Protection

Certain files should not be modified by sandboxed tools:

- **`.github/`** — CI/CD workflows. A malicious or confused AI could inject
  workflow steps, copilot agents and skills.
- **`.opencode/`, `.claude/`, `opencode.json`** opencode and claude agents and skills
- **`.gitignore`** — changing ignore rules could hide malicious files from
  review.
- **Lockfiles** (`package-lock.json`, `poetry.lock`, `Cargo.lock`,
  `pnpm-lock.yaml`, `yarn.lock`, `mise.toml`) — supply chain attack vector if modified.

These are overlaid with `--ro-bind` **after** the worktree bind, which
makes them read-only even though the worktree itself is writable. The
`--allow-infra` flag disables this protection.

The `.git` directory protection works differently: since the worktree's
`.git` is a file pointing to the main repository's `.git` directory, we
control access by binding the main `.git` directory as either `--ro-bind`
or `--bind` depending on `--allow-git`.

---

## AppArmor Compatibility

### The Problem

Ubuntu 24.04+ ships with `kernel.apparmor_restrict_unprivileged_userns=1`,
which prevents unprivileged processes from creating user namespaces unless
they have an AppArmor profile granting the `userns` permission. Since
bubblewrap relies on unprivileged user namespaces, it fails on these
systems out of the box.

### The Solution

`sudo scoder --configure-apparmor` installs a minimal AppArmor profile at
`/etc/apparmor.d/bwrap`:

```
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
```

This is the same approach used by Chrome, Firefox, and Flatpak. The
profile grants `userns` permission to the bwrap binary and nothing else
(`flags=(unconfined)` means all other access is unconfined, as before).

### Early Diagnostic

`check_bwrap_userns()` runs before any main logic. It attempts
`bwrap --bind / / /bin/true` and if that fails:

1. Checks if the failure looks like a user namespace error
2. Checks `kernel.apparmor_restrict_unprivileged_userns` sysctl
3. Prints specific advice: either "run --configure-apparmor" or "reload
   the existing profile"

This saves users from debugging opaque bwrap errors.

---

## Bash Pitfalls Encountered

### `set -e` and `((var++))`

With `set -e` (errexit), the arithmetic expression `((var++))` when `var`
is 0 evaluates to 0, which is falsy, and triggers immediate exit. Fixed by
using `var=$((var + 1))` instead of `((var++))`.

### Empty Arrays with `set -u`

Referencing `"${ARRAY[@]}"` when `ARRAY` is empty triggers an "unbound
variable" error under `set -u` (nounset) in bash versions before 4.4.
Protected with:

```bash
if [[ ${#ARRAY[@]} -gt 0 ]]; then
    cmd "${ARRAY[@]}"
fi
```

### Cleanup Trap and `set -e`

The EXIT trap function (`cleanup_worktree_summary`) starts with `set +e`
to ensure it runs to completion even if individual commands within it fail
(e.g., git commands on a partially-created worktree).

### `/sbin` May Be a Symlink

On some systems, `/sbin` is a symlink to `/usr/sbin`. Binding a symlink
as `--ro-bind /sbin /sbin` fails. The script checks
`[[ -d /sbin && ! -L /sbin ]]` before adding the bind.

---

## Decisions Explicitly Rejected

### Landlock / landrun

Investigated as an additional restriction layer. Removed because:
- The Landlock enforcement was incomplete for the filesystem paths we cared
  about.
- Bubblewrap already provides the namespace-based isolation we need.
- Adding a second layer increased complexity without measurable security
  benefit.

### Remapping Paths Inside the Sandbox

Considered mounting the worktree at `/home/scoder/workspace` for a cleaner
sandbox layout. Initially rejected because git worktree cross-references use absolute
paths, and remapping would break them. However current version maps files in sandbox to
same location in real filesystem and appears to work, so `/home/$USER/Git/project-a` is
created as a worktree in `/tmp/scoder/Git/project-a` which is mapped in the
sandbox to `/home/scoder/Git/project-a`. This needs monitoring.

### Config File

Considered `scoder.json` or `~/.config/scoder/config`. Rejected in favor
of flags and environment variables only. The tool should be opinionated
enough that configuration is rarely needed, and when it is, a flag is more
discoverable and composable than a config file.

### Automatic Cleanup of Worktrees

Considered automatically deleting the worktree and branch on exit if no
changes were made. Rejected because:
- The user might want to inspect even an unchanged worktree to verify the
  sandbox worked correctly.
- Automatic deletion of the branch with changes is dangerous.
- Manual cleanup instructions are printed on every exit.

### Setting GIT_WORK_TREE

Rejected. See [Path Mirroring](#path-mirroring).

### Per-Tool Network Defaults

All tools currently default to network=on. Considered making some tools
default to network=off, but every supported tool (opencode, gh, claude,
copilot) genuinely needs network access to function. A tool that doesn't
need network access is the exception, not the rule, so `--no-net` is the
opt-in flag.

---

## Known Limitations and Future Work

### Copilot CLI Config Paths

The copilot preset binds `~/.config/github-copilot` and
`~/.local/share/github-copilot`. These paths are based on documentation
and convention, not verified by running the actual tool (copilot was not
installed on the development machine). They may need adjustment.

### Live Tool Testing

The validation suite lives in `tests/validate.sh`. It uses `/bin/bash` as the
sandboxed tool, which exercises the sandbox mechanics (HOME isolation,
filesystem protection, worktree creation and worktree reuse). However, it does
not test with real tools (opencode, gh, claude, copilot). Edge cases in how
those tools interact with the sandbox (e.g., specific paths they try to write
to, signals they handle) may surface during real use.

### Worktree Accumulation

scoder creates worktrees and branches but never cleans them up
automatically. Because we reuse branches and worktrees for multiple
.

### Signal Handling

The current signal setup is:
- `trap cleanup_worktree_summary EXIT` — always runs on exit
- `trap 'exit 130' INT` — converts SIGINT to exit code 130 (triggering EXIT trap)
- `trap 'exit 143' TERM` — converts SIGTERM to exit code 143

Originally the final line was `exec bwrap ...`, but the shell process was replaced
and these traps are no longer active during tool execution, and the cleanup was
not being triggered when the tool finished, so the exec was removed.
Bwrap's `--die-with-parent` ensures cleanup if the parent process dies.


### No Nested Sandbox Detection

If scoder is run inside an existing scoder sandbox, it will attempt to
create a worktree from the worktree's `.git` file, which may or may not
work correctly. A future version could detect this (e.g., check for
`SCODER_SANDBOX=1` env var) and either refuse or adjust behavior.

### Read-Write Config Mounts

Some tool presets mount data/cache directories as read-write (e.g.,
opencode's `~/.local/share/opencode`). This means the sandboxed tool can
modify persistent state on the host. This is intentional — these tools
need to persist session data, databases, and caches — but it does create
a limited escape from the sandbox's filesystem isolation.
