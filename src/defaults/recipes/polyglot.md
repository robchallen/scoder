# Polyglot projects

## When to use

More than one of the language recipes applies (say a Java backend with a
TypeScript frontend, or R analysis with Python tooling).

## Env, Ports, Read-only binds, Read-write binds, MCP servers

The union of the matching recipes, with duplicates removed. Prefer the
narrowest grant that covers both (one `$HOME/.local/bin/<tool>` line, not
the whole directory), and say which recipe each line came from when
explaining it to the user.
