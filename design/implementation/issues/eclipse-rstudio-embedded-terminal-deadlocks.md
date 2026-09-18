---
target-version: 2.5.0
resolved-in: 2.3.1
status: fixed in 2.3.1, pending live IDE confirmation
tags: [issue, sandbox, dev, eclipse, rstudio, terminal, pty]
---

# Eclipse and RStudio Embedded Terminal Panes Deadlock in the Sandbox

## Resolution

**Root cause: no process inside a scoder sandbox could allocate a pty at
all.** Both routes to the pty multiplexer were shut, for two separate and
independently verified reasons:

- `--dev-bind /dev/ptmx /dev/ptmx` binds the *devtmpfs* ptmx node. A bind
  keeps the source dentry, and the kernel's ptmx open path
  (`path_pts()`, `fs/namei.c`, used by `devpts_acquire()`) resolves the
  devpts instance by looking for a `pts` sibling **next to the opened
  node's own dentry** — i.e. on devtmpfs, not in the sandbox. There is no
  devpts mounted there, so the lookup fails and `open()` returns `ENOENT`
  while `stat()` on the same path keeps succeeding.
- The other route, the devpts-internal `/dev/pts/ptmx`, comes from the
  host's own devpts instance, bound in wholesale — and that instance is
  mounted `ptmxmode=000`, so its ptmx node is mode `0000` and unopenable
  by the sandbox uid (whose mapping shows the owner as `nobody`).

Commit `2d0da64` (shadowing `/dev/pts/ptmx` with the top-level device)
closed the second route into the first: after it, *both* paths were
devtmpfs binds returning `ENOENT`.

**Fix (implemented in 2.3.1):** a **nested pair of bwraps**
that splits the two concerns. The *outer* owns `/dev` and nothing else —
`--dev /dev` plus `/dev/dri`, the real root bound through, no other
namespace unshared. The *inner* does all the isolation over that `/dev`
with a wholesale `--dev-bind /dev /dev` (recursive, so it carries the
outer's devpts submount and `/dev/ptmx` still resolves onto a real
devpts), and owns the network namespace, so pasta attaches to a netns
created by a bwrap that never saw `--dev`.

A single bwrap with `--dev /dev` fixes ptys but **does not work on the
reference host**: pasta fails with `Couldn't switch
to pasta namespaces: Operation not permitted`, reproduced directly with
the prototype harness below. The earlier report of that incompatibility
was therefore real, which is why the shipped fix splits the two concerns
across layers rather than putting `--dev` on the sandbox pasta attaches
to.

`buildDevLayer` in `src/sandbox/builder.ts` builds the outer layer and
wraps the inner command in it; everything else about the sandbox is
unchanged. pasta still learns the pid it needs from `--info-fd`, which
stays on the *inner* layer and reaches it by plain fd inheritance through
the outer one (verified directly) — the outer layer's own `child-pid`
would be the inner bwrap process, which sits outside the netns.

Verified end-to-end in a live launch (with a fake pasta shim, inside a
sandbox where pasta itself cannot run): scoder starts, the fd shim's
`--info-fd`/`--block-fd` reach the inner layer, the sidecar attaches by
pid, the block is released, the tool runs, and `script(1)` inside it
allocates `/dev/pts/0`.

Direct verification of pty allocation under the `--dev`-derived `/dev`,
from inside a live sandbox:

```
# before (scoder's individual dev-binds)
open /dev/ptmx      FAIL [Errno 2] No such file or directory
open /dev/pts/ptmx  FAIL [Errno 2] No such file or directory
os.openpty()        FAIL [Errno 2] No such file or directory

# after (--dev /dev --tmpfs /dev/shm ... --dev-bind /dev/dri /dev/dri)
open /dev/ptmx      OK
open /dev/pts/ptmx  OK
os.openpty()        OK -> /dev/pts/0
script -qec tty     -> /dev/pts/1
/dev/shm writable: True   /dev/dri: card1 card2 renderD128 renderD129
```

**Confirmed on the reference host** with
`design/prototype/nested-bwrap-pasta.sh` (see below): only the nested
shape passes everything.

| check | `legacy` | `single` (`--dev /dev`) | `nested` |
| --- | --- | --- | --- |
| pasta attaches | PASS | **FAIL** (`EPERM`) | PASS |
| `/dev/net/tun`, disks, TPM absent | PASS | PASS | PASS |
| private devpts (no host ptys) | **FAIL** | PASS | PASS |
| `openpty()` / `script(1)` / `pty.fork()` | **FAIL** | PASS | PASS |
| opened port reaches host, others blocked | PASS | n/a | PASS |
| outbound network | PASS | n/a | PASS |

### Two earlier findings this corrects

- "Ordinary PTY allocation works, repeatedly, in the exact same live
  session" — **wrong**. The six pty slaves under `/dev/pts` are the
  *host's*, visible only because the host's devpts instance is
  bind-mounted in (a shared peer-group mount, `master:3`, with mtimes
  predating the sandbox). Nothing inside the sandbox ever allocated one.
- The `/dev/pts/ptmx` mode-`0000` anomaly was real, but shadowing it with
  the top-level `/dev/ptmx` could not help, because that device is
  exactly the one that cannot resolve its devpts instance through a bind.
- Binding the host's `/dev/pts` wholesale is also an **isolation hole**,
  independent of the deadlock: the sandbox sees the host's pty slaves, and
  since they are owned by the same uid it can open them read/write —
  verified directly (`/dev/pts/{0,1,2}`, modes 0620/0600, opened
  `O_RDWR|O_NOCTTY` from inside a sandbox and closed again untouched).
  A sandboxed process could therefore write to the user's own terminals.
  A fresh devpts instance, which both `--dev` shapes give, closes this.

### Pasta caveat

`--dev /dev` was previously abandoned after bwrap failed to initialize on
one real host, surfacing only as pasta's generic `Couldn't switch to
pasta namespaces`, later attributed by `strace` to `setns(fd,
CLONE_NEWNET)` → `EPERM`. No mechanism was ever established for that, and
pasta cannot be exercised here (no `/dev/net/tun`). The materially new
reason to revisit it is that `--dev` is the *only* configuration in which
a pty can be allocated at all. If the sidecar now fails to attach, the
verified fallback is to leave the outer sandbox untouched and run the
payload under an inner `bwrap --bind / / --dev /dev --proc /proc` — tested
here, it yields a working devpts without changing the namespaces pasta
attaches to.

### Prototype harness for the nested shape

`design/prototype/nested-bwrap-pasta.sh` is a standalone bash harness for
settling the pasta question outside any sandbox. It builds one of three
shapes and runs identical checks against each:

- `MODE=nested` — two bwraps. The outer owns `/dev` only (`--dev /dev`
  plus `/dev/dri`, real root bound through, nothing else unshared); the
  inner does all the isolation over it with a wholesale `--dev-bind /dev
  /dev` and owns the network namespace, so pasta attaches to a netns
  created by a bwrap that never saw `--dev`. The inner bind is recursive,
  so it carries the outer's devpts submount and `/dev/ptmx` still resolves
  onto a real devpts.
- `MODE=single` — one bwrap with `--dev /dev` (what 2.3.1 ships).
- `MODE=legacy` — one bwrap with the old individual `--dev-bind`s.

Checks: pasta attaches at all; `/dev/net/tun` and host disks/TPM/mem are
absent while the core nodes work; a process with pipe stdio and no
controlling terminal can allocate a pty (`/dev/ptmx` open, `script(1)`,
`pty.fork()`) — the exact shape a JVM terminal connector runs in; and only
the port passed to `--tcp-ns` reaches a host loopback listener.

Checks include `dev-pts-private`, which is the one the node list alone
misses: a fresh devpts starts empty, so any numbered slave visible before
the harness allocates one came from the host.

Run on the reference host, `nested` passes every check; `single` fails
only `pasta-attach` (`Operation not permitted`); `legacy` fails
`dev-pts-private` and all three pty probes, reproducing the original
symptom verbatim (`script: failed to create pseudo-terminal: No such file
or directory`). Run inside the dev sandbox instead (where pasta cannot
work at all — no `/dev/net/tun`), the same pty and `/dev` verdicts hold,
and pasta gets as far as configuring `eth0` before failing on the missing
tun node — i.e. it had already `setns`'d into the nested inner user and
network namespaces, so the nesting itself does not obstruct the attach.

### Implementation notes for the nested shape

- The inner `--dev-bind /dev /dev` is only safe because that `/dev` is the
  outer's synthetic one, not the host's; the outer must therefore always
  be the layer that constructs `/dev`.
- The outer deliberately binds the real root through and isolates nothing:
  every existing bind, tmpfs, `--unshare-*`, `--new-session` and
  `--die-with-parent` decision stays on the inner layer, so the shipped
  isolation rules are unchanged.
- `--die-with-parent` is needed on both layers, or the inner survives the
  outer.
- pasta targets the **inner** `--info-fd`'s `child-pid`; the outer's
  `child-pid` is the inner bwrap process, which sits outside the inner
  netns and is the wrong target.

## Original Investigation Record

### Summary

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

### What's Confirmed, Not Theory

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

### Confirmed Since the Devpts Fix

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

### Claims That Did Not Hold Up

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

### Theories Ruled Out

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

### What's Still Unknown

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

### Recommended Next Steps

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

`tests/scoder.test.ts` covers the shape in `--dry-run`:
`dev-owned-by-outer-layer` (outer builds `/dev` with `--dev`, after its
root bind; inner takes it wholesale; no hand-bound `/dev/ptmx` or
`/dev/pts` anywhere), `dev-layer-leaves-isolation-to-inner`
(`--unshare-net`, `--info-fd`, `--block-fd` on the inner only;
`--die-with-parent` on both), `dev-layer-hoists-preset-device-binds`
(`/dev/dri` exposed by the outer as `--dev-bind-try` and still bound by
the inner), plus two unit tests for `buildDevLayer`/`collectBindDests`.

A live terminal-open test is still not practical in CI, and two unrelated
things stop the full suite running *inside* a scoder sandbox: the
`/tmp` staging-dir leak
([scoder-local-bin-staging-dirs-leak-into-tmp.md](/design/implementation/issues/scoder-local-bin-staging-dirs-leak-into-tmp.md)),
and the live-sandbox tests failing whenever one of the host files the
sandbox binds has been replaced on the host since that outer sandbox
started (its bind then points at a deleted inode, and bwrap cannot use it
as a bind source) — confirmed identical at HEAD, i.e. environmental, not
caused by this change.

[HAS_FEATURE](/design/features/sandbox-isolation.md)
[HAS_FEATURE](/design/features/tool-presets.md)
[IMPACTS](/src/sandbox/builder.ts)
[IMPACTS](/src/tools/presets.ts)
