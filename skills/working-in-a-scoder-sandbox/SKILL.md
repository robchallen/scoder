---
name: working-in-a-scoder-sandbox
description: 'Use when the current git branch matches `scoder/*`, when `$SCODER_SANDBOX` is `1`, or when the user says you are in a scoder sandbox or scoder worktree (including `--no-worktree` mode). Also use if you hit an unexpected read-only filesystem error, a broken symlink, or a missing command on a machine that should have it — these are the practical signs of a scoder sandbox now that paths inside it look identical to a normal checkout. Do NOT use for generic Git advice outside scoder or for unrelated sandbox/container environments.'
license: MIT
allowed-tools: Read Bash Grep Glob
---

# Working in a scoder sandbox

scoder sandboxes are permissive by design: they protect against accidents,
not deliberate misuse, and keep a separation between what the agent sees and
what the user sees. This skill covers the behaviour that actually trips
agents up — detection, what's read-only, what to do when something is
missing, and how visibility/commits work — not a full description of scoder
(see the project's own `README.md`/`AGENTS.md` for that, if present).

## Detecting the sandbox

1. If `AGENTS.md` exists it also carries a live, per-session "you are in a
   scoder sandbox" notice injected at the top — if you see that, believe it.
2. `echo $SCODER_SANDBOX` — `1` means you are definitely inside a sandbox.
   This is the only reliable, cheap signal.
3. **Unexpected hard filesystem errors** are often the first real sign when
   1 and 2 are inconclusive (e.g. a sub-process cleared the env): a
   read-only-filesystem error writing somewhere that should be writable, a
   broken symlink pointing outside the project, or a command that "should"
   exist but isn't found. Don't assume the whole checkout is broken —
   suspect the sandbox first and re-check `$SCODER_SANDBOX`.

## What's read-only

- **System paths**: `/usr`, `/bin`, `/lib`, `/etc`, `/opt`, `/sys`, `/run` —
  always read-only. Installing or modifying anything here will fail.
- **Protected project files**: `.github/`, `.gitignore`, lockfiles,
  `.agentreadonly` itself, and anything else `.agentreadonly` lists, are
  read-only even though the rest of the project tree is writable. A repo
  can relax this (an empty `.agentreadonly` removes the defaults) but you
  can't relax it yourself from inside the sandbox.
- **`AGENTS.md`**: always read-only inside the sandbox (overlaid with the
  sandbox notice). Don't try to edit it — ask the user instead.
- **`.agentports`**: read-only. If you need a localhost port opened (e.g. a
  local LLM/MCP server), ask the user to add it to `.agentports` or restart
  scoder — you cannot add it yourself.
- **Most of `$HOME`**: only specific things are actually populated — the
  project itself, a curated set of tool configs (git, cargo/rustup, mise, R,
  Maven `.m2`, npm/pypi rc files), and whatever `.agentreadonly` explicitly
  adds. Everything else under `$HOME` that exists on the real host may
  simply not be there. An `.agentreadwrite` file, if the project has one,
  additionally opens specific `$HOME/...` directories read-write (a
  persistent cache or output location) — you can't add entries to it
  yourself, same as `.agentreadonly`.

## If a tool or dependency is missing

**Ask the user to install it — don't try to work around it yourself.**
Only a fixed, curated list of host tools/configs is bound into the sandbox;
anything outside that list (a package manager not in the list, a system
package, a global install) isn't there and can't be installed durably from
inside: system paths are read-only, and most of `$HOME` is a fresh,
per-session filesystem that discards anything you install into an
unbound location the moment the session ends. A `pip install --user` or
`npm install -g` that "succeeds" now may silently vanish next session.

Tell the user what's missing and ask them to install it on the host (or add
its directory via `.agentreadonly` if it already lives under their `$HOME`)
rather than spending effort installing it inside the sandbox.

## Networking

- Outbound internet works normally (DNS, API calls).
- Host loopback (`127.0.0.1`) is blocked by default. Only ports listed in
  `.agentports` are reachable — see above if you need one added.

## Worktree vs. direct mode

- **Direct mode (`--no-worktree`, default)**: you're in the user's actual checkout.
  Changes are immediate, no commit needed — but also no isolation, and no
  "undo" via worktree removal.
- **Worktree mode (`--worktree`)**: your working directory is a git
  worktree, not the user's real checkout — it lives under
  `$HOME/<parent-of-repo>/worktrees/<repo-path>/scoder`, on branch
  `scoder/<repo-name>`, started from whatever `HEAD` the user launched from
  (not necessarily `main`). Uncommitted edits are invisible to the user's own checkout
  and to `git log`/`git diff` run elsewhere — commit at meaningful
  checkpoints, not just at the end, so progress isn't lost or invisible.

- To pick up upstream changes, use `git fetch origin` then
  `git rebase origin/main` or `git merge origin/main` explicitly — don't
  rely on `git pull`, since the sandbox branch has no upstream configured
  for that. If a rebase/merge conflicts on a file `.agentreadonly` protects,
  you can't resolve it yourself (the sandbox copy is read-only) — tell the
  user.

## Troubleshooting

**Write failed with a read-only error** — check first whether the path is
one of the categories above (system path, `.agentreadonly`-protected,
`AGENTS.md`, `.agentports`) before assuming the whole worktree is broken.
Running a `mount` command will give you detailed info about what is and what is
not bound, and what is read only.

**A symlink outside the project is broken** — its target almost certainly
isn't bound into the sandbox. Common case: a skill/config directory
symlinked from somewhere not in the curated tool list. Ask the user to add
it via `.agentreadonly`, or for them to install/relocate it into a location that is
already bound.

**A command isn't found, or a tool behaves as if unconfigured** — see "If a
tool or dependency is missing" above.

**You need a localhost service reachable** — see "Networking" above; the
user has to add the port to `.agentports`, you can't.
