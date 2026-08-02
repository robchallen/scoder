# scoder v2.2.0 — Test Suite Rebuild, Local Bin Resolution, Nesting Guards

## Summary

The validation suite is reimplemented on Bun's test runner, `~/.local/bin` now
resolves correctly inside the sandbox, a local LLM endpoint is detected without
being asked for, and scoder refuses to nest itself. Documentation across
`README.md`, `design/` and `architecture/` has been brought back in line with
the code.

## New Features

- **Local bin symlink resolution**: `~/.local/bin` is snapshotted to `/tmp` at
  startup instead of being bind-mounted raw. A symlink whose target is bound
  into the sandbox is kept as a symlink with its target rewritten into the
  sandbox namespace; a symlink whose target is unreachable has the target binary
  copied in; regular files are copied with their exec bits. Previously a symlink
  to a host path (e.g. `~/.cargo/bin/cargo`) dangled inside the sandbox and the
  tool failed silently. `setupLocalBinSnapshot` in `src/git/protection.ts`.

- **LLM port auto-detection**: scoder probes `127.0.0.1:11434` (the Ollama
  default) at startup and, if something is listening, forwards that one port
  into the sandbox without needing `--llm-port`. Override the probed port with
  `SCODER_LLM_PORT`; `--llm-port` still takes precedence and disables the probe.
  `detectDefaultLlmPort` in `src/utils/checks.ts`.

- **Nested sandbox detection**: scoder now refuses to start when it would nest.
  In worktree mode it exits if the current directory is a linked git worktree
  (`.git` is a file containing `gitdir:`), or if `SCODER_SANDBOX=1` is set. Direct
  mode is permitted in both cases, since it creates no worktree and so has
  nothing to nest. Documented as
  `design/features/nested-sandbox-detection.md`; retires the
  `no-nested-sandbox-detection` debt record.

- **`gh` config available to every tool**: `~/.config/gh` is bound read-only for
  all sandboxes via `buildExtraBinds`, not just the `copilot` preset, so any
  tool can use an authenticated `gh`. The copilot preset no longer warns about
  a missing `gh` config.

- **Diagnostic for unreachable tools**: a tool under `$HOME` in a directory that
  is not bound into the sandbox cannot work at all. scoder now detects this
  before launch — by checking the translated path against the bind destinations
  of the built bwrap command — and exits with the offending path and a suggested
  fix, instead of leaving pasta to emit a bare `execvp` error. In `--dry-run`
  this is a warning, so the command can still be inspected.

- **Size ceiling on snapshot copies**: an unresolvable `~/.local/bin` symlink
  target above 64 MB is no longer copied into the snapshot; a sandbox-mapped
  symlink is written and the entry logged as unresolved. Claude Code's binary is
  ~275 MB, and copying it on every launch of an unrelated tool is not a
  reasonable startup cost. Tools that large want a preset bind instead.

- **More passed-through credentials**: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
  `GITHUB_TOKEN`, and web-search keys `BRAVE_SEARCH_API_KEY`,
  `TAVILY_API_KEY`, `SERPER_API_KEY`, `EXA_API_KEY`, `YOUCOM_API_KEY`,
  `JINA_API_KEY`, `FIRECRAWL_API_KEY`, `PERPLEXITY_API_KEY` are added to the
  `--clearenv` allowlist.

## Bug Fixes

- **Tools installed under `$HOME` now launch** (`execvp: No such file or
  directory`): `which` resolves the tool on the host, but the sandbox replaces
  `/home` with a tmpfs containing only `/home/scoder`, so a host path such as
  `~/.local/bin/claude` does not exist inside it. The exec target is now
  translated into the sandbox namespace before launch. This broke every tool
  installed under the home directory — including Claude Code's native installer,
  the non-npm install path — while system-path tools were unaffected, since
  `/usr` and `/bin` are mirrored read-only at their real paths.
  `toSandboxPath` in the new `src/utils/paths.ts`.

- **`~/.local/bin` snapshot symlinks pointed at host paths**: symlink targets
  were written with their host spelling, so an entry the resolver had classified
  as `Symlink OK` still dangled inside the sandbox. Absolute targets are now
  rewritten into the sandbox namespace; relative targets are left alone, since
  they already resolve within the snapshot.

- **The resolvability check trusted paths that were not bound**:
  `SANDBOX_MOUNT_PREFIXES` listed the parent `/home/scoder/.local`, but the
  sandbox only creates that as an empty tmpfs directory and binds specific
  subdirectories. Anything under `~/.local/share` was therefore reported
  resolvable when it was not. The list now names the precise bound paths and
  mirrors `buildExtraBinds`, and the active preset's bind destinations are
  passed in per session, since they are dynamic.

- **`claude` preset now binds `~/.local/share/claude`** (read-only), where the
  native installer keeps the versioned binary that `~/.local/bin/claude` points
  at. Read-only so a sandboxed session cannot self-update the host install.

- **`~/.claude` is now bound read-write**: Claude Code writes there throughout a
  session (todos, history, shell snapshots, stats) and fails in many flows under
  a read-only bind. Note this is the widest host write surface any preset opens —
  `~/.claude` holds host-executed configuration (`settings.json` hooks,
  `skills/`, `CLAUDE.md`), so a sandboxed agent can arrange host command
  execution on the user's next non-sandboxed run. Accepted deliberately;
  the cost and three possible mitigations are recorded in the
  `rw-config-mounts-limited-escape` debt record. The *workspace* `.claude/`
  directory remains read-only.

- **`AGENTS.md` skip-worktree flag is now actually cleared**: `process.exit()`
  was called *inside* the `try` whose `finally` unmasks the file, and
  `process.exit()` does not run pending `finally` blocks — so every normal
  session left `AGENTS.md` flagged `S`, after which git silently ignores edits to
  it. The exit code is now captured and `process.exit()` moved after the
  `try`/`finally`. Masking also now applies in direct mode, using the current
  directory as the repository root. Signal-terminated sessions still bypass
  cleanup (`no-explicit-signal-trap` debt).

- **Worktree-mode session commits now land in the worktree**: `commitAllChanges`
  spawned `git add -A` and `git commit` without a `cwd`, so `Bun.spawn` inherited
  scoder's own working directory and committed the user's **main checkout**.
  Uncommitted work there was swept into a `Committing session by scoder.` commit
  on the checked-out branch, while the worktree's real changes went uncommitted
  and the session summary described the wrong tree. `repoDir` is now a mandatory
  parameter passed as `cwd`, and the commit is skipped entirely when the worktree
  is clean. Six such commits are already in this repository's history and are
  left as recorded history.

- **`--no-worktree` is no longer refused inside a linked git worktree**: the
  nesting check exited whenever `.git` was a file, regardless of mode, and the
  error advised the very flag the user had passed. Direct mode creates no
  worktree, so there is nothing to nest; the check is now gated on
  `options.worktree`, matching the neighbouring `SCODER_SANDBOX` check.

- **Uncommitted host changes are now reported**: `hasUncommittedChanges` was dead
  code — exported, documented as intended behaviour since 2.1.1, never called.
  Worktree mode now warns that work uncommitted in the launching checkout is
  invisible to the agent, since the worktree is checked out from a commit. A
  warning rather than a refusal: the user may not need those changes.

## Testing

- **Validation suite reimplemented on `bun test`**: `tests/validate.ts` (659
  lines) and `tests/validate.test.ts` (406 lines) are replaced by a single
  `tests/scoder.test.ts` using Bun's test runner. `em test` and
  `package.json` `test` both run `bun test`.
- **41 tests, up from 20.** New coverage: local bin symlink resolution,
  regular-file copying and argument passthrough (3 tests); LLM port
  auto-detection; AGENTS.md overlay in direct mode; `addGitExclude` /
  `removeGitExclude` behaviour including idempotency and both sandbox modes
  (5 tests); `$HOME`-installed tool resolution (4 tests); and session commit,
  cleanup and nesting correctness (6 tests); and claude preset bind modes
  (2 tests).
- **First tests to exercise a real preset.** Every other test uses `/bin/bash`,
  which gets no preset, so nothing asserted anything about preset bind modes —
  the `~/.claude` change below broke no test precisely because no test covered
  it. The two new ones assert via `--dry-run`, so they inspect the command
  without launching a sandbox or touching the real config, and self-skip when
  `claude` is not installed. Partially addresses the
  `no-real-tool-integration-tests` debt record.
- **Regression tests for the `$HOME`-installed tool failure**, the gap that let
  it ship: every existing test used `/bin/bash` as the sandboxed tool, a system
  path, so nothing exercised a tool under the home directory.
  `home-installed-tool-exec-path-mapped` asserts the dry-run exec target is
  rewritten; `home-installed-tool-runs` launches the real sandbox and asserts
  `execvp` never appears; `local-bin-symlink-target-mapped` asserts no snapshot
  entry is a symlink to a host `$HOME` path; `unbound-home-tool-diagnosed`
  asserts the new pre-flight diagnostic. Each was verified to fail with its fix
  reverted.
- Worktree tests self-skip when `SCODER_SANDBOX=1`, so the suite passes both on
  the host and inside a scoder session.
- Full suite runs in ~24s. Completes the
  `scoder-test-reimplementation` plan.

## Documentation

- **`README.md` corrected for the 2.1.1 default-mode change**: direct mode was
  made the default in 2.1.1 but the README still presented worktree mode as the
  default and labelled `-w` as `(default)`. Mode sections, examples, options
  and the "After a session" section now match `parse-args.ts`.
- `README.md` referenced the removed `tests/validate.ts`; now documents
  `bun test`. Localhost blocking now describes LLM port auto-detection and
  `SCODER_LLM_PORT`.
- `design/SCOPE.md`: local bin symlink resolution and nested sandbox detection
  moved out of the roadmap into implemented features (14 features, 6 planned);
  fixed the broken `[ROADMAP.md](/ROADMAP.md)` link to point at
  `design/legacy/ROADMAP.md`.
- `architecture/FRAMEWORK.md`: execution flow now includes the nesting checks,
  LLM port detection and the `~/.local/bin` snapshot, with step numbering
  repaired.
- `target-version` bumped to 2.2.0 in `SCOPE.md`, `FRAMEWORK.md`, `STANDARDS.md`.

## Known Issues

All four records in `design/implementation/issues/` are resolved in this release
and marked `status: resolved`. Remaining known gap:

- **Signal-terminated sessions skip cleanup**: `AGENTS.md` unmasking and temp
  file removal run in normal-exit paths only. A `SIGKILL` (or `SIGTERM` without a
  handler) still leaves the flag set. Tracked as the
  `no-explicit-signal-trap` debt record, not an issue, since it needs a signal
  trap rather than a bug fix.

## Files Changed

- `src/utils/paths.ts` — new: `toSandboxPath`, `resolveHomePrefixes`, `isUnderAny`
- `src/git/worktree.ts` — `commitAllChanges` takes an explicit `repoDir`, skips clean trees
- `src/git/protection.ts` — `setupLocalBinSnapshot`, `addGitExclude`, `removeGitExclude`, mapped symlink targets, narrowed mount prefixes, copy size ceiling
- `src/utils/checks.ts` — `detectDefaultLlmPort`
- `src/index.ts` — nesting checks, local bin snapshot wiring, overlay masking in `try`/`finally`, exec-path translation and pre-flight, `process.exit` moved out of the `try`, nesting check gated on worktree mode, uncommitted-changes warning wired up
- `src/sandbox/builder.ts` — `~/.config/gh` bind, expanded env allowlist, `collectBindDests`
- `src/tools/presets.ts` — `gh` bind removed from the copilot preset, `~/.claude.json` and `~/.local/share/claude` binds added, `~/.claude` switched to read-write
- `src/cli/parse-args.ts` — `--llm-port` help text, version 2.2.0
- `tests/scoder.test.ts` — new suite; `tests/validate.ts`, `tests/validate.test.ts` removed
- `design/features/nested-sandbox-detection.md`, `design/implementation/issues/worktree-check-ignores-no-worktree.md` — new
- `design/features/path-mirroring.md` — home-remapping section; `local-bin-resolution.md`, `tool-presets.md` — corrected
- `README.md`, `design/SCOPE.md`, `architecture/FRAMEWORK.md`, `architecture/STANDARDS.md`, `design/test-scripts/validation-suite.md` — updated

---

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
