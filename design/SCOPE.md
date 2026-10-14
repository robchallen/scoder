---
target-version: 2.2.0
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

[HAS_FEATURE](./features/network-isolation.md) - Outbound network access through pasta with host loopback blocking, optional LLM port forwarding, and auto-detection of localhost APIs (via SCODER_LLM_PORT).

[HAS_FEATURE](./features/git-worktree-isolation.md) - Optional git worktree mode that isolates changes to a scoped branch in /tmp.

[HAS_FEATURE](./features/tool-presets.md) - Built-in configuration presets for opencode, claude, copilot, pi, rstudio, eclipse, vscode, vscodium, positron, webstorm, and jupyterlab with tool-specific config/data binds. `--bind NAME` adds a CLI preset's binds to another tool's sandbox without launching it. `--new-workspace` resets eclipse's/vscode's scoder-managed per-project state, re-seeded from the host.

[HAS_FEATURE](./features/infrastructure-protection.md) - Default and user-configurable protection of critical files (.github/, .gitignore, lockfiles) via .sandbox/readonly.

[HAS_FEATURE](./features/path-mirroring.md) - Real-path mounting strategy so git cross-references work inside the sandbox without GIT_WORK_TREE.

[HAS_FEATURE](./features/agents-md-overlay.md) - Sandbox AGENTS.md overlay that appends environment-specific instructions without modifying the repository copy.

[HAS_FEATURE](./features/live-file-overlays.md) - A host file presented inside the sandbox with sandbox-only content added, read-only, and re-rendered whenever the host file changes.

[HAS_FEATURE](./features/agents-skills-snapshot.md) - Agent skills: every skill on the machine found at start-up, selected by `.sandbox/skills`, copied with symlinks resolved and bound read-only where the main agent reads skills.

[HAS_FEATURE](./features/apparmor-compatibility.md) - Automatic AppArmor profile installation for Ubuntu 24.04+ systems with restricted user namespaces.

[HAS_FEATURE](./features/dry-run-mode.md) - Dry-run mode that prints the bwrap command without executing it.

[HAS_FEATURE](./features/host-tool-binding.md) - Selective read-only binding of host tools and configs (.gitconfig, .local/bin, .cargo, .rustup, mise, R, .m2, .npmrc, .pypirc, .config/gh, .local/share/fonts, .config/mimeapps.list).

[HAS_FEATURE](./features/direct-mode.md) - Direct mode (`--no-worktree`) runs the tool in the current directory without git worktree isolation.

[HAS_FEATURE](./features/local-bin-resolution.md) - Startup-time snapshot of ~/.local/bin with broken symlinks replaced by forwarding shims.

[HAS_FEATURE](./features/session-temp-root.md) - One `/tmp/scoder-<id>` root per run holds everything staged for the sandbox, laid out to mirror the sandbox paths it is bound at, and removed on every exit path.

[HAS_FEATURE](./features/nested-sandbox-detection.md) - Refuses to start when it would nest a sandbox or create a worktree from a worktree (`SCODER_SANDBOX=1`, `.git` file detection).

[HAS_FEATURE](./features/ssh-tunnel-access.md) - Opt-in `--allow-ssh user@host` opens a single pre-authenticated ssh connection outside the sandbox and multiplexes only that one connection in, with no key material or agent socket exposed.

[HAS_FEATURE](./features/agent-readwrite.md) - A `.sandbox/readwrite` file at the project root lists `$HOME/...` directories bound read-write into the sandbox — a persistent cache, analysis output, or other area outside the project tree, validated the same way `.sandbox/readonly`'s own `$HOME/...` binds are.

[HAS_FEATURE](./features/ide-companion.md) - `--ide NAME` launches NAME (must have a registered preset) as a companion in the same sandbox: NAME in the background, the primary tool in the foreground, both must exit before scoder shuts down.

[HAS_FEATURE](./features/xpra-gui-isolation.md) - GUI presets run under an xpra server inside the sandbox, which forwards their windows to the host over a unix socket; the host's X11 socket, XAUTHORITY and DISPLAY are no longer exposed.

[HAS_FEATURE](./features/config-defaults.md) - shipped defaults for a project without `.sandbox/` files; starter recipes seeded into `~/.config/scoder/`; `.sandbox/env` lists the host environment variables passed into the sandbox.
[HAS_FEATURE](./features/configure-mode.md) - `--configure`: an agent-guided session that writes `.sandbox/` (and `.mcp.json`) from the user's recipes, applied only after a host-side review; runs automatically on an interactive start when a key file is missing.

[HAS_FEATURE](./features/clipboard-sharing.md) - Copying out of the sandbox: OSC 52 from the terminal works (the user's pty is bound at `/dev/tty`), xpra syncs GUI clipboards; `xclip`-style commands are planned via a one-way copy channel.

## Proposed Features (design documented, no implementation yet)

[HAS_FEATURE](./features/secret-storage.md) - What sandboxed tools do about a keyring they cannot reach: verified mechanism, an in-memory default, and an opt-in path to persistent secrets. Design proposal only — nothing implements it yet.

## From the Roadmap

From [ROADMAP.md](./legacy/ROADMAP.md), not yet in development:

- **Additional AI tool presets** — as new coding assistants emerge, add presets following the existing convention.
- **Restricted `/dev`** — bind only essential devices (`/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/tty`, `/dev/pts`, `/dev/fd`).
- **Auto-cleanup on no changes** — optionally remove the worktree and branch if the session made no commits.
- **R environment variables** — pass through `R_LIBS`, `R_LIBS_USER`, `R_HOME` and bind `~/.Renviron`.
- **Real-tool integration tests** — extend `tests/scoder.test.ts` to optionally test with an actual tool preset.

## Non-Goals

- Container-level isolation (no cgroups, no full process isolation)
- Landlock support (investigated and removed)
- Config file format (flags and env vars only)
- Automatic tool installation
- Automatic worktree/branch cleanup
