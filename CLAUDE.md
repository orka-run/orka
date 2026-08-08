# Orka — Agent Session Orchestrator

## No Backward Compatibility

**This project is NOT in production.** Do not maintain backward compatibility, legacy code paths, or deprecation shims. When replacing a system (e.g. encryption protocol, transport layer), remove the old code entirely. Do not keep "legacy" fallbacks "just in case". Delete dead code aggressively.

## Command Output Policy

**NEVER truncate command output.** Do not use `| tail`, `| head`, or any other output truncation when running shell commands. Always capture and read the FULL output. Truncated output hides errors, warnings, and context that are critical for debugging.

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
relay   — Start relay WS router for multi-machine (--port)
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
- Piped stdin — `echo "task" | orka spawn`

### Multi-Machine Mode

```bash
# Start relay (central router)
orka relay --port 7390

# Sign up for an API key
curl -X POST http://relay:7390/v1/signup -d '{"email":"user@example.com","name":"User"}'
# Returns: { "apiKey": "ork_live_...", ... }

# Create a node API key
curl -X POST http://relay:7390/v1/keys -H "Authorization: Bearer ork_live_..." \
  -d '{"label":"node1","permissions":"node"}'

# Start daemon node with Noise encryption (register with relay)
orka serve --encrypt --port 7394 --relay ws://relay:7390 --node-id node1 --relay-token <node_api_key>

# CLI connects via relay with Noise encryption
orka --remote ws://relay:7390/ws --token <client_api_key> --encrypt ps
# Or via env vars
ORKA_REMOTE=ws://relay:7390/ws ORKA_TOKEN=<client_api_key> ORKA_ENCRYPT=1 orka ps
```

## Import Policy

- **Between packages**: use workspace aliases — `import { ... } from "@orka/core"`, `import { ... } from "@orka/daemon"`
- **Within a package**: use relative imports **without file extensions** — `import { ... } from "./db"`, NOT `"./db.js"` or `"./db.ts"`
- Bun resolves `.ts` files from extensionless imports automatically
- Never use `@/` prefix — it doesn't work in Bun monorepo context

## Layer Separation

### Type Layers
- **DB Row types** (`*Row` schemas) — stay in `daemon/db.ts`, never exported
- **Domain types** (`Session`, `Task`, etc.) — in `core/types.ts`, used for internal logic
- **API response types** (`SpawnResult`, `SessionListItem`, etc.) — in `core/service.ts`, returned by OrkaService
- **Dashboard types** (`SessionSummary`, etc.) — in `dashboard/src/stores/`, derived from API responses

### Rules
1. **Never return a domain type directly from an API method.** Use a response DTO.
2. **Never expose DB row shapes to API consumers.** Map to domain first, then to response DTO.
3. **Never include filesystem paths in API responses** (`logFile`, `rawLogFile`, `workingDir` for non-detail views).
4. **Never include `env` in API responses.** Environment variables are security-sensitive.
5. **List endpoints return summary DTOs**, not full objects. Detail endpoints return full DTOs.
6. **If a dashboard mapper strips fields from the API response, the API response is too large.**

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **Validation**: zod/v4 — import as `import { z } from "zod/v4"`. Enum schemas in core/types.ts, config validation, DB row parsing
- **Storage**: SQLite via bun:sqlite (~/.orka/orka.db), versioned migrations in db.ts, `PRAGMA busy_timeout = 5000`
- **Session runtime**: provider runtime with adapter registry (`ClaudeCodeAdapter`, `CodexAdapter`) and persisted orchestration events
- **Worktrees**: ~/.orka/worktrees/<session-id> (OUTSIDE main repo for isolation)
- **Logs**: ~/.orka/logs/<session-id>.log
- **Config**: ~/.orka/config.toml (optional, TOML with [defaults], [limits], and [hooks] sections)
- **Dashboard transport**: dashboard uses same-origin `/ws` in both Vite dev proxy and nginx prod proxy
- **Tracing**: OpenTelemetry (see Observability section)
- **Issue tracking**: beads (`br` CLI)

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

**Relay** (`@orka/relay`) — transparent WS router for Noise NK encrypted transport. Forwards opaque frames between bound client↔node pairs. Supports:
- Transport binding via client_hello (client specifies target node_id)
- API key auth via `?token=` query param or `Authorization: Bearer` header
- Auto-reconnect for daemon nodes (5s backoff)
- `/health` endpoint with node status

**E2E Encryption** (Noise NK via `@orka/core/transport`):
- Noise NK handshake: X25519 key exchange + ChaChaPoly encryption
- Relay forwards opaque transport frames — only routing fields (`_rc`, `t`) are visible
- User-owned keys — relay operator has zero access to payload content
- Server exposes Noise public key via `/health` endpoint for client discovery

## Observability

OpenTelemetry tracing is integrated via `@opentelemetry/api` + `@opentelemetry/sdk-trace-base`.

**Instrumented operations:**
- `orka.spawn` — full session lifecycle (child spans include `orka.worktree.create` and `orka.provider.start_session`)
- `orka.stop` — session stop (`orka.provider.stop_session`)
- `orka.worktree.cleanup` — with skip reasons (`kept`, `uncommitted_changes`, `commits_ahead`)
- `orka.worktree.prune_orphans` — orphaned worktree cleanup

**Exporters:**
- **File** (`~/.orka/traces.jsonl`) — always on, JSON lines format
- **Console** — `ORKA_TRACE=console` env var
- **OTLP/HTTP** — `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` (Jaeger, Grafana, etc.)

**Adding new spans:** use `withSpan(name, attributes, async (span) => { ... })` from `./tracing`.

## Dependency Injection Policy

**Constructor injection only. No service locators, no module-level singletons.**

All stateful dependencies (databases, caches, config, services) must be created at the composition root and passed down via constructor/function parameters. Never import a singleton from a module and use it directly.

### Rules

1. **No inheritance**: `extends` is forbidden except for Error subclasses and React `Component` (required for error boundaries). Use composition and factory functions instead.
2. **No module-level singletons**: All state must be created at composition roots and passed via parameters. No `let _instance = null; export function getInstance()` patterns.
3. **Constructor/factory injection only**: Dependencies passed as function parameters or factory options objects.
4. **`mock.module()` forbidden in tests**: Use DI (factory parameters / deps objects) for test doubles instead. `mock.module()` poisons the global module cache across test files and breaks test isolation.
5. **Composition roots**: Only `daemon-context.ts`, `createLocalClient()`, relay `index.ts` / `startRelay()`, and CLI `index.ts` may use `new` to wire dependencies. All other code receives dependencies as parameters.

### Anti-patterns (DO NOT)

```typescript
// ❌ Module-level singleton (service locator)
let _db: Database | null = null;
export function getDb() {
  if (!_db) _db = new Database(process.env.DATA_DIR);
  return _db;
}

// ❌ Direct import of singleton
import { getDb } from "./db";
export function listUsers() { return getDb().query("..."); }

// ❌ Class inheritance for code reuse
class WsTransport extends BaseTransport { ... }

// ❌ mock.module() in tests (poisons global module cache)
mock.module("./db", () => ({ insertEvents: mock(() => {}) }));

// ❌ Hardcoded new inside services (should be injected)
class LocalClient {
  private getManager() {
    if (!this.mgr) this.mgr = new TerminalManager(); // ❌
    return this.mgr;
  }
}
```

### Correct patterns (DO)

```typescript
// ✅ Factory function creates isolated instance (composition root)
export function createRelay(opts: { dataDir: string; port: number }): RelayHandle {
  const db = new Database(join(opts.dataDir, "relay.db"));
  const authCache = new AuthCache(db);
  const rateLimiter = new RateLimiter();
  const api = createApiRouter({ db, rateLimiter });
  return { server, shutdown() { db.close(); } };
}

// ✅ Dependencies passed as parameters
export function listUsers(db: Database) { return db.query("..."); }

// ✅ Context object for many dependencies
interface DaemonContext { db: Database; pushHub: PushHub; providerService: ProviderService; }
export function createLocalClient(ctx: DaemonContext): OrkaService { ... }

// ✅ Injectable deps for testability (no mock.module needed)
export class UsageMeter {
  constructor(db: Database, interval?: number, deps?: { insertFn?: InsertFn }) { ... }
}
// In tests:
const meter = new UsageMeter(null as any, 600_000, { insertFn: mock(() => {}) });
```

### Linting

Run `bun run lint:di` to check for DI violations. See `scripts/lint-di.ts`.

**Why:** Module-level singletons make it impossible to run multiple instances in the same process (needed for test isolation, hot restart, multi-tenant). Constructor injection makes dependencies explicit and testable.

**Exception:** OpenTelemetry tracing is global by design (uses `@opentelemetry/api` global tracer). This is acceptable.

**Known residual violations** (documented, not yet refactored due to scope):
- `relay/src/tracing.ts`: `export const metrics` — application-specific metrics singleton used throughout relay hot path (25 occurrences across 2 files). Refactoring requires threading metrics through all relay handlers.
- `cli/src/index.ts`: `getSvc()` — lazy-caches OrkaService in CLI entry point. Acceptable as CLI composition root but uses singleton pattern.

## Key Architecture Decisions

- **Daemon-only client path**: All daemon-backed CLI operations go through `RemoteClient`. `LocalClient` exists to serve RPCs inside `orka serve`, not as a normal CLI fast path.
- **Daemon auto-start**: The CLI treats the daemon as required infrastructure. If `127.0.0.1:7394` is unhealthy, it starts `orka serve` in a detached session, records `~/.orka/daemon.pid`, and logs to `~/.orka/logs/daemon.log`.
- **Provider runtime is always on**: All sessions run through the provider adapter system with orchestration events persisted in SQLite.
- **Named worktree branches**: Background sessions auto-create `orka/<session-id>` branches (not detached HEAD), so agent commits are never lost. Use `orka merge <id>` to integrate.
- **Smart worktree cleanup**: Worktrees are preserved during reap/stop if they have uncommitted changes, commits ahead of parent, or are marked with `orka keep`. Only clean worktrees are auto-removed.
- **Worktrees outside main repo**: Background sessions get worktrees at `~/.orka/worktrees/` so `git rev-parse --show-toplevel` returns the worktree path, not the parent repo.
- **Event-sourced session reads**: `getResult()` and `captureOutput()` reconstruct data from persisted orchestration events; log file parsing remains as fallback support.
- **Session stores projectPath**: The original repo root is stored in the session record, separate from workingDir (which may be a worktree). Used for retry, merge, and worktree cleanup.
- **Auto-reap on every CLI invocation**: `reapSessions()` runs before every daemon-backed command except `wait`. With provider-only runtime, it is currently a no-op.
- **CLAUDECODE env unset**: Spawned agent scripts `unset CLAUDECODE` before running claude CLI, because Claude Code detects nested sessions and refuses to start.
- **Concurrent limits**: Configurable via `[limits] max_concurrent = "5"` in config.toml (0 = unlimited).
- **zod/v4 default gotcha**: When using `.default({})` on nested zod objects, inner field defaults are NOT applied. Always use `Schema.default(Schema.parse({}))` pattern (see config.ts).
- **Timer unref**: Any `setInterval`/`setTimeout` at module scope in library code MUST call `.unref()` so the process can exit when imported in ad-hoc scripts/tests.
- **Bun SQLite multi-statement**: `db.exec()` with multiple statements separated by `;` can fail with foreign key constraints. Split into individual `db.exec()` calls per statement.
- **Relay transparency**: Relay forwards opaque Noise transport frames between bound client↔node pairs. Only `_rc` (relay client ID) and `t` (message type) fields are read for routing. Protocol changes don't require relay updates.

## Testing

```bash
# Run all tests (unit + E2E)
bun test packages/ tests/

# Unit tests only
bun test packages/

# E2E tests only (no Docker needed — runs relay + daemon in-process)
bun test tests/e2e/
```

**Unit tests** (`packages/*/src/*.test.ts`): Pure logic tests for relay modules — rate-limiter, state, cluster, abuse, config, auth, metering, reconnect. Uses `bun:test`, no external deps.

**E2E tests** (`tests/e2e/`): In-process tests that start relay and daemon directly via `startRelay({ port: 0 })` and `startServer()`. No Docker required. Covers full-stack routing, auth, API endpoints, rate limiting, Noise encryption, and session lifecycle.

**Key testing patterns:**
- E2E tests share a single signup account per describe block to avoid signup rate limit (5/hour/IP)
- Set `ORKA_RELAY_DATA` and `ORKA_HOME` to isolated temp dirs BEFORE importing relay/daemon modules
- Use `relay.server.port` to get the assigned ephemeral port
- Shutdown: `await relay.shutdown({ drainTimeoutMs: 1000 })`
- Mock DB-dependent modules with `mock.module()` in unit tests (see metering.test.ts)

**Docker files:**
- `Dockerfile.relay` — relay server on `oven/bun:1`, port 7390
- `Dockerfile.daemon` — daemon container with git and compatibility tooling, port 7394
- `docker-compose.yml` — daemon + dashboard for local dev
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
br ready
br list --status open
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

## Agent Models

This project uses two agent backends with high reasoning:
- **Claude Code** — Opus 4.6 (default for complex tasks requiring deep codebase understanding)
- **Codex** — GPT-5.4 with `--reasoning-effort high` (for parallelizable implementation tasks)

When spawning agents, always use `--reasoning-effort high` for codex.

## Agent Sessions

- All sessions run through the provider runtime, which is event-sourced inside the daemon.
- The provider runtime registers `ClaudeCodeAdapter` and `CodexAdapter`, and persists orchestration events for output/result reconstruction.
- Logs are still written to `~/.orka/logs/` for diagnostics and streaming.
- Background sessions automatically get isolated worktrees with named branches.
- Use `orka result <id>` to extract final output, cost, and token usage from the runtime timeline.
- **Codex agents must be explicitly told to `git commit` in the prompt** — they don't auto-commit.
- `--auto-merge` merges the worktree branch into parent on successful completion.
