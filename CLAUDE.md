# Orka — Agent Session Orchestrator

See also: [AGENTS.md](./AGENTS.md) for issue tracking and agent workflow conventions.

## Commit Policy

**MANDATORY: After completing each task/issue, create a git commit BEFORE moving to the next task.**

- One task = one commit (minimum)
- Commit message format: `<type>: <what changed>` (e.g. `feat: add orka diff command`, `fix: tmux spawn shell escaping`)
- Stage only relevant files, never `.orka/`, `node_modules/`, `*.db`
- If a beads issue is closed, the corresponding code MUST be committed
- Do NOT batch multiple unrelated tasks into one commit

## Project Structure

```
packages/
  core/     — @orka/core: domain types, zod schemas, OrkaService interface, RPC types
  daemon/   — @orka/daemon: orchestrator, tmux, worktree, SQLite, backends, config, tracing,
              LocalClient, RemoteClient, WS server
  relay/    — @orka/relay: transparent WS router for multi-machine setups
  cli/      — @orka/cli: CLI entry point (20 commands)
orka        — shell wrapper for global CLI access
```

## CLI Commands

```
spawn   — Spawn an agent session (--backend, --mode, --model, --branch, --title, --prompt-file, --tag, --auto-merge)
ps      — List sessions (--status, --backend, --tag, --project, --verbose/-v)
attach  — Attach to running tmux session (shows SSH hint in remote mode)
logs    — View session output (--follow/-f for live streaming)
stop    — Stop a running session
diff    — Show git changes in session worktree
show    — Full session detail view (status, project, model, prompt, tags, kept, auto-merge)
workdir — Print session working directory (for shell: cd $(orka workdir <id>))
wait    — Block until session(s) complete (supports --all, --project)
result  — Extract final result, cost, tokens from background session log (--json)
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
- **Storage**: SQLite via bun:sqlite (~/.orka/orka.db), versioned migrations in db.ts
- **Session runtime**: tmux (sessions prefixed `orka-`)
- **Worktrees**: ~/.orka/worktrees/<session-id> (OUTSIDE main repo for isolation)
- **Logs**: ~/.orka/logs/<session-id>.log
- **Scripts**: ~/.orka/scripts/<session-id>.sh (command written to file, not inline bash -c)
- **Config**: ~/.orka/config.toml (optional, TOML with [defaults] and [limits] sections)
- **Tracing**: OpenTelemetry (see Observability section)
- **Issue tracking**: beads (`bd` CLI)

## Architecture: OrkaService Interface

The **OrkaService** interface (`@orka/core/service.ts`) is the contract between CLI and daemon. All methods are fully async (return Promise) for network transparency.

**Implementations:**
- **LocalClient** (`@orka/daemon/local-client.ts`) — direct in-process calls, used by default
- **RemoteClient** (`@orka/daemon/remote-client.ts`) — WS JSON-RPC client, used with `--remote`

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
- `orka.spawn` — full session lifecycle (child spans: `orka.worktree.create`, `orka.tmux.spawn`)
- `orka.reap` — session reaping with per-session events (exit codes)
- `orka.stop` — session stop (child: `orka.tmux.kill`)
- `orka.worktree.cleanup` — with skip reasons (`kept`, `uncommitted_changes`, `commits_ahead`)
- `orka.worktree.prune_orphans` — orphaned worktree cleanup

**Exporters:**
- **File** (`~/.orka/traces.jsonl`) — always on, JSON lines format
- **Console** — `ORKA_TRACE=console` env var
- **OTLP/HTTP** — `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` (Jaeger, Grafana, etc.)

**Adding new spans:** use `withSpan(name, attributes, async (span) => { ... })` from `./tracing`.

## Key Architecture Decisions

- **OrkaService interface**: All daemon operations are behind an abstract async interface. CLI never imports daemon internals directly (except tmuxAttach, config, projects which are CLI-local).
- **Named worktree branches**: Background sessions auto-create `orka/<session-id>` branches (not detached HEAD), so agent commits are never lost. Use `orka merge <id>` to integrate.
- **Smart worktree cleanup**: Worktrees are preserved during reap/stop if they have uncommitted changes, commits ahead of parent, or are marked with `orka keep`. Only clean worktrees are auto-removed.
- **Worktrees outside main repo**: Background sessions get worktrees at `~/.orka/worktrees/` so `git rev-parse --show-toplevel` returns the worktree path, not the parent repo.
- **Script files for tmux**: Commands are written to `~/.orka/scripts/<id>.sh` and tmux runs `bash <path>` — avoids nested `bash -c` shell escaping issues.
- **Session stores projectPath**: The original repo root is stored in the session record, separate from workingDir (which may be a worktree). Used for retry, merge, and worktree cleanup.
- **Auto-reap on every CLI invocation**: `reapSessions()` runs before every command, marking dead tmux sessions as completed and cleaning up worktrees.
- **Concurrent limits**: Configurable via `[limits] max_concurrent = "5"` in config.toml (0 = unlimited).
- **zod/v4 default gotcha**: When using `.default({})` on nested zod objects, inner field defaults are NOT applied. Always use `Schema.default(Schema.parse({}))` pattern (see config.ts).
- **Relay transparency**: Relay routes by `node` field in JSON-RPC envelope, never parses `params`/`result`. Protocol changes don't require relay updates.

## Development Commands

```bash
# Run CLI directly
bun run packages/cli/src/index.ts <command>

# Or via wrapper (if symlinked to ~/.local/bin/orka)
orka <command>

# Start daemon server + relay for multi-machine testing
orka relay --port 7390 &
orka serve --port 7394 --relay ws://127.0.0.1:7390 --node-id local &
orka --remote ws://127.0.0.1:7390/ws ps

# Check issues
bd ready
bd list --status=open
```

## Agent Sessions (orka-spawned claude-code)

- Background sessions use: `claude -p --verbose --output-format stream-json --permission-mode auto`
- Interactive sessions use: `claude <prompt>`
- All sessions get `--append-system-prompt "[orka session: <id>]"` for traceability
- Logs are tee'd to ~/.orka/logs/ for post-mortem reading
- Background sessions automatically get isolated worktrees with named branches
- Use `orka result <id>` to extract final output, cost, and token usage from background sessions
