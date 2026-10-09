---
target-version: 2.11.0
status: draft
tags: [plan, ide, jupyter, network, preset]
---

# JupyterLab Preset

> **Plan — not implemented.** Nothing here is measured yet; the open
> questions at the end are what the first implementation step answers.

## Summary

A `jupyterlab` preset, usable as the tool (`scoder jupyterlab`) or as a
companion (`scoder pi --ide jupyterlab`). Unlike the other IDE presets it is
not a GUI program: it is a **server**, and its UI is a browser page. The
server runs in the sandbox like everything else; the question this plan is
mostly about is **which browser** shows it, and how it reaches the server.

## How it differs from the other IDEs

| | vscode / webstorm / rstudio | jupyterlab |
|---|---|---|
| Process | a GUI window | a web server (`jupyter lab --no-browser`) |
| Display | xpra (or `--native-display`) | none needed in the default design |
| Singleton | one instance per config dir | none — servers coexist, each with its own port and runtime files |
| UI | the window | a browser at `http://127.0.0.1:<port>/lab?token=<token>` |

## Design

### 1. The browser: the host's, through one loopback-only forwarded port

Default: the user's **host browser** connects to the sandboxed server.

- scoder picks a free host port at start-up and generates a random token.
- It launches `jupyter lab --no-browser --ip=127.0.0.1 --port=<port>
  --IdentityProvider.token=<token>` inside the sandbox.
- pasta forwards that one port **host → sandbox, bound to the host's
  loopback only** (`-t 127.0.0.1/<port>`). Today scoder runs pasta with
  `--tcp-ports none`; this would be the first inbound port, and binding it
  to `127.0.0.1` is load-bearing — pasta's default binds all interfaces,
  which would put the server on the LAN.
- scoder prints the URL with the token at start-up and, optionally, opens
  it with the host's `xdg-open` (host side, outside the sandbox).

What this grants, stated plainly: the host browser renders pages the
sandboxed server serves. That is the same exposure as visiting any website
— the page runs under the browser's same-origin rules, on its own
`127.0.0.1:<port>` origin — not access to the host. The token keeps other
local users and pages off the server. The alternative is isolated but
worse to use:

### 1b. Alternative: a browser inside the sandbox, under xpra

`SCODER_JUPYTER_BROWSER=sandbox` (or similar): run a browser inside the
sandbox under xpra, like the GUI presets, pointed at the server; no inbound
port at all. Uses `SCODER_BROWSER` if set. Full isolation, at the cost of
xpra's usability and a second browser profile.

### 2. Finding JupyterLab: uv tool environments

`uv tool install jupyterlab` puts it in `~/.local/share/uv/tools/jupyterlab/`;
`~/.local/bin/jupyter-lab` is a script whose interpreter lives there. scoder
copies the script (local-bin resolution) but binds **nothing under
`~/.local/share/uv`** today, so it cannot run. Needed, and useful for every
uv-installed tool, not just this one:

- bind `~/.local/share/uv/tools/<tool>` read-only for the tool being run
  (or the whole `~/.local/share/uv/tools`);
- bind `~/.local/share/uv/python` read-only when the tool's venv uses a
  uv-managed interpreter (its `bin/python` symlinks there).

Plugins (`jupyter-ai`, `jupyter-mcp-server`, kernels) are installed on the
host with `uv tool install jupyterlab --with <pkg> --force`; the tool
environment is read-only inside, as extensions are for vscode. Confirmed on
the user's machine: `uv tool install jupyterlab --with jupyter-ai --force`
is what adds jupyter-ai — `uv pip install` targets a project venv, not the
tool's. **Done since this plan was written:** `~/.local/share/uv/tools` and
`~/.local/share/uv/python` are now bound read-only (fix/uv-tools), so
uv-installed tools run in the sandbox.

### 3. Configuration: read-only host config, per-project writable state

`~/.jupyter` holds **host-executed** configuration
(`jupyter_server_config.py` runs as Python whenever the user starts Jupyter
on the host), so it must not be writable from the sandbox — the same
reasoning as `~/.claude`'s hooks. Design:

- `~/.jupyter` bound **read-only** (the user's real config applies);
- JupyterLab's writable state redirected to a managed per-project dir,
  `~/.local/share/scoder-jupyterlab/<project>/`, via
  `JUPYTERLAB_SETTINGS_DIR` (user settings) and `JUPYTERLAB_WORKSPACES_DIR`
  (layouts), seeded once from the host's `~/.jupyter/lab/` — the vscode
  pattern, which also gives `--new-workspace`;
- runtime files under `$XDG_RUNTIME_DIR/jupyter` (private in the sandbox);
- kernelspecs: `~/.local/share/jupyter/kernels` read-only, so host-
  registered kernels (a project venv's ipykernel, IRkernel) appear.

### 4. Lifecycle

As `--ide`, the server is the background companion, the agent in front;
ENTER on the agent's exit asks it to stop. `ideShutdown`: TERM,
process-first (Jupyter shuts kernels down cleanly on SIGTERM) — to be
measured, as for the other IDEs. As the tool, it runs in the foreground and
Ctrl-C stops it.

### 5. MCP

Observed with Jupyter running **on the host**: jupyter-ai starts an MCP
server, logging `Starting MCP server 'Jupyter MCP Server' with transport
'http' on http://localhost:3001/mcp`. Adding `3001` to `.sandbox/ports`
lets a sandboxed agent use it today — but that server and its kernels run
on the host, so an agent executing cells through it runs arbitrary code on
the host, outside the sandbox. That is the strongest reason for this
preset: with Jupyter inside, the same server is on the sandbox's own
`localhost:3001` and its kernels are confined.

The agent and server share the sandbox, so an MCP server for notebooks
(`jupyter-mcp-server`, or jupyter-ai's) reaches the Jupyter server at
`127.0.0.1:<port>` with the token. scoder knows both, so the `--ide`
`AGENTS.md` note can include them, letting the agent write the MCP config
without asking. The per-setup details go in the skill's "Known working
setups", as for the other IDEs.

## Implementation steps

1. **uv tool environments** (section 2) — useful on its own; verify with a
   uv-installed tool already in use (e.g. `hf`).
2. pasta loopback-only inbound forward for one port; verify from the host
   that it is reachable on `127.0.0.1` and **not** on the LAN address.
3. `jupyterlab` preset: free port + token, launch args, config binds and
   env, start-up URL line, optional host `xdg-open`.
4. `ideShutdown` measured; `--new-workspace` via `managedWorkspaceDir`.
5. AGENTS.md note with URL/token under `--ide`; skill setup entry.
6. Optional in-sandbox browser mode (1b).
7. Docs and tests (dry-run: forward flag bound to 127.0.0.1, args, binds,
   env; unit: port/token generation).

## Open questions

1. Host browser by default (1) or sandboxed browser (1b)? This plan
   recommends (1), with (1b) as an option.
2. Open the host browser automatically, or only print the URL?
3. Bind all of `~/.local/share/uv/tools` or only the tool being run? The
   former is simpler and read-only; the latter is tighter.
4. Does `jupyter-ai` need anything beyond the read-only tool environment
   (a writable cache, model credentials via `.sandbox/env`)?
5. pasta's exact spelling for a loopback-bound inbound port, and whether
   it coexists with the live `.sandbox/ports` re-attach.

[HAS_FEATURE](/design/features/tool-presets.md)
[HAS_FEATURE](/design/features/network-isolation.md)
[HAS_FEATURE](/design/features/ide-companion.md)
