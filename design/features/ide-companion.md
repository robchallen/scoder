---
target-version: 2.5.0
status: draft
tags: [feature, ide, sandbox]
---

# `--ide`: A Companion IDE Alongside the Primary Tool

## Summary

`scoder <tool> --ide <name>` builds one sandbox holding both `<tool>` (in
the foreground, connected to the terminal) and `<name>` (in the
background) — e.g. `scoder pi --ide rstudio` launches RStudio in the
background and `pi` in the foreground, in the same sandbox instance. Both
must exit before scoder shuts down. `--ide` is accepted either before or
after the primary tool's own name.

## Motivation

Running an agent (`pi`, `claude`) alongside an IDE (`rstudio`, and in the
future others like `spyder` or `vscode`) inside one sandbox, bridged via
MCP, only works today if the user manually launches the IDE, then
manually launches the agent from inside the IDE's own embedded terminal.
`--ide` makes this one command, and generalizes past `rstudio`
specifically: any tool with a registered preset can be named as a
companion, following the same pattern.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/builder.ts#wrapWithIdeBackground)
[IMPLEMENTED_BY](/src/index.ts)
[IMPLEMENTED_BY](/src/cli/parse-args.ts)

- **One sandbox, not two.** The companion IDE's own `configBinds` (and, if
  it defines one, `resolveArgs`) run exactly as they would if it were the
  primary tool — the same preset objects, unmodified — and their
  binds/dirs/env are merged into the one bwrap invocation alongside the
  primary tool's own. Deduplicated on merge (`type`+`source`+`dest` for
  binds, exact string for dirs): a preset shared between the two — `pi`'s
  own binds also included by `rstudio`'s preset, since `pi` can run in
  RStudio's embedded terminal too — would otherwise produce literal
  duplicate `--dir`/`--bind` flags. Harmless to bwrap either way (a
  repeated bind is a no-op), but not worth leaving in the built command.
- **A `--ide` naming a tool with no registered preset is a hard error**,
  not a silent generic-sandbox launch. An unregistered tool has no way to
  get the binds it would need (X11 access, for a GUI IDE) and would just
  fail silently in its own background job with no diagnostic at all.
- **The exec target becomes a shell wrapper, not the primary tool's own
  binary, when `--ide` is set** (`wrapWithIdeBackground`, same convention
  as the existing `wrapWithFdShim`: arguments passed as positional
  parameters, never interpolated into the script string, so a tool
  argument containing shell metacharacters is never reparsed as syntax).
  Backgrounds the IDE (stdout/stderr redirected to a log file rather than
  left attached to the terminal — an Electron/GUI app's own console
  chatter would otherwise interleave with the primary tool's interactive
  session), runs the primary tool in the foreground, then `wait`s for the
  IDE before exiting with the primary tool's own exit status — so scoder
  reports the primary tool's exit code, not the IDE's, regardless of
  which one finishes first.
- **A notice when the primary tool finishes first.** If the primary tool
  (e.g. `pi`) exits while the IDE is still running, the `wait` above can
  block for a while with nothing on screen — indistinguishable from a
  hang otherwise. Right after the primary tool exits, `kill -0` checks
  whether the IDE is still alive (a benign race if it exits moments
  later — the message is just slightly premature, not wrong) and, if so,
  prints `Waiting for attached IDE to close...`, styled like scoder's own
  `info()` (`src/utils/logger.ts`), before blocking on `wait`.
- **No change needed to signal forwarding.** Confirmed directly: a
  backgrounded job in a non-interactive `bash -c` script shares the
  script's own process group (job-control process groups only apply to an
  interactive shell) — built a real test with a foreground and a
  backgrounded `sleep`, sent `SIGINT` to the whole group, both died.
  `installSignalForwarding`'s existing `process.kill(-childPid, signal)`
  already reaches both the primary tool and the backgrounded IDE without
  any change.
- **Verified end-to-end, not just in `--dry-run` output**: a real run
  (fake pasta shim, since this environment has no working
  `/dev/net/tun`) with a primary tool that exits immediately and a
  companion that sleeps before writing a marker file confirmed (a) scoder
  does not return until the companion's sleep finishes, (b) the marker
  file exists afterward (the companion ran to completion, not cut off),
  and (c) scoder's own exit code matches the primary tool's, not the
  companion's.

## `--ide` Accepted On Either Side Of The Tool Name

`--allow-ssh` and the rest of scoder's own flags only parse before the
tool name — everything after it becomes the tool's own argv, unexamined.
`--ide` is different on purpose: `scoder pi --ide rstudio` was the
requested usage, so the parser scans the tool's own argv specifically for
`--ide`/`--ide=NAME` and pulls it out, leaving everything else as the
tool's own args, untouched. `scoder --ide rstudio pi` also works, parsed
by the ordinary flag-parsing loop before the tool name is reached.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./tool-presets.md)

[HAS_TEST](../test-scripts/validation-suite.md)
