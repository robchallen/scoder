# scoder sandbox behavior

This note summarises the scoder-specific behavior that the
`working-in-a-scoder-sandbox` skill relies on.

## Key facts

1. A scoder session starts from the user's current `HEAD`, not specifically
   from `main`.
2. **Worktree mode (default):** The session branch is `scoder/<repo-name>`.
3. **Worktree mode:** The live sandbox worktree lives under `/tmp/scoder/<git-repo-path>`.
4. If scoder is launched from that same scoder worktree later, it reuses the
   current checkout instead of trying to create a new worktree.
5. The project worktree is writable, but system paths are read-only.
6. Protected paths such as `.github/`, `.gitignore`, lockfiles, and
   `.agentreadonly` are read-only by default.
7. An empty tracked `.agentreadonly` removes the default protected workspace
   list, but `.agentreadonly` itself remains protected.
8. To bring in upstream `main` changes from inside the sandbox, prefer
   `git fetch origin` followed by `git rebase origin/main` or
   `git merge origin/main`.
9. **Worktree mode:** Other checkouts only observe sandbox progress through committed branch
   updates. Uncommitted edits remain local to the `/tmp/scoder/...` worktree.
10. **Direct mode (`--no-worktree`):** No branch is created. Changes happen
    directly in the current working directory. `.agentreadonly` protection still
    applies. `AGENTS.md` overlay is created but without worktree-specific messages.

## Sources

- `README.md`
- `DESIGN.md`
- `TEST_SCRIPTS.md`
