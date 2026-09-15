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
produced by a real Eclipse: a short binary header, a length-prefixed UTF
string holding `URI//file:<path>`, then padding and a trailer.

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

## The plugin: a prerequisite, not vendored

Eclipse's own project-import mechanism doesn't exist out of the box — it
comes from a real, actively-maintained plugin,
[`robchallen/eclipse-import-projects-plugin`](https://github.com/robchallen/eclipse-import-projects-plugin)
(a fork of the original `seeq12/eclipse-import-projects-plugin`, now
published from its own proper p2 update site). **scoder requires this
plugin to already be installed into the host's Eclipse before scoder is
run** — the same way any other Eclipse feature is installed
(`Help > Install New Software...`, or the p2 director for scripted
provisioning) — and does not vendor, inject, or otherwise manage the
plugin itself.

This is a deliberate simplification, not the original plan: an earlier
version of this preset vendored a pinned jar and went to considerable
lengths to register it with Equinox at every launch, plus ran its import
as a separate headless pre-launch stage before the real interactive
launch. Both of those turned out to be unnecessary complexity — see
"History: the vendored-plugin approach" below for what the first one took
and why it was dropped, and Design point 4 below for why the second one
was too. Requiring the plugin as a prerequisite is both simpler and more
robust: nothing scoder does depends on guessing where Equinox's bundle
list lives or how it's structured.

Confirmed directly, from the plugin's own current README: the relevant
CLI flags are `-importProject <folder>` (recursively finds and
imports/refreshes every `.project` under it; repeatable) and
`-importPreferences <file>.epf` (also repeatable), and **both work
directly on the plugin's own normal interactive launch** — no separate
headless application needed at all (that's a *separate*, optional mode
the plugin also offers, for provisioning use cases that don't want to
start the IDE). `-importProject` replaced the older `-import` in `2.0.0`;
scoder targets `2.0.0+`.

## Verified Groundwork

Nothing below is asserted from documentation alone — a real, current
Eclipse Platform Runtime Binary (4.39) and the plugin's own real jar were
downloaded and actually run, headlessly (no GTK/display needed for any of
this: the headless-import application never touches SWT/GTK, confirmed
directly — the plain interactive workbench crashes immediately in a
GTK-less environment, the headless application does not). The headless
application was what this investigation could actually exercise
end-to-end in this environment (no GTK host available) — the plugin's own
README is the source for the interactive-launch behaviour (Design point 4
below), not independently re-verified here for the same reason.

| Claim | Result |
|---|---|
| `.location` is a binary, `DataOutputStream`-written, checksummed format (from reading Eclipse's actual source) | **Yes** — confirmed by inspecting a real produced file: binary header, length-prefixed `URI//file:<path>` string, padding, trailer — matches the source exactly. |
| The plugin has a genuine **headless** mode that needs no display | **Yes** — ran it with no `DISPLAY`, no X server, no GTK libraries present at all — completed cleanly. |
| A real project is genuinely imported and persisted, not just processed in-memory | **Yes** — the workspace's `.location` file was created with the expected binary/URI content; a **second, separate process invocation** against the same workspace correctly reported refreshing rather than re-importing, confirming genuine persistence across independent launches. |
| A single `-importProject <dir>` recursively finds **every** `.project` file under that directory, however deeply nested, and multiple separate `-importProject` flags in one invocation each import independently | **Yes** — confirmed directly: three separately-mounted directories (a main project, a flat dependency, and a dependency with its `.project` three levels deep) were all imported correctly in one headless-import run. |
| The plugin's own code is idempotent — re-running against an already-imported project refreshes rather than re-imports | **Yes** — confirmed directly across independent process invocations, including self-recovery from an "unsaved changes" warning left by a prior run. |

## Design

1. **The Eclipse installation directory itself**: bound read-write when it
   lives under `$HOME` (a personal install the user's own account already
   owns — Eclipse may need to write there, e.g. updating its own p2
   profile), bound read-only otherwise. The read-only case is mostly
   defensive, not load-bearing in the common case: a system install under
   `/opt` or `/usr` is already covered by `builder.ts`'s own wholesale
   binds, so this is usually just a harmless repeat mount — it only
   matters for an install somewhere those don't already reach.
2. **`$HOME/.eclipse`, bound whole and read-write, if it exists.** This is
   Equinox's own per-user state — instance preferences, and (per-install,
   hash-named subdirectories under it — see "History" below) its own
   runtime configuration area when the install itself isn't directly
   writable. Bound as a whole directory, at its own identically-mapped
   sandbox path, rather than trying to compute which specific
   subdirectory matters or reconstruct Equinox's own resolution logic:
   Eclipse's own default resolution then finds whatever it would
   natively, with **no explicit `-configuration` flag needed at all**.
   Preferences should be picked up automatically this way; not yet
   independently re-verified end-to-end against a real interactive
   Eclipse session (no GTK host available in this investigation).
3. **A persistent, project-scoped workspace directory**, the same shape
   as `rstudio`'s own `~/.config/rstudio`/`~/.local/share/rstudio`:
   `~/.local/share/scoder-eclipse-workspaces/<projDir>` on the host,
   `ensureDir`'d and bound read-write, so editor state (breakpoints, open
   editors, per-project settings) persists across sessions the way a
   normal IDE's does — not a throwaway workspace rebuilt from nothing
   every launch. This is chosen for editor-state continuity specifically
   — it is **not** what makes dependency-project import work (see point 5
   below); that part works identically whether the workspace persists or
   not, since the import args are passed on every launch regardless.
4. **No separate pre-launch stage — `-importProject`/`-importPreferences`
   go straight to the one, normal, interactive Eclipse launch**, via
   `resolveArgs`, not a distinct `prepareCommand` step. An earlier version
   of this preset ran the plugin's own *headless* application as a
   separate stage first, landing you in the IDE only afterward — dropped
   once the plugin's own README confirmed its import flags work directly
   on the interactive launch itself ("will ultimately place you in the
   IDE"), which buys the exact same result with one less JVM startup and
   no extra moving part.
5. **Every `.agentreadonly` `$HOME/...` entry gets its own
   `-importProject`, every launch** — solving "a Java project references
   other local projects that also need to be workspace projects" without
   a manual step. Confirmed (via the plugin's separate headless
   application, the only mode this investigation could exercise
   end-to-end) that a single invocation with multiple `-importProject`
   flags correctly imports a main project and multiple separately-mounted
   dependencies — including one nested several directories deep — in one
   shot, and that re-running against an already-imported project refreshes
   rather than re-imports (idempotent by the plugin's own construction,
   not scoder's).
6. **An optional, project-supplied `.eclipse.epf`** (Eclipse preferences,
   exported natively via `File > Export > Preferences`) at the root of
   the scoder project directory: if present, passed to `-importPreferences`
   at its own, ordinary in-project path — **deliberately not moved to a
   separate, read-only sandbox location.** Read-write is the actually
   -wanted behaviour here, not just an accepted gap: the whole point of
   importing it fresh on every launch is that edits made to it inside the
   sandbox take effect the next session, the same as any other project
   file. (Making it read-only in place would need a bind layered *after*
   the main project bind — the way `.agentreadonly`'s own protected paths
   work — which a preset's `configBinds` has no way to do; moot here
   anyway, since read-write is correct.)
7. **The interactive Eclipse launch is pointed at the persisted
   workspace** via `-data <persisted-workspace>` — always supplied by the
   preset itself (not merely a default-when-no-args-given the way
   `rstudio`'s `.Rproj` detection works), since the workspace path is
   intrinsically tied to project identity, not something a user would
   reasonably want to override. Any of the user's own arguments are
   appended after it.

## Design Decisions

### 1. Persisted workspace, not a fresh one every session — and this is independent of the dependency-import problem

Rejected recreating the workspace from nothing on every launch: Eclipse
workspaces hold real, useful per-project state (breakpoints, open editor
layout, run configurations) a user would reasonably expect to survive
between sessions, the same expectation `rstudio`'s own config/data binds
already honor. The plugin's own idempotent import behaviour (Verified
Groundwork) is what makes "persist it, and just re-import everything on
every launch to keep it honest" both correct and cheap.

Worth being explicit about, since it wasn't obvious going in: this
decision is **not** what makes dependency projects resolve correctly.
That's solved by Design point 5 (every `.agentreadonly` entry gets its own
`-importProject`, every single launch) regardless of whether the workspace
itself persists — an ephemeral, from-scratch-every-time workspace would
import the main project and every dependency exactly the same way, just
without carrying editor state between sessions.

### 2. GTK/X11 are the same accepted trade-off as RStudio, unverified for Eclipse specifically

Eclipse's UI is SWT/GTK, not Electron/Chromium — the same class of
X11-needing desktop app as `rstudio`, so the same
`/tmp/.X11-unix`/`DISPLAY`/`XAUTHORITY` binds and the same
[0002-rstudio-x11-access](/architecture/decision-records/0002-rstudio-x11-access.md)
trade-off apply by direct analogy. Not independently re-verified for
Eclipse specifically in this investigation: this project has no host with
GTK installed and a real X session to confirm it against, so only the
plugin's headless mode could actually be tested end-to-end here, not the
interactive GUI phase itself, including whether `-importProject` on the
interactive launch behaves exactly as its README describes. A host with
GTK installed and a real X session is needed to close this gap.

### 3. No explicit `-configuration` flag — `$HOME/.eclipse` is bound whole instead

An earlier version of this preset spent five separate rounds of real-world
bug-fixing trying to precisely reconstruct Equinox's own default
`-configuration` resolution algorithm (`<install-dir>/configuration`
first, falling back to a specific hash-named directory under
`~/.eclipse/`) well enough to reliably reuse the user's real, existing
configuration state. Every one of those bugs traced back to the same
root cause: trying to be *more precise* than necessary about exactly
which real, external directory or file mattered. The design settled on
here sidesteps that whole class of bug: bind `$HOME/.eclipse` as a single
whole directory (Design point 2) and pass no `-configuration` flag at
all, letting Eclipse's own already-correct internal resolution logic (not
scoder's own reimplementation of it) decide what to do with whatever's in
there — a strict superset of "reuse whichever specific subdirectory
matters," without scoder needing to know or reconstruct which one that
is. See "History" below for the specific bugs this replaces.

### 4. No headless pre-launch stage — the interactive launch does the import itself

An earlier version of this preset ran the plugin's own headless-import
application as a distinct `prepareCommand` step, entirely before the
interactive Eclipse process even started — motivated at the time by the
plugin's README section describing headless mode as *the* way to trigger
an import without touching the IDE. That's true, but it's not the *only*
way: the README's main "Usage" section, read more carefully after a user
question, says plainly that `-importProject`/`-importPreferences` work on
Eclipse's own ordinary interactive launch too, ending with "will
ultimately place you in the IDE." Once that's true, a separate headless
stage adds a second full JVM/Eclipse startup for no benefit — the
interactive launch already does the same import as part of its own
normal startup sequence.

Dropping the separate stage also retired an entire, general-purpose piece
of infrastructure this preset had motivated adding: `ToolPreset`'s
`prepareCommand` hook, `SandboxConfig.prepareSteps`, and
`builder.ts`'s `wrapWithPrepareStep` — all added specifically to support
this one preset's now-unneeded separate stage, and removed entirely once
nothing used them anymore, rather than left in place as speculative
future infrastructure.

### 5. What the removed `prepareCommand` hook looked like

Kept here for the historical record, since the hook itself is gone from
`src/types.ts`/`src/sandbox/builder.ts` — worth knowing this shape was
tried and deliberately backed out, not merely never attempted:

```typescript
// Runs inside the sandbox, before the tool/IDE exec. Failure here should
// not silently continue into a broken interactive session -- surfaced
// specifically, not folded into resolveArgs' or configBinds' own shape.
prepareCommand?: (
	hostProjectDir: string,
	sandboxProjectDir: string,
	dependencyDirs: string[],
) => Promise<{ bin: string; args: string[] } | null>;
```

`dependencyDirs` — the sandbox-side destinations of every
`.agentreadonly` `$HOME/...` entry already resolved for this session —
was genuinely useful independent of `prepareCommand`, though, and stayed:
it's now a parameter of `resolveArgs` instead (`ToolPreset.resolveArgs`
in `src/types.ts`), exposed as its own distinct list via
`ProtectionConfig.dependencyDirs` (`src/git/protection.ts`) rather than
mixed into `safeBinds` alongside unrelated binds.

## Changes Required

### `src/types.ts`

`ToolPreset.resolveArgs` gained a fourth parameter, `dependencyDirs:
string[]`, alongside its existing "always called, existing args passed
in" behaviour (`rstudio`'s own resolveArgs continues to only fill in a
default when the user gave none; eclipse always prepends its own fixed
flags ahead of `existingArgs`). No `prepareCommand` hook — see Decision 4.

### `src/git/protection.ts`

`ProtectionConfig` gained `dependencyDirs` — the sandbox-side destinations
of every `.agentreadonly` `$HOME/...` entry, exposed as its own distinct
list.

### `src/sandbox/builder.ts`

No eclipse-specific changes — `buildBwrapCommand`'s existing
`ideBin ? wrapWithIdeBackground(...) : [toolBin, ...toolArgs]` composition
already covers everything eclipse needs, whether it's the primary tool or
the `--ide` companion.

### `src/tools/presets.ts`

The `eclipse` preset:
- `configBinds`: X11/XAUTHORITY/XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS
  binds and env, by direct analogy with `rstudio`'s own (Decision 2);
  locates the host's Eclipse install (`which eclipse`, resolved through
  any symlinks) and binds it read-write if under `$HOME`, read-only
  otherwise; binds `$HOME/.eclipse` whole, read-write, if it exists
  (Decision 3); `ensureDir`+binds the persisted workspace directory
  (Design point 3). Does **not** touch `.eclipse.epf` at all — it's
  already part of the regular, read-write project bind (Design point 6).
- `resolveArgs`: the interactive launch always begins with `-data
  <persisted workspace>`, `-importProject <sandboxProjectDir>`, one more
  `-importProject` per `dependencyDirs` entry, and (only when
  `.eclipse.epf` exists at the project root) `-importPreferences
  <sandboxProjectDir>/.eclipse.epf` — with any user-supplied arguments
  appended after all of that.
- `validate`: `commandExists("eclipse")` — same shape as every other
  preset. Does **not** verify the plugin itself is installed; a missing
  plugin surfaces as a loud, native Eclipse error (an unresolved
  `-importProject`/`-importPreferences` argument, or "application not
  found" if something explicitly requests the headless application), not
  a silent one.

## History: the vendored-plugin approach (superseded)

An earlier version of this preset vendored a pinned build of the
plugin's predecessor (`seeq12/eclipse-import-projects-plugin`
`1.4.0.jar`) directly in the scoder repo, and went to considerable
lengths to make it available to a sandboxed Eclipse without ever
modifying the user's real, native Eclipse install or configuration. That
approach worked, but cost six rounds of real-world bug-fixing, all in the
same small area, all stemming from variations on the same root cause:
assuming a single, home-relative absolute path (or a specific,
reconstructed sub-location) could be written once and read correctly
from both inside and outside the sandbox, or precisely reconstructed by
reimplementing Equinox's own internal resolution logic from source. None
of the six were caught by this investigation's own headless testing
(which never exercised a real, externally-named `~/.eclipse/<hash>`
directory end-to-end); all six were caught by real use against a real
install.

In order:

1. **Injecting the jar into `<install>/plugins/` didn't work.** bwrap's
   `--ro-bind` needs to *create* a destination node for a file that
   doesn't already exist there, which fails once the parent is already
   mounted read-only by `builder.ts`'s own wholesale system binds — a
   claim this investigation had originally (wrongly) verified against a
   subtly easier case (binding a new source over an *already-existing*
   destination file, not creating a new one).
2. **Fixed by registering the jar via a hand-built `bundles.info`** —
   Equinox's real bundle list, editable as plain host-side file I/O
   inside whichever `-configuration` directory was in use. Real-world use
   then found this skipped Equinox's own actual *first* choice
   (`<install-dir>/configuration`, when directly writable) and fell
   straight to a `~/.eclipse/<hash>` check that was itself Equinox's
   *second* choice, silently landing sandboxed sessions in an empty,
   unconfigured state on a personal machine.
3. **The `~/.eclipse/<hash>` directory-name match was also wrong** — a
   real directory name has OS/WS/ARCH segments appended *after* the hash
   (`org.eclipse.platform_4.39.0_<hash>_linux_gtk_x86_64`), which an
   `endsWith` check never matched.
4. **The reused directory itself wasn't the configuration area** —
   Equinox's own source says the real location is one level deeper
   (`~/.eclipse/<hash>/configuration`), not the per-hash directory
   directly; fixed, then later found moot once bug 5 removed the need to
   touch any real `bundles.info` location at all.
5. **The deeper problem: don't touch the real `bundles.info` at all.** Any
   value written into a file read both natively and inside the sandbox
   can only be correct in one of those two contexts, since `$HOME` has
   two different spellings and this project deliberately never exposes
   the real one inside the sandbox. The actual fix: Equinox's
   `org.eclipse.equinox.simpleconfigurator.configUrl` system property,
   overridable per-launch via a trailing `-vmargs` argument, letting
   scoder point Equinox at a completely separate, scoder-private
   `bundles.info` — confirmed directly through the real `eclipse` binary
   that the real one is left byte-for-byte untouched either way.
6. **The scoder-private `bundles.info`'s own base-list template picked the
   wrong file** — a self-inflicted regression from bug 4's own,
   since-reverted fix, which had briefly created a stale, plugin-less
   `bundles.info` at the "deeper" nested path as a side effect of merely
   running; the fix's own candidate list checked that stale file first,
   silently dropping every plugin the user had actually installed.

The lesson carried forward, even though the specific mechanism it applied
to no longer exists in the code: this class of "reverse-engineer another
program's real, external state well enough to safely graft something
onto it without disturbing anything else" is exactly the kind of thing
that looks solvable in isolation and keeps finding new edges in the real
world. Requiring the plugin as a genuine prerequisite — the same way any
other Eclipse feature is installed — sidesteps needing to solve it at
all. The separate-headless-stage question (Decision 4) was a smaller
instance of a similar lesson: an implementation detail (a headless mode
exists and was the easiest thing to verify end-to-end in this
environment) got mistaken for a requirement, until a direct question
about it prompted rereading the plugin's own docs more carefully.

## Open Questions, Not Resolved Here

- **Locating the Eclipse installation's own directory** (needed to
  decide read-write-if-under-`$HOME`). Real-world feedback confirms at
  least one real shape directly: a root-installed `/opt/eclipse` with
  `plugins/` as a plain sibling of the `eclipse` binary — so `which
  eclipse`, followed to its real target through any symlinks, should
  work for that shape. Not tested here against a distro-packaged
  (`apt`/`.deb`) install, which historically sometimes uses an indirect
  launcher script rather than a direct symlink to the real binary.
- **GTK/D-Bus behavior for the actual interactive GUI phase** (Decision
  2), whether `-importProject`/`-importPreferences` behave on the
  interactive launch exactly as the plugin's README describes, and
  whether preferences are genuinely picked up correctly from a bound-in
  `$HOME/.eclipse` in a real interactive session — all need a host with
  GTK installed to close out; the user intends to test this directly.

[IMPACTS](/src/types.ts)
[IMPACTS](/src/git/protection.ts)
[IMPACTS](/src/tools/presets.ts)
[HAS_FEATURE](/design/features/tool-presets.md)
[HAS_FEATURE](/design/features/ide-companion.md)
