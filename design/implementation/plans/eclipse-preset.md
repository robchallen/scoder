---
target-version: 2.6.0
status: ready
tags: [plan, ide, eclipse, sandbox]
---

# Eclipse Preset: Dynamic Workspace Generation

## Goal

Let `scoder eclipse` and `scoder <agent> --ide eclipse` work, following the
same pattern established for `rstudio`. The problem the `rstudio` preset
didn't have to solve: Eclipse's workspace is not "point the IDE at a
directory" — it's a persistent metadata store that records, per project, an
**absolute path back to that project's real location on disk**, in a
binary, versioned, checksummed file format. Every path scoder mirrors into
the sandbox is either remapped (`$HOME` → `/home/scoder`) or, in worktree
mode, literally a different absolute path than where the user's own
checkout lives. A workspace created or last used outside the sandbox would
have every project reference pointing at a path that doesn't exist inside
it.

The user's own instinct — generate the workspace dynamically, at launch,
rather than reuse a persistent one — is confirmed correct by everything
below, not just a reasonable guess.

## The Core Problem, Confirmed From Eclipse's Own Source

Read the actual implementation, not documentation about it:
[`LocalMetaArea.java`](https://github.com/eclipse-platform/eclipse.platform/blob/master/resources/bundles/org.eclipse.core.resources/src/org/eclipse/core/internal/resources/LocalMetaArea.java),
the class that reads and writes each project's `.location` file under
`.metadata/.plugins/org.eclipse.core.resources/.projects/<name>/`. It's
written via `DataOutputStream`/read via `DataInputStream`, wrapped in
Eclipse's own `SafeChunkyInputStream`/`SafeChunkyOutputStream` framing
(checksummed, crash-safe, versioned — the source comment documents format
changes as recent as "since 3.23"). Confirmed directly against a real file
produced by a real Eclipse (see Verified Groundwork): a short binary
header, a length-prefixed UTF string holding `URI//file:<path>`, then
padding and a trailer.

This rules out hand-writing `.location` ourselves as a robust option —
it's not a portable format, and it's changed shape across versions. The
only sound way to update it is to have Eclipse's own code do it.

## Options Considered

**A. Reuse the user's real, persistent workspace as-is.** Rejected
outright — every project reference in it points at a real host path, and
scoder never binds the project at that path (worktree mode uses
`/tmp/scoder/<projDir>` on the host and `/home/scoder/<projDir>` in the
sandbox; direct mode binds `cwd` at `/home/scoder/<projDir>`, never at the
real host path either). Every reference would be stale on the very first
launch, regardless of mode.

**B. Hand-construct `.location` (and the rest of workspace metadata)
ourselves.** Rejected — see above. Binary, checksummed, versioned; a
hand-written implementation would need per-Eclipse-version handling and
would break silently on the next format revision.

**C. Generate a fresh (or freshly-refreshed) workspace at every launch,
using Eclipse's own project-import mechanism, pointed at the sandbox-side
project path.** This is the recommended direction — see Design below.

**D. Oomph.** Eclipse's own, actively-maintained provisioning framework.
Rejected for this specific need: Oomph's whole design centers on
*cloning* projects from a project-set file as part of provisioning a
fresh install — heavier machinery than needed here, since scoder already
has the project on disk and mounted; there's nothing to clone.

## Verified Groundwork

Nothing below is asserted from documentation alone — a real, current
(February 2026) Eclipse Platform Runtime Binary (4.39) was downloaded and
actually run:

| Claim | Result |
|---|---|
| `.location` is a binary, `DataOutputStream`-written, checksummed format (from reading Eclipse's actual source) | **Yes** — confirmed by inspecting a real produced file: binary header, length-prefixed `URI//file:<path>` string, padding, trailer — matches the source exactly. |
| A real, currently-maintained, MIT-licensed plugin exists that can import a project into a workspace from the command line ([seeq12/eclipse-import-projects-plugin](https://github.com/seeq12/eclipse-import-projects-plugin)) | **Yes** — confirmed: downloaded its pre-built `1.4.0` jar directly from the repo, dropped it into the Eclipse install's `plugins/` directory. |
| The plugin has a genuine **headless** mode (`-application com.seeq.eclipse.importprojects.headlessimport`) that needs no display | **Yes** — ran it with no `DISPLAY`, no X server, no GTK libraries present on this host at all (confirmed separately: plain interactive Eclipse crashes immediately in this same environment with `libgtk-3.so.0: cannot open shared object file`) — the headless application never touches SWT/GTK and completed cleanly. |
| The plugin's compiled `1.4.0.jar` actually works against this modern (4.39, Feb 2026) Eclipse, not just the 2012–2015 releases its own README claims testing against | **Yes** — the bundle loaded and reported `ACTIVE` in the OSGi console, and the import genuinely ran (see next row). Its own README's compatibility claim was outdated but the artifact still works. |
| A real project is genuinely imported and persisted, not just processed in-memory | **Yes** — ran the headless import against a fresh workspace with the `-import <dir>` flag: log showed `Searching for projects in ...` then `Importing project fake-project ...`; the workspace's `.metadata/.plugins/org.eclipse.core.resources/.projects/fake-project/.location` file was created, containing exactly the expected binary/URI content. A **second, separate process invocation** against the same workspace directory correctly reported `Refreshing project fake-project` (not `Importing`) and self-recovered from an "unsaved changes" warning left by the first run — confirming genuine, correct persistence across independent launches, not an in-memory artifact of one process. |
| A vendored file can be injected into an arbitrary nested path inside an otherwise fully **read-only**-mounted directory tree via bwrap, without needing the real install to already contain it or be writable at all | **No — this specific claim was wrong, corrected after real-world use.** The original test bound a new *source* onto an already-*existing* destination file (the jar had already been copied into that fixture's `plugins/` by earlier manual testing) — a genuinely different, easier case than *creating* a brand-new destination node. Against a real, never-touched install, this fails exactly as reported: `bwrap: Can't create file at <install>/plugins/<jar>: Read-only file system`. bwrap needs to create the destination node before the bind can land there, and by the time a preset's own binds run, `builder.ts`'s wholesale `/opt` (or `/usr`, etc.) bind has already made that parent directory read-only — pushing a more specific bind *later in the same array* doesn't undo that. See "The plugin-injection bug, and the real fix" below for what replaced this. |
| The plugin's own doc examples are internally inconsistent about the exact flag name (`-import` vs `-importProject`) | **Real risk, confirmed the hard way** — the repo's current README says the flag was renamed to `-importProject` in `2.0.0`, and its own "Headless" section example still uses the old `-import`. The actual compiled `1.4.0.jar` (extracted and inspected directly with `javap`) uses `-import` — the `master` branch source (`-importProject`, plus a `-importPreferences` feature) is *ahead of* the released jar, not what it contains. Using the README's newer syntax against the actual shipped jar silently does nothing (no error, no log entry, exit code 0) — this is exactly what happened on the first attempt, and it does not fail loudly. |
| An explicit `-configuration <dir>` flag redirects Equinox's own writable state (OSGi bundle cache, `org.eclipse.core.runtime`, `org.eclipse.equinox.app`, `config.ini`) away from a read-only install, without relying on Eclipse's own automatic per-user fallback area | **Yes** — confirmed directly: ran the prepare step against an install bound genuinely read-only (`--ro-bind`, not just a permissions test), with `-configuration <writable-dir>` pointing elsewhere; every file that had previously been written into the install's own (writable, in that earlier test) `configuration/` directory was instead written to the specified directory, correctly, with the install tree remaining untouched. |
| A single `-import <dir>` recursively finds **every** `.project` file under that directory, however deeply nested, and multiple separate `-import` flags in one invocation each import independently | **Yes** — confirmed directly: three separately-mounted directories (a main project, a flat dependency, and a dependency with its `.project` three levels deep) were all imported correctly in one headless-import run, each logged individually (`Searching for projects in ...` / `Importing project ...`), and all three ended up registered in the workspace. |

### The `~/.eclipse/<hash>` fallback, read from Eclipse's actual source

Real-world feedback asked specifically whether the default configuration
location is `<install-dir>` or `~/.eclipse` — read Equinox's own current
implementation
([`EquinoxLocations.java`](https://github.com/eclipse-equinox/equinox/blob/master/bundles/org.eclipse.osgi/container/src/org/eclipse/osgi/internal/location/EquinoxLocations.java),
`computeDefaultConfigurationLocation()`/`computeDefaultUserAreaLocation()`/`getInstallDirHash()`),
not just documentation about it. The answer is exactly what was
suspected, and more precisely specified than a guess would be:

1. **Try `<install-dir>/configuration` first.** Genuinely tested for
   writability, not assumed: `StorageUtil.canWrite()` calls
   `Files.isWritable()` and, if that's inconclusive, actually attempts to
   create and delete a temp file there. Confirmed directly, in isolation
   with a small standalone Java program under a real bwrap `--ro-bind`:
   both checks correctly detect a genuinely read-only mount (`false`, then
   `IOException: Read-only file system`) — the check itself is sound.
2. **If that fails, fall back to `<user.home>/.eclipse/<app-id>_<app-version>_<hash>/configuration`**,
   where `<hash>` is `installDir.getCanonicalPath().hashCode()` (falling
   back to `getAbsolutePath().hashCode()` only if the canonical path can't
   be resolved) — **a hash of the install directory's own path string**,
   nothing host- or sandbox-specific.

One thing this investigation could not fully explain: rerunning the exact
headless-import scenario against an install made genuinely read-only via
`--ro-bind` never actually produced a `~/.eclipse/...` directory, despite
independently confirming the underlying writability check behaves
correctly in isolation. Plausibly the headless-import application (unlike
the full interactive workbench) never reaches whatever code path first
needs the configuration area badly enough to trigger the fallback — not
conclusively isolated, and not clearly relevant besides.

**What is clearly relevant: since the hash is computed purely from the
install directory's own path, and scoder already mounts `/opt` (and
other non-`$HOME` system paths) at the identical real absolute path
both inside and outside the sandbox** — confirmed directly against the
current code, `src/sandbox/builder.ts`: `--ro-bind /opt /opt`, not
remapped the way `$HOME` is — **Eclipse running inside the sandbox would
compute the exact same hash, and so look for the exact same directory
name, as it does on the real host.** This means scoder doesn't need to
invent its own configuration location at all: it can instead look for
whatever `~/.eclipse/<app>_<version>_<hash>/` directory the user's own,
real, already-accumulated Eclipse usage has already created on the host,
and bind that same directory into the sandbox at the mirrored path —
letting Eclipse's own default resolution find and reuse it natively, with
no scoder-specific location and no divergence from the user's real
configuration. See the revised Decision 5 below — the design changed as
a direct result of this.

If no such host directory exists yet (a first-ever run, or an install the
user's own account can actually write to directly, so it never needed a
fallback), there's nothing to reuse, and scoder does need to create
somewhere writable and persist it — but that's now the fallback case, not
the default design.

### The plugin-injection bug, and the real fix

Real-world use of the implemented preset hit exactly what the corrected
row above now says it should: `bwrap: Can't create file at
/opt/eclipse/plugins/com.seeq.eclipse.importprojects_1.4.0.jar: Read-only
file system`. The fix is not a bwrap ordering trick — it's to stop trying
to put the jar under the install's own `plugins/` directory at all.

Modern Eclipse installs (this one included) don't load their bundle set
from a long `osgi.bundles=` list in `config.ini` the way older ones did —
`config.ini` lists just the OSGi framework itself plus
`org.eclipse.equinox.simpleconfigurator`, which then reads the *real*
bundle list from `bundles.info`
(`<configuration-area>/org.eclipse.equinox.simpleconfigurator/bundles.info`),
one line per bundle: `<symbolic-name>,<version>,<location>,<start-level>,<auto-start>`.
Confirmed directly, headlessly (no GTK needed for any of this):

- `<location>` accepts an **absolute `file:` URL**, not just a path
  relative to the install — so the vendored jar can live anywhere
  reachable inside the sandbox, not just under the read-only install.
- `bundles.info` lives inside the **writable** `-configuration` area —
  either the reused host directory or the scoder-managed fallback, both
  already bound read-write — so editing it is plain host-side file I/O,
  no bwrap trick needed at all.
- Handing Equinox a `bundles.info` containing *only* the new plugin's own
  line does **not** work — confirmed directly: it fails with
  `Unresolved requirement: Require-Bundle: org.eclipse.ui`, because the
  rest of the normal bundle set (which a `-configuration` dir with no
  `bundles.info` of its own would otherwise transparently inherit from
  the install's own "shared configuration area", an Equinox mechanism
  this investigation also confirmed exists) is not merged in once an
  instance-level `bundles.info` is present — it's replaced outright. So
  the fix reads whichever base list is available (the reused host
  directory's own `bundles.info` if it has one, else the install's own
  default one, shipped at
  `<install>/configuration/org.eclipse.equinox.simpleconfigurator/bundles.info`),
  and writes that full list back out with the plugin's own line appended
  (or replaced, if already present — idempotent across launches, same as
  everything else here).
- Confirmed end to end, headlessly: with the jar bound at a fixed,
  always-creatable sandbox path (`/home/scoder/.local/share/scoder-
  eclipse-plugin/`, never under any read-only system bind) and referenced
  from `bundles.info` by that path, the headless-import application
  starts and imports correctly — no install-tree mutation attempted at
  all.
- **When reusing the user's own real `~/.eclipse/<hash>` directory**, this
  writes a sandbox-only path into their real, native `bundles.info`.
  Confirmed directly this is benign: a `bundles.info` entry whose
  location doesn't resolve is silently skipped by Equinox — no error, no
  effect on any other bundle — and would only matter if they ran this
  exact plugin's own headless-import application natively themselves,
  which isn't a real workflow. Left in place rather than cleaned up
  afterward (no reliable "scoder is done with this install" signal to
  clean up on), and self-healing anyway: every future scoder launch
  rewrites the same entry idempotently.

### The second bug: skipping Equinox's own *first* choice

Real-world use again surfaced a real gap, this time not a broken
mechanism but a wrong implementation of an already-correct design: the
sandboxed Eclipse launched into what looked like a totally fresh,
unconfigured state — no real preferences, no previously-installed
plugins, nothing familiar — on a machine where the user's own account
already owns `/opt/eclipse` outright and their native Eclipse writes
straight into `<install>/configuration` itself, never needing the
`~/.eclipse/<hash>` fallback at all. The code, though, only ever checked
`~/.eclipse/<hash>` (finding nothing, since none was ever created) and
fell straight through to the scoder-managed fallback — silently using an
empty, brand-new directory instead of the user's real one, even though
Decision 5's own written design (and the Equinox source it's based on)
says to check `<install>/configuration` itself *first*, before ever
considering `~/.eclipse/<hash>`. The implementation simply never wrote
that first check.

Fixed by adding it: `resolveEclipseLayout` now checks whether
`<install>/configuration` both exists and is writable by the current
user (`isWritableDir`, a plain `access(W_OK)` against the real host
filesystem) *before* looking at `~/.eclipse/<hash>` at all. If so, that
directory is bound onto itself with a plain `--bind` (read-write),
overriding the wholesale/defensive install-dir `--ro-bind` that already
covers it — confirmed directly this composes correctly: binding an
*already-existing* directory read-write over an already-read-only parent
works (unlike creating a new file there, the plugin-injection bug above),
and the override correctly carries the *real* directory's own existing
content, not an empty one. No `-configuration` flag is passed in this
case either, exactly as for the `~/.eclipse/<hash>` case — both are now
just the two forms "a real, already-existing host directory is being
reused directly," covered by the same `reuseHostConfig` flag.

**A smaller, defensive fix alongside it**: the hash match against
`~/.eclipse/` entries now also tries the raw (possibly negative) hash
string, not just its absolute value — a hedge against the "Equinox forces
this non-negative" detail in this doc's own source citation being
slightly off, rather than silently missing a real directory over a sign
mismatch. Not confirmed either way to have been the actual cause of
anything (the missing first-choice check above was reproduced and fixed
independently of this), but cheap enough to add defensively while in this
code anyway.

### The third bug: the directory name isn't just `<app>_<version>_<hash>`

Immediately after the second bug's fix, real-world use surfaced a third
one in the same area: the user's real `~/.eclipse/` directory is named
`org.eclipse.platform_4.39.0_1473617060_linux_gtk_x86_64` — the hash is
followed by *more* underscore-separated segments (`linux`, `gtk`,
`x86_64` — OS/WS/ARCH, not part of this doc's original,
under-specified `<app>_<version>_<hash>` sketch). The match was written
as `name.endsWith(`_${hash}`)`, which only matches when the hash is the
*last* segment — never true here, so it fell through to the
scoder-managed fallback exactly the same way the second bug did, just
via a different, narrower mismatch this time.

Fixed by matching the hash as its own segment *anywhere* in the name,
not only at the end: split the entry name on `_` and check whether the
hash string is one of the resulting segments (`segments.includes(hash)`),
rather than testing the whole name for a trailing substring. Confirmed
directly against the user's own real directory name shape, with a fake
install reproducing the exact hash: correctly matched and bound, with
the existing (fake) custom-installed plugin's own `bundles.info` entry
still preserved alongside the newly-appended one.

Three bugs, all in the same area, is worth naming honestly rather than
looking past: none of them were found by this investigation's own
headless testing (which never had a `~/.eclipse/<hash>` directory, real
or fake, with a *genuine* platform-suffixed name to test against) — all
three were caught by the very first real-world use against a real
install. The lesson carried forward, not just noted here: this specific
mechanism (matching an existing, externally-named directory on the host)
is exactly the kind of thing worth testing against the messiest real
example available, not the cleanest one this investigation happened to
construct.

## Design

1. **Vendor the plugin jar in scoder's own repo**, pinned by its exact
   sha256 (`133c61b284c61b889836560c06619e1ff3619080b733537f4137d1accb28ab2d`
   for the verified `com.seeq.eclipse.importprojects_1.4.0.jar`), rather
   than requiring the user's own Eclipse install to already have it — the
   user's own idea ("require the eclipse installation has specific
   plugins") is improved on here: nothing about the user's install needs
   to change at all. The `eclipse` preset's `configBinds` binds it
   read-only at a fixed, always-creatable sandbox path
   (`/home/scoder/.local/share/scoder-eclipse-plugin/`, never under any
   read-only system bind) and registers it with Equinox by editing
   `bundles.info` inside the writable `-configuration` area — **not** by
   injecting it into `<eclipse-install>/plugins/`, which real-world use
   proved cannot work (see "The plugin-injection bug, and the real fix"
   above).
2. **A second, separate writable location for Eclipse's own runtime
   state** (the `-configuration` area, plus the p2 agent area, which
   needs nothing special since it already defaults to `$HOME`/`/home/scoder`,
   itself always writable) — not the same thing as the plugin's own install
   directory. Rather than always inventing a scoder-specific location,
   **prefer reusing whichever real, already-existing host directory
   Equinox's own default resolution would use, in the same order it
   checks them** (see Decision 5): first `<install-dir>/configuration`
   itself, if the current user can already write to it directly (the
   common case on a personal machine); else whatever
   `~/.eclipse/<app>_<version>_<hash>/` directory the user's own real,
   native Eclipse usage has already created on the host (see "The
   `~/.eclipse/<hash>` fallback" in Verified Groundwork) — since that hash
   is computed purely from the install directory's own path, and scoder
   already mounts `/opt`-style install paths unchanged between host and
   sandbox, the same directory name applies in both places. Either way,
   bind-mount it into the sandbox at the identical mirrored path and pass
   no `-configuration` at all, letting Eclipse's own default resolution
   find it — this means no divergence between the user's sandboxed and
   native Eclipse configuration. Only when neither real directory exists
   (first-ever run anywhere, and the install directory itself isn't
   writable) does scoder fall back to an explicit, scoder-managed
   `-configuration <dir>`.
3. **A persistent, project-scoped workspace directory**, the same shape
   as `rstudio`'s own `~/.config/rstudio`/`~/.local/share/rstudio`:
   `~/.local/share/scoder-eclipse-workspaces/<projDir>` on the host,
   `ensureDir`'d and bound read-write, so editor state (breakpoints, open
   editors, per-project settings) persists across sessions the way a
   normal IDE's does — not a throwaway workspace rebuilt from nothing
   every launch. This is chosen for editor-state continuity specifically
   — it is **not** what makes dependency-project import work (see point 4
   below); that part works identically whether the workspace persists or
   not, since the prepare step re-imports everything on every launch
   regardless.
4. **A new, unconditional pre-launch step**, run *inside* the sandbox
   before the interactive Eclipse process starts: the vendored plugin's
   headless-import application, pointed at that persisted workspace, with
   one `-import <path>` for the **sandbox-side** project path
   (`sandboxProjDir`) *and one more for every `.agentreadonly`
   `$HOME/...` entry already resolved for this session* — solving the
   "Java projects reference a lot of local dependency projects, each of
   which also needs to be an imported project" problem directly:
   confirmed a single invocation with multiple `-import` flags correctly
   imports a main project and multiple separately-mounted dependencies —
   including one with its `.project` several directories deep — in one
   shot, with no per-dependency manual step and no dependency on whether
   the workspace itself is persisted. This must run inside the sandbox,
   not on the host: the `.location` file records whatever path the
   process writing it can see, and only the sandbox-side paths are what
   the *interactive* Eclipse — which also runs inside the sandbox — will
   actually need to resolve later. Running the prepare step on the host
   would stamp paths that don't exist anywhere the interactive process
   can see them.
5. **Idempotent by construction, not by scoder's own logic** — the
   plugin's own code already branches on `project.isOpen()` to decide
   `import` vs `refresh`, confirmed directly (case 5 in Verified
   Groundwork): rerunning the exact same prepare step — main project,
   every dependency, all of it — against the same persisted workspace is
   safe and correct on every single launch, with no special-casing needed
   for "first run vs. subsequent runs," and no harm done by passing a
   `.agentreadonly` entry that isn't actually an Eclipse project at all
   (the plugin's own recursive search just finds nothing under it and
   logs no import for that path).
6. **The interactive Eclipse launch, afterward, is pointed at that same
   workspace** via `-data <persisted-workspace>` — always supplied by the
   preset itself (not merely a default-when-no-args-given the way
   `rstudio`'s `.Rproj` detection works), since the workspace path is
   intrinsically tied to project identity, not something a user would
   reasonably want to override. Whatever configuration-area decision the
   prepare step made (reused host directory, bound at its mirrored path
   with no `-configuration` flag; or an explicit fallback directory with
   `-configuration <dir>`) is repeated identically for the interactive
   launch, so both steps agree on where Equinox's state lives. Any of the
   user's own arguments are appended after it.

## New Preset-System Capability Needed

`rstudio` needed `configBinds` (binds/dirs/env) and `resolveArgs`
(argv-once-`sandboxProjDir`-is-known). Neither covers "run a separate,
complete command inside the sandbox first, and only then exec the real
target." This plan needs a third, new hook:

```typescript
// Runs inside the sandbox, before the tool/IDE exec. Failure here should
// not silently continue into a broken interactive session -- surfaced
// specifically, not folded into resolveArgs' or configBinds' own shape.
// dependencyDirs: the sandbox-side destinations of every .agentreadonly
// $HOME/... entry already resolved for this session -- see the plumbing
// note below, this isn't available as its own distinct list today.
prepareCommand?: (
	hostProjectDir: string,
	sandboxProjectDir: string,
	dependencyDirs: string[],
) => Promise<{ bin: string; args: string[] } | null>;
```

`buildBwrapCommand`'s wrapper (the same family as `wrapWithIdeBackground`)
needed a third stage: run the prepare command(s) to completion first
(checking each one's exit code — a failed workspace prep should be a
clear, loud failure, not a silently broken IDE launch), *then* proceed
with whatever combination of foreground tool / background `--ide`
companion was already going to run. **Implemented as a list, not a single
optional step**: eclipse's real use case is as the `--ide` companion (`pi
--ide eclipse`), so both the primary preset's own `prepareCommand` and
the `--ide` companion's own are collected (in that order) and run in
sequence by `wrapWithPrepareStep` — a whole-launch failure on the first
one that exits non-zero, later steps never run. This is a real, if fairly
small, extension to `src/sandbox/builder.ts`'s wrapper-generation code,
not something that fits inside the existing `wrapWithIdeBackground` shape
unchanged.

**A second, smaller plumbing gap**: `dependencyDirs` above isn't actually
available as its own list anywhere today. `.agentreadonly`'s `$HOME/...`
entries become ordinary `BindMount`s mixed into
`protectionConfig.safeBinds` alongside many unrelated things (the
agents/`.local/bin` snapshots, `resolv.conf`, ssh access, `.agentports`,
`scratch`, identity binds, the `AGENTS.md` overlay itself) — there's no
existing, distinct "here are just the `.agentreadonly` `$HOME` bind
destinations" list a preset could read. `.agentreadonly` parsing
(`src/git/protection.ts`) would need to also expose that subset
distinctly, rather than have `eclipse`'s `prepareCommand` try to infer
which `safeBinds` entries are dependency-project-shaped by guessing from
their shape.

## Design Decisions

### 1. Persisted workspace, not a fresh one every session — and this is independent of the dependency-import problem

Rejected recreating the workspace from nothing on every launch: Eclipse
workspaces hold real, useful per-project state (breakpoints, open editor
layout, run configurations) a user would reasonably expect to survive
between sessions, the same expectation `rstudio`'s own config/data binds
already honor. The headless-import step being safely idempotent (Verified
Groundwork) is what makes "persist it, and just re-run prepare every
launch to keep it honest" both correct and cheap.

Worth being explicit about, since it wasn't obvious going in: this
decision is **not** what makes dependency projects resolve correctly.
That's solved by Design point 4 (every `.agentreadonly` entry gets its own
`-import`, every single launch) regardless of whether the workspace
itself persists — an ephemeral, from-scratch-every-time workspace would
import the main project and every dependency exactly the same way, just
without carrying editor state between sessions. Persistence and
dependency-import were, at first glance, easy to conflate into one
"ephemeral vs. persistent" choice; they turned out to be orthogonal once
the plugin's own multi-`-import`, always-idempotent behaviour was
actually tested.

### 2. The vendored jar is pinned, not "whatever's newest"

The plugin's own `master` branch is ahead of its last built artifact in a
way that changes the actual command-line flag — confirmed the hard way
(Verified Groundwork, last row). Scoder should vendor the *exact*,
already-verified-working `1.4.0.jar` (sha256 above), not attempt to build
from source or track `master`. Re-verify explicitly, the same way, before
ever bumping to a newer build.

### 3. GTK/X11 are the same accepted trade-off as RStudio, unverified for Eclipse specifically

Eclipse's UI is SWT/GTK, not Electron/Chromium — the same class of
X11-needing desktop app as `rstudio`, so the same
`/tmp/.X11-unix`/`DISPLAY`/`XAUTHORITY` binds and the same
[0002-rstudio-x11-access](/architecture/decision-records/0002-rstudio-x11-access.md)
trade-off apply by direct analogy. Not independently re-verified for
Eclipse specifically in this investigation: this environment has no GTK
libraries installed at all (confirmed directly — the interactive
application crashes immediately with `libgtk-3.so.0: cannot open shared
object file`), so only the headless (no-display) prepare step could
actually be tested end-to-end here, not the interactive GUI phase itself.
Whether `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` passthrough matters
for Eclipse the way it was hypothesized to for RStudio's Electron shell is
unknown — SWT/GTK's own D-Bus dependence (if any) hasn't been
investigated. A host with GTK installed and a real X session is needed to
close this gap before implementation.

### 4. `-clean` was used in every successful test; whether it's strictly required is unresolved

Every verified test above passed `-clean` to the prepare step. Whether
that's required specifically because a plugin jar was added to an
Eclipse install that direction had already been launched at least once
before (a real OSGi bundle-cache staleness concern) or is unnecessary for
scoder's actual case — a fresh mount namespace, and so a "first launch"
from Eclipse's own perspective, every single time — was not conclusively
isolated. Cheap to just always pass it (a small, one-time startup cost on
the prepare step only) rather than resolve this precisely; worth
revisiting if the prepare step's latency ever matters.

### 5. Reuse the host's own `~/.eclipse/<hash>` directory when it exists; fall back to explicit `-configuration` only when it doesn't

Directly prompted by real-world feedback, and revised once already in
response to it: the user pointed out that always forcing a
scoder-invented `-configuration` directory means their sandboxed Eclipse
configuration permanently diverges from their native one — a real,
stated downside, even though some divergence (workspace, obviously) is
unavoidable. They asked whether the default configuration location is
`<install-dir>` or `~/.eclipse`, prompting a direct read of Equinox's
current source rather than relying on memory or docs (see "The
`~/.eclipse/<hash>` fallback" in Verified Groundwork for the full
citation trail). The answer: both, in that order — `<install-dir>/configuration`
first (genuinely writability-tested), falling back to
`~/.eclipse/<app>_<version>_<hash>/configuration`, where `<hash>` is
computed purely from the install directory's own path string.

That last fact is what resolves the tension: scoder's own `builder.ts`
already binds `/opt`-style install paths at their identical real absolute
location both inside and outside the sandbox, so for a typical
`/opt`-installed Eclipse the hash — and therefore the fallback directory
name — is the same in both contexts. So instead of always forcing a
scoder-specific location, this now mirrors Equinox's *own* two-step
check, in the same order, rather than jumping straight to the second
step (a real gap in an earlier version of this implementation, found and
fixed after real-world use — see "The second bug" below):

1. **Is `<install-dir>/configuration` itself writable by the current
   user?** Common on a personal machine (installed without `sudo`, or
   `chown`'d to themselves) — if so, that's exactly what their own native
   Eclipse already uses, not a fallback at all. scoder binds it onto
   itself, read-write (overriding the wholesale/defensive read-only
   install-dir bind that already covers it), and passes no
   `-configuration` flag — Eclipse's own default resolution finds it,
   identically to a native run.
2. **Else, does `~/.eclipse/<app>_<version>_<hash>/` already exist on the
   host** (built up from the user's own prior native usage, on a machine
   where step 1 doesn't apply — e.g. a shared, `sudo`-installed
   instance)? If so, scoder bind-mounts that exact directory into the
   sandbox at the mirrored path, again with no `-configuration` flag —
   the sandboxed and native configurations are the *same* directory, not
   merely similarly-shaped ones.
3. **Else** (first-ever run anywhere, and the install directory itself
   isn't writable), scoder creates and passes an explicit, scoder-managed
   `-configuration <dir>` — confirmed directly to correctly redirect
   every file that would otherwise be written into the install's own
   `configuration/` directory, for that fallback case.

One thing this could not fully explain: a full Eclipse headless-import
run against a genuinely `--ro-bind`-mounted install did not itself
produce the `~/.eclipse/<hash>` fallback directory, despite a standalone
test independently confirming the writability-check mechanism it relies
on behaves correctly under the same read-only bind. This doesn't block
the design above — scoder proactively computing and checking for the
expected directory name doesn't depend on Eclipse's own runtime fallback
logic actually triggering it — but it's flagged rather than glossed
over.

## Changes Required (sketch — implementation not started)

### `src/types.ts`

`ToolPreset` gains the optional `prepareCommand` hook described above
(with its `dependencyDirs` parameter).

### `src/git/protection.ts`

`.agentreadonly` `$HOME/...` parsing needs to also expose the resolved
sandbox-side destinations as their own distinct list (e.g. on
`ProtectionConfig`), not just as entries mixed into `safeBinds` — the
plumbing gap noted above.

### `src/sandbox/builder.ts`

- New vendored-jar-injection bind in whatever produces the `eclipse`
  preset's own `configBinds` output (see `src/tools/presets.ts` below) —
  no `builder.ts` change needed for this part specifically, it's just
  another `BindMount`.
- A new wrapper, in the same family as `wrapWithIdeBackground`, that runs
  the prepare command to completion (checking its exit status) before
  proceeding to the existing foreground/background tool-launch logic.
  Needs its own positional-argument-passing design, following
  `wrapWithFdShim`/`wrapWithIdeBackground`'s existing convention.

### `src/tools/presets.ts`

**Implemented** — see `src/tools/presets.ts`'s `eclipse` preset,
`resolveEclipseLayout`, and the surrounding helpers, plus the follow-on
commits to this plan doc for the exact final shape (including one real
production bug and its fix — see "The plugin-injection bug, and the real
fix" above). In brief:
- `configBinds`: X11/XAUTHORITY/XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS
  binds and env, by direct analogy with `rstudio`'s own (Decision 3);
  `ensureDir`+bind the persisted workspace directory; locate the host's
  Eclipse installation (needed regardless, to resolve where `plugins/`
  is, and as the base bundle-list source for the fallback config case)
  and bind the vendored plugin jar read-only at a fixed, always-creatable
  sandbox path, then register it with Equinox by editing `bundles.info`
  inside the writable configuration area (`ensureEclipseBundlesInfo`) —
  **not** by injecting it into the install's own `plugins/`, which
  real-world use proved doesn't work. Also resolve the actual
  configuration directory to use, checking in the same order Equinox
  itself would (Decision 5): first, is `<install-dir>/configuration`
  itself writable by the current user (`isWritableDir`) — if so, bind it
  onto itself, read-write, and record "no `-configuration` flag needed";
  else, does the expected `~/.eclipse/<app>_<version>_<hash>/` directory
  already exist on the host — if so, bind *that* in at the identical
  mirrored path, read-write, same "no flag needed" record; else,
  `ensureDir`+bind a scoder-managed fallback directory (keyed by the hash
  alone) and record its path for use as an explicit `-configuration
  <dir>`. **A real bug, found and fixed after real-world use**: an
  earlier version of this implementation skipped the first check
  entirely, going straight to the `~/.eclipse/<hash>` one — silently
  using the (empty) fallback directory instead of a personal-machine
  user's own real, already-populated Eclipse configuration. See "The
  second bug" above. **Deviation from the sketch
  above**: rather than reconstructing the full directory name from the
  install's `.eclipseproduct` marker, the implementation matches on the
  hash alone, as its own underscore-delimited segment anywhere in the
  entry name (not merely a suffix — see "The third bug": a real
  directory name has OS/WS/ARCH segments *after* the hash) — the hash is
  the only part actually load-bearing for correctness (it's what ties
  the directory to this specific install path); getting an app id or
  version string wrong would otherwise risk missing a real, existing
  directory for no good reason. `.eclipseproduct` is never
  read.
- `prepareCommand`: returns the headless-import invocation
  (`<eclipse-bin> -nosplash -clean [-configuration <fallback config
  dir>] -application com.seeq.eclipse.importprojects.headlessimport
  -data <persisted workspace> -import <sandboxProjDir> -import <dep1>
  -import <dep2> ...` — the `-configuration` flag included only in the
  fallback case; one `-import` for `sandboxProjDir`, then one more for
  each entry in `dependencyDirs`).
- The interactive launch's own args always begin with `[-configuration
  <fallback config dir>] -data <persisted workspace>` — same
  conditional-inclusion rule as the prepare step, so both agree — with
  any user-supplied arguments appended after. This needed `resolveArgs`
  to change from "only called when the user gave no args" to "always
  called, existing args passed in" — a real, if small, change to
  `ToolPreset`'s own contract (`src/types.ts`), not something eclipse
  alone could work around; `rstudio`'s own `resolveArgs` was updated to
  preserve its exact prior behaviour under the new contract.
- `validate`: `commandExists("eclipse")`, plus a re-check of the vendored
  jar's sha256 against the pinned value on every run (`verifyEclipseJar`)
  — not in the original sketch, added since the jar ends up referenced
  from `bundles.info` and is worth not just trusting blindly at a fixed
  repo path.
- **`--ide` support**: both the primary preset's own `prepareCommand` and
  the `--ide` companion's own are collected and run, in that order, before
  either actually starts (see the "New Preset-System Capability Needed"
  section above) — `pi --ide eclipse` is eclipse's actual intended use
  case, not merely `scoder eclipse` on its own, so this needed to work
  from the start rather than being deferred.

### Vendored asset

`com.seeq.eclipse.importprojects_1.4.0.jar` (MIT licensed, 8283 bytes),
checked into the scoder repo alongside its sha256, with a short note on
provenance and the exact verification performed (this document).

## Open Questions, Not Resolved Here

- **Locating the Eclipse installation's own directory** (needed to know
  where its `plugins/` and default `bundles.info` are, and as the
  install-hash basis for Decision 5). Real-world feedback confirms at
  least one real shape directly: a root-installed `/opt/eclipse` with
  `plugins/` as a plain sibling of the `eclipse` binary, exactly matching
  this investigation's own tarball extraction — so `which eclipse`,
  followed to its real target through any symlinks, with `plugins/`
  resolved as its sibling, should work for that shape. Not tested here
  against a distro-packaged (`apt`/`.deb`) install, which historically
  sometimes uses an indirect launcher script rather than a direct symlink
  to the real binary — worth confirming before relying on "sibling of the
  resolved binary" as a universal rule. Separately: the *per-user
  fallback directory* concern this same feedback originally raised is
  resolved, not just open — see Decision 5.
- **GTK/D-Bus behavior for the actual interactive GUI phase** (Decision 3)
  — needs a host with GTK installed to close out.
- **`-clean`'s necessity** (Decision 4) — cheap to leave unresolved and
  just always pass it.
- Whether to also expose `-importPreferences <file>.epf` (present in the
  plugin's newer, unreleased source, not in the verified `1.4.0.jar`) as
  a future way to bring in a user's own Eclipse preferences — parked,
  not needed to solve the core workspace problem this plan addresses.

[IMPACTS](/src/types.ts)
[IMPACTS](/src/sandbox/builder.ts)
[IMPACTS](/src/tools/presets.ts)
[HAS_FEATURE](/design/features/tool-presets.md)
[HAS_FEATURE](/design/features/ide-companion.md)
