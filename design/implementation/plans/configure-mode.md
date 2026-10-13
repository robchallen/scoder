---
target-version: unscheduled
status: draft
tags: [plan, config, skill, onboarding, mcp]
---

# `--configure`: Agent-Guided Setup of `.sandbox/`

> **Draft — for further thought, not scheduled.** No spike.

## Summary

`scoder --configure <agent>` starts a session whose only job is to set up
the project's `.sandbox/` with the user: the agent is started with an
instruction to use an injected `configure-scoder-sandbox` skill, which asks
structured questions about the project, inspects it, and proposes the
minimal `readonly`, `readwrite`, `ports` and `env` (and, where wanted,
`.mcp.json`) for the project's nature. When the configure session ends and
the user accepts the result, scoder launches a normal session with the new
configuration.

## Motivation

Getting `.sandbox/` right today means knowing scoder's defaults, which
paths each toolchain needs, which ports a local service uses, and which env
names a provider wants — and discovering gaps one failed build at a time.
An agent can do most of that discovery (it can see `pom.xml`, `pyproject`,
`DESCRIPTION`, `package.json`) and ask the user only what it cannot see:
which IDE, which local LLM or MCP service, which credentials. It is the
same reasoning that moved MCP setup into a skill — conversational, varies
per user — applied to the whole sandbox config.

## Design

### The session

- `--configure` is a scoder option (before the tool name), for an agent
  preset: `scoder --configure pi`, `scoder --configure claude`.
- The agent gets an initial instruction — "help the user configure scoder
  for this project using the `configure-scoder-sandbox` skill". Passing a
  first prompt is agent-specific (a positional prompt for `claude`; to be
  checked for pi and others), so presets gain an optional
  `initialPromptArgs(prompt)`; where an agent has none, the instruction
  goes in the sandbox's `AGENTS.md` note instead.
- The `configure-scoder-sandbox` skill is embedded in the binary and
  injected the same way `working-in-a-scoder-sandbox` is (the `~/.agents`
  snapshot, and `~/.claude/skills` for Claude Code).

### Writable config, without letting the agent edit its own limits

The request is a session with `.sandbox/` read-write. Proposed refinement:
the agent edits a **working copy**, not the real directory.

- scoder stages a copy of `.sandbox/` in the session staging root and binds
  that read-write at the project's `.sandbox/` path; the real directory is
  not mounted writable at all.
- When the session ends, scoder (on the host, outside the sandbox) shows the
  diff — file by file — and applies it only on the user's confirmation;
  otherwise nothing changes.
- scoder validates the result with the same parsers a normal session uses
  (port syntax, `$HOME/` rule for `readwrite`, env names/patterns, readonly
  paths existing) and refuses to apply an invalid one, saying why.

Same outcome for an honest session; and an agent that goes wrong — or a
prompt injection reaching it — cannot widen the sandbox without the user
seeing exactly what changed. Also keeps `--configure` usable on a project
whose config the user wants reviewed rather than rewritten.

### Then a normal session

On acceptance, scoder re-launches the same command without `--configure`,
now under the new config (or exits, if the user prefers — open question).

### The skill: `configure-scoder-sandbox`

Structured, short, and grounded in what the project shows:

1. **Look first.** Inspect the project and propose before asking:
   build files (`pom.xml`/`build.gradle` → Java; `pyproject.toml`/`uv.lock`
   → Python; `package.json` → Node; `Cargo.toml` → Rust; `DESCRIPTION`/
   `.Rproj` → R; `*.tex` → LaTeX), existing `.sandbox/`, `.mcp.json`,
   lockfiles worth protecting.
2. **Ask only what it cannot see:** which IDE (`--ide`), local LLM or other
   host services (ports), which providers/credentials the session needs
   (env names — never values), extra directories outside the project
   (read-only dependencies vs read-write caches/output).
3. **Map to minimal config**, knowing scoder's defaults so it adds nothing
   redundant — e.g. `~/.m2` is already bound read-write and `~/.cargo/bin`,
   uv tools and mise are already bound, so a Java or Rust project often
   needs nothing extra in `readwrite`; a Python project with a non-default
   cache might. A per-nature table in the skill, kept in step with
   `buildExtraBinds`.
4. **Explain each entry** to the user as it is added, and what it opens up
   (read-write paths and forwarded ports are the ones that widen the
   sandbox).
5. **MCP** (`.mcp.json`): the per-IDE and host-service setup moves here
   from `working-in-a-scoder-sandbox`, which keeps a short pointer — the
   configure session is where connections are normally set up.
6. Optionally offer to save the choices as the user's defaults in
   `~/.config/scoder/` for new projects — a host-side step, done by scoder
   after confirmation, like the `.sandbox/` diff.

## Open questions

1. After acceptance: re-launch a normal session automatically, ask, or exit?
2. Should `.mcp.json` edits go through the same diff-and-confirm (it is a
   project file the agent could write anyway in a normal session)?
3. How each agent takes an initial prompt (`claude` positional; pi, opencode,
   copilot to check), and the fallback via the `AGENTS.md` note.
4. Whether `--configure` also covers `~/.config/scoder/` directly ("set my
   defaults") or only ever the project.
5. Where the per-nature defaults table lives so it cannot drift from the
   code — generated from `buildExtraBinds` at build time, or tested against
   it.

[HAS_FEATURE](/design/features/config-defaults.md)
[HAS_FEATURE](/design/features/agents-skills-snapshot.md)
[HAS_FEATURE](/design/features/tool-presets.md)
