# Orka Docs

Orka is an agent session orchestrator for AI coding agents. It lets you run Claude Code, Codex, or plain shell tasks as isolated sessions, watch them live, and merge useful results back into your repo.

## What Orka does

- Runs multiple agent sessions in parallel
- Creates isolated Git worktrees for background runs
- Streams live logs and structured event output
- Preserves session metadata, usage, and final results
- Merges finished worktrees back into your branch
- Routes sessions across machines through a relay, with optional end-to-end encryption

## Architecture

Normal CLI commands talk to the daemon over WebSocket JSON-RPC.

```text
orka CLI
  -> local or remote daemon
  -> provider runtime / backend adapters
  -> agent process (claude-code, codex, shell)
```

Key flow:

1. `orka spawn` resolves the project and session options.
2. The daemon creates a session record and, for background work, a dedicated Git worktree under `~/.orka/worktrees/`.
3. A provider adapter launches the selected agent backend.
4. Session output is streamed, persisted, and exposed through `ps`, `logs`, `attach`, `wait`, `result`, and the dashboard.
5. Finished work can be inspected with `diff` and merged with `merge` or `--auto-merge`.

The daemon is the source of truth for orchestration, SQLite state, worktree lifecycle, and remote access. The CLI auto-starts the local daemon when needed.

## Package structure

- `packages/core` — shared types, schemas, RPC contracts, crypto helpers
- `packages/daemon` — orchestrator, config loading, SQLite, worktrees, provider runtime, WS server
- `packages/cli` — `orka` command-line interface
- `packages/relay` — multi-machine WebSocket relay/router
- `packages/dashboard` — React dashboard over same-origin `/ws`

## Storage layout

- `~/.orka/orka.db` — session database
- `~/.orka/logs/` — daemon log and session logs
- `~/.orka/worktrees/` — isolated worktrees
- `~/.orka/config.toml` — optional user config
- `~/.orka/keys/` — E2E encryption keys

## Backends

- `claude-code` — Anthropic Claude Code CLI
- `codex` — OpenAI Codex CLI
- `shell` — plain shell command execution

`providers.use_runtime = true` is the default, so Orka normally uses the provider runtime instead of the legacy tmux path.

## Docs

- [Getting Started](./getting-started.md) — install, spawn sessions, inspect and merge work
- [Hooks](./hooks.md) — worktree lifecycle hooks configuration

### Internal

- [Hooks Design](./hooks-design.md) — design rationale and future hook stages
- [Provider Migration](./provider-migration-plan.md) — runtime architecture notes
- [Codex Research](./codex-research.md) — backend integration research
