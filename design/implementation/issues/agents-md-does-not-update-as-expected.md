---
target-version: 2.7.0
status: resolved
tags: [issue, sandbox, agents-md, overlay, bind-mount]
---

# Host Edits of AGENTS.md Lose the scoder Template Inside the Sandbox

## Summary

The live AGENTS.md overlay works — until the host file is saved the way most
tools save. The moment an editor writes `AGENTS.md` via a temporary file and
`rename()` (VS Code's atomic save, vim's default backup mode, `sed -i`,
`git checkout`/`pull`/`stash pop`, `mv`), the sandbox starts showing the raw
host file: the updated content arrives, but **scoder's injected section is
gone**, and it stays gone for the rest of the session. The watcher keeps
rendering, keeps returning `true`, keeps logging "changed on the host —
updated in the sandbox" — into a bind mount nothing can reach any more.

Reported 2026-10-02, two days after the live-overlay rework
(`e56354b`, `38aff7e`).

## Reproduction

Direct mode, committed `AGENTS.md`, a tool that samples inside the sandbox
once a second; a rename-save on the host at t≈5s:

```
tick 5:  template=2 firstline=# project rules ORIGINAL
tick 6:  template=0 firstline=# rules RENAMED-BY-EDITOR   ← mv tmp AGENTS.md
tick 14: template=0 firstline=# rules RENAMED-BY-EDITOR   ← never recovers
```

(`template=N` counts `scoder sandbox` headings in `AGENTS.md` as read inside
the sandbox.)

An in-place edit — `echo 'more guidance' >> AGENTS.md` — does **not** break
anything: content and template both stay correct indefinitely. That asymmetry
is the whole story, and it is why the feature's own tests pass: they edit in
place.

## Root cause: a bind grafts onto the file at the destination, not the name

The overlay presents a staged file by mounting it *at* `<projdir>/AGENTS.md`.
That mount is attached to the file object occupying that directory entry when
bwrap sets it up — a graft onto **that file**, not a redirect of the name.
Inside the sandbox, `<projdir>` is the live host directory (a bind of it,
which is the point — it updates in real time), and path lookup passes
through the directory every time.

A rename-based save is a *directory* operation: it deletes the old entry and
installs a new file under the same name. The grafted entry is unlinked, and
its mount goes with it. The name now maps to the new file, which carries no
mount, so the sandbox reads it raw — live host content, no injection. The
staged source is irrelevant to all of this: its inode never changes and its
content stays current, but nothing reads it any more.

Isolated host-side, with exactly the shipped scheme (staged file re-rendered
in place, ro-bound at the project path):

```
before rename:  staged inode 1182877   proj inode 1182878   inside: base + template
after  rename:  staged inode 1182877   proj inode 1182879   inside: new base only
```

The source inode is constant throughout, as any staged-copy design requires;
what swapped is the destination's directory entry, and that is where the
mount lived.

Nothing outside a mount namespace can mount into it, so no watcher can repair
this mid-session; and the agent's uid inside the sandbox carries no
capabilities to self-repair either. Recovery requires restarting the session.

## The staging-directory + `--symlink` proposal, analysed

The original note on this issue (transcript preserved below) proposes binding
a scoder-owned staging directory read-only at `/staging` and placing a
`--symlink` at the project's `AGENTS.md`. The rename-immunity instinct is
correct — a symlink or mount is immune to renames *of other files* — but the
symlink cannot exist at that path, because the project file **is** at that
path. Measured on bwrap directly:

- **`AGENTS.md` exists (the bug's own case):**
  `bwrap: Can't make symlink at <proj>/AGENTS.md: destination exists and is
  not a symlink` — refused at startup.
- **`AGENTS.md` absent (the transcript's example):** it works inside — and the
  symlink is written **through the read-write bind onto the host filesystem**:
  the user's project now contains `AGENTS.md -> /staging/AGENTS.md`, dangling
  on the host (the target exists only inside the sandbox), repo-visible to
  git. The first real save then replaces the symlink with a regular file and
  the overlay is gone again, same as before.

The general rule the transcript's example quietly relies on: a symlink is a
filesystem object, not a namespace artefact — `symlink(2)` inside a bound
directory writes into the user's filesystem. So the pattern needs the link
(or mountpoint) to live in a filesystem scoder owns. This codebase already
applies that rule once: the resolv.conf snapshot binds at the *resolved*
`/run/systemd/resolve/...` path, which inside the sandbox is on its own
tmpfs (`--tmpfs /run`), so no host rename can ever touch the destination.
`AGENTS.md` has no such move available: agents read `./AGENTS.md` in the
project directory, which is the user's directory by definition.

## The tmp-overlay proposal, measured

A later proposal wraps the project directory in an overlay so the
destination's `AGENTS.md` entry lives on bwrap's own layer:

```bash
bwrap \
  --bind /path/to/host/project /sandbox/project \
  --overlay-src /path/to/host/project \
  --tmp-overlay /sandbox/project \
  --ro-bind /path/to/staging/AGENTS.md /sandbox/project/AGENTS.md \
  --chdir /sandbox/project /bin/bash
```

(As literally proposed, `--tmp-overlay` is rejected on bwrap 0.11.1 without a
`--overlay-src` naming the lower.) Measured, clean timeline, sampler inside:

| host event | sandbox sees | |
|---|---|---|
| in-place edit of project `AGENTS.md` | staged content unchanged | masked |
| in-place re-render of the staged file | new staged content arrives live | ✅ |
| host edit of an untouched file (`README.md`) | arrives live via the lower | ✅ |
| **rename-save of project `AGENTS.md`** | **staged content — bind survives** | ✅ **defeats this bug** |
| rename-replace of the *staged* file | frozen on the old staged content | stale, but scoder's staged writes are truncate-in-place, so unreachable |

The rename case passes because the mount is now grafted onto the *overlay's*
`AGENTS.md` dentry — the host's rename happens in the lower layer underneath
and can no longer unlink what the bind sits on. This is the same rule the
resolv.conf snapshot follows (mountpoint on a filesystem scoder owns),
achieved at the project path itself.

Its dealbreaker: `--tmp-overlay` routes sandbox writes to a throwaway tmpfs.
Measured — a file the sandbox created at tick 3 had vanished from the host
project at session end. Direct mode's "edits appear on the host immediately"
and worktree mode's post-exit `commitAllChanges` both break outright, and
overlay law adds a second wrinkle: once the sandbox has written a file, its
upper copy shadows the lower, so later host edits of that file go unseen
inside. The durable-upper variant (`--overlay RWSRC WORKDIR DEST`) saves the
writes — into a scoder-owned directory, not the project — which then needs a
deletion-aware (whiteout-interpreting) replay at teardown: a sync engine,
clone-mode territory, to fix one file.

## Approaches

| | presentation | survives rename | host repo during session | notes |
|---|---|---|---|---|
| a | staged file ro-bound at the project path *(current)* | **no** — this bug | untouched | works only for in-place writers |
| b | staging dir + `--symlink` at the project path | no (and refuses to start; leaks a dangling symlink into the repo when it does) | polluted | measured above |
| c | **in-place content injection**: the watcher writes `base + injection` into whichever file occupies the project path (truncate-write = same inode, so a self `--ro-bind` of the file over itself keeps it read-only inside — verified: writes inside hit EROFS, host truncate-writes stay live); restores the base byte-exact at teardown; re-appends within one poll tick after any rename | **yes** | carries the section while the session runs; skip-worktree already hides it from git | ro-inside lapses until restart after a rename (content stays correct); crash leftovers self-heal on next start (strip is exact-suffix/prefix, never eats user text) |
| d | warn-only: detect the source inode changing, log that the template is lost until restart | detection only | untouched | ~20 lines; honest; live instruction editing silently stops working for VS Code/vim/git saves |
| e | FUSE passthrough view of the project dir with `AGENTS.md` synthesised | yes | untouched | needs `/dev/fuse` and a FUSE daemon inside the sandbox; parked as heavyweight for one file |
| f | project under `--tmp-overlay`, staged file ro-bound on top | **yes** (measured — the overlay dentry absorbs host renames) | untouched | **but sandbox writes land on a throwaway tmpfs and vanish at exit** (measured); durable upper ⇒ teardown sync engine; breaks direct mode and `commitAllChanges` |

Option (c) is the only one that actually delivers the feature's promise —
"the moment you most want to correct an agent's instructions is while it is
working" — under normal editors. Its cost is the one invariant change: while
a session runs, the repository copy contains the injected section (masked
from git, removed on exit), the same trade `ensureOverlaySources` already
makes in miniature by creating a missing `AGENTS.md` on the host.

## Resolution (2.7.0)

Option **(d), warn-only**. The watcher now records the `dev:ino` of each
overlay's source at session start — the file the bind was grafted onto — and
the moment the path names a different file (or none), logs once that scoder's
instructions are gone from inside the sandbox until the session restarts; the
"updated in the sandbox" message is suppressed thereafter, because after a
detach it is no longer true. Rendering continues in both cases: the staged
file is the restart's starting point, and one small read per tick is cheap.
Covered by `overlay-warns-when-a-host-save-detaches-the-bind`, the
mid-session-rename regression test this issue called for.

The reasoning for declining (c) despite it actually fixing the feature: it
would put scoder's section inside the user's repository file for the whole
session. Masked by skip-worktree, still a mutation of the project the user
sees in `cat`, in backups, in `git stash` — and the mask itself has open
issues. The warning is the honest floor: the live-editing promise holds for
in-place writers, and rename-saving editors are told, precisely and once,
where they stand. If the warning turns out to bite often in practice, (c) is
fully specified above and can be revisited.

The reported session that started as root is a separate matter
([agents-md-empty-file-created-as-root](/design/implementation/issues/agents-md-empty-file-created-as-root.md)).

## Related

[HAS_FEATURE](/design/features/live-file-overlays.md)
[HAS_FEATURE](/design/features/agents-md-overlay.md)
[IMPACTS](/src/sandbox/overlays.ts)
[IMPACTS](/src/git/protection.ts)

Same family, previously observed: the eclipse preset's note that a bind
applied later at an ancestor path hides one already mounted beneath it
(design/implementation/plans/eclipse-preset.md). The skip-worktree mask's own
issues: [skip-worktree-mask-is-not-session-scoped](/design/implementation/issues/skip-worktree-mask-is-not-session-scoped.md),
[skip-worktree-not-restored-on-exit](/design/implementation/issues/skip-worktree-not-restored-on-exit.md).

## Appendix: the original proposal, verbatim

> Can we make it even simpler?
> If you don't want to deal with a hidden tmpfs directory and symlinks, you can mount the staging directory directly into the sandbox root as a read-only folder, and then symlink to that:
>
> ```bash
> bwrap \
>   --bind /path/to/host/project /sandbox/project \
>   --ro-bind /path/to/staging_dir /staging \
>   --symlink /staging/AGENTS.md /sandbox/project/AGENTS.md \
>   --chdir /sandbox/project \
>   /bin/bash
> ```
>
> this avoids creating a tmpfs, safely exposes the staging files at /staging inside the sandbox, and keeps your project folder fully writeable back to the host.
>
> Now in this pattern if I update the staging copy of AGENTS.md I can expect the sandbox copy to change. If I update the host project AGENTS.md there will be no change? correct?
>
> Yes, that is absolutely correct.
> By setting up the sandbox this way, you have successfully inverted the visibility rules for that specific file. Here is exactly how changes will behave while the sandbox is running:
>
> 1. If you update the staging copy on the host:
>    • Result: The sandbox copy will update dynamically.
>    • Why: The symlink inside the sandbox points to /staging/AGENTS.md. Because /staging is a bind mount of the entire directory, any atomic saves, deletes, or modifications you make to the staging files on the host are completely captured by the directory boundary. The sandbox will always see the latest version.
> 2. If you update the project copy on the host:
>    • Result: There will be no change inside the sandbox.
>    • Why: The real AGENTS.md file in your host project directory is completely hidden (masked) inside the sandbox by the symlink. The applications running inside your sandbox don't even know the original project file exists.
>
> One Important Caveat to Keep in Mind
> If an application inside the sandbox attempts to write to /sandbox/project/AGENTS.md, it will follow the symlink and attempt to write to /staging/AGENTS.md. Because you mounted /staging using --ro-bind, the write operation will fail with a Read-only file system error. This guarantees that your staging files remain completely safe from accidental modifications by the sandboxed process.
