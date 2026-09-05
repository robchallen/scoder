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

- pasta runs with `--tcp-ns none --udp-ns none` by default (no localhost forwarding)
- DNS: snapshots `/etc/resolv.conf`, preferring `/run/systemd/resolve/resolv.conf` when the host uses 127.0.0.53 (systemd-resolved)
- **`.agentports`**: a project-root file, one port per line (`#` comments
  allowed), listing host-loopback ports forwarded into the sandbox — an MCP
  server, a locally hosted research-tool API (Zotero, say), or an LLM
  endpoint. Always bind-mounted read-only into the sandbox, like
  `.agentreadonly`. A malformed line throws with a clear message (not a
  silent skip — this is network exposure, not a protection list).
- **Auto-detection**: scoder checks if port 11434 is open on localhost at
  startup (override the probed port with `SCODER_LLM_PORT`). If something
  responds (e.g. Ollama, Open WebUI), that port is appended to
  `.agentports` — additively, and only once — so it persists for every
  future session without anyone needing to remember the number. Skipped
  entirely under `--dry-run`, which stays side-effect free.
- **Live reload**: `.agentports` is re-read on a poll interval
  (`SCODER_AGENTPORTS_POLL_MS`, default 2000) for the life of the session.
  Editing it from outside the sandbox reattaches pasta with the new port
  list, without restarting the session — the network namespace belongs to
  bwrap, not pasta, so pasta can be stopped and a fresh one attached to the
  same still-running namespace (see
  [ADR 0001](/architecture/decision-records/0001-sandbox-uid-and-networking-composition.md)).
  A failed reattach falls back to the last known-good port list rather than
  leaving the sandbox with no networking.
- There is no `--llm-port` flag — `.agentports` replaced it entirely (see
  [design/implementation/plans/agentports.md](/design/implementation/plans/agentports.md)
  for why: the flag's original framing no longer matched what it was
  actually used for, and keeping both created a real ambiguity about
  whether a flag-provided port should persist).

[HAS_FEATURE](./sandbox-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
