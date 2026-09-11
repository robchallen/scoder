---
target-version: 2.4.0
resolved-in: 2.4.0
status: resolved
tags: [issue, sandbox, filesystem]
---

# `/opt` Not Mounted

> **Fixed in 2.4.0.** `buildBwrapCommand` now conditionally binds `/opt`
> read-only, alongside the other conditional system binds (`/lib64`,
> `/sbin`, `/sys`, `/run`). Covered by `opt-mounted`, which compares `ls
> /opt` run on the host directly against the same command run inside the
> sandbox — a real content check, not just "the bind flag is present in
> `--dry-run`" — using the same fake-pasta-shim technique already
> established for `update-alternatives-state-mounted`. No test fixture is
> written under `/opt` itself: on a real host that's root-owned system
> state, and this suite otherwise never mutates anything outside its own
> throwaway temp repos.

## Summary

The actual root cause of the report that led to
[update-alternatives-state-not-mounted](/design/implementation/issues/update-alternatives-state-not-mounted.md):
the user corrected the diagnosis directly — "the binaries it can't access
are those in `/opt`". `/opt` is the FHS location for manually-installed,
self-contained software (IDEs, vendor-shipped JDKs, browsers, most
non-package-manager dev tools), and nothing in `buildBwrapCommand` ever
mounted it. `/etc/alternatives` frequently points *into* `/opt`
(`/etc/alternatives/idea -> /opt/idea-IC/bin/idea.sh` is a common real-world
shape), so a tool resolving correctly through the alternatives symlink
chain could still fail at the final hop, independent of whether
`update-alternatives`'s own administrative state was reachable.

Both fixes are real and independently confirmed (see
`update-alternatives-state-not-mounted` for that one's own verification),
and both landed from the same investigation — the alternatives-state gap
was a genuine bug found along the way, just not the one actually being hit
here.

## Implementation

Conditional, matching the existing `dirExists()`-gated pattern used for
`/lib64`/`/sbin`/`/sys`/`/run`: absent on a host with no `/opt` at all
(common on minimal or non-Linux-FHS systems), the bind is simply skipped.

Read-only, like every other system path — verified directly, not assumed:
a write attempt inside the sandbox (`touch /opt/testfile`) fails with
`Read-only file system`, and `ls /opt` inside the sandbox was confirmed to
list the exact same entries as `ls /opt` on the host.

[IMPACTS](/src/sandbox/builder.ts)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
