# Python

## When to use

The project has `pyproject.toml`, `uv.lock`, `requirements*.txt`,
`setup.py` or `.py` files.

## Env

`UV_*` or `PIP_*` settings only if the user relies on them.

## Ports

None (a Jupyter server inside the sandbox needs none — use `--ide
jupyterlab`).

## Read-only binds

Lockfile (`uv.lock`, `poetry.lock`) as a project-relative line. uv's
managed interpreters and the uv tools the project uses:

```
$HOME/.local/share/uv/python
$HOME/.local/share/uv/tools
```

and the `~/.local/bin` entries for those tools (`$HOME/.local/bin/<tool>`).
`$HOME/.pypirc` only if the project publishes packages.

## Read-write binds

uv's cache, if installs are slow without it:

```
$HOME/.cache/uv
```

## MCP servers

With `--ide jupyterlab`: jupyter-ai's MCP server — the session's
`AGENTS.md` note gives the URL and token.
