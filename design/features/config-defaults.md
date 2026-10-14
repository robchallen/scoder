---
target-version: 2.7.0
status: implemented
tags: [feature, config, sandbox, environment]
---

# Configuration Defaults and Environment Passthrough

## Summary

Every sandbox gets two layers of grants, read file by file (`env`,
`readonly`, `readwrite`, `ports`, `skills`):

- **Baseline** — `~/.config/scoder/sandbox/` (under `$XDG_CONFIG_HOME` when
  set): the user's grants for every sandbox on the machine, seeded from
  `src/defaults/sandbox/`. Non-negotiable: a project cannot remove from it.
- **Project** — `<project>/.sandbox/`: additions for that project, written
  by a [configure session](./configure-mode.md) or by hand.

`~/.config/scoder/recipes/` holds the markdown recipes the configure skill
works from. `env` lists the host environment variables passed into the
sandbox, replacing the list that used to be hardcoded in
`src/sandbox/builder.ts`.

## Motivation

Every project used to start from defaults written as literals in the code:
the protected-path list in `protection.ts`, the header comments for
`readwrite` and `ports`, the `.sandbox/README.md` text, and the env
passthrough list in `builder.ts`. Changing any of them, for every project,
meant a scoder release; adding a provider's API key to the passthrough list
was the commonest case. A user's own defaults directory makes those
choices theirs, and makes the shipped files the single source for what
scoder does out of the box.

## Implementation

[IMPLEMENTED_BY](/src/git/sandbox-config.ts)

1. **Shipped baseline** — `src/defaults/sandbox/` (`env`, `readonly`,
   `readwrite`, `ports`, `skills`), embedded in the binary with Bun's
   `with { type: "text" }` imports, and written into
   `~/.config/scoder/sandbox/` by file name when missing (`seedBaseline`);
   the user's edits are kept. Not under `--dry-run`, which uses the
   shipped files when the user's are absent.
2. **Recipes** — `src/defaults/recipes/*.md`, written into
   `~/.config/scoder/recipes/` the same way (`seedRecipes`).
3. **Project** — nothing is written into `.sandbox/` by a session.

Every reader goes through `readConfigText`, which returns the baseline
file (or the shipped one if the user's is missing) followed by the
project's, duplicate lines dropped. All the formats are line lists, so
this is a union: the project adds, and a project entry can never cancel a
baseline one. A baseline `readonly` `$HOME/...` entry and a project
`readwrite` one for the same path is the same "listed in both" error as
within a project. The baseline is read once at start-up.

A `readonly` `$HOME/...` grant whose target does not exist yet (a
`~/.Rprofile` not yet written) is kept and skipped with a message, and
bound from the first session after it appears.

### `.sandbox/env`

One variable name per line, `#` comments allowed. Each listed name that is
set on the host is passed in with `--setenv`; nothing else is. A line that
is not a valid name is warned about and skipped rather than fatal: a name
list cannot expose more than it says, so a typo only ever passes less
through. Like the rest of `.sandbox/` it is read-only inside the sandbox,
so an agent cannot widen its own environment. `--dry-run` still redacts
any value whose name looks secret.

The shipped default lists the shell/editor variables and `GH_TOKEN` /
`GITHUB_TOKEN`, and comments out the provider API keys the old hardcoded
list passed unconditionally — a behaviour change: a key is now passed only
when a project's `env` (or the user's default, for new projects) lists it.

### Wildcards in `.sandbox/env`

A `*` in a line makes it a pattern (`PI_*`, `*_API_KEY`), expanded against
the host environment when the sandbox command is built
(`expandEnvNames`). A pattern only adds names, and never matches the
excluded set — `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `OLDPWD`,
`DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`,
`XDG_RUNTIME_DIR`, `SSH_AUTH_SOCK`, and anything starting `LD_` or
`SCODER_` — nor a variable scoder has already set in the command; naming
one exactly still passes it. A line of only `*` is refused with a warning:
it would pass the whole environment and undo the file's purpose. Start-up
reports each pattern's matches by name.

### `--env NAME=VALUE`

A one-off value for one session, nothing written. Parsed before the tool
name only, like `--allow-ssh`: after it, `--env` is commonly the tool's
own flag. The value is everything after the first `=`. The `--setenv`
pairs are pushed after the `.sandbox/env` passthrough, so bwrap's
last-wins rule makes them override it, a preset's values and scoder's
fixed ones; overriding a variable scoder sets itself is warned about. The
entry point's interface variables (`HARNESS_ARGC`, `IDE_ARGC`, ...) are
pushed after `--env`, so a typed value cannot break a companion-IDE
launch.

A repository that commits its own `.sandbox/env` chooses which host
variables its sessions see, the same trust a committed
`.sandbox/readwrite` already carries.

## Tests

`env-file-controls-passthrough`, `user-config-seeds-starter-recipes`, `baseline-applies-to-every-project`,
`user-config-dry-run-writes-nothing-but-previews-it` — see
[validation-suite](../test-scripts/validation-suite.md) cases 137-139. The
test file points `XDG_CONFIG_HOME` at a directory under its own temp root
and passes `process.env` explicitly to every scoder it spawns: Bun's spawn
default is the environment captured at process start, so without that a
test run would create and read the developer's real `~/.config/scoder`.

[HAS_FEATURE](./infrastructure-protection.md)
[HAS_FEATURE](./agent-readwrite.md)
[HAS_FEATURE](./network-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
