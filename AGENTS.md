# AGENTS.md

Instructions for AI coding agents working in this repository.

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
em test              # run validation suite (also: bun run tests/validate.ts)
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

## Adding a New Tool Preset

Edit `src/tools/presets.ts` following the `ToolPreset` interface. Each tool
has `configBinds(realHome, sandboxHome)` returning bind mounts and directories,
and `validate()` checking prerequisites. See existing presets for examples.

## Testing

Tests in `tests/validate.ts` create isolated repos under `/tmp`, run scoder,
assert output, and clean up. Use `runScoder(repoDir, args)` and
`runScoderInDir(runDir, args)` helpers. Clean up worktrees and branches in
finally blocks.
