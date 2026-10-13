---
target-version: 2.11.0
status: partial
tags: [feature, clipboard, terminal, sandbox, xpra]
---

# Clipboard Sharing

## Summary

Copying from inside a sandbox to the user's clipboard, without giving the
sandbox access to the host's display or session bus. Three routes, in the
order a user meets them:

| Route | Used by | Status |
|---|---|---|
| OSC 52 escape sequence, written to the terminal | TUIs in the terminal — pi, Claude Code, vim/neovim, tmux | **Works** (since the `/dev/tty` fix below) |
| xpra's clipboard sync | GUI presets under xpra (copy in RStudio, VS Code, ...) | Works, built into xpra |
| `xclip` / `xsel` / `wl-copy` / `pbcopy` | CLI tools and scripts that shell out to a clipboard command | **Fails** by design today — option B below is the plan |

## Motivation

Reported: inside a sandbox, copy actions in the terminal silently did
nothing — copying in pi worked outside a sandbox and not inside — and
`echo hello | xclip` failed with `Error: Can't open display: (null)`, in
plain and `--ide` sessions alike. Copying from an xpra-forwarded IDE did
work. Copying out is ordinary, constant work for a user driving an agent,
so silent failure is worse than a missing feature: it looks like the copy
happened.

## OSC 52 — the terminal's own clipboard

[IMPLEMENTED_BY](/src/sandbox/builder.ts#detectHostTty)

OSC 52 needs no display: a program writes `ESC ] 52 ; c ; <base64> BEL` to
the terminal and the terminal emulator sets the clipboard. Inside a sandbox
the user's real terminal is still the program's terminal, so this should
have worked.

**Cause.** bwrap's `--new-session` — kept, see below — leaves the sandbox
with no *controlling* terminal, and `/dev/tty` means "my controlling
terminal", so opening it fails with `ENXIO` ("No such device or address").
Many OSC 52 implementations, pi's among them, write to `/dev/tty` rather
than stdout (so copying works inside pipelines), and failed silently.
Confirmed on the reporting machine: `printf '\e]52;...' > /dev/tty` inside
the sandbox gave exactly that error.

**Fix.** The outer bwrap layer binds the user's actual pty (the terminal
behind scoder's stdout, else stderr, else stdin — the same choice bwrap
makes for `/dev/console`) at `/dev/tty`. The inner layer inherits it through
its `--dev-bind /dev /dev`; the bind has to be in the outer layer because
the inner bwrap sees only the outer layer's fresh devpts, where the host's
`/dev/pts/N` does not exist. Skipped when scoder is not on a terminal.

**Why this is safe.** It grants nothing new: the sandboxed program's fds
0/1/2 are already open on that same terminal. And it does not reopen
`TIOCSTI` keystroke injection — the attack `--new-session` exists to stop —
because the kernel allows `TIOCSTI` only on the caller's *controlling*
terminal, and binding a device does not make it one. Measured under bwrap
with both layers, under a pty: without the bind, `/dev/tty` fails with
ENXIO; with it, the OSC 52 sequence reaches the terminal; with
`dev.tty.legacy_tiocsti=1` (so injection is possible at all), a host process
could inject into its own terminal while `TIOCSTI` through the bound
`/dev/tty` inside the sandbox failed with `EPERM`. (With the modern default
`legacy_tiocsti=0`, it is refused outright.)

**Still needs** a terminal that supports OSC 52. GNOME Terminal and other
VTE-based terminals do not; xterm needs it enabled; tmux needs
`set-clipboard on`. That is between the program and the emulator — scoder
only makes sure the sequence arrives.

**Verified on the reporting machine** with kitty: OSC 52 from inside a
sandbox, via both stdout and `/dev/tty`, reached the host clipboard.
**Konsole** did not, inside or out — very likely because Konsole only gained
OSC 52 (write-only, no conditions checked — its handler in
`Vt102Emulation.cpp` sets the clipboard unconditionally) in 2024, and Ubuntu
24.04 ships Konsole 23.08 (version not yet confirmed on that machine). Copying
in pi *outside* the sandbox works there because, with a display, pi copies
via `xclip`/`wl-copy` rather than OSC 52 — and inside, with no display, it
falls back to OSC 52, which that Konsole drops. Option B below is the route
that works regardless of terminal. Note when checking by hand: plain `xclip`
reads and writes the *primary* selection; OSC 52 `c` sets the *clipboard*
(`xclip -o -selection clipboard`).

**Why not drop `--new-session`.** It is what blocks `TIOCSTI` on kernels
where it is still allowed, and scoder's signal forwarding is built on the
sandbox being its own session.

## xpra's clipboard

GUI presets under xpra already share a clipboard with the host: xpra syncs
the clipboard of its virtual display with the host's, which is why copying
inside an IDE works. That sync is **two-way** by default — the IDE (and so
anything in the sandbox that can reach xpra's display) can also read the
host clipboard, passwords included. xpra's `--clipboard-direction=to-client`
would make it copy-out only, at the cost of pasting into the IDE. Not
changed yet; a decision for the user.

## `xclip` and friends — option B, planned

`xclip`, `xsel`, `wl-copy` and `pbcopy` talk to a display (X or Wayland)
the sandbox deliberately does not have, so they fail. Tools that shell out
to them — some CLIs, scripts, editors with a clipboard command — get
nothing. The plan:

- scoder binds a small socket into the sandbox, and puts stand-ins named
  `xclip`, `xsel`, `wl-copy` and `pbcopy` on the sandbox's `PATH`. Each
  reads the text to copy (from stdin or arguments, matching the real tool's
  copy usage) and sends it down the socket.
- On the host, scoder's own process receives it and sets the clipboard:
  with OSC 52 on its own terminal (which, unlike the sandbox, it controls),
  or with the host's `wl-copy`/`xclip` when OSC 52 is not available.
- **One way only.** The stand-ins can copy, never paste: a "paste" request
  (`xclip -o`, `wl-paste`) returns nothing. The sandbox can never read the
  host clipboard through this.
- Works the same in plain, worktree and `--ide` sessions, with or without
  xpra.

**The remaining risk, stated plainly:** a malicious agent could put a
harmful command on the clipboard for the user to paste into a host
terminal. That is inherent in allowing "copy" at all, and the same risk as
OSC 52 already carries.

Left for later — OSC 52 covers the terminal programs that matter most.

## Rejected: the D-Bus routes

- **The desktop portal's clipboard** (`org.freedesktop.portal`) needs the
  sandbox to reach the host's session bus, which
  [ADR 0004](/architecture/decision-records/0004-no-host-dbus.md) rules out.
- **A custom clipboard service on the sandbox's private bus**, watched by a
  host script, needs a host process connected to a bus that exists only
  inside the sandbox — a lot of plumbing for a one-way text pipe, which
  option B is without the bus.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./xpra-gui-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
