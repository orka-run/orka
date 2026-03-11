# Orka — Agent Session Orchestrator

See also: [AGENTS.md](./AGENTS.md) for issue tracking and agent workflow conventions.

## Commit Policy

**MANDATORY: After completing each task/issue, create a git commit BEFORE moving to the next task.**

- One task = one commit (minimum)
- Commit message format: `<type>: <what changed>` (e.g. `feat: add orka diff command`, `docs: update daemon architecture notes`)
- Stage only relevant files, never `.orka/`, `node_modules/`, `*.db`
- If a beads issue is closed, the corresponding code MUST be committed
- Do NOT batch multiple unrelated tasks into one commit

## Project Structure

```
packages/
  core/     — @orka/core: domain types, zod schemas, OrkaService interface, RPC types
  daemon/   — @orka/daemon: orchestrator, provider runtime, worktree, SQLite, config, tracing,
              LocalClient, RemoteClient, WS server, relay registration
  relay/    — @orka/relay: transparent WS router for multi-machine setups
  cli/      — @orka/cli: CLI entry point (20 commands)
orka        — shell wrapper for global CLI access
```

## CLI Commands

```
spawn   — Spawn an agent session (--backend, --mode, --model, --branch, --title, --prompt-file, --tag, --auto-merge; auto-checks CLI installed)
ps      — List sessions (--status, --backend, --tag, --project, --verbose/-v)
attach  — Stream live session output (alias for `orka logs -f`)
logs    — View session output (--follow/-f for live streaming)
stop    — Stop a running session
diff    — Show git changes in session worktree
show    — Full session detail view (status, project, model, prompt, tags, kept, auto-merge)
workdir — Print session working directory (for shell: cd $(orka workdir <id>))
wait    — Block until session(s) complete (supports --all, --project, multiple IDs)
result  — Extract final result, cost, tokens from provider event history or legacy logs (--json)
send    — Send text input to a running interactive session
keep    — Protect a session's worktree from auto-cleanup
unkeep  — Remove worktree protection
merge   — Merge session worktree branch into current branch (auto-cleans worktree+branch)
retry   — Re-run a session with same prompt/model/title/tags
project — Register/list/remove project aliases
prune   — Remove old completed sessions (--age, --project)
serve   — Start daemon WS server (--port, --relay, --node-id, --encrypt)
relay   — Start relay WS router for multi-machine (--port, --token)
keygen  — Manage E2E encryption keys (client, node, save-server, show)
```

### Daemon Lifecycle

- Normal CLI commands talk to the daemon over WebSocket JSON-RPC.
- If no daemon is running, the CLI auto-starts one with `setsid bun run <cli-path> serve`.
- The daemon PID is written to `~/.orka/daemon.pid`.
- Daemon stdout/stderr is written to `~/.orka/logs/daemon.log`.
- Local-only commands are `serve`, `project`, `keygen`, and `relay`.

### Prompt Input

`orka spawn` accepts prompts from multiple sources (mutually exclusive):
- `--prompt "text"` — inline prompt
- `--prompt-file path` — read prompt from file
- Positional args — `orka spawn do the thing`
- Piped stdin — `echo "task" | orka spawn --backend shell`

### Multi-Machine Mode

```bash
# Start relay (central router)
orka relay --port 7390 --token mysecret

# Start daemon nodes with E2E encryption (register with relay)
orka serve --encrypt --port 7394 --relay ws://relay:7390 --node-id node1 --relay-token mysecret

# CLI: generate keys and save server's public key
orka keygen client
orka keygen save-server $(curl -s http://node1:7394/health | jq -r .publicKey)

# CLI connects via relay with E2E encryption
orka --remote ws://relay:7390/ws --token mysecret --encrypt ps
# Or via env vars
ORKA_REMOTE=ws://relay:7390/ws ORKA_TOKEN=mysecret ORKA_ENCRYPT=1 orka ps
```

## Import Policy

- **Between packages**: use workspace aliases — `import { ... } from "@orka/core"`, `import { ... } from "@orka/daemon"`
- **Within a package**: use relative imports **without file extensions** — `import { ... } from "./db"`, NOT `"./db.js"` or `"./db.ts"`
- Bun resolves `.ts` files from extensionless imports automatically
- Never use `@/` prefix — it doesn't work in Bun monorepo context

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **Validation**: zod/v4 — import as `import { z } from "zod/v4"`. Enum schemas in core/types.ts, config validation, DB row parsing
- **Storage**: SQLite via bun:sqlite (~/.orka/orka.db), versioned migrations in db.ts, `PRAGMA busy_timeout = 5000`
- **Primary session runtime**: provider runtime with adapter registry (`ClaudeCodeAdapter`, `CodexAdapter`, `ShellAdapter`) and persisted orchestration events
- **Legacy session runtime**: tmux fallback when `[providers] use_runtime = false`
- **Worktrees**: ~/.orka/worktrees/<session-id> (OUTSIDE main repo for isolation)
- **Logs**: ~/.orka/logs/<session-id>.log
- **Scripts**: ~/.orka/scripts/<session-id>.sh for the legacy tmux fallback path
- **Config**: ~/.orka/config.toml (optional, TOML with [defaults], [limits], and [providers] sections; `providers.use_runtime = true` by default)
- **Dashboard transport**: dashboard uses same-origin `/ws` in both Vite dev proxy and nginx prod proxy
- **Tracing**: OpenTelemetry (see Observability section)
- **Issue tracking**: beads (`bd` CLI)

## Architecture: OrkaService Interface

The **OrkaService** interface (`@orka/core/service.ts`) is the contract between CLI and daemon. All methods are fully async (return Promise) for network transparency.

**Implementations:**
- **RemoteClient** (`@orka/daemon/remote-client.ts`) — WS JSON-RPC client, used by the CLI for all daemon-backed commands
- **LocalClient** (`@orka/daemon/local-client.ts`) — direct in-process implementation used inside the daemon process (`orka serve`)

**Daemon-only CLI design:**
- The CLI no longer opens SQLite directly and no longer uses `LocalClient` for normal commands.
- `getSvc()` in the CLI always builds a `RemoteClient`, either to `--remote` or to the local daemon at `ws://127.0.0.1:7394`.
- Before building that local client, the CLI health-checks `http://127.0.0.1:7394/health` and auto-starts the daemon when needed.
- The daemon owns SQLite access, orchestration, session state, approvals, and log/result retrieval.

**Protocol:** JSON-RPC 2.0 over WebSocket. Request envelope includes optional `node` field for relay routing. Supports E2E encryption (see below).

**Relay** (`@orka/relay`) — transparent WS router. Reads only `id` and `node` from envelope, forwards payload as-is. Supports:
- Least-loaded node scheduling (tracks active requests per node)
- Auth tokens via `?token=` query param
- Auto-reconnect for daemon nodes (5s backoff)
- `/health` endpoint with node status

**E2E Encryption** (`@orka/core/crypto.ts`):
- X25519 ECDH key exchange + HKDF-SHA256 key derivation + AES-256-GCM symmetric encryption
- Only `params` (request) and `result` (response) are encrypted into `_enc` field
- Envelope fields (jsonrpc, id, method, node) stay plaintext for relay routing
- User-owned keys — relay operator has zero access to payload content
- Keys stored at `~/.orka/keys/` (client.pub/key, node.pub/key, server.pub)
- Server exposes public key via `/health` endpoint for client discovery
- Post-quantum ready: cipher field (`c`) enables future algorithm negotiation (hybrid X25519+Kyber768)

## Observability

OpenTelemetry tracing is integrated via `@opentelemetry/api` + `@opentelemetry/sdk-trace-base`.

**Instrumented operations:**
- `orka.spawn` — full session lifecycle (child spans include `orka.worktree.create` and `orka.provider.start_session`; tmux spans remain on the legacy path)
- `orka.reap` — session reaping with per-session events (exit codes)
- `orka.stop` — session stop (`orka.provider.stop_session` on the primary path, `orka.tmux.kill` on the fallback path)
- `orka.worktree.cleanup` — with skip reasons (`kept`, `uncommitted_changes`, `commits_ahead`)
- `orka.worktree.prune_orphans` — orphaned worktree cleanup

**Exporters:**
- **File** (`~/.orka/traces.jsonl`) — always on, JSON lines format
- **Console** — `ORKA_TRACE=console` env var
- **OTLP/HTTP** — `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` (Jaeger, Grafana, etc.)

**Adding new spans:** use `withSpan(name, attributes, async (span) => { ... })` from `./tracing`.

## Key Architecture Decisions

- **Daemon-only client path**: All daemon-backed CLI operations go through `RemoteClient`. `LocalClient` exists to serve RPCs inside `orka serve`, not as a normal CLI fast path.
- **Daemon auto-start**: The CLI treats the daemon as required infrastructure. If `127.0.0.1:7394` is unhealthy, it starts `orka serve` in a detached session, records `~/.orka/daemon.pid`, and logs to `~/.orka/logs/daemon.log`.
- **Provider runtime is the default**: `getConfig().providers.useRuntime` defaults to `true`, so sessions normally run through the provider adapter system with orchestration events persisted in SQLite. The tmux path remains only as a compatibility fallback when `providers.use_runtime = false`.
- **Named worktree branches**: Background sessions auto-create `orka/<session-id>` branches (not detached HEAD), so agent commits are never lost. Use `orka merge <id>` to integrate.
- **Smart worktree cleanup**: Worktrees are preserved during reap/stop if they have uncommitted changes, commits ahead of parent, or are marked with `orka keep`. Only clean worktrees are auto-removed.
- **Worktrees outside main repo**: Background sessions get worktrees at `~/.orka/worktrees/` so `git rev-parse --show-toplevel` returns the worktree path, not the parent repo.
- **Event-sourced session reads**: On the runtime path, `getResult()` and `captureOutput()` reconstruct data from persisted orchestration events; legacy log parsing remains as fallback support.
- **Script files for tmux fallback**: Commands are written to `~/.orka/scripts/<id>.sh` and tmux runs `bash <path>` on the legacy path, which avoids nested `bash -c` shell escaping issues.
- **Session stores projectPath**: The original repo root is stored in the session record, separate from workingDir (which may be a worktree). Used for retry, merge, and worktree cleanup.
- **Auto-reap on every CLI invocation**: `reapSessions()` runs before every daemon-backed command except `wait`. It mainly covers the legacy tmux fallback path and skips live provider-runtime handles.
- **CLAUDECODE env unset**: Spawned agent scripts `unset CLAUDECODE` before running claude CLI, because Claude Code detects nested sessions and refuses to start.
- **Concurrent limits**: Configurable via `[limits] max_concurrent = "5"` in config.toml (0 = unlimited).
- **zod/v4 default gotcha**: When using `.default({})` on nested zod objects, inner field defaults are NOT applied. Always use `Schema.default(Schema.parse({}))` pattern (see config.ts).
- **Timer unref**: Any `setInterval`/`setTimeout` at module scope in library code MUST call `.unref()` so the process can exit when imported in ad-hoc scripts/tests.
- **Bun SQLite multi-statement**: `db.exec()` with multiple statements separated by `;` can fail with foreign key constraints. Split into individual `db.exec()` calls per statement.
- **Relay transparency**: Relay routes by `node` field in JSON-RPC envelope, never parses `params`/`result`. Protocol changes don't require relay updates.

## Testing

```bash
# Run all tests (unit + E2E)
bun test packages/ tests/

# Unit tests only
bun test packages/

# E2E tests only (requires Docker)
bun test tests/e2e/

# Rebuild Docker images after source changes
docker build -f Dockerfile.relay -t orka-relay-test .
docker build -f Dockerfile.daemon -t orka-daemon-test .
```

**Unit tests** (`packages/*/src/*.test.ts`): Pure logic tests for relay modules — rate-limiter, state, cluster, abuse, config, auth, metering, reconnect. Uses `bun:test`, no external deps.

**E2E tests** (`tests/e2e/`): Testcontainers-based tests that spin up relay in Docker. Auto-skip when Docker is unavailable. Uses `testcontainers` npm package.

**Key testing patterns:**
- E2E tests share a single signup account per describe block to avoid signup rate limit (5/hour/IP)
- Relay container uses log-based wait strategy (`Wait.forLogMessage`) — WS port doesn't respond to TCP probes
- Docker images are built via `docker` CLI (not testcontainers' `fromDockerfile`) for layer cache reuse
- Mock DB-dependent modules with `mock.module()` in unit tests (see metering.test.ts)

**Docker files:**
- `Dockerfile.relay` — relay server on `oven/bun:1`, port 7390
- `Dockerfile.daemon` — daemon container with git and compatibility tooling, port 7394
- `docker-compose.test.yml` — relay + daemon + toxiproxy for local dev
- `.dockerignore` — excludes node_modules, .git, .orka, *.db

## Development Commands

```bash
# Run CLI directly
bun run packages/cli/src/index.ts <command>

# Or via wrapper (if symlinked to ~/.local/bin/orka)
orka <command>

# Auto-start local daemon on first daemon-backed command
orka ps

# Start daemon server + relay for multi-machine testing
orka relay --port 7390 &
orka serve --port 7394 --relay ws://127.0.0.1:7390 --node-id local &
orka --remote ws://127.0.0.1:7390/ws ps

# Check issues
bd ready
bd list --status=open
```

## Waiting for Agent Sessions

`orka wait` blocks until sessions complete. Use it instead of polling loops or `sleep`.

```bash
# Wait for a single session
orka wait sess-abc123

# Wait for multiple sessions
orka wait sess-abc123 sess-def456

# Wait for all running sessions
orka wait --all

# Wait for all sessions in a project
orka wait --project /path/to/repo
```

**Important for Claude Code**: `orka wait` is a blocking CLI command — use it directly in Bash tool, not in a polling loop. Do NOT `sleep` + `orka ps` in a loop. Just run `orka wait <ids>` and it will return when done.

To wait for tagged sessions (e.g. all migration agents):
```bash
# Get IDs of running sessions with a tag, then wait
orka wait $(orka ps --status running --tag migration -v 2>/dev/null | grep -oP 'sess-\w+' | tr '\n' ' ')
```

## Agent Sessions

- The default execution path is provider-backed and event-sourced inside the daemon.
- The provider runtime registers `ClaudeCodeAdapter`, `CodexAdapter`, and `ShellAdapter`, and persists orchestration events for output/result reconstruction.
- Logs are still written to `~/.orka/logs/` for diagnostics and streaming.
- Background sessions automatically get isolated worktrees with named branches.
- Use `orka result <id>` to extract final output, cost, and token usage from the runtime timeline or legacy logs.
- **Codex agents must be explicitly told to `git commit` in the prompt** — they don't auto-commit.
- `--auto-merge` merges the worktree branch into parent on successful completion.
- Backward compatibility: the tmux-backed backend commands and script files still exist when `providers.use_runtime` is disabled.
