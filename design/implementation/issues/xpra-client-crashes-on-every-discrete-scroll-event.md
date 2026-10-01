---
target-version: 2.6.0
status: open
tags: [issue, xpra, upstream, ide, rstudio]
---

# xpra's Client Raises on Every Discrete Scroll Event

> **Not a scoder bug.** Reproduced with `design/prototype/xpra-no-sandbox.sh`,
> which runs the application under xpra with no bwrap, no namespaces and no
> binds. The fix is a one-line change to xpra 6.5.4 and belongs upstream.

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

## Testing

`design/prototype/xpra-no-sandbox.sh rstudio` reproduces it on the host with
no sandbox involved, and is the right reproducer to send upstream — it is far
more useful to xpra than one that requires bwrap.

Whether scoder should detect an affected xpra and warn is open. The version
range is not established: only 6.5.4-r0 from the xpra.org repository has been
checked.

[IMPACTS](/design/features/xpra-gui-isolation.md)
[HAS_FEATURE](/design/features/xpra-gui-isolation.md)
