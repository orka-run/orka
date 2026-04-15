# Orka

Agent session orchestrator for AI coding agents. Run Claude Code or Codex
as isolated sessions, watch them live, and merge results back into your repo.

> **WARNING: Early development — no security hardening yet.**
>
> - **No local auth.** Anyone with network access to the daemon port (default 7394)
>   can spawn sessions, read logs, and execute arbitrary commands. Do not expose
>   the daemon to untrusted networks.
> - **Agents run with full permissions.** Background Claude Code sessions use
>   `--permission-mode bypassPermissions` — the agent can read, write, and execute
>   anything on the host without approval prompts. Sessions run in isolated git
>   worktrees, but there is no filesystem sandbox beyond that.
>
> Proper access controls and sandboxing are planned but not yet implemented.

## Features

- **Multiple backends** — Claude Code (Opus), Codex (GPT)
- **Parallel sessions** — run many agents simultaneously with isolated git worktrees
- **Live streaming** — attach to running sessions, stream logs and structured events
- **Smart worktree management** — auto-create, protect uncommitted work, merge on completion
- **Multi-machine** — route sessions across machines through a relay with Noise_NK encryption
- **Secure pairing** — SPAKE2 bootstrap for zero-trust node enrollment
- **Interactive & background modes** — foreground conversations or fire-and-forget tasks
- **Event-sourced** — full session timeline with cost, tokens, and result extraction
- **Dashboard** — React web UI for monitoring sessions in real time

## Quick Start

```bash
# Install dependencies
bun install

# Symlink CLI (optional)
ln -s "$(pwd)/orka" ~/.local/bin/orka

# Spawn a background session (daemon auto-starts)
orka spawn "refactor the auth module"

# Watch it work
orka attach <session-id>

# See all sessions
orka ps

# Inspect changes and merge
orka diff <session-id>
orka merge <session-id>
```

## How It Works

```
orka CLI ──WS──▶ Daemon ──▶ Provider Runtime ──▶ Agent Process
                   │              │
                   │              ├── ClaudeCodeAdapter
                   │              └── CodexAdapter
                   │
                   ├── SQLite (sessions, events, config)
                   ├── Git worktrees (~/.orka/worktrees/)
                   └── Session logs (~/.orka/logs/)
```

The CLI talks to the daemon over WebSocket JSON-RPC. If no daemon is running,
the CLI auto-starts one. The daemon owns all state: SQLite, worktrees,
orchestration, and provider lifecycle.

For multi-machine setups, a relay routes traffic between CLI clients and
remote daemon nodes. Noise_NK encryption ensures the relay never sees
RPC payloads.

```
CLI ──WS──▶ Relay ──WS──▶ Node A (daemon)
                   └─WS──▶ Node B (daemon)
```

## CLI Commands

### Session Lifecycle

| Command | Description |
|---------|-------------|
| `spawn` | Start an agent session |
| `stop` | Stop a running session |
| `retry` | Re-run with same prompt/model/tags |
| `send` | Send input to an interactive session |
| `wait` | Block until session(s) complete |

### Inspection

| Command | Description |
|---------|-------------|
| `ps` | List sessions (filter by status, backend, tag, project) |
| `show` | Full session detail view |
| `logs` | View session output (`-f` for live streaming) |
| `attach` | Stream live session output (alias for `logs -f`) |
| `diff` | Show git changes in session worktree |
| `result` | Extract final result, cost, and token usage (`--json`) |
| `workdir` | Print session working directory |

### Worktree Management

| Command | Description |
|---------|-------------|
| `merge` | Merge session branch into current branch (auto-cleans worktree) |
| `keep` | Protect a session's worktree from auto-cleanup |
| `unkeep` | Remove worktree protection |
| `prune` | Remove old completed sessions (`--age`, `--project`) |

### Infrastructure

| Command | Description |
|---------|-------------|
| `serve` | Start daemon WS server |
| `relay` | Start relay WS router for multi-machine |
| `keygen` | Manage E2E encryption keys |
| `project` | Register/list/remove project aliases |

## Spawn Options

```bash
# Specify backend and model
orka spawn -b codex --model gpt-5.4 "implement caching layer"

# Interactive mode
orka spawn -m interactive "help me debug this"

# With tags and auto-merge
orka spawn --tag migration --auto-merge "migrate users table to new schema"

# Prompt from file
orka spawn --prompt-file tasks/refactor.md

# Piped prompt
cat spec.md | orka spawn

# Specific branch name
orka spawn --branch feat/new-api "build the new REST API"
```

## Multi-Machine Setup

```bash
# 1. Start relay (central router)
orka relay --port 7390 --token mysecret

# 2. Start daemon nodes
orka serve --port 7394 --relay ws://relay:7390 --node-id node1 --relay-token mysecret

# 3. Pair a new node (secure SPAKE2 bootstrap)
#    On the node:
orka node pair start    # prints: Q7ND-M4KP-2X9F-T6RW-8BHC
#    On the client:
orka node add Q7ND-M4KP-2X9F-T6RW-8BHC

# 4. Use via relay
orka --remote ws://relay:7390/ws --token <api_key> ps

# Or via env vars
export ORKA_REMOTE=ws://relay:7390/ws
export ORKA_TOKEN=<api_key>
orka ps
```

## Configuration

Optional `~/.orka/config.toml`:

```toml
[defaults]
backend = "claude-code"
mode = "background"

[limits]
max_concurrent = 5    # 0 = unlimited

[hooks]
post_worktree_create = "bun install"
```

## Project Structure

```
packages/
  core/       @orka/core       Domain types, schemas, OrkaService, crypto (SPAKE2, Noise)
  daemon/     @orka/daemon     Orchestrator, provider runtime, SQLite, worktrees, WS server
  relay/      @orka/relay      Transparent WS router for multi-machine
  cli/        @orka/cli        CLI entry point (20+ commands)
  dashboard/  @orka/dashboard  React dashboard (Vite + TailwindCSS)
orka          Shell wrapper for global CLI access
```

## Storage

| Path | Purpose |
|------|---------|
| `~/.orka/orka.db` | SQLite session database |
| `~/.orka/logs/daemon.log` | Daemon output |
| `~/.orka/logs/<session>.log` | Per-session logs |
| `~/.orka/worktrees/<session>/` | Isolated git worktrees |
| `~/.orka/config.toml` | User configuration |
| `~/.orka/keys/` | E2E encryption keypairs |
| `~/.orka/nodes/` | Paired node configurations |
| `~/.orka/daemon.pid` | Daemon process ID |

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Language**: TypeScript (strict)
- **Validation**: zod/v4
- **Storage**: SQLite (bun:sqlite)
- **Crypto**: @noble/curves, @noble/ciphers, @noble/hashes
- **Tracing**: OpenTelemetry
- **Dashboard**: React 19, Vite, TailwindCSS, Zustand

## Development

```bash
# Run CLI directly
bun run packages/cli/src/index.ts <command>

# Type-check
bun run typecheck

# Run all tests
bun test packages/ tests/

# Unit tests only
bun test packages/

# E2E tests only
bun test tests/e2e/

# Start daemon + dashboard (auto-spawns Vite dev server when no dist/)
orka serve
```

## Documentation

- [Getting Started](docs/getting-started.md) — installation and first session
- [Pairing Protocol](docs/pairing.md) — SPAKE2 node enrollment
- [Noise Transport](docs/noise-transport.md) — encrypted communication
- [Relay](docs/relay.md) — multi-machine routing
- [Wire Protocol](docs/protocol-spec.md) — JSON-RPC and push protocol
- [Hooks](docs/hooks.md) — worktree lifecycle hooks
