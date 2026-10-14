---
target-version: 3.0.0
status: draft
tags: [architecture, framework]
---

# scoder Technical Architecture

The user-level overview of how a session is put together is in
[DEVELOP.md](../DEVELOP.md#architecture); this document is the code-level
map.

## Language and Runtime

- **Language:** TypeScript (strict mode)
- **Runtime:** Bun v1.3+ with native TypeScript execution (no transpilation)
- **Binary:** Single-file executable via `bun build --compile`; text assets
  (`entrypoint.sh`, the skills, the shipped baseline and recipes) are
  embedded with `with { type: "text" }` imports, declared for `tsc` in
  `src/text-modules.d.ts`
- **Module resolution:** Bundler

## Architecture Style

Modular pipeline architecture. Each phase is a pure function composition that
builds the bwrap command line incrementally. No classes, no dependency
injection: plain async functions with explicit parameter passing. Anything
scoder synthesises for the sandbox is staged under one session root,
`/tmp/scoder-<id>/`, at a path mirroring its bind destination
(`src/utils/session.ts`).

## System Dependencies

- **bwrap** — bubblewrap for unprivileged filesystem namespacing (two
  layers: an outer one for a fresh `/dev`, the inner sandbox)
- **pasta** — userspace networking for outbound connectivity with loopback isolation
- **git** — worktree creation, branch management, and index manipulation
- **xpra** (≥ 6.5.5) — GUI presets: a server in the sandbox, a client on the host
- **ssh** — only for `--allow-ssh`
- **sudo** — one-time setup only (`--configure-apparmor`, `--install-dependencies`)

## Module Map

```
src/
├── index.ts              # Main orchestration: parse → check → configure decision → config → presets → stage → build → launch → review/relaunch
├── types.ts              # Interfaces: ScoderOptions, ToolPreset, GitWorktreeInfo, BindMount, ...
├── skills.ts             # scoder's own skills (skills/*/SKILL.md), embedded
├── recipes.ts            # The starter recipes (src/defaults/recipes/*.md), embedded
├── text-modules.d.ts     # tsc declarations for the text imports
├── cli/
│   ├── parse-args.ts     # CLI option parsing, USAGE text, VERSION
│   ├── apparmor.ts       # --configure-apparmor: AppArmor profile for bwrap
│   └── dependencies.ts   # --install-dependencies: bubblewrap, passt, xpra (with the version floor)
├── configure/
│   └── configure.ts      # --configure: key files, working copies (.sandbox/, baseline, recipes), host-side review, validation, apply/backup, relaunch
├── git/
│   ├── sandbox-config.ts # .sandbox/ layout and legacy migration; the user baseline (~/.config/scoder/sandbox) and recipes dirs, seeding; readConfigText (baseline + project)
│   ├── protection.ts     # .sandbox/readonly (protected paths, $HOME grants, ~/.local/bin grants), readwrite, ports, env; AGENTS.md overlay; ~/.local/bin snapshot; resolv.conf snapshot
│   └── worktree.ts       # Git worktree lifecycle: create, reuse, relocate, prune, commit, diffstat
├── tools/
│   ├── presets.ts        # Per-tool binds, env, validation, initial-prompt args: agents (opencode, claude, copilot, pi) and GUI presets (rstudio, eclipse, vscode, vscodium, positron, webstorm, jupyterlab)
│   └── new-workspace.ts  # --new-workspace: reset a preset's managed per-project state
├── sandbox/
│   ├── builder.ts        # bwrap command construction: the two layers, system mounts, home binds, env, the --ide/xpra entry point
│   ├── entrypoint.sh     # In-sandbox entry point: --ide background/foreground, xpra server, private session bus
│   ├── launch.ts         # Two-stage launch (bwrap blocks, pasta attaches, tool released); signal forwarding; watchers for .sandbox/ports and resolv.conf
│   ├── pasta.ts          # Network sidecar: attach to the sandbox netns, teardown
│   ├── xpra.ts           # xpra display sidecar: host-side client, socket paths
│   ├── ssh.ts            # --allow-ssh: ControlMaster tunnel sidecar outside the sandbox
│   ├── overlays.ts       # Live file overlays (AGENTS.md note, .Rprofile hook): host file + sandbox-only content, kept in step
│   ├── skills.ts         # Agent skills: discovery, .sandbox/skills selection, staging at the agent's skills dir, hiding its other dirs, live watcher, the "skills on this machine" list
│   ├── browser.ts        # SCODER_BROWSER: the in-sandbox browser and mimeapps.list
│   └── identity.ts       # passwd/group overlay so getpwuid() resolves to the real user/home
├── defaults/
│   ├── sandbox/          # Shipped baseline: env, readonly, readwrite, ports, skills
│   └── recipes/          # Starter recipes
└── utils/
    ├── logger.ts         # Coloured output: info, infoBlue, warning, error
    ├── checks.ts         # System checks: bwrap userns (nested self-test), command existence, local LLM port probes (11434, 11435)
    ├── paths.ts          # Host ↔ sandbox path translation (home spelling canonicalization)
    ├── session.ts        # The per-run session root /tmp/scoder-<id>: stageDir/stageFile, cleanup on exit
    ├── process.ts        # Process-liveness helpers for the sidecars
    └── xpra-version.ts   # xpra version floor checks

skills/                   # The two skills injected into every session
tests/
├── scoder.test.ts        # Integration test suite (199 tests as of v3.0.0; see design/test-scripts/validation-suite.md)
└── helpers/
    ├── pty-signal-harness.py  # Real-PTY driver for terminal-signal-forwarding tests (Bun/Node have no first-party PTY allocation)
    └── signal-diagnostic.py   # Fixture: registers signal handlers, logs each one received
```

## Execution Flow

1. **Parse** CLI args into `ScoderOptions`.
2. **Nesting checks** — refuse in a linked git worktree (`.git` is a file),
   or with `SCODER_SANDBOX=1` in worktree mode.
3. **Special modes** — `--install-dependencies` and `--configure-apparmor`
   exit early (`--help` and `--version` already did, in parsing).
4. **Early validation** — user namespaces work under bwrap (a nested
   self-test, with the AppArmor diagnostic if not); pasta exists.
5. **Tool preset** — resolve the tool's preset.
6. **Configure decision** — `--configure`, or an interactive start with a
   key file (`env`, `readonly`, `readwrite`, `ports`, `skills`) missing
   from `.sandbox/`. A configure session forces direct mode and adds the
   preset's initial prompt. Otherwise, a project whose config has no
   `.sandbox/version` gets a start-up message.
7. **Binds and environment** — the preset's binds, dirs and env; the same
   for `--ide` and each `--bind` preset, merged and deduplicated;
   `SCODER_CONFIGURE=1` in a configure session.
8. **Worktree or direct** — worktree mode refuses uncommitted changes and
   creates, reuses or relocates the worktree at
   `$HOME/<dirname(projDir)>/worktrees/<basename(projDir)>/scoder`;
   direct mode refuses to run outside a git repository.
9. **Configuration** — migrate legacy dotfiles; seed the user baseline and
   recipes (not under `--dry-run`). Every `.sandbox/` file is read as the
   baseline's lines followed by the project's (`readConfigText`).
10. **Protection and staging:**
   - `.sandbox/readonly`: protected project paths, `$HOME/...` read-only
     binds (absent ones skipped), `~/.local/bin` grants
   - AGENTS.md overlay with the sandbox note (and the configure note)
   - Skills: discover, select, stage, bind at the agent's skills dir, hide
     its other dirs; start the skills watcher
   - `~/.local/bin` snapshot of granted entries (plus the session's own
     tool), resolving symlinks into bound paths; the real directory,
     read-only, in a configure session
   - `/etc/resolv.conf`, passwd/group
   - `.sandbox/` bound read-only (a writable working copy in a configure
     session, with the baseline and recipes working copies too)
   - `.sandbox/readwrite` binds; local LLM port probe appends to
     `.sandbox/ports`
11. **Git masking** — mark `AGENTS.md` `--skip-worktree` so the overlay is
    not a dirty tree inside the sandbox.
12. **Build the bwrap command** — the outer `/dev` layer; system mounts
    (read-only `/usr`, `/bin`, `/lib`, `/etc`, `/sys`, `/opt`, and
    update-alternatives' `/var/lib` state), tmpfs `/tmp`, `/home`, `/run`;
    the always-bound home paths; the project bind; preset binds;
    protection and staged binds (`safeBinds`, after the preset binds they
    may sit inside); `--clearenv` plus the passthrough list and scoder's own
    variables; the entry point for `--ide` / xpra.
13. **Pre-flight the exec targets** — a `$HOME`-installed tool (or `--ide`
    companion) not under any bind destination fails with a diagnostic
    rather than a bare `execvp` error.
14. **Launch** — bwrap creates the namespaces and blocks; pasta attaches to
    the netns; the tool is released. scoder forwards
    SIGWINCH/SIGINT/SIGQUIT/SIGTSTP into the sandbox (`--new-session`
    detaches it from the terminal), and polls `.sandbox/ports` (re-attaching
    pasta, falling back to the last good list), `resolv.conf`, overlay
    sources and the skills files.
15. **On exit:**
    - Worktree mode: commit changes, print the session summary
    - Configure session: summarise changes, validate, ask; on yes, back up
      and apply the baseline and recipes, apply `.sandbox/` (stubbing key
      files, writing `.sandbox/version`), and re-run the original command
      without `--configure`
    - Remove `--skip-worktree` from AGENTS.md, stop sidecars, reset the
      terminal, remove the session root

## Design Decisions

Feature documents are indexed in [design/SCOPE.md](../design/SCOPE.md);
architectural decisions are in [decision-records/](./decision-records/).

[HAS_FEATURE](../design/features/path-mirroring.md)
[HAS_FEATURE](../design/features/sandbox-isolation.md)
[HAS_FEATURE](../design/features/network-isolation.md)
[HAS_FEATURE](../design/features/git-worktree-isolation.md)
[HAS_FEATURE](../design/features/direct-mode.md)
[HAS_FEATURE](../design/features/nested-sandbox-detection.md)
[HAS_FEATURE](../design/features/local-bin-resolution.md)
[HAS_FEATURE](../design/features/ssh-tunnel-access.md)
[HAS_FEATURE](../design/features/agent-readwrite.md)
[HAS_FEATURE](../design/features/ide-companion.md)
[HAS_FEATURE](../design/features/configure-mode.md)
[HAS_FEATURE](../design/features/config-defaults.md)
[HAS_FEATURE](../design/features/agents-skills-snapshot.md)
[HAS_FEATURE](../design/features/session-temp-root.md)
[HAS_FEATURE](../design/features/xpra-gui-isolation.md)
[HAS_FEATURE](../design/features/live-file-overlays.md)
