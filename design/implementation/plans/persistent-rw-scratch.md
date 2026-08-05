---
target-version: 2.4.0
status: complete
tags: [plan, sandbox, scratch, filesystem]
---

# Persistent Read-Write Scratch via a `scratch` Symlink

> **Implemented.** `setupScratchLink` in `src/git/protection.ts`, wired into
> `src/index.ts` once after the worktree/direct branches merge, same as
> `--allow-ssh`. All decisions below landed as designed. Verified directly
> through `buildBwrapCommand`, bypassing this environment's own `/dev/net/tun`
> gap, for every branch: resolves read-write, resolves read-only when
> overlapping furniture or an `.agentreadonly` entry, hard-fails outside
> `$HOME`, warns and continues when dangling.

## Goal

Give a sandboxed agent a place to do things that don't belong in the project
tree, but that need to survive session restarts and use ordinary relative
paths: cloning a third-party dependency to debug or patch it, checking out
branches in that clone, pulling down a dataset, writing analysis output.
Direct mode's project bind is a true read-write passthrough already — nothing
here is about escaping the sandbox, only about having a second, persistent
place alongside the project that isn't part of it.

## Non-Goal, Explicitly Parked

An earlier draft of this explored preventing execution inside the scratch
area via a `noexec` mount, verified working end-to-end (host-side
`mount -o remount,noexec`, inherited correctly through an ordinary `--bind`,
un-liftable from inside the sandbox). Parked because it doesn't protect
anything real: `bash scratch/evil.sh` runs the interpreter, which is
elsewhere on an executable filesystem, and only *reads* the scratch file as
data — `noexec` never sees that exec. `/tmp` inside the sandbox has the exact
same property today. Blocking direct `execve()` of a file while leaving
`bash file` and `python file` untouched is not a security boundary, just a
speed bump, and not worth the operational cost (a privileged one-time host
mount, unlike everything else this design needs).

## Design

A symlink named exactly `scratch` at the project root — direct mode's cwd, or
the worktree directory in worktree mode — is the entire opt-in mechanism. No
flag, no config file. Its presence is detected and its target bound; its
absence changes nothing. Caveat emptor: whatever the user points it at, the
agent gets exactly the access to it that the symlink's target already has.

```
myproject/
├── .git/
├── src/
└── scratch -> /home/alice/scratch/myproject     (symlink, ideally committed)
```

Requirements this satisfies:

- **Persists across restarts.** The target is a real host directory outside
  any sandbox-managed, ephemeral location. Nothing about a new scoder session
  touches it.
- **Inspectable.** It's an ordinary directory at a path the user chose; `ls`,
  `cat`, whatever, no sandbox needed.
- **Relative paths resolve consistently.** The bind destination is always the
  literal absolute path the symlink already points to, every session, so a
  script that does `cd ../scratch/some-clone && ./build.sh` keeps working.
- **Looks the same in the sandbox as out.** Verified directly — see below.

## Verified Groundwork

Established by direct testing against this repository's actual
`buildBwrapCommand`, not assumed:

| Claim | Result |
|---|---|
| bwrap has a native way to shadow one entry inside an already-bound directory (`--dir`, a second `--bind`, or `--symlink` onto a path a prior bind populated) | **No** — all three tried, all three fail. `--bind`/`--dir` on a destination that resolves to a symlink from an earlier bind: `Unable to mount source on destination: No such file or directory`. `--symlink` onto an existing destination: `Can't make symlink at ... existing destination is ...`. |
| Reordering — bind the target at the sub-path *first*, the whole project *second* | **No** — the later, shallower bind (the project) resets the entire view beneath it, discarding the earlier sub-mount. Standard mount-stacking behaviour, not a bwrap quirk. |
| Splitting the project bind into one bind per top-level entry, so `scratch` is never dragged in by a whole-tree bind | **Works**, but rejected anyway — see Rejected Alternatives. |
| Leaving the symlink completely untouched inside the existing whole-project bind, and separately mirroring its **target** at that target's own real absolute path | **Works.** `stat scratch` inside the sandbox still shows a genuine symlink; reads and writes through it land on the real target (confirmed on the host afterward); editing an ordinary tracked file elsewhere in the project still passes straight through, unaffected. |
| `--bind SRC DEST` where SRC is itself a symlink path | Resolves the symlink for the *source* side transparently — no manual `realpath` needed to bind *through* a symlink. (Irrelevant to the chosen design below, which resolves it explicitly anyway so it can validate the target, but useful to know it isn't required.) |

## Rejected Alternatives

**Per-top-level-entry binding.** Instead of one `--bind <project> <dest>`,
enumerate the project's top-level entries and bind each individually,
including `scratch` (source: the symlink path itself, which resolves
correctly per the last row above). This does work, fully verified — but it
means the mechanism used to mount *the entire project* changes shape the
moment a `scratch` symlink exists, for no benefit over the simpler option
below. More moving parts, more surface for a future change to the project
bind to forget about the `scratch` case. Rejected in favour of leaving the
existing single project bind alone entirely.

**Overlayfs** (`--overlay`, shadow the symlink with a directory in the
upper layer). Also technically capable of solving the shadowing problem —
but overlayfs write semantics involve copy-up: writing to a file that exists
only in the lower layer (i.e. any ordinary project file) copies it into the
upper layer first, and the write lands there, not in the real project
directory. That silently breaks direct mode's whole premise — "changes
happen directly in your working directory" — for every file in the project,
not just `scratch`. Rejected outright once this was understood; never
seriously in the running once the write semantics were traced through.

## Design Decisions

### 1. Mirror the target at its own real absolute path — don't rewrite the symlink

The symlink is never touched. Its target, resolved via `realpath`, is bound
at *that same absolute path* — the same "path-mirroring" principle the
project bind and the worktree's git-common-dir bind already use, just
applied to a path outside the project. Concretely: `--dir` for every ancestor
path component that doesn't already exist in the sandbox, then one
`--bind <target> <target>` (or `--ro-bind`, see Decision 3) for the target
itself.

This is the one-additional-bind mechanism: everything else about how the
project gets mounted is completely unchanged, so there is no new code path
for the common case (no `scratch` symlink present) to regress.

### 2. Target must resolve inside the user's real home directory

Not "anywhere the symlink happens to point." `realpath(target)` must be a
proper subdirectory of `realHome` (not `realHome` itself — the whole home
directory is too broad a target for this mechanism). Two reasons:

- It bounds where the ancestor `--dir` chain has to reach — always somewhere
  under a path the sandbox already partially manages (`/home`), never an
  arbitrary point elsewhere on the host filesystem.
- It makes Decision 3's read-only check tractable — both existing sources of
  "this is already known to be read-only furniture" (`.agentreadonly`'s
  `$HOME/...` lines, and `buildExtraBinds`' fixed list) are themselves
  `$HOME`-relative.

A target outside `$HOME` is a **hard error** (exit 1) — this is a contract
violation worth surfacing loudly, not a transient state to wait out. A target
that doesn't exist *at all* is different — see Decision 4.

### 3. Read-only if the target overlaps something already read-only

If the resolved target is, or is inside, a path scoder already treats as
read-only furniture — an `.agentreadonly` `$HOME/...` entry, or one of
`buildExtraBinds`' fixed host-tool paths (`~/.local/bin`, `~/.gitconfig`,
`~/.cargo/bin`, `~/.rustup`, `~/.m2`, `~/.npmrc`, `~/.pypirc`,
`~/.config/gh`, `~/.local/share/mise`, `~/.config/mise`, `~/R`,
`~/.Rprofile`) — the mirrored bind is `--ro-bind`, not `--bind`. `scratch`
still resolves and is usable; it just isn't writable.

This closes a real footgun rather than a hypothetical one: without it,
pointing `scratch` at, say, `~/.cargo/bin` — accidentally, or by reusing an
existing directory out of habit — would hand the sandboxed agent write
access to something that is deliberately read-only everywhere else in the
tool. `scratch` should never be a backdoor to upgrade access to something
scoder already decided to protect.

The check: does the resolved target equal, contain, or sit inside (a) any
`ro-bind` source already present in `protectionConfig.safeBinds` at the time
`scratch` is evaluated (this already covers `.agentreadonly`'s `$HOME/...`
entries — those are computed earlier in `setupProtection`), or (b) a small
fixed list of real paths mirroring exactly what `buildExtraBinds` binds.
(b) has to be a parallel list rather than a call into `buildExtraBinds`
itself, since that function only returns *destinations* already tied to
`sandboxHome`, not a reusable set of *source* paths to check against — noted
as a small duplication to keep in sync if `buildExtraBinds` changes, same
category of thing `SANDBOX_MOUNT_PREFIXES` already is for a different check.

### 4. Dangling target: warn and skip, don't fail the session

Different from Decision 2's "outside `$HOME`" case. A `scratch` symlink whose
target doesn't exist *yet* is an expected, valid state — the point made in
discussion was specifically that for something like a data-analysis project,
a dangling `scratch -> ~/data/thisproject` committed to the repo is a
feature: it tells a new clone of the repo exactly what local setup step is
missing, rather than leaving no trace at all. Failing the whole session over
this would defeat that. Warn clearly, skip the extra bind, and let the
session proceed — the agent sees the same dangling symlink it would see
outside the sandbox, which is the honest state of things.

A target that exists but isn't a directory (a plain file, say) is treated
the same as "outside `$HOME`" — Decision 2's hard error, not Decision 4's
soft warning — since that's a clear, fixable misconfiguration rather than a
"not set up yet" state.

### 5. No new CLI flag

The symlink's presence *is* the opt-in — matches `.agentreadonly`'s existing
"a file's presence changes behaviour" convention. Nothing to remember to pass,
nothing to document as a flag. `git status`/`git ls-files` already tell you
whether it's tracked or ignored; no new state for scoder to manage on top of
that.

### 6. Tracked vs. gitignored — recommend tracked, support either

Untracked (gitignored): only ever appears where the user manually created
it. Fine for direct mode. In worktree mode, a fresh `git worktree add`
checkout contains only tracked files, so an untracked `scratch` symlink in
the original checkout will not appear in a newly created worktree — no
scoder-side workaround for this is planned, since:

Tracked (committed): git stores a symlink as a blob containing the target
path string — it never dereferences it, never copies the target's content
into the repository, so committing it costs nothing and touches no secrets.
Every worktree checkout, fresh or otherwise, then carries the symlink
automatically, with zero extra code. On a different machine — a colleague's
clone, CI, a downstream consumer — the same committed path will usually be
wrong for their filesystem and the symlink will dangle; Decision 4 makes that
an informative, non-fatal state rather than a hard failure. Recommended
default; both are supported since scoder only ever inspects the working
tree, not the index.

## Changes Required

### `src/git/protection.ts`

New exported function, called once, after `setupProtection` and after any
`.agentreadonly` HOME binds have been resolved into `protectionConfig`
(needed for Decision 3's overlap check against those sources):

```typescript
// ### setupScratchLink
// Detects a `scratch` symlink at projectRoot, resolves it, and mutates
// protectionConfig in place with the ancestor --dir chain and the mirrored
// bind (rw, or ro per Decision 3). No-ops silently if `scratch` doesn't exist
// or isn't a symlink. Exits 1 on a contract violation (Decision 2); warns and
// no-ops on a dangling target (Decision 4).
export async function setupScratchLink(
	projectRoot: string,
	protectionConfig: ProtectionConfig,
): Promise<void>;
```

Lives alongside `.agentreadonly`'s HOME-bind handling rather than in a new
module — it's the same category of thing (a project-root marker that grants
access to something outside the project), and reuses `realpath`/existence
helpers already private to this file.

### `src/index.ts`

Called once after the worktree/direct branches merge — `protectionConfig` is
a single shared variable regardless of which branch ran, so, same as
`--allow-ssh`'s wiring, there is no reason to duplicate this into both
branches:

```typescript
const projectRoot = options.worktree && worktreeInfo ? worktreeInfo.worktreeDir : process.cwd();
if (protectionConfig) {
	await setupScratchLink(projectRoot, protectionConfig);
}
```

No interaction with `--dry-run` beyond the ordinary one: the binds it adds to
`protectionConfig.safeBinds` show up in the printed `--dry-run` output the
same way every other protection bind already does, with no special-casing
needed (unlike `--allow-ssh`, nothing here opens a connection or otherwise
has a side effect dry-run would need to avoid).

### `src/git/protection.ts` — `RESERVED_SANDBOX_PATHS` / furniture list

The fixed host-path list for Decision 3's overlap check needs to live
somewhere reusable and kept in sync with `buildExtraBinds` in
`src/sandbox/builder.ts` — same caveat `SANDBOX_MOUNT_PREFIXES` already
carries ("this list must mirror buildExtraBinds exactly").

## Interactions to Resolve

1. **`.agentreadonly` protecting a path that is also the `scratch` target's
   ancestor or descendant**, in the *project* sense (not the `$HOME` sense
   Decision 3 already covers) — e.g. `.agentreadonly` lists a pattern that
   happens to match the literal `scratch` symlink itself. Since
   `.agentreadonly` patterns are resolved against the project tree and only
   affect what's visible *within* the project bind, and `scratch` the
   symlink is a single dirent there (not a directory scoder would recurse
   into for protection purposes), this should be inert in practice — worth a
   test case rather than a code change.
2. **Two `scratch`-like needs in one project.** Out of scope by design — one
   symlink, one bind. A project needing more than one persistent external
   area can create more symlinks under a real (non-magic-named) directory and
   point each at whatever it needs; only the literal top-level `scratch` name
   gets scoder's special handling. Worth a line in the README rather than
   new mechanism.
3. **Ancestor `--dir` chain colliding with an existing bind at one of those
   ancestor levels.** Since the target is constrained to be under `$HOME`
   (Decision 2), and `$HOME`'s own sandbox representation is a fresh
   `--tmpfs`, this should only ever add plain empty directories under a tmpfs
   scoder already owns — verified harmless when `--dir` is applied to a path
   segment that already exists (`/home`, from `--tmpfs /home` itself) in the
   groundwork testing above. No special-casing planned.

## Test Plan

- `scratch-symlink-resolves-rw`: with a `scratch` symlink pointing at a fresh
  directory under a fake `$HOME`, reading pre-existing content and writing
  new content through it inside the sandbox both work, and the write is
  visible on the host afterward.
- `scratch-absent-no-behaviour-change`: without a `scratch` symlink, the
  built bwrap command for a given project is byte-for-byte identical to
  today's — guards Decision 1's "no new code path for the common case"
  property directly, not just informally.
- `scratch-outside-home-fails`: a `scratch` symlink resolving outside
  `$HOME` exits 1 with a clear diagnostic.
- `scratch-dangling-warns-and-continues`: a `scratch` symlink whose target
  doesn't exist warns, and the session still runs successfully.
- `scratch-overlapping-furniture-is-readonly`: a `scratch` symlink pointing
  at (or inside) one of `buildExtraBinds`' fixed paths results in `--ro-bind`
  in the dry-run output, not `--bind`.
- `scratch-overlapping-agentreadonly-home-is-readonly`: same, for a target
  that overlaps an `.agentreadonly` `$HOME/...` entry.
- `scratch-real-passthrough-unaffected`: with `scratch` present, editing an
  ordinary tracked project file still writes straight through to the host —
  guards against ever regressing towards the rejected overlayfs approach.
- `scratch-tracked-symlink-present-in-fresh-worktree`: a committed `scratch`
  symlink is present (dangling or not) in a newly created worktree, with no
  scoder-side code involved in making that true — a sanity check on
  Decision 6's git-native claim, not a test of new scoder behaviour.

## Documentation to Update

(At implementation time.)

- New `design/features/persistent-scratch.md`, linked from `design/SCOPE.md`.
- `README.md`: the `scratch` symlink convention, the read-only-if-overlapping
  behaviour, and the tracked-vs-gitignored recommendation.
- `design/test-scripts/validation-suite.md`: the new cases, and the count.
- `architecture/FRAMEWORK.md`: module map — `setupScratchLink` in
  `src/git/protection.ts`.

[IMPACTS](/src/git/protection.ts)
[IMPACTS](/src/index.ts)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
[HAS_FEATURE](/design/features/path-mirroring.md)
[HAS_FEATURE](/design/features/infrastructure-protection.md)
