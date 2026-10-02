---
target-version: 2.9.0
status: draft
tags: [feature, secrets, sandbox, dbus]
---

# Sandbox Secret Storage

> **Design proposal — not implemented.** No `IMPLEMENTED_BY` links exist yet
> because there is no implementation to link to. It is filed as a feature
> (rather than an issue) because the same problem recurs with every GUI or
> Electron preset added, and each preset inventing its own answer is how the
> D-Bus proxy story in
> [0004-no-host-dbus.md](/architecture/decision-records/0004-no-host-dbus.md)
> happened: one fix per app, none of them examined as a whole. The mechanism
> section below is verified from source; the policy section is a proposal
> awaiting the real-desktop measurements listed at the end.

## Summary

A sandboxed tool that wants to "remember a login" asks the OS for a secret
service that, by ADR 0004, it cannot reach — what it can reach instead is a
private, sandbox-session-scoped one that xpra's D-Bus activation provides on
demand. This document records what actually happens in that situation, what
the honest options are, and proposes a single default that every preset
shares instead of each re-deciding.

## Motivation

The pattern is already been observed twice and the vscode preset is the third
hit:

- RStudio's sandbox session: opening a folder spawned Chrome, which demanded
  a **new gnome-keyring** on first run — D-Bus activation on xpra's private
  bus started `gnome-keyring-daemon` inside the sandbox on demand. The prompt
  was cancellable and nothing persisted.
- VS Code's accounts / Settings Sync store their tokens via Electron's
  `safeStorage`, i.e. the same Secret Service. A sandboxed instance with a
  fresh user-data-dir hits this on its very first GitHub sign-in.
- Any future Electron/GTK preset (and any CLI tool using `libsecret`
  directly) inherits the same question.

It is a *usability* problem that repeats every session, not a security hole:
under ADR 0004 the sandbox can never see the user's real keyring, so a
sandboxed tool's secrets are, by construction, sandbox-owned — the only real
decisions are where they live and how long they survive.

## What Actually Happens (verified from source)

All of this was read from the VS Code and Electron source (`microsoft/vscode`
`main`, 2026-10) rather than from docs folklore:

- VS Code's secret storage sits on Electron `safeStorage`
  (`src/vs/platform/encryption/electron-main/encryptionMainService.ts`). On
  Linux the backend is chosen at runtime: KWallet variants, GNOME
  (`gnome_libsecret` et al.), or `basic_text`.
- **No backend available → clean in-memory fallback, not a crash.**
  `BaseSecretStorageService.initialize()`
  (`src/vs/platform/secrets/common/secrets.ts`) checks
  `isEncryptionAvailable()` and, when false, swaps in an
  `InMemoryStorageService`: secrets work for the session's lifetime and
  vanish at exit. Nothing writes to disk, nothing dies.
- `--password-store=basic` (CLI flag, or `"password-store": "basic"` in
  `argv.json`) opts into `basic_text`: secrets *are* persisted — into the
  user-data-dir — "encrypted" with a key derived from a fixed, public empty
  password. That is obfuscation, not confidentiality; anyone who can read the
  file can decrypt it. Treat it as plaintext at rest, because it is.
- `--use-inmemory-secretstorage` forces the in-memory mode explicitly.
- The GNOME keyring *files* live at `$HOME/.local/share/keyrings/`. Inside a
  sandbox that path is unbound tmpfs, so a D-Bus-activated keyring's storage
  dies with the session even when the daemon is happy to run — the
  create-keyring prompt returns next session.

The last two bullets combine into the *de facto* status quo for a GUI preset:
sign in, tokens live in memory (or in a session-scoped keyring), every new
session asks again. Which is ADR 0004's isolation promise — at the price this
feature exists to pay down.

## The Trust Model, Stated Plainly

A secret a sandboxed tool can *use* is a secret the sandbox — and therefore
any agent inside it — can read, however it is stored: plaintext on disk while
running, or already-decrypted in the keyring daemon's memory while unlocked.
Choosing among the options below is therefore never about protecting secrets
from the sandboxed agent. It is only about **at-rest residue**: what a
session leaves on the host disk, for how long, and readable by whom. All
"whom" answers here are "the user's own account", since every candidate
directory lives under `$HOME`; scoder has no mechanism, and this feature does
not add one, to protect a file from its owner.

## Options

**A. In-memory (do nothing).** No flag passed; VS Code's own fallback does
the rest. Nothing ever lands on disk. Cost: re-authenticate every session.
This is the honest default and needs no scoder code at all — only a decision
not to "fix" the prompts with plaintext persistence by reflex.

**B. Session keyring (status quo, accidental).** gnome-keyring D-Bus-activates
on the private bus; a keyring exists for the session (possibly after the
empty-password prompt) and evaporates. Functionally ≈ A plus a first-run
prompt plus a daemon in the process tree. Unavoidable without extra
machinery; worth documenting, not worth engineering.

**C. Persistent obfuscated-plaintext (`--password-store=basic` + a persistent
user-data-dir).** Sign in once, it sticks. Requires the preset's user-data-dir
to persist anyway (the vscode plan does), adds one CLI flag, zero new
machinery. Cost, said plainly: tokens sit on the host disk in effectively
plaintext, in the user's own home, indefinitely.

**D. Persistent scoder-managed keyring.** Bind
`~/.local/share/scoder-keyrings` (project- or profile-scoped) at the sandbox
path `$HOME/.local/share/keyrings` so the activated daemon persists its files
across sessions. Looks like "real" secret service continuity but delivers
option B's protection while looking like more, because the default keyring
must be created with an empty password for an unlock-without-PAM session to
read it — the encrypted-at-rest property everyone assumes is exactly what
that empty password removes. Highest machinery-to-protection ratio of the
four; proposed only if a future tool *requires* the Secret Service API itself
(rather than VS Code's safeStorage, which C covers) and rejects `basic`.

## Proposed Policy

1. Default is **A**: presets pass no password-store flag; VS Code's own
   in-memory fallback is the designed behavior, not a bug to paper over.
2. Persistent secrets become an **opt-in, per-preset decision** — a flag or
   `.sandbox`-level setting, wording TBD — implemented as **C** when wanted.
   Never silent: the user chose to write tokens to disk.
3. **D** stays parked until a concrete tool needs the Secret Service API with
   persistence.
4. The **system bus stays out of scope**, as always: anything reaching for
   `org.freedesktop.secrets` on the *system* bus, or polkit/systemd root
   paths (the `bspm` class), remains blocked by ADR 0004 and unaffected by
   this feature. Nothing here reopens that.

## Per-tool notes

| Tool | Secret Service usage | Behavior today |
|---|---|---|
| vscode | Electron safeStorage (accounts, Settings Sync, extension secrets) | In-memory fallback (A); C is one flag away |
| Chrome (observed via rstudio session) | keyring on startup | Option B accidentally; prompt cancellable |
| rstudio | none observed | — |
| claude / pi / copilot CLI | none on Linux (file-based state) | — |

## Open questions

1. Real-desktop measurement of VS Code's actual first-run UX on xpra's
   private bus: pure in-memory, or does gnome-keyring activate and prompt?
   (The Chrome observation says the daemon *can* activate; VS Code's path is
   unmeasured.)
2. Same question for a sandbox image without gnome-keyring installed —
   confirming A's fallback is genuinely crash-free in practice.
3. Whether opt-in C should be per-project or per-user; per-project matches
   the vscode preset's managed user-data-dir scope and is proposed.

[HAS_FEATURE](/design/features/xpra-gui-isolation.md)
[HAS_FEATURE](/design/features/sandbox-isolation.md)
