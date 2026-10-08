---
target-version: 2.5.0
status: draft
tags: [issue, sandbox, rstudio, ide-companion, logging]
---

# RStudio's `rsession` JSON-RPC Error Appears Unprompted in `pi`'s Terminal

## Summary

While running `scoder --ide rstudio pi` (or the `eclipse` equivalent — not yet
confirmed whether this is RStudio-specific), lines like the following appear
in `pi`'s own terminal, with no action taken there to cause it:

```
rsession-vp22681[297172]: ERROR jsonrpc error 6 (Invalid json-rpc request); OCCURRED AT rstudio::core::Error rstudio::core::json::parseJsonRpcRequest(const string&, rstudio::core::json::JsonRpcRequest*) src/cpp/core/json/JsonRpc.cpp:43; LOGGED FROM: void rstudio::core::gwt::handleLogRequest(const string&, const rstudio::core::http::Request&, rstudio::core::http::Response*) src/cpp/core/gwt/GwtLogHandler.cpp:262
```

Reported directly: six instances observed in one session, correlating with
active editing in RStudio (typing/editing content, not any explicit action in
`pi`'s own terminal), noticed only on switching focus back to `pi` — not
interrupting typing in `pi`, but appearing unprompted there.

**Not yet resolved, and not yet clearly a scoder bug at all** — see
"Leading Hypothesis" below. Logged per the user's own request, to revisit if
it recurs or gets more disruptive, not currently under active investigation.

## What's Confirmed

This surfaced directly after fixing a related, separate problem: IDE error
output leaking onto the console because bwrap's redirect-fds-only approach
(`>"$IDE_LOG" 2>&1`, no `setsid`) didn't stop a GUI app writing straight to
`/dev/tty`. That fix (`setsid` + stdin from `/dev/null` for the IDE spawn,
`wrapWithIdeBackground` in `src/sandbox/builder.ts` — **still uncommitted**,
entangled in the working tree with unrelated in-progress `worktrunk`
integration work, see below) was checked directly against this exact
symptom, live, in the reporting session:

- **RStudio's own top-level process (the actual Electron/RStudio main
  process, identified precisely by process tree — not `rsession`, not one of
  its own `--type=zygote`/`--type=utility` Chromium helper children, and not
  the wrapper script itself, which incidentally matches a plain `grep
  rstudio` because its own command line contains `/usr/bin/rstudio` as an
  argument) is confirmed a session leader** (`ps` `STAT` column shows `s`),
  i.e. `setsid` took effect correctly.
- **That process's own fd 1 and fd 2 both point at `/tmp/scoder-ide.log`**,
  confirmed directly via `ls -al /proc/<pid>/fd/1` /`fd/2` on the live,
  currently-running process. The redirect is genuinely in place; RStudio's
  main process cannot be writing this message to a visible terminal through
  either of its own standard fds.
- `rsession` (the actual R backend, a separate process — this is the one
  named in the error text and whose pid matches it) has its **own** fd 1 and
  fd 2, which are **pipes**, not a tty and not directly `/tmp/scoder-ide.log`
  either. This is normal Electron-app architecture: the main process spawns
  its backend with dedicated pipes so it can capture and relay the backend's
  own output itself, rather than the backend inheriting the main process's
  fds directly.

Taken together: the two mechanisms already fixed (fd redirection, session
detachment from the controlling terminal) are both confirmed working
correctly for the actual process tree involved. Whatever is producing the
lines the user sees is not RStudio's own process writing directly to a
visible terminal device.

## Leading Hypothesis, Not Confirmed

The error text itself (`GwtLogHandler`/`parseJsonRpcRequest`) describes
RStudio's GWT (browser-based) frontend sending a malformed diagnostic-log
request to its own backend — plausibly a real, minor RStudio-side quirk
triggered by editing while a request is mid-flight (matching the user's own
observation that it correlates with active editing, not any particular
`pi`-side action), and plausibly unrelated to sandboxing at all. That request
being logged is expected to land in `/tmp/scoder-ide.log`, per the
already-confirmed-working redirect above — landing there is the fix working
as intended, not a leak.

The open question is how the *same content* is then appearing, unprompted,
in `pi`'s own terminal. Leading hypothesis: **`pi` itself is reading
`/tmp/scoder-ide.log` and surfacing new content**, not scoder or RStudio
writing to a shared terminal. Checked and ruled out as a scoder-side cause:
neither the sandbox's `AGENTS.md` overlay notice nor any skill file mentions
`/tmp/scoder-ide.log` to the agent at all — scoder itself gives `pi` no
reason to know that path exists. The path this hypothesis actually takes is
more likely: earlier in this same investigation, an agent running in `pi`
was explicitly asked to help diagnose the (now-resolved) RStudio/Eclipse
terminal-deadlock issue, which plausibly involved checking that exact log
file — and may have left some kind of ongoing watch/habit behind, or simply
continues to check it as part of unrelated, still-active work.

**Not confirmed.** The user's own read: "I think it's a no on the `pi` tail
but I can't be sure." If revisited, the direct way to settle this is to ask
whatever's running in `pi` at the time directly ("are you watching or
periodically checking `/tmp/scoder-ide.log`?"), or to watch `pi`'s own tool-call
history around the moment a new line appears.

## If Revisited

1. Confirm or rule out the `pi`-side hypothesis directly (above) before
   looking at anything sandbox-side again — the fd evidence already rules
   out RStudio's own process as the source through any standard channel.
2. If `pi` is not the source, the remaining live possibility is a *third*
   channel neither this investigation nor the one in
   `eclipse-rstudio-embedded-terminal-deadlocks.md` has found yet — get a raw
   terminal capture showing the line appear in real time (not a
   description after the fact), and check what process actually has the
   terminal device open at that moment (`fuser`/`lsof` on the pty, or a
   fresh `strace -f` on the whole session's process tree around the moment
   it appears) rather than guessing which specific process to suspect.
3. Whether or not this recurs, `wrapWithIdeBackground`'s `setsid`/`/dev/null`
   stdin fix itself is still sitting uncommitted in the working tree,
   entangled with unrelated in-progress `worktrunk` integration changes in
   the same three files (`src/sandbox/builder.ts`, `tests/scoder.test.ts`,
   `design/test-scripts/validation-suite.md`). It needs a decision on
   whether to commit it bundled with that other work or split out — not
   yet resolved as of this writing.

## Recurrence (2026-10-08)

Reported again, now described as "spamming" the terminal rather than six
lines in a session, with the user's guess that RStudio's autocomplete is
the trigger (consistent with the earlier "while editing" correlation):

```
rsession-vp22681[26854]: ERROR jsonrpc error 6 (Invalid json-rpc request); OCCURRED AT rstudio::core::Error rstudio::core::json::parseJsonRpcRequest(const string&, rstudio::core::json::JsonRpcRequest*) src/cpp/core/json/JsonRpc.cpp:43; LOGGED FROM: void rstudio::core::gwt::handleLogRequest(const string&, const rstudio::core::http::Request&, rstudio::core::http::Response*) src/cpp/core/gwt/GwtLogHandler.cpp:262
```

Context that has changed since the original report, and matters:

- The session ran under xpra (RStudio as the GUI child), where the IDE's
  stdout/stderr go to the xpra log, not the terminal — and setsid has been
  in place since. A line still reaching the terminal therefore did not
  travel over RStudio's own stdout/stderr.
- `rsession-<user>[pid]:` is syslog's tag format. A plausible third
  channel is RStudio logging via syslog: `/dev/log` is not bound into the
  sandbox, so the call either fails silently or something prints a
  fallback to a tty. Worth checking first: rsession's logging config
  (`logging.conf`, `log-level`, `logger-type`) and whether forcing
  `logger-type=file` stops the terminal lines.
- Branch at the time: `test/vscode-inmemory-secrets` (throwaway keyring
  trial), not believed related.

## Testing

No new test needed for this specific issue while unconfirmed — the fix
already shipped (uncommitted) for the underlying `/dev/tty`-leak mechanism
has its own test
(`ide-companion-detached-from-controlling-terminal`). If the `pi`-watching
hypothesis is confirmed, there is nothing here for scoder's own test suite
to cover (the fix, if any, is in how `pi` is instructed or configured, not
in scoder). If a genuine third leak channel is found instead, add a
regression test in the same shape as that one.

[HAS_FEATURE](/design/features/ide-companion.md)
[IMPACTS](/src/sandbox/builder.ts)
