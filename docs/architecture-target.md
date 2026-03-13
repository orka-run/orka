# Orka Target Architecture

> Status: Draft — describes the target state, not the current implementation.
> See also: [Protocol Specification](./protocol-spec.md)

## Overview

Orka is a distributed agent session orchestrator. The architecture supports
a spectrum of deployments, from a single-machine dev setup to a multi-node
cluster with relay routing, E2E encryption, and centralized event aggregation.

```
                          ┌──────────────────┐
                          │   Aggregator     │
                          │  (future, opt)   │
                          └───────▲──────────┘
                                  │ events (push)
         ┌────────────────────────┼─────────────────────────┐
         │                        │                         │
   ┌─────┴──────┐          ┌──────┴──────┐           ┌──────┴──────┐
   │  Daemon A   │          │  Daemon B   │           │  Daemon C   │
   │  (node)     │          │  (node)     │           │  (node)     │
   └──▲───▲──────┘          └──▲──────────┘           └──▲──────────┘
      │   │                    │                        │
      │   │  ┌─────────────────┼────────────────────────┘
      │   │  │     relay routing (transparent)
      │   │  │
      │   ├──┼─────────────────┐
      │   │  │          ┌──────┴──────┐
      │   │  │          │   Relay     │
      │   │  │          │  (router)   │
      │   │  │          └──────▲──────┘
      │   │  │                 │
  ┌───┴┐ │  │  ┌──────┐  ┌────┴────┐
  │CLI │ │  │  │ CLI  │  │Dashboard│
  └────┘ │  │  └──────┘  └─────────┘
  local  │  │  via relay   via relay
         │  │
    ┌────┴──┴──────────┐
    │    Dashboard      │
    │   (local/direct)  │
    └───────────────────┘
```

## Deployment Modes

### 1. Single-machine (current default)

- CLI auto-starts a local daemon on `127.0.0.1:7394`.
- Dashboard connects to the same daemon via `/ws`.
- No relay, no encryption, no aggregation.

### 2. Multi-node with relay

- One relay instance routes JSON-RPC between clients and daemon nodes.
- Each daemon node registers with the relay.
- CLI/dashboard connect to the relay, which routes to the target or least-loaded node.
- E2E encryption ensures relay has zero access to payload content.

### 3. Multi-node with aggregator (future)

- An aggregator node subscribes to orchestration events from all daemon nodes.
- Provides a unified view: cross-node session list, merged timelines, global usage metrics.
- Dashboard can connect to the aggregator instead of individual nodes.
- Aggregator is a consumer, not an authority — each daemon owns its sessions.

## Core Components

### Daemon (node)

The daemon is the unit of session ownership. Each daemon:

- Runs provider sessions (Claude Code, Codex, Shell) via adapter registry.
- Persists orchestration events in local SQLite.
- Serves JSON-RPC over WebSocket to CLI, dashboard, relay, or aggregator.
- Broadcasts events via push channels to connected clients.
- Manages local worktrees, logs, and raw JSONL provider output.
- Advertises capabilities via `/health` and `server.welcome`.

A daemon owns the sessions it spawns. Session state is not replicated
across nodes — it is projected from the local event log.

### Relay (router)

The relay is a transparent message router. It:

- Routes JSON-RPC envelopes by `node` field (explicit) or least-loaded scheduling.
- Never parses `params` or `result` — only reads envelope fields (`jsonrpc`, `id`, `method`, `node`).
- Supports E2E encryption (encrypted `_enc` field passes through opaquely).
- Authenticates clients and nodes via API keys with role-based permissions.
- Enforces rate limits and message size limits per account.
- Meters usage for billing.

The relay does NOT:

- Store or replay events.
- Own session state.
- Understand event schemas.
- Participate in capability negotiation beyond passing messages through.

### Aggregator (future)

The aggregator is a specialized client that:

- Connects to multiple daemon nodes (directly or via relay).
- Subscribes to `orchestration.event` and `orchestration.sessionUpdated` on each node.
- Maintains a merged session index with node attribution.
- Provides cross-node RPC: `listSessions` returns sessions from all nodes.
- Proxies node-specific RPCs (`getSessionTimeline`, `sendTurn`) to the owning node.
- Stores aggregated events in its own DB for historical queries.

The aggregator must handle:

- **Version skew**: nodes may run different daemon versions. Events must be
  accepted even if they contain unknown types or fields.
- **Node availability**: a node going offline should not crash the aggregator.
  Stale session data should be marked as potentially outdated.
- **Event deduplication**: if the aggregator reconnects, it must handle
  replayed events idempotically (by eventId).

### CLI

The CLI is a stateless RPC client. It:

- Connects to a daemon (local or remote via relay) using `RemoteClient`.
- Sends JSON-RPC requests and waits for responses.
- Does not subscribe to push channels (except `orka attach`/`orka logs -f`).
- Checks daemon capabilities before calling optional methods.

### Dashboard

The dashboard is a stateful push-subscribed client. It:

- Connects to a daemon (or aggregator) via WebSocket.
- Subscribes to push channels for live updates.
- Fetches timelines via RPC and merges with push events.
- Handles push gaps by requesting backfill from the server.
- Detects protocol version mismatch and prompts for reload.

## Data Flow

### Event Pipeline

```
Provider (Claude Code / Codex / Shell)
  │
  │  raw JSON lines (provider-specific format)
  ▼
Adapter (claude-adapter.ts, codex-adapter.ts, shell-adapter.ts)
  │
  │  ProviderRuntimeEvent (canonical, provider-agnostic)
  ▼
Ingestion (ingestion.ts)
  │
  │  OrchestrationEvent (session-scoped, persisted)
  ▼
Engine (engine.ts)
  │
  ├──▶ SQLite (persisted event log)
  ├──▶ Push broadcast (to connected clients)
  └──▶ Session projection (status, cost, tokens)
```

### Raw Log Preservation

Every provider adapter writes raw stdin/stdout to
`~/.orka/logs/<session-id>.raw.jsonl`. This is the source of truth
for event reconstruction. If the mapping logic changes or events
were lost, `backfillSession()` replays raw logs through the current
adapter to regenerate orchestration events.

This makes SQLite events a projection/cache layer, not the primary record.

## Versioning Strategy

### Protocol Version

A single integer `protocolVersion` (currently `1`) covers:

- Event envelope format (field names, required/optional fields)
- RPC method signatures (params and result shapes)
- Push envelope format

The version increments only on **breaking** changes — changes that would
cause a correctly-implemented older consumer to produce wrong results
(not just incomplete ones).

### Compatibility Rules

Within the same protocol version:

- New event types MAY be added.
- New optional fields MAY be added to existing events.
- Existing field semantics MUST NOT change.
- Existing fields MUST NOT be removed or renamed.
- New enum values MAY appear on open-ended wire schemas.
- New RPC methods MAY be added.
- New optional RPC params MAY be added.
- RPC methods MUST NOT be removed without a deprecation window.

### Event Envelope Versioning

Each serialized event carries `v: <integer>` (default `1` if absent).
When an incompatible change to a specific event type is needed:

1. Bump `v` for that event type.
2. Add a migration function at the read boundary.
3. Normalize into the current internal representation before processing.

This allows old persisted events to coexist with new ones in the same DB.

### Capability Negotiation

Daemons advertise capabilities in `/health` and `server.welcome`:

```json
{
  "protocolVersion": 1,
  "capabilities": {
    "resume": false,
    "encryption": "x25519-aes256gcm",
    "multiTurn": true,
    "adapters": ["claude-code", "codex", "shell"],
    "maxConcurrent": 5,
    "terminal": true
  }
}
```

Clients SHOULD check capabilities before calling optional methods.
Relay MAY use capabilities for intelligent node selection.

## Security Model

### E2E Encryption

- X25519 ECDH key exchange + HKDF-SHA256 + AES-256-GCM.
- Only `params` (request) and `result` (response) are encrypted.
- Envelope fields (`jsonrpc`, `id`, `method`, `node`) stay plaintext for routing.
- Relay has zero access to payload content.
- Post-quantum ready: cipher field `c` enables algorithm negotiation.

### Authentication

- **Local daemon**: no auth (localhost only).
- **Relay**: API key authentication via `?token=` query param.
- **Role-based**: `client` (RPC only), `node` (register + RPC), `admin` (all).
- **Per-account isolation**: multi-tenant relay, accounts never share state.

## Resilience

### Reconnection

All WS connections use exponential backoff with jitter:

```
delay = min(baseDelay * 2^attempt, maxDelay)
jitter = delay * jitterFactor * random(-1, 1)
finalDelay = max(100ms, round(delay + jitter))
```

### Push Gap Recovery

- Push envelopes carry per-channel sequence numbers.
- Clients detect gaps and call `reportEventGap()`.
- Server responds with backfill data for the missed range.
- On reconnect, client refetches full timeline (cold start).

### Session Resilience

- Sessions survive CLI disconnect (daemon owns the process).
- Sessions survive dashboard disconnect (push resumes on reconnect).
- Sessions do NOT currently survive daemon restart (see future: session resume).
- Raw JSONL logs survive everything — they are append-only files on disk.

## Future Extensions

### Session Resume After Daemon Restart

- On startup, daemon scans for sessions that were `running` before shutdown.
- For provider-runtime sessions: re-attach to the orphaned provider process
  if still alive, or mark as `interrupted`.
- For worktree sessions: preserve worktree state for manual recovery.

### Agent Communication Protocol (ACP)

- Interoperability with external agent frameworks via ACP standard.
- Orka daemon acts as an ACP host, exposing sessions as ACP agents.
- External ACP clients can discover and communicate with Orka agents.

### Cross-Node Session Migration

- Move a session's ownership from one node to another.
- Requires transferring event history, raw logs, and worktree state.
- Only feasible for idle/paused sessions.

### Central Dashboard with Multi-Node View

- Aggregator provides unified session list from all nodes.
- Dashboard shows node attribution, cross-node cost rollup.
- Drill-down into a session routes to the owning node's timeline.
