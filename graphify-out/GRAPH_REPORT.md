# Graph Report - scoder  (2026-06-10)

## Corpus Check
- 43 files · ~22,442 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 534 nodes · 711 edges · 43 communities (42 shown, 1 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `dbc61b19`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]

## God Nodes (most connected - your core abstractions)
1. `main()` - 21 edges
2. `createTestRepo()` - 21 edges
3. `runScoder()` - 21 edges
4. `What each test checks` - 21 edges
5. `Test Cases` - 21 edges
6. `Test-to-Code Mapping` - 19 edges
7. `info()` - 17 edges
8. `error()` - 16 edges
9. `setupGitWorktree()` - 16 edges
10. `compilerOptions` - 14 edges

## Surprising Connections (you probably didn't know these)
- `ParseResult` --references--> `ScoderOptions`  [EXTRACTED]
  src/cli/parse-args.ts → src/types.ts
- `main()` --calls--> `setupAgentsSnapshot()`  [EXTRACTED]
  src/index.ts → src/git/protection.ts
- `main()` --calls--> `setupProtection()`  [EXTRACTED]
  src/index.ts → src/git/protection.ts
- `main()` --calls--> `setupResolvConf()`  [EXTRACTED]
  src/index.ts → src/git/protection.ts
- `registerAgentreadonlyHomeBind()` --calls--> `error()`  [EXTRACTED]
  src/git/protection.ts → src/utils/logger.ts

## Communities (43 total, 1 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.08
Nodes (57): configureAppArmor(), fileExists(), realpath(), which(), parseArgs(), parsePorts(), ParseResult, printUsage() (+49 more)

### Community 1 - "Community 1"
Cohesion: 0.06
Nodes (34): Adding a New Tool Preset, Array Operations, Async File Operations, Build / Test / Lint Commands, Code Style, code:bash (# Install dependencies (first time only)), code:typescript (async function testHomeIsolation(): Promise<boolean> {), code:bash (# Example: test HOME isolation manually) (+26 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (32): 10. `worktree-branch-created`, 11. `existing-scoder-worktree-reused`, 12. `worktree-recreated-if-missing`, 13. `symlinked-agents-skills-available`, 14. `sandbox-agents-md-overlay-visible`, 15. `agents-md-overlay-in-direct-mode`, 16. `host-loopback-blocked`, 17. `llm-port-allows-host-loopback` (+24 more)

### Community 3 - "Community 3"
Cohesion: 0.06
Nodes (30): 10. `worktree-branch-created`, 11. `existing-scoder-worktree-reused`, 12. `symlinked-agents-skills-available`, 13. `sandbox-agents-md-overlay-visible`, 14. `host-loopback-blocked`, 15. `llm-port-allows-host-loopback`, 16. `outbound-dns-works`, 17. `dry-run-uses-pasta` (+22 more)

### Community 4 - "Community 4"
Cohesion: 0.17
Nodes (27): cleanup(), createTestRepo(), main(), runScoder(), runScoderInDir(), testAgentreadonlyHomeDirectoryMustExist(), testAgentreadonlyHomeDirectoryReadonly(), testAgentreadonlyProtected() (+19 more)

### Community 5 - "Community 5"
Cohesion: 0.07
Nodes (26): After a session, `.agentreadonly` file, AppArmor setup (Ubuntu 24.04+), code:block1 (scoder [options] <tool> [tool-args...]), code:bash (scoder opencode                   # sandbox opencode in curr), code:block3 (-h, --help              Show help), code:bash (git fetch origin), code:block5 (scoder: ====== Session Summary ======) (+18 more)

### Community 6 - "Community 6"
Cohesion: 0.07
Nodes (26): 10. worktree-branch-created, 11. existing-scoder-worktree-reused, 12. worktree-recreated-if-missing, 13. symlinked-agents-skills-available, 14. sandbox-agents-md-overlay-visible, 15. agents-md-overlay-in-direct-mode, 16. host-loopback-blocked, 17. llm-port-allows-host-loopback (+18 more)

### Community 7 - "Community 7"
Cohesion: 0.08
Nodes (23): 1. Confirm you are really in the sandbox workflow, 2. Absolute paths may be different, 2. Assume the sandbox branch started from the user's current `HEAD`, 3. Work as if the project worktree is writable but the environment is selective, 4. Update from local changes in main branch explicitly, 5. Treat commits as the visibility boundary, 6. Commit at meaningful checkpoints, A write failed with a read-only error (+15 more)

### Community 8 - "Community 8"
Cohesion: 0.10
Nodes (19): 1. Original Bash Script (`scoder` - 1502 lines), 2. Bash Test Suite (`tests/validate.sh` - 452 lines), 3. Old Test Scripts, After (TypeScript), Bash Script Retirement Summary, Bash Wrapper Script (`scoder`), Before (Bash), Breaking Changes (+11 more)

### Community 9 - "Community 9"
Cohesion: 0.10
Nodes (19): bin, scoder, description, devDependencies, c8, @types/bun, typescript, keywords (+11 more)

### Community 10 - "Community 10"
Cohesion: 0.24
Nodes (16): appendUniquePath(), createTempDir(), createTempFile(), DEFAULT_PROTECTED, fileExists(), fileOrDirExists(), findProtectedPaths(), pathsOverlap() (+8 more)

### Community 11 - "Community 11"
Cohesion: 0.12
Nodes (16): AppArmor Compatibility, CLI, Configuration, Current Functionality, Environment, Git lifecycle, Git Worktree Isolation, Host Tool Bind-Mounts (all sessions) (+8 more)

### Community 12 - "Community 12"
Cohesion: 0.12
Nodes (16): compilerOptions, allowImportingTsExtensions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit (+8 more)

### Community 13 - "Community 13"
Cohesion: 0.18
Nodes (10): code:typescript (// Fatal errors), Error Handling, File Organisation, Git Conventions, Language, Naming Conventions, Output Functions, scoder Code Standards (+2 more)

### Community 14 - "Community 14"
Cohesion: 0.20
Nodes (10): Agent Skills Snapshot, `.agentreadonly` HOME binds, code:block3 (/usr, /bin, /lib, /etc, /sys, /run  → read-only from host), Environment, Network Isolation, Sandbox AGENTS.md Overlay, Sandbox Shape, Sandboxing Strategy (+2 more)

### Community 15 - "Community 15"
Cohesion: 0.22
Nodes (8): Architecture Style, code:block1 (src/), Design Decisions, Execution Flow, Language and Runtime, Module Map, scoder Technical Architecture, System Dependencies

### Community 16 - "Community 16"
Cohesion: 0.22
Nodes (9): code:bash (# List scoder branches), Copilot CLI Config Paths, Known Limitations and Future Work, Live Tool Testing, No Nested Sandbox Detection, Read-Write Config Mounts, Signal Handling, Validation Test Speed (+1 more)

### Community 17 - "Community 17"
Cohesion: 0.29
Nodes (6): code:block1 (gitdir: /path/to/main/.git/worktrees/<name>), code:block2 (/tmp/scoder/<project-path>), Implementation, Path Mirroring, Problem, Summary

### Community 18 - "Community 18"
Cohesion: 0.29
Nodes (6): code:typescript (if (options.worktree) {), Impact, Missing Warning for Uncommitted Host Changes, Root Cause, Suggested Fix, Summary

### Community 19 - "Community 19"
Cohesion: 0.33
Nodes (5): Implemented Features, Non-Goals, Planned Features, Purpose, scoder Project Scope

### Community 20 - "Community 20"
Cohesion: 0.33
Nodes (5): Agent Skills Snapshot, Implementation, Motivation, Summary, Trade-off

### Community 21 - "Community 21"
Cohesion: 0.33
Nodes (5): Goals, Goals and Non-Goals, Non-Goals, scoder Design Decisions & Architecture, Table of Contents

### Community 22 - "Community 22"
Cohesion: 0.33
Nodes (6): code:block5 (gitdir: /path/to/main/.git/worktrees/<name>), code:block6 (/tmp/scoder/<git-repo-path>), GIT_WORK_TREE Must Not Be Set, Path Mirroring, The Problem, The Solution

### Community 23 - "Community 23"
Cohesion: 0.40
Nodes (4): AppArmor Compatibility, Implementation, Motivation, Summary

### Community 24 - "Community 24"
Cohesion: 0.40
Nodes (4): Git Worktree Isolation, Implementation, Motivation, Summary

### Community 25 - "Community 25"
Cohesion: 0.40
Nodes (4): Host Tool Binding, Implementation, Motivation, Summary

### Community 26 - "Community 26"
Cohesion: 0.40
Nodes (4): Implementation, Motivation, Sandbox Isolation, Summary

### Community 27 - "Community 27"
Cohesion: 0.40
Nodes (4): AGENTS.md Overlay, Implementation, Motivation, Summary

### Community 28 - "Community 28"
Cohesion: 0.40
Nodes (4): Dry-Run Mode, Implementation, Motivation, Summary

### Community 29 - "Community 29"
Cohesion: 0.40
Nodes (4): Implementation, Infrastructure Protection, Motivation, Summary

### Community 30 - "Community 30"
Cohesion: 0.40
Nodes (4): Implementation, Motivation, Network Isolation, Summary

### Community 31 - "Community 31"
Cohesion: 0.40
Nodes (4): Implementation, Motivation, Summary, Tool Presets

### Community 32 - "Community 32"
Cohesion: 0.40
Nodes (5): AppArmor Compatibility, code:block8 (abi <abi/4.0>,), Early Diagnostic, The Problem, The Solution

### Community 33 - "Community 33"
Cohesion: 0.40
Nodes (5): `.agentreadonly` File, code:block7 (# Protect additional paths), Default Protection, Implementation, Infrastructure Protection

### Community 34 - "Community 34"
Cohesion: 0.40
Nodes (5): code:typescript (interface ToolPreset {), Design, Generic Commands, Per-Tool Details, Tool Preset System

### Community 35 - "Community 35"
Cohesion: 0.40
Nodes (5): Branch Naming, Git Worktree Lifecycle, Lifecycle (Worktree Mode), Uncommitted Changes Warning, Why Worktrees

### Community 36 - "Community 36"
Cohesion: 0.50
Nodes (3): Key facts, scoder sandbox behavior, Sources

### Community 37 - "Community 37"
Cohesion: 0.50
Nodes (4): Architecture Overview, code:block1 (src/), code:block2 (Option parsing (--help, --version, --worktree/--no-worktree,), Execution Flow

### Community 38 - "Community 38"
Cohesion: 0.50
Nodes (4): Behavior, Direct Mode (`--no-worktree`), Rationale, When to Use

### Community 39 - "Community 39"
Cohesion: 0.50
Nodes (4): Trade-offs, TypeScript Migration Rationale, Why Bun?, Why TypeScript?

### Community 40 - "Community 40"
Cohesion: 0.50
Nodes (3): 1. Missing Warning for Uncommitted Host Changes, code:typescript (// Proposed fix in src/index.ts around line 118:), Known Issues

## Knowledge Gaps
- **296 isolated node(s):** `name`, `version`, `description`, `type`, `main` (+291 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `scoder Design Decisions & Architecture` connect `Community 21` to `Community 32`, `Community 33`, `Community 34`, `Community 35`, `Community 37`, `Community 38`, `Community 39`, `Community 14`, `Community 16`, `Community 22`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Why does `Sandboxing Strategy` connect `Community 14` to `Community 21`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Why does `Known Limitations and Future Work` connect `Community 16` to `Community 21`?**
  _High betweenness centrality (0.003) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _296 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.08115942028985507 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.05555555555555555 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.06060606060606061 - nodes in this community are weakly interconnected._