---
target-version: 2.6.0
status: implemented
tags: [plan, sandbox, x11, xpra, ide, security]
---

# Replace Host X11 Passthrough With xpra for GUI IDEs

> **Implemented in 2.6.0.** See
> [xpra-gui-isolation](/design/features/xpra-gui-isolation.md) for what the
> code actually does and
> [ADR 0003](/architecture/decision-records/0003-xpra-gui-isolation.md) for
> the decision. Kept as the record of how it was arrived at.
>
> **What changed against the plan, and why:**
>
> - **Decision 13 (entrypoint.sh) was adopted**, so Decision 6's `wrapExec`
>   hook was not needed — as Decision 13 predicted. Delivery is better than
>   the plan expected: Bun embeds a `with { type: "text" }` import into the
>   compiled binary, so the script is a real shellcheck'able file with no
>   runtime asset path to resolve, rather than being read from the repo at
>   startup.
> - **The interface grew `XPRA_TARGET`.** The plan assumed the GUI program
>   was always the `--ide` companion. `scoder rstudio` runs a GUI preset as
>   the *primary* tool, so the entry point has to be able to wrap either,
>   and a preset declares `gui: true` rather than the wiring inferring it
>   from `--ide`.
> - **Both socket and entrypoint are in the sandbox's `/tmp`, not `/run`.**
>   The plan said `/run/xpra/` and gave a socket-length argument for it. A
>   bind mountpoint cannot be created inside a read-only bind, so that fails
>   outright; `/run/xpra` only appeared to work because the xpra package
>   ships that directory. The length argument still holds and `/tmp` satisfies
>   it comfortably.
> - **Sequencing step 2 (repeat the spike with real RStudio and Eclipse) was
>   not done** — neither is installable here. Unchanged from the plan's own
>   "Still not verified" list, and now recorded in the feature doc and ADR
>   0003 rather than only here.
> - **Step 6 (re-measure `ideShutdown`) was not done**, same reason. The
>   recorded values are unchanged and explicitly flagged as unverified
>   through the new layer, in `entrypoint.sh`, the feature doc and ADR 0003.
> - **Decision 14 (one session temp root) was done first**, as its own
>   change, and closed
>   `scoder-local-bin-staging-dirs-leak-into-tmp` — see
>   [session-temp-root](/design/features/session-temp-root.md).
> - **The dependency question was settled by reimplementing** upstream's
>   three Debian/Ubuntu steps rather than piping `get-xpra.sh` into a root
>   shell, and by `--no-install-recommends` plus an explicit `xpra-x11`,
>   which drops the audio and html5 packages the plan flagged as noise.
> - **Two failures the spike could not have found** turned up during
>   implementation and are recorded in the commit and the feature doc:
>   process substitution needs `/dev/fd`, which the sandbox does not have,
>   and the read-only-bind mountpoint problem above.
> - **`--printing=no` and `--notifications=no` were added** beyond the plan,
>   after the end-to-end test showed the client enumerating the host's
>   printers over the system bus unprompted.

## Goal

Give GUI presets (`rstudio`, `eclipse`) a display without handing the
sandbox a live connection to the host's X server.

Today `guiX11Binds` (`src/tools/presets.ts`) binds `/tmp/.X11-unix`, passes
`DISPLAY` through, and binds the `XAUTHORITY` cookie file. [ADR
0002](/architecture/decision-records/0002-rstudio-x11-access.md) accepted
that deliberately, and documented the cost in unusually blunt terms:
anything in the sandbox can read the screen and inject synthetic input into
*other* windows via XTEST — verified there directly, including the finding
that X11's own "untrusted" client mode does **not** block it. It is the one
place in this project where a tool gets a channel scoder cannot mediate
once open.

xpra replaces that channel with a rendered-window stream over a unix
socket. The sandboxed IDE talks only to xpra's own virtual X server, inside
the sandbox; nothing it does reaches the host's display.

Also in scope: making xpra installable through `--install-dependencies`
alongside `bubblewrap` and `passt`, so the setup story stays one command.
That turns out to be more than one more package name — the distro's own
xpra is not usable (see Verified Groundwork).

## Why xpra Clears the Bar ADR 0002's Option C Could Not

ADR 0002 considered "a nested X server plus VNC, entirely inside the
sandbox" (option C), called it "structurally the safest of the options that
still uses bwrap," and rejected it for two concrete reasons. xpra defeats
both:

| ADR 0002's objection to option C | Why xpra doesn't have it |
|---|---|
| "needs the same not-yet-built inbound port forwarding" — `buildPastaArgs` hardcodes `--tcp-ports none`, confirmed still true | xpra transports over a **unix socket**, not TCP. A socket in a bind-mounted directory needs no port forwarding at all, and bind mounts are the thing scoder is already built around. |
| "plus a full nested X server, window manager, and VNC stack on top" | xpra is *seamless/rootless*: it forwards individual windows, so there is no desktop session and no window manager to run. It also starts and manages its own virtual X server (`Xvfb`/`Xdummy`), so that is one package, not a stack to assemble. |

So the structural argument ADR 0002 already found most persuasive becomes
affordable. That makes this plan a supersession of ADR 0002's decision, not
a revision of its reasoning — its analysis stands, one of its rejected
options just got cheap.

## Architecture

```
   host                                    │  sandbox (bwrap)
                                           │
   scoder                                  │
     ├─ bwrap ─────────────────────────────┼─→ xpra start
     │                                     │     --bind=<rendezvous>/xpra.sock
     │                                     │     --start-child=<ide>
     │                                     │     --exit-with-children=yes
     │                                     │     --daemon=no
     │                                     │        └─→ rstudio / eclipse
     │                                     │              └─→ its own virtual X
     │                                     │
     └─ xpra attach socket://<rendezvous>/xpra.sock        (windows appear
          (sidecar, outside the sandbox)   │                on the real desktop)
                                           │
        shared: <rendezvous> dir, bind-mounted read-write
```

Three moving parts, only one of them new in kind:

1. **In-sandbox xpra server**, started as the IDE's parent rather than the
   IDE being started directly. Owns a virtual X display that exists only
   inside the sandbox.
2. **A unix socket** in a directory bind-mounted read-write into the
   sandbox — the only thing crossing the boundary.
3. **Host-side `xpra attach` sidecar**, which renders the windows on the
   user's real desktop. Lifecycle-wise this is the same shape as the pasta
   sidecar and the `--allow-ssh` tunnel: a helper process that lives
   *outside* the sandbox, starts once the sandbox exists, and must be
   explicitly reaped because bwrap's `--die-with-parent` does not cover it.

## Verified Groundwork

This section was rewritten after actually building the thing. xpra 6.5.4
was installed from the upstream repo and the whole architecture run
end to end in a scoder-shaped bwrap sandbox. **The design works.**

### Confirmed by running it

| Claim | Result |
|---|---|
| An xpra server starts inside a bwrap sandbox shaped like scoder's | **Yes** — `xpra seamless server version 6.5.4-r0`, `uid=1000`, on its own virtual `X11 display :0` created inside the sandbox. |
| It works with `--unshare-net` still in force | **Yes** — the sandbox had no network namespace access at all. The unix socket is the *only* thing crossing the boundary; pasta is entirely uninvolved. Stronger than this plan originally claimed. |
| A socket in a bind-mounted directory is reachable from both sides | **Yes** — `srw-------` owner-only, created by the server inside, opened by the client outside. |
| A host-side client renders the sandboxed app's window on a real display | **Yes** — the decisive result. `xwininfo` on the stand-in host display listed `0x200028 "xclock on :0" 314x220`: the app's real window, forwarded from the sandbox's private `:0`. |
| The sandbox cannot reach the host's X server once `/tmp/.X11-unix` is not bound | **Yes** — checked directly; `xdpyinfo` against the host display fails from inside. Xvfb inside also logs `/tmp/.X11-unix will not be created`, confirming the sandbox's `/tmp` is its own. |
| `--exit-with-children=yes` makes the server exit with the app | **Yes** — `all children have exited and --exit-with-children was specified, exiting`, then `seamless server is terminating`. Decision 4 holds. |
| The client must wait for the socket | **Yes, and it is not marginal** — the socket appeared **~3s** after launch. Decision 5 is required, not defensive. |
| Software GL works inside the sandbox | **Yes** — `OpenGL is supported on display ':0' using 'llvmpipe'`. With no `/dev/dri` the server logs `Error querying drm devices: -2` and carries on, so the render node helps but is not load-bearing for xpra itself (Decision 8 unchanged). |

### Flag spellings — verified, with two corrections

`--bind=`, `--start-child=`, `--xvfb=`, `--mmap`, `--clipboard` all exist as
assumed. Two corrections to earlier drafts of this document:

- `--exit-with-children=yes|no` **takes a value**; bare `--exit-with-children`
  is wrong.
- `--daemon` **defaults to `yes`**, so `--daemon=no` must be passed
  explicitly or the server detaches and scoder loses its handle on it.

### Which xpra to depend on — settled, and it is not the distro

Checked all three archives directly:

| Source | Version |
|---|---|
| Ubuntu 24.04 (noble) `universe` | `3.1.5+dfsg1` — roughly five years old |
| Ubuntu 26.04 (resolute) | **not packaged at all** |
| PyPI | 6.5.4, but sdist only (full Cython/GTK build) |
| **xpra.org upstream repo** | **6.5.4-r0** |

So `apt install xpra` cannot be the dependency story: on the current LTS it
is years stale, and on the next release it does not exist. The upstream
repo is the answer, which changes the shape of the
`--install-dependencies` work (see Changes Required).

`https://xpra.org/get-xpra.sh` handles it: for Debian/Ubuntu it installs
the signing key to `/usr/share/keyrings/xpra.asc`, fetches a per-codename
`.sources` file from the project's GitHub into
`/etc/apt/sources.list.d/xpra.sources`, then `apt-get update && apt-get
install -y xpra`. Both `noble` and `resolute` are published upstream, so
this covers the current machine and the next one.

The `xpra` metapackage pulls 11 packages including audio and html5. The
split is worth knowing, because the two sides need different halves:
`xpra-server` + `xpra-x11` inside the sandbox, `xpra-client-gtk3` outside.

### Still not verified

- **RStudio and Eclipse specifically.** The spike used `xclock`. Electron
  (RStudio) is the likelier of the two to need coaxing; this is step 2 of
  the sequencing and is not done.
- **mmap throughput**, and rendering performance at IDE window sizes.
- Whether a *real* desktop (rather than an Xvfb stand-in) changes anything
  on the client side.

## Design Decisions

### 1. Server inside the sandbox, client outside — not the reverse

The isolation comes entirely from *which side owns the X server*. If xpra's
server ran on the host and the sandboxed app connected to it, the app would
again hold a live X connection to a display shared with host applications —
the same hole in a different wrapper. Running the server inside means the
only X server the app can reach is one whose entire window list is the
sandbox's own.

### 2. Unix socket, not TCP

Beyond sidestepping pasta's inbound forwarding (above), a socket in a
bind-mounted directory inherits filesystem permissions and the sandbox's
own uid mapping, both of which scoder already controls. A TCP port would
need pasta work, an authentication decision, and a listening surface on the
host. `--bind=<path>` gives an explicit socket path rather than relying on
xpra's own default socket directory, which differs by version and by
`XDG_RUNTIME_DIR`.

### 3. Client and server are guaranteed the same build

xpra is normally sensitive to client/server version skew. Here it cannot
happen: scoder binds the host's `/usr` read-only into the sandbox, so the
in-sandbox server and the host-side client are *literally the same
installed binary*. One install, one version, no compatibility matrix — a
free structural property of this sandbox's design worth stating explicitly,
because it removes the usual reason to pin versions.

### 4. `--exit-with-children` maps onto semantics that already exist

`wrapWithIdeBackground` already encodes "scoder does not return until both
the primary tool and the IDE have exited." Starting the IDE as xpra's child
with `--exit-with-children` keeps that true one layer up: the xpra server
exits when the IDE does, so whatever waits on the server is waiting on the
IDE. Without it, the server would outlive the IDE and hang the session.

### 5. The client must wait for the socket, and must not assume

The in-sandbox server cannot create its socket until bwrap has set up the
sandbox and xpra has started its virtual display; the host-side client is
launched from outside and will lose that race. Two options, in order of
preference:

1. `xpra attach` with whatever retry/wait flag it offers — **unverified
   that one exists**, check first.
2. Otherwise, poll for the socket path with a bounded timeout before
   launching the client, mirroring `waitForChildPid`'s existing shape in
   `src/sandbox/launch.ts` (bounded deliberately, because an unbounded wait
   turns a failed launch into a silent hang — the reasoning there applies
   unchanged).

Do not simply sleep. This project already has a bounded-wait helper and a
comment explaining why the bound matters.

### 6. Reachability must be checked for *both* xpra and the IDE

An earlier draft of this decision said `checkExecTargetReachable` should be
"pointed at `xpra`'s own resolved path, not the IDE's — the IDE is no
longer the exec target." **That was wrong**, and the correction matters
more than the original point did.

The IDE is still executed *inside the sandbox*. All that changes is which
layer execs it: bwrap directly today, xpra's `--start-child` after this.
Its directory therefore still has to be bound in, and it is by far the
likelier of the two to fail that test — `eclipse` lives at
`/opt/eclipse/eclipse` on the reporting machine, and a `~/.local/bin` or
`~/.local/share/...` install is exactly the case this check exists for.
xpra, by contrast, comes from the upstream repo at `/usr/bin/xpra`, under
the wholesale `--ro-bind /usr /usr`, so checking it is cheap insurance
rather than the interesting case.

`src/index.ts` already calls `checkExecTargetReachable` twice, once for the
primary tool and once for the `--ide` companion. **Neither call should be
removed.** xpra is an addition to that list, not a replacement for either.

The reason this is worth more than a footnote: the failure mode gets
*quieter*. Today an unreachable IDE means bwrap cannot exec it and says so
on the console. Under xpra, the server starts cleanly and then fails to
spawn its child — and that failure lands in the xpra log, which is
deliberately redirected away from the console (see `wrapWithIdeBackground`
and `/tmp/scoder-ide.log`). So the up-front check stops being a nicer
diagnostic than the eventual failure and becomes close to the only thing
that will tell the user what went wrong.

**What changes about the exec target itself** depends on Decision 13. If
the entrypoint script is adopted, bwrap's exec target is always that
script, presets supply data rather than a rewritten command, and no new
`ToolPreset` hook is needed at all — the layering moves into bash where it
is legible. If it is not, the exec target becomes `xpra` and the preset
needs some way to say so, for which a new optional
`wrapExec?: (bin, args) => { bin, args }` is the least invasive of the
three shapes considered (versus widening `resolveArgs`' return type for
one caller's benefit, or special-casing xpra inside `buildBwrapCommand`,
which puts preset knowledge in the builder that the preset system exists
to keep out).

### 7. Hard-fail when xpra is missing; never silently fall back to X11

A security-motivated change that quietly degrades to the mechanism it was
meant to replace is the worst possible default: the user believes they got
isolation and did not. GUI presets should fail with the same shape scoder
already uses for its own hard dependencies —

```
xpra not found in PATH
run sudo scoder --install-dependencies
```

— matching the existing `bwrap`/`pasta` checks in `main`. If a deliberate
opt-out is ever wanted, it should be an explicit flag that says what it
gives up, not a fallback that happens by absence.

### 8. `/dev/dri` stays

The GPU render-node bind (added to fix RStudio's `SIGILL` under Chromium —
see `design/features/sandbox-isolation.md`) is about the app's own
rendering inside the sandbox, not about reaching the host display. A DRM
render node is a far narrower grant than an X socket, and removing it
reintroduces a crash this project already debugged at length. Keep it, and
expect it to matter *more* under xpra, since the app is now rendering into
a virtual display rather than handing composition to the host's X server.

### 9. Clipboard becomes a controllable channel instead of an implicit one

Today, X11 passthrough gives the sandbox unrestricted clipboard access
along with everything else. xpra proxies the clipboard as an explicit,
configurable feature (`--clipboard=yes|no`, and direction controls in
recent versions). Defaulting it **on** is therefore not a regression — it
is the same capability, now with an off switch and a name. Worth exposing
as a knob later; not worth blocking this work on.

### 10. D-Bus and `XDG_RUNTIME_DIR` are a *separate* hole this does not close

`guiX11Binds` also passes `XDG_RUNTIME_DIR` and
`DBUS_SESSION_BUS_ADDRESS` through, and `buildBwrapCommand` binds `/run`
read-only — which is how the sandbox reaches the host's session bus. xpra
does nothing about that. A session bus is a real capability channel
(notifications, portals, and whatever else the user's desktop exposes on
it), so **finishing this work does not by itself make GUI presets
isolated** — it closes the largest and best-documented hole, not the last
one. Say so plainly in the new ADR rather than letting "we moved to xpra"
imply more than it delivers. Deciding what to do about D-Bus is separate
work and should get its own plan.

### 11. Per-IDE shutdown metadata must be re-measured, not assumed

`ideShutdown` (signal and children-first/process-first order) was measured
against each real IDE's own process tree — eclipse's launcher-around-a-JVM
wanted children-first, rstudio's `rsession` wanted process-first. Under
xpra the tree gains a layer: the thing `wrapWithIdeBackground` signals is
now the xpra server, not the IDE. `--exit-with-children` should make the
server tear its child down cleanly, which may make both presets converge on
the same setting — but that is a prediction, and this project's own history
with these two IDEs is that their process trees behave differently than
expected. Re-measure both before changing the recorded values.

### 12. The client sidecar must pin `GDK_BACKEND` — found the hard way

The spike lost an hour to this, so it is worth stating plainly. xpra's
client refuses to start with an unhelpful error:

```
'client' failed to initialize Gtk, no display?
```

— even with a working `DISPLAY`, valid `XAUTHORITY`, and `Gtk.init_check()`
returning `True` when called directly. The cause is in
`xpra/scripts/main.py`: `set_gdk_backend()` sets `GDK_BACKEND=wayland`
whenever `is_Wayland()` is true, and `is_Wayland()` keys off
`WAYLAND_DISPLAY` being set — *whether or not a compositor is actually
listening*. A stale `WAYLAND_DISPLAY` in the environment (this container
had one) therefore forces a Wayland backend that cannot initialize, and
the resulting error blames the display rather than the backend choice.
`GDK_BACKEND=x11` fixes it outright.

Implication for the sidecar: do not simply inherit the user's environment
and hope. Decide the backend deliberately from what is actually reachable,
and if the client fails, say which backend was tried — the upstream error
message will not.

### 13. Move the in-sandbox command into an `entrypoint.sh`, not more string concatenation

`wrapWithIdeBackground` currently builds a ~30-line bash program by
concatenating TypeScript string literals, with `biome-ignore` pragmas so
the linter stops reading `${IDE_ARGV[@]}` as a forgotten template
placeholder, ANSI escapes written as `\x1b[0;32m`, and a hand-rolled
`IDE_ARGC` length-prefix scheme so two variable-length argv vectors can be
passed positionally without a sentinel. It already does a lot: setsid
backgrounding, stdin from `/dev/null`, liveness probe, tty-guarded screen
clear, an ENTER-to-close loop with escalation to `SIGKILL`, and
children-first vs process-first signalling.

Adding "start xpra, wait for its socket, start the IDE under it, handle
its failure" to that is the point where generating the script stops paying
for itself. A real `entrypoint.sh`, bound into the sandbox and exec'd as
the entry point, is the better shape: it can be read, commented,
shellcheck'd, and tested directly, and the escaping hazards the current
code carries pragmas to suppress largely stop existing.

Three things to get right, none of them blocking:

**Delivery.** The script has to reach the sandbox somehow. scoder does not
currently ship any runtime asset — every generated script is an inline
string precisely because that avoids a "find my own files at runtime"
problem. But it *does* already write temp files and bind them, in at least
five places (the AGENTS.md overlay, the resolv.conf snapshot, the
passwd/group identity files, the agents snapshot, the `~/.local/bin`
snapshot). So the established pattern is available: keep `entrypoint.sh`
as a real file in the repo, read it at startup, write it into the session's
temp directory, and bind that read-only. That keeps the editable,
lintable file in the repo without introducing an installed-asset-path
problem.

**Interface: named environment variables for metadata, argv for
arguments.** Both commands have their own argument vectors (`pi` with
flags, `/bin/bash -c '...'` in every test), and two variable-length argv
vectors cannot be split positionally without a length prefix or a
delimiter — which is exactly why the current script invented `IDE_ARGC`.
The shape to adopt:

```
HARNESS_ARGC=2 IDE_ARGC=3 \
IDE_LOG=… IDE_SIG=TERM IDE_ORDER=children-first XPRA_SOCKET=… \
  entrypoint.sh  pi --flag val  /opt/eclipse/eclipse -data … -importProject …
```

Counts and settings move to named environment variables; the arguments
themselves stay in `argv`, split by the counts. Two reasons for that split
rather than putting everything in env:

- It keeps the safety property the current script has deliberately, and
  documents in a comment: arguments are never interpolated into a script
  string, so a tool argument containing shell metacharacters cannot be
  reparsed as syntax. Quoting stays the kernel's problem.
- It is what makes today's positional soup readable. The current exec line
  ends `… _ /tmp/scoder-ide.log HUP process-first 2 /opt/eclipse/eclipse …`
  — four positional values whose meaning is entirely conventional. As
  `--setenv IDE_LOG …`, `--setenv IDE_SIG HUP`, `--setenv IDE_ORDER
  process-first` they explain themselves in `--dry-run` output, which
  partly offsets the readability the inline script gives up (below).

Extensibility is the point: a future knob (clipboard direction, an xpra
encoding override, a second companion) is one more named variable rather
than another positional whose index everything else has to shift around.

**It replaces the inner script only.** `wrapWithFdShim` wraps the *bwrap
invocation itself* and runs on the host, outside the sandbox, to hold fds
3 and 9 open. That is a different layer and stays where it is.

One consequence worth deciding on rather than discovering: `--dry-run`
output changes character. Today it prints the entire inline script — ugly,
but completely self-contained, which is part of why it is useful for
debugging. With an entrypoint it prints `entrypoint.sh <args>`, which is
far more readable but no longer tells you what will actually happen
without opening another file. Probably still a net win, but this project
has invested in dry-run output quality recently (secret redaction), so it
should be a choice, not a side effect.

### 14. One session temp root, mirroring sandbox-side paths

scoder currently scatters seven distinct temp prefixes across `/tmp`:
`scoder-agents`, `scoder-agents-md`, `scoder-identity-`, `scoder-launch-`,
`scoder-local-bin`, `scoder-resolv`, `scoder-ssh-`, each created in its own
module with its own random suffix and its own (or no) cleanup. Adding
xpra's rendezvous directory to that makes eight.

Replace the convention with a single per-session root, inside which the
host path mirrors the **sandbox-side absolute path** of whatever is being
bound:

```
/tmp/<session-id>/etc/resolv.conf          → bound at /etc/resolv.conf
/tmp/<session-id>/etc/passwd               → bound at /etc/passwd
/tmp/<session-id>/home/<user>/.agents      → bound at ~/.agents
/tmp/<session-id>/home/<user>/.local/bin   → bound at ~/.local/bin
/tmp/<session-id>/run/xpra/                → bound at /run/xpra/  (rw)
```

What this buys, beyond tidiness:

- **It is plausibly the fix for an open issue.**
  `design/implementation/issues/scoder-local-bin-staging-dirs-leak-into-tmp.md`
  is `status: open`: every invocation — *including `--dry-run`* — leaves a
  `/tmp/scoder-local-bin.XXXXXX` behind, measured at **374 MB** each, with
  ~40 observed accumulating during a single test run. The root cause is
  that cleanup is per-artifact and several artifacts have none. One root
  means one `rm -rf` on the path that already tears the session down, and
  every future artifact inherits cleanup by construction rather than by
  remembering. That makes this refactor pay for itself independently of
  xpra.
- **The bind list becomes derivable.** `source = /tmp/<session-id>{dest}`
  is an invariant a single helper can hold — `sessionPath(dest)` returns
  the host side, and callers always bind `sessionPath(d) → d`. Today each
  call site independently decides both halves.
- **A live session is inspectable in one place**, shaped like the sandbox
  it feeds.

Three things it does not cover cleanly, which should be decided rather
than discovered:

- **Not every temp artifact has a sandbox-side path.** The `scoder-launch-`
  rendezvous holds the `--info-fd`/`--block-fd` fifos and pasta's pid file;
  those are host-only and never bound in, so there is nothing to mirror.
  They need a reserved subtree — `/tmp/<session-id>/.host/` — rather than
  being forced into the rule. Check `scoder-ssh-` the same way rather than
  assuming which side it belongs on.
- **Use a short session id, not a UUID.** Verified empirically: a unix
  socket path is usable to **107 bytes** and fails at 108. Under this
  scheme a full 36-char UUID puts xpra's socket at 89 bytes for a
  realistic `$HOME`-based destination — it works, but with 18 bytes of
  headroom, which a longer username or a deeper destination would spend.
  An 8-hex id gives 61. Prefer the short id and keep socket destinations
  shallow (`/run/xpra/` rather than somewhere under `$HOME`).
- **It is a refactor with its own test surface**, though a small one: only
  6 assertions in `tests/scoder.test.ts` reference the current prefixes.
  Worth doing *before* xpra adds an eighth artifact, not after.

## Changes Required

### `src/cli/parse-args.ts`, `src/index.ts`

`--install-dependencies` currently shells one `apt install bubblewrap
passt`. xpra cannot join that list as-is (see Verified Groundwork: the
distro package is five years stale on noble and absent on resolute), so
this step grows a repository-setup stage before the install:

1. Install the upstream signing key to `/usr/share/keyrings/xpra.asc`.
2. Write `/etc/apt/sources.list.d/xpra.sources` for the host's own
   `VERSION_CODENAME`.
3. `apt-get update`, then install alongside the existing packages.

Two decisions this needs, neither settled here:

- **Reimplement those steps, or shell out to `xpra.org/get-xpra.sh`?**
  The script is 90 lines and handles Fedora/RHEL/Debian/Ubuntu; scoder
  only needs the Debian/Ubuntu path. Piping a remote script to `bash` as
  root inside scoder's own setup command is a meaningfully different
  trust posture from `apt install` against already-configured repos, and
  scoder should probably not do it on the user's behalf. Reimplementing
  the three steps keeps the key pinned and the failure modes legible.
- **Which packages.** The `xpra` metapackage pulls 11, including audio
  and html5. `xpra-server` + `xpra-x11` (sandbox side) and
  `xpra-client-gtk3` (host side) are what is actually used. Narrowing is
  optional but the audio stack in particular contributes only log noise
  here (the spike's client logs filled with `pactl` connection failures
  until audio was disabled).

Also: usage text should mention GUI presets need xpra, and the error on
a missing binary should name this setup command (Decision 7).

### `src/utils/checks.ts`

- Nothing structural; the existing `commandExists` covers the new check.

### `src/tools/presets.ts`

- Rename `guiX11Binds` → `guiDisplayBinds` (it no longer binds X11) and
  strip the three X11 grants: the `/tmp/.X11-unix` bind, the `XAUTHORITY`
  bind and env var, and the `DISPLAY` passthrough. `DISPLAY` inside the
  sandbox is now set by xpra itself for its own virtual display.
- Create the shared rendezvous directory for the socket and bind it
  read-write, following the existing "preset makes a temp dir and binds it"
  convention already used by the agents/local-bin snapshots.
- Add the `wrapExec` implementation (Design Decision 6) producing the
  `xpra start` argv.
- `validate()`: add the `commandExists("xpra")` hard check (Decision 7).
- Keep `/dev/dri` exactly as it is (Decision 8).

### `src/sandbox/xpra.ts` (new)

Mirror `src/sandbox/pasta.ts` closely enough that the two read as siblings:

- `XpraSidecar { pid, socketPath }`
- `attachXpraClient(socketPath)` → spawns `xpra attach socket://…`, returns
  the sidecar or `null` on failure
- `stopXpraClient(sidecar)` → `terminateProcess` from `src/utils/process.ts`,
  the same helper pasta and the ssh tunnel already share
- `waitForXpraSocket(path)` → bounded poll (Decision 5)

### `src/sandbox/launch.ts`

- Start the client sidecar after the sandbox is released (the socket cannot
  exist before then), and stop it in the same `finally` that already reaps
  pasta and the resolv.conf watcher. Ordering matters: teardown should stop
  the client *before* the sandbox dies, or the user sees a frozen window
  during shutdown.

### `src/sandbox/builder.ts`, and possibly `src/sandbox/entrypoint.sh` (new)

- If Decision 13 is adopted: `wrapWithIdeBackground`'s generated script
  moves into `entrypoint.sh`, which grows the xpra layer; `builder.ts`
  writes it to the session temp dir, binds it read-only, and makes it the
  exec target. If not: `wrapWithIdeBackground` grows the xpra layer inline
  and the `wrapExec` hook from Decision 6 is needed.
- Either way, add xpra to the reachability checks **alongside** the
  existing tool and IDE checks, not in place of them (Decision 6).
- No `/dev` changes.

### Docs

- **New ADR 0003**, superseding 0002's decision. 0002 itself stays as-is —
  it is a historical record and its analysis is what makes this plan
  credible; add only a "superseded by 0003" callout at its top, matching
  how this project has handled supersession before.
- `design/features/tool-presets.md`, `design/features/sandbox-isolation.md`:
  replace the X11 trade-off paragraphs.
- `skills/working-in-a-scoder-sandbox/SKILL.md`: the agent inside the
  sandbox should know its display is a private virtual one, not the user's.

### Tests

- `--dry-run` structural tests for the new argv and socket bind, the
  portable majority, in the shape of the existing preset tests.
- One end-to-end test mirroring `rstudio-x11-connectivity-end-to-end`:
  start a real xpra server in a real bwrap sandbox, attach a client, assert
  a window appears. Self-skips without xpra, exactly as the X11 and ssh
  tests already self-skip.
- A negative test worth having: assert `/tmp/.X11-unix` and `XAUTHORITY`
  are **absent** from the built command for GUI presets. That is the actual
  security claim, and it is the one thing a future change could silently
  undo.

## Suggested Sequencing

1. ~~**Manual spike first, no code.**~~ **Done** — see Verified
   Groundwork. The architecture works end to end in a scoder-shaped
   sandbox, and the spike corrected two flag spellings, settled the
   dependency question, and turned up the `GDK_BACKEND` trap (Decision 12)
   that would otherwise have cost the same hour during implementation.
2. Repeat the spike with **real RStudio** and **real Eclipse** — Electron
   is the likelier of the two to need extra flags.
3. Dependencies + `validate()` hard check (small, independently useful).
4. `wrapExec` hook + preset argv construction, verified via `--dry-run`.
5. `src/sandbox/xpra.ts` + launch wiring.
6. Re-measure `ideShutdown` for both IDEs (Decision 11).
7. Docs, ADR 0003, tests.

## Open Questions, Not Resolved Here

- **Performance, and whether mmap is worth wiring up.** The spike's
  session negotiated **no mmap at all** — unsurprising in hindsight, since
  xpra's default mmap file lands in a temp directory that is *not* the
  same directory on both sides of the namespace boundary. Getting it would
  mean pointing `--mmap` at a path inside the shared rendezvous directory.
  Whether plain socket transport is already good enough at IDE window
  sizes is a measurement nobody has taken; `xclock` proves correctness,
  not throughput.
- **Which packages, and whether scoder should run upstream's installer
  script at all** — see Changes Required.
- **Does anything still need the host's real `DISPLAY`?** The `--ide`
  companion flow assumes the IDE and the primary tool share an
  environment; nothing obviously does, but it should be checked rather than
  assumed.
- **D-Bus** (Decision 10) — separate plan.
- **Non-GUI presets are unaffected**, but `--ide` with a future non-X11 GUI
  toolkit (Wayland) is not considered here at all.
