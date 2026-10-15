---
target-version: 3.0.1
status: resolved
tags: [issue, gui, native-display, eclipse, accessibility]
---

# GUI Presets Crash in the AT-SPI Bridge Under `--native-display`

## Symptoms

Reported on Ubuntu 26.04: `scoder --native-display eclipse` crashed shortly
after start-up, the JVM reporting

```
SIGSEGV (0xb) ...
# Problematic frame:
# C  [libatk-bridge-2.0.so.0+0x11778]  spi_register_object_to_path+0x28
```

— native code in GTK's accessibility (AT-SPI) bridge, which SWT loads, not
Eclipse or the JVM.

## Cause

The bridge registers the application with the accessibility bus. It finds
that bus on the session bus (private in a scoder GUI session, without the
host's accessibility service) or from the `AT_SPI_BUS` property on the X
root window. Under `--native-display` the program is on the host's X
session, so it reads the host desktop's address — a socket under
`/run/user/<uid>/at-spi/` that does not exist in the sandbox, whose `/run`
is a tmpfs. Older at-spi2 failed quietly; the version in 26.04 crashes.
Under xpra the program is on xpra's X server, which has no such property.

Confirmed by the reporter: with `--env NO_AT_BRIDGE=1` Eclipse stays up.

## Fix and decision

GUI presets set `NO_AT_BRIDGE=1` (GTK 2/3's atk-bridge) and
`GTK_A11Y=none` (GTK 4) in every session, xpra and `--native-display`
alike (`guiDisplayBinds` in `src/tools/presets.ts`). **Accessibility is
not supported in scoder GUI sessions**, by decision: the host's
accessibility bus is unreachable by design (no host D-Bus, ADR 0004), and
xpra forwards no accessibility information, so there was nothing working
to keep. Test: `gui-presets-disable-the-accessibility-bridge`.
