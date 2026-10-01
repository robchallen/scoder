---
target-version: 2.2.0
status: draft
tags: [test-script, validation]
---

# Validation Test Suite

[HAS_FEATURE](../features/sandbox-isolation.md)
[HAS_FEATURE](../features/network-isolation.md)
[HAS_FEATURE](../features/git-worktree-isolation.md)
[HAS_FEATURE](../features/infrastructure-protection.md)
[HAS_FEATURE](../features/agents-md-overlay.md)
[HAS_FEATURE](../features/agents-skills-snapshot.md)
[HAS_FEATURE](../features/local-bin-resolution.md)
[HAS_FEATURE](../features/path-mirroring.md)
[HAS_FEATURE](../features/nested-sandbox-detection.md)
[HAS_FEATURE](../features/tool-presets.md)
[HAS_FEATURE](../features/dry-run-mode.md)
[HAS_FEATURE](../features/apparmor-compatibility.md)
[HAS_FEATURE](../features/direct-mode.md)
[HAS_FEATURE](../features/ssh-tunnel-access.md)
[HAS_FEATURE](../features/agent-readwrite.md)
[HAS_FEATURE](../features/ide-companion.md)

## Summary

`tests/scoder.test.ts` is a self-contained integration test suite that creates
temporary git repositories under `/tmp`, runs `scoder` against them using
`/bin/bash` as the sandboxed command, and asserts expected behaviour. 113
tests cover all sandbox mechanics — this catalog is currently behind the
actual implemented count (see the note under case 113) due to other,
unrelated in-progress work; not fixed here.

Cleanup runs in an `afterAll` hook. It removes the temp repos, their worktrees
under `$HOME/tmp/scoder-test-repos/worktrees/tmp/scoder-test-repos`, and the
artifacts the `~/.local/bin` cases create in the real home directory. The
paths are enumerated explicitly rather than globbed, because a worktree now
lives under the same real `$HOME` a developer's own genuine session worktrees
do (see path-mirroring) — the test fixture directory name
(`scoder-test-repos`) keeps the two trees from ever actually colliding, but
a wholesale glob under `$HOME` would risk sweeping up real work.

Two exceptions use the real `claude` preset (cases 49-50). They run under
`--dry-run`, so they inspect the built command without launching a sandbox or
touching the host's config, and self-skip when `claude` is not installed.

Most of the `--allow-ssh` cases (56, 58-60, 62) start a disposable `sshd` —
ControlMaster multiplexing is a genuine OpenSSH client/server behaviour a
plain TCP stub cannot stand in for — and self-skip when `sshd` or
`ssh-keygen` is not installed. See "Mock ssh Server" below.

## How to Run

```bash
bun test tests/scoder.test.ts
```

or:

```bash
em test
```

## How It Works

For each test case:

1. Creates a fresh temporary git repository under `/tmp`
2. Adds a small starter project with a tracked file, `.github/ci.yml`, `.gitignore`, and `package-lock.json`
3. Runs `scoder` against that repo using `/bin/bash` as the sandboxed command
4. Checks for the expected result
5. Removes any `scoder/*` worktrees and branches created during the test
6. Deletes the temporary repo

An outer cleanup trap also removes any leftover temporary repos, worktrees, and branches if the script exits early.

## Test Cases

### 1. resolvconf-refresh-detects-and-corrects-a-stale-snapshot
[TESTED_BY](/tests/scoder.test.ts#testResolvconfRefreshDetectsAndCorrectsAStaleSnapshot)

Regression test: reported directly, a host power-state event
(suspend/resume) that changed the host's own DNS server left the
sandbox's one-time `/etc/resolv.conf` snapshot pointing at a
now-unreachable server for the rest of the session — confirmed
unrecoverable by an `.agentports` edit, which only reattaches pasta,
never touching this separately-bound snapshot. `refreshResolvConfSnapshot`
(`src/git/protection.ts`) now re-reads the real host DNS config and
rewrites the snapshot in place if it changed, on its own poll loop
(`startResolvConfWatcher` in `src/sandbox/launch.ts`,
`SCODER_RESOLVCONF_POLL_MS`) — no pasta/bwrap involvement at all, since
`/etc/resolv.conf` inside the sandbox is a `--ro-bind` of this exact
host file. Corrupts the snapshot itself (never the real host
`/etc/resolv.conf` — not safe to touch in a test) to prove the
diff-and-rewrite logic takes the same path a genuine host DNS change
would.

### 2. home-isolation
[TESTED_BY](/tests/scoder.test.ts#testHomeIsolation)

Verifies `$HOME` inside the sandbox is the real host `$HOME` (see
path-mirroring) — not a synthetic path, and not empty/unset.

### 3. system-read-only
[TESTED_BY](/tests/scoder.test.ts#testSystemReadOnly)

Attempts to create a file under `/usr/bin`. Must fail because system directories are mounted read-only.

### 4. worktree-writable
[TESTED_BY](/tests/scoder.test.ts#testWorktreeWritable)

Creates a file in the project working tree. Must succeed, proving the sandbox can modify the isolated worktree.

### 5. github-protected
[TESTED_BY](/tests/scoder.test.ts#testGithubProtected)

Attempts to create a file inside `.github/`. Must fail (default protected).

### 6. gitignore-protected
[TESTED_BY](/tests/scoder.test.ts#testGitignoreProtected)

Attempts to modify `.gitignore`. Must fail (default protected).

### 7. empty-agentreadonly-allows-writes
[TESTED_BY](/tests/scoder.test.ts#testEmptyAgentreadonlyAllowsWrites)

Empty `.agentreadonly` removes default workspace protection. Write to `.github/` must succeed.

### 8. agentreadonly-protected
[TESTED_BY](/tests/scoder.test.ts#testAgentreadonlyProtected)

`.agentreadonly` is always mounted read-only, even when empty.

### 9. agentreadonly-home-directory-readonly
[TESTED_BY](/tests/scoder.test.ts#testAgentreadonlyHomeDirectoryReadonly)

`$HOME/Git/other-project` in `.agentreadonly` binds a host directory read-only. Can read but not write.

### 10. agentreadonly-home-file-bind-does-not-create-conflicting-dir
[TESTED_BY](/tests/scoder.test.ts#testAgentreadonlyHomeFileBindDoesNotCreateConflictingDir)

Regression test: reported directly, an `.agentreadonly` `$HOME/...` entry
pointing at a *file* (not a directory) failed with `bwrap: Can't create
file at <path>: Is a directory`. `fileOrDirExists` (not `dirExists`) is
the existence check `registerAgentreadonlyHomeBind` already used, so
files were always meant to be supported — the bug was in the
ancestor-`--dir` scaffold loop, which pushed a `--dir` entry for the leaf
path too, not just its real ancestors. `bwrap` processes `--dir` before
`--ro-bind`, so it scaffolded an empty directory exactly where the file
needed a file mountpoint instead. Fixed by excluding the leaf from that
loop.

### 11. agentreadonly-home-directory-must-exist
[TESTED_BY](/tests/scoder.test.ts#testAgentreadonlyHomeDirectoryMustExist)

References to non-existent paths via `$HOME/...` must fail with a clear error about the directory missing.

### 12. agentreadonly-home-nested-namespace-path-allowed
[TESTED_BY](/tests/scoder.test.ts#testAgentreadonlyHomeNestedNamespacePathAllowed)

Regression test: reported directly, `$HOME/.local/share/fonts` was
rejected outright with "overlaps reserved sandbox path" even though
nothing was bound at the bare `$HOME/.local` umbrella it nested under at
the time — only specific sub-paths under it were (`.local/bin`,
`.local/share/mise`), neither of which fonts collided with.
`fixedBindDestinations` (`src/git/protection.ts`, shared with
`.agentreadwrite`'s own overlap check) now lists only the exact fixed
destinations, not the bare umbrellas they happen to live under. Uses
`$HOME/.local/share/icons` rather than the originally reported
`.../fonts`, since fonts has since become a fixed destination itself
(case 15) and no longer illustrates "safely nested, not itself fixed."

### 13. agentreadonly-home-fonts-directory-now-redundant
[TESTED_BY](/tests/scoder.test.ts#testAgentreadonlyHomeFontsDirectoryNowRedundant)

Fonts is now a fixed default bind (`buildExtraBinds` — see case 15) — an
`.agentreadonly` entry for the exact same path is therefore a redundant
re-declaration of something scoder already handles, correctly rejected
the same way `$HOME/.claude` or `$HOME/.config` already are.

### 14. agentreadonly-home-ancestor-of-fixed-bind-still-rejected
[TESTED_BY](/tests/scoder.test.ts#testAgentreadonlyHomeAncestorOfFixedBindStillRejected)

The other half of the same fix: a bare umbrella is only safe to allow
when nothing fixed lives under it. `$HOME/.config` is an ancestor of
real fixed sub-binds (`.config/mise`, `.config/gh` — see
`buildExtraBinds` in `src/sandbox/builder.ts`), so it must still be
rejected — the overlap check is bidirectional.

### 15. fonts-directory-bound-readonly-by-default
[TESTED_BY](/tests/scoder.test.ts#testFontsDirectoryBoundReadonlyByDefault)

Added directly at the user's request, alongside `.config/mimeapps.list`
(case 16): GUI presets (`rstudio`, `eclipse`) need real host fonts to
render text at all, not just cleanly. `buildExtraBinds`
(`src/sandbox/builder.ts`) binds `~/.local/share/fonts` unconditionally
when it exists, like every other host-tool-binding entry — no preset or
`.agentreadonly` entry needed.

### 16. mimeapps-list-bound-readonly-by-default
[TESTED_BY](/tests/scoder.test.ts#testMimeappsListBoundReadonlyByDefault)

Same reasoning as case 15: desktop apps commonly consult
`~/.config/mimeapps.list` for file-type "open with" associations.

### 17. worktree-branch-created
[TESTED_BY](/tests/scoder.test.ts#testWorktreeBranchCreated)

Running scoder creates a `scoder/<repo-name>` branch.

### 18. existing-scoder-worktree-reused
[TESTED_BY](/tests/scoder.test.ts#testExistingScoderWorktreeReused)

Rerunning from an existing scoder worktree reuses the checkout rather than creating a new one.

### 19. worktree-recreated-if-missing
[TESTED_BY](/tests/scoder.test.ts#testWorktreeRecreatedIfMissing)

Deleting the worktree directory (simulating system reboot) and rerunning scoder prunes the stale reference and recreates the worktree.

### 20. symlinked-agents-skills-available
[TESTED_BY](/tests/scoder.test.ts#testSymlinkedAgentsSkillsAvailable)

Symlinked agent skills are resolved at snapshot time and available read-only inside the sandbox.

### 21. sandbox-agents-md-overlay-visible
[TESTED_BY](/tests/scoder.test.ts#testSandboxAgentsMdOverlayVisible)

AGENTS.md overlay appends scoder sandbox notice without modifying the host repository copy.

### 22. agents-md-overlay-in-direct-mode
[TESTED_BY](/tests/scoder.test.ts#testAgentsMdOverlayInDirectMode)

AGENTS.md overlay in direct mode does not include worktree-specific messages.

### 23. host-loopback-blocked
[TESTED_BY](/tests/scoder.test.ts#testHostLoopbackBlocked)

Host localhost HTTP server is unreachable from the sandbox via pasta's default loopback blocking.

### 24. agentports-forwards-listed-port
[TESTED_BY](/tests/scoder.test.ts#testAgentportsForwardsListedPort)

A port listed in a project's `.agentports` file is reachable inside the
sandbox without any CLI flag — `.agentports` replaced `--llm-port` entirely.

### 25. outbound-dns-works
[TESTED_BY](/tests/scoder.test.ts#testOutboundDnsWorks)

DNS resolution works inside the sandbox via pasta's DHCP/DNS.

### 26. pasta-ipv6-routability-failure-detected-for-retry
[TESTED_BY](/tests/scoder.test.ts#testPastaIpv6RoutabilityFailureDetectedForRetry)

Regression test: reported directly, pasta refused to attach at all
("No routable interface for IPv6: IPv6 is disabled" / "Couldn't switch
to pasta namespaces: ...") on a host with IPv6 unavailable —
`--config-net`'s own dual-stack auto-detection apparently treats IPv6
being unavailable as fatal rather than something to skip gracefully.
`isIpv6RoutabilityFailure` (`src/sandbox/pasta.ts`) detects this exact
failure from pasta's own stderr so `attachPasta` can retry once with
`--ipv4-only`. Deliberately not predicted ahead of time by reading a
sysctl (`net.ipv6.conf.all.disable_ipv6`, tried first): that missed a
real case reported directly, where IPv6 was disabled via the
`ipv6.disable=1` kernel boot parameter rather than the per-sysctl
toggle, so `/proc/sys/net/ipv6` doesn't exist at all and the sysctl read
silently — and wrongly — reported "not disabled". Trusting pasta's own
authoritative determination, after the fact, covers every route to this
failure without needing to enumerate them.

### 27. dry-run-redacts-sensitive-env-vars
[TESTED_BY](/tests/scoder.test.ts#testDryRunRedactsSensitiveEnvVars)

Regression test: reported directly, `--dry-run`'s own preview printed
several real API keys/tokens in cleartext (`COPILOT_GITHUB_TOKEN`,
`DEEPSEEK_API_KEY`, and others from `builder.ts`'s `passThrough` list),
pasted directly into a chat log by a user who had no reason to expect a
*preview* to expose live secrets. `printBwrapCommand` (`src/index.ts`)
now redacts any `--setenv` value whose name matches
`/token|key|secret|password|credential/i` — a substring heuristic, not
an exact match against `passThrough`'s own list, so a newly added
provider env var is covered automatically. A non-sensitive env var
(`EDITOR`) still prints its real value, confirming the heuristic isn't
over-broad.

### 28. dry-run-uses-pasta
[TESTED_BY](/tests/scoder.test.ts#testDryRunUsesPasta)

Dry-run output includes `pasta` in the command line.

### 29. no-worktree-mode
[TESTED_BY](/tests/scoder.test.ts#testNoWorktreeMode)

`--no-worktree` flag bypasses git worktree creation and the output mentions "direct mode".

### 30. local-bin-symlink-resolved
[TESTED_BY](/tests/scoder.test.ts#testLocalBinSymlinkResolved)

A symlink in `~/.local/bin` pointing to a host path outside the sandbox is
resolved via a forwarding shim and the tool executes correctly.

### 31. local-bin-regular-file
[TESTED_BY](/tests/scoder.test.ts#testLocalBinRegularFile)

Regular executable files in `~/.local/bin` are copied with their
permissions intact and work inside the sandbox.

### 32. local-bin-symlink-arg-passthrough
[TESTED_BY](/tests/scoder.test.ts#testLocalBinSymlinkArgPassthrough)

Forwarding shim passes all arguments through to the underlying tool.

**Known coupling:** this case does not create its own fixture. It reuses the
`~/.local/bin/scoder-test-tool` symlink created by case 21
(`local-bin-symlink-resolved`), so it depends on execution order and on that
symlink surviving. Running it in isolation only passes if a previous full run
left the artifact behind. It should create its own fixture.

### 33. agentports-auto-detect-appends
[TESTED_BY](/tests/scoder.test.ts#testAgentportsAutoDetectAppends)

When `SCODER_LLM_PORT` is set and the port is open on localhost, scoder
auto-detects it, reaches it immediately, and appends it to `.agentports` —
additively, and only once: a second run with the port already listed does
not duplicate the entry.

### 34. addGitExclude should mark AGENTS.md as skip-worktree
[TESTED_BY](/tests/scoder.test.ts#testAddGitExclude)

`addGitExclude` sets the `--skip-worktree` index flag on `AGENTS.md` so git
ignores the overlay modification. This is what prevents the overlay from
appearing as a dirty working tree inside the sandbox.

### 35. removeGitExclude should restore normal tracking
[TESTED_BY](/tests/scoder.test.ts#testRemoveGitExclude)

`removeGitExclude` clears the `--skip-worktree` flag after the session ends,
restoring normal git tracking for `AGENTS.md`.

### 36. addGitExclude should be idempotent
[TESTED_BY](/tests/scoder.test.ts#testAddGitExcludeIdempotent)

Calling `addGitExclude` multiple times does not duplicate entries in the git index.

### 37. scoder should succeed in direct mode with AGENTS.md excluded
[TESTED_BY](/tests/scoder.test.ts#testScoderDirectModeExclude)

scoder runs successfully in `--no-worktree` mode with AGENTS.md excluded from
git tracking. The exclude is cleaned up after the session.

### 38. scoder should succeed in worktree mode with AGENTS.md excluded
[TESTED_BY](/tests/scoder.test.ts#testScoderWorktreeModeExclude)

scoder runs successfully in worktree mode with AGENTS.md excluded from the
worktree git index. The exclude is cleaned up after the session.

### 39. home-installed-tool-exec-path-resolved
[TESTED_BY](/tests/scoder.test.ts#testHomeInstalledToolExecPathResolved)

A tool installed under `$HOME` (a `~/.local/bin` entry symlinked at a versioned
binary under `~/.local/share/<tool>/versions/`, the layout native installers
produce) has an exec target that resolves inside the sandbox. Since the
sandbox's own `$HOME` is now the real host `$HOME` (see path-mirroring), the
resolved exec path and the host path are the same string — this asserts the
dry-run command carries a real, bindable path, not that it differs from the
host's.

Regression test for `scoder claude` failing with `execvp: No such file or
directory`: `which` resolves on the host, but historically the sandbox
replaced `/home` with a tmpfs containing only a separate `/home/scoder`
namespace the host path didn't exist under. That separate namespace is gone
now (see path-mirroring's history), but the underlying risk this test guards
— a `$HOME`-installed tool whose directory isn't actually bound into the
sandbox — is still real, just caught by `checkExecTargetReachable`'s
`isUnderAny` check against the built command's own bind destinations instead.

### 40. home-installed-tool-runs
[TESTED_BY](/tests/scoder.test.ts#testHomeInstalledToolRuns)

The same layout, launched for real rather than dry-run: the tool executes inside
the sandbox and produces its output. Asserts `execvp` never appears on stderr.

### 41. local-bin-symlink-target-mapped
[TESTED_BY](/tests/scoder.test.ts#testLocalBinSymlinkTargetMapped)

Renamed from an earlier version of this test that scanned the whole
`~/.local/bin` snapshot for any symlink pointing at a literal `$HOME/...`
path — a meaningful check back when the sandbox remapped `$HOME` onto a
separate `/home/scoder` namespace (any such entry was necessarily a bug: the
rewrite had been skipped). Now that the sandbox's own `$HOME` is the real
host `$HOME` (see path-mirroring), a `$HOME`-relative symlink target is not
itself suspicious, so that sweep is gone. What's left, and still meaningful:
a fixture tool that is small and unbound by any preset must be copied into
the snapshot whole, not left as a dangling symlink.

### 42. unbound-home-tool-diagnosed
[TESTED_BY](/tests/scoder.test.ts#testUnboundHomeToolDiagnosed)

A tool in a `$HOME` directory that is not bound into the sandbox cannot work.
scoder exits 1 with an actionable diagnostic naming the directory, rather than
launching and letting pasta emit a bare `execvp` error.

### 43. session-commit-lands-in-worktree
[TESTED_BY](/tests/scoder.test.ts#testSessionCommitLandsInWorktree)

A worktree-mode session leaves the *launching* repository's `git status` and
commit log byte-identical, while the sandbox's own change is committed on the
`scoder/*` branch. Regression test for `commitAllChanges` spawning git without a
`cwd`, which committed the user's main checkout.

### 44. clean-worktree-session-commits-nothing
[TESTED_BY](/tests/scoder.test.ts#testCleanWorktreeSessionCommitsNothing)

A session that changes nothing succeeds rather than failing on `git commit`
returning non-zero for an empty commit.

### 45. skip-worktree-cleared-after-session
[TESTED_BY](/tests/scoder.test.ts#testSkipWorktreeClearedAfterSession)

`git ls-files -v AGENTS.md` reports `H`, not `S`, after a completed session.
Regression test for `process.exit()` inside the `try` whose `finally` clears the
flag — `process.exit()` does not run pending `finally` blocks. The existing
`addGitExclude`/`removeGitExclude` tests call those functions directly and so
cannot catch this.

### 46. direct-mode-works-in-linked-worktree
[TESTED_BY](/tests/scoder.test.ts#testDirectModeWorksInLinkedWorktree)

`scoder --no-worktree` succeeds when run from inside a linked git worktree
(`.git` is a file). Regression test for the nesting check exiting regardless of
mode while advising the flag the user had already passed.

### 47. worktree-mode-refused-in-linked-worktree
[TESTED_BY](/tests/scoder.test.ts#testWorktreeModeRefusedInLinkedWorktree)

The other half of the same check: `scoder -w` from inside a linked worktree still
exits 1, since that nesting genuinely cannot work.

### 48. worktree-mode-refuses-dirty-checkout
[TESTED_BY](/tests/scoder.test.ts#testWorktreeModeRefusesDirtyCheckout)

Renamed from `uncommitted-host-changes-warned`. Worktree mode used to only
warn when the launching checkout had uncommitted changes the agent cannot
see; it now refuses outright (exit 1, `--worktree requires a clean
checkout`), checked before `setupGitWorktree` runs so no branch/worktree is
created on the refused launch. Asserts both the exit code/message and that
`git worktree list` shows no new `scoder/*` entry afterward.

### 49. claude-preset-home-config-writable
[TESTED_BY](/tests/scoder.test.ts#testClaudePresetHomeConfigWritable)

`~/.claude` is bound `--bind` (read-write), not `--ro-bind`. Claude Code writes
there throughout a session and fails rather than degrades under a read-only
bind. Guards a deliberate trade-off that no other test covered — see
[rw-config-mounts-limited-escape](../implementation/debt/rw-config-mounts-limited-escape.md).

### 50. workspace-claude-dir-still-protected
[TESTED_BY](/tests/scoder.test.ts#testWorkspaceClaudeDirStillProtected)

The *workspace* `.claude/` directory stays read-only even though `~/.claude` is
writable. The two are separate binds and must not be conflated.

### 51. sandbox-uid-preserved
[TESTED_BY](/tests/scoder.test.ts#testSandboxUidPreserved)

The uid inside the sandbox is the host uid, not 0. Guards the regression where
pasta's spawn mode created a nested user namespace overriding bwrap's `--uid`,
so the tool ran as root. Was marked `test.failing` while the defect stood; the
marker came off when bwrap took ownership of both namespaces. See
[ADR 0001](../../architecture/decision-records/0001-sandbox-uid-and-networking-composition.md).

### 52. sandbox-uid-maps-to-host-user
[TESTED_BY](/tests/scoder.test.ts#testSandboxUidMapsToHostUser)

The property that makes case 42 survivable: whatever uid the sandbox reports,
files it creates are owned by the real host user, because pasta maps inside-0
back to the caller. This must keep holding through any fix.

### 53. pasta-sidecar-reaped
[TESTED_BY](/tests/scoder.test.ts#testPastaSidecarReaped)

A completed session leaves no pasta process behind. This is the failure mode
attach mode introduces: pasta runs outside the sandbox, so bwrap's
`--die-with-parent` no longer reaps it and scoder must do so itself. Counts
sidecars before and after rather than asserting zero, because the developer may
legitimately have other scoder sessions running.

### 54. sandbox-identity-consistent
[TESTED_BY](/tests/scoder.test.ts#testSandboxIdentityConsistent)

`id -un`, `id -gn` and `getpwuid()` all report the sandbox's real identity:
the real username (`getSandboxUsername()` — `$SUDO_USER`, else `$USER`, else
`$LOGNAME`) and the real `$HOME`. Setting `$HOME` is not sufficient, because
anything resolving the user through NSS reads `/etc/passwd` and `/etc/group`
instead — OpenSSH locates `~/.ssh` that way. The overlay `setupSandboxIdentity`
writes exists to make that resolution deterministic (not dependent on
whatever the host's own passwd/group database happens to contain, e.g. an
LDAP-backed system) — it describes the real identity now, not a synthetic
`scoder` one, since the sandbox no longer remaps `$HOME` to a separate
namespace (see path-mirroring).

### 55. session-temp-root-cleaned
[TESTED_BY](/tests/scoder.test.ts#testSessionTempRootCleaned)

No `/tmp/scoder-<id>` session temp root survives a session — checked after a
normal run and again after a `--dry-run`, which stages real files and then
exits through `process.exit()`, above the `finally` that would clear them.

Counts roots rather than the `scoder-identity-*` directories this replaced:
there is no per-concern temp directory left to count, which is the point of
`session-temp-root`. The invariant is correspondingly stronger, covering
every staged artifact at once — including the `~/.local/bin` snapshot that
was never cleaned up at all and reached 374 MB a time
(`scoder-local-bin-staging-dirs-leak-into-tmp`), and the fixed
`/tmp/bwrap_passwd_<uid>` two generations back, which was never removed and
collided between concurrent sessions.

The glob is anchored to exactly 8 hex characters so it matches session roots
only: `/tmp` holds plenty of other `scoder`-prefixed things, this suite's own
`/tmp/scoder-test-repos` among them, and a bare `scoder-*` count would fold
them in and never change.

### 56. ssh-tunnel-established-with-flag
[TESTED_BY](/tests/scoder.test.ts#testSshTunnelEstablishedWithFlag)

With `--allow-ssh <user>@127.0.0.1` and a mock `sshd` running, `ssh 127.0.0.1
whoami` inside the sandbox returns the expected remote username. The real
end-to-end proof that the tunnel works.

### 57. ssh-blocked-by-default
[TESTED_BY](/tests/scoder.test.ts#testSshBlockedByDefault)

Without the flag, `ssh 127.0.0.1 whoami` inside the sandbox fails regardless
of what is reachable outside it. Guards the default.

### 58. ssh-wrong-host-falls-through
[TESTED_BY](/tests/scoder.test.ts#testSshWrongHostFallsThrough)

With `--allow-ssh` pointed at the mock server, `ssh some-other-host.invalid
whoami` inside the sandbox still fails. The tunnel is pinned to one
destination; a different hostname does not match the generated `Host` block
and falls through to a normal, failing connection attempt.

### 59. ssh-wrong-user-falls-through
[TESTED_BY](/tests/scoder.test.ts#testSshWrongUserFallsThrough)

Same reachable host, a different login (`ssh someoneelse@127.0.0.1 whoami`) —
also fails. Guards the `%r`-based pinning specifically: matching by hostname
alone would let a different user ride the tunnel.

### 60. ssh-no-private-keys-in-sandbox
[TESTED_BY](/tests/scoder.test.ts#testSshNoPrivateKeysInSandbox)

With `--allow-ssh` active, nothing under the sandbox's `$HOME/.ssh` or
`$HOME/.ssh-control` contains private key material. The most
important guard in the set — it is what stops a future "just forward the
agent, it's easier" change from passing review.

### 61. ssh-tunnel-fails-closed-on-bad-target
[TESTED_BY](/tests/scoder.test.ts#testSshTunnelFailsClosedOnBadTarget)

`--allow-ssh` pointed at an unreachable target (`nobody@unreachable.invalid`)
exits non-zero with a clear error rather than hanging or silently
continuing. Needs no mock server.

### 62. ssh-tunnel-torn-down-on-exit
[TESTED_BY](/tests/scoder.test.ts#testSshTunnelTornDownOnExit)

After a completed session, no leftover ssh master process survives. Counts
before/after rather than asserting zero, matching `pasta-sidecar-reaped`'s
reasoning: the developer may have other legitimate ssh sessions running.

### 63. ssh-dry-run-describes-without-connecting
[TESTED_BY](/tests/scoder.test.ts#testSshDryRunDescribesWithoutConnecting)

`--dry-run --allow-ssh` shows the control-socket bind as `--ro-bind`, not
`--bind`, and never opens a real connection — `describeSshAccess` never calls
`startSshTunnel`.

### 64. bwrap-not-orphaned-on-pasta-attach-failure
[TESTED_BY](/tests/scoder.test.ts#testBwrapNotOrphanedOnPastaAttachFailure)

A fake `pasta` shimmed onto `PATH`, always exiting non-zero, forces the
attach-failure path deterministically. Asserts no bwrap process matching the
test's repo path survives. Regression test for
[bwrap-orphaned-on-pasta-attach-failure](../implementation/issues/bwrap-orphaned-on-pasta-attach-failure.md):
bwrap forks internally even without `--unshare-pid`, and killing only the
outer, tracked pid left the inner one — the one actually holding the
namespaces — running forever, reparented to pid 1.

### 65. agentreadwrite-resolves-rw
[TESTED_BY](/tests/scoder.test.ts#testAgentreadwriteResolvesRw)

With `.agentreadwrite` listing a directory under a throwaway location in
the real `$HOME`, reading pre-existing content and writing new content
through it inside the sandbox both work, and the write is visible on the
host afterward — the real end-to-end proof the bind works, replacing the
`scratch` symlink this feature superseded.

### 66. agentreadwrite-created-if-missing
[TESTED_BY](/tests/scoder.test.ts#testAgentreadwriteCreatedIfMissing)

Same bug class already fixed twice, for `.agentreadonly` and
`.agentports`: a missing `.agentreadwrite` is created and protected
read-only in the very same session that finds it missing, not just from
the next run onward.

### 67. agentreadwrite-self-protected-readonly
[TESTED_BY](/tests/scoder.test.ts#testAgentreadwriteSelfProtectedReadonly)

`.agentreadwrite` itself is always bound read-only inside the sandbox,
the same self-protection `.agentreadonly` and `.agentports` already give
themselves.

### 68. agentreadwrite-missing-target-created
[TESTED_BY](/tests/scoder.test.ts#testAgentreadwriteMissingTargetCreated)

A listed directory that doesn't exist yet is created (`mkdir -p`) rather
than left dangling or treated as an error — the deliberate difference
from `.agentreadonly`'s own `$HOME/...` binds, which require the target
to already exist. The real `mkdir` happens while building the bwrap
command, before pasta ever gets a chance to fail, same reasoning as
`agentreadonly-created-default`'s "file exists before that point is
reached" pattern.

### 69. agentreadwrite-missing-target-not-created-under-dry-run
[TESTED_BY](/tests/scoder.test.ts#testAgentreadwriteMissingTargetNotCreatedUnderDryRun)

`--dry-run` stays side-effect free: the intended bind still appears in
the preview, but the real `mkdir` is skipped.

### 70. agentreadwrite-outside-home-rejected
[TESTED_BY](/tests/scoder.test.ts#testAgentreadwriteOutsideHomeRejected)

A line not starting with `$HOME/` exits non-zero with a clear diagnostic
— unlike `.agentreadonly`, which also accepts local gitignore-style
patterns for its own protected-paths mode, `.agentreadwrite` supports
nothing outside `$HOME` at all.

### 71. agentreadwrite-escape-via-symlink-rejected
[TESTED_BY](/tests/scoder.test.ts#testAgentreadwriteEscapeViaSymlinkRejected)

A `$HOME/...` entry that resolves outside `$HOME` via a symlink is
rejected the same way `.agentreadonly`'s own HOME binds already are.

### 72. agentreadwrite-overlapping-fixed-bind-rejected
[TESTED_BY](/tests/scoder.test.ts#testAgentreadwriteOverlappingFixedBindRejected)

An entry matching one of `buildExtraBinds`' fixed host-tool paths
(`~/.local/bin`, here) is a hard error, not a silent downgrade to
read-only the way the retired `scratch` symlink handled the same
collision. Skips if `~/.local/bin` doesn't exist on the machine running
the suite.

### 73. agentreadwrite-nested-under-namespace-umbrella-allowed
[TESTED_BY](/tests/scoder.test.ts#testAgentreadwriteNestedUnderNamespaceUmbrellaAllowed)

The one deliberate difference from `.agentreadonly`'s own overlap check:
`$HOME/.cache/<tool>` — nested under a bare namespace umbrella that is
never actually populated by a real bind, just scaffolded empty by
`builder.ts`'s own `--dir` list — is allowed, not rejected. This is the
feature's own motivating use case, and blocking it would reject a
perfectly safe entry for no real protection.

### 74. agentreadwrite-overlapping-agentreadonly-rejected
[TESTED_BY](/tests/scoder.test.ts#testAgentreadwriteOverlappingAgentreadonlyRejected)

The same `$HOME/...` path listed in both `.agentreadonly` and
`.agentreadwrite` — directly opposite intents, protect vs. open for
writing — is a hard error naming the conflicting path.

### 75. agentreadwrite-real-passthrough-unaffected
[TESTED_BY](/tests/scoder.test.ts#testAgentreadwriteRealPassthroughUnaffected)

With `.agentreadwrite` present, editing an ordinary tracked project file
still writes straight through to the host.

### 76. agentreadwrite-survives-fresh-worktree
[TESTED_BY](/tests/scoder.test.ts#testAgentreadwriteSurvivesFreshWorktree)

A tracked `.agentreadwrite` still resolves its listed directory
read-write after a fresh worktree checkout — unlike the retired
`scratch` symlink, this is an ordinary tracked file with no special git
handling to verify, so the check is the resulting bind itself, not git's
own symlink-as-blob behaviour.

### 77. llm-port-flag-removed
[TESTED_BY](/tests/scoder.test.ts#testLlmPortFlagRemoved)

`--llm-port` is an unknown option — it was removed, not deprecated, in
favour of `.agentports`. See
[design/implementation/plans/agentports.md](/design/implementation/plans/agentports.md).

### 78. agentports-malformed-line-fails
[TESTED_BY](/tests/scoder.test.ts#testAgentportsMalformedLineFails)

A non-numeric line in `.agentports` exits non-zero, naming the bad line.

### 79. agentports-is-readonly
[TESTED_BY](/tests/scoder.test.ts#testAgentportsIsReadonly)

`.agentports` is always bind-mounted read-only inside the sandbox, the same
self-protection `.agentreadonly` gives itself.

### 80. agentports-auto-detect-skips-under-dry-run
[TESTED_BY](/tests/scoder.test.ts#testAgentportsAutoDetectSkipsUnderDryRun)

`--dry-run` with a detectable port does not write `.agentports` — dry-run
stays entirely side-effect free.

### 81. agentports-live-reload-adds-port
[TESTED_BY](/tests/scoder.test.ts#testAgentportsLiveReloadAddsPort)

Editing `.agentports` mid-session reattaches pasta with the updated port
list, without restarting the session. Uses a fake `pasta` that mimics real
pasta's daemonize-then-exit shape — same reasoning as case 64
(`bwrap-not-orphaned-on-pasta-attach-failure`), applied to the success path:
this environment's own lack of `/dev/net/tun` would make a real pasta attach
non-deterministic here, when what's actually under test is the watcher's
swap logic, not pasta's own forwarding. Verified manually against this exact
shim shape before being committed to the suite.

### 82. agentports-live-reload-bad-edit-keeps-old-config
[TESTED_BY](/tests/scoder.test.ts#testAgentportsLiveReloadBadEditKeepsOldConfig)

A reattach that fails to attach falls back to re-attaching the last
known-good port list, rather than leaving the sandbox with no networking.
Only pins down the fail-then-restore sequence itself (the first three fake
pasta invocations); a later poll tick retrying the same edit and succeeding
is correct behaviour for a transient failure, not something this case
constrains.

### 83. agentports-not-created-under-dry-run
[TESTED_BY](/tests/scoder.test.ts#testAgentportsNotCreatedUnderDryRun)

`--dry-run` with no pre-existing `.agentports` does not create one — dry-run
never runs anything inside the sandbox, so there is nothing for a missing
bind to expose, and dry-run must stay side-effect free regardless.

### 84. agentports-created-if-missing
[TESTED_BY](/tests/scoder.test.ts#testAgentportsCreatedIfMissing)

A real session with no pre-existing `.agentports` creates one on the host,
containing a header comment, before the sandbox is ever built — closing the
bind-mount gap described below regardless of whether the rest of the
session goes on to succeed or fail.

### 85. agentports-missing-file-not-writable-from-sandbox
[TESTED_BY](/tests/scoder.test.ts#testAgentportsMissingFileNotWritableFromSandbox)

A missing source path gets no bind mount at all, which otherwise leaves that
path part of the regular read-write project bind — letting the sandboxed
agent create `.agentports` itself, with whatever ports it likes, completely
unprotected. This case attempts exactly that write from inside a session
that started with no `.agentports` at all, and requires it to fail in the
very first session, not just from the next run onward. Distinguishes a
pasta-attach failure (this suite's own dev environment lacks
`/dev/net/tun`, an unrelated cause) from an actual rejected write, so it
cannot pass trivially just because the sandbox failed to launch for a
different reason.

### 86. agentreadonly-created-if-missing
[TESTED_BY](/tests/scoder.test.ts#testAgentreadonlyCreatedIfMissing)

A real session with no pre-existing `.agentreadonly` creates one on the
host, containing the default protected-path list, before the sandbox is
ever built.

### 87. agentreadonly-missing-file-not-writable-from-sandbox
[TESTED_BY](/tests/scoder.test.ts#testAgentreadonlyMissingFileNotWritableFromSandbox)

A missing source path gets no bind mount at all, which otherwise leaves
that path part of the regular read-write project bind — letting the
sandboxed agent create or edit `.agentreadonly` itself. This case attempts
exactly that edit from inside a session that started with no
`.agentreadonly` at all, and requires it to fail in the very first session,
not just from the next run onward. Distinguishes a pasta-attach failure
(this suite's own dev environment lacks `/dev/net/tun`, an unrelated cause)
from an actual rejected write, so it cannot pass trivially just because the
sandbox failed to launch for a different reason.

### 88. terminal-signals-forwarded-to-sandbox
[TESTED_BY](/tests/scoder.test.ts#testTerminalSignalsForwardedToSandbox)

SIGWINCH (a real resize, via `TIOCSWINSZ`) and SIGINT (a real Ctrl-C byte)
reach the sandboxed process, which `--new-session` would otherwise fully
detach from any controlling terminal. A second Ctrl-C sent quickly
force-kills the whole launch rather than forwarding again. Needs a real
controlling-terminal relationship to reproduce at all — a plain `Bun.spawn`
(pipes, no tty) cannot exercise this — so it drives a real PTY through
`tests/helpers/pty-signal-harness.py` (Bun/Node have no first-party PTY
allocation). Self-skips if `python3` is not installed. See
[design/implementation/issues/terminal-signals-not-forwarded-to-sandbox.md](/design/implementation/issues/terminal-signals-not-forwarded-to-sandbox.md).

### 89. agents-md-overlay-states-real-home
[TESTED_BY](/tests/scoder.test.ts#testAgentsMdOverlayStatesRealHome)

Renamed from `agents-md-overlay-uses-real-host-home-for-external-tools`. That
test's whole premise — dual-path advice telling the agent the sandbox home
differs from the real host home, because MCP servers running outside the
sandbox only understand the real one — is obsolete now that the sandbox's
own `$HOME` *is* the real host `$HOME` (see path-mirroring): there is only
one path to state. The overlay now just says `$HOME` (stated literally, via
`getRealHome()`) is the real host home directory, and paths under it resolve
the same way inside and outside the sandbox. This test asserts that text and
that no `/home/scoder` string survives anywhere in the overlay.

### 90. update-alternatives-state-mounted
[TESTED_BY](/tests/scoder.test.ts#testUpdateAlternativesStateMounted)

`update-alternatives --list <name>` run inside the sandbox produces the
identical output to running it directly on the host — not just "does not
error" — proving `/var/lib/dpkg/alternatives`/`/var/lib/alternatives` is
mounted and faithfully reflects the host's real alternative state. Reuses
the daemonize-then-exit fake pasta shim from case 64 so the real scoder
binary runs this end-to-end without depending on a working
`/dev/net/tun`. Self-skips if `update-alternatives` isn't installed, or the
host has no registered alternatives to probe against — see
[design/implementation/issues/update-alternatives-state-not-mounted.md](/design/implementation/issues/update-alternatives-state-not-mounted.md).

### 91. opt-mounted
[TESTED_BY](/tests/scoder.test.ts#testOptMounted)

`ls /opt` run inside the sandbox produces the identical output to running
it directly on the host, proving `/opt` is mounted and faithfully reflects
the host's real content — not just "the bind flag is present in
`--dry-run`". No fixture is written under `/opt` itself (root-owned host
system state; this suite otherwise never mutates anything outside its own
throwaway temp repos), and it reuses the same fake pasta shim as case 64.
Self-skips if `/opt` does not exist on the host at all. See
[design/implementation/issues/opt-not-mounted.md](/design/implementation/issues/opt-not-mounted.md).

### 92a. gui-preset-binds-xpra-socket-not-host-x11
[TESTED_BY](/tests/scoder.test.ts#testGuiPresetBindsXpraSocketNotHostX11)

A GUI preset's sandbox gets the xpra socket directory bound read-write and
`XPRA_SOCKET` set, and gets **none** of the host X11 access ADR 0002
accepted: no `/tmp/.X11-unix`, no `XAUTHORITY`, no `.Xauthority`, no
`DISPLAY` passthrough. `DISPLAY` is set in the environment for this run
deliberately, since a host with a real X session is where a regression
would be most likely to "work".

The negative half is the point. A future change could silently reintroduce
host X11 access — a preset gaining a convenience bind, someone fixing a
display problem the quick way — and everything would still function,
without the isolation. Nothing else would catch it: the window looks
identical either way. See
[0003-xpra-gui-isolation](/architecture/decision-records/0003-xpra-gui-isolation.md).

### 92b. rstudio-preset-binds-config-dirs
[TESTED_BY](/tests/scoder.test.ts#testRstudioPresetBindsConfigDirs)

The `rstudio` preset binds `~/.config/rstudio` and `~/.local/share/rstudio`
read-write.

### 93. rstudio-preset-binds-dev-dri-when-present
[TESTED_BY](/tests/scoder.test.ts#testRstudioPresetBindsDevDriWhenPresent)

Regression test: reported directly, RStudio Desktop (Electron/Chromium)
showed a white window then crashed with `SIGILL` ("Illegal instruction
(core dumped)") once `/dev` was narrowed to a fixed list of real device
nodes that never included `/dev/dri` — Chromium's GPU process, unable to
open a DRM render node, hits an internal `CHECK()` failure (compiled to
a hardware trap in release builds) rather than falling back to software
rendering cleanly. `guiDisplayBinds` (`src/tools/presets.ts`, shared with
`eclipse`) now binds it via `--dev-bind` — not `--ro-bind`, which grants
no real device-node access — when it exists on the host, absent
otherwise (asserted either way, so the test is meaningful whether or not
the machine running the suite has a GPU).

### 94. rstudio-preset-includes-pi-config
[TESTED_BY](/tests/scoder.test.ts#testRstudioPresetIncludesPiConfig)

`pi` runs inside RStudio's own embedded terminal, so the `rstudio` preset
also includes pi's data/cache binds — via a shared `piConfigBinds` helper
both presets call, not a second, separately-maintained copy of the list.

### 95, 96. *(removed in 2.6.0)*

`rstudio-preset-binds-xauthority-when-present` and
`rstudio-preset-skips-xauthority-when-absent` asserted the shape of the
`XAUTHORITY` passthrough — that the cookie file was bound and the env var
pointed at the sandbox copy rather than the host path. There is no
`XAUTHORITY` passthrough any more (ADR 0003), and case 92a asserts its
absence, which is the invariant worth holding. Removed rather than
adapted: nothing was left for them to test.

### 96b. sandbox-processes-reaped-when-session-dies
[TESTED_BY](/tests/scoder.test.ts#testSandboxProcessesReapedWhenSessionDies)

A force-killed session (two SIGINTs, the documented escape hatch) leaves
**nothing** running in the sandbox's mount namespace. Regression test for a
leak that accumulated seven RStudio instances on one machine, each carrying
an Electron stack, an `rsession`, a Tomcat and a language server — see
"Nothing outlives the sandbox" in `ide-companion` for why `--die-with-parent`
does not cover it.

Asserts on the namespace being empty rather than on one tracked pid being
gone, because that is the actual contract and the difference is not
academic: a pid-based version of this fix left xpra's `Xvfb` and
`dbus-daemon` behind every time.

Two things this case had to get right, both of which it got wrong first:

- The namespace is found via a process whose **argv[0]** is the fake IDE's
  command, not via a substring of the whole command line. scoder nests two
  bwrap layers and the outer one's argv contains the entire inner command, so
  a substring match returns the *outer* layer's namespace — where nothing
  sandboxed lives. That made the test pass against a deliberately broken
  reaper.
- Two SIGINTs, not SIGTERM or SIGKILL. scoder handles neither of the latter,
  so both kill it outright and no teardown runs; the test would then be
  asserting a gap rather than the fix.

Confirmed to fail with the reaper disabled and pass with it, which is the
only evidence that a regression test is worth having.

### 96c. overlay-tracks-host-edits
[TESTED_BY](/tests/scoder.test.ts#testOverlayTracksHostEdits)

A host edit reaches the staged file; an unchanged host file produces no
rewrite, so the watcher stays quiet rather than logging every tick; a missing
source renders as the injection alone and starts tracking the file if it
appears later.

Asserts the injection appears **exactly once** after several rounds of
editing, which is the invariant worth protecting: rendering from the previous
output rather than from the source would duplicate it on every refresh, and
would not show up until the host file had been edited twice.

### 96d. overlay-prepends-when-asked
[TESTED_BY](/tests/scoder.test.ts#testOverlayPrependsWhenAsked)

`position: "prepend"` puts the injection before the host content, with no
leading blank line when the source is absent. The motivating case is an
`.Rprofile`: R evaluates it top to bottom, so appending a session
registration would be silently useless.

### 97. gui-display-is-private-end-to-end
[TESTED_BY](/tests/scoder.test.ts#testGuiDisplayIsPrivateEndToEnd)

Replaces `rstudio-x11-connectivity-end-to-end`, whose premise 2.6.0
inverts. That case asserted a real X client inside the sandbox reached a
real X server *outside* it — the behaviour ADR 0002 accepted and 0003
withdraws. Reaching the host's display is now the failure, so the assertion
is turned around rather than dropped.

A GUI program launched as the `rstudio` tool through the real scoder binary
gets a working display (`xdpyinfo` reports one), it is xpra's own virtual
display inside the sandbox rather than the host's disposable Xvfb, and the
host's is unreachable from in there. Still the one case that actually
launches the sandbox rather than inspecting `--dry-run` output, and reuses
the same fake pasta shim.

Runs with a 60s timeout rather than bun's 5s default: the xpra server takes
~3s to create its socket, on top of Xvfb starting and a real sandbox
launch. Self-skips without `xpra`/`Xvfb`/`xdpyinfo`, or if a real `rstudio`
is installed — the fake it writes to `~/.local/bin/rstudio` carries a
marker comment so that a leftover from a killed run is recognised as
scoder's own rather than read as a real install, which would otherwise skip
this case silently on every subsequent run.

### 98. rstudio-preset-passes-through-xdg-runtime-and-dbus
[TESTED_BY](/tests/scoder.test.ts#testRstudioPresetPassesThroughXdgRuntimeAndDbus)

`XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` are set inside the
sandbox when present on the host — the (unverified, well-motivated) fix
for RStudio's reported greyed-out menus. See
[0002-rstudio-x11-access](/architecture/decision-records/0002-rstudio-x11-access.md).

### 99. rstudio-resolveargs-picks-rproj-file
[TESTED_BY](/tests/scoder.test.ts#testRstudioResolveargsPicksRprojFile)

With a `.Rproj` file at the project root and no explicit argument,
`rstudio` is launched with that file's sandbox-side path — fixes RStudio
starting with `getwd()` at `$HOME` rather than the project.

### 100. rstudio-resolveargs-falls-back-to-project-dir
[TESTED_BY](/tests/scoder.test.ts#testRstudioResolveargsFallsBackToProjectDir)

With no `.Rproj` file, `rstudio` is launched with the project directory
itself.

### 101. rstudio-resolveargs-does-not-override-explicit-args
[TESTED_BY](/tests/scoder.test.ts#testRstudioResolveargsDoesNotOverrideExplicitArgs)

An explicit argument (e.g. a specific file to open) is left untouched,
even when a `.Rproj` file is present.

### 102. ide-flag-merges-companion-binds
[TESTED_BY](/tests/scoder.test.ts#testIdeFlagMergesCompanionBinds)

`--ide` merges the companion's own binds (`rstudio`'s xpra display) into
the one sandbox alongside the primary tool's own — deduplicated: an entry
both presets independently contribute (`pi`'s own binds, since `rstudio`
includes them so `pi` also works from its embedded terminal) appears
once, not twice. See
[ide-companion](/design/features/ide-companion.md).

### 103. ide-flag-works-before-or-after-tool-name
[TESTED_BY](/tests/scoder.test.ts#testIdeFlagWorksBeforeOrAfterToolName)

`--ide rstudio` is recognised whether it appears before or after the
primary tool's own name (`scoder --ide rstudio pi` and
`scoder pi --ide rstudio` are equivalent) — every other scoder flag only
parses before the tool name.

### 104. ide-must-differ-from-primary-tool
[TESTED_BY](/tests/scoder.test.ts#testIdeMustDifferFromPrimaryTool)

`--ide` naming the same tool as the primary fails with a clear error.

### 105. ide-requires-registered-preset
[TESTED_BY](/tests/scoder.test.ts#testIdeRequiresRegisteredPreset)

`--ide` naming a tool with no registered preset fails with a clear error,
rather than silently launching it with no binds (and so, for a GUI IDE,
failing silently in its own background job).

### 106. ide-companion-background-then-primary-foreground-both-must-exit
[TESTED_BY](/tests/scoder.test.ts#testIdeCompanionBackgroundThenPrimaryForegroundBothMustExit)

The one real end-to-end case: the primary tool exits immediately, but
scoder does not return until the companion's own background job (an
artificial delay) has also finished, and that job's side effect (a
marker file) is visible afterward — proving it ran to completion, not
just that the wrapper script looks right in `--dry-run` output. Also
confirms scoder reports the primary tool's exit code, not the
companion's. Reuses the fake pasta shim established earlier in this
suite. Self-skips if a real `pi` or `rstudio` is already installed on the
test-running machine, so it never shadows either.

### 107. rstudio-preset-sets-mcptools-socket-dir
[TESTED_BY](/tests/scoder.test.ts#testRstudioPresetSetsMcptoolsSocketDir)

`MCPTOOLS_SOCKET_DIR` is set to a fixed, always-writable sandbox path
(`/tmp/mcptools`), unconditionally — unlike the `XDG_RUNTIME_DIR`/D-Bus
passthrough, not gated on any host env var. Fixes
`mcptools::mcp_session()` failing with "Socket directory
/run/user/<uid>/mcptools is a symlink; refusing to use it." — `/run` is
read-only inside the sandbox, so `mcptools`' own default location can
never be created there regardless of what's already at that path on the
host.

### 108. worktrees-parent-dir-bound-regardless-of-mode
[TESTED_BY](/tests/scoder.test.ts#testWorktreesParentDirBoundRegardlessOfMode)

The directory that will hold a project's scoder worktree(s)
(`getWorktreesParentDir` in `src/git/worktree.ts` — `$HOME/<dirname(projDir)>
/worktrees/<basename(projDir)>`, without the trailing `/scoder`) is ensured to exist and
bound read-write on *every* session, not just `--worktree` ones —
preparatory infrastructure for explicitly supporting multiple named
worktrees from within a direct-mode session in future (see
git-worktree-isolation). Runs a direct-mode (`--no-worktree`) session and
checks the directory exists on disk afterward — the real `mkdir` happens
while building the bwrap command, before pasta ever gets a chance to fail,
same reasoning as `agentreadonly-created-default`'s "file exists before that
point is reached" pattern — then a separate `--dry-run` invocation checks the
expected `--bind <dir> <dir>` entry appears in the built command. `--dry-run`
itself stays side-effect free (matching `getAgentPortsBind`'s auto-detect
step and `describeSshAccess`): it skips the real `mkdir`, so only the
preview is checked there.

### 109. dev-minimal-real-nodes
[TESTED_BY](/tests/scoder.test.ts#testDevMinimalRealNodes)

Regression test for `/dev` exposure: an earlier `--dev-bind /dev /dev`
gave the sandbox the host's entire real `/dev` — every raw disk, TPM,
USB, and other device node on the machine — opened for early testing
and never narrowed down until now. A later attempt to replace it with
bwrap's own synthetic `--dev` construction was reverted: confirmed
directly that `--dev` alone fails to initialize the sandbox on at least
one real host (bwrap itself failing, surfaced only as a generic,
uninformative pasta attach error with no indication `/dev` was the
cause — see `design/features/network-isolation.md`). Settled on
individual `--dev-bind` of specific real host device nodes (`null`,
`zero`, `urandom`, `random`, `tty`, `pts`, `fd`) plus a `--tmpfs` for
`/dev/shm` — narrows exposure without bwrap's own synthetic
construction, confirmed working directly for both a plain tool
(`scoder pi`) and a GUI companion (`scoder --ide eclipse pi`).

### 110. dev-pts-ptmx-shadowed-by-working-top-level-device
[TESTED_BY](/tests/scoder.test.ts#testDevPtsPtmxShadowedByWorkingTopLevelDevice)

Regression test: reported directly, on a real host, the devpts-internal
`/dev/pts/ptmx` node (exposed only because the whole `/dev/pts`
directory is bound above) carries mode `0000` — locked down by that
host's own devpts configuration — while the top-level `/dev/ptmx` bound
separately is mode `0666` and demonstrably works. Some native pty
libraries open the per-instance `/dev/pts/ptmx` specifically rather
than the top-level symlink. Confirms a later, narrower `--dev-bind` at
`/dev/pts/ptmx`, sourced from the confirmed-working top-level device,
appears after the broader `/dev/pts` bind it shadows — ordering is
load-bearing, since a shadow bind before the directory it shadows would
itself be overridden by that directory instead.

### 111. direct-mode-requires-git-repo
[TESTED_BY](/tests/scoder.test.ts#testDirectModeRequiresGitRepo)

Direct mode used to silently tolerate a non-git directory — git commands
elsewhere (`addGitExclude`/`removeGitExclude` for the AGENTS.md overlay
mask, `getProjDir`'s repo-root resolution) just no-op or fall back to `cwd`
without checking exit codes, so nothing crashed, but there was no
undo/audit trail for whatever the agent did there. It now refuses (exit 1,
`not inside a git repository`) the same way worktree mode always has,
checked before any sandbox setup. Runs `scoder --no-worktree` against a
plain `mkdir`'d directory (no `git init`) and asserts the refusal.

### 112. worktree-mode-requires-git-repo
[TESTED_BY](/tests/scoder.test.ts#testWorktreeModeRequiresGitRepo)

Parity coverage for the same requirement in worktree mode — already
enforced by `setupGitWorktree`'s own check, but until now untested
directly. Same shape as case 96, with `-w` instead of `--no-worktree`.

### 113. ide-companion-detached-from-controlling-terminal
[TESTED_BY](/tests/scoder.test.ts#testIdeCompanionDetachedFromControllingTerminal)

Regression test: reported directly, IDE error output still reached the
console mid-session despite the existing `>"$IDE_LOG" 2>&1` redirect — a
JVM's native crash handler or a GTK/X11 error dialog can write straight
to `/dev/tty` (the controlling terminal) rather than its own inherited
stdout/stderr, which redirecting fds 1 and 2 alone does not catch.
`wrapWithIdeBackground` (`src/sandbox/builder.ts`) now backgrounds the
IDE under `setsid`, with stdin from `/dev/null` — `setsid` makes it its
own session leader with no controlling terminal at all, so a direct
`/dev/tty` open from inside it fails instead of reaching the visible
console.

*(Note: the `--ide` companion feature's other tests — the screen-clear,
ENTER-to-close, and shutdown-order behavior already implemented and
tested — predate this entry and are not yet individually catalogued
here; `em doc`'s test-count check currently reflects that pre-existing
gap, unrelated to this specific fix.)*

## Current Network Coverage

- Host loopback access is blocked (`host-loopback-blocked`)
- A port listed in `.agentports` can be reached (`agentports-forwards-listed-port`)
- Auto-detection of an open LLM port appends it to `.agentports` (`agentports-auto-detect-appends`)
- Editing `.agentports` mid-session live-reloads pasta (`agentports-live-reload-adds-port`, `agentports-live-reload-bad-edit-keeps-old-config`)
- A missing `.agentports` is created and stays protected in the same session (`agentports-created-if-missing`, `agentports-missing-file-not-writable-from-sandbox`)
- Outbound DNS resolution works (`outbound-dns-works`)
- Terminal signals (resize, Ctrl-C) reach the sandboxed process despite `--new-session` (`terminal-signals-forwarded-to-sandbox`)

## Test Implementation Notes

### Environment Variable Passing

Some tests override `HOME` via the `runScoder()` helper's `env` parameter:

```typescript
const output = await runScoder(repoDir, ["-q", "/bin/bash", "-c", "echo $HOME"], {
  HOME: fakeHome,
});
```

### Server Cleanup

Tests that create HTTP servers must clean them up in a `finally` block:

```typescript
const server = Bun.serve({ ... });
try {
  // test logic
} finally {
  server.stop();
}
```

### Worktree Detection

The `existing-scoder-worktree-reused` test parses `git worktree list --porcelain`
output to find the worktree directory, then runs scoder from that directory.

The `worktree-recreated-if-missing` test identifies the scoder branch worktree
(skipping the main worktree) by looking for `branch refs/heads/scoder/*` entries.

### Git Skip-Worktree Detection

Tests use `git ls-files -v` to check `--skip-worktree` state: uppercase `S`
means skip-worktree, uppercase `H` means normal staged file.

### Mock ssh Server

`startMockSshd()` starts a disposable `sshd` on a fixed port (`19996`) with an
ephemeral host key and an ephemeral client key authorized for the *current*
user — `sshd` authenticates against real system accounts, so there is no
fabricated identity to log in as, only a throwaway key for a real one.

It also writes a `ssh` shim ahead of the real one on `PATH`:
`exec /usr/bin/ssh -F <tmp>/client_config "$@"`. This is what redirects the
*host-side master connection* `startSshTunnel` opens to the mock server's
port and identity. Overriding `$HOME` does not work for this — confirmed
directly while building the fixture: ssh resolves `~/.ssh/config` via
`getpwuid()`, not `$HOME` (the same identity quirk documented in
[ADR 0001](/architecture/decision-records/0001-sandbox-uid-and-networking-composition.md)),
so `HOME=<fixture> ssh -G host` still reports the real config's settings. The
shim never affects the *sandboxed* ssh invocation under test: `bwrap
--clearenv` wipes the host `PATH`, and the generated
`$HOME/.ssh/config` is read correctly because `getpwuid()` resolves to the
real `$HOME` inside the sandbox — that's what `setupSandboxIdentity` is for.

### Temp Directory Cleanup

All tests create repos under a shared `TEST_BASE` directory, which is removed
by the `cleanup()` function in a finally block.
