#!/bin/bash
# scoder's in-sandbox entry point.
#
# bwrap execs this instead of the tool directly whenever there is a companion
# IDE to run (--ide), or a GUI program that needs an xpra server, or both. It
# owns everything that has to happen *inside* the sandbox: starting the xpra
# server, starting the IDE, backgrounding it, running the primary tool in the
# foreground, and the shutdown handshake when one outlives the other.
#
# It replaces a ~30-line bash program that src/sandbox/builder.ts used to build
# by concatenating TypeScript string literals, with biome-ignore pragmas so the
# linter would stop reading "${IDE_ARGV[@]}" as a forgotten JS template
# placeholder, ANSI escapes spelled \x1b[0;32m, and a hand-rolled length-prefix
# scheme buried in positional arguments. Adding the xpra layer to that was the
# point where generating the script stopped paying for itself. As a real file it
# can be read, commented, shellcheck'd and edited.
#
# It does NOT replace wrapWithFdShim, which wraps the bwrap invocation itself
# and runs on the host, outside the sandbox, to hold fds 3 and 9 open. Different
# layer, stays where it is.
#
# ---------------------------------------------------------------------------
# Interface
#
#   HARNESS_ARGC=<n>   argv entries belonging to the primary tool, including
#                      its binary. Required, and at least 1.
#   IDE_ARGC=<n>       argv entries belonging to the companion IDE, including
#                      its binary. They follow the harness's. 0 or unset means
#                      there is no companion.
#   IDE_LOG=<path>     where the IDE's stdout and stderr go.
#   IDE_SIG=<NAME>     signal used to ask the IDE to close, without SIG.
#   IDE_ORDER=children-first|process-first   who gets signalled first.
#   XPRA_SOCKET=<path> when set, a GUI program runs under an xpra server bound
#                      to this unix socket. Unset for a non-GUI session.
#   XPRA_MMAP=<path>   shared-memory file for the fast transport. Must be the
#                      same path the host-side client uses.
#   XPRA_EXTRA_ARGS    extra flags appended to `xpra start`, word-split. An
#                      escape hatch for tuning a GUI session without a code
#                      change — scoder forwards SCODER_XPRA_SERVER_ARGS here,
#                      and any XPRA_* variable set on the host.
#   XPRA_TARGET=ide|harness   which of the two the server wraps. Only read
#                      when XPRA_SOCKET is set; defaults to ide.
#   XPRA_LOG=<path>    where the xpra server's own log goes.
#
#     HARNESS_ARGC=3 IDE_ARGC=5 IDE_SIG=HUP … entrypoint.sh \
#         pi --flag val  /opt/eclipse/eclipse -data … -importProject …
#
# Counts and settings are named environment variables; the arguments themselves
# stay in argv. That split is deliberate, and the safety half of it is the
# reason: an argument is never interpolated into a string that is later parsed
# as shell, so a tool argument containing shell metacharacters cannot be
# reparsed as syntax. Quoting stays the kernel's problem. The readability half
# is that `--setenv IDE_SIG HUP` explains itself in --dry-run output, where the
# positional scheme it replaced ended `… _ /tmp/scoder-ide.log HUP
# process-first 2 /opt/eclipse/eclipse …` and explained nothing. Extensibility
# follows: a new knob is one more named variable, not another positional whose
# index everything downstream has to shift around.

set -u

GREEN='\033[0;32m'
RESET='\033[0m'

say() { printf "${GREEN}scoder: %s${RESET}\n" "$1" >&2; }
die() { printf "${GREEN}scoder: %s${RESET}\n" "$1" >&2; exit 1; }

# --- split argv ------------------------------------------------------------
# Order is harness first, then IDE. Both vectors are variable-length, which is
# why the counts exist at all: there is no delimiter that a tool argument could
# not itself legitimately contain.

HARNESS_ARGV=()
for ((i = 0; i < ${HARNESS_ARGC:-0}; i++)); do
	HARNESS_ARGV+=("$1")
	shift
done

IDE_ARGV=()
for ((i = 0; i < ${IDE_ARGC:-0}; i++)); do
	IDE_ARGV+=("$1")
	shift
done

[ ${#HARNESS_ARGV[@]} -gt 0 ] || die "entrypoint: no primary tool in argv"

# Captured before the xpra layer below rewrites IDE_ARGV[0] to "xpra": the user
# is waiting for "rstudio" to close, not for "xpra".
IDE_NAME=
[ ${#IDE_ARGV[@]} -gt 0 ] && IDE_NAME="${IDE_ARGV[0]##*/}"

IDE_LOG="${IDE_LOG:-/tmp/scoder-ide.log}"
IDE_SIG="${IDE_SIG:-TERM}"
IDE_ORDER="${IDE_ORDER:-children-first}"
XPRA_SOCKET="${XPRA_SOCKET:-}"
XPRA_MMAP="${XPRA_MMAP:-}"
XPRA_TARGET="${XPRA_TARGET:-ide}"
XPRA_LOG="${XPRA_LOG:-/tmp/scoder-xpra.log}"

# --- the xpra layer --------------------------------------------------------
# xpra starts its own virtual X server inside the sandbox, execs the GUI
# program against it, and forwards the resulting windows over a unix socket to
# a client running on the host. The program therefore never holds a connection
# to the host's X server — that is the whole point of this layer, see
# architecture/decision-records/0003-xpra-gui-isolation.md.
#
# Which of the two programs gets wrapped depends on how scoder was invoked:
# `scoder pi --ide rstudio` wraps the companion, `scoder rstudio` wraps the
# primary tool. Either way exactly one of them is a GUI program, and the other
# (if any) runs directly.

# ### xpra_wrap
# Set XPRA_WRAPPED to the argv that runs "$@" under an xpra server.
#
# Assigns to a global rather than printing, because the obvious spelling —
# `mapfile -t ARGV < <(xpra_argv ...)` — does not work here. Process
# substitution needs /dev/fd, and scoder's sandbox has no /dev/fd: /dev is
# assembled from a short list of individually bound device nodes rather than
# being a devtmpfs, so the /dev/fd -> /proc/self/fd symlink the host has simply
# is not there. Found by running it; bash reports only
# `/dev/fd/63: No such file or directory`, which does not obviously point at
# the missing symlink. Command substitution `$(...)` is a pipe and works fine,
# which is why the --start-child quoting below is unaffected.
XPRA_WRAPPED=()
xpra_wrap() {
	# --exit-with-children=yes ties the server's lifetime to the child's, so
	# whatever waits on the server is waiting on the program the user cares
	# about. It takes a value; bare --exit-with-children is not valid.
	#
	# --daemon=no because --daemon defaults to *yes*: without this the server
	# forks away and $! is a pid that has already exited.
	#
	# --start-child is xpra's own convention for "run this, and treat it as
	# the session's child". It is handed to a shell, so each argument is
	# %q-quoted rather than passed raw — this is the one place an argument
	# does cross a shell boundary, and the quoting is what keeps that safe.
	#
	# Audio, notifications and printing are off. Audio because the stack is
	# not wired through the sandbox and produced nothing but a steady stream
	# of pactl connection failures in the log. The other two because they are
	# capability channels in their own right — xpra will happily proxy the
	# host's notification daemon and its printer list into the sandbox, and
	# handing those back is the opposite of the point of this layer. Observed
	# directly during the end-to-end test: the client tried to enumerate
	# printers over the system bus unprompted.
	#
	# --mmap is the performance fix, and it only works because the directory
	# holding it is bound at the same absolute path on both sides: xpra sends
	# the *path* across, so a file the two sides know by different names
	# cannot be negotiated. Without it every pixel update is encoded and
	# decoded rather than shared, which was reported as both IDEs being "too
	# laggy to be useable". See xpraDir in src/sandbox/xpra.ts.
	#
	# --input-method=keep stops xpra starting an ibus stack — ibus-daemon,
	# -memconf, -extension-gtk3, -x11, -portal, 8 processes in all, measured.
	# Nothing in a sandbox is using an input method editor, and they are not
	# free: see the inotify note below.
	#
	# `keep`, not `none`, and the difference matters. `none` does not mean
	# "no input method": xpra reads it as "disable imsettings and fall back to
	# xim", and sets GTK_IM_MODULE=xim for every child
	# (xpra/x11/subsystem/keyboard.py: configure_imsettings_env). Eclipse's
	# SWT then prints `***WARNING: Detected: GTK_IM_MODULE=xim. This input
	# method is unsupported and can cause graphical issues ... if flicking is
	# experienced` — reported from a real session, and introduced by this
	# flag rather than present before it.
	#
	# `keep` means "leave the environment alone", which here leaves
	# GTK_IM_MODULE unset — exactly what SWT's warning asks for. That is only
	# true because bwrap runs with --clearenv and nothing sets it, so this
	# depends on buildBwrapCommand's behaviour, not on the host's. Verified
	# directly: GTK_IM_MODULE unset, XMODIFIERS unset, 0 ibus processes.
	#
	# No --dpi here, despite xpra warning `DPI set to 31 x 35 (wanted 96 x 96)`
	# and suggesting "the dpi switch". Measured: --dpi=96 changes nothing —
	# xdpyinfo inside the sandbox reports the same 100x100 with and without
	# it, because the number comes from the virtual screen's physical
	# dimensions, not the flag. Left out rather than shipped as an inert
	# setting that looks like a fix. xpra's other suggestion, a patched Xorg
	# dummy driver, is a different piece of work.
	XPRA_WRAPPED=(
		xpra start
		"--bind=$XPRA_SOCKET"
		--daemon=no
		--exit-with-children=yes
		"--start-child=$(printf '%q ' "$@")"
		--notifications=no
		--printing=no
		--input-method=keep
		"--mmap=${XPRA_MMAP:-yes}"
		--audio=no
		--speaker=no
		--microphone=no
		--webcam=no
		--pulseaudio=no
	)

	# Deliberately unquoted, so the caller's flags word-split into separate
	# arguments — this is the one place in this script where splitting is the
	# intent rather than a hazard. See XPRA_EXTRA_ARGS in the interface notes.
	# shellcheck disable=SC2206
	[ -n "${XPRA_EXTRA_ARGS:-}" ] && XPRA_WRAPPED+=(${XPRA_EXTRA_ARGS})
	return 0
}

if [ -n "$XPRA_SOCKET" ]; then
	command -v xpra >/dev/null || die "xpra not found inside the sandbox"

	# inotify instances are a per-*user* kernel resource, not a per-namespace
	# one: fs.inotify.max_user_instances defaults to 128 and the sandbox shares
	# the user's uid, so everything in here competes with the user's whole
	# desktop for the same 128. RStudio noticed first — reported directly,
	# rsession's file monitors failing repeatedly with
	# `system error 24 (Too many open files)`, which is what inotify_init()
	# returns when that limit is reached, not a file-descriptor problem.
	#
	# Measured: an xpra session held 8 of them by default and 1 with these two
	# off. The menu watcher is one instance per watched directory, and it
	# exists to export the *host's* application menu into the session — which
	# is host data this sandbox has no use for, took 3.3s to scan, and is a
	# small channel in its own right. Both reasons point the same way.
	export XPRA_MENU_WATCHER=0
	export XPRA_EXPORT_MENU_DATA=0

	if [ "$XPRA_TARGET" = harness ]; then
		xpra_wrap "${HARNESS_ARGV[@]}"
		HARNESS_ARGV=("${XPRA_WRAPPED[@]}")
	else
		[ ${#IDE_ARGV[@]} -gt 0 ] ||
			die "entrypoint: XPRA_TARGET=ide but no IDE in argv"
		xpra_wrap "${IDE_ARGV[@]}"
		IDE_ARGV=("${XPRA_WRAPPED[@]}")
	fi
fi

# --- start the companion IDE, if there is one ------------------------------
# The IDE runs detached in the background and the primary tool in the
# foreground, both in the same process group inside the sandbox, so bwrap (and
# so scoder) does not return until BOTH have exited. Confirmed directly that a
# backgrounded job in a non-interactive bash script shares the script's own
# process group — job control only creates separate groups for an interactive
# shell — so installSignalForwarding's existing process-group kill() reaches
# both without needing to know about either.
#
# Output goes to a log rather than the terminal: an Electron or GUI app's
# console chatter would otherwise interleave with the primary tool's
# interactive session.
#
# setsid, not a plain background job, and stdin from /dev/null. Redirecting
# fds alone is not enough: a JVM's native crash handler, a GTK/X11 error
# dialog, or an Electron renderer can open /dev/tty and write to the
# controlling terminal directly, bypassing any redirection its parent set up.
# setsid makes the IDE a session leader with no controlling terminal at all, so
# that open fails instead of reaching the visible console — reported directly
# as RStudio's rsession spraying jsonrpc errors into the middle of an agent
# session. Confirmed directly that setsid under bwrap's own --new-session still
# leaves $! as the IDE's real pid, with no extra fork layer to account for, so
# the kill/wait logic below needs no adjustment.

IDE_PID=
if [ ${#IDE_ARGV[@]} -gt 0 ]; then
	if [ -n "$XPRA_SOCKET" ] && [ "$XPRA_TARGET" != harness ]; then
		setsid "${IDE_ARGV[@]}" </dev/null >"$XPRA_LOG" 2>&1 &
	else
		setsid "${IDE_ARGV[@]}" </dev/null >"$IDE_LOG" 2>&1 &
	fi
	IDE_PID=$!
fi

# --- run the primary tool in the foreground --------------------------------

"${HARNESS_ARGV[@]}"
STATUS=$?

# --- shutdown handshake ----------------------------------------------------
# The primary tool has exited. If the IDE is still up, scoder does not return
# until it closes too — the user is still working in it. That wait can block
# for a long time with no further output, which is indistinguishable from a
# hang unless something says so.
#
# kill -0 here checks whether the IDE is still running at this moment. A benign
# race if it exits a moment later: the message is premature, not wrong.
#
# Three things happen at this point, all for the same reason — the terminal has
# just been handed back by a full-screen agent TUI and has to be legible on its
# own:
#
#   - The screen is cleared (ESC[H ESC[2J), so whatever the agent left rendered
#     does not sit there looking live. Scrollback is deliberately NOT cleared
#     (no ESC[3J): the session transcript is still worth having.
#   - The notice names the IDE and its pid, because with several IDE windows
#     open it is not obvious which one belongs to this terminal.
#   - ENTER asks that IDE to close, which is also the reliable way to identify
#     it: the window that disappears was the attached one. A second ENTER
#     escalates to SIGKILL, for an IDE that ignores the first signal (sitting
#     on a modal dialog, say). The signal is a shutdown *request*, not the
#     IDE's own File -> Exit: it gives a JVM its shutdown hooks, but what
#     happens to unsaved editor state is the IDE's business, which is why the
#     prompt says "ask", not "save".
#
# The loop is not gated on stdin being a tty — only the prompt is. With stdin
# closed or on /dev/null, read returns EOF immediately and the elif breaks out
# to the same plain wait, rather than spinning. Confirmed directly both ways:
# ENTER tears the IDE and its child down in milliseconds and still exits with
# the primary tool's own status, and with stdin closed the script waits the IDE
# out exactly as it did before any of this existed.

if [ -n "$IDE_PID" ] && kill -0 "$IDE_PID" 2>/dev/null; then
	# Clearing the screen only when stderr is a terminal: piped or redirected,
	# the escape sequence would be written into whatever is collecting output.
	[ -t 2 ] && printf '\033[H\033[2J' >&2

	say "Waiting for attached IDE to close: $IDE_NAME (pid $IDE_PID)"
	[ -t 0 ] && say "Press ENTER to ask it to close, or close it yourself"

	IDE_SIGNALLED=0
	while kill -0 "$IDE_PID" 2>/dev/null; do
		# -t 1 so the loop re-checks liveness once a second whether or not
		# anyone types anything; the IDE closing on its own must end this wait
		# just as an ENTER does.
		if read -r -t 1 _; then
			if [ "$IDE_SIGNALLED" -eq 0 ]; then
				say "Asking $IDE_NAME to close (SIG$IDE_SIG); press ENTER again to force it"
				IDE_SIGNALLED=1
				# children-first vs process-first is per-IDE and was measured
				# against each one's real process tree, not chosen on principle
				# — see design/features/ide-companion.md. Eclipse's launcher is
				# a thin wrapper around its JVM, so signalling only the wrapper
				# orphans the application and leaves its window on screen;
				# RStudio's rsession is a direct child, so signalling children
				# first kills the user's R session and leaves the IDE standing.
				#
				# Under xpra the signalled process is the server rather than the
				# IDE, and --exit-with-children is what carries the request the
				# rest of the way down. Both presets' recorded values were
				# measured against a directly-exec'd IDE and have NOT been
				# re-measured through that extra layer — see Decision 11 in
				# design/implementation/plans/xpra-gui-isolation.md.
				if [ "$IDE_ORDER" = children-first ] && command -v pkill >/dev/null; then
					pkill "-$IDE_SIG" -P "$IDE_PID" 2>/dev/null
				fi
				kill "-$IDE_SIG" "$IDE_PID" 2>/dev/null
			else
				say "Forcing $IDE_NAME to stop"
				command -v pkill >/dev/null && pkill -KILL -P "$IDE_PID" 2>/dev/null
				kill -KILL "$IDE_PID" 2>/dev/null
			fi
		elif [ $? -le 128 ]; then
			# read failed for a reason other than its timeout (128+ is a
			# timeout or signal) — stdin is closed, so there will never be an
			# ENTER. Stop consuming a core waiting for one.
			break
		fi
	done
fi

# stderr redirected because bash reports a SIGKILLed background job there
# ("line 1: 1234 Killed ..."), which is noise the user did not cause and
# cannot act on.
[ -n "$IDE_PID" ] && wait "$IDE_PID" 2>/dev/null

# The primary tool's status, not the IDE's: the IDE is a companion, and scoder's
# exit code has always described the tool the user actually invoked.
exit "$STATUS"
