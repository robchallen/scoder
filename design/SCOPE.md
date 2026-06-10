---
target-version: 2.1.0
status: draft
tags: [scope, overview]
---

# scoder Project Scope

## Purpose

scoder sandboxes AI coding tools (opencode, claude, copilot, pi) using
bubblewrap (bwrap) for filesystem isolation and `pasta` for network
isolation, with optional git worktree isolation. It lets developers run AI
coding assistants in a restricted environment where the tool cannot access
files outside the project, modify protected infrastructure, or reach host
localhost services by default.

## Implemented Features

[HAS_FEATURE](./features/sandbox-isolation.md) - Filesystem isolation via bubblewrap with read-only system mounts and ephemeral HOME.

[HAS_FEATURE](./features/network-isolation.md) - Outbound network access through pasta with host loopback blocking and optional LLM port forwarding.

[HAS_FEATURE](./features/git-worktree-isolation.md) - Optional git worktree mode that isolates changes to a scoped branch in /tmp.

[HAS_FEATURE](./features/tool-presets.md) - Built-in configuration presets for opencode, claude, copilot, and pi with tool-specific config/data binds.

[HAS_FEATURE](./features/infrastructure-protection.md) - Default and user-configurable protection of critical files (.github/, .gitignore, lockfiles) via .agentreadonly.

[HAS_FEATURE](./features/path-mirroring.md) - Real-path mounting strategy so git cross-references work inside the sandbox without GIT_WORK_TREE.

[HAS_FEATURE](./features/agents-md-overlay.md) - Sandbox AGENTS.md overlay that appends environment-specific instructions without modifying the repository copy.

[HAS_FEATURE](./features/agents-skills-snapshot.md) - Startup-time snapshot of ~/.agents with symlink resolution for read-only sandbox access.

[HAS_FEATURE](./features/apparmor-compatibility.md) - Automatic AppArmor profile installation for Ubuntu 24.04+ systems with restricted user namespaces.

[HAS_FEATURE](./features/dry-run-mode.md) - Dry-run mode that prints the bwrap command without executing it.

[HAS_FEATURE](./features/host-tool-binding.md) - Selective read-only binding of host tools and configs (.gitconfig, .local/bin, .cargo, .rustup, mise, R, .m2, .npmrc, .pypirc).

[HAS_FEATURE](./features/direct-mode.md) - Direct mode (`--no-worktree`) runs the tool in the current directory without git worktree isolation.

## Planned Features

From [ROADMAP.md](/ROADMAP.md), not yet in development:

- **Additional AI tool presets** — as new coding assistants emerge, add presets following the existing convention.
- **Restricted `/dev`** — bind only essential devices (`/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/tty`, `/dev/pts`, `/dev/fd`).
- **Nested sandbox detection** — detect when scoder runs inside an existing scoder session (`SCODER_SANDBOX=1`) and refuse or adjust behaviour.
- **Auto-cleanup on no changes** — optionally remove the worktree and branch if the session made no commits.
- **R environment variables** — pass through `R_LIBS`, `R_LIBS_USER`, `R_HOME` and bind `~/.Renviron`.
- **Configurable env var passthrough** — make the set of passed-through environment variables user-configurable.
- **Real-tool integration tests** — extend `tests/validate.ts` to optionally test with an actual tool preset.

## Non-Goals

- Container-level isolation (no cgroups, no full process isolation)
- Landlock support (investigated and removed)
- Config file format (flags and env vars only)
- Automatic tool installation
- Automatic worktree/branch cleanup
