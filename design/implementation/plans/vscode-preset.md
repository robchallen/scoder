---
target-version: 2.9.0
status: draft
tags: [plan, ide, vscode, sandbox]
---

# VS Code Preset

## Goal

Let `scoder vscode` and `scoder <agent> --ide vscode` work, following the
patterns established for `rstudio` (an Electron GUI app under xpra) and
`eclipse` (an IDE whose notion of "state" outlives the session and needs
scoder-managed persistence). VS Code is the third hit of two recurring
problems — *where does app state live when `$HOME` is tmpfs*, and *what does
a sandboxed app do about a keyring it can't reach* — so this plan decides
the first and delegates the second to
[design/features/secret-storage.md](/design/features/secret-storage.md).

Every factual claim below marked **verified** was read from `microsoft/vscode`
source (`main`, 2026-10) or measured in this repo. Claims marked
**measure-on-desktop** need the user's real desktop (same relationship to the
eclipse plan as its own "not independently verified" sections — but listed
up front this time, not discovered mid-implementation; that was the ADR 0004
lesson).

## What Carries Over Unchanged

VS Code Desktop is Electron/Chromium — the same class of app as RStudio
Desktop — so all of this transfers by direct analogy, no new work:

- `gui: true`, `guiDisplayBinds()`: virtual X display inside the sandbox,
  xpra socket dir, `XDG_RUNTIME_DIR` passthrough,
  `GTK_OVERLAY_SCROLLING`, and the **load-bearing `/dev/dri` dev-bind** — the
  Chromium GPU process `CHECK()` failure without a DRM node was measured
  against RStudio, and it is the same Chromium.
- [0003-xpra-gui-isolation](/architecture/decision-records/0003-xpra-gui-isolation.md)
  display model and
  [0004-no-host-dbus](/architecture/decision-records/0004-no-host-dbus.md):
  VS Code needs *a* session bus; xpra's private one is it. `--notifications=yes`
  carries notifications outward the same way.
- `--ide` companion mechanics (`wrapWithIdeBackground`, merged binds, ENTER
  prompt) — `--ide` accepts any registered preset by design; the
  [ide-companion feature](/design/features/ide-companion.md) has named vscode
  as its motivating future case since it was written.
- Dialog placement prediction from the parked
  [dialog-placement issue](/design/implementation/issues/xpra-dialogs-placed-at-screen-origin.md):
  Electron delegates dialog geometry to the WM (it is why RStudio places
  correctly and SWT/Eclipse does not) — expect RStudio-like behavior. Free
  confirmation to watch for in the checklist, not work.
- The dry-run test template: `no-host-dbus-address-in-the-sandbox` in
  `tests/scoder.test.ts` shows the shape for every assertion below.

Unlike **Eclipse**, VS Code has no workspace-metadata problem: workspace
state is keyed by a **hash of the folder path** in the user-data-dir, not by
absolute-path blobs in a checksummed binary format. With path mirroring, a
direct-mode project sits at its own host path inside the sandbox, so the
hash matches what the host's VS Code would compute. No plugin, no import
flags, no `.location`-class reverse-engineering.

## The Core Problem: User-Data-Dir Identity

VS Code keeps everything per-instance — settings, keybindings, globalState,
`state.vscdb`, per-workspace storage, and (with `basic` mode) secrets — under
one **user-data-dir**, `~/.config/Code` by default. It is **single-instance
per user-data-dir**: the second process to start with the same user-data-dir
hands its window request to the first main process over an IPC socket and
exits.

That rule immediately rules out the rstudio-style answer ("bind the host's
real `~/.config/Code` read-write"):

1. **Concurrency is the default, not an edge case.** The user's host VS Code
   is likely open *while* a sandboxed one launches. The singleton lock
   (`SingletonLock`, a `hostname`-`pid` symlink) and IPC socket live *inside*
   the user-data-dir, so the two instances see each other's lock through the
   bind — and because they share no PID namespace (scoder's bwrap uses
   `--unshare-user --unshare-net` only), a lock written by a sandbox instance
   is readable host-wide and vice versa.
2. **Worse than a UX wart: two live processes writing one SQLite
   (`state.vscdb`) is a corruption risk**, and a cross-namespace IPC socket
   *connect* over a shared bind mount succeeds — the sandboxed instance would
   genuinely hand its "open this folder" request to the host instance (or to
   another sandbox's), opening windows in the wrong place and exiting.
3. It would silently widen the host-write surface past even `~/.claude`'s
   (the recorded debt in `design/implementation/debt/rw-config-mounts-limited-escape.md`)
   to a live app database.

So: **a private user-data-dir, always.** Microsoft's own CLI help agrees this
is the intended mechanism — **verified** from
`src/vs/platform/environment/node/argv.ts:116`: `--user-data-dir` "Can be
used to open multiple distinct instances of Code."

Private is decided; the real question, the one the user raised, is:
**ephemeral or persisted?** Ephemeral (fresh per session, `$HOME` tmpfs) is
trivially correct but resets the IDE every session — extensions' per-user
state, recently-opened lists, unsent settings edits. Unacceptable on
usability grounds. Which required investigating the existing persistence
machinery.

## Persistence-Mechanism Investigation (the user's ask)

Three mechanisms for persistent data exist in scoder today, in various
states:

**1. `.sandbox/readwrite`** ([implemented feature](/design/features/agent-readwrite.md),
the successor to the retired `persistent-rw-scratch` plan — the scratch plan
is kept as the historical record of why the symlink design was replaced).
A file at the project root listing `$HOME/...` directories bound read-write,
auto-created when missing, validated against escape and against overlap with
already-protected paths. *Could* carry the user-data-dir: list
`$HOME/.local/share/scoder-vscode-userdata/<proj>` and it persists, bound at
its own mirrored path (and `--user-data-dir` takes any path, so no dest
trickery needed). Rejected as the *primary* mechanism for preset-internal
state: it is per-project opt-in by a **file in the repo**, aimed at
*agent* data (caches, analysis output) that a project author wants to
declare. IDE identity state is the opposite — scoder's own decision, identical
for every project, and nothing a project should carry or a colleague's clone
should inherit. Kept as a documented **escape hatch** (a user who wants
somewhere else entirely can point `.sandbox/readwrite` at it and… well, the
preset computes the path; overriding is an open question, below).

**2. The eclipse managed-workspace**: `~/.local/share/scoder-eclipse-workspaces/<projDir>`
(`SCODER_ECLIPSE_WORKSPACES_DIRNAME`, keyed by `getProjDir`), host-side
`ensureDir` + ancestor `--dir` chain (`pushIntermediateDirs`) + one rw bind,
plus seed-once-on-first-creation from the user's real settings and a guard
against re-seeding ever clobbering sandbox edits. **This is the right shape**,
and VS Code needs the same three pieces: per-project persistence, a smaller
seed, and the same "seed only on first creation" rule.

**3. Scratch symlinks** — retired, listed for completeness of the record;
its "mirror at real path" groundwork survives inside `.sandbox/readwrite`.

## Design Decisions

### 1. Managed, project-scoped user-data-dir

`~/.local/share/scoder-vscode-userdata/<projDir>` (via `getProjDir`, exact
analogue of eclipse's layout), created host-side, bound rw at its own path,
passed with `--user-data-dir`. Same project → same IDE state next session,
worktree or direct. Different projects → different instances, which is
precisely what dissolves the singleton problem *between* projects: separate
user-data-dirs are, by Microsoft's own description, distinct instances.

Worktree-mode note: per-workspace storage inside the user-data-dir is keyed
by folder-path hash, so a project's worktrees accumulate separate
workspaceStorage entries in one shared dir. Correct, slightly growing,
harmless — same shape as eclipse storing several `.location`s.

### 2. Seed settings once, copy-not-symlink, never re-seed

On **first creation only** (the eclipse rule, `dirExists` check before
`ensureDir`): copy `settings.json`, `keybindings.json`, and `snippets/` from
the host's `~/.config/Code/User/`. Deliberately *not* seeded: workspace
storage, globalState, `state.vscdb`, `argv.json` (that one is load-bearing —
see §5 — the host's must stay out), and everything secret-shaped. Copy, not
symlink: a symlink would make sandbox edits reach the host's settings file,
re-opening through a `--dir` under `$HOME` the very write surface §"Core
Problem" closed, and would make "seeded" mean "live-shared" under a name that
promises a one-time copy.

### 3. Extensions: shared read-only

`~/.vscode/extensions` (the host desktop install's own extensions dir) bound
**read-only** at its mirrored path, passed with `--extensions-dir`. Agreed
call: ro first, refine from experience. What ro means in practice, so the
refinement decision later has a record: extension install/update from inside
the sandbox fails with an error notification (VS Code writes `.obsolete`,
`.fif` markers and extracted VSIXes into that dir), and an update-available
toast may nag but cannot act. Extension *execution* is unaffected — the
extension host launches node/electron against ro files; nothing extensions
do at runtime needs their install tree to be writable. Refinement candidates,
in rough order of least harm: leave ro and tell users to install host-side;
`~/.vscode/extensions` rw (accept host writes, the eclipse
`$HOME/.eclipse` rw precedent); a managed extensions dir seeded by copy
(the full-parallel of the user-data-dir answer — heaviest).

`--builtin-extensions-dir` is *not* passed: built-ins live in the install
directory (`/usr/share/code/resources/app/extensions` for a .deb), already
covered by the builder's wholesale `/usr` ro bind and path-mirrored for a
tarball install under `$HOME`.

### 4. scoder-owned vs user-owned argv

Following the established split (eclipse always-prepends, rstudio
fill-if-empty), VS Code's flags split across the line too:

- **Always prepended** (instance identity — dropping them would re-open the
  singleton collision, so they are never user-overridable):
  `--user-data-dir <managed>`, `--extensions-dir <host ~/.vscode/extensions>`,
  `--disable-updates` (**verified** flag, `argv.ts:190`; an auto-updater
  inside a sandbox writes nowhere useful and only produces failures).
- **Fill-if-empty**: the project directory, rstudio-style — first positional
  arg is the folder to open, `code <dir>` opens it directly.
- **Never touched**: telemetry (`--disable-telemetry` exists,
  `argv.ts:188` — the user's seeded `settings.json` should govern it, not
  scoder), crash reporter, extensions by id, `--new-window`, and everything
  else — `existingArgs` pass through after the project arg, like eclipse's
  user args after its fixed ones.

One more judgment flag, proposed as always-prepended with the reasoning
stated: `--disable-workspace-trust` (**verified** flag, `argv.ts:124`). A
fresh managed user-data-dir has *no* workspace-trust state, so first launch
would drop the project into restricted mode (many extensions silently
disabled) and re-ask trust decisions that scoder's own sandbox has already
made moot — the dialog's threat model is "you opened an untrusted folder on
your real machine". This is the one place a scoder flag *removes* a safety
prompt, so it is called out; the measure-on-desktop checklist confirms the
symptom before the flag ships.

### 5. `argv.json` stays out

**Verified** (`mainImpl.ts`): the per-user Electron args file (`~/.vscode/argv.json`)
supports `password-store`, `disable-chromium-sandbox`, and others. `$HOME` is
tmpfs and `~/.vscode` is not bound, so a host `argv.json` is invisible inside
the sandbox — which is the *right* default: it means scoder's flags can't be
quietly overridden by a file the user set up for their host instance, and
equally means nothing scoder needs can live there. If a sandboxed-vs-host
divergence ever *wants* an argv.json, that's the day to bind a managed one —
open question, not a task.

### 6. Chromium's own sandbox under bwrap — measure first

**Verified** (`mainImpl.ts:41-55`): the Chromium sandbox is on by default and
can be disabled by `--no-sandbox` / `--disable-chromium-sandbox` (or
`argv.json`). Whether disabling is ever *needed* is the plan's first
open measurement: bwrap gives the sandbox a user namespace (`--unshare-user`)
and Chromium's sandbox wants exactly that; nested unprivileged user
namespaces may simply work, in which case no flag is passed and nothing more
is said. If instead VS Code refuses to start (the classic "SUID sandbox
helper binary was found, but is not configured correctly" dialog), then
`--no-sandbox` gets added to the always-prepended list *with a comment
recording why it is safe here*: Electron's sandbox defends against a
compromised renderer escaping to the user's session; in a scoder sandbox the
outer boundary **is** bwrap, and the renderer already cannot reach the host
filesystem, sockets, or network that Electron's sandbox exists to gate. Same
logic as RStudio running with GPU flags no desktop would ship. Do not add
the flag speculatively.

### 7. Secret storage — see the feature doc, decision A

Per [secret-storage.md](/design/features/secret-storage.md): pass **no**
password-store flag; VS Code's verified behavior without a Secret Service is
a clean in-memory fallback (secrets for the session, nothing to disk,
`mainImpl.ts` even ships a `use-inmemory-secretstorage` switch for forcing
it). Persistent tokens are a *future opt-in* (`--password-store=basic` —
one flag, now that §1 persists the user-data-dir to hold them), not a default.
What the checklist must confirm: whether gnome-keyring D-Bus-activates on
xpra's private bus the way it did for Chrome, and what the first-run
experience is when it does.

### 8. validate(): `code`, and never a snap

`commandExists("code")` + `requireXpra()`, with install instructions
distinguishing the .deb/rpm (fine), the tarball (fine — resolves and binds at
its own path under `$HOME`; ro is enough since VS Code writes no state into
its install tree), and **snap** (rejected): if the resolved path is under
`/snap/`, fail with a clear diagnostic — a snap is itself a container with
its own confinement; scoder wrapping it produces failures nobody could
debug, the same hard-fail-never-degrade stance as `requireXpra`. (The VS Code
snap even sets `SNAP_INSTANCE_NAME`, which `mainImpl.ts` reads — real snap
paths are expected in the wild.) A pure `isSnapInstall(path)` predicate makes
this unit-testable even though `/snap` itself is not fakeable in tests.
VSCodium (`codium`, its own dirs: `~/.config/VSCodium`, `~/.vscode-oss`)
noted as a possible one-line sibling preset later; out of scope now.

### 9. `ideShutdown` — measured, not guessed

The recorded pairs are measurements (rstudio: HUP/process-first — SIGHUP is
"your terminal went away" and rsession must not die first; eclipse:
TERM/children-first — the launcher must not be signalled alone). Prior for
VS Code: all children (extension host, GPU process, pty host) fork from
Electron main, so **process-first** — but which signal closes it *cleanly*
(with its windows actually gone) is exactly the kind of thing that was wrong
in prior before; the checklist measures TERM/INT/HUP/USR1 and the order, same
protocol that produced rstudio's and eclipse's values.

### 10. Agent-in-terminal parity with rstudio

`pi` (and `claude`) in VS Code's integrated terminal get the same treatment
rstudio's preset gives: include `piConfigBinds` via the shared helper — one
list, no second drifting copy. `~/.claude` stays under the claude preset's
existing rw rationale.

## Changes Required

- `src/tools/presets.ts`: new `vscode` preset (the layout helpers mirror the
  eclipse section: `resolveVscodeLayout` computing managed user-data-dir +
  seed-once; `configBinds` = `guiDisplayBinds` + managed dir + extensions ro
  + `piConfigBinds`; `resolveArgs` per §4; `validate` per §8).
- `src/types.ts`: `resolveArgs`' existing signature covers this preset (no
  `dependencyDirs` use in v1; VS Code's own multi-root workspaces are the
  user's to compose) — but the plan's "nothing new expected" turned out
  wrong in one small way: every other preset's key is its binary's name,
  and vscode's isn't ("everyone calls the editor vscode; the binary is
  `code`"), so `ToolPreset` gained an optional `command?: string` that
  `index.ts`'s two `which()` resolutions prefer over the preset key.
- `src/cli/dependencies.ts` / help text: none (xpra already listed).
- `README.md`: preset list + `scoder vscode` / `--ide vscode` example.
- `design/features/tool-presets.md`: the vscode section once implemented
  (this plan stays the record of the investigation until then).

## Test Plan (automatable from here, dry-run style)

- `vscode-preset-args-and-binds`: fake `code` on PATH + fake `$HOME` with
  `~/.config/Code/User/settings.json` + `~/.vscode/extensions`; dry-run must
  show: `--user-data-dir` at the managed path (and its ancestor `--dir`
  chain), `--ro-bind` of the extensions dir, `--bind` of the managed dir,
  flags in order (managed-dir flags before the project dir arg), and the
  project dir present as the folder argument.
- `vscode-settings-seeded-once-and-never-again`: first run copies
  `settings.json` into the managed dir; host file edited; second run leaves
  the managed copy untouched (eclipse's seeding guard, re-asserted here).
- `vscode-user-args-preserved`: pinned flags prepend, the user's own args
  follow verbatim, and any user arg at all suppresses the project-dir fill.
  The plan originally wrote "keeps user args after the project arg", but
  that can't be implemented cleanly: distinguishing which of the user's
  args is a folder to open from which is a flag's value (`--install-extension
  ext.id` has a value that is not a folder) is fragile, so the fill triggers
  on total arg presence (the same rule rstudio uses), not on positional
  detection. A user giving any argument takes over choosing what to open.
- `vscode-as-ide-companion`: `scoder pi --ide vscode` dry-run shows the same
  binds/flags merged into the single bwrap command, deduplicated.
- `vscode-no-host-dbus-address`: clone the `no-host-dbus-address-in-the-sandbox`
  assertions for the vscode preset.
- `isSnapInstall` unit test (pure predicate; see §8 for why not end-to-end).

## Real-Desktop Validation Checklist (the user's host — nothing here
blocks writing the code, but items 1, 3, 5, 6 gate shipping their answers)

1. **Launch without any sandbox flags.** Does VS Code start under bwrap with
   Chromium's sandbox intact (§6)? If it shows the SUID-helper dialog: retry
   with `--no-sandbox`, confirm clean, then implement §6's fallback with the
   recorded rationale.
2. **Host + sandbox concurrently**, different user-data-dirs: two fully
   independent windows, no handoff. (Expected by design; this falsifies it if
   wrong.)
3. **Two scoder sessions, same project** (same managed dir): expected bad —
   the second hands off and/or exits. If confirmed, the policy is a
   pre-flight check: a live `SingletonLock` in the managed dir ⇒ hard error
   naming the running session, never silent handoff (`requireXpra`'s
   philosophy; eclipse's same-project concurrency limit is the precedent).
4. **Relaunch after a killed session** (stale lock): does Electron steal the
   stale lock cleanly? Pids are host-visible (no PID namespace), and hostname
   is the host's, so its staleness check has honest inputs — confirm rather
   than assume.
5. **Secret storage first run** (§7, feature doc Q1).
6. **Shutdown matrix** (§9).
7. **Extension install attempt with ro extensions dir**: capture the exact
   failure UX to inform the §3 refinement decision.
8. **Workspace trust** symptom (§4's flag rationale) with and without the
   flag.
9. **Scroll wheel + dialog placement** (xpra-gui-isolation known issues;
   expect RStudio-like per the placement issue's analysis).
10. **GPU path**: with `/dev/dri` bound; and (if easily testable) forcing the
    software path, watching for the RStudio-class white-window `SIGILL`.
11. `scoder pi --ide vscode`, `pi` in the integrated terminal, clean exit
    from both sides (also exercises the embedded-terminal deadlock fix that
    eclipse/rstudio recorded).

## Open Questions

1. §6's answer decides one flag; nothing else proceeds differently either way.
2. §3's refinement, informed by checklist item 7.
3. Escape hatch for overriding the managed user-data-dir location (`.sandbox/readwrite`
   can *carry* it but today cannot *relocate* it — the preset computes the
   path). Only worth machinery if the first answer is ever wrong in practice.
4. Codium sibling preset: name mapping table (`code`/`codium`,
   `~/.config/Code`/`~/.config/VSCodium`, `~/.vscode`/`~/.vscode-oss`) — one
   preset factory parameterized by the three, if wanted.
5. Does a `code tunnel` / remote-server story ever belong under scoder? Out
   of scope; VS Code's own product answer, not a sandboxing one.

## Documentation to Update (at implementation time)

- `design/features/tool-presets.md` — the vscode section (and its table row).
- `design/features/secret-storage.md` — the checklist answers land in its
  open questions; policy item 2 implements only if a user wants it.
- `design/test-scripts/validation-suite.md` — new cases + count.
- `architecture/FRAMEWORK.md` — module map if anything moves outside
  presets.ts.

[IMPACTS](/src/tools/presets.ts)
[HAS_FEATURE](/design/features/tool-presets.md)
[HAS_FEATURE](/design/features/ide-companion.md)
[HAS_FEATURE](/design/features/xpra-gui-isolation.md)
[HAS_FEATURE](/design/features/secret-storage.md)
