---
target-version: 2.9.0
status: draft
tags: [plan, sandbox, x11, dbus, ide, security]
---

# Native X11 Display As An Explicit Opt-In Alongside xpra

## Goal

Give GUI presets (`rstudio`, `eclipse`, and `vscode` once the preset on
`feat/vscode-preset` merges) a second display path: a `--native-display`
flag that binds the host's X11 socket directly into the
sandbox instead of running the program under an xpra server, for sessions
where xpra's UI translation costs more than its isolation buys. xpra stays
the default and the documented recommendation; native mode is the named,
warned escape valve, not a fallback that happens by absence.

Two failures drive this, both recorded rather than remembered:

- [Dialogs land at the screen origin under xpra, in Eclipse but not
  RStudio](../issues/xpra-dialogs-placed-at-screen-origin.md) — parked. SWT
  computes dialog coordinates against the *virtual* display's single-rectangle
  geometry, which does not match a real multi-monitor layout. Nothing scoder
  can flag away fixes this; the virtual display would have to mirror the
  host's real monitor layout.
- Hovers, tooltips, combobox dropdowns and menus — **override-redirect**
  windows, which bypass the window manager by design and have to be
  reconstructed by xpra's protocol. The one attempt to engage with that here,
  `--modal-windows=yes`, *broke* every dropdown menu and was reverted (see
  the note in [xpra-gui-isolation](/design/features/xpra-gui-isolation.md)).
  This is the structurally hard part of remote display, not a tuning miss.

The scroll stall and the lag were the other two complaint classes and are
already fixed (the `XPRA_SCROLL_ENCODING` workaround for the xpra 6.5.4
regression; path-mirrored mmap). What remains is exactly the class native
mode fixes completely.

The decision record this works against is
[ADR 0003](/architecture/decision-records/0003-xpra-gui-isolation.md), which
withdrew X11 passthrough, and its predecessor
[ADR 0002](/architecture/decision-records/0002-rstudio-x11-access.md), which
measured what passthrough costs. ADR 0003 is about the *default*; this plan
adds an opt-out without weakening it, and ships the amendment
(ADR 0005, below) in the same change rather than as a follow-up.

## The Security Delta, Priced

The native grant is one X connection. What that grants was measured before
ADR 0003 was written, during the ADR 0002 investigation, and the measurement
is what justified the withdrawal:

- **XTEST input injection into every window on the session** — not just the
  sandbox's own windows, and verified directly *not* blocked by X11's
  "untrusted" client mode. That was the surprising finding; it is the load-
  bearing one here.
- **Screen readback** of anything visible anywhere, and **full clipboard /
  X-selection read-write**.

Everything else is orthogonal and untouched by the flag: file binds,
network/pasta, worktree isolation, `.sandbox/` read-only, no host D-Bus
(ADR 0004), no secrets service. Blast radius is the desktop session, nothing
else — which is still "sandboxed code can type into your email window and
read your screen", the reason this must be a per-run, typed, loud choice.

**The host's session type changes the price, and the warning should know
it.** The ADR 0002 measurement was taken on Xorg. On a Wayland session, X
clients reach the desktop through XWayland and the compositor isolates
clients: a misbehaving X client can disturb other XWayland windows, not
Wayland-native ones. Native-on-Wayland is a materially smaller grant than
native-on-Xorg, so the startup warning is calibrated to what is detected
(`WAYLAND_DISPLAY` set and reachable → the smaller wording). The flag is
**X11-only**: granting Wayland-native clients would mean binding the
`wayland-0` socket, and deliberately *not* all of `XDG_RUNTIME_DIR` — the
session bus socket lives inside it and a whole-directory bind would
re-open ADR 0004's hole from the other side. Wayland-native is out of scope;
X clients on a Wayland host simply get XWayland, as they do today outside
scoder.

## Verified Groundwork

### Confirmed by running it, in this repo's current state

- **`--tmpfs /run` is load-bearing and stays** —
  [builder.ts](/src/sandbox/builder.ts) builds `--tmpfs /run` plus a fresh
  `--dir /run/user/<uid>`, and ADR 0004 documents what the old `/run` bind
  leaked (docker.sock, ssh-agent.sock, the session bus — all genuinely
  reachable). **Native mode must not put anything under the host's `/run`
  back into the sandbox.** The old pre-xpra `guiX11Binds` never bound a `/run`
  path and neither does this plan, with one explicitly-carved exception
  (Decision 3).
- **`dbus-run-session` exists and behaves**: verified directly in this
  environment — `dbus-run-session -- dbus-send … ListNames` succeeds, and its
  bus socket lands at `/tmp/dbus-XXXXXXXX`, which inside the sandbox means
  **the sandbox's own `/tmp` tmpfs**, not the host's, and not `/run`. So
  Decision 4 satisfies the `/run` invariant for free.
- **The old grant shape is in git history.** `guiX11Binds` as of the
  commit before `bf9aa5e` (`xpra: give GUI presets a private display instead
  of the host's X server`) is `ro-bind /tmp/.X11-unix`, `ro-bind` the
  XAUTHORITY file, `DISPLAY`/`XDG_RUNTIME_DIR` env passthrough, `/dev/dri`.
  Porting it is mechanical **minus one line**: it also passed
  `DBUS_SESSION_BUS_ADDRESS`, which ADR 0004 has since made forbidden. A
  naive copy-paste would resurrect the hole's address even though the socket
  itself is gone — the port must drop it.
- **The entrypoint already speaks "no xpra".** `XPRA_SOCKET` unset *is* the
  no-xpra path through [entrypoint.sh](/src/sandbox/entrypoint.sh); the
  companion wrap (setsid, logs, ENTER-to-close handshake) is independent of
  the xpra layer and needs no change for the companion case.
- **The host-side attach is already optional**: `launchSandbox` takes the
  socket path as `null` and skips `attachXpraClient`; the `XpraWrap`
  object's absence propagates through the builder, the env vars and launch
  without touching any of them.

### Still not verified — the real-desktop checklist

- That `ro-bind` (not `bind`) of `/tmp/.X11-unix` is sufficient — clients
  `connect()` to socket inodes whose permissions don't need write access to
  the directory, and this was the shipping shape pre-xpra, but it should be
  confirmed again rather than trusted from history.
- Where the user's real host puts its XAUTHORITY. On Wayland/GDM hosts it is
  commonly *under* `/run/user/<uid>/`, which collides head-on with the `/run`
  tmpfs invariant — Decision 3 covers the single-file carve-out, but the
  real path has to be seen.
- Whether the recorded `ideShutdown` values hold — see Decision 9's twist:
  native is *closer* to the conditions they were measured under than xpra is.
- Eclipse/RStudio/VS Code menus and clipboard on a private (non-xpra) bus
  with a *native* display. ADR 0004's sufficiency experiment was a private
  bus *under xpra*; the combination is new.
- The dialog-placement issue disappearing natively (expected: SWT computing
  against the real screen — verify, then update the parked issue).

## Design Decisions

### 1. An explicit per-run flag that names what it gives up

`--native-display`, parsed like every other scoder flag (before the tool
name; *not* `--ide`-style dual-position parsing — this is the operator's
choice, not the tool's business). Valid only with a GUI preset in play —
with a non-GUI tool it is an error naming what the flag does, per
`requireXpra`'s standing principle that an opt-out "should be an explicit
flag that names what it gives up, not something that happens by absence."

Startup prints a two-line warning in `warnIfLoopback`'s shape (see
[ssh.ts](/src/sandbox/ssh.ts)): what the sandbox can now do (inject input
into and read from the whole X session), and what xpra would have done
instead (forward only this session's windows). The Wayland calibration from
the pricing section applies: on a Wayland host the first line names
XWayland's smaller blast radius.

`SCODER_NATIVE_DISPLAY=1` is honoured as the env spelling, for someone who
lives in this mode — the flag stays the discoverable path, the env is the
muscle-memory path.

**Not** a `.sandbox/` setting, deliberately, and worth saying why in the
feature doc. `.sandbox/` is repo-committed project configuration, and
display isolation is a property of *who is running the code*, not of the
repo; a committed file must never be able to carry an isolation downgrade
into a stranger's sandbox (`git clone` → `scoder claude` → silently wider
grant). This is the inverse of `.sandbox/readonly`, which is safe precisely
because it can only *add* protection.

### 2. xpra stays the default; ADR 0003 is amended, not re-litigated

Nothing about the default path changes — the same binds, the same
`requireXpra` hard-fail, byte-identical built commands (pinned by the
existing tests, which must not be edited, only added beside). The new ADR
records that an explicit, warned opt-out exists and that the isolation
decision governs the default; the two parked/tracked xpra issues are
cross-referenced as its motivation, so nobody reopens "tune xpra harder"
for the second time.

### 3. The `/run` tmpfs survives the native path; one carved exception

Native mode's grants are:

| grant | path | type | note |
| --- | --- | --- | --- |
| X socket dir | `/tmp/.X11-unix` | `ro-bind` | applied *after* `--tmpfs /tmp`, so the mountpoint lands in the sandbox's own tmpfs — the same ordering rule the xpra dir bind and the entrypoint already rely on |
| X auth cookie | host `XAUTHORITY` (or `~/.Xauthority`) | `ro-bind`, single file | see below |
| `DISPLAY` | env | passthrough | |
| GPU | `/dev/dri` | dev-bind | unchanged, shared by both modes (it predates xpra — `a4cf925`) |

**No host `/run` directory is ever bound.** The one case that must be
allowed is the XAUTHORITY cookie itself when the host keeps it under
`/run/user/<uid>/`: a **single-file** `ro-bind` of exactly that cookie, with
its sandbox-side parent created via the existing `--dir` machinery. That is
not `/run` coming back — the invariant ADR 0004 bought is closed sockets,
and a read-only copy of one cookie file grants no socket at all — but it
must be written down as a carve-out precisely so it stays a file and never
grows into the directory containing it.

`XDG_RUNTIME_DIR` passthrough is unchanged from today's allowlist: the *env
value* crosses, pointing at the fresh empty `/run/user/<uid>` the sandbox
already creates. Nothing in the host's copy is reachable.

### 4. The GUI program gets its own session bus — never the host's

Under xpra the GUI never asked for this: `xpra start` defaults
`--dbus-launch` to starting a **private session bus inside the sandbox** and
exporting its address into everything `--start-child` runs — the mechanism
ADR 0004 ended up endorsing ("GUI presets keep xpra's private bus, at its
default"). Native mode drops the xpra server, and with it that bus, so the
same *effect* has to be produced without xpra: the GUI argv runs under

```
dbus-run-session -- <gui argv>
```

which starts a private `dbus-daemon --session`, exports
`DBUS_SESSION_BUS_ADDRESS` to the child only, and tears it down when the
child exits. Verified above: the socket is created under `/tmp`, which in
the sandbox is the sandbox's own tmpfs — so the bus lives entirely inside
the sandbox, the `/run` invariant holds untouched, and the built bwrap
command still contains **no** `--setenv DBUS_SESSION_BUS_ADDRESS` at all.
The runtime value comes from inside the sandbox, which is the difference
that matters.

ADR 0004's accidental experiment — a real RStudio on a real private bus with
no host bus reachable, menus fine — is the evidence that a private bus is
sufficient; `dbus-run-session` is the standard tool reproducing it.
(Prefer it over raw `dbus-launch --sh-syntax`, which leaks a daemon when
the client dies uncleanly; xpra uses it because it predates the choice, not
for a reason we inherit.)

**Checklist item:** `dbus-run-session`'s signal forwarding and exit-status
propagation, through bwrap — the wrapper must be transparent enough that
the entrypoint's `wait`/`$?` handshake and `installSignalForwarding`'s
process-group kill still behave. If it isn't, the fallback is a `dbus-daemon
--session --print-address` block managed directly in the entrypoint; record
which one shipped.

### 5. The wrap is argv composition at build time — no new script knob, no second script

`dbus-run-session --` is *two words prepended to the wrapped side's argv*,
and the builder already owns both argv vectors. So it happens there:

| session | xpra mode | native mode |
| --- | --- | --- |
| `scoder rstudio` | entrypoint, `XPRA_TARGET=harness` | **no entrypoint** — bwrap execs `dbus-run-session -- <tool>` directly; the `if (ideBin \|\| xpra)` gate does not grow |
| `scoder pi --ide rstudio` | entrypoint, `XPRA_TARGET=ide` | entrypoint unchanged (`XPRA_SOCKET` unset already means no xpra); `dbus-run-session --` prepended to the IDE argv vector |

Two rejected shapes, recorded so they are re-litigated only with new
information:

- **A second `entrypoint-native.sh`.** A direct-GUI script could own exactly
  one of the three session shapes — the trivial one. `--ide` needs the
  companion/handshake apparatus, and that is the half that must never fork
  (it carries the measured shutdown behaviour and the script's invariants:
  the `HARNESS_ARGC` split, no-argv-interpolation, the exit-status-is-the-
  harness's rule). Parallel maintenance would therefore be two files that
  both carry the complex half, to save one branch in the simple case.
- **A `DBUS_TARGET` knob in the existing script.** The precedent for
  rewriting argv *inside* the script is `xpra_wrap`, and it exists because
  xpra has runtime knowledge there — `XPRA_EXTRA_ARGS` is env read in-
  sandbox. The dbus wrap has no runtime knowledge; a knob would re-implement
  argv plumbing the builder already has. If native-direct later grows real
  in-sandbox behaviour (placement diagnostics, display probes), the seam is
  a function in the one script, not a second file.

Consequence to measure, identical under either rejected shape and so not a
cost of this choice: in the companion case `$!` becomes `dbus-run-session`'s
pid — the same wrapper-above-the-IDE layering `xpra_wrap` already
introduced, so Decision 4's signal-forwarding and exit-propagation
checklist item is unchanged, not new.

### 6. `guiDisplayBinds` grows a mode branch; it stays the single choke point

ADR 0003 deliberately made one function own every GUI display grant.
It owns both now: xpra branch unchanged (stage dir, mmap, allowlisted env);
native branch the pre-`bf9aa5e` shape with the `DBUS_SESSION_BUS_ADDRESS`
line **deleted** (Decision 3). How the mode reaches it is a small plumbing
choice — a parameter through `configBinds`, or a module-level display mode
set once in `index.ts` (the latter matches how `process.cwd()` already
reaches `configBinds`; the former is cleaner; decide at implementation,
don't let it sprawl into both).

`buildXpraClientArgs`, `attachXpraClient`, `stageXpraDir` and the whole host
sidecar are untouched — native mode simply never constructs an `XpraWrap`,
and every downstream conditional already handles `undefined`.

### 7. Validation fails *before* exec, in native mode too

`requireXpra()` in each GUI preset's `validate()` becomes mode-aware:
xpra mode unchanged (refuse with the install hint); native mode instead
preflights what native actually needs — host `DISPLAY` set,
`/tmp/.X11-unix` present, the XAUTHORITY file readable — and refuses with
what's missing. Without this, a native misfire surfaces as `cannot open
display` in sandbox stderr or, worse for `--ide`, in `$IDE_LOG` where
nobody looks. The host `which("xpra")` reachability check in `index.ts`
stays gated on an xpra wrap existing, as it already is.

### 8. `ideShutdown` under native is closer to how it was measured

The recorded shutdown values (`eclipse` TERM/children-first, `rstudio`
HUP/process-first) were measured against a **directly-exec'd** IDE; the
xpra layer interposed a server between the signal and the IDE, which the
feature doc explicitly flags as un-re-measured. Native mode removes that
interposition, so the recorded values should apply as-measured — but "should"
is what the checklist's shutdown matrix item is for, and the vscode preset's
deliberately-unrecorded shutdown spec gets measured through whichever mode
the user tested in, labelled as such.

### 9. Interactions, enumerated so nobody rediscovers them

- **`--ide` + `--native-display`**: works; both flags parse before/around the
  tool name as they already do. The companion table in
  [ide-companion](/design/features/ide-companion.md) gains the native row's
  signal note.
- **`--dry-run`**: describes the native bind set and the `dbus-run-session`
  wrap without starting anything, same convention as `describeSshAccess`
  and `buildPastaArgs`.
- **Two concurrent GUI sessions**: native needs no new per-session plumbing
  (no socket to collide on); window identity is unchanged — the ENTER-to-close
  trick already names pid and app.
- **Clipboard**: native is the implicit X selection channel; xpra's proxied
  `--clipboard=yes` is mode-specific by construction, nothing to do.
- **Notifications**: the xpra notifications channel (ADR 0004's outward-only
  reversal) has no native equivalent — notifications from a native session go
  wherever the app sends them, which with no bus is nowhere; say so in the
  feature doc rather than leaving it to be noticed.

## Changes Required

- **`src/cli/parse-args.ts`** — `--native-display` flag + `--help` entry
  naming the cost.
- **`src/index.ts`** — display mode resolution; skip `XpraWrap` construction
  and the host-xpra reachability check in native mode; the two-line warning
  (Wayland-calibrated).
- **`src/tools/presets.ts`** — `guiDisplayBinds` mode branch (Decision 6);
  `requireXpra` → mode-aware validation for `rstudio`, `eclipse` (and
  `vscode` when that branch merges); XAUTHORITY single-file carve-out.
- **`src/sandbox/builder.ts`** — pass the native grants (X socket dir,
  cookie, `DISPLAY`); prepend `dbus-run-session --` to the wrapped side's
  argv (Decision 5).
- **`src/sandbox/entrypoint.sh`** — **no change.** `XPRA_SOCKET` unset
  already means no xpra layer, and the dbus wrap happens at build time.
- **`src/sandbox/xpra.ts` / `launch.ts`** — no change (the `undefined` path
  already exists end-to-end).
- **Docs** — ADR 0005 (the amendment; its pricing section is the warning
  text); "Native mode" section in
  [xpra-gui-isolation](/design/features/xpra-gui-isolation.md) with the two
  issue docs as recorded motivation; README flag section quoting the warning;
  the dialog-placement issue updated if the desktop checklist confirms the
  fix; validation-suite cases below.

## Test Plan

Dry-run and build-level, matching how the xpra layer itself is tested:

1. **Default path byte-identical** — the existing xpra tests are the
   regression guard and are not edited. This is the cheap half of "xpra is
   still the default."
2. **Native grants present**: `--native-display --dry-run rstudio` contains
   the `/tmp/.X11-unix` ro-bind, the cookie ro-bind, `DISPLAY`, an exec line
   beginning `-- dbus-run-session --`, and no `XPRA_SOCKET`/`XPRA_MMAP`.
3. **`/run` invariants hold in native mode**: `--tmpfs /run` still in the
   built command; no bind whose source starts with `/run/` except the exact
   cookie file; **no `--setenv DBUS_SESSION_BUS_ADDRESS` anywhere** — the
   ADR 0004 guard test, now mode-scoped to *both* modes.
4. **Native grants absent by default / xpra grants absent natively**: the
   existing "sandbox sees xpra socket, not host X11" guard gains its mirror
   image ("with the flag, no xpra dir bind; without it, no X11 bind"), so
   neither mode can leak into the other.
5. **Non-GUI + flag is a named error**; companion form wraps the IDE argv in
   `dbus-run-session --` on the entrypoint invocation, harness argv and all
   `IDE_*` variables untouched.
6. **Runtime spot-check where the container allows**: a `dbus-run-session`
   shim/fake-GUI test that the child sees a `DBUS_SESSION_BUS_ADDRESS` under
   `/tmp/dbus-*` and that exit status survives the wrap. Full display
   round-trip (Xvfb + fake client) is optional — the real-desktop checklist
   carries the display cases.

## Sequencing

1. Draft ADR 0005 first — the pricing section *is* the warning text, and the
   amendment settles the default-vs-optout framing before code.
2. Flag + `guiDisplayBinds` branch + native validation + warning.
3. The `dbus-run-session --` argv prepend, direct and companion forms, plus
   its runtime checks (Decision 4's checklist folded in) — no entrypoint
   changes (Decision 5).
4. Tests, then the docs sweep, then the real-desktop checklist against the
   same live desktop the vscode preset's checklist needs — the two checklists
   deliberately share a session.
