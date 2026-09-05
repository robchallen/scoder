---
target-version: 2.4.0
status: complete
tags: [plan, sandbox, network, pasta, filesystem]
---

# `.agentports`: Persistent Host-Loopback Port Access, Live-Reloaded

> **Implemented**, with two deviations from the design below, both discovered
> during implementation:
>
> - **Sequential swap, not attach-before-detach.** The "not verified" question
>   of whether two pasta processes can attach to one netns simultaneously was
>   never resolved (no working `/dev/net/tun` in the implementation
>   environment to test it). Since the user's own guidance was "prefer the
>   simple approach unless the gap is multi-second," and the measured
>   attach/detach overhead pointed well under a second, the implementation
>   takes the option that doesn't depend on the unverified answer: stop the
>   old sidecar, then attach the new one. On a failed new attach, it falls
>   back to re-attaching the last known-good port list rather than leaving
>   the sandbox with no networking — a real second gap on the failure path,
>   not the common one. See `startAgentPortsWatcher` in `src/sandbox/launch.ts`.
> - **`readAgentPorts` throws, it does not call `process.exit`.** The design
>   below described a hard error (exit 1) on a malformed line, which is
>   correct at startup — but the same function is also called on every tick
>   of the live-reload watcher, mid-session, long after the sandbox is up.
>   `process.exit()` from inside that background poll loop would kill the
>   whole scoder process without ever reaching `launchSandbox`'s `finally`
>   block — no `stopPasta`, no bwrap teardown, exactly the class of leak the
>   `bwrap-orphaned-on-pasta-attach-failure` fix exists to prevent. Fixed
>   during implementation, before it shipped: `readAgentPorts` throws; the
>   startup caller in `index.ts` catches and exits (preserving the original
>   behaviour), and the watcher catches and warns, keeping the last-known-
>   good config running instead.

## Goal

A project that needs the sandbox to reach a locally hosted service outside
it — an MCP server on a fixed port, a local API like Zotero's, an
Ollama-style LLM endpoint — should be able to say so once, have it persist
across every future session without anyone needing to remember a port
number, and be editable from outside the sandbox with the change taking
effect in a running session, not just the next one.

A `.agentports` file at the project root is the entire mechanism, following
`.agentreadonly` and the `scratch` symlink's existing convention: a file's
presence and content *is* the configuration, no flag. It replaces
`--llm-port`.

## Removing `--llm-port`

Not a deprecation — a removal. Its original framing ("allow localhost TCP
access... for LLM communication") no longer describes what this is used for:
the same mechanism now serves MCP servers, local research-tool APIs, and
whatever else needs a locally hosted port, not just LLM endpoints. Keeping
it around as a second, CLI-flag-based way to configure the same thing this
file now owns creates a genuine ambiguity — if `--llm-port 8080` is passed,
should the port persist into `.agentports` for future sessions, or was it
meant as a one-off? Neither answer is clearly right, and the file removes
the question rather than resolving it awkwardly. Since this is
pre-deployment alpha, the cost of removing it now is low; it will not be
after a real release.

`detectDefaultLlmPort()` and `SCODER_LLM_PORT` are **not** part of this
removal — they remain, narrowly, as the auto-detection probe (see Decision 3).
That mechanism is genuinely LLM-specific (looking for an OpenAI-compatible
API on a well-known port); what's being removed is the general-purpose,
manually-specified port list, which was never LLM-specific in practice.

## Design Decisions

### 1. File format: one port per line, strict validation

Blank lines and lines starting with `#` are skipped, matching
`.agentreadonly`'s existing convention. Every other line must be a single
integer in `1-65535` — unlike `.agentreadonly`'s permissive pattern parsing,
a malformed line is a **hard error** (exit 1, naming the bad line), not a
silent skip. This is host-loopback network exposure, not a workspace
protection list; a config file that could silently mean less than it looks
like is the wrong failure mode here.

```
# .agentports — ports forwarded from host loopback into the sandbox
11434   # ollama, auto-detected
23119   # zotero local api
```

(Trailing `#` comments on a port line are fine — parsed as a comment,
consistent with how the port itself is just the leading token.)

### 2. Always read-only inside the sandbox, unconditionally

Same treatment `.agentreadonly` gives itself: `.agentports` is bind-mounted
`ro-bind` into the sandbox regardless of whether anything else lists it,
not routed through the `.agentreadonly` protected-paths mechanism. The
agent can see what's configured; only the host side can change it.

### 3. Auto-detection seeds the file, additively, once

`detectDefaultLlmPort()` keeps probing `127.0.0.1:11434` (or
`SCODER_LLM_PORT`) at startup. On a hit, if that port is not already listed
in `.agentports`, append it — creating the file if it doesn't exist yet.
Never remove or reorder existing entries. This is the same shape of thing
`setupProtection` already does for a missing `.agentreadonly` (writing a
default), just additive to an existing file rather than only bootstrapping
an absent one.

The probe still runs every session — cheap, and it's what lets a first
Ollama-having developer's session write the entry that then persists for
every teammate's session and CI without them ever running the probe
themselves (assuming the file is committed — same tracked-vs-gitignored
choice the `scratch` symlink already offers, and the same recommendation:
track it).

### 4. Live reload while the session is running

`launchSandbox` gains a polling loop, started once the sandbox is released
and running alongside `await proc.exited`, stopped when the tool exits. On
each tick, re-read and re-parse `.agentports`; if the resulting port list
differs from the one currently forwarded, swap pasta:

1. Attempt to attach a *new* pasta sidecar, with the updated port list, to
   the same still-running netns (`childPid` doesn't change — the namespace
   belongs to bwrap, not pasta, exactly what makes this possible at all, per
   [ADR 0001](/architecture/decision-records/0001-sandbox-uid-and-networking-composition.md)).
2. If it attaches successfully, stop the *old* sidecar and adopt the new one.
3. If it fails to attach, leave the old sidecar exactly as it was and warn
   loudly — a bad edit to `.agentports` degrades to "the change didn't take,
   try again," never to "the sandbox silently lost networking."

Polling, not `fs.watch`/inotify: simpler, and sidesteps a real class of bugs
inotify has with atomic-save editors (write-to-temp-then-rename changes the
inode, which can silently stop a naive single-file watch). A few seconds of
reload latency is a fine trade for that — nothing here needs sub-second
responsiveness.

## Verified Groundwork

| Claim | Result |
|---|---|
| pasta's lifetime is independent of bwrap's; the netns outlives it | **Yes** — established firmly this session, both via ADR 0001's own reasoning and via the `bwrap-orphaned-on-pasta-attach-failure` bug: pasta and bwrap are separate processes, and `stopPasta`'s explicit teardown exists precisely because nothing else reaps pasta. |
| pasta has a runtime reconfiguration interface (signal, control socket) that could avoid a full stop/restart | **No** — confirmed already in ADR 0001: "pasta has no runtime reconfiguration interface... this would mean terminating pasta and attaching a fresh one." |
| pasta's own `--help` exposes any destination-address or CIDR-based filtering, for scope | Checked directly (this session): no. Its address-scoped options (`-t ADDR/PORT`, `--map-host-loopback`, `--map-guest-addr`) are about which host address a forward binds to, not applicable here. Irrelevant to this design, recorded because it was checked while discussing pasta's limits. |

### Not Verified

- **Can two pasta processes be attached to the same netns simultaneously?**
  This determines whether step 1/2 above can be zero-gap (attach new,
  *then* stop old) or must be gap-incurring (stop old, then attach new, with
  the fallback in step 3 covering only "new never came up," not "there was a
  window with neither running"). Both pasta instances would be trying to
  configure the same tap interface, DHCP/NDP responders, etc. — plausibly
  conflicting, plausibly fine since only one would "win" the tap fd. Needs a
  direct test before the exact swap sequence is finalized, the same way
  every other pasta/bwrap interaction in this codebase has been settled by
  testing rather than assumption.
- Poll interval vs. reload-latency trade-off — no data yet on what interval
  feels responsive without being wasteful. Likely needs to be short enough
  for tests to observe without an unreasonable wait, possibly via an
  internal override (same shape as `SCODER_LLM_PORT` overriding the probe
  target) rather than a fixed constant.

## Changes Required

### `src/types.ts`

```typescript
export interface ScoderOptions {
	// llmPorts removed
	openPorts: number[];
}
```

Renamed, not just repurposed — `llmPorts` described a CLI-flag-populated,
LLM-framed list; `openPorts` is a general "these host-loopback ports are
forwarded" list seeded from `.agentports` plus whatever the LLM probe just
added. The rename is the honest description of what changed.

### `src/cli/parse-args.ts`

- Remove the `--llm-port`/`--llm-port=` parsing branches and their `USAGE`
  entry entirely.
- `options.openPorts` starts empty; populated by the new `readAgentPorts`
  step in `index.ts`, not by CLI parsing.

### `src/git/protection.ts` (or a new small module — see Interactions)

```typescript
// Reads and validates .agentports. Missing file -> []. A malformed line is
// a hard error (exit 1), not a silent skip — see Design Decision 1.
export async function readAgentPorts(projectRoot: string): Promise<number[]>;

// Appends `port` if not already present, creating the file if missing.
// Never reorders or removes existing entries.
export async function appendAgentPort(projectRoot: string, port: number): Promise<void>;

// The read-only self-bind, unconditional, same treatment as .agentreadonly.
export function getAgentPortsBind(projectRoot: string, sandboxProjDir: string): BindMount | null;
```

### `src/index.ts`

```typescript
options.openPorts = await readAgentPorts(projectRoot);

if (!options.openPorts.includes(/* SCODER_LLM_PORT or 11434 */)) {
	const detectedPort = await detectDefaultLlmPort();
	if (detectedPort && !options.openPorts.includes(detectedPort)) {
		await appendAgentPort(projectRoot, detectedPort);
		options.openPorts.push(detectedPort);
	}
}
```

Plus the `getAgentPortsBind` result pushed into `protectionConfig.safeBinds`,
alongside the other project-root marker files (same place `scratch` and
`.agentreadonly` itself get wired in).

### `src/sandbox/pasta.ts`

`buildPastaArgs` reads `options.openPorts` where it previously read
`options.llmPorts` — otherwise unchanged, since the actual `--tcp-ns`/
`--udp-ns` construction was never LLM-specific to begin with.

### `src/sandbox/launch.ts`

The new polling loop, and the swap-with-fallback sequence from Design
Decision 4. Needs `projectRoot` threaded in (currently `launchSandbox`
doesn't need to know it — this is the first thing that changes that).

### `src/utils/checks.ts`

`detectDefaultLlmPort` unchanged in behaviour; its caller changes (`index.ts`
now decides whether to append the result, rather than assigning it directly
to an options field).

## Interactions to Resolve

1. **Where does `readAgentPorts`/`appendAgentPort`/`getAgentPortsBind` live?**
   `protection.ts` already owns the equivalent `.agentreadonly` and
   `scratch` logic, and reuses its `fileExists`/line-parsing helpers — the
   natural home unless it grows enough to warrant its own file, the same
   judgment call `ssh.ts` resolved the other way for `--allow-ssh`.
2. **Worktree mode and a freshly created worktree not having `.agentports`
   yet**, if it's gitignored rather than tracked — the exact same shape of
   issue the `scratch` symlink design already resolved, and the same
   resolution applies: track it, and a fresh `git worktree add` checkout
   carries it automatically. No new mechanism needed, just the same
   recommendation repeated in this file's own README section.
3. **Interaction with `--dry-run`.** The auto-detect-and-append side effect
   (writing to `.agentports`) should not happen under `--dry-run`, matching
   how `--allow-ssh` avoids opening a real connection under `--dry-run` —
   dry-run must stay side-effect free. Read the existing file for display,
   but skip the probe-and-append step.
4. **What happens to a port that's removed from `.agentports` while a
   session is running?** Symmetric with adding one — the next poll tick
   picks up the shorter list and reattaches pasta without it. Same
   swap-with-fallback mechanics either direction.

## Test Plan

- `agentports-forwards-listed-port`: a port listed in `.agentports` is
  reachable inside the sandbox without any CLI flag.
- `agentports-malformed-line-fails`: a non-numeric or out-of-range line
  exits 1 naming the bad line.
- `agentports-is-readonly`: `--dry-run` shows `--ro-bind` for `.agentports`,
  not `--bind`.
- `agentports-auto-detect-appends`: with a mock LLM-style server on the
  probed port and no pre-existing `.agentports`, a session creates the file
  containing that port; a second session with the file already present and
  the port still listed does not duplicate the entry.
- `agentports-auto-detect-skips-under-dry-run`: `--dry-run` with a
  detectable port does not write `.agentports`.
- `agentports-live-reload-adds-port`: start a session, append a port to
  `.agentports` mid-session, confirm it becomes reachable without
  restarting — the real end-to-end proof, and the one that needs the poll
  interval short enough to observe in a test within a reasonable timeout.
- `agentports-live-reload-bad-edit-keeps-old-config`: mid-session, edit
  `.agentports` in a way that makes the new pasta attach fail (mirroring the
  fake-`pasta`-on-`PATH` technique from `bwrap-not-orphaned-on-pasta-attach-failure`),
  confirm the previously-working port is still reachable afterward — guards
  Design Decision 4's fallback specifically, not just the happy path.
- `llm-port-flag-removed`: `--llm-port` is now an unknown option, exits 1
  with the standard "unknown option" error — guards against the removal
  quietly regressing back to a silently-accepted no-op flag.

## Documentation to Update

(At implementation time.)

- `design/features/network-isolation.md`: replace the `--llm-port`
  description with `.agentports` and the auto-detect-appends behaviour.
- New `design/features/agentports.md` (or fold into `network-isolation.md`
  directly, since it's the same feature area — a judgment call for
  implementation time, not fixed here).
- `README.md`: remove `--llm-port` from Options; add a `.agentports` section
  alongside the existing `.agentreadonly` and `scratch` ones.
- `design/test-scripts/validation-suite.md`: the new cases, and the removal
  of any `--llm-port`-specific ones that no longer apply.
- `architecture/FRAMEWORK.md`: module map, if a new file is warranted (see
  Interactions item 1).

[IMPACTS](/src/types.ts)
[IMPACTS](/src/cli/parse-args.ts)
[IMPACTS](/src/git/protection.ts)
[IMPACTS](/src/index.ts)
[IMPACTS](/src/sandbox/pasta.ts)
[IMPACTS](/src/sandbox/launch.ts)
[IMPACTS](/src/utils/checks.ts)
[HAS_FEATURE](/design/features/network-isolation.md)
[HAS_FEATURE](/design/features/infrastructure-protection.md)
