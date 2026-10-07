---
target-version: 2.2.0
status: draft
tags: [feature, tools, configuration]
---

# Tool Presets

## Summary

Built-in configuration presets for opencode, claude, copilot, pi, rstudio,
eclipse, and vscode that provide tool-specific config/data directory bind
mounts into the sandbox.

## Motivation

Different AI coding tools store configuration and persistent data in
different locations. scoder maps each tool's directories into the sandbox
automatically, with config read-only and data/cache read-write.

## Implementation

[IMPLEMENTED_BY](/src/tools/presets.ts)

A preset may also carry `ideShutdown` (`{ signal, order }`), used only when
it is named as an `--ide` companion: how that IDE is asked to close when the
primary tool exits first. The values are measurements per IDE, not
preferences — see
[design/features/ide-companion.md](/design/features/ide-companion.md).

And a preset may carry `command`: the binary it actually runs, when that
differs from the preset key the user types. Only `vscode` needs it — the
key is what everyone calls the editor, the binary is `code`. `index.ts`
resolves `preset.command ?? toolName` on the host for both the primary
tool and an `--ide` companion.

A preset can also be named with `--bind NAME`, which merges its
`configBinds` result into another tool's sandbox without launching it
(`scoder pi --bind claude`). Only `configBinds` runs: `validate()` checks
that the binary is installed, which is the launch's question, and a bound
preset is not launched. The merge uses `dedupeBinds` like an `--ide`
companion's, except for env: on a clash the running tools keep their own
values, since a bound preset's env exists for a process that is not there.
GUI presets are refused — their binds include the display grant (the xpra
socket directory, or under `--native-display` the host's X socket and
cookie), and with no GUI process that is a dangling socket directory or an
unasked-for host-display grant. A bound preset brings its read-write binds
too: `--bind claude` opens the same host write surface described for
`~/.claude` below. After the tool name, `--bind X` is claimed only when X
is a registered preset, because `--bind` is a common flag of other tools.
`SCODER_BIND` (comma- or space-separated names) makes the same request
from the environment, added to any `--bind` flags and held to the same
rules; an error names `SCODER_BIND` when that is where the name came from.

`eclipse` and `vscode` also carry `managedWorkspaceDir(hostProjectDir)`:
the host path of their scoder-managed per-project state (eclipse's
workspace, vscode's user-data-dir), computed by the same
`managedProjectDir` helper their layout resolvers use, so the two cannot
disagree. `--new-workspace` deletes that directory before any
`configBinds` runs; the resolver then finds it missing and takes its
ordinary first-run path — create, seed from the host — so there is no
separate reset logic. `src/tools/new-workspace.ts` refuses a path not
strictly inside a `~/.local/share/scoder-*` root, and refuses while any
process has the directory in its argv (`-data DIR`, `--user-data-dir
DIR`): scoder shares the host's PID namespace, so a sandboxed IDE is
visible there, and deleting under a live instance would leave it writing
into a half-removed tree.

Every preset has an async function pair:
- `configBinds(realHome, sandboxHome)` — returns bind mounts and directory specs
- `validate()` — checks tool is installed, prints install instructions if missing

One more hook is optional, and only some presets need it:
- `resolveArgs(hostProjectDir, sandboxProjectDir, existingArgs,
  dependencyDirs)` — lets a preset choose the tool's final argv once the
  project directory is known (`configBinds` runs before it exists).
  Always called when present; `existingArgs` is whatever the user already
  passed (`[]` for the `--ide` companion, which has no way to supply its
  own). Each preset decides for itself what to do with them — `rstudio`
  only fills in a default when the user gave none at all; `eclipse`
  always prepends its own fixed flags ahead of whatever the user passed.
  `dependencyDirs` is the sandbox-side destinations of every
  `.sandbox/readonly` `$HOME/...` entry already resolved for this session
  (`ProtectionConfig.dependencyDirs` in `src/git/protection.ts`) — e.g.
  `eclipse` imports each of these as its own project. See
  `ToolPreset.resolveArgs` in `src/types.ts`.

An earlier version of this feature also had a `prepareCommand` hook,
added specifically to run a separate command inside the sandbox before
the tool/IDE exec (`eclipse`'s own dynamic workspace generation, before
its plugin's `-importProject` flags were confirmed to work directly on
the normal interactive launch). Removed once nothing needed it anymore —
see `design/implementation/plans/eclipse-preset.md`'s "Design Decision 4"
for why the separate stage turned out to be unnecessary.

| Tool | Config (ro) | Data/Cache (rw) |
|------|------------|-----------------|
| opencode | ~/.config/opencode | ~/.local/share/opencode, ~/.cache/opencode |
| claude | ~/.claude.json, ~/.config/claude, ~/.local/share/claude | ~/.claude |
| copilot | ~/.config/github-copilot, ~/.copilot | ~/.local/share/github-copilot |
| pi | — | ~/.pi/agent, ~/.local/share/pi, ~/.cache/pi |
| rstudio | — | ~/.config/rstudio, ~/.local/share/rstudio, plus pi's own binds (see below) |
| eclipse | ~/.eclipse/\<hash\> (reused, when found) or a scoder-managed fallback | ~/.local/share/scoder-eclipse-workspaces/\<project\>, plus the reused/fallback config dir above |
| vscode | ~/.vscode/extensions (whole tree, see below); ~/.config/Code/User is read only as a one-time seed source, never bound | ~/.local/share/scoder-vscode-userdata/\<project\> (scoder-managed), plus pi's own binds |

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

RStudio Desktop is a GUI app, so this preset is marked `gui: true` and runs
under an xpra server started inside the sandbox, which forwards its windows
to the host over a unix socket (see `xpra-gui-isolation`). The only display
bind is that socket's directory, `/tmp/scoder-xpra`, read-write. The host's
`/tmp/.X11-unix`, `XAUTHORITY` and `DISPLAY` are **not** bound or passed
through — until 2.6.0 they were, and
[0003-xpra-gui-isolation](/architecture/decision-records/0003-xpra-gui-isolation.md)
records why that changed.

The preset also binds `/dev/dri` (GPU direct
rendering) when it exists on the host, via `--dev-bind` rather than
`--ro-bind` since only `--dev-bind` grants actual device-node access.
**Load-bearing, not optional**, for RStudio specifically: reported
directly, RStudio showed a white window then crashed with `SIGILL`
("Illegal instruction (core dumped)") once `/dev` was narrowed from a
wholesale `--dev-bind /dev /dev` down to a fixed list of real device
nodes that never included it — Chromium's GPU process, unable to open a
DRM render node, hits an internal `CHECK()` failure (compiled to a
hardware trap in release builds) rather than falling back to software
rendering cleanly. It is kept under xpra, and expected to matter *more*
there: the app now renders into a virtual display rather than handing
composition to the host's X server. A DRM render node is also a far
narrower grant than an X socket ever was.

All of this — the xpra socket directory, `XDG_RUNTIME_DIR`, `/dev/dri` —
lives in a shared
`guiDisplayBinds` helper (named `guiX11Binds` until it stopped binding
X11), not a second, separately-maintained copy: `eclipse` is a GUI app
needing the exact same access, by direct analogy (see below).

`XDG_RUNTIME_DIR` is passed through; `DBUS_SESSION_BUS_ADDRESS` is not, and
the host's session bus is unreachable — see
[0004-no-host-dbus](/architecture/decision-records/0004-no-host-dbus.md).
`/dev/dri` has never been independently verified against a real
GPU-backed host, since this project has none. `pi` runs inside RStudio's own embedded
terminal, so this preset also includes pi's own config/data/cache binds —
via a shared `piConfigBinds` helper, not a second, separately-maintained
copy of the same list.

Also passes `XDG_RUNTIME_DIR` through when set on the host. It used to pass
`DBUS_SESSION_BUS_ADDRESS` too — reported: most menu items greyed out except
cut/copy/paste, and only the window manager's own close button quits
RStudio. RStudio Desktop is Electron/Chromium-based, and such apps commonly
need D-Bus for native file dialogs and session/quit integration, degrading
rather than crashing when it's unavailable, which matched the symptom.

That fix worked, and was recorded here as "well-motivated, not verified"
because this project had no real RStudio or desktop D-Bus session to confirm
it against. The unexamined half was which bus: what Electron needs is *a*
session bus, not the user's. Under a GUI preset xpra starts one of its own,
private to the sandbox, and the menus are fine with no host bus reachable at
all — measured, finally, against a real RStudio. The passthrough is gone;
see [0004-no-host-dbus](/architecture/decision-records/0004-no-host-dbus.md).

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
workspace built or last used natively has every project reference pointing
at that project's own absolute path on disk. Path mirroring (see
`path-mirroring`) means a *direct-mode* project already living under
`$HOME` now sits at that same path inside the sandbox too, but a worktree
session still runs from a distinct, sibling location (see
`git-worktree-isolation`) rather than the path a workspace would have
recorded, and a workspace referencing other projects elsewhere on disk
still needs each one imported explicitly.

The full investigation, including why hand-writing `.location` was
rejected and what was verified against a real Eclipse install, is
`design/implementation/plans/eclipse-preset.md`. In short:

- **Requires a plugin the user installs themselves, as a genuine
  prerequisite** —
  [`robchallen/eclipse-import-projects-plugin`](https://github.com/robchallen/eclipse-import-projects-plugin)
  (`>= 2.0.0`), from its own p2 update site, the same way any other
  Eclipse feature is installed. scoder does not vendor, inject, or
  otherwise manage the plugin itself — an earlier version did, and it
  took six rounds of real-world bug-fixing (all in the same small area,
  reverse-engineering Equinox's own internal state well enough to graft
  a plugin onto it without disturbing anything else) before landing on
  "just require it" as the actually-robust answer. See
  eclipse-preset.md's "History" section for the full account.
- `configBinds` locates the host's Eclipse install (resolving `which
  eclipse` through any symlinks): bound read-write if it lives under
  `$HOME` (a personal install the user's own account already owns —
  Eclipse may need to write there, e.g. p2 profile updates), read-only
  otherwise (mostly defensive — a system install under `/opt`/`/usr` is
  already covered by builder.ts's own wholesale binds). Also binds
  `$HOME/.eclipse` whole, read-write, if it exists — Equinox's own
  per-user state, including *configuration-scope* preferences and
  (per-install, hash-named subdirectories under it) its own runtime
  configuration area when the install itself isn't directly writable.
  Bound as a whole directory rather than computing which specific
  subdirectory matters: Eclipse's own default resolution then finds
  whatever it would natively, with **no explicit `-configuration` flag
  needed at all** — the design an earlier, much more involved version
  eventually converged on anyway, after the six bugs above. `configBinds`
  also binds a persisted, project-scoped workspace directory
  (`~/.local/share/scoder-eclipse-workspaces/<project>`, read-write).
- **Instance-scope preferences are seeded once, on first workspace
  creation, by copying `.settings/` directories, not by importing an
  exported `.epf` file.** Configuration scope (bound via `$HOME/.eclipse`
  above) is a small, install-level set — it is *not* where most of what a
  person calls "my Eclipse settings" lives. JDT compiler/formatter
  options, editor behaviour, save actions, and most per-tool preferences
  are *instance scope*, stored per workspace at
  `<workspace>/.metadata/.plugins/<plugin-id>/.settings/*.prefs` — and
  scoder's own persisted workspace is a workspace that has never been
  opened before, so it starts with none of them regardless of what's
  bound from `$HOME/.eclipse`. An earlier version relied on the plugin's
  own `-importPreferences <path>.epf` flag (a project-root
  `.eclipse.epf`, exported via `File > Export > Preferences`) to seed
  this — dropped for two reasons found in practice: it requires a full
  GUI restart to take effect, and a preferences export/import round-trip
  does not populate default values for keys the export never wrote,
  leaving some settings blank even after a successful import. A plain
  `.settings/` directory copy avoids both — it preserves normal Eclipse
  preference resolution (an unset key still falls through to
  `DefaultScope`), needs no restart, and needs no plugin support at all.
  `resolveEclipseLayout` does this only when the scoder-managed workspace
  directory doesn't already exist (never on a later launch, so it can't
  clobber preference edits made inside the sandbox), copying every
  `.metadata/.plugins/*/.settings/` directory wholesale from the user's
  most recently used *real* Eclipse workspace — found via
  `RECENT_WORKSPACES` in `org.eclipse.ui.ide.prefs` (Eclipse's own
  launcher-level record of workspaces it has opened), taking the most
  recent entry, no project-matching or other logic. One necessary guard:
  `$HOME/.eclipse` is bound read-write at its own real path, so Eclipse
  running *inside* a previous scoder session already wrote its own
  workspace to the front of that same `RECENT_WORKSPACES` list — entries
  under scoder's own managed-workspaces root are excluded, or seeding a
  second project would copy from a first project's scoder workspace
  instead of the user's actual one.
- `resolveArgs` always prepends, to the interactive launch, `-data
  <workspace>`, `-importProject <sandboxProjectDir>`, and one more
  `-importProject` per `dependencyDirs` entry (importing the main
  project and every `.sandbox/readonly` `$HOME/...` dependency as its own
  workspace project — solving "a Java project references other local
  projects that also need to be workspace projects" without a manual
  step). All of this on **every** launch, whatever args the user passed —
  intrinsically tied to project identity, not something a user would
  reasonably want to override, and safe to repeat every time since the
  plugin's own code already branches on whether a project is open to
  decide import vs. refresh. No separate pre-launch stage: an earlier
  version ran the plugin's own headless-import application as a distinct
  step first, dropped once the plugin's own README confirmed these same
  flags work directly on the ordinary interactive launch (see
  eclipse-preset.md's Design Decision 4).

Like `rstudio`, this is a GUI app (`gui: true`) getting the same xpra
display and the same `guiDisplayBinds` — but unlike `rstudio`'s, this has
**not** been independently re-verified: this project has no host with GTK
installed and a real X session to confirm the interactive phase against.
Neither IDE has been verified under xpra specifically; the spike and the
end-to-end test use `xclock` and `xdpyinfo`.
Whether `-importProject` behaves on the interactive launch exactly as the
plugin's README describes, and whether the `RECENT_WORKSPACES`/`.settings`
seeding mechanism actually locates and copies the right thing on a real
install, are likewise unverified here — the user intends to test this
directly.

### vscode

Everything specific to this preset follows from one app-level fact,
**verified from `microsoft/vscode` source** (`src/main.ts`
`attemptToAskInstanceToRelaunch`/`openCertificateStore`, and
`src/vs/code/electron-main/app.ts`): VS Code supports exactly **one
running instance per user-data-directory**. The singleton lock (a
`SingletonLock` `hostname`-`pid` symlink) and the IPC socket it hands off
through live *inside* that directory, alongside the live SQLite state
(`state.vscdb`). scoder shares neither the PID nor the UTS namespace, so
a directory shared with the host editor would let the sandboxed instance
see the host's lock as live and connect to it across the bind — windows
opening in the wrong instance, two writers on one database. So the
sandbox always gets its own, via `--user-data-dir`: Microsoft's own flag
help calls this "the intended way to run multiple distinct instances".

The directory is scoder-managed and **persisted**, host-side, one per
project: `~/.local/share/scoder-vscode-userdata/<projDir>`, bound
read-write at its mirrored path — eclipse's managed-workspace shape
(above) reused for the opposite reason: eclipse's dir protects the user's
real workspace from a destructive flag; this one exists because sharing
is structurally broken. Seeded **once on first creation**, copy not
symlink (a symlink would make sandbox settings edits reach the host's
real file), and never re-seeded afterwards: settings edits made inside
the sandbox survive later sessions and later host changes, and nothing
is ever copied back. Copied from `~/.config/Code/User`: `settings.json`,
`keybindings.json`, `snippets/`. Deliberately *not* copied:
`globalStorage`/`state.vscdb` and `workspaceStorage` (machine-scoped live
state — and mid-write whenever the host editor runs), `argv.json` (a
sandboxed session silently inheriting host Electron switches is the
failure mode this preset avoids everywhere else), and anything
secret-bearing.

`~/.continue` (the Continue extension's config, models and API keys,
chat sessions and codebase index — kept outside the user-data-dir) binds
**read-write** when it exists and is never created when it does not:
Continue writes sessions and its index there all session long, so read-only
would break it and tmpfs would show it unconfigured every launch. Its API
keys become readable inside the sandbox, the same exposure scoder's API-key
env passthrough already accepts.

`~/.vscode/extensions` binds whole and **read-only**, existence-gated —
install and update extensions on the host. Accepted cost, to be
revisited on experience: "Install" inside the sandbox fails against the
ro tree rather than silently diverging. `resolveArgs` always prepends
`--user-data-dir <managed>`, `--extensions-dir`, `--disable-updates` (an
auto-updater inside a disposable sandbox has nothing useful to update),
and `--disable-workspace-trust` (the trust dialog's threat model is
"you opened an untrusted folder on your real machine"; inside scoder that
question is already answered, and a fresh user-data-dir would otherwise
open every project in restricted mode), and `--verbose`. That last one is
load-bearing, not a debugging aid: `code` is a CLI launcher that spawns the
Electron app `detached` with `stdio: 'ignore'` and exits immediately
(`src/vs/code/node/cli.ts`), so without it the IDE log stays empty and the
entry point's `$!` names a process already gone. The session then treats
the IDE as finished, skips the ENTER prompt when the primary tool exits,
and the namespace reaper kills the real window. `--verbose` makes the CLI
pipe the app's output through and wait for it to exit; the app stays the
CLI's child, so the children-first shutdown still reaches it. Then the user's own args,
untouched; the project directory is opened only when the user gave no
argument at all (rstudio's fill-if-empty semantics — distinguishing
folder arguments from flag values like `--install-extension <id>` would
be fragile). `validate()` refuses a snap build (`isSnapInstall`, whose
own confinement stacking under bwrap nobody could debug) and requires
xpra like every GUI preset; `command: "code"` covers the key/binary
mismatch.

Sandboxed secrets are **in-memory by design**: no `--password-store`
flag is passed, and VS Code's verified fallback with no Secret Service
reachable is session-lifetime secrets and nothing written to disk — see
[secret-storage](/design/features/secret-storage.md) (option A). The
`ideShutdown` field is deliberately absent: the field records
measurements, and vscode has none; the expected shape (TERM,
process-first — children-first would signal Electron's renderer and GPU
helpers out from under the main process) is recorded as a comment on the
preset until measured.

All of the above is verified from *source*; none of it has yet been run
against a real desktop VS Code from inside scoder. The dry-run tests fix
the command shape; the plan's real-desktop checklist gates the shipping
answers: whether Chromium's own sandbox survives bwrap without
`--no-sandbox` (never added speculatively), what two sessions on the
same project actually do (expected: handoff/exit — a pre-flight
live-lock refusal is the proposed policy if confirmed), the keyring
first-run experience, and the shutdown matrix. Full investigation:
`design/implementation/plans/vscode-preset.md`.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./host-tool-binding.md)
[HAS_FEATURE](./local-bin-resolution.md)
