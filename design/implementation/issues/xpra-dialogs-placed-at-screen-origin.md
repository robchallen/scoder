---
target-version: 2.8.0
status: open
tags: [issue, xpra, ide, eclipse, placement]
---

# Dialogs Land at the Screen Origin Under xpra, in Eclipse but Not RStudio

Low severity, parked. Recorded while the observations were fresh rather
than worked on, because the split between the two IDEs is the useful part
and would be easy to lose.

## Symptoms

Reported from a real desktop with an unusual multi-monitor layout:

| application | window | where it lands |
|---|---|---|
| Eclipse | splash screen | top left of the monitor **layout** |
| Eclipse | most alerts | top left of the layout |
| Eclipse | Save As | top left of the layout |
| RStudio | splash screen | centred on the primary monitor — correct |
| RStudio | Save As | centred on the application window — correct |

## Why the split is the clue

"Top left of the layout" is `(0, 0)` of the X screen's bounding box, which
is what a window gets when it carries an explicit position of `(0, 0)` or
one that clamped there — not what a window manager does when left to place
a window itself.

That points at the toolkit rather than at xpra's defaults, and the two IDEs
differ in exactly the right way:

- **Eclipse is Java/SWT**, which positions its shells *explicitly*, computing
  coordinates from the parent shell and the display bounds.
- **RStudio is Electron/Chromium**, which largely leaves placement to the
  window manager, or asks for "centre on parent".

So the application that computes its own coordinates gets them wrong, and the
one that delegates gets them right. The coordinates SWT computes are in the
**virtual** display's geometry inside the sandbox; what reaches the host is
that absolute position, interpreted against a real monitor layout that does
not match. A single-rectangle virtual display standing in for an unusual
multi-monitor arrangement would do this.

## Ruled out

- **`--modal-windows=yes`** — tried, reverted. It completely breaks drop-down
  menus, because it arms a code path that fires on every override-redirect
  window. See `xpra-gui-isolation`. It was also aimed wrongly: modal governs
  input, not position.

## Worth collecting next time

- Whether the virtual display's geometry matches the host layout:
  `xpra info | grep -i "screen\|monitor"` against the host's own layout.
- Whether `--resize-display` on the server changes anything.
- Whether a single-monitor host shows it at all — if not, the multi-monitor
  geometry is confirmed as the cause rather than inferred.
- Whether Eclipse alone shows it on the host *without* scoder, using
  `design/prototype/xpra-no-sandbox.sh`. That is the test that should have
  come first in the scroll investigation and would settle whether scoder is
  involved at all.
