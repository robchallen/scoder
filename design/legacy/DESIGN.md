# scoder Design Decisions & Architecture

This document records the design decisions, trade-offs, and technical
discoveries made during the v2.1.0 TypeScript migration of scoder. It is
intended as a reference for future contributors and for the original author
when returning to the codebase after time away.

## Table of Contents

- [Goals and Non-Goals](#goals-and-non-goals)
- [Architecture Overview](#architecture-overview)
- [TypeScript Migration Rationale](#typescript-migration-rationale)
- [Sandboxing Strategy](#sandboxing-strategy)
- [Git Worktree Lifecycle](#git-worktree-lifecycle)
- [Direct Mode (`--no-worktree`)](#direct-mode-no-worktree)
- [Tool Preset System](#tool-preset-system)
- [Path Mirroring](#path-mirroring)
- [Infrastructure Protection](#infrastructure-protection)
- [AppArmor Compatibility](#apparmor-compatibility)
- [Known Limitations and Future Work](#known-limitations-and-future-work)

---

## Goals and Non-Goals

### Goals

1. **Multi-tool sandboxing** — support opencode, claude, copilot, pi, and
   arbitrary commands, each with sensible defaults.
2. **Flexible git isolation** — worktree mode (default) for full isolation,
   or direct mode for quick sandboxing without branch management.
3. **Minimal configuration** — no config files. Flags and environment
   variables only. Assume the user has already set up their tools (e.g.,
   `gh auth login`).
4. **Transparency** — the user should always know what happened. Print a
   session summary on exit with branch name, commit count, and merge/discard
   instructions (worktree mode only).
5. **Type safety and extensibility** — TypeScript with strict mode, clear
   interfaces, and modular architecture for easier maintenance and feature
   additions.

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

The TypeScript codebase is organized into modular components:

```
src/
├── index.ts              # Main entry point, orchestrates all phases
├── types.ts              # TypeScript interfaces and types
├── cli/
│   ├── parse-args.ts     # Option parsing and validation
│   └── apparmor.ts       # AppArmor profile installation
├── git/
│   ├── worktree.ts       # Git worktree lifecycle management
│   └── protection.ts     # .agentreadonly, AGENTS.md overlay, ~/.agents snapshot
├── tools/
│   └── presets.ts        # Tool presets (opencode, claude, copilot, pi)
├── sandbox/
│   └── builder.ts        # bwrap command construction
└── utils/
    ├── logger.ts         # Colored output functions
    └── checks.ts         # System checks (bwrap, pasta, ports)

tests/
└── scoder.test.ts        # Validation test suite
```

### Execution Flow

```
Option parsing (--help, --version, --worktree/--no-worktree, etc.)
  → Early validation (bwrap/pasta exist, AppArmor check)
  → Special modes exit early (--configure-apparmor, --install-dependencies)
  → Tool preset selection and validation
  → If worktree mode: Git worktree creation (branch + /tmp directory)
  → Infrastructure protection setup (.agentreadonly parsing, AGENTS.md overlay)
  → Agent skills snapshot (~/.agents copied to /tmp)
  → Resolver config snapshot (/etc/resolv.conf)
  → bwrap command construction with all bind mounts
  → bwrap starts pasta, pasta starts the tool in a nested network namespace
  → On exit: commit changes (worktree mode only), print summary, cleanup temp files
```

---

## TypeScript Migration Rationale

### Why TypeScript?

The original bash script was ~1500 lines. While functional, it had limitations:

1. **Type safety** — No type checking for arrays, strings, or function signatures
2. **Error handling** — Bash error handling is primitive (exit codes, traps)
3. **Testing** — Bash tests are slow and hard to write
4. **Extensibility** — Adding new features requires careful string manipulation
5. **Tooling** — Limited IDE support, no autocomplete, refactoring is manual

### Why Bun?

- **Fast** — Faster than Node.js for CLI tools
- **Native TypeScript** — No transpilation step needed
- **Single binary** — Can compile to standalone executable
- **Modern APIs** — `Bun.spawn()`, `Bun.file()`, template literals

### Trade-offs

- **Runtime dependency** — Requires bun (though wrapper script handles this)
- **Verbosity** — TypeScript is more verbose than bash (~2400 lines vs ~1500)
- **Learning curve** — Contributors need TypeScript knowledge

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
- `--unshare-user` — user namespace isolation
- `--clearenv` / `--setenv` — environment variable control
- `--new-session` — new session ID (prevents signal leakage)
- `--die-with-parent` — kill sandbox if parent dies
- `--chdir` — set working directory

### Why pasta

`pasta` provides unprivileged outbound networking for a nested namespace
without forcing the sandbox to share the host loopback interface. scoder uses
it to keep completions/API traffic working while preventing direct connections
to host-local TCP services on `127.0.0.1` and `::1`.

### Sandbox Shape

```
/usr, /bin, /lib, /etc, /sys, /run  → read-only from host
/dev                                → devtmpfs (full device access)
/proc                               → procfs
/tmp                                → ephemeral tmpfs
/home/scoder                        → ephemeral tmpfs (sandbox HOME)
  └── .config/, .local/, .cache/    → empty dirs + selective bind-mounts
<worktree-real-path>                → bind from /tmp/scoder/<git-repo-path> (worktree mode)
<cwd>                               → bind from current directory (direct mode)
<git-dir-real-path>                 → bind from host .git (rw, worktree mode only)
```

### Environment

The sandbox starts with `--clearenv` and explicitly sets:
- `PATH` — constructed from system paths + worktree-local tool paths
- `HOME` — `/home/scoder`
- `USER`, `LOGNAME` — `scoder`
- `TERM`, `LANG` — inherited from host
- `EDITOR`, `VISUAL`, `NO_COLOR`, `FORCE_COLOR` — passed through if set
- Tool-specific env vars (API keys, config paths, etc.)

`GIT_WORK_TREE` is intentionally **not** set. See [Path Mirroring](#path-mirroring).

### Network Isolation

The outer `bwrap` sandbox still shares the host network namespace, but the
tool itself is started through `pasta` inside that filesystem sandbox. The
tool therefore runs in a nested network namespace with outbound connectivity,
while `pasta` is configured with `--tcp-ns none` and `--udp-ns none` so host
localhost services are not forwarded into the sandbox by default.

For host-local LLM servers such as Ollama, `--llm-port=<port>` injects a
single TCP localhost forwarding rule via `pasta --tcp-ns <port>`, allowing
access to that fixed port while keeping all other localhost destinations
blocked.

On systems using `systemd-resolved`, `/etc/resolv.conf` normally points at the
host stub resolver on `127.0.0.53`, which would fail from the nested namespace.
scoder therefore snapshots a non-loopback resolver config into the sandbox,
preferring `/run/systemd/resolve/resolv.conf` when the host `resolv.conf` uses
loopback nameservers.

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

### `.agentreadonly` HOME binds

In addition to repository-relative protected paths, `.agentreadonly` also
accepts bare entries beginning with literal `$HOME/`. These are interpreted as
read-only reference directory binds from the host home into the sandbox's home,
preserving the same relative path under `/home/scoder/`.

For example, `$HOME/Git/other-project` is mounted read-only at
`/home/scoder/Git/other-project`. The source must exist, must resolve within
the real host home directory, and the mirrored sandbox destination must not
overlap reserved paths such as the active project worktree or tool/config bind
locations.

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

### Lifecycle (Worktree Mode)

1. **Create**: `git worktree add -b scoder/<git-repo-name> /tmp/scoder/<git-repo-path> HEAD`
2. **Reuse check**: If already in a scoder worktree, reuse it
3. **Use**: the tool operates on the worktree. Commits go to the scoder branch.
4. **Exit**: commit changes, print summary (commit count, diffstat), leave worktree + branch for review
5. **Cleanup** (manual): `git worktree remove <path> && git branch -D <branch>`

### Branch Naming

Format: `scoder/<git-repo-name>`

scoder sessions always take place in the same branch and will reuse the same worktree if
it exists.

Other checkouts only observe changes on that branch when commits are created.
Uncommitted edits remain local to the `/tmp/scoder/...` worktree and are not
visible through the branch ref alone.

### Uncommitted Changes Warning

If the user has uncommitted changes in their working tree when starting
scoder (and not already in a scoder worktree), we prompt to commit them first.
This ensures a clean base for the worktree.

---

## Direct Mode (`--no-worktree`)

### Rationale

Sometimes you want sandboxing without git branch management:
- Quick experiments
- Non-git projects
- Testing without branch accumulation
- Faster startup (no worktree creation)

### Behavior

- No git worktree created
- No branch created
- Sandboxed execution in current directory
- `.agentreadonly` protection still applies
- AGENTS.md overlay still created
- No commit on exit
- Changes are immediate in working directory

### When to Use

**Use worktree mode (default)** when:
- Working on a git repository
- You want isolated changes
- You want to review/merge/discard easily

**Use direct mode** when:
- Quick sandboxing without git overhead
- Testing a tool's behavior
- Non-git projects
- You're comfortable with immediate changes

---

## Tool Preset System

### Design

Each supported tool has an async function pair:

```typescript
interface ToolPreset {
  description: string;
  configBinds: (realHome: string, sandboxHome: string) => Promise<ToolBindSpec>;
  validate: () => Promise<boolean>;
}
```

- `configBinds()` — populates bind mounts and directory creation specs
- `validate()` — checks prerequisites (tool installed, dependencies, etc.)

This interface-based approach avoids convention-based dispatch and provides
type safety.

### Per-Tool Details

| Tool | Config Paths | Notes |
|------|--------------|-------|
| opencode | `~/.config/opencode` (ro), `~/.local/share/opencode` (rw), `~/.cache/opencode` (rw) | Data/cache dirs created if missing |
| claude | `~/.claude` (ro), `~/.config/claude` (ro) | Both paths checked (location varies) |
| copilot | `~/.config/gh` (ro), `~/.config/github-copilot` (ro), `~/.local/share/github-copilot` (rw) | Config paths based on docs |
| pi | `~/.pi/agent` (rw), `~/.local/share/pi` (rw), `~/.cache/pi` (rw) | Pi Coding Agent |

### Generic Commands

Any command not matching a preset name gets a generic sandbox with no
tool-specific binds. The validation tests use `/bin/bash` this way.

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
- **`.claude/`, `opencode.json`** — opencode and claude agents and skills
- **`.gitignore`** — changing ignore rules could hide malicious files from
  review.
- **Lockfiles** (`package-lock.json`, `poetry.lock`, `Cargo.lock`,
  `pnpm-lock.yaml`, `yarn.lock`, `mise.toml`) — supply chain attack vector if modified.

### Default Protection

By default, these paths are protected (read-only). The list can be customized
via `.agentreadonly` in the repository root.

### `.agentreadonly` File

Format: similar to `.gitignore`

- One path per line
- Comments start with `#`
- Empty file = all paths writable (except `.agentreadonly` itself)
- `$HOME/...` entries bind host home directories read-only

Example:
```
# Protect additional paths
src/config/
docs/

# Bind a reference directory from host home
$HOME/Git/other-project
```

### Implementation

Protected paths are overlaid with `--ro-bind` **after** the worktree bind,
which makes them read-only even though the worktree itself is writable.

The `.agentreadonly` file itself is always protected (cannot be modified).

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

`checkBwrapUserns()` runs before any main logic. It attempts
`bwrap --bind / / /bin/true` and if that fails:

1. Checks if the failure looks like a user namespace error
2. Checks `kernel.apparmor_restrict_unprivileged_userns` sysctl
3. Prints specific advice: either "run --configure-apparmor" or "reload
   the existing profile"

This saves users from debugging opaque bwrap errors.

---

## Known Limitations and Future Work

### Copilot CLI Config Paths

The copilot preset binds `~/.config/github-copilot` and
`~/.local/share/github-copilot`. These paths are based on documentation
and convention, not verified by running the actual tool (copilot was not
installed on the development machine). They may need adjustment.

### Live Tool Testing

The validation suite (`tests/scoder.test.ts`) uses `/bin/bash` as the
sandboxed tool, which exercises the sandbox mechanics (HOME isolation,
filesystem protection, worktree creation and worktree reuse). However, it does
not test with real tools (opencode, gh, claude, copilot). Edge cases in how
those tools interact with the sandbox (e.g., specific paths they try to write
to, signals they handle) may surface during real use.

### Worktree Accumulation

scoder creates worktrees and branches but never cleans them up
automatically. Because we reuse branches and worktrees for multiple sessions,
this is usually acceptable. However, over time, old branches may accumulate.

Manual cleanup:
```bash
# List scoder branches
git branch --list 'scoder/*'

# Remove a specific worktree and branch
git worktree remove /tmp/scoder/<path>
git branch -D scoder/<name>
```

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

### Signal Handling

The current signal handling relies on:
- Bun's async/await for cleanup
- `process.exit()` for controlled termination
- bwrap's `--die-with-parent` ensures cleanup if parent dies

Unlike the bash version, there's no explicit signal trap. This is generally
fine because the TypeScript runtime handles cleanup properly, but edge cases
(SIGKILL, system crash) may leave temp files behind.

### Validation Test Speed

The validation test suite creates git worktrees, which is slow (several
seconds per test). Future optimization could:
- Use lighter-weight tests for basic functionality
- Parallelize independent tests
- Mock filesystem operations where possible
