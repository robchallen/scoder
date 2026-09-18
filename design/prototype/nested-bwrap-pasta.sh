#!/usr/bin/env bash
#
# nested-bwrap-pasta.sh — /dev-splitting sandbox shapes, compared under pasta.
#
# Run this from a NORMAL HOST SHELL, not from inside a scoder sandbox: nesting
# bwrap inside an existing sandbox changes both the /dev the inner layer sees
# and the namespace chain pasta has to walk, which is exactly what is under
# test here.
#
# The question it answers, for each candidate sandbox shape:
#
#   1. does pasta attach to the sandbox's network namespace at all?
#   2. is /dev still narrow (no /dev/net/tun, no raw disks/TPM/mem)?
#   3. can a process with pipe stdio and no controlling terminal allocate a
#      pty — the thing Eclipse's and RStudio's terminal panes actually do?
#   4. do only the explicitly-opened host loopback ports reach through?
#
# Shapes (MODE=):
#
#   nested   what scoder implements as of 2.3.1 (buildDevLayer in
#            src/sandbox/builder.ts). Two bwraps. The OUTER owns /dev only (--dev /dev, plus /dev/dri),
#            binds the real root otherwise, and unshares nothing else. The
#            INNER does all the real isolation over that /dev with a wholesale
#            --dev-bind /dev /dev, and owns the network namespace, so pasta
#            attaches to a netns created by a bwrap that never saw --dev.
#   single   one bwrap, --dev /dev. Working ptys, but pasta cannot attach:
#            "Couldn't switch to pasta namespaces: Operation not permitted".
#   legacy   one bwrap, the individual --dev-binds (scoder <= 2.3.0). pasta
#            attaches; ptys are impossible and the host's own pty slaves are
#            visible and openable. The negative control.
#
# Usage:
#   ./nested-bwrap-pasta.sh                 # MODE=nested
#   MODE=single ./nested-bwrap-pasta.sh
#   MODE=legacy ./nested-bwrap-pasta.sh
#   SHOW_CMD=1 KEEP=1 ./nested-bwrap-pasta.sh
#
# Env knobs: MODE, SHOW_CMD (print the bwrap command lines), KEEP (keep the
# run directory), PORT_ALLOWED / PORT_BLOCKED (default: auto-picked free
# ports), TIMEOUT (whole-run watchdog, seconds).

set -uo pipefail

MODE=${MODE:-nested}
SHOW_CMD=${SHOW_CMD:-0}
KEEP=${KEEP:-0}
TIMEOUT=${TIMEOUT:-90}
UID_IN=${UID_IN:-$(id -u)}
GID_IN=${GID_IN:-$(id -g)}

RUN_MOUNT=/run/nbwrap        # where the handshake dir appears inside
RUNDIR=
PASTA_PID=
LISTENER_PIDS=()

# ---------------------------------------------------------------- scaffolding

say()  { printf '%s\n' "$*"; }
head1() { printf '\n=== %s ===\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 2; }

HOST_FAILURES=0
host_check() { # host_check <name> <0|1 ok> <detail>
	if [[ $2 -eq 0 ]]; then
		printf '  PASS  %-22s %s\n' "$1" "$3"
	else
		printf '  FAIL  %-22s %s\n' "$1" "$3"
		HOST_FAILURES=$((HOST_FAILURES + 1))
	fi
}

cleanup() {
	local st=$?
	[[ -n $PASTA_PID ]] && kill "$PASTA_PID" 2>/dev/null
	for p in ${LISTENER_PIDS[@]+"${LISTENER_PIDS[@]}"}; do kill "$p" 2>/dev/null; done
	if [[ -n $RUNDIR && $KEEP -eq 0 ]]; then
		rm -rf "$RUNDIR"
	elif [[ -n $RUNDIR ]]; then
		say "run directory kept: $RUNDIR"
	fi
	exit $st
}
trap cleanup EXIT INT TERM

command -v bwrap >/dev/null || die "bwrap not found"
command -v pasta >/dev/null || die "pasta not found"
command -v python3 >/dev/null || die "python3 not found (host side only: free ports + listeners)"
[[ -e /dev/net/tun ]] || say "NOTE: no /dev/net/tun on this host — pasta cannot attach; network checks will fail for every mode."

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }
PORT_ALLOWED=${PORT_ALLOWED:-$(free_port)}
PORT_BLOCKED=${PORT_BLOCKED:-$(free_port)}

RUNDIR=$(mktemp -d /tmp/nbwrap.XXXXXX)
chmod 755 "$RUNDIR"

# Two host loopback listeners. Only PORT_ALLOWED is handed to pasta, so the
# other one is the control: reachable from the host, not from the sandbox.
cat > "$RUNDIR/listener.py" <<'LISTENER'
import socket, sys
srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", int(sys.argv[1])))
srv.listen(8)
while True:
    c, _ = srv.accept()
    c.sendall(b"NBWRAP-HELLO\n")
    c.close()
LISTENER
for port in "$PORT_ALLOWED" "$PORT_BLOCKED"; do
	python3 "$RUNDIR/listener.py" "$port" >/dev/null 2>&1 &
	LISTENER_PIDS+=($!)
done
sleep 0.3
for port in "$PORT_ALLOWED" "$PORT_BLOCKED"; do
	timeout 2 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" 2>/dev/null \
		|| die "host listener on $port did not come up"
done

# --------------------------------------------------------------- the payload
# Runs innermost. Publishes its pid, waits for pasta, then checks everything.

cat > "$RUNDIR/payload.sh" <<'PAYLOAD_EOF'
#!/usr/bin/env bash
# Innermost payload. stdio here is whatever the harness gave us; the pty probe
# deliberately re-runs itself with pipe stdio and no controlling terminal.
RUN=$1; PORT_ALLOWED=$2; PORT_BLOCKED=$3
FAILURES=0

check() { # check <name> <0|1 ok> <detail>
	if [[ $2 -eq 0 ]]; then
		printf '  PASS  %-22s %s\n' "$1" "$3"
	else
		printf '  FAIL  %-22s %s\n' "$1" "$3"
		FAILURES=$((FAILURES + 1))
	fi
}

echo $$ > "$RUN/inner.pid"

printf '\n--- inside the sandbox ---\n'
printf '  /dev:  %s\n' "$(ls /dev | tr '\n' ' ')"
printf '  mounts on /dev:\n'
grep -E ' /dev' /proc/self/mountinfo | sed 's/^/    /'

printf '\n--- /dev exposure ---\n'
# The tun node is the sharp edge: pasta itself needs it, on the HOST side. If
# it is reachable from inside, the sandbox can make its own network devices.
[[ ! -e /dev/net/tun ]]; check dev-no-tun $? "/dev/net/tun must not be reachable"

leaked=""
for pat in '/dev/sd*' '/dev/nvme*' '/dev/vd*' '/dev/loop*' '/dev/dm-*' '/dev/mem' '/dev/kmem' '/dev/port' '/dev/tpm*' '/dev/kmsg' '/dev/watchdog*'; do
	for f in $pat; do [[ -e $f ]] && leaked="$leaked $f"; done
done
[[ -z $leaked ]]; check dev-no-host-devices $? "${leaked:-no disks/TPM/mem/kmsg nodes}"

missing=""
for n in null zero full random urandom tty; do [[ -c /dev/$n ]] || missing="$missing $n"; done
[[ -z $missing ]]; check dev-core-nodes $? "${missing:+missing:$missing}${missing:-null zero full random urandom tty all present}"

echo test > /dev/null 2>/dev/null; check dev-null-writable $? "/dev/null accepts writes"
touch /dev/shm/probe 2>/dev/null && rm -f /dev/shm/probe; check dev-shm-writable $? "/dev/shm is a writable tmpfs"

# The check the /dev-node list alone does not make. legacy binds the HOST's
# devpts instance wholesale, so the sandbox sees — and, since the slaves are
# owned by the same uid, can open read/write — the user's own host terminals.
# A fresh devpts instance starts empty, so any numbered slave visible here
# before this harness has allocated one came from outside.
host_slaves=$(ls /dev/pts 2>/dev/null | grep -E '^[0-9]+$' | tr '\n' ' ')
openable=""
for sl in $host_slaves; do
	(exec 3<>"/dev/pts/$sl") 2>/dev/null && openable="$openable $sl"
done
if [[ -z $host_slaves ]]; then
	check dev-pts-private 0 "devpts instance is private and empty"
else
	check dev-pts-private 1 "host pty slaves visible: ${host_slaves}(openable:${openable:- none}) — the sandbox can reach the user's own terminals"
fi

if [[ -e "$RUN/host-has-dri" ]]; then
	[[ -d /dev/dri ]]; check dev-dri-present $? "host has /dev/dri, so the GUI presets need it here"
else
	printf '  SKIP  %-22s %s\n' dev-dri-present "host has no /dev/dri"
fi

printf '\n--- pty allocation (the Eclipse/RStudio path) ---\n'
# Eclipse's terminal connector runs in a JVM whose spawned shell has pipe
# stdio and no controlling terminal, then allocates a pty through JNI. These
# probes reproduce that shape: no tty in, no tty out, then openpty().
tty -s; rc=$?; [[ $rc -ne 0 ]]
check pty-probe-has-no-tty $? "stdin is a pipe/null, not a tty"
(exec 3<>/dev/tty) 2>/dev/null; rc=$?; [[ $rc -ne 0 ]]
check pty-probe-no-ctty $? "no controlling terminal to fall back on, as in the IDE"

(exec 3<>/dev/ptmx) 2>"$RUN/ptmx.err"; rc=$?
detail=$(cat "$RUN/ptmx.err" 2>/dev/null)
check pty-ptmx-openable "$rc" "${detail:-/dev/ptmx opened O_RDWR}"

if command -v script >/dev/null; then
	# script(1) is openpty() + fork + setsid + TIOCSCTTY — the same sequence a
	# terminal connector's native helper runs. Stdin is a pipe, stdout a pipe.
	out=$(printf '' | setsid script -qec 'tty' /dev/null 2>&1 | tr -d '\r')
	[[ $out == *"/dev/pts/"* ]]; check pty-openpty-via-script $? "${out:-no output}"
else
	printf '  SKIP  %-22s %s\n' pty-openpty-via-script "script(1) not installed"
fi

if command -v python3 >/dev/null; then
	out=$(printf '' | setsid python3 -c '
import os, pty, sys
try:
    pid, fd = pty.fork()
except OSError as e:
    print("pty.fork failed:", e); sys.exit(1)
if pid == 0:
    os.write(1, b"slave=" + os.ttyname(0).encode()); os._exit(0)
import time; time.sleep(0.3)
try: print(os.read(fd, 128).decode(errors="replace").strip())
except OSError as e: print("master read failed:", e)
' 2>&1)
	[[ $out == *"slave=/dev/pts/"* ]]; check pty-fork-via-python $? "${out:-no output}"
else
	printf '  SKIP  %-22s %s\n' pty-fork-via-python "python3 not in the sandbox"
fi

printf '\n--- filesystem isolation (sanity) ---\n'
touch /usr/.nbwrap-probe 2>/dev/null; [[ $? -ne 0 ]]; check fs-usr-readonly $? "/usr rejects writes"
touch /tmp/.nbwrap-probe 2>/dev/null; check fs-tmp-writable $? "/tmp is a private writable tmpfs"
rm -f /tmp/.nbwrap-probe

printf '\n--- network ---\n'
# The harness attaches pasta once inner.pid appears; it flags readiness here.
for _ in $(seq 1 100); do [[ -e "$RUN/net.ready" ]] && break; sleep 0.1; done
if [[ ! -e "$RUN/net.ready" ]]; then
	check net-pasta-attached 1 "pasta never attached — see the harness output above"
else
	check net-pasta-attached 0 "$(cat "$RUN/net.ready")"

	ip -o addr show 2>/dev/null | sed 's/^/    /'

	timeout 4 bash -c "exec 3<>/dev/tcp/127.0.0.1/$PORT_ALLOWED && head -c 13 <&3" >"$RUN/allowed.out" 2>/dev/null
	[[ $(cat "$RUN/allowed.out" 2>/dev/null) == NBWRAP-HELLO ]]
	check net-opened-port $? "127.0.0.1:$PORT_ALLOWED (--tcp-ns) reaches the host listener"

	timeout 4 bash -c "exec 3<>/dev/tcp/127.0.0.1/$PORT_BLOCKED" 2>/dev/null
	[[ $? -ne 0 ]]; check net-unopened-port-blocked $? "127.0.0.1:$PORT_BLOCKED must not reach the host listener"

	timeout 6 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null
	if [[ $? -eq 0 ]]; then
		printf '  PASS  %-22s %s\n' net-outbound "1.1.1.1:443 reachable"
	else
		printf '  INFO  %-22s %s\n' net-outbound "1.1.1.1:443 unreachable (may be this host's egress, not pasta)"
	fi
fi

printf '\n%d check(s) failed inside the sandbox\n' "$FAILURES"
echo "$FAILURES" > "$RUN/inner.failures"
exit $((FAILURES > 0))
PAYLOAD_EOF
chmod +x "$RUNDIR/payload.sh"
[[ -d /dev/dri ]] && touch "$RUNDIR/host-has-dri"

# ------------------------------------------------------------- sandbox shapes
# Flags every shape shares once the /dev decision is made. This is a cut-down
# echo of src/sandbox/builder.ts — enough isolation to be representative, not
# a copy of the full bind list.

common_fs=(
	--ro-bind /usr /usr --ro-bind /etc /etc
	--ro-bind-try /bin /bin --ro-bind-try /sbin /sbin
	--ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64
	--proc /proc --tmpfs /tmp --tmpfs /home
	--bind "$RUNDIR" "$RUN_MOUNT"
	--chdir / --new-session --die-with-parent
)
common_ids=(--unshare-user --uid "$UID_IN" --gid "$GID_IN")
payload=(bash "$RUN_MOUNT/payload.sh" "$RUN_MOUNT" "$PORT_ALLOWED" "$PORT_BLOCKED")

# scoder <= 2.3.0: hand-bound device nodes. No devpts instance reachable, so
# openpty() cannot work — kept as the control.
legacy_dev=(
	--dev-bind /dev/null /dev/null --dev-bind /dev/zero /dev/zero
	--dev-bind /dev/full /dev/full --dev-bind /dev/urandom /dev/urandom
	--dev-bind /dev/random /dev/random --dev-bind /dev/tty /dev/tty
	--dev-bind /dev/pts /dev/pts --dev-bind /dev/ptmx /dev/ptmx
	--dev-bind /dev/ptmx /dev/pts/ptmx --dev-bind /dev/fd /dev/fd
	--tmpfs /dev/shm
)
dri_bind=()
[[ -d /dev/dri ]] && dri_bind=(--dev-bind /dev/dri /dev/dri)

case "$MODE" in
nested)
	# OUTER: owns /dev and nothing else. It binds the real root through so the
	# inner layer can still name host paths, unshares only the user namespace,
	# and hands the inner layer a synthetic /dev with a real devpts in it.
	# No --unshare-net here: the netns pasta attaches to must be the INNER one.
	outer=(bwrap --unshare-user --uid "$UID_IN" --gid "$GID_IN"
		--bind / /
		--dev /dev "${dri_bind[@]}"
		--die-with-parent)
	# INNER: everything else, over the outer's /dev. A wholesale
	# --dev-bind /dev /dev is safe *here* because that /dev is the outer's
	# synthetic one, not the host's — and being recursive it carries the
	# devpts submount, so /dev/ptmx still resolves onto a real devpts.
	inner=(bwrap "${common_ids[@]}" --unshare-net
		--dev-bind /dev /dev --tmpfs /dev/shm
		"${common_fs[@]}")
	cmd=("${outer[@]}" -- "${inner[@]}" -- "${payload[@]}")
	;;
single)
	cmd=(bwrap "${common_ids[@]}" --unshare-net
		--dev /dev --tmpfs /dev/shm "${dri_bind[@]}"
		"${common_fs[@]}" -- "${payload[@]}")
	;;
legacy)
	cmd=(bwrap "${common_ids[@]}" --unshare-net
		"${legacy_dev[@]}" "${dri_bind[@]}"
		"${common_fs[@]}" -- "${payload[@]}")
	;;
*)
	die "unknown MODE '$MODE' (expected nested, single or legacy)"
	;;
esac

head1 "MODE=$MODE"
say "run dir      : $RUNDIR (mounted at $RUN_MOUNT)"
say "ports        : $PORT_ALLOWED opened via --tcp-ns, $PORT_BLOCKED left closed"
if [[ $SHOW_CMD -eq 1 ]]; then
	printf 'command      :'; printf ' %q' "${cmd[@]}"; printf '\n'
fi

# ------------------------------------------------------------------- run it

# Pipe stdio, no controlling terminal, stdin not a tty: the shape a JVM's
# ProcessBuilder hands its spawned shell. Without this the probes inside could
# inherit the harness's own tty and pass for the wrong reason.
mkfifo "$RUNDIR/out"
tee "$RUNDIR/inner.log" < "$RUNDIR/out" &
TEE_PID=$!
"${cmd[@]}" </dev/null >"$RUNDIR/out" 2>&1 &
SANDBOX_PID=$!

# The payload publishes its own pid, which is a host pid: no --unshare-pid
# anywhere, so /proc/<that pid>/ns/{user,net} is what pasta needs. In nested
# mode it names the INNER namespaces, which is the whole point of the shape.
head1 "attaching pasta"
INNER_PID=
for _ in $(seq 1 100); do
	[[ -s "$RUNDIR/inner.pid" ]] && { INNER_PID=$(cat "$RUNDIR/inner.pid"); break; }
	kill -0 "$SANDBOX_PID" 2>/dev/null || break
	sleep 0.1
done

if [[ -z $INNER_PID ]]; then
	host_check sandbox-started 1 "the sandbox never published a pid — bwrap itself failed to initialize"
else
	host_check sandbox-started 0 "innermost payload is pid $INNER_PID"
	say "  namespaces of $INNER_PID:"
	ls -l /proc/"$INNER_PID"/ns/{user,net,mnt} 2>/dev/null | sed 's/^/    /'
	say "  userns chain (lsns):"
	lsns -t user 2>/dev/null | sed 's/^/    /' | head -8

	# The same flag shape src/sandbox/pasta.ts builds, plus one opened port.
	pasta_args=(pasta --config-net --dhcp-dns --no-map-gw
		--tcp-ports none --tcp-ns "$PORT_ALLOWED" --udp-ns none
		--pid "$RUNDIR/pasta.pid" "$INNER_PID")
	[[ $SHOW_CMD -eq 1 ]] && { printf '  pasta        :'; printf ' %q' "${pasta_args[@]}"; printf '\n'; }

	"${pasta_args[@]}" >"$RUNDIR/pasta.out" 2>&1
	pasta_rc=$?
	sleep 0.5
	if [[ $pasta_rc -eq 0 && -s "$RUNDIR/pasta.pid" ]]; then
		PASTA_PID=$(cat "$RUNDIR/pasta.pid")
		host_check pasta-attach 0 "pasta $PASTA_PID servicing the netns of $INNER_PID"
		printf 'attached: pasta %s -> pid %s\n' "$PASTA_PID" "$INNER_PID" > "$RUNDIR/net.ready"
	else
		host_check pasta-attach 1 "rc=$pasta_rc: $(tr '\n' ' ' < "$RUNDIR/pasta.out")"
		# Let the payload stop waiting and report the rest of its checks.
		sleep 10
	fi
fi

# ------------------------------------------------------------------ verdict

( sleep "$TIMEOUT"; kill "$SANDBOX_PID" 2>/dev/null ) &
WATCHDOG=$!
wait "$SANDBOX_PID"; SANDBOX_RC=$?
kill "$WATCHDOG" 2>/dev/null
wait "$TEE_PID" 2>/dev/null

head1 "verdict (MODE=$MODE)"
INNER_FAILURES=$(cat "$RUNDIR/inner.failures" 2>/dev/null || echo "?")
say "host-side failures : $HOST_FAILURES"
say "sandbox failures   : $INNER_FAILURES"
say "sandbox exit       : $SANDBOX_RC"
if [[ $HOST_FAILURES -eq 0 && $INNER_FAILURES == 0 ]]; then
	say "RESULT: PASS — this shape gives working ptys, a narrow /dev, and pasta networking"
	exit 0
fi
say "RESULT: FAIL"
exit 1
