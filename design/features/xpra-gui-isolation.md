---
target-version: 2.6.0
status: draft
tags: [feature, sandbox, x11, xpra, ide, security]
---

# xpra GUI Isolation

## Summary

A GUI preset (`rstudio`, `eclipse`) runs under an xpra server started
*inside* the sandbox. That server owns a virtual X display that exists only
there, and forwards individual windows over a unix socket to a client
process on the host, which draws them on the user's real desktop.

The host's `/tmp/.X11-unix`, `XAUTHORITY` and `DISPLAY` are not bound or
passed through. `DISPLAY` inside the sandbox is set by xpra, for its own
virtual display.

```
   host                                 │  sandbox (bwrap)
   scoder                               │
     ├─ bwrap ───────────────────────────┼─→ entrypoint.sh
     │                                   │     └─→ xpra start
     │                                   │           --bind=/tmp/scoder-<id>/xpra/xpra.sock
     │                                   │           --start-child=<ide>
     │                                   │           --exit-with-children=yes
     │                                   │             └─→ rstudio / eclipse
     │                                   │                   └─→ its own virtual X
     └─ xpra attach socket://…           │
          (sidecar, outside the sandbox) │
```

## Motivation

[ADR 0002](/architecture/decision-records/0002-rstudio-x11-access.md) bound
the host's X socket and cookie, and verified the cost rather than assuming
it: anything inside the sandbox could read the screen and inject synthetic
input into *other* windows via XTEST — including under X11's own
"untrusted" mode, which does not block it. It was the one channel scoder
could not mediate once open.

[ADR 0003](/architecture/decision-records/0003-xpra-gui-isolation.md)
supersedes that. It has the full argument, what this does and does not
close, and the verified results.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/xpra.ts)
[IMPLEMENTED_BY](/src/sandbox/entrypoint.sh)

Three moving parts, only one new in kind:

1. **In-sandbox xpra server**, started by `entrypoint.sh` as the GUI
   program's parent. `--daemon=no` (the default is `yes`, and a detached
   server leaves `$!` pointing at an exited pid), `--exit-with-children=yes`
   (takes a value; bare `--exit-with-children` is invalid), and
   `--start-child=` carrying the program's argv, `%q`-quoted because xpra
   hands it to a shell.
2. **One shared directory** at `/tmp/scoder-<id>/xpra`, bound read-write —
   the only thing crossing the boundary. It holds the unix socket and the
   mmap file, and is bound at **the same absolute path on both sides** (see
   below). Read-write because the server inside creates the socket and the
   client outside creates the mmap file.
3. **Host-side `xpra attach` sidecar** (`attachXpraClient`). The same family
   as the pasta sidecar and the `--allow-ssh` tunnel: it lives outside the
   sandbox, starts once the sandbox exists, and is not covered by bwrap's
   `--die-with-parent`, so `launchSandbox` reaps it explicitly — before
   pasta, so the user does not watch a frozen window through shutdown.

### Which program gets wrapped

A preset declares `gui: true` (`ToolPreset`). It is a GUI preset whether
named as the primary tool or as the companion, so `entrypoint.sh` takes
`XPRA_TARGET=harness` for `scoder rstudio` and `XPRA_TARGET=ide` for
`scoder pi --ide rstudio`. Exactly one xpra server per session; the
companion wins if both are somehow GUI, since that is the arrangement
`--ide` exists for.

### The client must wait, and must pin its GDK backend

The socket appears **~3s** after launch (measured), and the client is
started from outside, so it always loses that race. `waitForXpraSocket`
polls with a 30s bound — bounded for the reason `waitForChildPid` is, that
an unbounded wait turns a failed launch into a silent hang.

It polls with `stat().isSocket()`, **not** `Bun.file(path).exists()`, which
answers "is there a regular file here" and returns **false** for a unix
socket. The first version used `exists()` and could therefore never
succeed, on any machine: every GUI session burned the full 30s and then
reported a socket that was sitting right there. Reported from a real
Eclipse session whose xpra log read `created unix domain sockets:
'/tmp/scoder-xpra/xpra.sock'` while scoder was still waiting for it.

`xpraClientEnv` sets `GDK_BACKEND` from what is actually reachable rather
than inheriting it. xpra's client otherwise refuses to start with
`'client' failed to initialize Gtk, no display?` even with a working
`DISPLAY`, a valid `XAUTHORITY` and `Gtk.init_check()` returning `True`:
`set_gdk_backend()` in `xpra/scripts/main.py` forces `GDK_BACKEND=wayland`
whenever `WAYLAND_DISPLAY` is merely *set*, whether or not a compositor is
listening, and the resulting error blames the display rather than the
backend choice. `attachXpraClient` reports which backend was tried when the
client fails, because upstream's message will not.

### The shared directory is bound at the same path on both sides

Host `/tmp/scoder-<id>/xpra` is sandbox `/tmp/scoder-<id>/xpra`. Not
tidiness — it is what makes mmap work, and mmap is what makes the GUI
usable.

xpra's shared-memory transport has the client create the mmap file and send
the server its *path*. Across a namespace boundary where the two sides know
the same file by different names, the server cannot open what the client
names, the negotiation fails, and every pixel update is encoded (h264/vp9/
webp) and decoded instead of written to shared memory. Reported directly:
both IDEs worked but were "too laggy to be useable", with scroll events
visibly trailing the UI, and the client logging `cannot access mmap file
'/run/user/<uid>/xpra/xpra.*.mmap': Read-only file system`.

Verified directly that mirroring fixes it — the same session then logs
`enabled fast write mmap transfers using 2GB shared memory area` on the
server and `enabled fast read ...` on the client. The end-to-end test
asserts it, because this is a property a later change could undo while
everything still visibly worked.

Self-mirroring is the degenerate case of the `session-temp-root` rule (host
path mirrors the sandbox path it is bound at) and of `path-mirroring`,
which this project is built on everywhere else. Under the session root
rather than a fixed path so two concurrent sessions cannot collide.

### inotify instances are a per-user budget, and xpra was spending 8

Reported directly: RStudio's file monitors failing repeatedly with
`system error 24 (Too many open files)`. That is `EMFILE` from
`inotify_init()`, which means `fs.inotify.max_user_instances` — **128 by
default, and per *user*, not per namespace**. The sandbox shares the user's
uid, so everything inside it competes with their whole desktop for the same
128. It is not a file-descriptor limit and raising `ulimit -n` does nothing.

Measured: an xpra session held **8** instances by default, **1** with two
things turned off, both of which the sandbox wanted off anyway.

- `--input-method=keep` stops xpra starting an ibus stack — `ibus-daemon`,
  `-memconf`, `-extension-gtk3`, `-x11`, `-portal`, 8 processes. Nothing in
  a sandbox is using an input method editor.

  `keep`, not `none`. `none` does not mean "no input method": xpra reads it
  as "disable imsettings and fall back to xim", and sets
  `GTK_IM_MODULE=xim` for every child
  (`xpra/x11/subsystem/keyboard.py`, `configure_imsettings_env`). Eclipse's
  SWT then prints `***WARNING: Detected: GTK_IM_MODULE=xim. This input
  method is unsupported and can cause graphical issues ... if flicking is
  experienced` — reported from a real session, and introduced by the `none`
  spelling rather than present before it. `keep` leaves the environment
  alone, which here means `GTK_IM_MODULE` stays unset, exactly what SWT
  asks for. That only works because bwrap runs `--clearenv`, so it depends
  on `buildBwrapCommand`, not on the host. Verified directly: both
  variables unset, 0 ibus processes, so the inotify saving is unchanged.
- `XPRA_MENU_WATCHER=0` and `XPRA_EXPORT_MENU_DATA=0` stop the menu
  provider, which creates one inotify instance per watched directory to
  export the *host's* application menu into the session. That is host data
  the sandbox has no use for, it took 3.3s to scan on a real machine, and
  it is a small channel in its own right.

This reduces scoder's own share; it cannot raise the ceiling. A user whose
desktop is already near 128 needs
`sysctl fs.inotify.max_user_instances=<larger>` on the host.

### Both binds are mountpoints inside the sandbox's own /tmp

Both the shared directory and `entrypoint.sh` are bound under `/tmp`, which
is the sandbox's own tmpfs. Not a preference — a bind's mountpoint has to be
created, and it cannot be created inside a read-only bind, so `/run` (where
an earlier version put both) fails outright with `bwrap: Can't mkdir
parents ... Read-only file system`. That `/run/xpra` appeared to work during
development was an accident: the xpra package itself ships that directory.

A writable parent is not a weakness here. Verified directly from inside the
sandbox: `rm` and `mv` on a bind mountpoint both fail with `EBUSY`, and a
symlink over it fails with `EEXIST`, so an unprivileged process in the
namespace cannot remove or replace it, and `--ro-bind` makes the contents
unwritable.

The socket path also has a hard length limit — 107 bytes usable, 108 fails.
`/tmp/scoder-<8 hex>/xpra/xpra.sock` is 35 bytes; a `$HOME`-based
destination would have spent much of that on the username.

### Capabilities

`--notifications=no` and `--printing=no` on both sides: xpra proxies the
host's notification daemon and printer list into the session otherwise,
which is a capability channel this layer exists to close. Observed directly
— the client tried to enumerate printers over the system bus unprompted.
Audio is off because the stack is not wired through the sandbox and produced
only `pactl` connection failures.

The clipboard is deliberately **on**. X11 passthrough gave the sandbox
unrestricted clipboard access along with everything else, so proxying it is
the same capability with a name and an off switch, not a regression. Worth
exposing as a flag.

### Two transports, and mmap is the right default

xpra 6.5.4 will use **either** mmap **or** its scroll-delta encoding for a
window, never both. Verified directly by A/B, with the client's
`XPRA_SCROLL_ENCODING=1` set in both runs:

| client `--mmap` | window encoding | `encoding.scrolling.enabled` |
|---|---|---|
| a path (the default) | `mmap` | **False** |
| `no` | `auto` | **True** |

It looked as though scroll-delta would be the better trade for an IDE, since
scrolling is the dominant interaction and mmap ships every wheel notch as
changed pixels. **That prediction was wrong.** Tested on real Eclipse and
RStudio sessions: `--mmap=no` was *worse* in both, never better. mmap stays
the default, and the measured
`pixels_encoded_per_second=137959260` (~37 full 2560x1440 frames/sec) is why.

### What is actually slow: the mouse wheel, in Electron

Reported from real sessions, which between them isolate it:

| session | wheel scrolling |
|---|---|
| `scoder pi --ide eclipse` | **fine** |
| `scoder pi --ide eclipse` with `--mmap=no` | laggy |
| `scoder --ide rstudio pi` | laggy |
| `scoder --ide rstudio pi` with `--mmap=no` | laggy |

Two things follow. Eclipse is fine on the shipped configuration. And
RStudio's problem is not the transport, because it is laggy on the
configuration Eclipse is happy with.

The decisive detail: **dragging a scrollbar is smooth; only the wheel is
slow.** Dragging produces pointer-motion events and repaints fine, so
rendering is not the bottleneck — this is wheel *event* handling.

The mechanism, from xpra's own source. `XPRA_SMOOTH_SCROLL` defaults on, so
the GTK client requests `SMOOTH_SCROLL_MASK` from GDK
(`client/gtk3/window/pointer.py`) and one physical notch arrives as a stream
of fractional deltas, which `send_wheel_delta`
(`client/subsystem/window/wheel.py`) forwards as precise `wheel-motion`
packets. RStudio is Electron, and Chromium *animates* each scroll event, so
a stream of them queues a backlog of animations — which is what "scroll
events propagate slowly to the UI" describes. SWT (Eclipse) scrolls directly
per event and does not compound the same way.

`--mousewheel=coarse` turns that off — the client stops asking for smooth
scroll and sends one discrete click per notch. Verified it parses to
`wheel_smooth=False` while keeping the full button map, unlike
`--mousewheel=no` which disables the wheel entirely.

**Tested, and it does not help.** So the event *rate* is not the problem
either, and the smooth-scroll explanation above is eliminated along with
the transport one.

### The GPU: a badly designed test, and what the logs already said

`--disable-gpu`, `--disable-gpu-compositing` and `--disable-smooth-scrolling`
were all tried and none made any difference. That was read as "not the GPU".
**It does not show that**, as the reporter pointed out: disabling something
that was never working looks identical to leaving it alone. The test could
not distinguish its two outcomes, which is a reason to design a better test
rather than a result.

What settles the question was already in the server log all along:

```
OpenGL is supported on display ':0' using 'llvmpipe (LLVM 20.1.2, 256 bits)'
```

`llvmpipe` is Mesa's **software** rasteriser. The virtual display's GL is
software, so anything going through GLX against it — Chromium included —
renders on the CPU no matter that `/dev/dri` is bound. The GPU is not
blocked by permissions; it is unreachable by that route, because the route
runs through Xvfb.

That makes the working hypothesis "Electron's wheel scrolling wants GPU
compositing and is not getting it", and the thing to do is **enable** the
GPU and see, not disable it further.

**A second blocker, verified directly**, which may matter more than the
first: the sandbox loses supplementary group membership. A user namespace
maps exactly one gid, so every supplementary group becomes `nogroup`:

```
host:    id -G -> 1000 27 1001   (user, sudo, docker)
sandbox: id -G -> 1000 65534 65534
```

**That display is misleading, and an earlier version of this document drew
the wrong conclusion from it.** Entering a user namespace changes how ids are
*rendered*, not the credentials the kernel checks against. Verified directly:
a file owned `root:docker` with mode 640 is readable from inside the sandbox
by a process whose `id -G` reports only `1000 65534 65534`. The supplementary
group is still there as far as permission checks are concerned — it simply
has no name inside the namespace.

So a group-gated device *is* reachable from the sandbox, and this was never
what blocked the GPU.

Separately, `logind` sets a POSIX ACL on `/dev/dri/*` granting the active
user access by uid, so on a systemd desktop the node is reachable by that
route as well:

```
crw-rw----+ 1 nobody nogroup 226, 128 renderD128     <- note the ACL "+"
id -G: 1001 65534                                     <- groups gone
writable: yes                                         <- ACL still grants it
```

The owner reads as `nobody nogroup` only because root and `render` are
outside the namespace's uid/gid map. The node is accessible, and RStudio's
Chromium zygote was in fact holding `/dev/dri/renderD128` open.

The wider consequence is a security one rather than a GPU one, and it is
followed up in [0004-no-host-dbus](/architecture/decision-records/0004-no-host-dbus.md):
because group membership keeps working, a sandbox reaches anything on the
host that its user can reach, including group-gated sockets under `/run`.
`/run` is a tmpfs now, for exactly that reason.

It is also worth noting beyond the GPU: **any group-gated device or file is
invisible to a sandboxed tool in the same way.** That is arguably correct
for an isolation tool, but it is undocumented and fails silently.

**Route 1 has now been tested and did not help.** Run with

```
RSTUDIO_CHROMIUM_ARGUMENTS="--ignore-gpu-blocklist --enable-gpu-rasterization --use-gl=egl"
```

the flags demonstrably reached Chromium (`--use-gl=egl` visible on its child
processes) and the render node was open, and the scrolling was unchanged. So
Chromium-level GPU configuration is not the answer either, and the list of
eliminated causes now covers the transport, the event rate, inotify, and
every GPU flag worth trying.

### The experiment that should come next

Everything so far has varied settings *within* the scoder + xpra + Electron
stack. What has never been tested is whether scoder is involved at all.
**Run RStudio under xpra on the host, with no sandbox:**

```
design/prototype/xpra-no-sandbox.sh rstudio
```

It uses the same xpra flags the entrypoint does, with no bwrap, no namespaces
and no binds, so the sandbox is the only variable removed. Verified end to
end with `xclock` standing in for RStudio.

`design/prototype/xpra-gpu-debug.sh`, run inside a GUI session, answers the
questions that came up repeatedly here: which Chromium children exist and of
what type, which hold the render node, whether it can be opened and why, and
which GL flags actually arrived. It exists because three separate hand-written
versions of those checks were wrong in ways specific to this sandbox —
Chromium's children re-exec as `/proc/self/exe` so they cannot be found by
application name, the PID namespace is shared with the host so `/proc` lists
other users' processes, and a bare `grep -- --type=` matches its own command
line.

It partitions the remaining space in half, and either answer is useful:

- **Still laggy** — the problem is an xpra/Electron interaction and has
  nothing to do with the sandbox. Nothing in scoder can fix it; the honest
  position is that GUI presets work well for Eclipse and that RStudio has an
  upstream problem worth reporting to xpra with this reproducer.
- **Smooth** — the sandbox is implicated after all, and the search narrows
  to what bwrap changes for a Chromium process: a missing device, `/proc`
  or `/sys` visibility, shared memory, or the IPC namespace.

Two routes were considered before that, neither now worth trying first:

1. ~~**Let Chromium use the render node directly via EGL**~~ — tested, see
   above. `/dev/dri` is already bound, so this needs no sandbox change —
   only flags. Chromium also blocklists software/unknown GL configurations,
   hence `--ignore-gpu-blocklist`:

   ```
   RSTUDIO_CHROMIUM_ARGUMENTS="--ignore-gpu-blocklist --enable-gpu-rasterization --use-gl=egl" \
     scoder --ide rstudio pi
   ```

   Whether it took effect is checkable rather than a matter of impression.
   Note that Chromium's children re-exec as `/proc/self/exe`, so they must be
   found by their `--type=` argument and **not** by the application name — a
   filter on "rstudio" hides the GPU process entirely, which is how an
   earlier version of this check concluded there was not one. A process using
   the GPU also has the DRM render node open:

   ```bash
   for p in $(ls /proc | grep -E '^[0-9]+$'); do
       ls -l "/proc/$p/fd" 2>/dev/null | grep -q '/dev/dri/' &&
           echo "pid $p: $(tr '\0' ' ' < "/proc/$p/cmdline" | cut -c1-90)"
   done
   ```

   Two things that an earlier, broken version of this check got wrong, both
   worth stating because they are properties of this sandbox rather than
   mistakes anyone would expect. **scoder does not unshare the PID
   namespace** (see `sandbox-isolation`), so `/proc` inside the sandbox
   shows the host's processes too — `pgrep` will cheerfully match a browser
   running on the desktop outside. Hence printing every match with its
   command line and picking out the rstudio one, rather than trusting the
   first hit. And most of those host processes belong to other users or are
   otherwise unreadable, so the `2>/dev/null` is load-bearing: without it
   the output is hundreds of `Permission denied` lines and no answer.

2. **Give xpra a virtual display that can reach the GPU.** `--xvfb=` accepts
   alternatives, including `weston+Xwayland`, where Weston's headless
   backend can render through GBM on the DRM node and Xwayland presents X11
   on top. More invasive — it needs weston and Xwayland installed on the
   host, since `/usr` is what the sandbox sees — but it fixes the problem at
   the display rather than per-application.

Chromium's own sandbox is *not* in the way, incidentally: nested user
namespaces work inside a scoder sandbox, verified directly, so
`--no-sandbox` and `--disable-gpu-sandbox` should not be needed.

### Ruled out: inotify exhaustion

The symptom, reported precisely, is not slow scrolling. It is **no response
for several seconds, during which the UI is unresponsive, and then it
arrives at the final position** — with no intervening frames, at most the
last few. That is not a rendering cost. It is something blocking.

Chromium handles the two scroll gestures on *different threads*. Scrollbar
dragging is handled on the compositor thread. Mouse wheel is routed to the
**main thread** whenever a non-passive wheel listener is registered, which
an editor like RStudio's does. So a blocked main thread freezes wheel
scrolling while leaving scrollbar dragging perfectly smooth — which is
exactly the split observed, and which no amount of rendering configuration
would change.

What would block it is already on record from the same sandbox:

```
rsession ERROR system error 24 (Too many open files);
  ... file_monitor::detail::registerMonitor ...
  LOGGED FROM: ProjectContext::fileMonitorTermination
```

Error 24 is `EMFILE` from `inotify_init()`, meaning
`fs.inotify.max_user_instances` is exhausted — 128 by default, **per user**,
shared with the user's entire desktop (see the inotify section above, where
xpra's own share was cut from 8 instances to 1). On the development machine
for this work, an idle box, 112 of the 128 were already in use. RStudio
registers several file monitors and retries them.

This hypothesis explains every observation, which none of the previous three
did:

| observation | explained by |
|---|---|
| Electron only, Eclipse fine | only Chromium splits wheel and drag across threads |
| wheel stalls, scrollbar drag smooth | main thread vs compositor thread |
| no rendering flag helps | it is not a rendering problem |
| seconds of nothing, then the final state | main thread blocked, then drains its queue |
| `EMFILE` in the same session | the thing doing the blocking |

**Tested and eliminated.** The limit was raised to 512 on the host, the
`system error 24` messages stopped, and the scrolling was unchanged — so
every test recorded above was run without the inotify errors present. The
exhaustion was real and worth fixing on its own account; it was not the
cause of this.

The thread-split reasoning survives the elimination, though, and is still
the best account of *why* the wheel and the scrollbar behave differently:
whatever blocks RStudio's main thread will stall the wheel and leave
dragging smooth. It just is not inotify doing the blocking.### Tuning a live session: SCODER_XPRA_*

Judging whether a GUI session feels responsive is something only the person
at the screen can do, and each attempt costs them a full IDE session. So
the xpra flags are reachable without a code change:

- any `XPRA_*` variable set on the host is forwarded into the sandbox and
  reaches the server; the client inherits the host environment already, so
  one setting covers both sides
- `SCODER_XPRA_SERVER_ARGS` — extra flags for the in-sandbox `xpra start`
- `SCODER_XPRA_CLIENT_ARGS` — extra flags for the host-side `xpra attach`

Both are whitespace-split, so a flag value containing a space cannot be
passed this way. Forwarding `XPRA_*` wholesale is safe because the sandbox
is `--clearenv`'d: nothing arrives that the user did not deliberately set,
and it only reaches xpra. The entrypoint reads its own settings with
`${VAR:-default}`, so a forwarded value wins.

```
XPRA_SCROLL_ENCODING=1 SCODER_XPRA_CLIENT_ARGS="--encoding=rgb" \
  scoder pi --ide eclipse
```

### Appearance

Three things a forwarded window gets wrong by default, all reported directly.

**xpra's own title bar.** `--headerbar` defaults to `auto` on Linux, which
adds an xpra title bar and menu ("Information > About Xpra") to every
*decorated* window. That is why it appeared on RStudio and not Eclipse —
nothing to do with either IDE. Turned off (`--headerbar=no`), because the
window should look like the application the user asked for, and because that
menu offers session controls for a connection scoder owns the lifecycle of.

**Dialog placement.** Reported: dialogs appear in unusual places on the
host. `--modal-windows` defaults to `no`, and xpra's source says why — GTK
offers only application-modal, not window-modal, so a modal window blocks
input to *every* window that client manages, "including other unrelated
applications". That warning is about one client serving a session full of
applications. A scoder session has its own server and client forwarding one
GUI program, so the windows at risk are that program's own, which is what a
modal dialog is meant to block. Turned on (`--modal-windows=yes`).

It is a placement fix only indirectly: modal is about input, but a window
manager uses the modal and `transient-for` hints to decide to centre a dialog
on its parent instead of placing it by its own policy. So it is the right
lever for *dialogs* and not for menus or dropdowns — those are
override-redirect windows positioned absolutely by the application, and xpra
already patches a `transient-for` onto them and nudges them back on-screen.
If the misplaced popups are menus rather than dialogs, this will not touch
them and the cause is elsewhere.

Unverified in this project, which has no desktop to see window placement on.
`SCODER_XPRA_CLIENT_ARGS="--modal-windows=no"` turns it off without a
rebuild.

**GTK theming.** A GUI preset otherwise renders in the default white theme
rather than the user's, which under a dark desktop is not a small
difference. A GTK app needs both halves — the setting naming a theme, and the
theme itself — so `buildExtraBinds` binds, read-only and each only when
present:

| path | why |
|---|---|
| `.config/gtk-3.0`, `.config/gtk-4.0` | the settings that name the theme |
| `.gtkrc-2.0` | the same, for GTK2 |
| `.themes`, `.local/share/themes` | user-installed themes |
| `.icons`, `.local/share/icons` | user-installed icon themes |
| `.fonts` | pre-XDG font location, alongside the existing `.local/share/fonts` |

`GTK_OVERLAY_SCROLLING` is inherited from the host for the same reason —
setting it to `0` is how KDE users stop GTK auto-hiding scrollbars, and
without it a sandboxed IDE hides them while every other application on the
desktop does not.

That is an explicit allowlist in `guiDisplayBinds`, emphatically **not** a
`GTK_*` passthrough. `GTK_IM_MODULE` must stay unset: `entrypoint.sh` relies
on bwrap's `--clearenv` leaving it empty so that xpra's
`--input-method=keep` leaves it alone, which is what stops Eclipse's SWT
warning that `GTK_IM_MODULE=xim` is unsupported. A host that exports it would
silently reintroduce the exact bug that spelling was chosen to avoid.

The settings files matter most on KDE, which is where this was reported:
`kde-gtk-config` writes the chosen GTK theme into `.config/gtk-3.0/settings.ini`
and `.gtkrc-2.0`, so without them the sandbox has no idea a theme was ever
chosen. System-wide themes under `/usr/share` already arrive with the
wholesale read-only `/usr` bind. Verified inside a real sandbox that all three
kinds resolve: `$HOME` is a tmpfs, so these depend on the `--dir` scaffolding
for `.config` and `.local/share` that `buildBwrapCommand` already emits.

### Hard dependency, never a fallback

`requireXpra` (`src/tools/presets.ts`), shared by every GUI preset's
`validate()`. A missing xpra fails with the same shape as the `bwrap` and
`pasta` checks in `main()`. It deliberately does not fall back to the old
X11 binds — see ADR 0003.

`--install-dependencies` adds the upstream repository (key,
per-codename `.sources`, `apt-get update`) before installing
`xpra xpra-x11` with `--no-install-recommends`; the distro's own package is
five years stale on Ubuntu 24.04 and absent on 26.04. See
`src/cli/dependencies.ts`.

It installs **6.5.3 specifically**, and writes an apt pin holding it there,
because 6.5.4 makes GUI presets unusable — every mouse-wheel notch stalls the
UI for seconds. Without the pin an ordinary `apt upgrade` restores the broken
version silently, and nothing about the symptom points at xpra. See
`xpra-client-crashes-on-every-discrete-scroll-event` for the pin's exact
contents and why priority 1001.

## Known Gaps

- ~~**A killed session leaves the whole IDE stack running.**~~ **Fixed.**
  Everything in the sandbox's mount namespace is now terminated when the
  session ends — see "Nothing outlives the sandbox" in `ide-companion`, which
  is where it belongs since it is not specific to GUI presets. xpra's `Xvfb`
  and `dbus-daemon` are covered too, which a pid-based attempt was not.
- **Mousewheel scrolling stalled — root cause found, and it was an xpra bug.**
  Every *discrete* scroll event raises an `AttributeError` inside xpra's own
  client, which calls a `get_subsystem` method that does not exist in 6.5.4.
  Each raise prints a traceback on the client's UI thread, which is what
  produces seconds of unresponsiveness followed by a jump to the final
  position. Reproduced with no sandbox at all, and fixed by a one-line
  change. See
  [xpra-client-crashes-on-every-discrete-scroll-event](/design/implementation/issues/xpra-client-crashes-on-every-discrete-scroll-event.md),
  which also records why the transport, GPU, event-rate and inotify
  hypotheses each tested negative: nothing was wrong with rendering.
- **Eclipse starts and runs under xpra** — reported directly from a real
  session: the server came up, `--start-child` launched
  `/opt/eclipse/eclipse` with its full `-data`/`-importProject` argv, m2e
  queued its project refreshes and the embedded Tomcat started. What that
  session did *not* confirm is the window reaching the screen, because it
  hit the `Bun.file().exists()` socket bug above and no client ever
  attached. Worth re-confirming once.
- **RStudio is unverified under xpra.** Electron is the likelier of the two
  to need coaxing.
- **`ideShutdown` is unverified under xpra.** Both presets' recorded values
  were measured against a directly-exec'd IDE; the signalled process is now
  the xpra server. Unchanged, and should be re-measured rather than reasoned
  about.
- ~~**D-Bus is untouched**, and is a real capability channel~~ — **closed**
  by [0004-no-host-dbus](/architecture/decision-records/0004-no-host-dbus.md).
  The host's session bus went with `--tmpfs /run` and nothing brings it back.
  What the GUI gets instead is xpra's *own* private bus, which it starts by
  default and which reaches nothing outside the sandbox — and which turned
  out to be all the applications ever needed.
- ~~**`/run/user/<uid>` write failures**~~ — **fixed** by the same tmpfs.
  That directory is writable now, so xpra's session files, its pid files, the
  client's mmap file and `dconf` all stop failing against it.
- **xpra's scope is wider than this document assumes.** It brought its own
  session bus, its own notification forwarding, its own printer enumeration
  and its own menu watcher; three of those were switched off one at a time,
  each as a separate surprise, before anyone looked at the pattern. More of
  xpra is worth reading before the next feature is built beside it.

[HAS_FEATURE](./tool-presets.md)
[HAS_FEATURE](./ide-companion.md)
[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./session-temp-root.md)
[HAS_TEST](../test-scripts/validation-suite.md)
