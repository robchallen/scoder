# Java (Maven, Gradle)

## When to use

The project has `pom.xml` (Maven) or `build.gradle` / `build.gradle.kts` /
`settings.gradle*` (Gradle).

## Env

`JAVA_HOME` if the user sets it explicitly; usually not needed (the JDK is
under `/usr` or `/opt`, both visible).

## Ports

None.

## Read-only binds

None for Maven. If `~/.local/bin` holds wrappers the build uses (`mvnd`,
`jmc`, `visualvm`), grant those entries: `$HOME/.local/bin/mvnd`.

## Read-write binds

Maven's local repository — builds write to it:

```
$HOME/.m2
```

### Gradle

Gradle's cache and wrapper distributions instead of (or as well as) `~/.m2`:

```
$HOME/.gradle
```

## Skills

```
java.*|maven.*|gradle.*|junit.*
```

## MCP servers

With `--ide eclipse`, AssistAI's endpoints — see the
"Eclipse: AssistAI" setup under MCP servers in the
`configure-scoder-sandbox` skill.

Eclipse imports dependency projects listed in `.sandbox/readonly` only if
they contain a `.project` file.
