---
target-version: 2.3.0
status: complete
tags: [plan, sandbox, ssh, security, opt-in]
---

# `--allow-ssh <user@host>`: a Single Pre-Authenticated ssh Tunnel

> **Implemented.** Supersedes
> [allow-ssh-opt-in](./allow-ssh-opt-in.md) (agent forwarding) before it was
> built. Also supersedes the ssh-forwarding pointer in
> [pasta-attach-mode-implementation](./pasta-attach-mode-implementation.md)
> item 6 and [accept-root-uid-in-sandbox](./accept-root-uid-in-sandbox.md)
> item 4, both of which left agent forwarding as the only reconsiderable
> option. This is a different mechanism, not a variant of theirs.
>
> Two refinements made during implementation, beyond what was designed here:
> `ConnectTimeout` was added alongside `BatchMode` in the generated `Host *`
> block — `BatchMode` alone suppresses interactive prompts but does not bound
> a slow DNS lookup or TCP connect, which a fallback connection attempt must
> never hang on. And the "Test Plan" section's fixture originally called for
> overriding `HOME` to redirect the master connection in tests; that does not
> work, because ssh resolves `~/.ssh/config` via `getpwuid()`, not `$HOME` —
> confirmed directly while building the test fixture. The fixture uses a
> `PATH`-shimmed `ssh` instead. Both are corrected in place below rather than
> left to mislead a future reader.

## Goal

Let a sandboxed agent run **non-interactive commands over ssh against one
explicit, operator-chosen destination** — for remote administration tasks —
without the sandbox ever holding a private key, an ssh-agent socket, or the
ability to choose *where* ssh connects.

Default behaviour is unchanged: no flag, no ssh.

```
scoder --allow-ssh me@remote-host pi
```

The target is a command-line argument, decided by whoever launches scoder,
not by the agent running inside it. This is the central property that
distinguishes this design from agent forwarding: forwarding the agent grants
the *use* of every key it holds against any host that trusts one of them;
naming one destination up front grants exactly that destination, nothing
else, and control of which host that is stays outside the sandbox entirely.

**CLI ordering note:** consistent with `--llm-port`, `--allow-ssh` is parsed
as a scoder option and must appear **before** the tool name — `scoder
--allow-ssh me@remote-host pi`, not `scoder pi --allow-ssh me@remote-host`.
scoder's parser stops interpreting options at the first bare argument, which
becomes the tool name; everything after that is passed through to the tool
unparsed (`src/cli/parse-args.ts`). Accepting scoder flags after the tool name
would need a different parsing model and would be ambiguous with tool
arguments — out of scope here.

## Why Not Agent Forwarding

[allow-ssh-opt-in](./allow-ssh-opt-in.md) proposed binding `SSH_AUTH_SOCK`
read-only into the sandbox. That works, but the capability it grants is wider
than the goal requires: the sandboxed agent decides which host to connect to,
and the forwarded agent will sign a challenge for any of them. The security
notes in that draft said as much plainly: *"the sandboxed agent can
authenticate as you to every host that trusts any key in your agent."*

A remote-administration session only ever needs one destination — the one the
operator is trying to administer. Fixing that destination outside the sandbox,
before the agent ever starts, removes the delegated-authority problem instead
of just documenting it.

## Mechanism: ssh `ControlMaster`

OpenSSH can multiplex additional sessions over an already-authenticated
connection via a control socket (`ControlMaster`/`ControlPath`). scoder:

1. **Outside the sandbox**, before launch, opens one master connection to the
   exact target named on the command line:
   ```
   ssh -M -N -o ControlPath=<path> -o BatchMode=yes -o ConnectTimeout=10 <user>@<host>
   ```
   `-N` means it carries no command — it exists purely to hold an
   authenticated transport open. Authentication happens exactly as it would
   for any ordinary `ssh` command run by hand: the host's real `~/.ssh/config`,
   agent, and keys, none of which scoder inspects or touches.
2. **Only the resulting unix control socket** — not a key, not the agent
   socket, not `known_hosts`, not `config` — is bound into the sandbox.
3. Inside the sandbox, a scoder-generated `~/.ssh/config` (not the host's) lets
   `ssh <host>` and `ssh <host> <command>` work exactly as they would outside
   it, by pointing that one host's stanza at the bound socket. Any other
   destination — a different host, a different user, a different port — falls
   through to a normal connection attempt with nothing to authenticate with,
   and fails the way ssh always fails when it has nothing to offer.

No `SSH_AUTH_SOCK`, no environment override channel, no `known_hosts`. This is
a smaller change to the sandbox's environment than agent forwarding, not a
larger one — the earlier draft's `extraEnv` addition to `SandboxConfig` is not
needed at all.

## Verified Groundwork (carried over)

From [allow-ssh-opt-in](./allow-ssh-opt-in.md)'s testing, still applicable
because the bind mechanics are the same class of operation (binding a unix
socket path into the sandbox):

| Claim | Result |
|---|---|
| A bwrap bind can make a host unix socket reachable inside the sandbox | **Yes** |
| A **read-only** bind of a unix socket suffices for a client to connect through it | **Yes** — verified for the ssh-agent socket; not independently re-verified for a `ControlMaster` socket specifically, but it is the same connect()-to-AF_UNIX-path operation, so the same result is expected. Listed under Test Plan as a case to confirm rather than assumed silently. |
| The host path lands under `/tmp`, which the sandbox replaces with tmpfs | **Yes** — same reason this design generates its own socket directory and binds it at a stable sandbox path rather than mirroring the host path (see [path-mirroring](../../features/path-mirroring.md) for why that deviation is deliberate here, as it was for the agent socket). |
| Outbound TCP from the sandbox | Not needed — the ssh transport lives entirely on the host side; the sandbox never opens a network connection for ssh at all, only a local unix socket. |

### Not verified

- Whether ssh's strict permission checks (OpenSSH ≥ 8.7 extends these to
  `~/.ssh/config`, not just key files) accept a `--ro-bind`-mounted config file
  and a bwrap-created `~/.ssh` directory (`--dir` makes it `0755`). The
  generated config file itself is created with `mktemp`'s default `0600`,
  which should satisfy the check; not yet run against a real sandbox.
  Test case: `ssh-config-permissions-accepted`.
- Behaviour when the target host is genuinely new to the operator (not yet in
  their real `~/.ssh/known_hosts`). `BatchMode=yes` on the master connection
  means scoder will not prompt to accept an unknown host key — the master
  simply fails, and per the design decision below, so does the whole session
  start. The user must have connected to the target once, outside scoder,
  first. Worth a line in the README rather than a surprise.

## Design Decisions

### 1. Pin the destination with a templated `ControlPath`, not a literal one

The sandbox's generated `~/.ssh/config`:

```
Host <host>
    User <user>
    ControlPath /home/scoder/.ssh-control/%r@%h:%p.sock
    ControlMaster no
    BatchMode yes
```

`Host <host>` matches only the exact hostname the operator named — not `Host
*`. Combined with OpenSSH's `%r`/`%h`/`%p` token expansion in `ControlPath`
(remote user, hostname, port, exactly as typed or defaulted), this is what
makes the flag transparent for the one intended destination *and* fail closed
for everything else, without a wrapper script or any scoder-side
allow/deny logic:

- `ssh <host>` — matches the `Host` block, `User` fills in the login name,
  `%r@%h:%p` resolves to the one file scoder actually bound. Multiplexes
  through the pre-authenticated connection. Looks exactly like ssh outside
  the sandbox, including for non-interactive commands: `ssh <host> <cmd>`.
- `ssh otheruser@<host>` — still matches `Host <host>`, but the explicit user
  overrides `%r`, so `ControlPath` resolves to a filename that does not exist
  in the bound directory. `ControlMaster no` means ssh will not spin up a new
  master for it — it falls through to a normal connection attempt with no
  agent and no keys inside the sandbox, and fails the way ssh always fails
  with nothing to authenticate with.
- `ssh <host> -p <otherport>` — same mechanism, via `%p`.
- `ssh some-other-host` — does not match the `Host` block at all, gets none of
  these directives, and fails the same way.

This was refined from an earlier, weaker version of this idea (a `Host *`
block with a **literal** `ControlPath`) that was rejected during design
discussion: a literal path plus `Host *` would have meant *any* host or user
typed by the agent multiplexes through the one live socket regardless of
mismatch — silently running the command against the pinned target instead of
failing. Token-templating the path is what turns "wrong destination" into a
normal, loud ssh failure instead of a silent one.

### 2. No `known_hosts`, no host `~/.ssh/config` — needed by neither path

This resolves the open "needs your decision" item from the superseded draft
outright rather than choosing a side of it:

- On the **matching** path, the mux client never performs its own host-key
  verification — it hands the request to the already-authenticated master,
  which verified the host key outside the sandbox before this session ever
  started. Nothing inside the sandbox needs `known_hosts`.
- On the **mismatch/fallback** path, host-key material would only help ssh
  succeed — which is exactly the outcome we want to avoid for anything other
  than the pinned target.

So the sandbox never sees the operator's real `~/.ssh/known_hosts` or
`~/.ssh/config` at all — only the small, synthetic stanza above, generated by
scoder and containing no real hostnames beyond the one already passed on the
command line, no `IdentityFile` paths, nothing else about the operator's
other infrastructure.

### 3. Read-only bind of the control-socket directory

Bind the directory containing the control socket (not `~/.ssh` itself) at a
sandbox path outside `~/.ssh`, e.g. `/home/scoder/.ssh-control`, with
`ro-bind`. Kept separate from `/home/scoder/.ssh` (which holds only the
generated `config`) so the two concerns — "where the transport lives" and
"what ssh reads by default" — don't share a directory tree, and so a future
`.agentreadonly` `$HOME/.ssh` bind (see Interactions to Resolve) only
conflicts with the smaller of the two.

### 4. Fail closed, not just warn

The superseded draft recommended warning and continuing if no usable agent
was found, reasoning the user might not need ssh that session. That reasoning
doesn't transfer here: agent forwarding was incidental (the agent is running
anyway; `--allow-ssh` just exposed it), but this design's `--allow-ssh
<user@host>` **names a specific destination the operator explicitly asked
for**. If scoder cannot establish that connection — bad host, auth failure,
timeout — continuing without it silently would be more confusing than
refusing to start, echoing the same "bounded wait, then a clear error"
lesson [ADR 0001](/architecture/decision-records/0001-sandbox-uid-and-networking-composition.md)
already drew from pasta's attach failure mode.

```
scoder: --allow-ssh me@remote-host failed to establish a connection
scoder: <captured ssh stderr>
scoder: refusing to start without the ssh access you asked for
```

Exit non-zero, matching how `-w`/`--worktree` refuses outright when it cannot
do what was asked, rather than the warn-and-continue precedent used elsewhere
in scoder for genuinely optional conveniences (e.g. LLM port auto-detection).

### 5. Warn when the target is the machine scoder runs on

A destination like `me@localhost` or `me@127.0.0.1` — or any address that
resolves to the same host scoder is running on — makes `--allow-ssh` a full,
unsandboxed shell back onto the host. This is different from, and worse than,
the general "your ssh reach becomes the sandbox's reach" caveat below: it
specifically defeats the sandbox's own purpose regardless of what the target
account can do, because the target *is* the machine being sandboxed against.

Recommendation: **warn loudly, do not block.** Blocking would also break the
one legitimate reason to point at loopback: testing (see Test Plan — the mock
`sshd` used there listens on `127.0.0.1` by design). Detect via resolving
`<host>` and comparing against the host's own addresses; warn if there's a
match, continue either way.

## Changes Required

### `src/types.ts`

```typescript
export interface ScoderOptions {
	// ...existing
	sshTarget: string | null;
}
```

Holds the raw, shape-validated `user@host` string. Splitting it into
`{ user, host }` happens in `src/sandbox/ssh.ts`, not the CLI layer.

### `src/cli/parse-args.ts`

- Default `sshTarget: null`.
- Parse `--allow-ssh=<user@host>` and `--allow-ssh <user@host>` (both forms,
  mirroring `--llm-port`).
- Validate shape at parse time: exactly one `@`, non-empty user and host
  substrings. Reject otherwise:
  `--allow-ssh must be in the form user@host`.
- Add to `USAGE`:
  ```
      --allow-ssh USER@HOST  Open a single pre-authenticated ssh connection to
                              USER@HOST outside the sandbox, and expose only
                              that one connection inside it
  ```

### `src/sandbox/ssh.ts` — new

Structured the same way as `src/sandbox/pasta.ts` — a sidecar the sandbox
depends on but that runs outside it, started before launch and torn down
explicitly on exit, because nothing inside the sandbox's own lifecycle
(bwrap's `--die-with-parent`) reaps it.

```typescript
export interface SshTarget {
	user: string;
	host: string;
}

export interface SshTunnel {
	pid: number;
	controlDir: string;   // temp dir holding the control socket (host side)
	controlPath: string;  // host-side path to the control socket file
}

export interface SshAccess {
	binds: BindMount[];
	dirs: string[];
	tunnel: SshTunnel;
}

// Splits "user@host" — the CLI already validated the shape.
export function parseSshTarget(raw: string): SshTarget;

// Opens the master connection and waits, with a bound, for it to become
// ready. Returns null (having reported ssh's stderr) if the master exits
// first or the wait times out — see Design Decision 4 for why the caller
// treats null as fatal rather than warn-and-continue.
export async function startSshTunnel(raw: string): Promise<SshAccess | null>;

// Builds the same binds/dirs a live tunnel would produce, without opening a
// connection. Used by --dry-run — see the dry-run note below.
export function describeSshAccess(raw: string): SshAccess;

// `ssh -O exit`, then the same SIGTERM/SIGKILL/waitForExit escalation as
// stopPasta. Removes controlDir afterward. Safe to call more than once and
// safe when the tunnel is null.
export async function stopSshTunnel(tunnel: SshTunnel | null): Promise<void>;
```

`startSshTunnel` responsibilities:

1. `parseSshTarget` the raw string.
2. `mktemp -d` for `controlDir` (same helper pattern as `createTempDir` in
   `src/git/protection.ts`).
3. `controlPath = ${controlDir}/${user}@${host}:22.sock` — the literal
   filename scoder computes for itself, matching the `%r@%h:%p` token
   expansion the sandbox-side config will use to look it up. (Port is fixed
   at `22` for this iteration — see Non-Goals.)
4. `Bun.spawn(["ssh", "-M", "-N", "-o", "ControlPath=" + controlPath, "-o",
   "BatchMode=yes", "-o", "ConnectTimeout=10", user + "@" + host], ...)`.
5. Race the master's own exit against `ssh -O check -S <controlPath>
   <user>@<host>` succeeding, bounded (e.g. matching pasta's grace-period
   style rather than inventing a new one). If the master exits first, capture
   and surface its stderr.
6. On success, return binds for the control directory (`ro-bind`) and the
   generated config file (`ro-bind`, at `/home/scoder/.ssh/config`), the `dir`
   entry for `/home/scoder/.ssh`, and the tunnel handle.
7. Emit the loopback-target warning (Design Decision 5) here, once resolution
   is known.

### `src/sandbox/builder.ts`

No changes. Unlike the superseded draft, this design needs no `extraEnv`
override channel — everything is a filesystem bind, applied the same way
`toolBinds` and `protectionConfig.safeBinds` already are.

### `src/index.ts`

Alongside the other snapshot setups, in **both** the worktree and direct
branches — same latent-duplication trap the superseded draft flagged, since
binding in only one half-enables the feature:

```typescript
let sshTunnel: SshTunnel | null = null;
if (options.sshTarget) {
	const sshAccess = options.dryRun
		? describeSshAccess(options.sshTarget)
		: await startSshTunnel(options.sshTarget);

	if (!sshAccess) {
		error(`--allow-ssh ${options.sshTarget} failed to establish a connection`);
		process.exit(1);
	}

	if (protectionConfig) {
		protectionConfig.safeBinds.push(...sshAccess.binds);
		protectionConfig.dirs?.push(...sshAccess.dirs);
	}
	sshTunnel = "tunnel" in sshAccess ? sshAccess.tunnel : null;
}
```

**Dry-run must not open a real connection.** `--dry-run` today has no
observable side effects — it never runs `launchSandbox`, so pasta never
attaches either. Actually calling `startSshTunnel` under `--dry-run` would
make dry-run reach out to a real remote host as a side effect, which is a
behavioural regression dry-run shouldn't have. `describeSshAccess` produces
the same shape of binds (using a placeholder control path under a
not-yet-created temp dir) purely for display, so `--dry-run --allow-ssh
me@host` shows what *would* be bound without connecting to anything.

`stopSshTunnel(sshTunnel)` belongs in the same `finally` block that already
removes `identity.dir`:

```typescript
} finally {
	await removeGitExclude(repoRoot, "AGENTS.md");
	if (identity) {
		await rm(identity.dir, { recursive: true, force: true });
	}
	await stopSshTunnel(sshTunnel);
}
```

## Interactions to Resolve

1. **Overlap with `.agentreadonly` `$HOME/.ssh`.** A user who binds their
   whole real `~/.ssh` via `.agentreadonly` *and* passes `--allow-ssh` would
   have two things trying to populate `/home/scoder/.ssh` — the real
   directory (with private keys) and scoder's generated `config`. Decision 3
   keeps the control socket out of that path, but the generated `config`
   file itself still collides. `RESERVED_SANDBOX_PATHS` in
   `src/git/protection.ts` doesn't list `.ssh` today, and shouldn't gain a
   *static, unconditional* entry for it either — that would break the
   existing, deliberately supported "opt in via `.agentreadonly`" path
   documented in `pasta-attach-mode-implementation.md` item 6, for sessions
   that never pass `--allow-ssh` at all. Instead, refuse the *combination*
   explicitly when both are present for a given session, at the same point
   `sshAccess.binds` would otherwise be pushed:
   `.agentreadonly binds $HOME/.ssh, which conflicts with --allow-ssh — use one or the other`.
2. **Nested sandboxes.** A sandbox that re-runs scoder with `--allow-ssh`
   would need the control socket re-forwarded from the already-forwarded
   path. Document as unsupported, same conclusion the superseded draft
   reached for the same scenario.
3. **`--dry-run`** shows the control-socket bind and the generated config
   content, per the dry-run note above, without connecting to anything.
4. **ssh config permission strictness** — see Not Verified above.

## Non-Goals (this iteration)

- **Custom ports.** `--allow-ssh` takes `user@host` only; the master always
  connects on port 22. A host on a different port can still be reached today
  by the operator's own `~/.ssh/config` `Host`/`Port` alias resolving `host`
  to the right place before scoder ever sees it — no new scoder surface
  needed for that, and it's exactly how the test plan below reaches a
  same-host `sshd` on a non-privileged port without inventing a `--ssh-port`
  flag. Add explicit port support later only if that proves insufficient.
- **Interactive sessions.** Confirmed out of scope in discussion — the goal is
  non-interactive remote administration commands (`ssh host cmd`). A `ssh
  host` with no command still works through the mechanism above (nothing
  prevents it), but nothing here is designed around making it pleasant.

## Test Plan

Needs a real, disposable `sshd` outside the sandbox — a mock ssh **server**,
not a mock of the ssh protocol, because `ControlMaster` multiplexing is a
genuine OpenSSH client/server behaviour that cannot be faked with a plain TCP
stub. This is the same shape of thing `Bun.serve()` mock HTTP servers already
do for `host-loopback-blocked` and the `llm-port` cases — a test-owned,
throwaway service outside the sandbox that a sandboxed session then tries (or
fails) to reach — just an `sshd` process instead of an HTTP one.

### Test fixture: `startMockSshd()`

A new test helper, cleaned up the same way `Bun.serve()` mocks are (`finally`
block, mirrored in an `afterAll` for anything left running):

1. Generate an ephemeral host key (`ssh-keygen -t ed25519 -f <tmp>/host_key -N ""`).
2. Generate an ephemeral client key and its own `authorized_keys` file.
   `sshd` authenticates against real system accounts, so the fixture logs in
   as the test-runner's own user (`$(whoami)@127.0.0.1`) rather than a
   fabricated identity.
3. Pick a free unprivileged port (bind a throwaway listener to port 0, read
   it back, close it — same trick used for the `llm-port` fixtures).
4. Start `sshd -f <generated config> -p <port> -h <tmp>/host_key -D`, with
   `UsePAM no`, `AuthorizedKeysFile <tmp>/authorized_keys`, `StrictModes no`
   (temp-dir permissions are not guaranteed to satisfy sshd's default
   strictness), `PidFile <tmp>/sshd.pid`.
5. Return `{ port, hostKeyPath, clientKeyPath, cleanup }`.

The test's `--allow-ssh` target is `$(whoami)@127.0.0.1`. The non-default port
is supplied by **shimming `ssh` on `PATH`**, not by overriding `HOME` — this
was tried first and doesn't work: ssh resolves `~/.ssh/config` via
`getpwuid()`, the same quirk documented in
[ADR 0001](/architecture/decision-records/0001-sandbox-uid-and-networking-composition.md),
so a `$HOME` override is silently ignored for config lookup (confirmed
directly — `HOME=<fixture> ssh -G 127.0.0.1` still reports `port 22`). A
fixture-local `ssh` script ahead of the real one on `PATH`,
`exec /usr/bin/ssh -F <tmp>/client_config "$@"`, forces the redirect
regardless of `$HOME`:

```
Host 127.0.0.1
    Port <port>
    IdentityFile <clientKeyPath>
    UserKnownHostsFile <tmp>/known_hosts
    StrictHostKeyChecking yes
```

(`known_hosts` pre-populated via `ssh-keyscan -p <port> 127.0.0.1`). This only
affects the *host-side master connection* `startSshTunnel` opens — it never
touches the sandboxed ssh invocation, which reads the real generated
`/home/scoder/.ssh/config` and needs no shim, since inside the sandbox
`getpwuid()` already resolves correctly to `/home/scoder` (that's what
`setupSandboxIdentity` is for). Confirmed directly against a throwaway
control-socket directory standing in for `/home/scoder/.ssh-control`, without
bwrap: the matching host multiplexes through in ~0.1s (`whoami` returns the
real remote user), a wrong user falls through to a real, fast, failing
connection attempt (`Connection refused`), and a wrong host fails equally
fast (`Could not resolve hostname`) — no hangs, confirming `Host *` /
`BatchMode yes` (plus `ConnectTimeout`, added after this test — ssh's
`BatchMode` suppresses interactive prompts but does not itself bound a slow
DNS lookup or TCP connect) is sufficient for the fallback path to fail
quickly rather than hang. No `--ssh-port` flag needed — see Non-Goals.

The whole group `skipIf`s when `sshd` is not on `PATH`, mirroring how
`claude-preset-home-config-writable` self-skips when `claude` isn't
installed.

### Cases

- `ssh-tunnel-established-with-flag`: with `--allow-ssh $(whoami)@127.0.0.1`
  and the mock `sshd` running, `ssh 127.0.0.1 whoami` inside the sandbox
  returns the expected remote username. The real end-to-end proof.
- `ssh-blocked-by-default`: same command, no flag — fails.
- `ssh-wrong-host-falls-through`: with the flag set, `ssh some-other-host
  whoami` inside the sandbox fails. Guards against the tunnel leaking to
  destinations other than the one named.
- `ssh-wrong-user-falls-through`: with the flag set, `ssh
  someoneelse@127.0.0.1 whoami` inside the sandbox fails. Guards the
  `%r`-based pinning specifically (Design Decision 1).
- `ssh-control-socket-bound-readonly`: `--dry-run` output contains `--ro-bind`
  for the control-socket directory, not `--bind`.
- `ssh-no-private-keys-in-sandbox`: with the flag set, nothing under
  `/home/scoder/.ssh` or `/home/scoder/.ssh-control` is a private key. Carries
  forward the superseded draft's most important guard, adapted: this design
  never binds the operator's real `~/.ssh` at all, so this should hold
  trivially, but it is what stops a future "just forward the agent, it's
  easier" change from passing review.
- `ssh-tunnel-fails-closed-on-bad-target`: `--allow-ssh` pointed at an
  unreachable host exits non-zero with a clear error rather than hanging.
  Guards Design Decision 4 and the ADR-0001-style bounded-wait lesson.
- `ssh-tunnel-torn-down-on-exit`: after a completed session, no leftover ssh
  master process survives. Counts before/after rather than asserting zero,
  matching `pasta-sidecar-reaped`'s reasoning (the developer may have other
  legitimate ssh sessions running).
- `dry-run-does-not-connect`: `--dry-run --allow-ssh $(whoami)@127.0.0.1`
  completes without the mock `sshd` ever seeing a connection attempt.

## Security Notes

Worth stating plainly in the README, not just here.

**What the flag grants.** For the lifetime of the session, the sandboxed
agent can run commands as **exactly the named user, on exactly the named
host** — nothing else. It cannot reach a different host, authenticate as a
different user, or extract the credentials that made the connection possible
in the first place.

**This is still real exposure, just a narrower one than agent forwarding.**
Whatever `<user>@<host>` can do, the sandboxed agent can now do, for the
session's duration. If that account has broad reach — root on a production
box, say — the sandbox boundary does not limit what happens on the other end
of that one connection. Choosing a narrowly-scoped remote account for
whatever administration task is intended is the user's mitigation, same as
it would be for running that command by hand.

**Loopback targets are a special case of the above, worth calling out
separately** (Design Decision 5): pointing `--allow-ssh` at the machine
scoder itself runs on removes the sandbox boundary for anything reachable
that way, regardless of what the target account can do, because the target
*is* the thing being sandboxed against.

**Not addressed here:** exactly as the superseded draft noted for agent
forwarding, if `<host>` itself has network access back to the machine running
scoder, a sandboxed agent that can run commands on `<host>` may be able to
reach back around the sandbox indirectly. Out of scope for this design, same
as before.

## Documentation to Update

(At implementation time, not now — this stays a plan until built.)

- New `design/features/ssh-tunnel-access.md`, linked from `design/SCOPE.md`
  (`em doc` checks feature docs against `HAS_FEATURE` entries and will fail
  otherwise).
- `README.md`: the flag in Options, the CLI-ordering note above, and the
  Security Notes section. The sandbox properties list currently implies
  nothing reaches out on the operator's behalf; that becomes conditional.
- `design/test-scripts/validation-suite.md`: the new cases, the mock-`sshd`
  fixture, and the count.
- `architecture/FRAMEWORK.md`: the module map gains `src/sandbox/ssh.ts`.
- Update the pointers in `pasta-attach-mode-implementation.md` item 6 and
  `accept-root-uid-in-sandbox.md` item 4 from "agent forwarding, not planned"
  to "superseded by this plan" (done now, ahead of implementation, since
  those pointers were actively misleading once this draft existed).

[IMPACTS](/src/cli/parse-args.ts)
[IMPACTS](/src/index.ts)
[IMPACTS](/src/types.ts)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
[HAS_FEATURE](/design/features/path-mirroring.md)
[HAS_FEATURE](/design/features/network-isolation.md)
