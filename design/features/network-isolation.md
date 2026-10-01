---
target-version: 2.1.0
status: draft
tags: [feature, network, pasta]
---

# Network Isolation

## Summary

`pasta` provides unprivileged outbound networking in a nested namespace,
preventing the sandboxed tool from reaching host loopback services
(127.0.0.1, ::1) while preserving outbound API access.

## Motivation

AI tools need internet access for completions and API calls, but should not
reach locally hosted services (databases, dev servers, MCP servers on
localhost) unless explicitly allowed.

## Implementation

[IMPLEMENTED_BY](/src/sandbox/builder.ts#buildBwrapCommand)
[IMPLEMENTED_BY](/src/sandbox/pasta.ts#attachPasta)
[IMPLEMENTED_BY](/src/git/protection.ts#refreshResolvConfSnapshot)
[IMPLEMENTED_BY](/src/sandbox/launch.ts#startResolvConfWatcher)

- pasta runs with `--tcp-ns none --udp-ns none` by default (no localhost forwarding)
- **IPv4-only retry**: `--config-net`'s own dual-stack auto-detection
  refuses to attach at all on a host with IPv6 unavailable — reported
  directly as `pasta failed to attach to the sandbox: No routable
  interface for IPv6: IPv6 is disabled` / `Couldn't switch to pasta
  namespaces: ...`, treating IPv6 being unavailable as fatal rather
  than something to skip gracefully, unlike a merely-unconfigured or
  unrouted IPv6 address on an otherwise dual-stack-capable host.
  `isIpv6RoutabilityFailure` (`src/sandbox/pasta.ts`) detects this exact
  failure from pasta's own stderr, and `attachPasta` retries once with
  `--ipv4-only`. Deliberately reactive, not predictive: an earlier
  version tried predicting the failure ahead of time by reading
  `net.ipv6.conf.all.disable_ipv6` directly, but that missed a real,
  reported case — IPv6 disabled via the `ipv6.disable=1` kernel boot
  parameter rather than the per-sysctl toggle, under which
  `/proc/sys/net/ipv6` doesn't exist at all, so the sysctl read
  silently (and wrongly) reported "not disabled". Trusting pasta's own
  authoritative determination, after a real attempt fails, covers every
  route to this failure without needing to enumerate them — and never
  disables IPv6 on a host where it actually works, since the retry only
  fires after a genuine failure blaming IPv6 specifically. `--dry-run`
  never shows the retry's `--ipv4-only`, only the first-attempt args —
  the retry only happens after a real attach genuinely fails, which
  `--dry-run` never does.
- **DNS**: snapshots `/etc/resolv.conf`, preferring
  `/run/systemd/resolve/resolv.conf` when the host uses 127.0.0.53
  (systemd-resolved) — `resolveResolvConfSource` in
  `src/git/protection.ts`. **Live-refreshed**, like `.sandbox/ports`: a
  background poll (`SCODER_RESOLVCONF_POLL_MS`, default 2000, its own
  separate knob from `.sandbox/ports`' polling cadence — the two watch
  unrelated things) re-reads the real host config and rewrites the
  sandbox's snapshot file in place if it changed
  (`refreshResolvConfSnapshot`). Fixes a real, reported gap: a
  power-state event (suspend/resume) that changes the host's own DNS
  server used to leave the one-time snapshot pointing at a
  now-unreachable server for the rest of the session, unrecoverable
  short of a full restart — confirmed directly that pasta's own routing
  stayed healthy throughout (a raw-IP `curl` worked), isolating the
  problem to this snapshot specifically. Much simpler than
  `.sandbox/ports`' own live reload: no pasta/bwrap involvement at all,
  since `/etc/resolv.conf` inside the sandbox is a `--ro-bind` of this
  exact host file, not a copy detached from it — overwriting the file's
  content on the host is visible inside the sandbox immediately, with
  nothing to swap, restart, or fail over to.
- **`.sandbox/ports`**: a project-root file, one port per line (`#` comments
  allowed), listing host-loopback ports forwarded into the sandbox — an MCP
  server, a locally hosted research-tool API (Zotero, say), or an LLM
  endpoint. Always bind-mounted read-only into the sandbox, like
  `.sandbox/readonly` — created first (a single header comment) if missing,
  since a missing source path gets no bind mount at all, which would
  otherwise leave the path part of the regular read-write project bind and
  let the sandboxed agent create it itself, unprotected. Skipped under
  `--dry-run`. A malformed line throws with a clear message (not a
  silent skip — this is network exposure, not a protection list).
- **Auto-detection**: scoder checks if port 11434 is open on localhost at
  startup (override the probed port with `SCODER_LLM_PORT`). If something
  responds (e.g. Ollama, Open WebUI), that port is appended to
  `.sandbox/ports` — additively, and only once — so it persists for every
  future session without anyone needing to remember the number. Skipped
  entirely under `--dry-run`, which stays side-effect free.
- **Live reload**: `.sandbox/ports` is re-read on a poll interval
  (`SCODER_AGENTPORTS_POLL_MS`, default 2000) for the life of the session.
  Editing it from outside the sandbox reattaches pasta with the new port
  list, without restarting the session — the network namespace belongs to
  bwrap, not pasta, so pasta can be stopped and a fresh one attached to the
  same still-running namespace (see
  [ADR 0001](/architecture/decision-records/0001-sandbox-uid-and-networking-composition.md)).
  A failed reattach falls back to the last known-good port list rather than
  leaving the sandbox with no networking.
- There is no `--llm-port` flag — `.sandbox/ports` replaced it entirely (see
  [design/implementation/plans/agentports.md](/design/implementation/plans/agentports.md)
  for why: the flag's original framing no longer matched what it was
  actually used for, and keeping both created a real ambiguity about
  whether a flag-provided port should persist).

[HAS_FEATURE](./sandbox-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
