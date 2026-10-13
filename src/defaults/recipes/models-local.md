# Locally hosted models

## When to use

The user runs a model server on the host — Ollama, llama.cpp, LM Studio.

## Env

The agent's base-URL variable pointing at it, if the user wants it set
explicitly (e.g. `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`).

## Ports

Usually nothing to add: scoder auto-detects a server on `11434` (any
listener) and on `11435` (one answering an OpenAI-style `/v1/models`) and
adds the port itself. Add other ports explicitly.

## Read-only binds

None.

## Read-write binds

None.

## MCP servers

None.
