# Orka Wire Protocol Specification

> Version: 1 (draft)
> Status: Target specification — describes both current behavior and planned changes.
> See also: [Target Architecture](./architecture-target.md)

## 1. Conventions

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" in this
document are to be interpreted as described in RFC 2119.

**Wire types** are defined using TypeScript-like notation for readability.
All messages are UTF-8 encoded JSON.

## 2. Transport

### 2.1. WebSocket Connection

All communication uses WebSocket (RFC 6455) over TCP.

| Endpoint | Purpose |
|----------|---------|
| `ws://host:port/ws` | JSON-RPC + push (clients, dashboard) |
| `ws://relay:port/ws` | Relay-routed JSON-RPC (clients via relay) |
| `POST relay:port/register?node=<id>` | Node registration (upgrade to WS) |

### 2.2. HTTP Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check + capability advertisement |
| `/v1/traces` | POST | OTLP JSON trace ingestion |

### 2.3. Health Response

```typescript
{
  status: "ok",
  protocolVersion: number,               // Current: 1
  serverVersion: string,                  // Semantic version (e.g., "0.3.0")
  publicKey?: string,                     // Base64 X25519 public key (if encryption enabled)
  capabilities: {                         // Structured capability object
    resume: boolean,
    encryption: string | false,           // e.g., "x25519-aes256gcm" or false
    multiTurn: boolean,
    adapters: string[],                   // e.g., ["claude-code", "codex", "shell"]
    maxConcurrent: number,                // 0 = unlimited
    terminal: boolean,
  }
}
```

Implementations MUST include `protocolVersion` and `capabilities` in
the health response. Clients SHOULD use these to determine feature availability.

## 3. JSON-RPC Layer

Orka uses JSON-RPC 2.0 (RFC 7049-like) over WebSocket.

### 3.1. Request Envelope

```typescript
interface RpcRequest {
  jsonrpc: "2.0",
  id: string | number,                    // Request correlation ID
  method: string,                         // RPC method name
  params?: Record<string, unknown>,       // Method parameters (encrypted in E2E mode)
  traceparent?: string,                   // W3C Trace Context (optional)
  node?: string,                          // Relay routing hint (optional)
}
```

### 3.2. Response Envelope

```typescript
interface RpcResponse {
  jsonrpc: "2.0",
  id: string | number | null,
  result?: unknown,                       // Present on success
  error?: RpcError,                       // Present on failure
}

interface RpcError {
  code: number,
  message: string,
  data?: unknown,
}
```

### 3.3. Error Codes

| Code | Constant | Meaning |
|------|----------|---------|
| -32700 | PARSE_ERROR | Malformed JSON |
| -32600 | INVALID_REQUEST | Missing required envelope fields |
| -32601 | METHOD_NOT_FOUND | Unknown RPC method |
| -32602 | INVALID_PARAMS | Bad or missing parameters |
| -32603 | INTERNAL_ERROR | Unhandled server exception |
| 404 | NOT_FOUND | Referenced entity does not exist |
| 409 | CONFLICT | Operation conflicts with current state |

Clients MUST treat `-32601` on a known-optional method as
"feature not supported by this daemon version" and degrade gracefully.

### 3.4. RPC Methods

Methods are grouped by domain. All parameters use named fields (not positional).

#### Session Lifecycle

| Method | Params | Returns | Notes |
|--------|--------|---------|-------|
| `spawn` | `SpawnRequest` | `Session` | Start a new agent session |
| `stop` | `{ sessionId }` | `void` | Graceful stop |
| `reap` | — | `number` | Clean up zombie sessions, returns count |
| `sendTurn` | `{ sessionId, text }` | `void` | Send input to interactive session |
| `backfillSession` | `{ sessionId }` | `{ eventsReplayed: number }` | Regenerate events from raw log |

#### Session Queries

| Method | Params | Returns |
|--------|--------|---------|
| `getSession` | `{ id }` | `Session \| null` |
| `listSessions` | `{ filters?: SessionFilters }` | `Session[]` |
| `getChildSessions` | `{ sessionId }` | `Session[]` |
| `getTask` | `{ id }` | `Task \| null` |
| `isAlive` | `{ sessionId }` | `boolean` |

#### Session Data

| Method | Params | Returns |
|--------|--------|---------|
| `getSessionTimeline` | `{ sessionId }` | `OrchestrationEvent[]` |
| `getResult` | `{ sessionId }` | `SessionResult \| null` |
| `getChatMessages` | `{ sessionId }` | `ChatEntry[]` |
| `getUsage` | `{ sessionId?, since?, backend? }` | `UsageSummary` |
| `captureOutput` | `{ sessionId }` | `string` |
| `getLogContent` | `{ sessionId }` | `string \| null` |
| `getDiff` | `{ sessionId }` | `DiffResult` |
| `getTags` | `{ sessionId }` | `string[]` |

#### Session Management

| Method | Params | Returns |
|--------|--------|---------|
| `setKept` | `{ sessionId, kept }` | `void` |
| `merge` | `{ sessionId, cleanup? }` | `MergeResult` |
| `deleteSessions` | `{ ids }` | `void` |
| `pruneSessions` | `{ maxAgeMs, projectPath?, confirm?, purgeLogs?, purgeDb? }` | `PruneResult` |
| `archiveSession` | `{ sessionId }` | `void` |
| `unarchiveSession` | `{ sessionId }` | `void` |

#### Approvals

| Method | Params | Returns |
|--------|--------|---------|
| `getPendingApprovals` | `{ sessionId? }` | `ApprovalRequest[]` |
| `resolveApproval` | `{ requestId, decision }` | `void` |

#### Terminal PTY

| Method | Params | Returns |
|--------|--------|---------|
| `terminalOpen` | `{ sessionId, opts?: { cols?, rows? } }` | `{ termId: string }` |
| `terminalWrite` | `{ termId, data }` | `void` |
| `terminalResize` | `{ termId, cols, rows }` | `void` |
| `terminalClose` | `{ termId }` | `void` |
| `terminalList` | `{ sessionId }` | `Array<{ id, cols, rows }>` |

#### Observability

| Method | Params | Returns |
|--------|--------|---------|
| `getMetrics` | — | `Record<string, unknown> \| null` |
| `reportClientError` | `{ error, stack?, url?, timestamp? }` | `void` |
| `listClientErrors` | `{ limit? }` | `ClientError[]` |
| `queryTraces` | `{ service?, errorsOnly?, namePattern?, limit?, since? }` | `Array<Record<string, unknown>>` |
| `reportEventGap` | `{ channel, expectedSeq, gotSeq }` | `void` |

## 4. Push Protocol

### 4.1. Push Envelope

The server pushes unsolicited messages to subscribed clients.

```typescript
interface PushEnvelope<T> {
  type: "push",
  channel: string,                        // Channel name
  sequence: number,                       // 1-based, monotonically increasing per channel
  data: T,                                // Channel-specific payload
}
```

### 4.2. Control Messages

Clients subscribe and unsubscribe by sending control messages (not JSON-RPC):

```typescript
// Client → Server
interface PushControlRequest {
  type: "subscribe" | "unsubscribe",
  channels: string[],                     // Channel names
}
```

Servers MUST silently ignore unknown channel names in subscribe requests.
This allows new clients to request channels that old servers don't support.

### 4.3. Push Channels

| Channel | Data Type | Description |
|---------|-----------|-------------|
| `server.welcome` | `WelcomeData` | Sent once on WS open (no subscription needed) |
| `server.shutdown` | `{}` | Server is shutting down |
| `orchestration.sessionUpdated` | `SessionUpdatedData` | Session status changed |
| `orchestration.sessionDeleted` | `SessionDeletedData` | Session was deleted |
| `orchestration.event` | `OrchestrationEvent` | Real-time orchestration event |
| `session.logLine` | `SessionLogLineData` | Raw log line (for `orka logs -f`) |

### 4.4. Welcome Data

Sent automatically on WebSocket connection, before any subscriptions.

```typescript
interface WelcomeData {
  serverVersion: string,
  protocolVersion: number,                // NEW — protocol version for compat check
  sessionCount: number,
  capabilities: CapabilityObject,         // NEW — same as /health capabilities
}
```

### 4.5. Gap Recovery

Clients MUST track the last received `sequence` per channel. If a gap is
detected (received sequence > expected), clients SHOULD call `reportEventGap`.

> **v1 status:** `reportEventGap` is observability-only in the current
> implementation. The server records the gap as a tracing span
> (`orka.push.delivery_gap`) but does NOT re-send missed events. The
> `LocalClient` implementation is a no-op. Actual gap recovery (server-side
> replay of missed push events) is planned for a future protocol version.

On reconnect, clients SHOULD refetch full state (session list, timelines)
rather than relying on gap recovery across disconnections.

## 5. Orchestration Events

Orchestration events are the primary data model for session activity.
They are persisted in SQLite, pushed to clients, and consumed by the dashboard.

### 5.1. Event Envelope

Every orchestration event shares this base shape:

```typescript
interface OrchestrationEventBase {
  type: string,                           // Discriminant
  sessionId: string,
  timestamp: string,                      // ISO 8601
  v?: number,                             // Envelope version (default: 1)
}
```

The `v` field:
- MUST be written as `1` on all new events.
- MUST be treated as `1` if absent (backward compatibility with pre-v events).
- MUST be incremented when a breaking change is made to that event type's shape.
- Readers MUST normalize old versions to the current internal representation.

### 5.2. Event Types

#### Session Lifecycle

```
session.created    { sessionId, threadId, backend, timestamp }
session.started    { sessionId, timestamp }
session.completed  { sessionId, exitCode: number | null, timestamp }
session.failed     { sessionId, error: string, timestamp }
session.cancelled  { sessionId, reason?: string, timestamp }
session.state.changed { sessionId, state: SessionState, reason?: string, timestamp }
```

#### Turn Lifecycle

```
turn.started    { sessionId, turnId, timestamp }
turn.completed  { sessionId, turnId, state?: TurnState, stopReason?: string,
                  cost?: number, tokens?: { input, output }, timestamp }
turn.aborted    { sessionId, turnId, reason: string, timestamp }
```

#### Content Streaming

```
content.delta   { sessionId, turnId, streamKind: StreamKind, delta: string, timestamp }
```

#### Item Lifecycle

```
item.started    { sessionId, turnId, itemId, itemType: ItemType,
                  status?: ItemStatus, title?: string, detail?: string,
                  args?: unknown, timestamp }
item.updated    { <same as item.started> }
item.completed  { <same as item.started> }
```

#### User Interaction

```
user.input        { sessionId, turnId?, text: string, timestamp }
request.opened    { sessionId, requestId, requestType: string,
                    detail?: string, timestamp }
request.resolved  { sessionId, requestId, decision: string, timestamp }
```

#### Tool Progress

```
tool.progress   { sessionId, turnId, itemId?, toolName?: string,
                  summary?: string, elapsedSeconds?: number, timestamp }
```

#### Runtime Diagnostics

```
runtime.error    { sessionId, turnId?, itemId?, error: string,
                   class?: string, terminal?: boolean, timestamp }
runtime.warning  { sessionId, turnId?, itemId?, message: string, timestamp }
```

#### Passthrough (NEW)

```
event.passthrough { sessionId, turnId?, originalType: string,
                    provider?: string, rawPayload: unknown, timestamp }
```

Used when `mapProviderEvent()` encounters an unknown provider event type.
Preserves the full payload for future processing and dashboard inspection.
Consumers SHOULD render these as inspectable "unknown event" entries.

### 5.3. Wire Enums

These enums appear in orchestration events. On the wire, they are
**open-ended strings** — consumers MUST accept unknown values gracefully.

#### ItemType

Known values:

| Value | Meaning |
|-------|---------|
| `user_message` | User-provided text |
| `assistant_message` | Model-generated text |
| `reasoning` | Model reasoning/thinking |
| `command_execution` | Shell command (Bash) |
| `file_change` | File write/edit |
| `file_read` | File read |
| `search` | Search (Grep, Glob) |
| `web` | Web access (fetch, search) |
| `agent` | Sub-agent delegation |
| `mcp_tool_call` | MCP tool invocation |
| `error` | Error item |
| `unknown` | Unrecognized tool |

Consumers MUST treat unknown values as equivalent to `unknown`.

#### StreamKind

Known values: `assistant_text`, `reasoning_text`, `command_output`,
`file_change_output`, `unknown`.

Consumers MUST render unknown stream kinds. If no specific rendering
exists, treat as plaintext.

#### SessionState

Known values: `starting`, `ready`, `running`, `waiting`, `stopped`, `error`.

#### TurnState

Known values: `completed`, `failed`, `interrupted`, `cancelled`.

#### ItemStatus

Known values: `in_progress`, `completed`, `failed`, `declined`.

### 5.4. Forward Compatibility Rules

1. **Unknown event types**: Consumers MUST NOT crash on unknown `type` values.
   Dashboard SHOULD render them as inspectable entries. Aggregator MUST persist them.

2. **Unknown enum values**: Consumers MUST fall back to a default rendering.
   MUST NOT reject the entire event.

3. **Unknown fields**: Consumers MUST ignore fields they do not recognize.
   Serializers MUST preserve unknown fields during round-trip (passthrough).

4. **Missing optional fields**: Consumers MUST handle absent optional fields
   with sensible defaults. MUST NOT assume a field will be present just because
   it was present in previous events of the same type.

5. **Version migration**: When reading an event with `v` lower than current,
   the reader MUST apply a migration function to normalize it. The migration
   function MUST be pure (no side effects, no network calls).

> **v1 status:** There are no event schema migrations in v1. The
> implementation writes `v: 1` on all new events and normalizes missing `v`
> to `1` on read, but no per-type migration registry exists yet. A formal
> migration registry (keyed by `(type, fromVersion) -> normalizer`) will be
> introduced when v2 event schemas require breaking changes to existing
> event type shapes.

## 6. E2E Encryption

### 6.1. Key Exchange

- Algorithm: X25519 ECDH (RFC 7748).
- Both client and server generate persistent X25519 keypairs.
- Client sends its public key via `?pubkey=<base64>` query parameter on WS connect.
- Server's public key is discoverable via `/health` response.

### 6.2. Key Derivation

```
sharedSecret = X25519(myPrivateKey, theirPublicKey)
salt = sort([clientPubB64, serverPubB64]).join("")  // deterministic
sessionKey = HKDF-SHA256(sharedSecret, salt, "orka-e2e-v1", 32 bytes)
```

### 6.3. Message Encryption

Only payload fields are encrypted. Routing fields stay plaintext.

**Request encryption:**
```
{ jsonrpc, id, method, params, traceparent?, node? }
  ↓ encrypt(params)
{ jsonrpc, id, method, traceparent?, node?, _enc: EncryptedPayload }
```

**Response encryption:**
```
{ jsonrpc, id, result }
  ↓ encrypt(result)
{ jsonrpc, id, _enc: EncryptedPayload }
```

Error responses are NOT encrypted (non-sensitive, and useful for debugging).

### 6.4. Encrypted Payload

```typescript
interface EncryptedPayload {
  c: string,                              // Cipher identifier: "aes-256-gcm"
  iv: string,                             // Base64 12-byte nonce
  ct: string,                             // Base64 ciphertext
  tag: string,                            // Base64 16-byte auth tag
}
```

### 6.5. Cipher Negotiation

The `c` field allows future algorithm upgrades (e.g., `"x25519-kyber768-aes256gcm"`
for post-quantum hybrid). Receivers MUST reject unknown cipher identifiers
with an unencrypted error response.

### 6.6. Security Properties (v1)

The v1 E2E encryption provides **confidentiality** but **not forward secrecy**.

- Both client and server use **persistent** (long-lived) X25519 keypairs.
- The salt is deterministic: `sort([clientPubB64, serverPubB64]).join("")`.
- The same client-server keypair pair always derives the **same symmetric key**
  across all connections and reconnections.
- There are no ephemeral keys or per-connection key rotation in v1.

**Implications:**
- Compromise of either party's private key allows decryption of **all past
  and future** traffic between that keypair pair.
- The design does not provide Perfect Forward Secrecy (PFS). PFS would
  require ephemeral key exchange per connection, which is planned for v2.
- Despite the `sessionKey` naming in the implementation, the derived key is
  **identity-scoped**, not session-scoped.

## 7. Relay Routing

### 7.1. Envelope Transparency

The relay reads ONLY these fields from JSON-RPC envelopes:

- `id` — for response correlation
- `node` — for routing
- `method` — for allowlist validation

The relay MUST NOT read, parse, or validate `params`, `result`, or `_enc`.
This ensures protocol changes never require relay updates.

### 7.4. Method Allowlist

The relay enforces a method allowlist as a service-level security boundary.
Only methods in the allowlist are forwarded to nodes; unknown methods receive
a `-32601` error from the relay itself. The allowlist MUST be updated when
new RPC methods are added to the protocol. This is a deployment concern,
not a wire protocol concern — the relay remains transparent at the
payload level.

### 7.2. Node Selection

If `node` is specified: route to that node (error if not connected).

If `node` is omitted: route to the least-loaded node in the account
(fewest `activeRequests`). Relay MAY use advertised `capabilities`
for smarter routing (e.g., prefer nodes with specific adapters).

### 7.3. Push Forwarding

Push envelopes from nodes are forwarded to the originating client connection.
The relay does not broadcast push messages to all clients — only to the client
whose RPC triggered the session.

For dashboard connections that need push from any session, the dashboard
connects directly to the daemon (not via relay) or to the aggregator.

## 8. Backward Compatibility Matrix

| Scenario | Behavior | Required Action |
|----------|----------|-----------------|
| New daemon, old CLI | CLI gets `-32601` for new methods | CLI degrades gracefully |
| Old daemon, new CLI | CLI checks capabilities first | CLI skips unavailable features |
| New daemon, old dashboard | Unknown events ignored in UI | Dashboard shows stale but functional view |
| Old daemon, new dashboard | Dashboard detects version mismatch | Show reload banner or degrade |
| New daemon, old relay | Relay passes unknown methods through | No action needed |
| New daemon, old aggregator | Aggregator receives unknown events | Aggregator persists as `event.passthrough` |
| Old events in SQLite, new daemon | Events lack `v` field | Reader treats missing `v` as `1`, migrates |

## 9. Known Limitations (v1)

### 9.1. E2E Encryption Does Not Work Through Relay

The client sends its public key as a `?pubkey=` query parameter on the
WebSocket URL. When connecting via relay, this parameter reaches the relay,
not the destination node. The relay does not forward client key material to
nodes, so the node has no key to derive the shared secret. Encrypted
requests sent through the relay arrive as opaque `_enc` data that the node
cannot decrypt.

**Workaround:** Connect directly to the daemon (not via relay) when E2E
encryption is required.

**Planned fix:** Introduce an explicit key-exchange handshake message that
traverses the relay as a normal JSON-RPC request, delivering the client
public key to the node.

### 9.2. Push Protocol Does Not Traverse Relay

The relay only handles JSON-RPC request/response envelopes (messages with
`jsonrpc`, `id`, and `method` fields). Push control messages (`subscribe`,
`unsubscribe`) and push envelopes (`type: "push"`) do not conform to the
JSON-RPC shape and are not forwarded by the relay.

This means:
- `server.welcome` is not delivered to clients connected via relay.
- Push subscriptions (orchestration events, log lines) do not work through
  the relay.
- Dashboard clients must connect directly to the daemon for live updates.

**Planned fix:** Either extend the relay to recognize push control and push
envelope message types, or encapsulate push subscriptions as JSON-RPC
methods with server-streaming semantics.

## 10. Versioning Changelog

### Protocol Version 1 (current)

- Initial protocol definition.
- JSON-RPC 2.0 over WebSocket.
- Push protocol with sequence-based gap detection.
- 20 orchestration event types + `event.passthrough`.
- E2E encryption with X25519 + AES-256-GCM.
- Capability advertisement in `/health` and `server.welcome`.

### Migration from Pre-v1 (implicit)

The following changes formalize existing behavior:

- Add `v: 1` to all new event payloads.
- Add `protocolVersion` and `capabilities` to health/welcome.
- Add `event.passthrough` for unknown provider events.
- Make wire enums open-ended (accept unknown string values).
- Add `protocolVersion` to `server.welcome`.
- Servers silently ignore unknown push channel subscriptions.
