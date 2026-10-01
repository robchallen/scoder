#!/usr/bin/env bash
#
# xpra-no-sandbox.sh — is scoder involved in the GUI problem at all?
#
# Run this from a NORMAL HOST SHELL, not inside a scoder sandbox. It runs an
# application under xpra with the same flags scoder's entrypoint uses, but
# with NO bwrap, no namespaces and no binds. Everything else about the setup
# is identical, so the only variable removed is the sandbox itself.
#
#   ./xpra-no-sandbox.sh rstudio
#   ./xpra-no-sandbox.sh /opt/eclipse/eclipse
#   ./xpra-no-sandbox.sh xclock            # a trivial control
#
# Why it exists: every attempt at RStudio's mousewheel scrolling so far has
# varied a setting INSIDE the scoder + xpra + Electron stack — the transport
# (mmap vs scroll encoding), the wheel event rate (--mousewheel=coarse), the
# inotify budget, and Chromium's GPU flags. All were eliminated. What had
# never been varied is whether the sandbox matters, which this answers.
#
#   Still laggy  -> an xpra/Electron interaction. scoder cannot fix it, and
#                   this script is the reproducer to report upstream, which
#                   is far more useful to xpra than one involving bwrap.
#   Smooth       -> the sandbox is implicated, and the search narrows to what
#                   bwrap changes for a Chromium process: a missing device,
#                   /proc or /sys visibility, shared memory, the IPC
#                   namespace.
#
# The flags below are kept deliberately in step with src/sandbox/entrypoint.sh
# and src/sandbox/xpra.ts. If those change, change these, or the comparison
# stops meaning anything.

set -u

APP=${1:-xclock}
SOCKET=${XPRA_TEST_SOCKET:-/tmp/xpra-no-sandbox-$$.sock}

command -v xpra >/dev/null || {
	echo "xpra not found in PATH" >&2
	exit 1
}

cleanup() {
	[ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
	rm -f "$SOCKET"
}
trap cleanup EXIT INT TERM

echo "Starting xpra server (no sandbox) with child: $APP"
echo "Socket: $SOCKET"
echo

# --input-method=keep, not =none: 'none' makes xpra set GTK_IM_MODULE=xim for
# every child, which Eclipse's SWT warns is unsupported. See entrypoint.sh.
xpra start \
	--bind="$SOCKET" \
	--daemon=no \
	--exit-with-children=yes \
	--start-child="$APP" \
	--input-method=keep \
	--notifications=no \
	--printing=no \
	--audio=no \
	--speaker=no \
	--microphone=no \
	--webcam=no \
	--pulseaudio=no &
SERVER_PID=$!

# The socket appears a few seconds after launch — measured at ~3s — so the
# client has to wait for it rather than assume, exactly as waitForXpraSocket
# does in src/sandbox/xpra.ts. Bounded, for the same reason: an unbounded
# wait turns a failed launch into a silent hang.
echo "Waiting for the server socket..."
for _ in $(seq 1 300); do
	[ -S "$SOCKET" ] && break
	kill -0 "$SERVER_PID" 2>/dev/null || {
		echo "server exited before creating its socket" >&2
		exit 1
	}
	sleep 0.1
done
[ -S "$SOCKET" ] || {
	echo "timed out waiting for $SOCKET" >&2
	exit 1
}

echo "Attaching client. Ctrl-C to detach and shut down."
echo

# GDK_BACKEND pinned for the reason xpraClientEnv pins it: xpra's client sets
# GDK_BACKEND=wayland whenever WAYLAND_DISPLAY is merely *set*, whether or not
# a compositor is listening, and then fails with a message blaming the display
# rather than the backend.
if [ -n "${DISPLAY:-}" ]; then
	export GDK_BACKEND=x11
elif [ -n "${WAYLAND_DISPLAY:-}" ]; then
	export GDK_BACKEND=wayland
fi

# No --mmap here: with no sandbox there is no namespace boundary, so xpra
# picks its own path under $XDG_RUNTIME_DIR and gets mmap without help. That
# differs from the sandboxed case only in the path, not the mechanism.
xpra attach "socket://$SOCKET" \
	--daemon=no \
	--audio=no \
	--speaker=no \
	--microphone=no \
	--printing=no \
	--webcam=no \
	--clipboard=yes
