#!/bin/bash
#
# Prototype: pasta attach mode, to fix the sandbox uid regression.
#
# See design/implementation/issues/sandbox-uid-becomes-root.md
#
# Production scoder builds:
#
#     bwrap --unshare-user --uid 1001 ... pasta --config-net ... -- <tool>
#
# pasta is the last thing bwrap execs, and pasta's spawn mode always creates a
# new network AND user namespace. That nested userns maps inside-0 to the
# caller, so it overrides bwrap's --uid and the tool runs as root.
#
# This prototype inverts the responsibility. bwrap creates BOTH namespaces
# itself (--unshare-net alongside --unshare-user), so its uid mapping is the
# only one; pasta then attaches to the already-created netns from outside via
# its PID form, `pasta <PID>`, and never makes a namespace of its own.
#
# The startup race is closed with two bwrap fds:
#   --info-fd   bwrap writes {"child-pid": N} once the namespaces exist
#   --block-fd  bwrap waits for data before exec'ing the tool
#
# so the ordering is: namespaces exist -> pasta attaches -> tool starts. The
# tool never observes a window without networking.
#
# Usage: ./pasta-attach-mode.sh
# Exits 0 if uid is preserved AND outbound TCP works.

set -u

INFO=$(mktemp)
BLOCK=$(mktemp -u)
mkfifo "$BLOCK"
RESOLV=$(mktemp)
trap 'rm -f "$INFO" "$BLOCK" "$RESOLV"' EXIT

# Read-write open, so neither end blocks waiting for a peer to appear.
exec 9<>"$BLOCK"

HOST_UID=$(id -u)
HOST_GID=$(id -g)

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

echo "host uid=$HOST_UID gid=$HOST_GID"

bwrap \
	--ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
	--ro-bind /lib64 /lib64 --ro-bind /etc /etc \
	--ro-bind /run /run \
	--ro-bind "$RESOLV" /etc/resolv.conf \
	--proc /proc --dev-bind /dev /dev --tmpfs /tmp \
	--unshare-user --uid "$HOST_UID" --gid "$HOST_GID" \
	--unshare-net \
	--info-fd 3 --block-fd 9 \
	/bin/bash -c '
		echo "  uid inside : $(id -u)"
		echo "  uid_map    : $(cat /proc/self/uid_map)"
		echo "  interfaces : $(ip -o link show | awk -F": " "{print \$2}" | tr "\n" " ")"

		# Outbound TCP, by IP — proves the network path independently of DNS
		if timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/443" 2>/dev/null; then
			echo "  TCP to 1.1.1.1:443 : ok"
		else
			echo "  TCP to 1.1.1.1:443 : FAILED"
			exit 1
		fi

		if timeout 5 getent hosts example.com >/dev/null 2>&1; then
			echo "  DNS        : resolves"
		else
			echo "  DNS        : FAILED"
			exit 1
		fi

		[ "$(id -u)" = "'"$HOST_UID"'" ] || { echo "  uid NOT preserved"; exit 1; }
	' 3>"$INFO" &
BWRAP_PID=$!

# Wait for bwrap to publish the child PID
for _ in $(seq 1 100); do
	[ -s "$INFO" ] && break
	sleep 0.05
done

CHILD=$(sed -n 's/.*"child-pid": *\([0-9]*\).*/\1/p' "$INFO")
echo "bwrap child-pid: ${CHILD:-<none>}"
if [ -z "$CHILD" ]; then
	echo "FAILED: bwrap did not report a child-pid"
	exit 1
fi

# Attach networking to the sandbox's existing netns, from outside it.
# Note: no --config-net-style spawn here — the PID form joins instead.
pasta --quiet --config-net --dhcp-dns --no-map-gw \
	--tcp-ports none --udp-ports none "$CHILD" 2>&1 | sed 's/^/pasta: /'

# Release the sandbox; the tool starts now, with networking already up.
echo go >&9

if wait "$BWRAP_PID"; then
	echo "RESULT: uid preserved and networking works"
	exit 0
fi

echo "RESULT: prototype failed"
exit 1
