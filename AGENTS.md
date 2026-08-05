# AGENTS.md

Instructions for AI coding agents working in this repository.

## Principles

* If the user prompt looks like a bash command they have probably forgotten to escape it and you should stop and ask whether they forgot to escape it.
* If the input looks incomplete ask the user and wait for the next message.
* If uncertain about user intentions clarify with the user and do not make assumptions.
* Design artefacts are in the `design` folder.
* **MAKE SURE YOU HAVE A CLEAN REVERT POINT BEFORE MAKING EVEN SEEMING MINOR CHANGES**
* **IT IS NOT HELPFUL TO IMMEDIATELY FIX PRE-EXISTING BUGS WITHOUT CONSULTING THE USER**
* **IT IS ALWAYS HELPFUL TO DOCUMENT PRE-EXISTING BUGS IN `design/implementation/issues` (n.b. create it if it does not exist)**
* If you are asked to work on documentation, ONLY change documentation files:
    When documenting **do NOT fix bugs, refactor code, or modify any non-documentation files, even when you discover bugs.**
    Document discovered bugs instead (see above).
* When you discover a bug during any task:
    1. If the bug was INTRODUCED BY YOUR OWN PREVIOUS CHANGE → fix it immediately
    2. If the bug is PRE-EXISTING (introduced by the user or existed before) document it in `design/implementation/issues` and do NOT fix it
    3. It is helpful to document the suggested fix in `design/implementation/issues`
    4. If `design/implementation/issues` does not exist → create it
* Always distinguish between bugs you introduced (fix immediately) and pre-existing bugs (document and move on).
* If you are asked to create tests for existing code **CREATE TESTS BASED ON YOUR UNDERSTANDING OF INTENTION NOT EXISTING CODE BEHAVIOUR EVEN IF THEY FAIL**.
    * Discuss new test failures with the user and document in `design/implementation/issues` (if it doesn't exist → create it)
* If you are asked to use a TODO list to manage a process then
    1. **CREATE THE TODO LIST**,
    2. **EXECUTE THE NEXT TASK ON THE LIST ONE AT A TIME**,
    3. **MARK THE TASK AS COMPLETE**,
    4. **REPEAT UNTIL NO MORE TASKS**. No skipping. No doing multiple steps at once.
* Before commiting confirm the following:
    1) **ALL AFFECTED TESTS PASS**,
    2) **NO NEW LINTING OR STATIC ANALYSIS ISSUES**,
    3) **DESIGN DOCUMENTATION IS UP TO DATE**,
    4) **PATCH VERSION NUMBER IS INCREMENTED**
* When you or the user have fixed an active issue update its status in `design/implementation/issues`
* git push is the users responsibility. **DO NOT TRY AND GIT PUSH THE PROJECT**

## Project Overview

scoder sandboxes AI coding tools using bubblewrap and pasta, with optional
git worktree isolation. TypeScript, Bun runtime, modular pipeline architecture.

[Framework details](/architecture/FRAMEWORK.md)
[Code standards](/architecture/STANDARDS.md)

## Build / Test / Lint

```bash
bun install          # first time only
bun run typecheck    # type check
bun run build        # standalone binary
em test              # run validation suite (also: bun run tests/scoder.test.ts)
em design            # design consistency check
```

## Design Folder Layout

```
design/
├── SCOPE.md
├── features/           # one doc per feature, linked to src/ via IMPLEMENTED_BY
├── test-scripts/       # test documentation, linked to tests/ via TESTED_BY
├── implementation/
│   ├── issues/         # known issues to fix
│   ├── debt/           # technical debt with IMPACTS links
│   └── plans/          # implementation plans
├── prototypes/         # executable design prototypes
└── legacy/             # archived pre-migration docs
architecture/
├── FRAMEWORK.md        # technical architecture
├── STANDARDS.md        # code standards
└── decision-records/
```

## Common Patterns

### Async File Operations

```typescript
async function fileExists(path: string): Promise<boolean> {
  try {
    return await Bun.file(path).exists();
  } catch {
    return false;
  }
}

const content = await Bun.file(path).text();
await Bun.write(path, content);
```

### Spawning Processes

```typescript
const proc = await Bun.spawn(["git", "rev-parse", "HEAD"], {
  stdout: "pipe", stderr: "pipe", cwd: process.cwd(),
});
await proc.exited;
if (proc.exitCode !== 0) {
  const stderr = await new Response(proc.stderr).text();
  throw new Error(`Git failed: ${stderr}`);
}
const stdout = await new Response(proc.stdout).text();
```

### Array Operations

```typescript
function appendUniquePath(array: string[], value: string): void {
  if (!array.includes(value)) array.push(value);
}

if (await dirExists(path)) {
  binds.push({ type: "ro-bind", source, dest });
}
```

## Git Conventions

- Commit messages: lowercase imperative verb, no prefix, no trailing period
- Session branches: `scoder/<proj>`

## Common Pitfalls

1. **Path resolution**: Use `realpath()` for worktree paths to handle symlinks.
2. **Null checks**: `worktreeInfo` is `GitWorktreeInfo | null` — check before accessing.
3. **Bind mount order**: `--ro-bind` overlays must come **after** the parent `--bind`.
4. **AppArmor on Ubuntu 24.04+**: bwrap needs user namespace permission. Run `sudo scoder --configure-apparmor` once.
5. **Temp file cleanup**: Temp files (AGENTS.md overlay, resolv.conf, agents snapshot) are created in `/tmp`. Clean up on exit.
6. **Async/await**: All file and process operations are async. Do not forget `await`.
7. **Bun.serve cleanup**: Tests using `Bun.serve()` for localhost need `server.stop()` in finally blocks.
8. **AGENTS.md overlay masking**: The workspace `AGENTS.md` is overlaid with a read-only sandbox notice inside the sandbox. Use `git update-index --skip-worktree AGENTS.md` to mask the overlay from git (so the agent can use git freely). Restore with `--no-skip-worktree` after the session.

## Adding a New Tool Preset

Edit `src/tools/presets.ts` following the `ToolPreset` interface. Each tool
has `configBinds(realHome, sandboxHome)` returning bind mounts and directories,
and `validate()` checking prerequisites. See existing presets for examples.

## Testing

Tests in `tests/scoder.test.ts` create isolated repos under `/tmp`, run scoder,
assert output, and clean up. Use `runScoder(repoDir, args)` and
`runScoderInDir(runDir, args)` helpers. Clean up worktrees and branches in
finally blocks.
