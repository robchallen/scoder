---
name: working-in-a-scoder-sandbox
description: 'Use when the current git branch matches `scoder/*` or when the user tells you that you are in a scoder sandbox or scoder worktree. Also use when the user mentions `--no-worktree` mode. Use this if the user requests you update your copy of the code to incorporate changes from upstream and you detect you are in a sandbox. Use if you find that full paths that previously worked fail and your home directory is now `/home/scoder`. Do NOT use for generic Git advice outside scoder or for unrelated sandbox/container environments.'
license: MIT
allowed-tools: Read Bash Grep Glob
---

# Working in a scoder sandbox

This skill explains how to behave when working inside a `scoder` sandboxed
worktree. It is a capability skill: it helps you reason about the
environment, choose Git commands that fit the workflow, and avoid assumptions
that are true in a normal checkout but false in a `scoder` session. The skill
gives you guidance about what Git and filesystem operations will or will not
behave normally inside a `scoder` session. It is helpful for deciding how to
pick up changes from `main`, when other checkouts can see your work, what paths
are protected, and when to commit.

`scoder` sandboxes are fairly permissive. They are not expected to prevent
intentional misuse but rather accidental filesystem errors and keep a
seperation between user and agent views of the repository. You still need to exercise
caution when composing bash commands.

## Available Scripts

No helper scripts are bundled with this skill.

## When to Use This Skill

Use this skill when:

- the current branch name matches `scoder/*` and your home directory is now `/home/scoder/`
- the user says that you are in a scoder sandbox or scoder worktree
- **the user mentions running scoder with `--no-worktree` (direct mode, no branch created)**
- you need to decide whether a file write is likely to succeed inside scoder
- you need to bring upstream `main` changes into an in-progress sandbox session
- you need to know whether another checkout can already see sandbox changes
- file edits are failing and you are not sure why

Do not use this skill for:

- ordinary Git workflows outside scoder
- generic container, VM, or sandbox guidance unrelated to scoder

## Environment

### Confirming you are in a sandbox

The primary detection is the `SCODER_SANDBOX=1` environment variable.
Check it first:

```bash
echo $SCODER_SANDBOX
```

If it prints `1` you are inside a scoder sandbox. The `$HOME` variable will be
`/home/scoder/`, `$USER` and `$LOGNAME` will be `scoder`, and the working
directory will be either the worktree path (worktree mode) or the actual
project directory (direct mode).

If `SCODER_SANDBOX` is not set but you are on a `scoder/*` branch, you may be
looking at the repository outside the sandbox (the real checkout).

### Sandbox environment variables

| Variable | Value | Notes |
|---|---|---|
| `$HOME` | `/home/scoder` | Ephemeral, on tmpfs — lost when sandbox exits |
| `$USER` | `scoder` | Not your real username |
| `$LOGNAME` | `scoder` | Not your real login name |
| `$SCODER_SANDBOX` | `1` | Set only inside the sandbox |
| `$TERM` | from host | Passed through |
| `$LANG` | from host | Passed through |
| `$PATH` | modified | Includes sandbox-local `~/.local/bin` |

### Environment variables passed through

The sandbox clears the environment then selectively passes through:

- **Editor tools**: `EDITOR`, `VISUAL`
- **Colour control**: `NO_COLOR`, `FORCE_COLOR`
- **AI keys**: `OPENROUTER_API_KEY`, `ANTHROPIC_*`, `OPENAI_*`, `GEMINI_*`, `MISTRAL_*`, `DEEPSEEK_*`, `GROQ_*`, `CEREBRAS_*`, `CLOUDFLARE_*`, `XAI_*`, `OPENCODE_*`, `HF_TOKEN`, `FIREWORKS_*`, `TOGETHER_*`, `KIMI_*`, `MINIMAX_*`, `XIAOMI_*`, `AI_GATEWAY_API_KEY`
- **Azure**: `AZURE_OPENAI_*`
- **AWS**: `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION`
- **Google Cloud**: `GOOGLE_CLOUD_*`
- **Pi-specific**: `PI_SKIP_VERSION_CHECK`, `PI_OFFLINE`
- **Tool-specific**: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `CLAUDE_MODEL`, `COPILOT_*`

All other environment variables from your host are **not** available inside
the sandbox.

## Workflow

### 1. Confirm you are really in the sandbox workflow

The strongest signal for this skill is `SCODER_SANDBOX=1`. Check this first:

```bash
echo $SCODER_SANDBOX
```

If it returns `1`, you are inside a scoder sandbox. Your `$HOME` is `/home/scoder/`.
If the user only mentions scoder in passing, verify the env var or the branch
before giving sandbox-specific advice.

### 2. Absolute paths may be different

Relative paths from `$HOME` will match exactly the layout of this repository outside
the sandbox. However your `$HOME` is `/home/scoder/` which is different from the
users `$HOME` variable outside the sandbox.

Use paths relative to `$HOME` so that your context will stay the same if you are moved out
of the sandbox later.

You may have stale context that uses absolute paths including the users `$HOME` if an original
session was started outside of the sandbox. If you replace their `$HOME` with `/home/scoder`
you should be able to find the file.

Symbolic links outside of the repository will probably be broken. A common problem is
with agent skill directories. scoder copies `~/.agents` to a temp directory and
bind-mounts it read-only, so symlinked skills resolve correctly as a snapshot
taken at sandbox start.

**Note on modes:** In worktree mode (default), your working directory is at
`/tmp/scoder/<git-repo-path>` mapped to `/home/scoder/<git-repo-path>`. In direct mode
(`--no-worktree`), your working directory is the current directory of the real
project checkout.

### 3. Assume the sandbox branch started from the user's current `HEAD`

There is nothing special about `main`. A scoder session starts from whatever
branch or commit the user launched it from, then creates or reuses
`scoder/<repo>`.

This matters when reasoning about diffs and rebases: compare against the
current branch context, not against `main` by default.

**Exception:** In `--no-worktree` mode, no branch is created. Changes happen
directly in the working directory and are immediate (no commit required, but
also no isolation).

### 4. Work as if the project worktree is writable but the environment is selective

What is usually safe:

- editing normal project files in the sandbox worktree
- running Git on the current `scoder/*` branch (or current branch in direct mode)
- rerunning `scoder` from the same scoder worktree

What is usually constrained:

- writes to system paths such as `/usr`, `/etc`, `/bin`
- writes to protected infra files such as `.github/`, `.gitignore`, lockfiles,
  and `.agentreadonly` unless the repository's `.agentreadonly` configuration
  has explicitly relaxed protection
- writing to `AGENTS.md` is not possible (read-only overlay with sandbox notice)
- writing to `$HOME` persists only for the session (ephemeral tmpfs)

When a task fails with a read-only error, first check whether the target is a
protected path or a broken symlink rather than assuming the whole worktree is broken.
Abandon an edit and confer with the user if you get a read only error.

`.agentreadonly` is a gitignore-like file specifying paths that the agent cannot
modify. Lines starting with `$HOME/` bind host home directories read-only into
the sandbox at the same relative path (e.g. `$HOME/Git/other-project` becomes
`/home/scoder/Git/other-project`). An empty `.agentreadonly` removes all default
protections. `.agentreadonly` itself is always read-only.

### 5. Update from local changes in main branch explicitly

Inside the sandbox, do not assume `git pull` will bring in the latest `main`.
The scoder branch may not have an upstream configured for that purpose. The
local code is where the relevant changes are.

Prefer:

```bash
git fetch origin
git rebase origin/main
```

or:

```bash
git fetch origin
git merge origin/main
```

Use this when the user asks to pick up their latest local changes, or when you discover
that the branch you started from is behind the worktree root branch and the task depends on
those changes. **DO NOT** try and pull or merge from origin. You may have to manage merge conflicts.

**GOTCHAS**: If the user changes a read only protected file, then a rebase or merge will fail as
they are unable to update the sandbox copy (which will be read only). In this case the only
real option is for the user to fix things outside the sandbox.

### 6. Network behavior

- **Outbound internet** is available (DNS resolution, API calls)
- **Host localhost** (127.0.0.1) is **blocked by default**
- **LLM ports**: if the user specifies `--llm-port=PORT` or scoder auto-detects an open port, that one localhost port is reachable
- DNS is configured via the host's resolv.conf snapshot

If your tool needs to reach a localhost service, the user must pass
`--llm-port=PORT` when launching scoder.

### 7. Treat commits as the visibility boundary

**In worktree mode:** Other checkouts do not see sandbox changes just because files were edited in
the scoder sandbox. They see changes when commits move the `scoder/*` branch.

That means:

- uncommitted edits are local to the active scoder worktree
- `git log`, `git diff <branch>`, merge, and rebase from another checkout only
  reflect committed state
- if the user expects review or integration from another checkout, commit first

**In `--no-worktree` mode:** Changes are immediate in the working directory.
No commit is required, but there is also no isolation - changes affect the
actual working tree directly.

### 8. Commit at meaningful checkpoints

Inside scoder, committing is not just for final cleanup. It is also how you:

- make progress visible outside the worktree
- create safe restore points before riskier rebases or merges
- allow the user to inspect branch state from another checkout

Commit often:

- After each round of changes is complete before you hand back to the user.
- before asking the user to review results from another checkout.
- before rebasing or merging if you have important in-progress changes.

Avoid churning tiny commits within one round of changes for no reason, but do not hold critical progress
only in uncommitted work if the task is long-running.

### 9. Available tools and libraries

The sandbox includes read-only access to these tools and libraries:

- **R**: user library (`~/R`), `.Rprofile`
- **Java/Maven**: `~/.m2` repository
- **Rust**: `~/.rustup` and `~/.cargo/bin`
- **mise**: `~/.local/share/mise`, `~/.config/mise`, `~/.local/share/mise/shims`

The sandbox also has access to `/dev` (full device passthrough).

## Guidance

- Think of the scoder branch as a disposable integration branch for the session,
  not as the user's long-lived development branch.
- Think of the scoder sandbox as an ephemeral working copy; the branch ref is only
  the committed record of that work. If you don't commit all your changes will be
  lost when the session exits.
- If a command fails because a path is read-only, inspect whether the target is
  intentionally protected or a broken symlink before deciding whether you should
  work around it (unlikely).
- If the user wants the latest upstream state, fetch and rebase or merge
  explicitly rather than using `git pull` by habit.
- If the user talks about what another session can or cannot see, distinguish
  carefully between uncommitted worktree state and committed branch state.
- If you need to access a localhost service from inside the sandbox, the user
  must launch scoder with `--llm-port=<port>`.
- `$HOME` is ephemeral (tmpfs). Any files you create there disappear when the
  sandbox exits.

## Validation

Before relying on this skill's assumptions, check:

- `SCODER_SANDBOX` env var is `1`, or the branch really is `scoder/*`, or the user explicitly said this is a scoder session
- the operation you want is against the sandbox worktree, not the user's source checkout
- the path you want to modify is not one of scoder's protected read-only paths
- the user expectation is clear about committed versus uncommitted visibility

## Troubleshooting

### A write failed with a read-only error

Check whether the target is a protected path like `.github/`, `.gitignore`, a
lockfile, `.agentreadonly`, or `AGENTS.md`. That is different from the project worktree
being non-writable.

### The user can't see your changes

Make sure you have committed them and suggest they checkout the
`scoder/{project}` branch in their IDE or use one of the following commands on the terminal:
* `git diff scoder/{project}`

### The user expects another checkout to see current work

Clarify whether they mean committed branch state or uncommitted worktree state.
If they need another checkout to see the changes through the branch, commit.

### The user reran scoder from the scoder worktree

That is expected to reuse the existing scoder worktree rather than blocking on
its uncommitted changes.

### You detect `--no-worktree` mode

If the user mentions running with `--no-worktree`, or if you notice there's no
`scoder/*` branch but the user says they're in a sandbox:

- Changes are immediate (no commit needed)
- No worktree is created
- `.agentreadonly` protection still applies
- `AGENTS.md` overlay is still created (with sandbox notice, without worktree-specific messages)
- You can edit files directly in the current directory
- `AGENTS.md` is masked from git tracking (same as worktree mode)

### You can't reach localhost services

Host localhost is blocked by default. The user must pass `--llm-port=<port>` to
allow access to a specific localhost port (e.g. for a local Ollama instance).

## References

- [scoder sandbox behavior summary](references/scoder-sandbox-behavior.md)
