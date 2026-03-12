# Hooks Design (v1)

## Scope

This is a minimal host-side hooks feature for real workflows we need now:

- `post_worktree_create`: run after orka creates the worktree
- `pre_merge`: run before `orka merge`

These cover the current use cases:

- bootstrap a worktree (`bun install`, copy `.env`, generate local files)
- block merges when repo checks fail

## Config

Hooks live in `~/.orka/config.toml` as simple shell command strings.

```toml
[hooks]
post_worktree_create = "bun install"
pre_merge = "bun test"
```

If a hook is unset or empty, it does not run.

Commands run on the host with a hardcoded 60 second timeout.

## Execution

- `post_worktree_create` runs after the worktree exists and before the agent starts
- `pre_merge` runs immediately before merge logic starts
- hooks run with `sh -lc "<command>"`
- non-zero exit stops the current operation
- stdout/stderr are appended to the session log
- `--no-hooks` skips all hooks for that command

## Environment Variables

Hooks receive the daemon environment plus:

- `ORKA_SESSION_ID`: session id when the hook is tied to a session
- `ORKA_WORKTREE_DIR`: absolute path to the session worktree
- `ORKA_PROJECT_PATH`: absolute path to the main project root

## Example

```toml
[hooks]
post_worktree_create = "test -f package.json && bun install; test -f \"$ORKA_PROJECT_PATH/.env\" && cp -f \"$ORKA_PROJECT_PATH/.env\" \"$ORKA_WORKTREE_DIR/.env\" || true"
pre_merge = "bun test"
```

## Deferred

Not in v1:

- more hook stages
- JSON context files
- directory-based hooks
- append/replace strategies
- configurable timeouts
- hook ordering/chaining
- per-project overrides
- templates
- trust/security policy work
