---
target-version: 2.5.0
status: open
tags: [issue, git, agents-md, low-priority]
---

# The AGENTS.md skip-worktree Mask Is Repo-Global, Not Per-Session

## Summary

`addGitExclude`/`removeGitExclude` (`src/git/protection.ts`) set and clear
`--skip-worktree` on `AGENTS.md` in the repository index, which is shared
state. The last session to touch it wins, in both directions:

- A second scoder session in the same repo clears the mask for a still-running
  first one when it exits, so that session's `AGENTS.md` starts showing as
  modified mid-flight. Observed directly.
- A signal-terminated session skips the `finally` and leaves the mask set —
  already noted under the `no-explicit-signal-trap` debt record.

Low priority: the visible effect is a dirty `git status` inside a live sandbox,
and restarting the session restores the mask.

## Suggested Fix

Make the flag refcounted or session-aware rather than a bare set/clear — e.g.
only clear it on exit if this session was the one that set it (it was already
`H` beforehand), which also fixes the signal case for any session that is not
the last one out.

[HAS_FEATURE](/design/features/agents-md-overlay.md)
[IMPACTS](/src/git/protection.ts)
[IMPACTS](/src/index.ts)
