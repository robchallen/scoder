# AGENTS.md

Instructions for AI coding agents working in this repository.

## Project Overview

scoder is a **TypeScript application** (~2400 lines) that sandboxes AI coding
tools (opencode, claude, copilot, pi) using bubblewrap (bwrap) for filesystem
isolation and `pasta` for network isolation, with optional git worktree
isolation. The project uses Bun as the runtime.

### Key Files

- `src/index.ts` — main entry point, orchestrates all phases
- `src/types.ts` — TypeScript interfaces and types
- `src/cli/` — option parsing and AppArmor configuration
- `src/git/` — worktree lifecycle and infrastructure protection
- `src/tools/presets.ts` — tool-specific configurations
- `src/sandbox/builder.ts` — bwrap command construction
- `tests/validate.ts` — developer-facing validation suite
- `README.md` — user-facing documentation
- `DESIGN.md` — architecture decisions, trade-offs, pitfalls — **keep in sync
  when making non-trivial changes**

## Build / Test / Lint Commands

```bash
# Install dependencies (first time only)
bun install

# Run the validation suite (requires bwrap and pasta installed):
bun run tests/validate.ts

# Dry-run to inspect the bwrap command for a specific tool:
bun run src/index.ts --dry-run opencode

# Type check (no emit):
bun run typecheck

# Build standalone binary:
bun run build
```

The validation suite creates temporary git repos under `/tmp` and cleans up
their worktrees and branches on exit. To test a single aspect manually:

```bash
# Example: test HOME isolation manually
bun run src/index.ts -q /bin/bash -c 'echo $HOME'   # should print /home/scoder
```

## TypeScript Configuration

- **Runtime**: Bun v1.3+
- **Strict mode**: enabled in `tsconfig.json`
- **Module resolution**: bundler
- **No unchecked indexed access**: disabled (allows array access without undefined checks)

## Code Style

### Naming Conventions

| Scope | Style | Example |
|-------|-------|---------|
| Interface/Type | `PascalCase` | `ToolPreset`, `BindMount`, `GitWorktreeInfo` |
| Class | `PascalCase` | (none currently, all functions) |
| Function | `camelCase` | `setupGitWorktree`, `checkBwrapUserns` |
| Variable | `camelCase` | `worktreeInfo`, `sandboxProjDir` |
| Constant | `SCREAMING_SNAKE_CASE` | `SCODER_HOME`, `DEFAULT_PROTECTED` |
| Private field | `#camelCase` | (not used) |

### File Organization

- One logical component per file
- Related functions grouped together
- Interfaces/types in `types.ts` unless component-specific
- Async functions marked with `async` and return `Promise<T>`

### Error Handling

```typescript
// Fatal errors: log and exit
error("message");
process.exit(1);

// Non-fatal: log and continue
warning("message");

// Try-catch for async operations
try {
  await someAsyncOperation();
} catch (err) {
  error(`Operation failed: ${err}`);
  process.exit(1);
}
```

### Output Functions

```typescript
import { error, warning, info, infoBlue } from "./utils/logger.ts";

error("message");      // red, always shown, to stderr
warning("message");    // yellow, always shown, to stderr
info("message");       // green, suppressed by --quiet, to stderr
infoBlue("message");   // blue, suppressed by --quiet, to stderr
```

### Type Safety

- Always use explicit types for function parameters and return values
- Use `| null` or `| undefined` for optional values
- Prefer `unknown` over `any` for caught errors
- Use type guards when narrowing unions

```typescript
// Good
async function setupGitWorktree(useWorktree: boolean): Promise<GitWorktreeInfo | null> {
  if (!useWorktree) {
    return null;
  }
  // ...
}

// Good
if (worktreeInfo) {
  // TypeScript knows worktreeInfo is GitWorktreeInfo here
  console.log(worktreeInfo.worktreeDir);
}
```

## Adding a New Tool Preset

Edit `src/tools/presets.ts`:

```typescript
export const TOOL_PRESETS: Record<string, ToolPreset> = {
  // ... existing tools ...

  newtool: {
    description: "New Tool",

    configBinds: async (realHome, sandboxHome) => {
      const binds: BindMount[] = [];
      const dirs: string[] = [];

      // Config (read-only)
      const configDir = `${realHome}/.config/newtool`;
      if (await dirExists(configDir)) {
        dirs.push(`${sandboxHome}/.config/newtool`);
        binds.push({
          type: "ro-bind",
          source: configDir,
          dest: `${sandboxHome}/.config/newtool`,
        });
      }

      // Data (read-write)
      const dataDir = `${realHome}/.local/share/newtool`;
      await ensureDir(dataDir);
      dirs.push(`${sandboxHome}/.local/share/newtool`);
      binds.push({
        type: "bind",
        source: dataDir,
        dest: `${sandboxHome}/.local/share/newtool`,
      });

      return { binds, dirs };
    },

    validate: async () => {
      const exists = await commandExists("newtool");
      if (!exists) {
        error("newtool not found in PATH");
        error("Install: <install instructions>");
        return false;
      }
      return true;
    },
  },
};
```

## Module Structure

### `src/index.ts`

Main orchestration:
1. Parse CLI options
2. Validate system dependencies (bwrap, pasta)
3. Handle special modes (--configure-apparmor, --install-dependencies)
4. Select tool preset
5. Setup git worktree (if enabled)
6. Setup protection (.agentreadonly, AGENTS.md overlay)
7. Build bwrap command
8. Execute and handle exit

### `src/git/worktree.ts`

Git operations:
- `isInGitRepo()` — check if in git repository
- `setupGitWorktree()` — create/reuse worktree
- `commitAllChanges()` — commit staged changes
- `getCommitCount()` — count commits on branch
- `getDiffStat()` — get diff statistics

### `src/git/protection.ts`

Infrastructure protection:
- `setupProtection()` — parse .agentreadonly, setup binds
- `setupAgentsSnapshot()` — copy ~/.agents to /tmp
- `setupAgentsMdOverlay()` — create AGENTS.md with sandbox notice
- `setupResolvConf()` — snapshot resolver config
- `getAgentsMdOverlayBind()` — create bind mount for AGENTS.md

### `src/sandbox/builder.ts`

bwrap command construction:
- System mounts (/usr, /bin, /lib, etc.)
- Device binds (/dev)
- HOME setup (tmpfs + directories)
- Tool-specific binds
- Extra binds (host tools, config files)
- Environment variables
- pasta network configuration

### `src/tools/presets.ts`

Tool configurations:
- `opencode` — OpenCode AI assistant
- `claude` — Claude Code
- `copilot` — GitHub Copilot CLI
- `pi` — Pi Coding Agent

Each tool has `configBinds()` and `validate()` functions.

## Common Patterns

### Async File Operations

```typescript
// Check if file exists
async function fileExists(path: string): Promise<boolean> {
  try {
    return await Bun.file(path).exists();
  } catch {
    return false;
  }
}

// Read file content
const content = await Bun.file(path).text();

// Write file
await Bun.write(path, content);
```

### Spawning Processes

```typescript
const proc = await Bun.spawn(["git", "rev-parse", "HEAD"], {
  stdout: "pipe",
  stderr: "pipe",
  cwd: process.cwd(),
});

await proc.exited;

if (proc.exitCode !== 0) {
  const stderr = await new Response(proc.stderr).text();
  throw new Error(`Git failed: ${stderr}`);
}

const stdout = await new Response(proc.stdout).text();
const commit = stdout.trim();
```

### Array Operations

```typescript
// Append unique value
function appendUniquePath(array: string[], value: string): void {
  if (!array.includes(value)) {
    array.push(value);
  }
}

// Conditional push
if (await dirExists(path)) {
  binds.push({ type: "ro-bind", source, dest });
}
```

## Git Conventions

- **Commit messages**: lowercase imperative verb, no prefix, no trailing period
  - `add typescript migration`
  - `fix worktree branch naming`
  - `remove bash script`
- **Branch naming for scoder sessions**: `scoder/<tool>/<YYYY-MM-DD>-<hex>`

## Common Pitfalls

1. **Path resolution**: Always use `realpath()` for worktree paths to handle
   symlinks correctly.

2. **Null checks**: `worktreeInfo` is `GitWorktreeInfo | null` — check before
   accessing properties when in direct mode.

3. **Bind mount order**: `--ro-bind` overlays must come **after** the parent
   `--bind` in the bwrap command to take effect.

4. **AppArmor on Ubuntu 24.04+**: bwrap requires user namespace permission.
   Run `sudo scoder --configure-apparmor` once.

5. **Temp file cleanup**: Temp files (AGENTS.md overlay, resolv.conf, agents
   snapshot) are created in `/tmp`. Clean up on exit to avoid accumulation.

6. **Async/await**: All file and process operations are async. Don't forget
   `await` keywords.

7. **Bun.serve for tests**: The validation test suite uses `Bun.serve()` for
   localhost testing. Remember to call `server.stop()` in finally blocks.

## Testing Guidelines

When adding tests to `tests/validate.ts`:

1. Create isolated test repos in `/tmp`
2. Clean up after tests (use try/finally)
3. Use descriptive test names
4. Test both worktree and direct modes where applicable
5. Use `assert_match()` and `assert_not_match()` helpers for output validation

Example:
```typescript
async function testHomeIsolation(): Promise<boolean> {
  const repoDir = await createTestRepo("home-isolation");
  const output = await runScoder(repoDir, ["-q", "/bin/bash", "-c", "printf '%s\n' $HOME"]);
  return output.includes(SCODER_HOME);
}
```
