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

## Direction: `.sandbox/` as the single arbiter

Decided in discussion (2026-10-13): `--configure` is not only a helper for
writing config — it is what makes it reasonable for **`.sandbox/` to be the
one place that says what a session can see**, minimally, per project.
Today scoder hard-codes a set of host paths into every session regardless
of project; under this direction they move out of the code and become
explicit grants in `.sandbox/readonly` / `.sandbox/readwrite`, added by the
configure session only where the project needs them. A non-Java project no
longer gets read-write `~/.m2`; a project without R no longer sees `~/R`.

### What moves, and what stays in code

Bound for every session today (`buildExtraBinds`), and **moving to explicit
grants**:

| Path | Today | Becomes, when the project needs it |
|---|---|---|
| `~/.m2` | read-write | `readwrite` (Java/Maven) |
| `~/R`, `~/.Rprofile` | read-only | `readonly` (R) |
| `~/.rustup`, `~/.cargo/bin` | read-only | `readonly` (Rust) |
| `~/.local/share/mise`, `~/.config/mise` | read-only | `readonly` (mise users) |
| `~/.local/share/uv/tools`, `~/.local/share/uv/python` | read-only | `readonly` (uv tools used in the session) |
| `~/.npmrc`, `~/.pypirc` | read-only | `readonly` (Node / Python publishing) |
| `~/.agents` (snapshot) | read-only | `readonly` — and **individual skills** can be granted selectively rather than the whole directory |
| `~/.local/bin` (resolved snapshot) | read-only | open question — likely a default grant, narrowed by the configure skill |

Borderline — general developer plumbing most sessions want; candidates for
the **shipped defaults** (`src/defaults/readonly`, so still visible and
removable per project) rather than code: `~/.gitconfig`, `~/.config/gh`,
fonts, `mimeapps.list`, GTK themes/icons (the last three only matter to
GUI presets, so arguably belong with them).

**Stays in code**: sandbox mechanics (system dirs, `/dev`, `/run`, `/tmp`,
resolv.conf, passwd/group, the project and git dir, the worktrees parent),
**agent preset config paths** (`~/.pi`, `~/.claude`, ...) and **IDE preset
paths** (managed workspaces, extensions trees) — these follow from which
tool is launched, not from the project — plus anything `--bind NAME` adds.

### Consequences in the file formats

- **`readonly`'s `$HOME/...` lines are currently "Eclipse dependency
  projects"** as well as read-only binds: each is collected into
  `dependencyDirs` and passed to Eclipse as `-importProject`, and the plugin
  then searches it recursively for `.project` files. Moving `~/R` or
  `~/.m2` there would make them Eclipse imports (and slow scans). The
  format needs to tell the two apart — e.g. a marker on dependency-project
  lines, or a separate `dependencies` file — before anything moves.
- **Files, not only directories.** `readonly`'s `$HOME/...` lines must
  point at an existing directory today; `~/.gitconfig`, `~/.Rprofile`,
  `~/.npmrc` and `mimeapps.list` are files. Single-file binds need
  supporting.
- **Overlap checks** that refuse `readonly`/`readwrite` entries colliding
  with scoder's fixed binds shrink with the fixed list — what remains to
  protect is the agent/IDE preset paths.
- **Symlinks at configure time.** The skill resolves symlinks while
  configuring (a `~/.local/bin` tool pointing into a uv venv, a skills dir
  linking elsewhere) and grants the resolved targets, keeping the set as
  small as possible instead of granting whole trees to be safe.

### Migration

This breaks existing sandboxes that rely on the implicit binds (a Java
project that never listed `~/.m2`). Acceptable while scoder's users are
few — one `--configure` session per project fixes it. To make the break
loud rather than mysterious: a format version marker in `.sandbox/` (e.g.
in `README.md` or a `version` file); a project on the old format gets a
start-up message — "this project's sandbox config predates explicit
grants; run `scoder --configure <agent>`" — and, until then, either the old
implicit binds (a grace period) or none (open question).

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

0. Migration: honour the old implicit binds for unconverted projects for a
   while, or drop them at once with the start-up message?
0. `~/.local/bin`: default grant (it is how most host tools are reached) or
   per-project?
0. How `readonly` distinguishes a plain read-only grant from an Eclipse
   dependency project.
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
