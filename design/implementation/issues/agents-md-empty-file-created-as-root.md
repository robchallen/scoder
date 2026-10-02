---
target-version: 2.7.0
status: open
tags: [issue, sandbox, agents-md, overlay, permissions]
---

# scoder-Created AGENTS.md Land Root-Owned in the User's Project

## Summary

In a project without an `AGENTS.md`, scoder creates one empty file (see
`ensureOverlaySources`, and "When the host file does not exist" in
`live-file-overlays`). Reported 2026-10-02: on the user's desktop the created
file needed `sudo` to edit — i.e. it was owned by root, not by the user.

The owner does **not** believe the session in question ran as root and is
investigating; nothing here is fixed yet, and no root-guard has been added
deliberately. This doc records what has been reproduced, so the desktop
investigation starts from evidence rather than guesses.

## Reproduced: a session launched as root leaves a root-owned file

Reproduced exactly in a container:

```
$ git init demo && cd demo && ... && git commit -m init   # no AGENTS.md
$ sudo scoder -q --no-worktree /bin/true
$ stat -c "%a %U %s" AGENTS.md
644 root 0
```

Why it goes unnoticed while running: `identity.ts` resolves the sandbox uid
as `SUDO_UID || getuid()`, so the sandbox itself behaves as the ordinary user
— the file ownership is the *only* visible trace. And scoder's own setup
messages ("run `sudo scoder --install-dependencies`") normalise running it
under sudo, which is how such a session plausibly happens.

Note `ensureOverlaySources` cannot be the culprit in a *non-root* session:
it is an ordinary `Bun.write` from the scoder process, so the file carries
the session's uid (verified: `644 agent` in a user-run container session).

## Secondary suspect: bwrap's own mountpoint on setuid builds

If `ensureOverlaySources`'s write fails — project directory not writable by
the session's user (e.g. left over from an earlier root run), or the file
missing at bwrap time for any other reason — bwrap creates the mountpoint
itself. That is how the read-only-`.Rprofile` incident happened, which
`ensureOverlaySources` was written to prevent; the *mode* fix is verified, but
the *owner* depends on how bwrap was built. On Ubuntu 24.04 (and other
AppArmor-transition distros) `/usr/bin/bwrap` ships **setuid root**, so its
mountpoint would land `root:root 0444` — matching "needed sudo to edit"
without the session itself being root. The container used for the repros here
has a non-setuid bwrap, so this variant could not be reproduced locally.

## Investigation notes for the desktop

- `stat -c "%U %G %a" AGENTS.md` next time it happens, and whether scoder
  logged `Created empty ... for the sandbox overlay` (it always logs when
  `ensureOverlaySources` writes the file — a silent root file points at the
  bwrap-mountpath, not at scoder's write).
- `ls -l $(command -v bwrap)` — a setuid bit makes suspect two live.
- `id -u` of the launching shell / any wrapper or IDE task that starts scoder.
- A candidate guard if it proves real: refuse session launches when
  `getuid() === 0` with a pointer to the two sudo subcommands
  (`--configure-apparmor`, `--install-dependencies`), and/or `chown` created
  files to `SUDO_UID` when running under sudo. Deliberately not implemented
  until the cause is confirmed.

## Related

[HAS_FEATURE](/design/features/live-file-overlays.md)
[IMPACTS](/src/sandbox/overlays.ts)
[IMPACTS](/src/sandbox/identity.ts)

The live-overlay presentation bug reported alongside this one:
[agents-md-does-not-update-as-expected](/design/implementation/issues/agents-md-does-not-update-as-expected.md).
