---
target-version: 2.7.0
status: draft
tags: [feature, sandbox, overlay, agents-md]
---

# Live File Overlays

## Summary

A host file is presented inside the sandbox with extra, sandbox-only content
added, bound read-only, and **re-rendered whenever the host file changes** —
so an edit made outside a running session reaches the agent inside it.

Two files use this today:

| file | injection | position |
|---|---|---|
| `AGENTS.md` | scoder's "you are in a sandbox" section | append |
| `.Rprofile` (rstudio preset) | `btw::btw_mcp_session()`, so an R session registers itself with MCP | prepend |

## Motivation

Both halves of this already existed and neither was sufficient alone. The
AGENTS.md overlay composed a file with injected content but rendered it
exactly once, so editing `AGENTS.md` on the host did nothing until the session
was restarted — for the file whose entire purpose is telling the agent how to
behave, that is the wrong way round: the moment you most want to correct an
agent's instructions is while it is working. The `resolv.conf` snapshot
refreshes on change but injects nothing.

The second case is what made it worth generalising rather than patching
AGENTS.md. An R project needs

```r
if (interactive()) {
  btw::btw_mcp_session()
}
```

in its `.Rprofile` for an RStudio session in the sandbox to register itself
with MCP. Committing that to every project that might one day be opened in a
sandbox is noise for everyone not using scoder, and has to be kept in step by
hand whenever the project's own `.Rprofile` changes.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/overlays.ts)

```ts
interface LiveOverlay {
	label: string;                      // named in log lines
	source: string;                     // host file; need not exist
	dest: string;                       // sandbox path, bound read-only
	injection: string;                  // sandbox-only content
	position: "prepend" | "append";
}
```

- `renderOverlay` composes the staged file and returns whether it changed
- `setupOverlays` renders a set and returns their read-only binds
- `startOverlayWatcher` re-renders on change, started by `launchSandbox`
  alongside the `resolv.conf` watcher and stopped in the same `finally`

A preset declares its own with `ToolPreset.fileOverlays(hostProjectDir,
sandboxProjectDir)`. That is separate from `configBinds` because the project
directory is not known when `configBinds` runs, and these are almost always
project files. Both the primary tool's preset and the `--ide` companion's are
consulted — a GUI preset is the same preset either way.

### Always rendered from the source

The one invariant that matters. Appending to the previous render rather than
recomposing from the host file would duplicate the injection on every
refresh, and the bug would not appear until the host file had been edited
twice. The test asserts the injection appears exactly once after several
rounds, not one.

### Position

`AGENTS.md` appends, so the project's own instructions lead and scoder's notes
follow. `.Rprofile` prepends, because R evaluates the file top to bottom and a
session registration has to run before anything the project does — appending
would be silently useless.

A missing source renders as the injection alone, with no leading blank line,
and the overlay starts tracking the file if it appears later.

### When the host file does not exist

**An empty file is created on the host.** That is unavoidable rather than
chosen: a bind needs a mountpoint, and the project directory is bound
read-write, so if the file is absent bwrap creates one there — which is the
host's own directory. The file appears either way.

What scoder controls is *how*. Verified directly: bwrap's own mountpoint is
created `-r--r--r--`, leaving an empty **read-only** `.Rprofile` in the
project that the user cannot edit without `chmod`. So `ensureOverlaySources`
creates it first, with ordinary `-rw-r--r--` permissions, and says so. The
side effect on the user's project becomes a deliberate act rather than a
consequence of how bwrap happens to work.

It is called from `launchSandbox`, not at setup time, so `--dry-run` never
reaches it — confirmed that a dry run leaves the project untouched.

Two consequences worth knowing:

- The file **persists after the session**. For `AGENTS.md` this is long-
  standing behaviour.
- `AGENTS.md` is masked from git with `skip-worktree` (see
  `agents-md-overlay`), but **a created `.Rprofile` is not** — it will show as
  untracked. That is arguably right, since an R project probably wants one,
  but it is not hidden.

### Polled, not inotify

Two seconds, matching the `resolv.conf` watcher. inotify instances are a
per-*user* kernel resource — `fs.inotify.max_user_instances` defaults to 128
and is shared with the user's whole desktop — and this project has already had
one report of that budget being exhausted, with baffling symptoms (see
`xpra-gui-isolation`, where xpra's own usage was cut from 8 instances to 1).
Spending more of it to notice an edit a second sooner is a poor trade.

`SCODER_OVERLAY_POLL_MS` overrides the interval.

## Known Gaps

- **The sandbox cannot edit these files**, by design — they are bound
  read-only, and the AGENTS.md injection says so. An agent that wants a change
  must ask.
- **No overlay is applied to a file the sandbox needs to write.** The pattern
  only suits files that are read.
- **`.Rprofile` is unverified against a real RStudio session.** The rendering
  is tested; whether `btw::btw_mcp_session()` does the right thing from a
  sandboxed RStudio is not, and depends on `btw` being installed in the
  project's R library.

[HAS_FEATURE](./agents-md-overlay.md)
[HAS_FEATURE](./tool-presets.md)
[HAS_TEST](../test-scripts/validation-suite.md)
