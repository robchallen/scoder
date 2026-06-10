---
target-version: 2.1.0
status: draft
tags: [standards, coding]
---

# scoder Code Standards

## Language

- TypeScript with strict mode enabled (`tsconfig.json`)
- Bun v1.3+ runtime with bundler module resolution
- No unchecked indexed access (`noUncheckedIndexedAccess: false`)

## Naming Conventions

| Scope | Style | Example |
|-------|-------|---------|
| Interface/Type | PascalCase | `ToolPreset`, `BindMount`, `GitWorktreeInfo` |
| Function | camelCase | `setupGitWorktree`, `checkBwrapUserns` |
| Variable | camelCase | `worktreeInfo`, `sandboxProjDir` |
| Constant | SCREAMING_SNAKE_CASE | `SCODER_HOME`, `DEFAULT_PROTECTED` |

## File Organisation

- One logical component per file
- Related functions grouped together
- Interfaces/types in `types.ts` unless component-specific
- Async functions marked with `async` and return `Promise<T>`

## Error Handling

```typescript
// Fatal errors
error("message");
process.exit(1);

// Non-fatal
warning("message");
```

## Output Functions

From `src/utils/logger.ts`:

- `error(msg)` — red, always shown, to stderr
- `warning(msg)` — yellow, always shown, to stderr
- `info(msg)` — green, suppressed by `--quiet`, to stderr
- `infoBlue(msg)` — blue, suppressed by `--quiet`, to stderr

## Type Safety

- Explicit types for function parameters and return values
- `| null` or `| undefined` for optional values
- `unknown` over `any` for caught errors
- Type guards for narrowing unions

## Testing

- Test files: `tests/` directory
- Test framework: custom async test runner in `tests/validate.ts`
- Test pattern: create isolated git repo in `/tmp`, run scoder, assert output
- Cleanup: try/finally blocks for temp file removal
- Coverage target: all sandbox mechanics tested (filesystem, network, protection, worktree lifecycle)

## Git Conventions

- Lowercase imperative verb, no prefix, no trailing period
- Branch naming for scoder sessions: `scoder/<proj>`
- `baseCommit` is `null` for reused worktrees to suppress meaningless diffstats
