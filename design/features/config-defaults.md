---
target-version: 2.7.0
status: implemented
tags: [feature, config, sandbox, environment]
---

# Configuration Defaults and Environment Passthrough

## Summary

scoder's per-project configuration in `.sandbox/` is seeded from the user's
own defaults in `~/.config/scoder/` (or `$XDG_CONFIG_HOME/scoder/`), which
are in turn seeded from the defaults shipped in the binary
(`src/defaults/`). A fourth file, `.sandbox/env`, lists the host environment
variables passed into the sandbox, replacing the list that used to be
hardcoded in `src/sandbox/builder.ts`.

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

Three levels, each filled only where the next one down is missing a file —
nothing is ever overwritten:

1. **Shipped defaults** — `src/defaults/` (`README.md`, `env`, `readonly`,
   `readwrite`, `ports`), embedded in the binary with Bun's
   `with { type: "text" }` imports (the same mechanism as `entrypoint.sh`;
   verified to survive `bun build --compile`).
2. **User defaults** — `~/.config/scoder/`. On every run, any shipped
   default missing there is written. A user's edit is kept; a deleted file
   comes back as the shipped default (an empty or all-comment file is how
   to opt out of one).
3. **Project** — `<project>/.sandbox/`. `prepareConfigDir` copies every
   regular file in `~/.config/scoder/` that the project lacks, after the
   legacy-dotfile migration, so a migrated `.agentreadonly` is not shadowed
   by a fresh default. From then on the project's copy is the one in
   force: editing `~/.config/scoder/` changes what *new* projects start
   with, not existing ones.

`readonly`, `readwrite` and `ports` are read from `.sandbox/` exactly as
before. Every reader goes through `readConfigText`, whose fallbacks —
`~/.config/scoder/`, then the shipped default — exist for `--dry-run`,
which writes nothing at either level yet previews what a real run would
apply. The old in-code defaults (`DEFAULT_PROTECTED`, the readwrite and
ports header strings, the README literal) are gone.

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

A repository that commits its own `.sandbox/env` chooses which host
variables its sessions see, the same trust a committed
`.sandbox/readwrite` already carries.

## Tests

`env-file-controls-passthrough`, `user-config-seeds-project-sandbox-dir`,
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
