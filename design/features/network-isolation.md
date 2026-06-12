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
- LLM port forwarding: `--llm-port=<port>` injects `--tcp-ns <port>` to
  allow a single localhost port (e.g., Ollama on 11434)
- **Auto-detection**: when `--llm-port` is not specified, scoder checks
  if port 11434 is open on localhost at startup. If something responds
  (e.g. Ollama, Open WebUI), that port is auto-enabled. Override the
  default port with `SCODER_LLM_PORT`.

[HAS_FEATURE](./sandbox-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
