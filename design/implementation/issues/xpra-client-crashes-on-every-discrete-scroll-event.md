---
target-version: 2.6.0
resolved-in: 2.6.0
status: resolved
tags: [issue, xpra, upstream, ide, rstudio]
---

# xpra's Client Raises on Every Discrete Scroll Event

> **Resolved upstream in xpra 6.5.5 (2026-10).** scoder now requires
> xpra >= 6.5.5 — checked by `--install-dependencies` and by every GUI
> session's preflight — instead of pinning 6.5.3, and removes the old pin
> file it wrote. Verified: the dev container upgraded 6.5.4 → 6.5.5 through
> `--install-dependencies`, and the GUI tests pass on it. The history below
> is kept as written.
>
> **Not a scoder bug, and a regression.** Introduced in xpra **6.5.4**;
> 6.5.3 and every earlier version checked are unaffected. Reproduced with
> `design/prototype/xpra-no-sandbox.sh`, which runs the application under
> xpra with no bwrap, no namespaces and no binds. Fixable by a one-line
> patch, or by downgrading to 6.5.3 — both below.

## Summary

Every non-smooth scroll event delivered to xpra's GTK3 client raises an
`AttributeError`, because the client calls a method that does not exist:

```
File "/usr/lib/python3/dist-packages/xpra/client/gtk3/window/pointer.py",
  line 293, in _do_scroll_event
    pointer_sub = self.get_subsystem("pointer")
AttributeError: 'GLClientWindow' object has no attribute 'get_subsystem'
```

`get_subsystem` (singular) exists nowhere in xpra 6.5.4. The only similar
name is `get_subsystems` (plural), on the *server* (`xpra/server/core.py`,
`xpra/server/base.py`). The class named in the traceback is incidental — any
client window class would fail, since the method was never defined on the
client side at all.

## Why it causes multi-second stalls

The handler returns early for smooth scroll events and only reaches the
broken line for discrete ones:

```python
if event.direction == Gdk.ScrollDirection.SMOOTH:
    ...
    self._client.wheel_event(device_id, self.wid, norm_x, -norm_y, pointer)
    return True                                   # smooth: fine
pointer_sub = self.get_subsystem("pointer")       # discrete: raises
```

GDK delivers *emulated discrete duplicates* alongside smooth events, for the
benefit of clients that did not ask for `SMOOTH_SCROLL_MASK` — which is
exactly what the next line, guarded by `SKIP_DUPLICATE_SCROLL_EVENTS` and
`event.get_pointer_emulated()`, exists to filter out. So in normal use every
physical notch produces at least one event that raises, and each raise prints
a full traceback.

Formatting and writing a traceback per event, on the client's UI thread, is
what produces the symptom: the UI stops responding, nothing intermediate is
drawn, and the view then jumps to its final position. The server's own
telemetry confirms the client falling behind:

```
delayed region timeout
 region is 7 seconds old, will retry - bad connection?
 8 late responses:
     77 mmap :   9s
     ...
```

## It is a regression, introduced in 6.5.4

Bisected by downloading each package from the xpra.org repository and
inspecting the file — no installation needed:

| version | `get_subsystem(` calls in the scroll handler |
|---|---|
| 6.4.4-r0-1 | 0 |
| 6.5-r0-1 | 0 |
| 6.5.1-r0-1 | 0 |
| 6.5.2-r0-1 | 0 |
| 6.5.3-r0-1 | 0 |
| **6.5.4-r0-1** | **1** |

Diffing the handler between 6.5.3 and 6.5.4 shows the whole block is new —
it is not a line that changed, it is a feature added in 6.5.4 that cannot
ever have worked:

```diff
+        pointer_sub = self.get_subsystem("pointer")
+        if SKIP_DUPLICATE_SCROLL_EVENTS and pointer_sub and pointer_sub.wheel_smooth and event.get_pointer_emulated():
+            log("ignoring emulated scroll event: direction=%i", event.direction)
+            return True
```

`SKIP_DUPLICATE_SCROLL_EVENTS` defaults to `True`
(`XPRA_SKIP_DUPLICATE_SCROLL_EVENTS`), but that makes no difference here: the
`get_subsystem` call is on its own line and runs before the condition is
evaluated, so no environment variable avoids it.

That also means 6.5.3 and earlier do not merely lack the bug — they lack the
suppression entirely, and forward emulated duplicates as ordinary button
events.

## Fix

One line, consistent with how the same file reaches the same object twice
elsewhere — `self._client.wheel_smooth` at line 96 and
`self._client.wheel_event(...)` at line 291:

```diff
-        pointer_sub = self.get_subsystem("pointer")
+        pointer_sub = self._client
```

Applied locally with:

```bash
sudo cp /usr/lib/python3/dist-packages/xpra/client/gtk3/window/pointer.py{,.orig}
sudo sed -i 's/pointer_sub = self\.get_subsystem("pointer")/pointer_sub = self._client/' \
    /usr/lib/python3/dist-packages/xpra/client/gtk3/window/pointer.py
```

Reverted by restoring the `.orig`, or by reinstalling `xpra-client-gtk3`.
Verified that the patched file parses and that no `get_subsystem(` call
remains.

This enables the suppression for the first time rather than restoring 6.5.3's
behaviour, since 6.5.3 had no such block. That is what the author intended,
and should be an improvement — 6.5.3 forwards the emulated duplicates as
extra button events — but it is newly exercised code.

### Or downgrade, which carries no such uncertainty

6.5.3 is still in the repository, and all the xpra packages must be pinned
together or apt will refuse:

```bash
sudo apt install --allow-downgrades \
    xpra=6.5.3-r0-1 xpra-client=6.5.3-r0-1 xpra-client-gtk3=6.5.3-r0-1 \
    xpra-server=6.5.3-r0-1 xpra-x11=6.5.3-r0-1 xpra-codecs=6.5.3-r0-1 \
    xpra-common=6.5.3-r0-1
```

Add `xpra-audio`, `xpra-audio-server` and `xpra-codecs-extras` at the same
version if they are installed. `xpra-html5` versions independently and does
not need pinning.

## What scoder does about it

`--install-dependencies` installs `xpra=6.5.3-r0-1` and writes an apt pin at
`/etc/apt/preferences.d/scoder-xpra.pref`:

```
Package: xpra xpra-client xpra-client-gtk3 xpra-server xpra-x11 xpra-codecs xpra-codecs-extras xpra-common xpra-audio xpra-audio-server
Pin: version 6.5.3-r0-1
Pin-Priority: 1001
```

Three details, each verified against apt rather than assumed:

- **Priority 1001, not 500 or 990.** Above 1000 is the specific thing that
  lets apt *downgrade* an already-installed package, which a machine already
  on 6.5.4 needs. Checked: with the pin in place, `apt-cache policy xpra`
  reports `Candidate: 6.5.3-r0-1` while `Installed: 6.5.4-r0-1`.
- **An explicit package list, not an `xpra*` glob.** `xpra-html5` versions
  independently (21-r1-1), and a glob would pin it to a version that does not
  exist. Confirmed that it is unaffected by this stanza. Pinning a package
  that is not installed is harmless — it only constrains it if it ever is.
- **It fixes the hand-downgrade conflict.** Listing the packages manually on
  the command line makes apt resolve them piecemeal, which is why
  `xpra-audio-server` conflicted when the downgrade was first done by hand.
  With the pin present apt solves the whole set at once: `apt-get
  --just-print upgrade` plans all ten packages down to 6.5.3 together,
  `xpra-audio-server` included. So on a machine where that package was left
  behind at 6.5.4, `sudo apt upgrade` now completes the downgrade.

The pin is deliberately to an exact version rather than a
`Pin: version 6.5.4*` / `Pin-Priority: -1` block-the-bad-one rule. The latter
would pick up a future fixed release automatically, which is attractive, but
it would equally pick up 6.5.5 if that ships before the fix — and the failure
is silent and baffling. The file says in a comment to delete it once upstream
has fixed this, which is the point at which someone should be looking anyway.

## What this explains about the investigation

It accounts for the results that made no sense individually, and for why
several plausible hypotheses each tested negative:

- **`--mousewheel=coarse` made things worse, not better.** `coarse` stops the
  client requesting `SMOOTH_SCROLL_MASK`, so *every* event becomes discrete
  and every one raises. The explanation for trying it — that the event rate
  was too high — was wrong, but the direction of the result is exactly what
  this bug predicts.
- **No transport, GPU or rendering setting helped**, because nothing was
  wrong with rendering. `--mmap=no`, `--disable-gpu`,
  `--disable-gpu-compositing`, `--disable-smooth-scrolling`,
  `--ignore-gpu-blocklist --use-gl=egl`: all irrelevant to an exception
  thrown before the event is ever sent.
- **Scrollbar dragging stayed smooth throughout**, because dragging produces
  pointer-motion events, which never enter this handler.
- **The stall was seconds long with no intermediate frames**, which never fit
  a throughput explanation and should have pointed at blocking much sooner.

## Upstream report

Ready to paste at <https://github.com/Xpra-org/xpra/issues>. Kept short
deliberately: the project carries well over a hundred open issues, so this
leads with the regression and the one-line fix, and is written so a
maintainer can confirm it by reading rather than by running anything.

---

**Title:** `6.5.4 regression: AttributeError on every discrete scroll event (get_subsystem is not defined)`

Since 6.5.4, every non-smooth scroll event raises in the GTK3 client:

````
File "xpra/client/gtk3/window/pointer.py", line 293, in _do_scroll_event
    pointer_sub = self.get_subsystem("pointer")
AttributeError: 'GLClientWindow' object has no attribute 'get_subsystem'
````

`get_subsystem` is not defined anywhere in 6.5.4 — the only similar name is
`get_subsystems()` on the server. The window class in the traceback is
incidental.

**Introduced in 6.5.4.** The whole block is new: 6.5.3 contains neither
`get_subsystem` nor `SKIP_DUPLICATE_SCROLL_EVENTS`.

````python
# xpra/client/gtk3/window/pointer.py, _do_scroll_event()
        pointer_sub = self.get_subsystem("pointer")          # <- raises
        if SKIP_DUPLICATE_SCROLL_EVENTS and pointer_sub and pointer_sub.wheel_smooth and event.get_pointer_emulated():
````

`XPRA_SKIP_DUPLICATE_SCROLL_EVENTS=0` does not avoid it: the call is on its
own line, evaluated before the condition it feeds.

**Impact.** Smooth events return earlier so scrolling partly works, but GDK
also delivers emulated discrete duplicates — exactly what this block exists
to filter. Each raises and prints a traceback on the client's UI thread,
stalling the GUI for several seconds per wheel notch. Electron applications
(RStudio) become unusable; the server reports the client falling ~9s behind
with `delayed region timeout ... late responses`.

**Fix.** The same object is reached as `self._client` twice elsewhere in the
file (lines 96 and 291):

````diff
-        pointer_sub = self.get_subsystem("pointer")
+        pointer_sub = self._client
````

Downgrading to 6.5.3 removes the stall entirely, confirming the bisect.

**Reproduce** with any GTK application:

````
xpra start --bind=/tmp/t.sock --daemon=no --exit-with-children=yes --start-child=xterm
xpra attach socket:///tmp/t.sock
````

then scroll with a mouse wheel.

**Environment:** xpra 6.5.4-r0 (xpra.org repo), Ubuntu 24.04 noble, Python
3.12, GTK3 client and seamless server.

---

## Testing

`design/prototype/xpra-no-sandbox.sh rstudio` reproduces it on the host with
no sandbox involved, and is the right reproducer to send upstream — it is far
more useful to xpra than one that requires bwrap.

Whether scoder should detect an affected xpra and warn is open, and now
cheap: the affected range is known to start at 6.5.4, so a version check
against `xpra --version` would be a two-line test with an accurate message.
Worth doing if upstream is slow, since the symptom is baffling and nothing
about it points at xpra.

[IMPACTS](/design/features/xpra-gui-isolation.md)
[HAS_FEATURE](/design/features/xpra-gui-isolation.md)
