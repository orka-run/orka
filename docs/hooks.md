# Hooks

Hooks are shell commands Orka runs at specific points in a session lifecycle.

Commands run on the host with `bash -c "<command>"`. The working directory is the session worktree, so relative paths resolve inside it.

## `post_worktree_create`

Runs after the git worktree is created and before the agent starts. Use it to prepare a fresh worktree:

- install dependencies
- copy local env files
- run a repo-specific setup script

## Configuration

Hooks live in `~/.orka/config.toml` under `[hooks]`.

### Single command

```toml
[hooks]
post_worktree_create = "bun install"
```

### Multiple commands

```toml
[hooks]
post_worktree_create = ["bun install", "cp -f .env.example .env"]
```

Commands run in order.

### Table format

```toml
[[hooks.post_worktree_create]]
run = "bun install"

[[hooks.post_worktree_create]]
run = "cp -f .env.example .env"
```

## Error Handling

`post_worktree_create` is best-effort:

- empty commands are ignored
- commands run in order
- if one command exits non-zero, Orka prints a warning
- session creation continues regardless
- subsequent hook commands still run

A failing hook does not block the session.

## Environment

Hooks inherit the daemon process environment. The working directory is set to the session worktree path, so commands like `bun install` work without extra configuration.

If you need files from outside the worktree, use absolute paths or a wrapper script.

## Examples

### Install dependencies

```toml
[hooks]
post_worktree_create = "bun install"
```

### Copy env files

```toml
[hooks]
post_worktree_create = "cp -f .env.example .env"
```

### Run a setup script

```toml
[hooks]
post_worktree_create = "./scripts/setup-worktree.sh"
```

### Full setup

```toml
[hooks]
post_worktree_create = [
  "bun install",
  "test -f .env.example && cp -f .env.example .env || true",
  "./scripts/setup-worktree.sh"
]
```
