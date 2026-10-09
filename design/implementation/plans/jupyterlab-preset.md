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
mostly about is **which browser** shows it. Decided: **a browser inside the
sandbox**, under xpra like the other GUI presets — there is no host-browser
mode and no inbound port.

## How it differs from the other IDEs

| | vscode / webstorm / rstudio | jupyterlab |
|---|---|---|
| Process | a GUI window | a web server (`jupyter lab --no-browser`) |
| Display | xpra (or `--native-display`) | xpra (or `--native-display`), for the browser |
| Singleton | one instance per config dir | none — servers coexist, each with its own port and runtime files |
| UI | the window | a browser inside the sandbox at `http://127.0.0.1:8888/lab?token=<token>` |

## Design

### 1. The browser: inside the sandbox, started by Jupyter

The server and the browser both run in the sandbox. Jupyter is the preset's
program — the one xpra wraps (`gui: true`) — and it starts the browser
itself once it is ready to serve, through its own setting:

```
jupyter lab --ip=127.0.0.1 --port=8888 \
    --IdentityProvider.token=<token> \
    --ServerApp.browser='/tmp/scoder-browser %s'
```

`/tmp/scoder-browser` is the `SCODER_BROWSER` wrapper that already exists
(src/sandbox/browser.ts): the same command and flags the user chose for
opening links — e.g. `google-chrome --incognito --no-first-run
--no-default-browser-check --disable-component-update`, with `--app=` worth
considering for a window without browser chrome. If `SCODER_BROWSER` is
unset, the preset fails up front with a named error rather than guessing a
browser (or falls back to the first of a short known list — open question).

**Why not the host's browser.** Considered and rejected
(2026-10-09). Forwarding one loopback-only port is not itself the problem;
handing the sandbox a page in the user's everyday browser is:

- cookies are not separated by port, so a page on `localhost:8888` shares
  `localhost` cookies with every other local web app — including a host
  Jupyter's login cookie, which is code execution on the host;
- the page can send requests from the browser to other host `localhost`
  services, which scoder otherwise keeps out of reach (cross-origin rules
  stop most responses being read, not the requests; services that allow
  local origins, as Ollama does by default, can be read in full);
- plus the ordinary hazards of an untrusted page: downloads into the real
  Downloads folder, look-alike prompts, browser bugs.

A browser inside the sandbox has none of these: its `localhost` is the
sandbox's, pasta keeps the host's loopback out of reach, its profile is
thrown away with the session, and downloads land in the sandbox. The cost
is xpra's usual usability and a fresh profile each session — the same
trade the IDE presets already make.

**Ports.** The sandbox has its own network namespace, so Jupyter can use
fixed ports — `8888` for the server, `3001` for jupyter-ai's MCP server —
with no collision with the host or with another session. Nothing is
forwarded in either direction. The token is random per session: inside the
sandbox it guards little (the agent there may read it, and is meant to use
it for MCP), but it keeps Jupyter's normal auth on.

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

As `--ide`, Jupyter (and the browser it started) is the background
companion under xpra, the agent in front; ENTER on the agent's exit asks it
to stop. Closing the browser window does not stop the server — Jupyter is
xpra's child, not the browser — which is right while a kernel is running,
and is what `File → Shut Down` is for. `ideShutdown`: TERM,
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

The agent and server share the sandbox, so jupyter-ai's MCP server is at
`http://localhost:3001/mcp` and the Jupyter server at `127.0.0.1:8888`
with the token. scoder knows both, so the `--ide`
`AGENTS.md` note can include them, letting the agent write the MCP config
without asking. The per-setup details go in the skill's "Known working
setups", as for the other IDEs.

## Implementation steps

1. ~~**uv tool environments**~~ — done (fix/uv-tools).
2. **Spike, by hand:** inside a session with `SCODER_BROWSER` set, run the
   `jupyter lab ... --ServerApp.browser=...` line above under xpra (e.g. as
   `scoder` running it as the tool once the preset is `gui: true`, or with
   `--native-display` for a first look); confirm the browser opens on the
   lab URL and the MCP server logs on 3001.
3. `jupyterlab` preset: `gui: true`, token generation, launch args, config
   binds (`~/.jupyter` ro, managed settings/workspaces dirs, kernelspecs
   ro), env, and a named error when `SCODER_BROWSER` is unset.
4. `ideShutdown` measured; `--new-workspace` via `managedWorkspaceDir`.
5. AGENTS.md note under `--ide` naming the server URL and token, and the
   MCP endpoint; skill "Known working setups" entry.
6. Docs and tests (dry-run: launch args, binds, env, no inbound forward;
   unit: token generation).

## Open questions

1. With `SCODER_BROWSER` unset: refuse with a named error, or fall back to
   the first of a short known list (`chromium`, `google-chrome`, `firefox`)
   found on the host?
2. `--app=<url>` (a bare window) as a recommended addition to the user's
   browser flags for this preset, or left to them?
3. Bind all of `~/.local/share/uv/tools` or only the tool being run? (Done
   as all, read-only, in fix/uv-tools; revisit only if it matters.)
4. Does `jupyter-ai` need anything beyond the read-only tool environment
   (a writable cache, model credentials via `.sandbox/env`)?
5. Does the browser's GPU path need anything beyond what the IDE presets
   already bind (`/dev/dri`)?

[HAS_FEATURE](/design/features/tool-presets.md)
[HAS_FEATURE](/design/features/network-isolation.md)
[HAS_FEATURE](/design/features/ide-companion.md)
