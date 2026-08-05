---
target-version: 2.3.0
status: superseded
tags: [plan, sandbox, ssh, security, opt-in]
---

# `--allow-ssh`: Opt-in ssh Access from the Sandbox

> **Superseded by
> [ssh-tunnel-opt-in](./ssh-tunnel-opt-in.md).** Agent forwarding grants the
> sandboxed agent the *use* of every key the host agent holds, against any
> host it trusts. Discussion after this draft concluded that was more
> exposure than the goal needed: a session only ever wants to reach one
> destination, decided by the person launching scoder, not by whatever the
> agent inside decides to connect to. `ssh-tunnel-opt-in` replaces the
> forwarded agent socket with a single pre-authenticated ssh connection
> (`ControlMaster`) that scoder itself opens to an explicit `user@host`
> target, multiplexed into the sandbox. Retained here as the record of the
> agent-forwarding option and why it was moved away from — the Verified
> Groundwork below (the socket-bind mechanism, the tmpfs-over-`/tmp` problem,
> read-only-bind sufficiency) still applies to the new design and is
> referenced from it rather than re-verified.
>
> Original framing, superseding the "ssh is out of scope" decision recorded in
> [pasta-attach-mode-implementation](./pasta-attach-mode-implementation.md) item 6
> and [accept-root-uid-in-sandbox](./accept-root-uid-in-sandbox.md) item 4:

## Goal

Let a sandboxed agent use ssh — for remote administration tasks — behind an
explicit `--allow-ssh` flag, **without any private key entering the sandbox**.

Default behaviour is unchanged: no flag, no ssh.

## Verified Groundwork

Established by direct testing before this document was written:

| Claim | Result |
|---|---|
| Agent forwarding works through a bwrap bind | **Yes** — `ssh-add -l` inside the sandbox listed the host agent's key |
| A **read-only** bind of the socket suffices | **Yes** — connecting to a unix socket does not need a writable mount |
| Is the socket already reachable? | **No.** `SSH_AUTH_SOCK` was `/tmp/ssh-XXXX/agent.N`, and `/tmp` is a fresh tmpfs inside the sandbox |
| Does `~/.ssh` hold real key material? | **Yes** — `.pem`, `exeter_laptop`, `config_clifton`, `authorized_keys` |
| Outbound TCP from the sandbox | **Yes** — verified separately; `--tcp-ports none` only disables inbound forwarding |

The mechanism, minimally:

```
--ro-bind "$SSH_AUTH_SOCK" /home/scoder/.ssh-agent.sock
--setenv SSH_AUTH_SOCK /home/scoder/.ssh-agent.sock
```

### Not verified

Flagged because the design leans on them:

- Whether `~/.ssh/known_hosts` exists on the dev machine, and its permissions.
  I was interrupted before checking, and it affects work item 4.
- Behaviour when no agent is running (`SSH_AUTH_SOCK` unset, or set but stale).
- The gnome-keyring agent variant. `/run/user/<uid>/keyring/{control,pkcs11}`
  exists on the dev machine but `SSH_AUTH_SOCK` did not point there, so the
  keyring-as-ssh-agent path is untested.
- Whether ssh's strict-permission checks complain about a bwrap-created
  `~/.ssh` directory (`--dir` makes it 0755).

## Design Decisions

### 1. Forward the agent; never bind private keys

`--allow-ssh` grants the *use* of keys, not the keys. The agent signs
challenges on the host; no key file crosses the boundary, and nothing persists
after the session.

Binding `~/.ssh` wholesale remains possible for anyone who really wants it, via
an existing mechanism that needs no code: a `$HOME/.ssh` line in
`.agentreadonly`. Keeping those two paths distinct means the flag has one clear
meaning and the riskier option stays deliberate and separate.

### 2. Bind at a stable sandbox path, not the mirrored host path

Bind to `/home/scoder/.ssh-agent.sock` rather than mirroring
`/tmp/ssh-XXXX/agent.N`, because:

- The host path is under `/tmp`, which the sandbox replaces with a tmpfs. A
  mirrored bind would have to be ordered after that tmpfs — workable but fragile.
- The host path embeds a random directory name, so nothing inside the sandbox
  could rely on it.
- It keeps a host path shape out of the sandbox.

This deviates from `path-mirroring`, which is deliberate: the socket is not a
project file and nothing cross-references its path.

### 3. Read-only bind

Verified sufficient. Use `ro-bind` so the flag grants no more than it needs.

### 4. Also bind the non-secret config — *needs your decision*

Agent forwarding alone is arguably not enough to be useful:

- Without `known_hosts`, ssh cannot verify a host and will refuse or prompt.
  Non-interactive use fails.
- Without `config`, host aliases do not resolve, so `ssh myhost` fails even
  though the agent has the key.

Both files are non-secret. Recommendation: bind `~/.ssh/known_hosts` and
`~/.ssh/config` read-only as part of `--allow-ssh`.

Caveats:

- `config` will contain `IdentityFile` paths that do not exist in the sandbox.
  ssh tries them, fails, and falls back to the agent — noisy but functional.
- `config` leaks hostnames and infrastructure detail. Non-secret, but not nothing.

The alternative — agent only, and let the user add `$HOME/.ssh` to
`.agentreadonly` if they need config — is simpler but means the flag alone
rarely works, and the fallback exposes keys. That trade is why I recommend
including the two files, but it is your call.

### 5. Fail loudly, not silently

If `--allow-ssh` is passed and no usable agent is found, warn clearly rather
than starting a sandbox where ssh mysteriously does not work. Suggested text:

```
scoder: --allow-ssh was given but SSH_AUTH_SOCK is not set
scoder: start an agent and add a key:  eval "$(ssh-agent)" && ssh-add
scoder: continuing without ssh access
```

Warning rather than fatal: the user may not need ssh for that session.

## Changes Required

### `src/types.ts`

```typescript
export interface ScoderOptions {
	// ...existing
	allowSsh: boolean;
}
```

### `src/cli/parse-args.ts`

- Default `allowSsh: false` in the options literal.
- Parse `--allow-ssh`.
- Add to `USAGE`:

```
    --allow-ssh         Forward the ssh agent into the sandbox, so ssh can
                        authenticate without private keys entering it
```

### `src/sandbox/ssh.ts` — new

```typescript
export interface SshAccess {
	binds: BindMount[];
	dirs: string[];
	env: Record<string, string>;
}

// Returns null when --allow-ssh was not given, or when no usable agent exists
// (having warned). The socket is bound read-only; a unix socket connect does
// not need a writable mount.
export async function setupSshAccess(realHome: string): Promise<SshAccess | null>;
```

Responsibilities:

1. Read `SSH_AUTH_SOCK`; confirm the path exists and is a socket. Warn and
   return null otherwise.
2. `ro-bind` it at `/home/scoder/.ssh-agent.sock`.
3. If item 4 is adopted: `--dir /home/scoder/.ssh` plus `ro-bind` for
   `known_hosts` and `config` when each exists.
4. Return `SSH_AUTH_SOCK=/home/scoder/.ssh-agent.sock` as env.

### `src/sandbox/builder.ts`

`SandboxConfig` gains an override channel for environment variables. The
existing `passThrough` allowlist cannot serve here: it copies host values
through unchanged, and `SSH_AUTH_SOCK` must be *replaced* with the sandbox path.

```typescript
export interface SandboxConfig {
	// ...existing
	extraEnv?: Record<string, string>;
}
```

Emit `--setenv` for each entry, after the existing `passThrough` loop so an
override wins.

### `src/index.ts`

Alongside the other snapshot setups, in **both** the worktree and direct
branches — the existing duplication between those two blocks is a latent trap
here, since binding in only one would half-enable the feature:

```typescript
const sshAccess = options.allowSsh ? await setupSshAccess(realHome) : null;
if (sshAccess && protectionConfig) {
	protectionConfig.safeBinds.push(...sshAccess.binds);
	protectionConfig.dirs?.push(...sshAccess.dirs);
}
```

Then thread `extraEnv: sshAccess?.env` into the `config` object passed to
`buildBwrapCommand`.

No cleanup needed: nothing is written to `/tmp`, unlike the identity and
snapshot paths.

## Interactions to Resolve

1. **Overlap with `.agentreadonly` `$HOME/.ssh`.** If a user binds the whole
   directory *and* passes `--allow-ssh`, both try to bind under
   `/home/scoder/.ssh`. `RESERVED_SANDBOX_PATHS` in `src/git/protection.ts` does
   not currently list `.ssh`, so the `.agentreadonly` bind is permitted today.
   Decide precedence, or detect and refuse the combination. Bind ordering means
   the later one silently wins, which is the worst outcome.
2. **Nested sandboxes.** A sandbox that re-runs scoder with `--allow-ssh` would
   need the socket re-forwarded from the already-forwarded path. Probably just
   document as unsupported.
3. **`--dry-run`** should show the socket bind and the `SSH_AUTH_SOCK` override,
   or it stops describing what runs.
4. **ssh directory permissions.** If item 4 is adopted, confirm ssh accepts a
   0755 `~/.ssh` created by `--dir`. If not, the files may need binding
   somewhere else with `-F`/`UserKnownHostsFile` pointed at them via config,
   which would be considerably more intrusive.

## Test Plan

Mirroring how `claude-preset-home-config-writable` handles environment
dependence — `skipIf` when no agent is present, so the suite still passes on a
machine without one.

- `ssh-agent-forwarded`: with `--allow-ssh`, `ssh-add -l` inside the sandbox
  lists the same key as the host. This is the real end-to-end assertion and the
  one that proves the feature.
- `ssh-blocked-by-default`: without the flag, `SSH_AUTH_SOCK` is unset inside
  the sandbox and `ssh-add -l` fails. Guards the default.
- `ssh-agent-socket-bound-readonly`: `--dry-run` output contains `--ro-bind`
  for the socket, not `--bind`.
- `ssh-no-private-keys`: with `--allow-ssh`, `/home/scoder/.ssh` contains no
  private key files. The most important guard in the set — it is what stops a
  later "just bind ~/.ssh, it's easier" change from passing review.
- `allow-ssh-warns-without-agent`: with `SSH_AUTH_SOCK` cleared, the flag warns
  and the session still starts.

## Security Notes

Worth stating plainly in the README, not just here.

**What the flag grants.** For the lifetime of the session, the sandboxed agent
can authenticate as you to **every host that trusts any key in your agent**. It
cannot read the keys, cannot copy them, and retains nothing after exit — but
while running it has the same reach you do.

That is a smaller exposure than binding `~/.ssh`, and a real one. It is not
mitigated by the sandbox's filesystem isolation, because the capability is
delegated rather than stolen.

**Mitigations available to the user**, host-side and worth documenting:

- `ssh-add -c` requires interactive confirmation for each signing operation,
  which turns silent use into a prompt.
- A dedicated agent holding only the keys needed for the task, started for the
  session:  `eval "$(ssh-agent)" && ssh-add ~/.ssh/that_one_key`.
- `ssh-add -t <seconds>` bounds how long the key stays usable.

**Not addressed here:** an agent that holds a key with access to the machine
scoder is running on lets the sandbox reach back to the host over the network,
sidestepping the sandbox entirely. Users doing remote administration should
assume `--allow-ssh` is close to "no sandbox" for anything their keys reach.

## Documentation to Update

- New `design/features/ssh-agent-forwarding.md`, linked from `design/SCOPE.md`
  (`em doc` checks feature docs against `HAS_FEATURE` entries and will fail
  otherwise).
- `README.md`: the flag in Options, plus the security note above. The sandbox
  properties list currently implies nothing reaches out; that becomes
  conditional.
- `design/test-scripts/validation-suite.md`: the new cases, and the count.
- Supersede item 6 of `pasta-attach-mode-implementation.md` and item 4 of
  `accept-root-uid-in-sandbox.md`, which both record ssh as out of scope.
- `architecture/FRAMEWORK.md`: the module map gains `src/sandbox/ssh.ts`.

[IMPACTS](/src/cli/parse-args.ts)
[IMPACTS](/src/sandbox/builder.ts)
[IMPACTS](/src/index.ts)
[IMPACTS](/src/types.ts)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
[HAS_FEATURE](/design/features/host-tool-binding.md)
