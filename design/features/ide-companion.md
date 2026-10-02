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

Running an agent (`pi`, `claude`) alongside an IDE (`rstudio`, `eclipse`,
`vscode` — any registered preset, following the same pattern), bridged via
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
  get the binds it would need (a display, for a GUI IDE) and would just
  fail silently in its own background job with no diagnostic at all.
- **The exec target becomes a shell wrapper, not the primary tool's own
  binary, when `--ide` is set** (`wrapWithIdeBackground`, same convention
  as the existing `wrapWithFdShim`: arguments passed as positional
  parameters, never interpolated into the script string, so a tool
  argument containing shell metacharacters is never reparsed as syntax).
  Backgrounds the IDE under `setsid`, with stdin from `/dev/null` and
  stdout/stderr redirected to `/tmp/scoder-ide.log` rather than left
  attached to the terminal. Redirecting the fds alone is not enough on its
  own — reported directly, IDE error output still reached the console
  mid-session despite it: a JVM's native crash handler or a GTK/X11 error
  dialog can write straight to `/dev/tty` (the controlling terminal)
  rather than its own inherited stdout/stderr, which `>"$IDE_LOG" 2>&1`
  does not catch. `setsid` makes the IDE its own session leader with no
  controlling terminal at all, so a direct `/dev/tty` open from inside it
  fails instead of reaching the visible console — confirmed directly that
  it still leaves `$!` as the IDE's own real pid under bwrap's own
  `--new-session` (no extra fork layer to account for), so this needed no
  change to the kill/wait logic elsewhere in the same script. Runs the
  primary tool in the foreground, then `wait`s for the IDE before exiting
  with the primary tool's own exit status — so scoder reports the primary
  tool's exit code, not the IDE's, regardless of which one finishes
  first.
- **A notice, a clear screen, and an ENTER prompt when the primary tool
  finishes first.** If the primary tool (e.g. `pi`) exits while the IDE is
  still running, the `wait` above can block for a while with nothing on
  screen — indistinguishable from a hang otherwise. Right after the
  primary tool exits, `kill -0` checks whether the IDE is still alive (a
  benign race if it exits moments later — the message is just slightly
  premature, not wrong) and, if so:
  - **Clears the screen** (`ESC[H ESC[2J`), because the terminal has just
    been handed back by a full-screen agent TUI whose last frame otherwise
    sits there looking live. Scrollback is deliberately *not* cleared (no
    `ESC[3J`) — the session transcript is still worth having — and the
    escape is guarded on stderr being a tty, so a redirected log never
    collects control codes.
  - **Names the IDE and its pid** in the notice
    (`Waiting for attached IDE to close: eclipse (pid 1234)`), styled like
    scoder's own `info()` (`src/utils/logger.ts`). With several IDE windows
    open it is otherwise not obvious which one this terminal is waiting on.
  - **Offers ENTER to close it.** Pressing ENTER asks that IDE to close,
    which is also the reliable way to identify it: the window that
    disappears was the attached one. A second ENTER escalates to `SIGKILL`
    (process and children), for an IDE sitting on a modal dialog or
    otherwise ignoring the first. The signal is a shutdown *request*, not
    the IDE's own File → Exit — what happens to unsaved editor state is the
    IDE's own business, which is why the prompt says "ask".

    **Which signal, and to whom, is per-preset** (`ToolPreset.ideShutdown`
    in `src/types.ts`), because the two IDEs measured want opposite things:

    | preset | signal | order | why |
    | --- | --- | --- | --- |
    | `eclipse` | `SIGTERM` | `children-first` | `/opt/eclipse/eclipse` is a thin launcher; the JVM child is what owns the window, and signalling only the launcher orphans it. `SIGHUP`/`SIGINT`/`SIGUSR1` do not close Eclipse at all. |
    | `rstudio` | `SIGHUP` | `process-first` | `SIGTERM` does not close the main process; `SIGHUP`, `SIGINT` and `SIGUSR1` all do. `rsession` is a direct child, so signalling children first killed the user's R session and left the IDE standing — RStudio closes its own `rsession`. |

    `SIGHUP` is preferred over `SIGINT` for RStudio because "the terminal
    this was attached to has gone away" is precisely what has happened, and
    it carries no risk of being read downstream as "interrupt the running
    computation". A preset that says nothing gets `DEFAULT_IDE_SHUTDOWN`
    (`SIGTERM`, `children-first`) from `src/sandbox/builder.ts`. Both
    measured values are pinned by
    `ide-shutdown-presets-record-measured-signals`, so a later tidy-up
    cannot quietly collapse them into one shared default. `vscode` is
    currently one that says nothing: all of Electron's children fork
    from the main process, so the prior is TERM/`process-first` —
    children-first would signal the renderer and GPU helpers out from
    under main and lose its save-on-exit — but a prior is exactly what
    this table refuses to list; the vscode plan's checklist measures it
    into this table or the preset.
  - The read loop is **not** gated on stdin being a tty; only the prompt
    is. With stdin closed or on `/dev/null`, `read` returns EOF immediately
    and the script falls through to the same plain `wait` as before rather
    than spinning — covered by
    `ide-companion-waits-out-ide-without-stdin`. `wait`'s own stderr is
    redirected because bash reports a `SIGKILL`ed background job there
    ("line 1: 1234 Killed ..."), which is noise the user cannot act on.
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

## Nothing outlives the sandbox

When a session ends, anything still running inside it is terminated.

This is not automatic, and the reason is structural. scoder does not unshare
the PID namespace — pasta attaches to the network namespace from outside, see
[ADR 0001](/architecture/decision-records/0001-sandbox-uid-and-networking-composition.md)
— so bwrap's `--die-with-parent` reaches only its own immediate child. The
companion IDE is deliberately started under `setsid`, so that an IDE keeping
its controlling terminal cannot write crash handlers into the agent's
session, and a `setsid` process is reparented to init when its parent dies.
Verified directly: a `setsid` child wrote its marker file eight seconds after
bwrap had exited. Reported as **seven** accumulated RStudio instances on one
machine, each carrying an Electron stack, an `rsession`, a Tomcat and a
language server.

`launchSandbox` therefore records the sandbox's mount namespace while the
session is alive and, after it exits, terminates everything still in it.

**By namespace, not by tracked pid.** An earlier attempt recorded the IDE's
pid and signalled its process group. That left xpra's `Xvfb` and its
`dbus-daemon` running after every GUI session, because xpra forks both into
sessions of their own, and no amount of extra grace period helped. Membership
of the sandbox's mount namespace is exactly the property "belongs to this
sandbox": nothing else can be in it, and nothing in it belongs to anyone
else.

**The namespace is pinned by an open fd**, which is load-bearing rather than
incidental. A namespace is freed once its last process leaves, and the kernel
may reuse its inode number — so comparing recorded ids after the fact could
match an unrelated namespace and signal someone else's processes. Holding an
fd keeps it alive and its id unique. Only the caller's own uid is ever
considered.

Normal exits reach none of this: the entrypoint does not return until both
programs have finished, so there is nothing left and the cost is one scan of
`/proc`.

**Not covered:** `SIGKILL` to scoder, which runs no teardown at all, and
`SIGTERM`, which scoder does not handle (`FORWARDED_SIGNALS` covers
`SIGWINCH`, `SIGINT`, `SIGQUIT` and `SIGTSTP`) so it terminates the process
outright. `design/prototype/scoder-cleanup.sh` finds and removes what those
leave behind.

## The session log, readable from outside

Every entry-point session writes exactly one log — the IDE's output under
`>/tmp/scoder-ide.log`, or, whenever an xpra server is running, everything
including the IDE's output under `/tmp/scoder-xpra.log`, because that is
where the server's own stdout goes. Both names used to resolve to the
sandbox's private `/tmp` tmpfs: the path was fixed so a diagnostic could
name it, but reading it meant opening a shell inside the session whose GUI
was misbehaving — from the terminal already showing that GUI not appearing.

The log is therefore a staged file bound read-write at its own sandbox path:
same name inside the sandbox (so `entrypoint.sh`, the agent-facing message
and the existing tests all keep working untouched), and on the host at
`<session staging root>/tmp/scoder-<name>.log`, which scoder prints at
startup — `IDE log on the host: …` for a companion with no xpra, `xpra log
on the host: …` whenever xpra is running. The host path lives under the
session staging root, so it dies with the session like everything staged
there; the startup line is telling you where to `tail` *while* things are
wrong, not where the post-mortem is archived. `SCODER_KEEP_SESSION_TMP`
keeps the whole staging root, log included, if the session already ended.
Which of the two files a given session uses is one decision shared between
the builder and the startup message (`entrypointLogDest`), not two
statements that can drift.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./tool-presets.md)

[HAS_TEST](../test-scripts/validation-suite.md)
