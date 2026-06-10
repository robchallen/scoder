# scoder v2.1.1 — Evolutionary Design Migration

## Summary

A baseline migration to the continuous evolutionary design framework for the
scoder project, together with documentation consolidation and a bug fix for
worktree recovery after system reboot.

## Bug Fixes

- **Worktree recovery after reboot**: Stale worktree references in `/tmp/scoder/`
  (caused by `/tmp` being cleared on reboot) are now detected, pruned via
  `git worktree prune`, and recreated from the existing branch. Previously,
  scoder would mount an empty directory created by `Bun.write()` side effects,
  giving the agent an empty codebase.

- **Missing uncommitted changes warning documented**: `hasUncommittedChanges` in
  `src/git/worktree.ts` was imported but never called, so scoder would silently
  start a worktree session without warning about host-local uncommitted changes
  that the agent would not see. Documented as a known issue in
  `design/implementation/issues/`.

## Default Behaviour Change

- **Direct mode is now the default**: `scoder` runs in direct mode
  (`--no-worktree`) unless `-w` / `--worktree` is explicitly passed. Use
  worktree mode when you want isolated changes on a separate branch.

## Evolutionary Design Migration

The project now follows the continuous evolutionary design framework. This
baseline establishes:

### Design Documentation

- `design/SCOPE.md` — project scope with 12 implemented features and 7 planned features
- `design/features/` — 12 feature documents with `IMPLEMENTED_BY` links to source code
- `design/test-scripts/validation-suite.md` — all 20 validation tests documented with `TESTED_BY` links
- `design/implementation/issues/` — 1 known issue (uncommitted changes warning)
- `design/implementation/debt/` — 7 technical debt records from DESIGN.md
- `design/legacy/` — archived pre-migration docs (DESIGN.md, ROADMAP.md, TEST_SCRIPTS.md, ISSUES.md)

### Architecture Documentation

- `architecture/FRAMEWORK.md` — module map, execution flow, design decisions
- `architecture/STANDARDS.md` — naming, error handling, testing conventions

### Tooling

- `em` script — unified interface for `setup`, `test`, `check`, `doc`, `design`, `bump`, `run`
- `graphify` knowledge graph baseline (534 nodes, 711 edges, 43 communities)
- `.repomixignore` and `.graphifyignore` for code graph and repomix exclusions

### Production Code Links

Anchor comments added to all key functions across `src/sandbox/builder.ts`,
`src/git/worktree.ts`, `src/git/protection.ts`, `src/tools/presets.ts`,
`src/cli/apparmor.ts`, and `tests/validate.ts` with `IMPLEMENTS` and `TESTS`
links to design documents.

### Design Quality

- 0 broken links in design documentation
- 0 incorrect link types
- `em test` passes all 20 validation tests
- `em design` runs clean validation

## Files Changed

- 62 new files in `design/`, `architecture/`, `skills/`, `graphify-out/`
- `src/git/worktree.ts` — reboot recovery and `createWorktree` branching logic
- `src/cli/parse-args.ts` — default worktree flag to false
- `src/sandbox/builder.ts`, `src/git/protection.ts`, `src/tools/presets.ts`, `src/cli/apparmor.ts` — anchor comments
- `tests/validate.ts` — new `testWorktreeRecreatedIfMissing` test, explicit `-w` flags
- `AGENTS.md` — slimmed from 342 to 98 lines, links to architecture docs
- Legacy files moved to `design/legacy/`
