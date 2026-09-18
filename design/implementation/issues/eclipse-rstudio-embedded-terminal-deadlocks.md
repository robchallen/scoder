---
target-version: 2.5.0
status: draft
tags: [issue, sandbox, dev, eclipse, rstudio, terminal, pty]
---

# Eclipse and RStudio Embedded Terminal Panes Deadlock in the Sandbox

## Summary

Opening a terminal pane inside either GUI preset's own embedded terminal
(Eclipse's Terminal view, RStudio's Terminal pane) hangs indefinitely inside
a scoder sandbox. Eclipse surfaces this as a "Terminal Reconnection Failure"
dialog reporting a generic `system error 2 (No such file or directory)`;
RStudio's dialog is similarly generic. Neither Eclipse's own Error Log nor
any other log records an exception when this happens — because, as
established below, nothing actually throws. The dialog is very likely
Eclipse's own internal timeout giving up on an operation that is genuinely
stuck, not a report of a real failure.

Confirmed unaffected: the primary tool's own terminal (whatever inherits
scoder's real stdio, e.g. `pi` in a plain shell) works normally throughout —
this is specific to a GUI preset spawning its *own*, separate terminal
process from inside the sandbox.

**Not yet resolved.** This document is the investigation record so far, plus
a concrete next-steps plan, written at the point of handing off to a fresh
debugging session inside the sandbox.

## What's Confirmed, Not Theory

Each item below was verified directly — either by an agent running alongside
the live, currently-stuck Eclipse process (with full visibility into the same
sandbox), or by an independent, isolated `bwrap`/`pasta` reproduction outside
any live session. Nothing here is inferred from log text alone without a
direct check.

- **Ordinary PTY allocation works, repeatedly, in the exact same live
  session.** `ls -la /dev/pts` on the live, stuck session showed six real pty
  slave devices (numbered `0`–`5`), created at different points over hours,
  all owned by the real host uid. Something in that same sandbox instance
  has successfully allocated ptys many times over — this rules out "PTY
  allocation is broken in the sandbox" as a category.
- **The deadlock is a real hang, not a clean error.** `jstack`, run
  correctly from *inside* the same sandbox (a first attempt from the host
  failed — see below), showed:
  - Two of Eclipse's own child `bash` processes with stdin/stdout/stderr on
    **anonymous pipes**, not a tty (`/dev/pts/*`) — i.e. spawned via a plain
    `ProcessBuilder`/pipe-based mechanism, not one that allocates a PTY.
  - Both `bash` processes blocked in the kernel wait channel
    `anon_pipe_read`, waiting for input that will never arrive.
  - Eclipse's own `org.eclipse.terminal.view.ui.streams.InputStreamMonitor`
    threads blocked in `Object.wait()`, waiting for data to relay across —
    the Java-side half of the same stuck pipe.
- **`jstack` from the host fails with "state is not ready to participate in
  attach handshake."** This is a namespace/filesystem-visibility problem,
  not evidence about the actual bug: the JVM's attach mechanism creates a
  trigger file and a Unix socket under `/tmp`, and the sandboxed JVM's `/tmp`
  is a separate, unshared `--tmpfs /tmp` the host cannot see into. `jstack`
  must be run from a process already inside the same sandbox instance (e.g.
  by asking the co-located `pi` agent to run it) — doing so worked cleanly.
- **A real, separate devpts anomaly exists, was fixed, but does not resolve
  this.** `stat /dev/pts/ptmx` (the devpts-*internal* multiplexer node,
  exposed only because the whole `/dev/pts` directory is bound in) showed
  mode `0000` on the reporting host, while the top-level `/dev/ptmx` (bound
  separately) is mode `0666` and demonstrably works. Fixed by shadowing
  `/dev/pts/ptmx` with a later `--dev-bind` sourced from the working
  top-level device (`src/sandbox/builder.ts`, commit `2d0da64`) — confirmed
  the shadow took effect (`/dev/pts/ptmx` now reads mode `0666` live in the
  same session) — but **the terminal pane still deadlocks after this fix**.
  Whatever opens `/dev/pts/ptmx` specifically is not the (sole) blocker.

## Confirmed Since the Devpts Fix

After shadowing `/dev/pts/ptmx` (above), the terminal still deadlocks, and
further live inspection of the stuck session added:

- **Eclipse's terminal shell is confirmed on anonymous pipes via raw procfs
  data**, not just a `jstack` summary: `/proc/<bash-pid>/fd/{0,1,2}` all
  resolve to `pipe:[...]` targets, not a `/dev/pts/*` tty.
- **A real, specifically-named Eclipse class is very likely the actual
  gate**: `org.eclipse.cdt.utils.pty.PTY.isSupported()` — CDT's own check
  for whether its native, JNI-backed PTY support is usable. If that check
  returns false, CDT's terminal connector falls back to a plain
  `ProcessBuilder`/pipe spawn *by design*, not as an error path — which
  would explain both the pipe-based spawn and the total absence of any
  logged exception. This check is very likely about whether CDT's own
  bundled native library (a JNI `.so`) loaded successfully — a question
  entirely separate from whether `/dev/ptmx` itself works, and not yet
  directly confirmed either way.

## Claims That Did Not Hold Up

Two rounds of live diagnosis from an agent with full access to the stuck
session each included a specific, confident technical claim that did not
survive direct scrutiny. Recorded here so a fresh session does not have to
rediscover this:

1. **"`/dev` has a nested user namespace under `--dev /dev`, which is why
   `pasta` can't attach."** Directly contradicted by `lsns`, which showed an
   identical, non-nested, single-layer namespace structure whether `--dev
   /dev` or individual `--dev-bind`s were used. The real, confirmed
   mechanism (via `strace`) is that `pasta`'s `setns(fd, CLONE_NEWNET)`
   fails with `EPERM` under `--dev /dev` specifically — a real, reproducible
   difference, just not the one originally claimed. See "Theories Ruled
   Out" below.
2. **"`openat(\"/dev/ptmx\", O_RDWR)` and `openat(\"/dev/pts/ptmx\", O_RDWR)`
   both return `ENOENT`, even though `stat()` on the same paths succeeds,
   because the kernel refuses to open devtmpfs paths inside an unprivileged
   user namespace."** This is not a real Linux kernel behavior — a path
   cannot fail `open()` with ENOENT while `stat()` on the identical path
   just succeeded, and no such user-namespace-specific `open()` restriction
   is documented. It also directly contradicts this project's own repeated,
   direct verification: `os.open('/dev/ptmx', ...)` and a full `pty.fork()`
   sequence both succeeded, more than once, in a faithful reproduction of
   scoder's exact current `bwrap` invocation. **Before acting on this claim
   again, re-run the actual `open()` attempt directly and look at the raw
   output yourself** — do not trust a paraphrased trace summary a second
   time without that.

**General caution for whoever picks this up**: this investigation's most
useful findings have consistently come from checking a claim directly
(`lsns`, `strace`, `stat`, raw `/proc/*/fd` reads) rather than from
plausible-sounding narrative explanations, which have now been wrong twice
in specific, checkable ways. Treat any new theory — including
`PTY.isSupported()` above — as something to verify, not something to act on
directly.

## Theories Ruled Out

Each of these was floated, by an agent with live access to the stuck
session, as *the* root cause — and each was checked directly rather than
accepted on assertion.

1. **"`/dev/ptmx` and `/dev/pts/ptmx` both fail to open (ENOENT/EACCES),
   PTY allocation is categorically broken."** Directly contradicted by the
   six pre-existing pty slaves in the same live session (above), and by two
   independent, faithful reproductions of scoder's exact `--dev-bind` list
   in an isolated `bwrap` invocation, both of which allocated a fresh PTY
   successfully via a plain `pty.fork()`.
2. **"Switching from individual `--dev-bind`s to bwrap's own `--dev /dev`
   fixes this, via correct devpts semantics."** This was tested and is a
   dead end, but not for a devpts reason — `--dev /dev` breaks `pasta`'s own
   namespace attach outright, confirmed via a direct `strace` comparison:
   with individual `--dev-bind`s, pasta's `setns(fd, CLONE_NEWUSER)` and
   `setns(fd, CLONE_NEWNET)` both succeed; with `--dev /dev`, the identical
   sequence instead fails at `setns(fd, CLONE_NEWNET)` with `EPERM`, before
   ever reaching anything devpts-related. `lsns` showed an identical,
   non-nested namespace structure in both cases, directly contradicting a
   "nested user namespace" explanation offered for this specific failure.
   Since `--dev /dev` breaks networking entirely, it was never actually
   possible to test whether it would have fixed the *terminal* issue in the
   first place — the working tree's `--dev /dev` experiment was reverted
   back to the clean, individual-`--dev-bind` baseline (commit `2d0da64`).
   **`--dev /dev` should not be revisited** without a materially new reason
   to believe the pasta incompatibility itself has changed.
3. **"The devpts-internal `/dev/pts/ptmx` mode-`0000` permission is the
   cause."** Real anomaly, genuinely fixed (see above) — but the terminal
   still deadlocks afterward, so this was at most a contributing red herring,
   not the actual blocker.

## What's Still Unknown

The concrete, unanswered question: **why did Eclipse's terminal connector
spawn `bash` via a plain pipe (`ProcessBuilder`-shaped), instead of via
whatever PTY-allocating mechanism it would normally use?** Two live
possibilities, not yet distinguished:

- Eclipse's active terminal connector is a PTY-capable one (e.g. pty4j, used
  broadly across Java IDEs, including via JNA) that *attempted* PTY
  allocation, failed for some reason not yet identified, and its own
  fallback/error-handling path is itself what produces the pipe-based spawn
  and subsequent deadlock — rather than failing cleanly and visibly.
- Eclipse's active terminal connector never attempts PTY allocation at all —
  either because the PTY-capable connector plugin/native library isn't
  present or loadable inside the sandbox (a JNA native-library-extraction
  problem, or a missing plugin), or because it's deliberately configured
  (via a preference, possibly inherited through the seeded workspace
  settings) to use the plain pipe-based connector regardless of sandbox
  mechanics.

## Recommended Next Steps

In order of expected diagnostic value per unit of effort, to run from
*inside* a live, stuck sandbox session (matching the `jstack`-from-inside
approach that already worked, not from the host):

1. **Check whether `org.eclipse.cdt.utils.pty.PTY.isSupported()` is actually
   the gate, and if so, why it returns false.** This is now the most
   specific, promising lead. Get the full stack trace of the thread that
   actually called the spawn (`jstack <eclipse-pid>`, searching for
   `ProcessBuilder.start`, `Runtime.exec`, or a terminal-connector-specific
   spawn method) — not just the `InputStreamMonitor` threads, which are
   downstream, just waiting on the already-open pipe. This settles directly
   whether CDT's PTY path was attempted and failed, or never attempted at
   all, without further guessing. If PTY support is checked via a JNI
   native library, `System.loadLibrary` failures commonly print an
   `UnsatisfiedLinkError` to plain stdout/stderr — `/tmp/scoder-ide.log`
   (Eclipse's own redirected stdout/stderr, per the `--ide` wrapper script)
   is a fast first check for that, even though nothing shows up in
   Eclipse's own structured Error Log.
2. **Before trusting any further specific technical claim about `/dev`
   itself** (whether from a diagnosing agent or a future hypothesis), run
   the actual check directly and read the raw output — see "Claims That Did
   Not Hold Up" above. `python3 -c "import os; os.open('/dev/ptmx',
   os.O_RDWR)"` (and the same for `/dev/pts/ptmx`) from inside the live,
   stuck session takes seconds and settles it without ambiguity.
3. **If CDT's PTY path was never attempted at all** (not a failure, just
   not the active code path), check which terminal connector extension is
   actually active: `Help → About → Installation Details → Plug-ins`,
   filtered for `org.eclipse.tm.terminal` / `org.eclipse.terminal`, to see
   which connector implementation is present and enabled. Cross-check
   against whatever the seeded workspace settings
   (`~/.local/share/scoder-eclipse-workspaces/.../.settings/`, copied from
   the host — see `design/implementation/plans/eclipse-preset.md`) specify
   for the terminal connector preference, in case a host-side setting is
   forcing the pipe-based one regardless of what's installed.
4. **Only once one of the above identifies a concrete missing resource**
   (a specific path, a specific native library, a specific preference),
   propose a scoder-side fix — following the same pattern as the
   `/dev/dri`, fonts, and `/dev/pts/ptmx` fixes already shipped this
   session: verify the anomaly directly first, then fix the narrowest thing
   that explains it, then confirm the fix actually resolves the original
   symptom before considering it done. Given how many plausible-but-wrong
   theories this investigation has already produced, treat any new
   explanation — including one this document might eventually turn out to
   be missing — as a hypothesis to verify, not a conclusion to act on
   directly.

## Testing

No regression test exists yet for the terminal-open path itself — this
dev environment has no real Eclipse or RStudio install and no working
`pasta` attach (missing `/dev/net/tun`), so nothing here can be verified
end-to-end outside a real GUI-capable host. Once the actual cause is
identified, add a test in the same shape as
`rstudio-preset-binds-dev-dri-when-present` (asserting the specific fix's
bind/config appears in `--dry-run` output, gated on the relevant host
resource existing) — not a live terminal-open test, which isn't practical
in CI.

[HAS_FEATURE](/design/features/sandbox-isolation.md)
[HAS_FEATURE](/design/features/tool-presets.md)
[IMPACTS](/src/sandbox/builder.ts)
[IMPACTS](/src/tools/presets.ts)
