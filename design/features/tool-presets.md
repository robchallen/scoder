---
target-version: 2.2.0
status: draft
tags: [feature, tools, configuration]
---

# Tool Presets

## Summary

Built-in configuration presets for opencode, claude, copilot, pi, and rstudio
that provide tool-specific config/data directory bind mounts into the sandbox.

## Motivation

Different AI coding tools store configuration and persistent data in
different locations. scoder maps each tool's directories into the sandbox
automatically, with config read-only and data/cache read-write.

## Implementation

[IMPLEMENTED_BY](/src/tools/presets.ts)

Each tool has an async function pair:
- `configBinds(realHome, sandboxHome)` — returns bind mounts and directory specs
- `validate()` — checks tool is installed, prints install instructions if missing

| Tool | Config (ro) | Data/Cache (rw) |
|------|------------|-----------------|
| opencode | ~/.config/opencode | ~/.local/share/opencode, ~/.cache/opencode |
| claude | ~/.claude.json, ~/.config/claude, ~/.local/share/claude | ~/.claude |
| copilot | ~/.config/github-copilot, ~/.copilot | ~/.local/share/github-copilot |
| pi | — | ~/.pi/agent, ~/.local/share/pi, ~/.cache/pi |
| rstudio | — | ~/.config/rstudio, ~/.local/share/rstudio, plus pi's own binds (see below) |

`~/.config/gh` is not preset-specific — it is bound read-only for every
sandbox by `buildExtraBinds`, so any tool can use an authenticated `gh`.

`~/.claude` is bound **read-write**: Claude Code writes there continuously
(todos, history, shell snapshots, stats) and fails rather than degrades under a
read-only bind. It also holds host-executed configuration — `settings.json`
hooks, `skills/`, `CLAUDE.md` — so this bind is the widest host write surface any
preset opens. See
[rw-config-mounts-limited-escape](../implementation/debt/rw-config-mounts-limited-escape.md).

This is distinct from the *workspace* `.claude/` directory, which remains
read-only via `infrastructure-protection`.

`~/.claude.json` holds Claude Code's top-level state (project history, MCP
server registrations, onboarding flags). It is bound read-only, so a session
reads the host's state but cannot alter it — writes inside the sandbox do not
reach the host and do not survive the session.

`~/.local/share/claude` holds the versioned binary installed by Claude Code's
native installer, which `~/.local/bin/claude` symlinks at. Without this bind
that symlink dangles inside the sandbox and the tool cannot start. It is bound
read-only so a sandboxed session cannot self-update the host installation.

### rstudio

RStudio Desktop is a GUI app, so this preset also binds `/tmp/.X11-unix`
(the host's X11 socket directory) and passes `DISPLAY` through, plus
`XAUTHORITY` and its backing file when the host X session uses cookie-based
auth (bound to a sandbox-side path, not the host's own — `XAUTHORITY` is a
filesystem path, unlike the plain passthrough env vars below, so it cannot
come from the generic `passThrough` list in `builder.ts`; see
`ToolBindSpec.env` in `src/types.ts`).

This is a deliberate, accepted relaxation of the sandbox's isolation, not
an oversight — see
[0002-rstudio-x11-access](/architecture/decision-records/0002-rstudio-x11-access.md)
for the full trade-off and what was verified before accepting it. `pi` runs
inside RStudio's own embedded terminal, so this preset also includes pi's
own config/data/cache binds — via a shared `piConfigBinds` helper, not a
second, separately-maintained copy of the same list.

Also passes `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` through when
set on the host — reported: most menu items greyed out except cut/copy/
paste, and only the window manager's own close button quits RStudio.
RStudio Desktop is Electron/Chromium-based, and such apps commonly need
D-Bus for native file dialogs and session/quit integration, degrading
rather than crashing when it's unavailable, which matches the symptom.
This is a well-motivated fix, not a verified one — this project has no
real RStudio install or desktop D-Bus session to confirm the actual
symptom against, unlike the X11 mechanics above. No extra bind is needed
for the socket itself: confirmed directly that bwrap's `--ro-bind`
recurses into a nested mount stacked on its source, so `/run/user/<uid>`
— a separate tmpfs on a real systemd-managed desktop — is already
reachable through the existing wholesale `--ro-bind /run /run`.

Also sets `MCPTOOLS_SOCKET_DIR=/tmp/mcptools` unconditionally — reported:
`mcptools::mcp_session()`, bridging RStudio's R console to `pi` (e.g. via
`--ide`), failed with `Socket directory /run/user/<uid>/mcptools is a
symlink; refusing to use it.` The real cause is structural, not just that
one symlink: `mcptools` defaults its socket directory to
`$XDG_RUNTIME_DIR/mcptools` (`/run/user/<uid>`), which is read-only
inside the sandbox regardless of what's already there on the host — even
with nothing at that path at all, `mcptools`' own `mkdir()` would still
fail there. Unlike the D-Bus passthrough above, this isn't gated on any
host env var: it's a fixed, always-writable sandbox path (`/tmp`, a fresh
tmpfs), not a value read from the host, and it's set once for the whole
sandbox — RStudio, `pi`, and anything `pi` spawns (e.g. its own MCP
server child process) all inherit the same bwrap-level `--setenv`,
whether `pi` is the primary tool or `rstudio` is `--ide`'s companion. No
new bind needed: `mcptools` creates the directory itself the first time
either side needs it. Harmless if `mcptools` is never used at all — an
unused env var pointing at an always-writable path.

RStudio Desktop also does not inherit the launching process's cwd for its
initial R session — reported directly: `getwd()` came back `/home/scoder`,
not the project directory, because RStudio's own default (with no
argument) is to reopen its last project, or fall back to `$HOME`, which
is always the case in a fresh sandbox. The preset's `resolveArgs` hook
(`ToolPreset.resolveArgs` in `src/types.ts`, called once `sandboxProjDir`
is known — after `configBinds` runs, so it needs its own hook) looks for
a `*.Rproj` file at the project root and passes its sandbox-side path as
the launch argument; with none found, it falls back to passing the
project directory itself. Only applied when the user passed no argument
of their own. The `.Rproj` case is RStudio's own documented, reliable way
to choose a project; the bare-directory fallback is also documented
RStudio CLI behaviour, but — like the D-Bus passthrough above — has not
been independently verified against a real RStudio Desktop install in
this project.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./host-tool-binding.md)
[HAS_FEATURE](./local-bin-resolution.md)
