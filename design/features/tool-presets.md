---
target-version: 2.2.0
status: draft
tags: [feature, tools, configuration]
---

# Tool Presets

## Summary

Built-in configuration presets for opencode, claude, copilot, pi, rstudio, and
eclipse that provide tool-specific config/data directory bind mounts into the
sandbox.

## Motivation

Different AI coding tools store configuration and persistent data in
different locations. scoder maps each tool's directories into the sandbox
automatically, with config read-only and data/cache read-write.

## Implementation

[IMPLEMENTED_BY](/src/tools/presets.ts)

Every preset has an async function pair:
- `configBinds(realHome, sandboxHome)` — returns bind mounts and directory specs
- `validate()` — checks tool is installed, prints install instructions if missing

Two more hooks are optional, and only some presets need them:
- `resolveArgs(hostProjectDir, sandboxProjectDir, existingArgs)` — lets a
  preset choose the tool's final argv once the project directory is known
  (`configBinds` runs before it exists). Always called when present;
  `existingArgs` is whatever the user already passed (`[]` for the `--ide`
  companion, which has no way to supply its own). Each preset decides for
  itself what to do with them — `rstudio` only fills in a default when the
  user gave none at all; `eclipse` always prepends its own fixed flags
  ahead of whatever the user passed. See `ToolPreset.resolveArgs` in
  `src/types.ts`.
- `prepareCommand(hostProjectDir, sandboxProjectDir, dependencyDirs)` — runs
  a separate, complete command inside the sandbox before the tool/IDE exec,
  for setup work that has to happen inside the sandbox's own mount
  namespace. Only `eclipse` uses this today — see below and
  `design/implementation/plans/eclipse-preset.md`. A non-zero exit here is
  a loud, whole-launch failure (`wrapWithPrepareStep` in
  `src/sandbox/builder.ts`), not something folded silently into the other
  hooks. `dependencyDirs` is the sandbox-side destinations of every
  `.agentreadonly` `$HOME/...` entry already resolved for this session
  (`ProtectionConfig.dependencyDirs` in `src/git/protection.ts`).

| Tool | Config (ro) | Data/Cache (rw) |
|------|------------|-----------------|
| opencode | ~/.config/opencode | ~/.local/share/opencode, ~/.cache/opencode |
| claude | ~/.claude.json, ~/.config/claude, ~/.local/share/claude | ~/.claude |
| copilot | ~/.config/github-copilot, ~/.copilot | ~/.local/share/github-copilot |
| pi | — | ~/.pi/agent, ~/.local/share/pi, ~/.cache/pi |
| rstudio | — | ~/.config/rstudio, ~/.local/share/rstudio, plus pi's own binds (see below) |
| eclipse | ~/.eclipse/\<hash\> (reused, when found) or a scoder-managed fallback | ~/.local/share/scoder-eclipse-workspaces/\<project\>, plus the reused/fallback config dir above |

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

### eclipse

Eclipse's workspace is not "point the IDE at a directory" — it's a
persistent metadata store that records, per project, an absolute path back
to that project's real location on disk, in a binary, versioned,
checksummed file format (`.location`, under
`.metadata/.plugins/org.eclipse.core.resources/.projects/<name>/`). A
workspace built or last used outside the sandbox has every project
reference pointing at a path that doesn't exist inside it — none of
scoder's own path-mirroring saves this, since project paths under `$HOME`
are remapped onto `/home/scoder`.

The full investigation, including why hand-writing `.location` was
rejected and what was verified against a real Eclipse install, is
`design/implementation/plans/eclipse-preset.md`. In short:

- `configBinds` locates the host's Eclipse install (resolving `which
  eclipse` through any symlinks) and binds a vendored, pinned plugin jar
  (`seeq12/eclipse-import-projects-plugin`, `assets/eclipse/`) read-only
  at a fixed, always-creatable sandbox path — **not** inside the install's
  own `plugins/` directory: that was tried first and confirmed broken in
  real use (bwrap needs to *create* a destination node for a file that
  doesn't already exist there, which fails once the parent has already
  been mounted read-only by builder.ts's own wholesale system binds).
  The plugin is registered with Equinox via a completely separate,
  scoder-private `bundles.info` — built fresh every launch (from
  whichever real one is found, purely as a base template) and bound in
  read-only alongside the jar — pointed at via a trailing `-vmargs
  -Dorg.eclipse.equinox.simpleconfigurator.configUrl=file:<path>`
  argument. **Not** by editing any real bundles.info directly: an earlier
  version did exactly that, which real-world use flagged as a real
  hygiene problem (a value written into a file read both natively and
  in-sandbox can only ever be valid in one of those two contexts, since
  `$HOME` has two different spellings) — confirmed directly against the
  real `eclipse` binary that pointing the `configUrl` system property at
  a separate file works identically, with the real bundles.info
  untouched either way. See eclipse-preset.md's "The plugin-injection
  bug, and the real fix" and "The fifth bug". `configBinds` also binds a
  persisted, project-scoped workspace directory
  (`~/.local/share/scoder-eclipse-workspaces/<project>`, read-write) and
  Eclipse's own runtime configuration area: **reusing whichever real,
  already-existing host directory Equinox's own default resolution would
  use, checked in the same order**: first `<install-dir>/configuration`
  itself, if the current user can already write to it directly (the
  common case on a personal machine — a real bug, found and fixed after
  real-world use, since an earlier version skipped straight to the next
  check and silently used an empty fallback instead); else the host's
  existing `~/.eclipse/<app>_<version>_<hash>/` directory, if one exists
  (bound in *whole*, not narrowed to a `configuration/` subpath — a real
  install turned out to have bundles.info at two plausible nested
  locations at once, and binding the whole directory sidesteps needing
  to know which one matters — at the identical mirrored sandbox path;
  the hash is a pure function of the install directory's own path, and
  scoder mounts `/opt`-style install paths unchanged between host and
  sandbox, so the same hash applies in both places); falling back to a
  scoder-managed directory, keyed by that same hash, only when neither
  real directory exists.
- `prepareCommand` runs the vendored plugin's headless-import application
  inside the sandbox, before the interactive launch, importing the main
  project and every `.agentreadonly` `$HOME/...` dependency as its own
  project — solving "a Java project references other local projects that
  also need to be workspace projects" without a manual step. Safe to
  re-run on every launch: the plugin's own code already branches on
  `project.isOpen()` to import vs. refresh. Both the primary preset's own
  `prepareCommand` and the `--ide` companion's own run, in that order, if
  either or both define one — `pi --ide eclipse` (eclipse's actual
  intended use case) needs eclipse's own step to run even though it's
  the companion, not the primary tool.
- `resolveArgs` always prepends `-data <workspace>` (and `-configuration
  <dir>`, only in the fallback case) to the interactive launch, whatever
  args the user passed — these are intrinsically tied to project identity,
  not something a user would reasonably want to override.

Like `rstudio`, this is a GUI app needing the same X11
socket/`DISPLAY`/`XAUTHORITY` access — but unlike `rstudio`'s, this has
**not** been independently re-verified: this project has no host with GTK
installed and a real X session to confirm the interactive phase against,
only the headless prepare step.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./host-tool-binding.md)
[HAS_FEATURE](./local-bin-resolution.md)
