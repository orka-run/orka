# Hooks

Hooks are shell commands Orka runs at specific points in a session lifecycle.

In the current implementation, hooks run on the host with `bash -c "<command>"`. The working directory is set to the session worktree, so relative paths resolve inside that worktree.

## What Are Hooks

Use hooks to prepare a fresh worktree automatically, for example:

- install dependencies
- copy local env files
- run a repo-specific setup script

`post_worktree_create` runs whenever Orka creates a git worktree for a session. That includes background sessions and sessions started with an explicit branch.

## Available Hooks

### `post_worktree_create`

Status: implemented

Runs after the git worktree is created and before work starts in that worktree.

### `pre_merge`

Status: designed, not implemented in this tree

The internal design doc includes a `pre_merge` hook for `orka merge`, but the current config parser and merge path do not execute it yet.

## Config Format

Hooks live in `~/.orka/config.toml`.

### Single string

```toml
[hooks]
post_worktree_create = "bun install"
```

### Array of strings

```toml
[hooks]
post_worktree_create = ["bun install", "cp -f .env.example .env"]
```

Commands run in order.

### Array of tables

```toml
[[hooks.post_worktree_create]]
run = "bun install"

[[hooks.post_worktree_create]]
run = "cp -f .env.example .env"
```

This is useful when you want one TOML block per command.

## Environment And Working Directory

Hooks inherit the daemon process environment.

In the current implementation, Orka does not add hook-specific variables such as `ORKA_SESSION_ID`, `ORKA_WORKTREE_DIR`, or `ORKA_PROJECT_PATH`.

What Orka does set today:

- working directory: the session worktree path
- shell: `bash -c`
- stdout/stderr: inherited by the daemon process

Because the working directory is already the worktree, these usually work:

```toml
[hooks]
post_worktree_create = "bun install"
```

```toml
[hooks]
post_worktree_create = "cp -f .env.example .env"
```

If you need files from outside the worktree, use an absolute path or a wrapper script.

## Error Handling

`post_worktree_create` is best-effort:

- empty commands are ignored
- commands run in order
- if one command exits non-zero, Orka prints a warning
- session creation continues
- later hook commands still run

A failing hook does not block worktree creation.

## `--no-hooks`

The internal design doc mentions a `--no-hooks` flag, but the current CLI does not implement it.

If you need to skip hooks today, remove or comment out the hook config before starting the session.

## Practical Examples

### Install dependencies

```toml
[hooks]
post_worktree_create = "bun install"
```

### Copy env files

If the source file is committed in the repo, keep it simple:

```toml
[hooks]
post_worktree_create = "cp -f .env.example .env"
```

If you need to copy from the main project checkout, use a wrapper script or an absolute path. The design doc shows `$ORKA_PROJECT_PATH`, but that variable is not currently injected.

### Run a setup script

```toml
[hooks]
post_worktree_create = "./scripts/setup-worktree.sh"
```

### Full setup with multiple hooks

```toml
[hooks]
post_worktree_create = [
  "bun install",
  "test -f .env.example && cp -f .env.example .env || true",
  "./scripts/setup-worktree.sh"
]
```
