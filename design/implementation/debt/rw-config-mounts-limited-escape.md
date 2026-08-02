---
target-version: 2.2.0
status: draft
tags: [debt, sandbox, security]
---

# Read-Write Config Mounts Create Limited Escape

## Summary

Some tool presets mount data/cache directories as read-write (e.g.,
opencode's `~/.local/share/opencode`, claude's `~/.claude`). The sandboxed tool
can modify persistent state on the host.

## Rationale

These tools need to persist session data, databases, and caches. The
read-write mounts are intentional and necessary for normal operation.

## Impact

A limited escape from the sandbox's filesystem isolation. The tool can
write to its own data directories on the host, though not to arbitrary
locations.

### Escalated in 2.2.0: `~/.claude` is read-write

`~/.claude` was changed from `ro-bind` to `bind` because Claude Code writes
there throughout a session (todos, history, shell snapshots, stats) and fails in
many flows when it cannot. This is a larger exposure than the other rw mounts,
because `~/.claude` is not purely data — it holds **host-executed
configuration**:

- `settings.json` — supports `hooks`, which run arbitrary shell commands on the
  **host** the next time the user runs Claude Code outside the sandbox
- `skills/`, `plugins/` — instructions and code loaded into later sessions
- `CLAUDE.md` — global instructions applied to every project

So a sandboxed agent that writes `~/.claude/settings.json` can arrange host
command execution outside the sandbox. This is not a theoretical distinction
from writing to a cache directory: it converts a filesystem-isolation escape
into arbitrary host code execution, deferred to the user's next non-sandboxed
run.

The trade-off was accepted deliberately: with a read-only bind the tool does not
degrade gracefully, it breaks. Recording it so the cost is explicit rather than
implied by a one-word bind type.

## Possible Mitigations

Not implemented; listed so the option space is on record.

1. **Selective binds** — bind only the subdirectories Claude Code writes
   (`history.jsonl`, `todos/`, `shell-snapshots/`, `projects/`) read-write and
   keep `settings.json`, `skills/`, `plugins/`, `CLAUDE.md` read-only. Most
   targeted, but couples scoder to Claude Code's internal layout, which changes
   between versions.
2. **Overlay/copy-on-write** — snapshot `~/.claude` into `/tmp` and bind the
   copy read-write, discarding changes at session end (the
   `agents-skills-snapshot` pattern). Fully protects the host but loses session
   persistence, which is part of why the directory is bound at all.
3. **Protect the executable surface only** — a read-write bind of the directory
   with read-only overlays on the specific host-executed files. Bind ordering
   already supports this (`--ro-bind` after the parent `--bind`), and it is the
   same mechanism `infrastructure-protection` uses for the workspace.

[IMPACTS](/src/tools/presets.ts)
[HAS_FEATURE](/design/features/tool-presets.md)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
