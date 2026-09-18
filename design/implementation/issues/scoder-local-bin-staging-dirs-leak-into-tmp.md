---
target-version: 2.5.0
status: open
tags: [issue, sandbox, tmp, cleanup, local-bin]
---

# `scoder-local-bin` Staging Directories Are Never Cleaned Up

## Summary

Every scoder invocation — including `--dry-run`, which never launches a
sandbox — creates a `/tmp/scoder-local-bin.XXXXXX` snapshot of
`~/.local/bin` (`setupLocalBinSnapshot`, `src/git/protection.ts:764`) and
leaves it behind on exit. Nothing removes it: there is no unlink on the
normal exit path, none on the error paths, and no reaper for stale ones
from earlier runs.

On this host each snapshot is **374 MB** (symlinked tools whose targets
are not bound into the sandbox get the real binary copied in), so the
directories accumulate fast.

## Impact

- Observed directly: running `bun test tests/scoder.test.ts` inside a
  scoder sandbox (whose `/tmp` is a 16 GB `--tmpfs`) created ~40 of these
  and filled `/tmp` to 100% before the suite finished, failing the run and
  then breaking every subsequent command that needed temp space. The full
  test suite therefore cannot currently be run from inside a sandbox.
- On a normal host the same leak lands in the real `/tmp`, at ~374 MB per
  scoder run, until a reboot or a tmpfiles sweep clears it.
- `TMPDIR` is not honoured — `createTempDir` goes to `/tmp` regardless —
  so a caller cannot redirect the leak onto a roomier filesystem as a
  workaround.

## Reproduction

```
ls -d /tmp/scoder-local-bin.* | wc -l     # n
scoder --dry-run --no-worktree /bin/bash  # launches nothing
ls -d /tmp/scoder-local-bin.* | wc -l     # n + 1
du -sh /tmp/scoder-local-bin.*            # 374M each, here
```

## Suggested Fix

Not fixed here — pre-existing, and out of scope of the terminal-deadlock
work that surfaced it. Three parts, in order of value:

1. Remove the snapshot directory on exit, on every path (success, error,
   and signal), the same way the pasta pid file and the other
   `scoder-*` temp artefacts are cleaned up.
2. Skip creating it at all under `--dry-run`, which only needs the bind's
   *path* for the printed preview, not its contents.
3. Optionally sweep stale `scoder-local-bin.*` directories at startup
   (only ones not bound by a live sandbox), so existing accumulations
   drain without manual intervention.

## Testing

A test asserting the directory is gone after a `--dry-run` run, and one
asserting `--dry-run` does not populate it in the first place, both fit
the existing `tests/scoder.test.ts` shape.

[HAS_FEATURE](/design/features/local-bin-resolution.md)
[IMPACTS](/src/git/protection.ts)
