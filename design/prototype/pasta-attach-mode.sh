#!/bin/bash
#
# Prototype: pasta attach mode, rehearsing the production shape.
#
# See architecture/decision-records/0001-sandbox-uid-and-networking-composition.md
# and design/implementation/plans/pasta-attach-mode-implementation.md
#
# Production scoder builds one nested command:
#
#     bwrap --unshare-user --uid 1001 ... pasta --config-net ... -- <tool>
#
# pasta is the last thing bwrap execs, and pasta's spawn mode always creates a
# new network AND user namespace. That nested userns maps inside-0 to the
# caller, overriding bwrap's --uid, so the tool runs as root.
#
# This inverts the responsibility. bwrap creates BOTH namespaces itself
# (--unshare-net alongside --unshare-user), so its uid mapping is the only one;
# pasta then attaches to the already-created netns from outside via its PID
# form and never makes a namespace of its own.
#
# Startup ordering is closed with two bwrap fds:
#   --info-fd   bwrap writes {"child-pid": N} once the namespaces exist
#   --block-fd  bwrap waits for data before exec'ing the tool
#
# giving: namespaces exist -> pasta attaches -> tool starts. The tool never
# observes a window without networking.
#
# Bun.spawn cannot pass fd 3 or above (its stdio is a fixed 3-tuple), so bwrap
# is launched through a shell shim that opens those descriptors itself. The
# `exec` with only redirections applies them to the shim rather than replacing
# it; `exec "$@"` then runs bwrap with argv passed as real arguments, so paths
# containing spaces survive.
#
# Usage: ./pasta-attach-mode.sh
# Exits 0 only if every check below passes.

set -u

WAIT_LIMIT=100 # x 0.05s = 5s for bwrap to publish the child pid

INFO=$(mktemp)
BLOCK=$(mktemp -u)
mkfifo "$BLOCK"
PIDFILE=$(mktemp -u)
RESOLV=$(mktemp)
PASSWD=$(mktemp)
SPACEDIR="/tmp/scoder prototype spaced"

cleanup() {
	[ -s "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null
	[ -n "${SERVER:-}" ] && kill "$SERVER" 2>/dev/null
	rm -rf "$INFO" "$BLOCK" "$PIDFILE" "$RESOLV" "$PASSWD" "$SPACEDIR"
}
trap cleanup EXIT

HOST_UID=$(id -u)
HOST_GID=$(id -g)

# A host-local listener, standing in for the --llm-port case (e.g. Ollama)
LLM_PORT=19731
python3 -m http.server "$LLM_PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
sleep 1

# Identity: attach mode fixes the uid, but getpwuid() still resolves through
# NSS. With the host passwd it would return the host home, which does not exist
# inside the sandbox — so ~/.ssh would still be wrong. This entry is what
# buildBwrapCommand already writes, and is already correct for the host uid.
echo "scoder:x:${HOST_UID}:${HOST_GID}:Sandbox User:/home/scoder:/bin/bash" > "$PASSWD"

# Same substitution scoder's setupResolvConf() performs: a resolv.conf naming a
# loopback resolver (systemd-resolved on 127.0.0.53) is useless inside any
# network namespace, so fall back to the real upstream list.
#
# /run must be bound before this, because /etc/resolv.conf is commonly a
# symlink into /run/systemd/resolve/ and bwrap resolves the bind destination
# through it. scoder binds /run for other reasons and so does not hit this.
if grep -qE "nameserver (127\.|::1)" /etc/resolv.conf 2>/dev/null &&
	[ -r /run/systemd/resolve/resolv.conf ]; then
	cp /run/systemd/resolve/resolv.conf "$RESOLV"
else
	cp /etc/resolv.conf "$RESOLV"
fi

# Proves argv survives the shim intact. Bound AFTER --tmpfs /tmp, or the tmpfs
# masks it (AGENTS.md pitfall: ro-bind overlays come after the parent mount).
mkdir -p "$SPACEDIR"
echo spaced-path-ok > "$SPACEDIR/probe.txt"

echo "host uid=$HOST_UID gid=$HOST_GID, llm port=$LLM_PORT"

bash -c 'exec 3>"$1"; exec 9<>"$2"; shift 2; exec "$@"' _ "$INFO" "$BLOCK" \
	bwrap \
	--ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
	--ro-bind /lib64 /lib64 --ro-bind /etc /etc --ro-bind /run /run \
	--ro-bind "$RESOLV" /etc/resolv.conf \
	--ro-bind "$PASSWD" /etc/passwd \
	--proc /proc --dev-bind /dev /dev --tmpfs /tmp \
	--ro-bind "$SPACEDIR" "$SPACEDIR" \
	--tmpfs /home --dir /home/scoder \
	--unshare-user --uid "$HOST_UID" --gid "$HOST_GID" \
	--unshare-net \
	--setenv HOME /home/scoder --setenv USER scoder --setenv LOGNAME scoder \
	--info-fd 3 --block-fd 9 \
	/bin/bash -c '
		fail=0
		check() { if [ "$2" = "$3" ]; then echo "  $1: $2"; else echo "  $1: $2 (expected $3) FAILED"; fail=1; fi; }

		check "uid           " "$(id -u)" "'"$HOST_UID"'"
		check "whoami        " "$(whoami)" "scoder"
		check "getpwuid home " "$(python3 -c "import os,pwd;print(pwd.getpwuid(os.getuid()).pw_dir)")" "/home/scoder"
		check "spaced argv   " "$(cat "/tmp/scoder prototype spaced/probe.txt")" "spaced-path-ok"

		echo "  uid_map       : $(cat /proc/self/uid_map)"

		# Outbound by IP, so a DNS failure cannot read as a dead network
		if timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/443" 2>/dev/null; then
			echo "  outbound TCP  : ok"
		else
			echo "  outbound TCP  : FAILED"; fail=1
		fi

		if timeout 5 getent hosts example.com >/dev/null 2>&1; then
			echo "  DNS           : resolves"
		else
			echo "  DNS           : FAILED"; fail=1
		fi

		# --llm-port equivalent: this one host-local port is forwarded in...
		if timeout 5 bash -c "exec 3<>/dev/tcp/127.0.0.1/'"$LLM_PORT"'" 2>/dev/null; then
			echo "  llm port      : reachable"
		else
			echo "  llm port      : FAILED"; fail=1
		fi

		# ...while other host loopback services stay blocked
		if timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/22" 2>/dev/null; then
			echo "  other loopback: REACHABLE (should be blocked) FAILED"; fail=1
		else
			echo "  other loopback: blocked"
		fi

		# Hold the session open while the parent kills pasta, to show the netns
		# belongs to bwrap and the sandbox survives losing its network handler.
		sleep 4
		echo "  survived pasta teardown: yes"
		exit $fail
	' &
SHIM=$!

for _ in $(seq 1 "$WAIT_LIMIT"); do
	[ -s "$INFO" ] && break
	sleep 0.05
done

CHILD=$(sed -n 's/.*"child-pid": *\([0-9]*\).*/\1/p' "$INFO")
echo "bwrap child-pid: ${CHILD:-<none>}"
if [ -z "$CHILD" ]; then
	# Production needs this timeout: without it the sandbox blocks on
	# --block-fd forever and the session hangs with no diagnostic.
	echo "FAILED: bwrap did not publish a child-pid within 5s"
	kill $SHIM 2>/dev/null
	exit 1
fi

# Attach networking to the sandbox's existing netns, from outside it. -P records
# the pid, because pasta now lives on the host and bwrap's --die-with-parent no
# longer reaps it.
pasta --quiet --config-net --dhcp-dns --no-map-gw \
	--tcp-ports none --tcp-ns "$LLM_PORT" --udp-ns none \
	-P "$PIDFILE" "$CHILD" 2>&1 | sed 's/^/pasta: /'

if [ -s "$PIDFILE" ]; then
	echo "pasta pid: $(cat "$PIDFILE")"
else
	echo "FAILED: pasta wrote no pid file"
	kill $SHIM 2>/dev/null
	exit 1
fi

# Release the sandbox; the tool starts now, with networking already up. The shim
# owns fd 9, so the release is a plain write to the fifo — which is what the
# TypeScript side would do.
echo go > "$BLOCK"

# Terminate pasta mid-session. In spawn mode this would destroy the sandbox,
# because pasta owns the namespaces. Here the netns is bwrap's, so the session
# continues. This is what would make changing forwarded ports without a restart
# possible later.
sleep 2
kill "$(cat "$PIDFILE")" 2>/dev/null && echo "killed pasta mid-session"

if wait $SHIM; then
	echo "RESULT: all checks passed"
	exit 0
fi

echo "RESULT: prototype failed"
exit 1
