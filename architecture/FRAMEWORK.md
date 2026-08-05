---
target-version: 2.2.0
status: draft
tags: [architecture, framework]
---

# scoder Technical Architecture

## Language and Runtime

- **Language:** TypeScript (strict mode)
- **Runtime:** Bun v1.3+ with native TypeScript execution (no transpilation)
- **Binary:** Single-file executable via `bun build`
- **Module resolution:** Bundler

## Architecture Style

Modular pipeline architecture. Each phase is a pure function composition that
builds the bwrap command line incrementally. No classes, no dependency
injection: plain async functions with explicit parameter passing.

## System Dependencies

- **bwrap** — bubblewrap for unprivileged filesystem namespacing
- **pasta** — userspace networking for outbound connectivity with loopback isolation
- **git** — worktree creation, branch management, and index manipulation
- **sudo** — one-time AppArmor profile installation only

## Module Map

```
src/
├── index.ts              # Main orchestration: parse → validate → setup → build → execute
├── types.ts              # All TypeScript interfaces: ScoderOptions, ToolPreset, GitWorktreeInfo, BindMount
├── cli/
│   ├── parse-args.ts     # CLI option parsing, USAGE text, port validation
│   └── apparmor.ts       # AppArmor profile generation and installation
├── git/
│   ├── worktree.ts       # Git worktree lifecycle: create, reuse, prune, commit, diffstat
│   └── protection.ts     # .agentreadonly parsing, AGENTS.md overlay, skip-worktree masking, snapshots, scratch symlink
├── tools/
│   └── presets.ts        # Per-tool config binds and validation for opencode/claude/copilot/pi
├── sandbox/
│   ├── builder.ts        # bwrap command construction: system mounts, binds, env vars, pasta
│   ├── identity.ts       # passwd/group overlay so getpwuid() resolves to /home/scoder
│   ├── launch.ts         # two-stage launch: bwrap blocks, pasta attaches, tool releases
│   ├── pasta.ts          # network sidecar: attach to the sandbox netns, teardown
│   └── ssh.ts            # --allow-ssh: ControlMaster tunnel sidecar, opened and torn down outside the sandbox
└── utils/
    ├── logger.ts          # Coloured output: info, infoBlue, warning, error
    ├── checks.ts          # System checks: bwrap userns, command existence, port detection
    └── paths.ts           # Host ↔ sandbox path translation (home remapping)

tests/
└── scoder.test.ts        # Integration test suite (33 tests as of v2.2.0)
```

## Execution Flow

1. **Parse** CLI args into `ScoderOptions`
2. **Nesting checks** — refuse if cwd is a linked git worktree (`.git` is a file), or if `SCODER_SANDBOX=1` and worktree mode was requested
3. **Early validation** — bwrap exists, pasta exists, userns works (AppArmor diagnostic if it fails)
4. **LLM port detection** — probe `127.0.0.1:11434` (or `SCODER_LLM_PORT`) unless `--llm-port` was given
5. **Special modes** — `--configure-apparmor`, `--install-dependencies` exit early
6. **Tool selection** — resolve preset, validate tool exists, get config binds, translate the host tool path into the sandbox namespace
7. **If worktree mode:**
   - Create/reuse/prune git worktree at `/tmp/scoder/<project-path>`
   - Check for stale worktree directories (reboot recovery)
8. **Infrastructure protection:**
   - Parse `.agentreadonly` for protected paths and `$HOME/` binds
   - Create AGENTS.md overlay with sandbox notice
   - Snapshot `~/.agents` to `/tmp` with symlink resolution
   - Snapshot `~/.local/bin` to `/tmp`, resolving symlinks that point outside the sandbox
   - Snapshot non-loopback `/etc/resolv.conf`
9. **Git masking:**
   - Mark `AGENTS.md` as `--skip-worktree` via `git update-index`
   - This prevents the overlay from appearing as a dirty tree inside the sandbox
10. **Build bwrap command:**
   - System mounts (ro-bind: /usr, /bin, /lib, /etc, /sys, /run)
   - Device, proc, tmpfs mounts
   - HOME as ephemeral tmpfs with selective config/data binds
   - Worktree or cwd bind
   - Protection overlays (ro-bind over rw bind)
   - Environment variables (clearenv + selective setenv)
   - pasta network layer
11. **Pre-flight the exec target** — a `$HOME`-installed tool whose directory is not among the command's bind destinations cannot run; fail with a diagnostic rather than a bare `execvp` error
12. **Execute** — `bwrap ... pasta ... <tool> <args>`
13. **On exit:**
    - Commit changes in worktree mode
    - Print session summary (commits, diffstat, branch info)
    - Remove `--skip-worktree` from AGENTS.md
    - Cleanup temp files

## Design Decisions

[HAS_FEATURE](../design/features/path-mirroring.md)
[HAS_FEATURE](../design/features/sandbox-isolation.md)
[HAS_FEATURE](../design/features/network-isolation.md)
[HAS_FEATURE](../design/features/git-worktree-isolation.md)
[HAS_FEATURE](../design/features/direct-mode.md)
[HAS_FEATURE](../design/features/nested-sandbox-detection.md)
[HAS_FEATURE](../design/features/local-bin-resolution.md)
[HAS_FEATURE](../design/features/ssh-tunnel-access.md)
[HAS_FEATURE](../design/features/persistent-scratch.md)
