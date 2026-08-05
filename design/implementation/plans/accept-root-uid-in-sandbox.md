---
target-version: 2.3.0
status: rejected
tags: [plan, sandbox, uid, nss, ssh]
---

# Accept root uid in the Sandbox

> **Rejected** in favour of
> [pasta-attach-mode](../../prototypes/pasta-attach-mode.md). See
> [ADR 0001](../../../architecture/decision-records/0001-sandbox-uid-and-networking-composition.md)
> for the reasoning: the sandbox should resemble an ordinary home directory
> rather than a root shell, and attach mode leaves room to change forwarded
> ports without restarting a session. Neither consideration is about diff size,
> which is where this option wins.
>
> **Retained because parts of it still apply.** Work items 1 (as uid 1001, not
> uid 0), 4 and 6 are carried into the chosen approach:
>
> - **Item 1, adapted** — the passwd entry must exist and must not be a
>   one-line file that discards `nobody` and friends. Under attach mode it stays
>   uid **1001**, which is what the current code already writes, so only the
>   whole-file and `/etc/group` parts remain outstanding.
> - **Item 4, unchanged** — `~/.ssh` is not bound at all, so ssh has nowhere to
>   read from regardless of which option is taken. The option analysis below is
>   the live version.
> - **Item 6, unchanged** — the predictable, uncleaned passwd temp file is a bug
>   either way.
>
> Items 2, 3 and 5 fall away: identity is settled as the unprivileged `scoder`
> user, `/root` needs no symlink, and preset tolerance of root stops mattering.

## Goal

Stop fighting the uid. pasta and bwrap both want the sandboxed process to be
uid 0, so accept that and make the *identity* of uid 0 correct instead: home
directory, name and group resolving to `/home/scoder` through NSS, so that
`~/.ssh` and everything else lands in the right place without each tool needing
`$HOME` to be honoured.

Addresses [sandbox-uid-becomes-root](../issues/sandbox-uid-becomes-root.md).

## Why the Current Behaviour Breaks

There are two independent home-resolution paths, and only one of them works
today:

| Mechanism | Used by | Today |
|-----------|---------|-------|
| `$HOME` environment variable | bash `~`, git, Node `os.homedir()`, Python `expanduser` | `/home/scoder` ✅ |
| `getpwuid(getuid())` via NSS | **OpenSSH**, `whoami`, anything resolving by uid | `/root` ❌ |

scoder already writes a custom `/etc/passwd` and binds it, but the entry is

```
scoder:x:1001:1001:Sandbox User:/home/scoder:/bin/bash
```

— uid **1001**, while the effective uid inside the sandbox is **0**. Nothing
matches `getpwuid(0)`, so NSS falls through to `nss-systemd`, which synthesises
`root:x:0:0:Super User:/root:/usr/bin/bash`. That synthetic `/root` is the bug,
and `/root` does not even exist inside the sandbox.

The one-line passwd file also discards every other entry (`nobody`,
`systemd-*`). That has gone unnoticed precisely because the systemd fallthrough
has been backfilling them.

## Verified Core Change

Rewriting the root line's home field is sufficient for resolution. Confirmed by
direct probe:

```
root:x:0:0:Sandbox User:/home/scoder:/bin/bash

  getent uid 0 : root:x:0:0:Sandbox User:/home/scoder:/bin/bash
  getpwuid home: /home/scoder
  ssh -G       : identityfile ~/.ssh/id_rsa …
```

This depends on `files` preceding `systemd` in `/etc/nsswitch.conf`. On the
development host the order is `passwd: files systemd sss`, so `files` wins — but
the ordering is host policy, not a guarantee, and should be treated as a
precondition worth asserting rather than assuming.

## Work Items

### 1. Correct the passwd entry

- Write the entry for **uid 0**, not the host uid.
- Copy the host `/etc/passwd` and rewrite only the root line's home field,
  rather than emitting a single-line file.
- Do the same for `/etc/group` and gid 0, which has the identical problem and
  currently no handling at all.

### 2. Settle the identity

`USER=scoder` is currently set while `whoami` returns `root`. Pick one:

- **Keep the name `root`, home `/home/scoder`**, and set `USER`/`LOGNAME` to
  `root` to match. Maximum compatibility; the sandbox genuinely is root and
  pretending otherwise is what produced the mismatch. *Preferred.*
- Name uid 0 `scoder`. Consistent with the existing env, but breaks anything
  calling `getpwnam("root")`.

### 3. Symlink `/root` to `/home/scoder`

`--symlink /home/scoder /root`, so anything hardcoding `/root` rather than
asking NSS lands correctly instead of hitting ENOENT. Cheap insurance.

### 4. Decide how ssh gets its material

> **Decided: out of scope.** ssh failing inside the sandbox is the intended
> behaviour — the sandbox should not carry credentials for reaching other
> systems. Users opt in explicitly with a `$HOME/.ssh` line in `.agentreadonly`,
> which already binds host directories read-only at the mirrored path.
>
> Of the options below, agent forwarding (option 1) was reconsidered and drafted
> in [allow-ssh-opt-in](./allow-ssh-opt-in.md), then superseded before
> implementation by [ssh-tunnel-opt-in](./ssh-tunnel-opt-in.md): forwarding
> `SSH_AUTH_SOCK` grants the agent use of *every* key it holds against *any*
> host that trusts one of them, which is more delegated authority than a
> remote-administration session needs. The tunnel design instead opens one
> pre-authenticated connection to an operator-named `user@host` outside the
> sandbox and multiplexes only that single destination in — no key material,
> no agent socket, and no ability for the sandboxed agent to choose where ssh
> connects.

**This is the item that determines whether the original ssh complaint is
actually fixed.** Correcting resolution only makes ssh look in the right place;
`~/.ssh` is not bound at all, so there is nothing there. `buildExtraBinds`
covers `.gitconfig`, `.m2`, cargo, rustup, mise, `.npmrc`, `.pypirc` and
`.config/gh` — not `.ssh`. Options, in increasing order of exposure:

1. **Forward the agent.** Add `SSH_AUTH_SOCK` to the env allowlist and bind the
   socket path. Gives git-over-ssh with **no private key inside the sandbox**.
   *Preferred.*
2. **Bind `known_hosts` and `config` read-only.** Fixes host verification and
   per-host settings without exposing keys.
3. **Bind all of `~/.ssh` read-only.** Simplest, and puts private keys inside a
   sandbox an agent controls. Needs an explicit decision, not a default.

Note ssh refuses key files whose owner differs from the effective uid. Because
the namespace maps inside-0 to the host user, host-owned files appear as uid 0
inside, so that check passes.

### 5. Confirm the presets tolerate uid 0

**The discriminator for the whole approach.** Some tooling refuses to run as
root or changes behaviour (npm, pnpm, yarn, assorted linters). Test `opencode`,
`claude`, `copilot` and `pi` under uid 0 *before* building anything. If a preset
misbehaves, attach mode becomes the better option again, because it is the only
one that avoids uid 0 entirely.

### 6. Fix the passwd temp file

`path.join(os.tmpdir(), \`bwrap_passwd_${uid}\`)` is a fixed, predictable path in
shared `/tmp`, and is never cleaned up. Two concurrent sessions for the same
user collide, and another user can pre-create it. Use a unique temp file and
clean it up on exit, matching the other snapshots.

## Consequences to Accept

- **Permission bits stop meaning anything inside the sandbox.** root bypasses
  DAC checks, so protection must remain *mount*-enforced. `infrastructure-
  protection` already uses `--ro-bind`, which holds against uid 0 — the
  `github-protected` and `gitignore-protected` tests have been passing under
  uid 0 all along, so this is already proven. It must not later be "simplified"
  to permission bits.
- **Apparent ownership is confusing.** Files the user owns display as `root`
  inside; files owned by other host users display as `nobody`. Host-side
  ownership is unaffected.
- **No additional host privilege.** Only one uid is mapped, so root inside the
  namespace confers nothing outside it.

## Documentation and Tests to Unwind

- Delete the `sandbox-uid-preserved` `test.failing` case — it asserts the
  opposite of this design, so it must be removed rather than inverted.
- Keep `sandbox-uid-maps-to-host-user`; it stays true and stays valuable.
- Add cases for `getent passwd 0`'s home field, `getpwuid` resolution, and
  `ssh -G` identityfile.
- Rewrite the resolution section of
  [sandbox-uid-becomes-root](../issues/sandbox-uid-becomes-root.md): option 3
  becomes the chosen route, option 1 becomes a rejected alternative.
- Mark [pasta-attach-mode](../../prototypes/pasta-attach-mode.md) as a rejected
  alternative, retaining it as evidence rather than deleting it.

## Comparison with Attach Mode

| | Accept root uid | pasta attach mode |
|---|---|---|
| Change size | passwd/group file plus a few binds | two-process orchestration |
| uid inside | 0 | host uid |
| Open risks | preset tolerance of root (item 5) | pasta teardown, `Bun.spawn` fd support, `--llm-port` |
| Status | analysed, core change verified | prototyped end to end |

Attach mode is proven to work; this is cheaper and less invasive. Item 5 is the
deciding question, and it is cheap to answer.

[IMPACTS](/src/sandbox/builder.ts)
[IMPACTS](/src/tools/presets.ts)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
[HAS_FEATURE](/design/features/host-tool-binding.md)
