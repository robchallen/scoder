#!/usr/bin/env bash
#
# xpra-gpu-debug.sh — what a GUI preset's Chromium is actually doing.
#
# Run this INSIDE a scoder sandbox that has a GUI preset running, e.g. from
# the shell of `scoder --ide rstudio pi`, while RStudio is open.
#
# It answers the questions that came up repeatedly while investigating
# RStudio's mousewheel scrolling, each of which was got wrong at least once
# by a hand-written command:
#
#   1. which Chromium child processes exist, and of what type
#   2. whether any of them hold the DRM render node (i.e. is the GPU in use)
#   3. whether the render node can be opened at all, and why or why not
#   4. which GL-related flags actually reached Chromium
#
# Three traps this avoids, all specific to this sandbox rather than
# carelessness:
#
#   - Chromium's children re-exec as /proc/self/exe, so they CANNOT be found
#     by the application name. A grep for "rstudio" hides every one of them
#     and makes it look as though there is no GPU process.
#   - scoder does not unshare the PID namespace, so /proc here lists the
#     HOST's processes too, including other users'. Reading their fd links
#     fails, and without redirection that buries the answer in hundreds of
#     "Permission denied" lines.
#   - A plain `grep -- --type=` matches the grep's own command line, and this
#     script's. Hence reading /proc/<pid>/cmdline directly and skipping our
#     own pid.
#
# Prints nothing to stderr on a healthy run; every "cannot read" is expected
# and silenced, because on a shared machine most processes are not ours.

set -u

self=$$

echo "=== 1. Chromium child processes, by type ==="
gpu_count=0
any_child=0
for d in /proc/[0-9]*; do
	p=${d#/proc/}
	[ "$p" = "$self" ] && continue
	# Grouped redirect: the shell reports a failed "<" itself, so 2>/dev/null
	# on tr alone does not silence a process that exits mid-scan.
	cmd=$( { tr '\0' '\n' < "/proc/$p/cmdline"; } 2>/dev/null )
	[ -z "$cmd" ] && continue
	type=$(printf '%s\n' "$cmd" | grep -m1 '^--type=' | cut -d= -f2)
	[ -z "$type" ] && continue
	exe=$(printf '%s\n' "$cmd" | head -1)
	printf '  pid %-8s type=%-16s %s\n' "$p" "$type" "$exe"
	any_child=$((any_child + 1))
	[ "$type" = "gpu-process" ] && gpu_count=$((gpu_count + 1))
done
[ "$any_child" -eq 0 ] && echo "  none — is the IDE actually running?"
echo
echo "  gpu-process count: $gpu_count"
if [ "$gpu_count" -eq 0 ] && [ "$any_child" -gt 0 ]; then
	echo "  -> Chromium is running WITHOUT a GPU process: software compositing."
fi

echo
echo "=== 2. Processes holding the DRM render node ==="
holders=0
for d in /proc/[0-9]*; do
	p=${d#/proc/}
	# readlink over the fd glob rather than parsing `ls -l`: the targets are
	# what matter, and most of these processes are not ours to read.
	nodes=$(readlink "/proc/$p/fd/"* 2>/dev/null |
		grep -o '/dev/dri/[a-zA-Z0-9]*' | sort -u | tr '\n' ' ')
	[ -z "$nodes" ] && continue
	cmd=$( { tr '\0' ' ' < "/proc/$p/cmdline"; } 2>/dev/null | cut -c1-80)
	printf '  pid %-8s [%s] %s\n' "$p" "${nodes% }" "$cmd"
	holders=$((holders + 1))
done
if [ "$holders" -eq 0 ]; then
	echo "  none — nothing is using the GPU"
else
	echo
	echo "  (the PID namespace is shared with the host, so host processes"
	echo "   appear here too — look for the one running the IDE)"
fi

echo
echo "=== 3. Can the render node be opened? ==="
if [ -d /dev/dri ]; then
	# `ls -l` deliberately, not `find`: the mode string is the point, and
	# specifically the trailing '+' that marks a POSIX ACL — which is what
	# makes this node reachable at all (see the note below).
	# shellcheck disable=SC2012
	ls -l /dev/dri/ 2>&1 | sed 's/^/  /'
	echo
	echo "  id -G: $(id -G)"
	for node in /dev/dri/renderD*; do
		[ -e "$node" ] || continue
		echo "  $node writable: $( [ -w "$node" ] && echo yes || echo NO )"
	done
	echo
	echo "  A '+' in the mode means a POSIX ACL. On a systemd desktop logind"
	echo "  grants the active user access to /dev/dri/* by UID, which is why"
	echo "  this can be writable even though the sandbox has dropped every"
	echo "  supplementary group (id -G shows 65534 = nogroup for them): a uid"
	echo "  ACL survives the user namespace where a group membership does not."
	echo "  Owner showing as nobody/nogroup just means root and the device's"
	echo "  group are outside this namespace's maps."
else
	echo "  /dev/dri is NOT present in the sandbox."
	echo "  The preset binds it only when it exists on the host (dirExists"
	echo "  check in guiDisplayBinds, src/tools/presets.ts), so either the"
	echo "  host has no GPU or the bind did not happen."
fi

echo
echo "=== 4. GL-related flags that reached Chromium ==="
flags=$(
	for d in /proc/[0-9]*; do
		p=${d#/proc/}
		[ "$p" = "$self" ] && continue
		{ tr '\0' '\n' < "/proc/$p/cmdline"; } 2>/dev/null |
			grep -E '^--(use-gl|use-angle|ignore-gpu-blocklist|disable-gpu|enable-gpu|in-process-gpu|disable-software-rasterizer)'
	done | sort -u
)
if [ -n "$flags" ]; then
	printf '%s\n' "$flags" | sed 's/^/  /'
else
	echo "  none — RSTUDIO_CHROMIUM_ARGUMENTS did not reach Chromium."
	echo "  scoder forwards it only when it is set on the host; the sandbox"
	echo "  runs --clearenv, so nothing arrives by itself."
fi

echo
echo "=== 5. What the virtual display's GL is ==="
echo "  xpra's own startup line in /tmp/scoder-xpra.log is authoritative:"
grep -iE "OpenGL is supported|llvmpipe|renderer" /tmp/scoder-xpra.log 2>/dev/null |
	tail -3 | sed 's/^/  /' ||
	echo "  (no /tmp/scoder-xpra.log — is this a GUI session?)"
echo
echo "  'llvmpipe' means the display's GL is Mesa's SOFTWARE rasteriser, so"
echo "  anything reaching GL through GLX against it renders on the CPU no"
echo "  matter what /dev/dri allows."
