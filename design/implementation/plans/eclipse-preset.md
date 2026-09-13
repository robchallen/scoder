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
| A vendored file can be injected into an arbitrary nested path inside an otherwise fully **read-only**-mounted directory tree via bwrap, without needing the real install to already contain it or be writable at all | **Yes** — confirmed directly: `--ro-bind <real Eclipse install> /opt/fake` then a second, more specific `--ro-bind <vendored jar> /opt/fake/plugins/<jar>` — the injected file appeared correctly, all 230 pre-existing files in the same directory were still visible and untouched, and the tree remained genuinely read-only (`touch` inside it failed with `Read-only file system`). |
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

## Design

1. **Vendor the plugin jar in scoder's own repo**, pinned by its exact
   sha256 (`133c61b284c61b889836560c06619e1ff3619080b733537f4137d1accb28ab2d`
   for the verified `com.seeq.eclipse.importprojects_1.4.0.jar`), rather
   than requiring the user's own Eclipse install to already have it — the
   user's own idea ("require the eclipse installation has specific
   plugins") is improved on here: nothing about the user's install needs
   to change at all. The `eclipse` preset's `configBinds` adds one more
   `ro-bind`, injecting the vendored jar into `<eclipse-install>/plugins/`
   — confirmed this works against an install the sandbox otherwise only
   ever sees read-only.
2. **A second, separate writable location for Eclipse's own runtime
   state** (the `-configuration` area, plus the p2 agent area, which
   needs nothing special since it already defaults to `$HOME`/`/home/scoder`,
   itself always writable) — not the same thing as the plugin's own install
   directory. Rather than always inventing a scoder-specific location,
   **prefer discovering and reusing whatever `~/.eclipse/<app>_<version>_<hash>/`
   directory the user's own real, native Eclipse usage has already created
   on the host** (see "The `~/.eclipse/<hash>` fallback" in Verified
   Groundwork): since that hash is computed purely from the install
   directory's own path, and scoder already mounts `/opt`-style install
   paths unchanged between host and sandbox, the same directory name
   applies in both places. If found, bind-mount it into the sandbox at the
   identical mirrored path and pass no `-configuration` at all, letting
   Eclipse's own default resolution find it — this means no divergence
   between the user's sandboxed and native Eclipse configuration. Only
   when no such host directory exists (first-ever run, or an install the
   user's account can already write to directly) does scoder fall back to
   an explicit, scoder-managed `-configuration <dir>`.
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
would need a third stage: run the prepare command to completion first
(checking its exit code — a failed workspace prep should be a clear,
loud failure, not a silently broken IDE launch), *then* proceed with
whatever combination of foreground tool / background `--ide` companion
was already going to run. This is a real, if fairly small, extension to
`src/sandbox/builder.ts`'s wrapper-generation code, not something that
fits inside the existing `wrapWithIdeBackground` shape unchanged.

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
scoder-specific location, the prepare step first checks whether
`~/.eclipse/<app>_<version>_<hash>/` already exists on the host (built up
from the user's own prior native usage). If it does, scoder bind-mounts
that exact directory into the sandbox at the mirrored path and passes no
`-configuration` flag at all — Eclipse's own default resolution finds it
natively, and the sandboxed and native configurations are the *same*
directory, not merely similarly-shaped ones. Only when no such directory
exists yet (first-ever run anywhere, or an install the user's account
can write to directly, so no fallback was ever needed) does scoder
create and pass an explicit, scoder-managed `-configuration <dir>` —
confirmed directly to correctly redirect every file that would otherwise
be written into the install's own `configuration/` directory, for that
fallback case.

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
commit to this plan doc for the exact final shape. In brief:
- `configBinds`: X11/XAUTHORITY/XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS
  binds and env, by direct analogy with `rstudio`'s own (Decision 3);
  `ensureDir`+bind the persisted workspace directory; locate the host's
  Eclipse installation (needed regardless, to resolve where `plugins/`
  is) and inject the vendored plugin jar there, read-only. Also compute
  the expected `~/.eclipse/<app>_<version>_<hash>/` directory (Decision
  5) and check whether one already exists on the host: if so, bind it
  into the sandbox at the identical mirrored path, read-write, and
  record "no `-configuration` flag needed"; if not, `ensureDir`+bind a
  scoder-managed fallback directory (keyed by the hash alone) and record
  its path for use as an explicit `-configuration <dir>`. **Deviation
  from the sketch above**: rather than reconstructing the full
  `<app>_<version>_<hash>` name from the install's `.eclipseproduct`
  marker, the implementation matches on the hash suffix alone (any
  `~/.eclipse/*_<hash>` entry) — the hash is the only part actually
  load-bearing for correctness (it's what ties the directory to this
  specific install path); getting an app id or version string wrong
  would otherwise risk missing a real, existing directory for no good
  reason. `.eclipseproduct` is never read.
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
  — not in the original sketch, added since the jar is injected into a
  real install's own trusted `plugins/` dir and is worth not just
  trusting blindly at a fixed repo path.

### Vendored asset

`com.seeq.eclipse.importprojects_1.4.0.jar` (MIT licensed, 8283 bytes),
checked into the scoder repo alongside its sha256, with a short note on
provenance and the exact verification performed (this document).

## Open Questions, Not Resolved Here

- **Locating the Eclipse installation's own directory** (needed to know
  where to inject the vendored jar, since Eclipse's `plugins/` sits
  alongside the executable, not somewhere independently discoverable).
  Real-world feedback confirms at least one real shape directly: a
  root-installed `/opt/eclipse` with `plugins/` as a plain sibling of the
  `eclipse` binary, exactly matching this investigation's own tarball
  extraction — so `which eclipse`, followed to its real target through
  any symlinks, with `plugins/` resolved as its sibling, should work for
  that shape. Not tested here against a distro-packaged (`apt`/`.deb`)
  install, which historically sometimes uses an indirect launcher script
  rather than a direct symlink to the real binary — worth confirming
  before relying on "sibling of the resolved binary" as a universal rule.
  Separately: the *per-user fallback directory* concern this same feedback
  originally raised is resolved, not just open — see Decision 5.
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
