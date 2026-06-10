---
target-version: 2.1.0
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
- **git** — worktree creation and branch management
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
│   └── protection.ts     # .agentreadonly parsing, AGENTS.md overlay, ~/.agents snapshot
├── tools/
│   └── presets.ts        # Per-tool config binds and validation for opencode/claude/copilot/pi
├── sandbox/
│   └── builder.ts        # bwrap command construction: system mounts, binds, env vars, pasta
└── utils/
    ├── logger.ts          # Coloured output: info, infoBlue, warning, error
    └── checks.ts          # System checks: bwrap userns, command existence, port detection

tests/
└── validate.ts           # Integration test suite (20 tests as of v2.1.0)
```

## Execution Flow

1. **Parse** CLI args into `ScoderOptions`
2. **Early validation** — bwrap exists, userns works (AppArmor diagnostic if it fails)
3. **Special modes** — `--configure-apparmor`, `--install-dependencies` exit early
4. **Tool selection** — resolve preset, validate tool exists, get config binds
5. **If worktree mode:**
   - Create/reuse/prune git worktree at `/tmp/scoder/<project-path>`
   - Check for stale worktree directories (reboot recovery)
6. **Infrastructure protection:**
   - Parse `.agentreadonly` for protected paths and `$HOME/` binds
   - Create AGENTS.md overlay with sandbox notice
   - Snapshot `~/.agents` to `/tmp` with symlink resolution
   - Snapshot non-loopback `/etc/resolv.conf`
7. **Build bwrap command:**
   - System mounts (ro-bind: /usr, /bin, /lib, /etc, /sys, /run)
   - Device, proc, tmpfs mounts
   - HOME as ephemeral tmpfs with selective config/data binds
   - Worktree or cwd bind
   - Protection overlays (ro-bind over rw bind)
   - Environment variables (clearenv + selective setenv)
   - pasta network layer
8. **Execute** — `bwrap ... pasta ... <tool> <args>`
9. **On exit:**
   - Commit changes in worktree mode
   - Print session summary (commits, diffstat, branch info)
   - Cleanup temp files

## Design Decisions

[HAS_FEATURE](../design/features/path-mirroring.md)
[HAS_FEATURE](../design/features/sandbox-isolation.md)
[HAS_FEATURE](../design/features/network-isolation.md)
[HAS_FEATURE](../design/features/git-worktree-isolation.md)
