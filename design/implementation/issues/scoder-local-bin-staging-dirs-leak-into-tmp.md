---
target-version: 2.5.0
resolved-in: 2.5.0
status: resolved
tags: [issue, sandbox, tmp, cleanup, local-bin]
---

# `scoder-local-bin` Staging Directories Are Never Cleaned Up

> **Fixed in 2.5.0** by `session-temp-root`, which replaced the seven
> independent `/tmp/scoder-<concern>.XXXXXX` prefixes with one
> `/tmp/scoder-<id>` root per run, removed on every exit path including
> `--dry-run`'s. Covered by `session-temp-root-cleaned`, which asserts the
> root count is unchanged after both a normal run and a `--dry-run`.
>
> Fixed as suggested below, but not in the shape suggested: the fix is
> structural rather than one teardown added for this one directory.
> Per-concern cleanup was the cause — each staged artifact needed someone to
> remember a matching teardown, and `~/.local/bin` and the AGENTS.md overlay
> were the two nobody did. Taking the suggested part 1 alone would have left
> the next staged artifact in the same position.
>
> Suggested part 2 (skip the snapshot entirely under `--dry-run`) was **not**
> done. `--dry-run` is worth keeping honest about what a real run would stage,
> and the snapshot is also what the `local-bin-symlink-target-mapped` test
> inspects; cleanup afterwards gets the same result without making `--dry-run`
> a different code path. Suggested part 3 (a startup sweep of stale
> directories) was also not done, and is now cheap to add if it is ever wanted
> — the `scoder-` prefix on the root exists partly to keep that option open.
> Note that it will not drain the accumulations that already exist under the
> *old* prefixes; those need a manual `rm -rf /tmp/scoder-local-bin.*` once.
>
> On the host this was fixed on: 6,919 abandoned `scoder-local-bin.*`
> directories and 6,044 `scoder-agents-md.*` ones.

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
[HAS_FEATURE](/design/features/session-temp-root.md)
[IMPACTS](/src/git/protection.ts)
