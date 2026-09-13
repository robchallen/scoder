# `com.seeq.eclipse.importprojects_1.4.0.jar`

Vendored, pinned build of the [`seeq12/eclipse-import-projects-plugin`](https://github.com/seeq12/eclipse-import-projects-plugin)
(MIT licensed), used by the `eclipse` preset (`src/tools/presets.ts`) to
generate an Eclipse workspace dynamically at launch — see
`design/implementation/plans/eclipse-preset.md` for the full investigation.

- **Source**: `jar/com.seeq.eclipse.importprojects_1.4.0.jar` in the
  upstream repo, release `1.4.0`.
- **sha256**: `133c61b284c61b889836560c06619e1ff3619080b733537f4137d1accb28ab2d`
- **Size**: 8283 bytes.

## Why this exact build, not `master`

The plugin's `master` branch is ahead of this build in a way that changes
the actual command-line flag: `master`'s own source (and its README's
"Usage" section) use `-importProject`, but this compiled `1.4.0.jar`
(confirmed directly with `javap -c -p -constants`) uses the older
`-import` — the flag was seemingly renamed in an unreleased `2.0.0`.
Passing `-importProject` to this jar fails completely silently (exit 0, no
log entry, nothing imported). scoder's own `prepareCommand` uses `-import`
to match what this exact jar actually does.

**Do not bump this jar to a newer build without re-verifying by hand**,
the same way this one was verified: confirm the real compiled flag name
with `javap`, and re-run the full headless-import scenario described in
`eclipse-preset.md`'s Verified Groundwork table before trusting it.
