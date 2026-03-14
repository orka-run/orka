# Relay

The relay is a transparent WebSocket router between CLI clients and daemon nodes.
It knows nothing about Noise encryption or RPC payload contents — it only reads
routing fields from the JSON-RPC envelope and forwards messages.

```
CLI --WS--> Relay --WS--> Node (daemon)
```

---

## Starting

```bash
orka relay --port 7390 --token mysecret
```

Configuration is loaded from `ORKA_RELAY_CONFIG` (TOML) or defaults.
Data (SQLite) is stored in `ORKA_RELAY_DATA` (default `~/.orka-relay/`).

---

## WebSocket Endpoints

### `/register?node=<nodeId>` — node registration

The daemon connects and becomes the RPC recipient for its `nodeId`.
Requires an API key with `node` permission.

```bash
orka serve --relay ws://relay:7390 --node-id node1 --relay-token mysecret
```

The daemon automatically reconnects on disconnection (exponential backoff).

### `/ws` (or `/`) — client connection

The CLI connects and sends JSON-RPC requests.
Requires an API key with `client` permission.

```bash
orka --remote ws://relay:7390/ws --token <api_key> ps
```

### `/v1/pair/<enrollId>` — pairing

Transparent bidirectional forwarding for SPAKE2 pairing.
The first WebSocket waits in a slot, the second connects, and the relay
begins forwarding all frames in both directions without inspecting content.

- Maximum 100 concurrent slots (configurable).
- Slot TTL: 10 minutes (default).
- On either side disconnecting — both sides are closed.

---

## Message Routing

### Client -> Node

1. Parses from JSON-RPC envelope: `id`, `method`, `node`.
2. Validates `method` against the allowlist (40+ permitted methods).
3. Applies rate limits (per-account + global).
4. Selects a node:
   - If `node` is specified — routes there.
   - Otherwise — picks the **least-loaded** node (fewest active requests).
5. Forwards the raw message in its entirety to the node.
6. Records a PendingRequest: `accountId:requestId -> { client, node, timestamp }`.

### Node -> Client

1. Parses `id` from the response.
2. Looks up PendingRequest by `accountId:requestId`.
3. Forwards the raw response to the client.
4. Decrements the node's activeRequests counter.

**Key principle**: the relay never reads `params`, `result`, or `_enc`.
This allows E2E encryption to work and protocol changes to happen without relay updates.

---

## Authentication

### API Keys

Format: `ork_live_<32 random base62 characters>`.

- Keys are stored in SQLite as SHA-256 hashes.
- Authentication: `Authorization: Bearer <key>` or `?token=<key>`.
- In-memory cache: LRU with 10k entries, 5-minute TTL.
- `lastUsedAt` is updated in batches every 10 seconds.

### Permissions

| Permission | Grants |
|------------|--------|
| `client` | Connect as CLI client (/ws) |
| `node` | Register as daemon node (/register) |
| `admin` | Access to admin API |

### Legacy Token

Optional fallback — a single token set in the config.
Creates a synthetic auth context on the fly.

---

## Rate Limiting

### Per-Account (sliding window)

Dual-window algorithm for accurate estimation:

```
estimate = previousCount * (1 - elapsed_fraction) + currentCount
```

Two limits checked in parallel:

| Limit | Default |
|-------|---------|
| Requests per minute | 60 |
| Requests per hour | 1000 |

### Per-Account Connection Limit

Maximum concurrent WebSocket connections per account.
Checked on WS open. Exceeded -> 429.

### Message Size Limit

Maximum bytes per message (default 1 MB). Exceeded -> 413.

### Global Rate Limit

Safety valve: maximum requests per second across the entire relay (default 10k/s).
Exceeded -> 503.

---

## Abuse Detection

The system monitors three patterns:

| Pattern | Description |
|---------|-------------|
| **Burst** | 10x rate limit within 10 seconds |
| **Connection churn** | Abnormally frequent connections |
| **Node registration abuse** | Exceeding max nodes per account |

Action escalation by signal count within a 10-minute window:

- High severity -> `suspend`
- >= 5 signals -> `suspend`
- >= 3 signals -> `throttle`
- Otherwise -> `warn`

---

## Metering

Buffer-and-flush pattern:

- Buffer accumulates up to 1000 events.
- Flush every 5 seconds or when the buffer fills.
- Retention: 90 days (daily cleanup).

Event types: `request`, `response`, `ws_connect`, `ws_disconnect`,
`node_connect`, `node_disconnect`.

---

## HTTP API

### Public

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Status, uptime, version |
| `POST /v1/signup` | Create account + first API key (5/hour/IP) |

### Authenticated

| Endpoint | Description |
|----------|-------------|
| `GET /v1/account` | Current account details |
| `POST /v1/keys` | Generate API key (max 10 per account) |
| `GET /v1/keys` | List keys |
| `DELETE /v1/keys/:id` | Revoke a key |
| `GET /v1/usage` | Usage for a period (hour/day granularity) |

### Admin

| Endpoint | Description |
|----------|-------------|
| `GET /v1/admin/accounts` | List all accounts |
| `PATCH /v1/admin/accounts/:id` | Update account (status, tier, limits) |
| `GET /v1/admin/stats` | Relay-wide statistics |
| `GET /v1/admin/health` | Detailed health with per-account breakdown |

---

## Accounts and Tiers

### Account Status

| Status | Description |
|--------|-------------|
| `active` | Full access |
| `suspended` | Disabled (abuse or admin action) |
| `deleted` | Deleted |

### Tiers

| Tier | Description |
|------|-------------|
| `free` | Default limits |
| `pro` | Higher limits |
| `enterprise` | Custom limits |

---

## Database

SQLite at `ORKA_RELAY_DATA/relay.db`.

| Table | Purpose |
|-------|---------|
| `accounts` | Accounts (email, name, status, tier) |
| `api_keys` | API keys (key_hash, permissions, last_used_at) |
| `rate_limit_config` | Per-account limits |
| `usage_events` | Metering events |
| `node_registrations` | Registered nodes |
| `schema_migrations` | Schema versioning |

---

## Observability

### Metrics (in-memory)

- **Counters**: requestsTotal, bytesIn, bytesOut, connectionsOpened/Closed,
  authFailures, rateLimitHits, abuseDetections
- **Histograms**: requestDuration, messageSize
- **Gauges**: activeConnections, registeredNodes, activeAccounts

### Tracing (OpenTelemetry)

- **File exporter**: always writes to `~/.orka-relay/traces.jsonl`.
- **Console exporter**: enabled via `ORKA_TRACE=console`.
- **OTLP**: via `OTEL_EXPORTER_OTLP_ENDPOINT`.

Instrumented operations: auth, rate limiting, abuse detection,
metering, DB operations, API endpoints, WS message routing.

---

## Graceful Shutdown

1. `draining = true` — new connections rejected, health still responds.
2. Wait for in-flight requests to complete (up to timeout).
3. Flush subsystems:
   - Auth: flush lastUsedAt queue.
   - Metering: flush buffer.
   - Pairing: close all slots.
4. Close DB.
5. Stop server.
6. Shutdown tracing.

---

## Method Allowlist

The relay only forwards known JSON-RPC methods. Unknown methods
receive `-32601` from the relay itself.

Allowed categories:
- Session lifecycle: `spawn`, `stop`, `reap`
- Queries: `getSession`, `listSessions`, `getChildSessions`, `getTask`
- Properties: `setKept`, `getTags`
- Output: `getResult`, `getSessionTimeline`, `getChatMessages`, `getUsage`,
  `captureOutput`, `getLogContent`, `isAlive`, `sendTurn`
- Worktree: `getDiff`, `merge`
- Bulk: `deleteSessions`, `pruneSessions`
- Archive: `archiveSession`, `unarchiveSession`
- Approvals: `getPendingApprovals`, `resolveApproval`
- Events: `reportEventGap`, `backfillSession`
- Metrics: `getMetrics`, `queryTraces`
- Terminal: `terminalOpen`, `terminalWrite`, `terminalResize`, `terminalClose`, `terminalList`
- Errors: `reportClientError`, `listClientErrors`

---

## Multi-Tenant Isolation

- A client can only see nodes belonging to its own account.
- PendingRequest key: `"accountId:requestId"` — the same request ID can exist
  across different accounts without conflict.
- Rate limits are per-account, not per-node.

---

## Source Files

| File | Contents |
|------|----------|
| `packages/relay/src/index.ts` | Composition root: startRelay(), shutdown, WS routing |
| `packages/relay/src/state.ts` | RelayState: nodes, clients, pending requests |
| `packages/relay/src/auth.ts` | Authentication, cache, API key generation |
| `packages/relay/src/rate-limiter.ts` | Per-account and global rate limiting |
| `packages/relay/src/abuse.ts` | Abuse detection and escalation |
| `packages/relay/src/metering.ts` | Usage metering (buffer-and-flush) |
| `packages/relay/src/pairing.ts` | Pairing router (transparent forwarding) |
| `packages/relay/src/db.ts` | SQLite schema, CRUD, migrations |
| `packages/relay/src/config.ts` | TOML config loading, zod validation |
| `packages/relay/src/api.ts` | HTTP API endpoints (signup, keys, usage, admin) |
| `packages/relay/src/tracing.ts` | OpenTelemetry setup, metrics, file/console exporters |
| `packages/relay/src/cluster.ts` | Cluster abstraction (single-instance for now) |
