# Provider Runtime Migration Status

Updated on 2026-03-11 after verifying the live CLI, daemon config, daemon server, orchestrator, provider runtime, dashboard transport, and SQLite setup.

## Current State

The migration is complete enough that the provider runtime is now the default production path.

- The CLI is daemon-only for normal operations. `packages/cli/src/index.ts` now routes daemon-backed commands through `RemoteClient` and only uses `LocalClient` inside `orka serve`.
- If the local daemon is not healthy at `http://127.0.0.1:7394/health`, the CLI auto-starts it with `setsid bun run <cli-path> serve`.
- The detached daemon writes `~/.orka/daemon.pid` and logs to `~/.orka/logs/daemon.log`.
- `providers.use_runtime` defaults to `true` in `packages/daemon/src/config.ts`.
- `spawnSession()` in `packages/daemon/src/orchestrator.ts` now dispatches to the provider adapter system by default and only uses the script-plus-tmux path when `providers.use_runtime = false`.

## Live Execution Path

For a normal local CLI command:

1. The CLI resolves a daemon connection.
2. If needed, it auto-starts the local daemon.
3. The CLI uses JSON-RPC over WebSocket via `RemoteClient`.
4. The daemon handles the request through `LocalClient`.
5. Session orchestration, SQLite access, approvals, worktree management, and log/result retrieval all happen inside the daemon.

For a spawned session on the default path:

1. `spawnSession()` creates the task/session records, worktree, and log file.
2. `ProviderService` starts the adapter for `claude-code` or `codex`.
3. `consumeProviderEvents()` feeds provider events into `OrchestrationEngine`.
4. Orchestration events are persisted in SQLite.
5. Session output is reconstructed from persisted orchestration events, while logs remain available for diagnostics and streaming.

This is the key architectural change from the earlier rollout plan: the runtime is no longer dormant or gated off by default.

## Runtime and Persistence Model

The current provider runtime is composed from:

- `ProviderAdapterRegistry`
- `ClaudeCodeAdapter`
- `CodexAdapter`
- `ShellAdapter`
- `ProviderService`
- `OrchestrationEngine`
- `consumeProviderEvents()`

The daemon persists orchestration events with `insertOrchestrationEvent()` and reads them back with `getOrchestrationEvents()`. On the runtime path:

- `captureOutput()` prefers persisted orchestration events
- `getResult()` builds the result from the orchestration timeline
- usage records are written from `turn.completed` events
- approvals are tracked by `ApprovalManager`

## Legacy Compatibility Path

tmux has not been removed entirely, but it is no longer the primary architecture.

- The script-file and tmux runner still exist as a fallback path.
- That path is used only when `[providers] use_runtime = false`.
- `reapSessions()` still contains tmux-oriented cleanup logic for that fallback path.
- `orka attach` no longer attaches to tmux; it streams live output by polling daemon-side captured output.

When updating docs or code, describe tmux as a compatibility path, not as the default runtime.

## Daemon and Dashboard Notes

- The daemon listens on `ws://127.0.0.1:7394` by default and exposes `/health` over HTTP on the same port.
- The dashboard does not connect directly to the daemon port in browser-facing docs. Both Vite dev and nginx prod use a same-origin `/ws` proxy path.
- Relay mode is unchanged at a high level: clients still speak JSON-RPC over WebSocket, optionally through the relay and optionally with end-to-end encryption.

## SQLite Notes

SQLite remains daemon-owned state. The daemon configures:

- `PRAGMA journal_mode = WAL`
- `PRAGMA busy_timeout = 5000`
- `PRAGMA foreign_keys = ON`

The `busy_timeout` pragma is now part of the expected architecture and should be documented anywhere we describe daemon-owned SQLite access.

## What Changed From The Original Plan

The earlier version of this document assumed:

- provider runtime was not wired into the live path
- the rollout flag should default off
- result/output APIs still depended entirely on tmux and log scraping

Those assumptions are no longer current. The provider runtime is active by default, the CLI is daemon-only, and session reads now use the orchestration event store first with legacy log/tmux behavior retained only for compatibility.
