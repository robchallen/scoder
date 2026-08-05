---
target-version: 2.3.0
status: draft
tags: [feature, ssh, security, opt-in]
---

# ssh Tunnel Access

## Summary

`--allow-ssh <user@host>` opens a single pre-authenticated ssh connection to
an operator-named destination, outside the sandbox, and multiplexes only that
one connection into it via ssh `ControlMaster`. No private key, ssh-agent
socket, or `known_hosts` ever enters the sandbox. Default behaviour is
unchanged: no flag, no ssh.

## Motivation

Remote administration tasks sometimes need ssh, but forwarding an ssh-agent
socket grants the sandboxed agent the *use* of every key it holds against any
host it trusts — more reach than a session that only ever needs one
destination requires. Naming that destination on the command line, and
opening the connection before the agent ever starts, keeps the choice of
*where* ssh connects outside the sandbox entirely.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/ssh.ts)
[IMPLEMENTED_BY](/src/cli/parse-args.ts)
[IMPLEMENTED_BY](/src/index.ts)

- `startSshTunnel` opens `ssh -M -N -o ControlPath=<path> -o BatchMode=yes -o
  ConnectTimeout=10 <user>@<host>` outside the sandbox, using the operator's
  own ssh config/agent/keys exactly as an ordinary `ssh` invocation would.
  Bounded wait for the master to become ready (`ssh -O check`), racing it
  against the master exiting first.
- Only the resulting unix control socket, and a scoder-generated (not the
  host's) `~/.ssh/config`, are bound into the sandbox:
  - `ro-bind` the socket's directory at `/home/scoder/.ssh-control`.
  - `ro-bind` the generated config at `/home/scoder/.ssh/config`.
- The generated config pins both host *and* user via a token-templated
  `ControlPath` (`%r@%h:%p`) inside a `Host <host>` block — not a literal
  path, not `Host *`. A bare `ssh <host> [cmd]` resolves to the one bound
  socket and multiplexes through transparently; a different user, host, or
  port resolves to a socket that does not exist, and falls through to a
  normal connection attempt with nothing to authenticate with. A global
  `Host *` block sets `BatchMode yes` and a bounded `ConnectTimeout`, so that
  fallback attempt fails fast rather than hanging on an interactive prompt or
  a slow DNS/TCP attempt.
- No `known_hosts` is needed on either path: the matching path never performs
  its own host-key check (the already-authenticated master already did, host
  side, before the session started), and the fallback path is only ever
  supposed to fail.
- `--dry-run` never opens a real connection — `describeSshAccess` produces
  the same shape of binds against a placeholder path, purely for display.
- `stopSshTunnel` asks the master to exit gracefully (`ssh -O exit`), then
  escalates SIGTERM/SIGKILL like `stopPasta` does, since the master runs
  outside the sandbox and nothing in the sandbox's own lifecycle reaps it.
- A target that resolves to the machine scoder itself runs on is warned about
  (not blocked — blocking would also rule out testing against a local mock
  server), since it makes the flag a full, unsandboxed shell back onto the
  host.
- `.agentreadonly` binding `$HOME/.ssh` and `--allow-ssh` together are
  refused explicitly, since both would try to populate `/home/scoder/.ssh`
  and bind ordering would make whichever applies last win silently.

[HAS_FEATURE](./sandbox-isolation.md)
[HAS_FEATURE](./network-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
