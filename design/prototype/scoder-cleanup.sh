#!/usr/bin/env bash
#
# scoder-cleanup.sh — find and remove what a killed scoder session leaves behind.
#
# Run from a NORMAL HOST SHELL. Reports by default; pass --kill to act.
#
#   design/prototype/scoder-cleanup.sh          # show what is left over
#   design/prototype/scoder-cleanup.sh --kill   # terminate it
#
# Why this is needed, and it is a real defect rather than untidiness:
#
#   scoder does not unshare the PID namespace — pasta has to attach to the
#   network namespace from outside, see ADR 0001 — so bwrap's
#   --die-with-parent only reaches its own immediate child. The companion IDE
#   is deliberately started under `setsid`, because an IDE that keeps its
#   controlling terminal writes crash handlers and jsonrpc errors straight to
#   /dev/tty in the middle of the agent's session. A setsid process is in its
#   own session and is reparented to init when its parent dies.
#
#   Together those mean: a session that does not end cleanly leaves the whole
#   IDE stack running — Electron, its zygotes and renderers, rsession, a
#   Tomcat, a language server. Verified directly: a setsid child outlived
#   bwrap by design.
#
#   Several of those accumulating is not a cosmetic problem. Each is a real
#   workload, and they are a plausible confounder for any "the GUI feels
#   laggy" measurement, which is how this script came to be written.
#
# How an orphan is told apart from a legitimately running application: it has
# BOTH been reparented to init (ppid 1) AND is still in a mount namespace that
# is not this shell's. An application started from a terminal that has since
# closed satisfies the first but not the second, so it is left alone.

set -u

KILL=0
[ "${1:-}" = "--kill" ] && KILL=1

HOST_MNT=$(readlink /proc/self/ns/mnt)
me=$(id -u)

echo "host mount namespace: $HOST_MNT"
echo

orphans=()
echo "=== processes orphaned from a dead sandbox ==="
for d in /proc/[0-9]*; do
	p=${d#/proc/}

	# Only our own processes; other users' are not ours to inspect or kill.
	owner=$(stat -c %u "$d" 2>/dev/null) || continue
	[ "$owner" = "$me" ] || continue

	mnt=$(readlink "/proc/$p/ns/mnt" 2>/dev/null) || continue
	[ "$mnt" = "$HOST_MNT" ] && continue

	ppid=$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null) || continue
	[ "$ppid" = "1" ] || continue

	cmd=$( { tr '\0' ' ' < "/proc/$p/cmdline"; } 2>/dev/null | cut -c1-90)
	[ -z "$cmd" ] && continue
	printf '  pid %-8s %s\n' "$p" "$cmd"
	orphans+=("$p")
done
[ ${#orphans[@]} -eq 0 ] && echo "  none"

echo
echo "=== xpra sessions xpra itself knows about ==="
xpra list 2>&1 | sed 's/^/  /' | head -20

echo
echo "=== stale scoder session roots in /tmp ==="
# Session roots are /tmp/scoder-<8 hex>; anything still here belongs to a run
# that did not reach its exit handler. The test suite's own
# /tmp/scoder-test-repos is deliberately not matched.
roots=()
for dir in /tmp/scoder-*; do
	[ -d "$dir" ] || continue
	case "${dir#/tmp/scoder-}" in
		[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
		*) continue ;;
	esac
	echo "  $dir ($(du -sh "$dir" 2>/dev/null | cut -f1))"
	roots+=("$dir")
done
[ ${#roots[@]} -eq 0 ] && echo "  none"

echo
if [ "$KILL" -eq 0 ]; then
	echo "Nothing was changed. Re-run with --kill to clean up."
	exit 0
fi

echo "=== cleaning up ==="

# SIGTERM first, then SIGKILL to whatever ignored it — the same escalation
# terminateProcess uses for pasta and the ssh tunnel. Signalling and checking
# immediately reports a false survivor every time, because the process has not
# been reaped yet, hence the wait in between.
for p in "${orphans[@]}"; do
	kill -TERM "$p" 2>/dev/null && echo "  SIGTERM -> $p"
done
[ ${#orphans[@]} -gt 0 ] && sleep 2
for p in "${orphans[@]}"; do
	if kill -0 "$p" 2>/dev/null; then
		kill -KILL "$p" 2>/dev/null && echo "  SIGKILL -> $p"
	fi
done

# Removes dead entries from xpra's own session registry; it does not touch
# live sessions.
xpra clean >/dev/null 2>&1 && echo "  xpra clean: done"

for dir in "${roots[@]}"; do
	rm -rf "$dir" && echo "  removed $dir"
done

echo
echo "Done. Re-run without --kill to confirm nothing is left."
