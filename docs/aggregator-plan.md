# Daemon Aggregator & Dual-Mode Dashboard — Implementation Plan

> Status: Plan (not implemented)
> See also: [Architecture Target](./architecture-target.md), [Protocol Spec](./protocol-spec.md), [Noise Transport](./noise-transport.md), [Pairing](./pairing.md)

## Overview

The dashboard currently has two connection modes that emerged organically:

1. **Local daemon** — same-origin `/ws`, no encryption, daemon handles everything
2. **Direct to relay** — browser does Noise NK, SPAKE2 pairing, auth

This plan formalizes these into a clean dual-mode architecture with explicit mode selection:

```
LOCAL MODE                           HOSTED MODE
Dashboard → Local Daemon             Dashboard (browser) → Relay → Nodes
               ↓
         Relay → Remote Nodes
```

**Local mode**: Dashboard is a thin UI. Daemon is the aggregator — it connects to remote nodes, performs pairing, stores keys, aggregates sessions, and proxies RPCs.

**Hosted mode**: No local daemon. Browser does Noise NK directly with nodes through relay, manages keys in localStorage. Uses the existing code.

---

## 1. Daemon Aggregator

The daemon becomes a client of remote nodes in addition to being a server. It uses `OrkaClient` from `@orka/client` to connect to remote nodes via relay, aggregates sessions from all nodes (local + remote), and proxies RPCs to the correct node.

### 1.1 Node Registry (Daemon-Side)

**What**: Persistent storage of paired node metadata and Noise keys in `~/.orka/nodes/`. Replaces the dashboard's `localStorage`-based `nodeRegistry.ts` and `noiseKeys.ts` for local mode.

**Files**:
- New: `packages/daemon/src/node-registry.ts`

**Design**:
```typescript
// ~/.orka/nodes/<nodeId>.json
interface StoredNode {
  nodeId: string;
  nodeName: string;
  relayUrl: string;           // e.g. "wss://relay.example.com"
  relayToken?: string;        // auth token for relay
  nodePaths: string[];        // relay paths from pairing bootstrap
  pairedAt: string;           // ISO 8601
  noiseStaticPubkey: string;  // base64url, 32 bytes
  noiseKeyId: string;         // "sha256:..."
  autoConnect: boolean;       // connect on daemon start (default: true)
}

interface NodeRegistry {
  save(node: StoredNode): void;
  load(nodeId: string): StoredNode | null;
  loadAll(): StoredNode[];
  remove(nodeId: string): void;
}

export function createNodeRegistry(orkaHome: string): NodeRegistry;
```

**Storage**: JSON files at `~/.orka/nodes/<nodeId>.json`. File-based (not SQLite) because:
- Small number of nodes (typically <20)
- Human-readable/editable
- No queries needed beyond list/get-by-id
- Consistent with existing key storage pattern (`~/.orka/keys/`)

**Complexity**: S

**Dependencies**: None

### 1.2 Remote Node Connections

**What**: Daemon maintains persistent `OrkaClient` connections to all paired nodes. Auto-connects on startup, reconnects on failure.

**Files**:
- New: `packages/daemon/src/remote-nodes.ts`
- Modified: `packages/daemon/src/daemon-context.ts` — add `RemoteNodeManager` to context
- Modified: `packages/daemon/src/server.ts` — initialize connections on startup

**Design**:
```typescript
interface RemoteNodeHandle {
  nodeId: string;
  client: OrkaClient;
  status: "connecting" | "connected" | "disconnected" | "reconnecting";
  lastConnected: number | null;
  lastError: string | null;
}

interface RemoteNodeManager {
  /** Connect to a node. Called on daemon startup for autoConnect nodes. */
  connect(node: StoredNode): Promise<void>;
  /** Disconnect from a node. */
  disconnect(nodeId: string): void;
  /** Get handle for a connected node. */
  getHandle(nodeId: string): RemoteNodeHandle | null;
  /** Get all handles. */
  listHandles(): RemoteNodeHandle[];
  /** Shutdown all connections. */
  shutdown(): void;
}

export function createRemoteNodeManager(
  registry: NodeRegistry,
  pushHub: PushHub,
): RemoteNodeManager;
```

**Connection lifecycle**:
1. On daemon start: load all nodes with `autoConnect: true` from registry, call `connect()` for each
2. Each connection: create `OrkaClient` with `NoiseConfig` from stored keys
3. On connection success: subscribe to push channels (`orchestration.event`, `orchestration.sessionUpdated`, `orchestration.sessionDeleted`)
4. On push from remote: re-broadcast via local `PushHub` to dashboard clients (with node attribution)
5. On connection lost: exponential backoff reconnect (use existing `ReconnectStrategy`)
6. On `removeNode()`: disconnect and delete from registry

**OrkaClient connection URL**: The `OrkaClient` connects to the relay at the node's path. The URL is constructed from `node.relayUrl` + auth, and the `nodeId` + `noiseServerKey` are passed as `OrkaClientOptions`.

**Push forwarding**: When a remote node sends a push event, the `RemoteNodeManager` receives it via `OrkaClient`'s push subscription and re-broadcasts it through the local `PushHub`. The event payload is extended with `nodeId` so the dashboard knows which node it came from:
```typescript
// Remote push received:
{ channel: "orchestration.sessionUpdated", data: { sessionId: "sess-abc", status: "running" } }

// Re-broadcast to local dashboard clients:
{ channel: "orchestration.sessionUpdated", data: { sessionId: "sess-abc", status: "running", nodeId: "fra1-gpu-01" } }
```

**Complexity**: L

**Dependencies**: 1.1 (Node Registry)

### 1.3 OrkaClient Push Subscriptions

**What**: `OrkaClient` currently doesn't support push subscriptions — it's a request/response-only client. The aggregator needs to receive push events from remote nodes. `WsTransport` already supports push subscriptions, but `OrkaClient` uses raw WebSocket directly.

**Options**:
1. **Refactor OrkaClient to use WsTransport internally** — cleanest, but large refactor
2. **Add push subscription to OrkaClient directly** — simpler, some duplication
3. **Use WsTransport directly in RemoteNodeManager** — bypass OrkaClient, most pragmatic

**Recommendation**: Option 3. The `RemoteNodeManager` creates a `WsTransport` per remote node instead of `OrkaClient`. `WsTransport` already handles Noise handshake, push subscriptions, reconnection, and RPC. The `RemoteNodeHandle` wraps a `WsTransport` and exposes `request()` for proxied RPCs and `subscribe()` for push forwarding.

This avoids touching `OrkaClient` entirely and reuses the battle-tested `WsTransport`.

**Files**:
- Modified: `packages/daemon/src/remote-nodes.ts` — use `WsTransport` instead of `OrkaClient`

**Complexity**: M (part of 1.2 work)

**Dependencies**: 1.2

### 1.4 Session Aggregation

**What**: `listSessions` and `getSession` need to merge local + remote sessions. Other query methods (`getSessionTimeline`, `getChatMessages`, `getResult`, etc.) need to route to the correct node.

**Files**:
- New: `packages/daemon/src/aggregating-client.ts`
- Modified: `packages/daemon/src/server.ts` — use `AggregatingClient` instead of `LocalClient` when remote nodes exist
- Modified: `packages/core/src/types.ts` — add `nodeId` to `Session` and `SessionSummary`

**Design**:
```typescript
/**
 * Wraps a LocalClient (for local sessions) and RemoteNodeManager (for remote
 * sessions). Implements OrkaService by merging/routing as appropriate.
 */
export function createAggregatingClient(
  localClient: OrkaService,
  remoteNodes: RemoteNodeManager,
  nodeRegistry: NodeRegistry,
): OrkaService;
```

**Method behavior by category**:

| Method | Behavior | Notes |
|--------|----------|-------|
| `listSessions` | Merge local + all remote | Parallel fetch, add `nodeId` to each |
| `getSession` | Route by session ID prefix or lookup | See routing strategy below |
| `getSessionTimeline` | Route to owning node | |
| `getChatMessages` | Route to owning node | |
| `getResult` | Route to owning node | |
| `captureOutput` | Route to owning node | |
| `getLogContent` | Route to owning node | |
| `getDiff` | Route to owning node | |
| `spawn` | Route by explicit `nodeId` param, or local | |
| `stop` | Route to owning node | |
| `sendTurn` | Route to owning node | |
| `merge` | Route to owning node | |
| `setKept` | Route to owning node | |
| `isAlive` | Route to owning node | |
| `listNodes` | Merge local node + all remote node handles | |
| `startPairing` | Local only (node-side operation) | |
| `getPendingApprovals` | Route to owning node (or merge all if no sessionId) | |
| `resolveApproval` | Route to owning node | |
| `terminalOpen/Write/Resize/Close/List` | Route to owning node | |
| `getUsage` | Merge local + remote | Aggregate cost/tokens |
| `getMetrics` | Local only | |
| `queryTraces` | Local only | |
| `deleteSessions` | Route each to owning node | |
| `pruneSessions` | Local only (remote nodes prune themselves) | |
| `archiveSession` | Route to owning node | |
| `backfillSession` | Route to owning node | |
| `reap` | Local only | |

**Session routing strategy**: The aggregator maintains an in-memory `Map<sessionId, nodeId>` built from `listSessions` responses and updated by push events. When a session-specific RPC arrives:
1. Look up `nodeId` in the map
2. If found, route to that node's `WsTransport`
3. If not found, try local first, then fall back to querying each remote node
4. If `nodeId === "local"`, route to `LocalClient`

**Session ID uniqueness**: Session IDs are UUIDs (`sess-<nanoid>`), so collisions across nodes are astronomically unlikely. No namespacing needed.

**Error handling for unreachable nodes**: If a remote node is disconnected, its sessions are still listed (from cached state) but marked with a stale indicator. RPCs to unreachable nodes return an error with code `NODE_UNREACHABLE`.

**Complexity**: L

**Dependencies**: 1.2 (Remote Node Connections), 1.3 (Push Subscriptions)

### 1.5 Session Cache

**What**: The aggregator needs to cache remote sessions for fast `listSessions` and session routing. Without caching, every `listSessions` call would require parallel RPCs to all nodes.

**Files**:
- New: `packages/daemon/src/session-cache.ts`

**Design**:
```typescript
interface SessionCache {
  /** Replace all sessions for a node. Called on initial fetch. */
  setNodeSessions(nodeId: string, sessions: SessionSummary[]): void;
  /** Update a single session (from push event). */
  upsertSession(nodeId: string, session: SessionSummary): void;
  /** Remove a session (from deletion push). */
  removeSession(sessionId: string): void;
  /** Get all cached sessions across all nodes. */
  getAllSessions(): SessionSummary[];
  /** Look up which node owns a session. */
  getOwningNode(sessionId: string): string | null;
  /** Clear cache for a node (on disconnect). */
  clearNode(nodeId: string): void;
}
```

**Lifecycle**:
1. On remote node connect: fetch `listSessions()`, populate cache
2. On `orchestration.sessionUpdated` push: upsert in cache
3. On `orchestration.sessionDeleted` push: remove from cache
4. On node disconnect: keep cached sessions but mark node as offline
5. On node reconnect: re-fetch and replace

**`listSessions` with cache**: Returns `localClient.listSessions()` merged with `sessionCache.getAllSessions()`. The local sessions are always fresh (from SQLite). Remote sessions are from cache + live push updates.

**Complexity**: M

**Dependencies**: 1.2 (Remote Node Connections)

### 1.6 Spawn Routing

**What**: When the user spawns a session via dashboard (or CLI with `--node`), the spawn request must route to the correct node.

**Files**:
- Modified: `packages/core/src/types.ts` — `SpawnRequest` already has an optional `nodeId` field (used by dashboard's `NewSessionDialog`)
- Modified: `packages/daemon/src/aggregating-client.ts` — route spawn by `nodeId`

**Behavior**:
- `nodeId` absent or `"local"`: spawn on local daemon (default)
- `nodeId` set to a remote node ID: forward `spawn()` RPC to that node's `WsTransport`
- `nodeId` set to unknown node: error `NODE_NOT_FOUND`

**Complexity**: S (covered by aggregating-client routing logic)

**Dependencies**: 1.4 (Session Aggregation)

### 1.7 Push Forwarding to Dashboard

**What**: Push events from remote nodes must reach dashboard clients connected to the local daemon.

**Files**:
- Modified: `packages/daemon/src/remote-nodes.ts` — subscribe to remote push channels and re-broadcast

**Design**: The `RemoteNodeManager` subscribes to three channels on each remote `WsTransport`:
- `orchestration.event` — session timeline events
- `orchestration.sessionUpdated` — session status changes
- `orchestration.sessionDeleted` — session deletion

On receiving a push, it:
1. Attaches `nodeId` to the event data (if not already present)
2. Updates the session cache
3. Broadcasts via local `PushHub` to all connected dashboard clients

**Session log streaming**: `session.logLine` push channel is session-specific. The dashboard subscribes to log lines for a selected session. When the dashboard selects a remote session, it should subscribe via the aggregator, which proxies the subscription to the remote node. This is complex — for v1, the dashboard can fetch logs via RPC (`getLogContent`) and poll, or the aggregator can subscribe to log lines for all active remote sessions and re-broadcast.

**Recommendation for v1**: Forward `orchestration.event` (which includes `content.delta`) and `orchestration.sessionUpdated` pushes. These are sufficient for the chat view. `session.logLine` forwarding is deferred.

**Complexity**: M

**Dependencies**: 1.2, 1.5 (Session Cache)

### 1.8 DaemonContext Changes

**What**: Add `NodeRegistry` and `RemoteNodeManager` to `DaemonContext`.

**Files**:
- Modified: `packages/daemon/src/daemon-context.ts`

**Design**:
```typescript
interface DaemonContext {
  // ... existing fields ...
  nodeRegistry: NodeRegistry;
  remoteNodes: RemoteNodeManager;
}
```

Both are always created, but `RemoteNodeManager` starts with zero connections if no nodes are configured. The `AggregatingClient` wraps `LocalClient` and delegates to `RemoteNodeManager` for remote operations.

**Complexity**: S

**Dependencies**: 1.1, 1.2

---

## 2. Pairing via Daemon RPC

### 2.1 Client-Side Pairing RPCs

**What**: New RPC methods so the dashboard (in local mode) can trigger pairing through the daemon instead of doing it in-browser.

**Current state**: `startPairing` exists but is a **node-side** operation (the daemon creates an enrollment for others to pair with). We need the **client-side** equivalent — the daemon acts as a pairing client, connecting to a remote node's enrollment.

**Files**:
- Modified: `packages/core/src/service.ts` — add new methods to `OrkaService`
- Modified: `packages/daemon/src/local-client.ts` — implement client-side pairing
- Modified: `packages/daemon/src/rpc-handler.ts` — register new RPC handlers
- New: `packages/daemon/src/client-pairing.ts` — daemon-side PairingClient orchestration

**New OrkaService methods**:
```typescript
interface OrkaService {
  // ... existing ...

  /** Initiate pairing with a remote node as a CLIENT.
   * Daemon runs PairingClient, performs SPAKE2 + Noise verify,
   * saves node to ~/.orka/nodes/, connects automatically. */
  pairWithNode(params: PairWithNodeParams): Promise<PairWithNodeResult>;

  /** Get progress of an active client-side pairing. */
  getPairingProgress(pairingId: string): Promise<PairingProgress>;

  /** List all paired remote nodes. */
  listPairedNodes(): Promise<StoredNode[]>;

  /** Remove a paired node (disconnect + delete keys). */
  removePairedNode(nodeId: string): Promise<void>;

  /** Manually connect/disconnect a paired node. */
  connectNode(nodeId: string): Promise<void>;
  disconnectNode(nodeId: string): Promise<void>;
}

interface PairWithNodeParams {
  /** The pairing code from the remote node operator. */
  pairingCode: string;
  /** Relay URL to reach the node. */
  relayUrl: string;
  /** Auth token for relay. */
  relayToken?: string;
}

interface PairWithNodeResult {
  pairingId: string;          // For polling progress
  nodeId: string;             // From bootstrap
  nodeName: string;
}

interface PairingProgress {
  pairingId: string;
  state: "connecting" | "hello" | "spake2" | "bootstrap" | "noise_verify" | "done" | "failed";
  error?: string;
  nodeId?: string;
  nodeName?: string;
}
```

**Implementation flow** (`pairWithNode`):
1. Parse pairing code → extract secret, derive enrollId
2. Open WebSocket to `relayUrl/v1/pair/<enrollId>` (with auth token)
3. Run `PairingClient` state machine (same code as dashboard uses)
4. On bootstrap success: verify Noise NK handshake against received pubkey
5. On Noise verify success: save node to `NodeRegistry` and keys to `~/.orka/nodes/`
6. Auto-connect to the new node via `RemoteNodeManager`
7. Return `PairWithNodeResult`

**Pairing progress tracking**: Since pairing is async (WebSocket-based, takes user interaction time), `pairWithNode` returns immediately with a `pairingId`. The dashboard polls `getPairingProgress` for status updates. Alternatively, progress can be pushed via a dedicated push channel.

**Recommendation**: Make `pairWithNode` synchronous (blocks until complete or fails). The pairing flow takes 2-5 seconds and the dashboard can show a spinner. This avoids the complexity of progress tracking. If a timeout is needed, use a 30-second RPC timeout.

**Complexity**: L

**Dependencies**: 1.1 (Node Registry), 1.2 (Remote Node Connections)

### 2.2 Dashboard Pairing in Local Mode

**What**: In local mode, the `PairNodeDialog` calls daemon RPCs instead of running `PairingClient` in-browser.

**Files**:
- Modified: `packages/dashboard/src/components/PairNodeDialog.tsx` — two code paths based on mode

**Behavior in local mode**:
1. User enters pairing code + relay URL
2. Dashboard calls `pairWithNode({ pairingCode, relayUrl, relayToken })` via RPC
3. Dashboard shows spinner while RPC is in progress
4. On success: daemon is already connected to the new node, dashboard refreshes node list
5. On failure: show error message

**Behavior in hosted mode**: Same as current implementation — browser runs `PairingClient` directly.

**Complexity**: M

**Dependencies**: 2.1, 3.1 (Mode Selection)

### 2.3 Node Management RPCs

**What**: Dashboard needs to list, connect/disconnect, and remove paired nodes.

**Files**:
- Modified: `packages/daemon/src/rpc-handler.ts` — register handlers
- Modified: `packages/daemon/src/local-client.ts` — implement methods

**These methods are only meaningful in local mode** (in hosted mode, the browser manages its own node list). The dashboard's node management UI uses these RPCs in local mode and localStorage in hosted mode.

**`listNodes()` enhancement**: Currently returns `[{ id: "local", status: "online" }]`. With aggregation, it returns:
```typescript
[
  { id: "local", status: "online", activeRequests: 3, registeredAt: ... },
  { id: "fra1-gpu-01", status: "online", activeRequests: 1, registeredAt: ... },
  { id: "us-east-01", status: "reconnecting", activeRequests: 0, registeredAt: ... },
]
```

**Complexity**: S

**Dependencies**: 1.1, 1.2, 1.8

---

## 3. Dashboard Dual-Mode

### 3.1 Mode Selection

**What**: Explicit mode selection — the dashboard must know whether it's operating in local or hosted mode. Not auto-detected.

**Files**:
- Modified: `packages/dashboard/src/stores/connectionSettingsStore.ts` — add `mode` field
- Modified: `packages/dashboard/src/components/ConnectionSettingsDialog.tsx` — mode toggle

**Design**:
```typescript
interface ConnectionSettings {
  // ... existing ...
  mode: "local" | "hosted";  // persisted in localStorage
}
```

**Mode determination**:
- **Default**: `"local"` (most common case — desktop/self-hosted)
- **Explicit toggle**: ConnectionSettingsDialog has a clear "Local Daemon" / "Direct to Relay" switch
- **Build-time override**: `VITE_DASHBOARD_MODE=hosted` forces hosted mode (for SaaS deployment)
- **URL parameter**: `?mode=hosted` overrides persisted setting (for testing)

**Why not auto-detect**: Auto-detection (e.g., "if localhost → local, else hosted") is fragile. The user might run a daemon on a remote server and connect to it via SSH tunnel (still "local mode" semantics). Explicit selection is clearer.

**Complexity**: S

**Dependencies**: None

### 3.2 Transport Setup by Mode

**What**: Different transport initialization depending on mode.

**Files**:
- Modified: `packages/dashboard/src/App.tsx` — transport creation logic

**Local mode**:
```typescript
// Connect to local daemon, no Noise
const url = getDaemonUrl(); // same-origin /ws
const transport = new WsTransport(url);
```
- No `NoiseConfig` — local daemon is trusted (same machine)
- No `authToken` — localhost, no relay in the path
- Dashboard uses daemon RPCs for everything (pairing, node management, session ops)

**Hosted mode**:
```typescript
// Connect to relay with Noise
const url = endpointUrl; // e.g. "wss://relay.example.com/ws"
const noiseConfig = resolveNoiseConfig(pairedNodeId);
const transport = new WsTransport(appendAuthToken(url, authToken), { noiseConfig });
```
- `NoiseConfig` from browser localStorage (from browser-side pairing)
- `authToken` for relay authentication
- Dashboard manages its own pairing, node keys, etc.

**Complexity**: S

**Dependencies**: 3.1 (Mode Selection)

### 3.3 Component Behavior by Mode

**What**: Some components behave differently based on mode.

| Component | Local Mode | Hosted Mode |
|-----------|-----------|-------------|
| `PairNodeDialog` | Calls `pairWithNode` RPC | Runs `PairingClient` in browser |
| `ConnectionSettingsDialog` | Hides relay URL/token (daemon manages) | Shows relay URL/token inputs |
| `Sidebar` (node selector) | Uses `listNodes` RPC (includes remote) | Uses `listNodes` RPC (relay-reported) |
| `SessionView` | All RPCs go to local daemon (which routes) | RPCs go directly to relay with `node` field |
| `NewSessionDialog` | Spawns via daemon (which routes to node) | Spawns via relay with `node` routing |
| `StatusBar` | Shows daemon connection status | Shows relay connection status |
| Noise key storage | Keys on daemon filesystem | Keys in browser localStorage |
| Node metadata | `~/.orka/nodes/` via RPC | Browser localStorage |

**Files**:
- Modified: `packages/dashboard/src/components/PairNodeDialog.tsx`
- Modified: `packages/dashboard/src/components/ConnectionSettingsDialog.tsx`
- Modified: `packages/dashboard/src/components/Sidebar.tsx`
- Possibly: new `packages/dashboard/src/hooks/useMode.ts` — custom hook for mode access

**Implementation**: Create a `useMode()` hook that reads from `connectionSettingsStore`. Components that differ by mode use:
```typescript
const mode = useMode();
if (mode === "local") {
  // call daemon RPC
} else {
  // do it in browser
}
```

**Complexity**: M

**Dependencies**: 3.1, 3.2, 2.2

### 3.4 Hosted Mode: Keep Existing Code

**What**: The existing browser-side Noise/pairing code (`noiseKeys.ts`, `nodeRegistry.ts`, `PairNodeDialog` pairing flow, `WsTransport` with `NoiseConfig`) is the hosted mode implementation. It stays as-is.

**No changes needed** — just ensure it's guarded by `mode === "hosted"` checks where the local mode path diverges.

**Complexity**: S

**Dependencies**: 3.1

---

## 4. Migration Path

### 4.1 What Stays

- `@orka/core` pairing protocol (SPAKE2, Noise), transport types — shared by both modes
- `@orka/client` `WsTransport`, `OrkaClient`, `driveNoiseHandshake` — used by daemon aggregator (local mode) and dashboard (hosted mode)
- `@orka/relay` — completely unchanged (transparent router)
- `@orka/daemon` `LocalClient`, `PushHub`, `OrchestrationEngine`, `ProviderService` — all stay, LocalClient becomes the "local" leg of the aggregator
- `@orka/dashboard` existing Noise/pairing code — stays for hosted mode

### 4.2 What's New

- `packages/daemon/src/node-registry.ts` — file-based node storage
- `packages/daemon/src/remote-nodes.ts` — `WsTransport`-based connections to remote nodes
- `packages/daemon/src/session-cache.ts` — in-memory session cache for remote nodes
- `packages/daemon/src/aggregating-client.ts` — `OrkaService` wrapper that merges local + remote
- `packages/daemon/src/client-pairing.ts` — daemon-side pairing client orchestration
- `packages/dashboard/src/hooks/useMode.ts` — mode selection hook

### 4.3 What Changes

- `packages/core/src/service.ts` — new methods (`pairWithNode`, `listPairedNodes`, `removePairedNode`, `connectNode`, `disconnectNode`)
- `packages/core/src/types.ts` — `nodeId` field on `Session`/`SessionSummary`, `NodeInfo` enhanced
- `packages/daemon/src/daemon-context.ts` — add `NodeRegistry`, `RemoteNodeManager`
- `packages/daemon/src/server.ts` — use `AggregatingClient`, initialize remote connections
- `packages/daemon/src/rpc-handler.ts` — register new RPC handlers
- `packages/daemon/src/local-client.ts` — implement new methods, enhance `listNodes()`
- `packages/dashboard/src/App.tsx` — mode-aware transport creation
- `packages/dashboard/src/stores/connectionSettingsStore.ts` — add `mode` field
- `packages/dashboard/src/components/PairNodeDialog.tsx` — mode-conditional pairing
- `packages/dashboard/src/components/ConnectionSettingsDialog.tsx` — mode toggle

### 4.4 What Gets Deleted

Nothing. Both modes coexist. The browser-side pairing/Noise code is the hosted mode implementation.

### 4.5 CLI Compatibility

The CLI is unaffected. It continues to:
- Connect to local daemon via `RemoteClient`
- Or connect to relay via `--remote` flag

The CLI already supports `--node` for routing, which works through the relay. With the aggregator, the same `--node` flag works through the local daemon's aggregating client.

**New CLI capability**: `orka node pair <code>` could call `pairWithNode` on the daemon, but this is optional (the operator can also use the dashboard).

### 4.6 Incremental Phasing

The work can be phased so each phase is independently useful:

**Phase 1: Node Registry + Remote Connections** (1.1, 1.2, 1.3, 1.8)
- Daemon can connect to remote nodes
- Push events forwarded to dashboard
- `listNodes` shows remote nodes
- Dashboard sees remote nodes in sidebar
- Sessions still queried individually per node (existing dashboard multi-node fetch)

**Phase 2: Session Aggregation** (1.4, 1.5, 1.6, 1.7)
- `listSessions` merges local + remote
- RPCs routed to correct node automatically
- Dashboard doesn't need to do per-node parallel fetch anymore

**Phase 3: Client-Side Pairing via Daemon** (2.1, 2.2, 2.3)
- Dashboard can trigger pairing through daemon
- Node management RPCs

**Phase 4: Explicit Dual-Mode** (3.1, 3.2, 3.3, 3.4)
- Dashboard mode selection
- Mode-conditional component behavior

---

## 5. Desktop App Considerations

### 5.1 Daemon + Dashboard Bundling

**Electron/Tauri shell**:
- Main process starts daemon (`orka serve`) as a child process
- Renderer loads dashboard (Vite build or dev server)
- Dashboard always operates in local mode — no mode selection UI needed

**Daemon lifecycle**:
- Start on app launch: spawn `bun run packages/cli/src/index.ts serve --port 0` (ephemeral port)
- Read assigned port from stdout or health check
- Stop on app quit: send `SIGTERM` to daemon process
- Crash recovery: monitor child process, restart if exits unexpectedly

### 5.2 Port Discovery

The desktop app needs to know which port the daemon is listening on:

**Option A**: Fixed port (7394) — simple but conflicts if user also runs CLI daemon
**Option B**: Ephemeral port (`--port 0`) — daemon writes port to `~/.orka/daemon.port`
**Option C**: Unix socket (`--socket ~/.orka/daemon.sock`) — no port conflicts, but requires WS-over-unix-socket support

**Recommendation**: Option B. The daemon already writes PID to `~/.orka/daemon.pid`. Add port to `~/.orka/daemon.port` or combine into `~/.orka/daemon.json`:
```json
{ "pid": 12345, "port": 7394, "startedAt": "2026-03-15T..." }
```

### 5.3 Security

- **No network exposure**: Daemon binds to `127.0.0.1` only (already the default)
- **No auth for local**: Localhost connections are trusted (no tokens needed)
- **Key storage**: `~/.orka/nodes/` and `~/.orka/keys/` — standard OS file permissions
- **Electron specific**: Enable `contextIsolation`, disable `nodeIntegration` in renderer
- **Tauri specific**: Use Tauri's built-in security model (no Node in renderer)

### 5.4 Build & Distribution

Not in scope for this plan — the desktop app shell is a separate effort. This plan ensures the architecture supports it by:
- Making local mode the default
- Keeping daemon lifecycle simple (single binary, single process)
- Not requiring browser crypto for local mode

**Complexity**: N/A (separate project)

---

## 6. Risks and Open Questions

### 6.1 Aggregation Consistency

**Risk**: Remote node goes offline during a `listSessions` fetch.

**Mitigation**: Session cache provides stale-but-available data. Each session in the response includes a `stale: boolean` flag (or `lastSeen` timestamp) so the dashboard can indicate staleness.

**Open question**: Should `listSessions` fail if any node is unreachable, or return partial results? **Recommendation**: Always return partial results. The dashboard can show a banner "Node X is offline — some sessions may be outdated".

### 6.2 Session Ownership Ambiguity

**Risk**: A session ID appears in the cache but the owning node is offline. RPC calls to that session fail.

**Mitigation**: Clear error message (`NODE_UNREACHABLE`) with the node name, so the user knows why. The session is still visible in the list (from cache) but interactions fail gracefully.

### 6.3 Config/State Conflicts

**Risk**: CLI and dashboard both manage the daemon — pairing a node via CLI while dashboard is connected.

**Mitigation**: All state changes go through the daemon (single source of truth). The daemon broadcasts `node.added`, `node.removed`, `node.statusChanged` push events so the dashboard stays in sync. New push channel: `fleet.nodeUpdated`.

### 6.4 Rate Limits

**Risk**: Daemon as aggregator opens N connections to relay (one per remote node), plus the dashboard connection. This may hit relay connection limits.

**Mitigation**: The daemon's connections to relay are persistent (not per-request). One WebSocket per remote node, reused for all RPCs. Relay connection limits are per-account, so a single account with 10 nodes uses 10 connections — well within typical limits (default 100 per account).

### 6.5 Push Event Ordering

**Risk**: Push events from remote nodes arrive asynchronously. The local PushHub has its own sequence numbers. Re-broadcasting remote pushes may cause sequence gaps or ordering confusion.

**Mitigation**: Separate push sequence spaces. Remote push events are broadcast with their original `nodeId` and `eventId`. The dashboard's gap detection should be per-node, not global. This may require changes to the dashboard's sequence tracking.

### 6.6 Noise Key Rotation

**Risk**: A remote node rotates its Noise static key. The daemon's stored key becomes invalid, Noise handshakes fail.

**Mitigation**: On `key_id_mismatch` error during handshake, the daemon marks the node as "key_mismatch" status and notifies the dashboard. Re-pairing is required. The daemon should not auto-accept new keys (TOFU violation).

### 6.7 WsTransport in Node.js/Bun Context

**Risk**: `WsTransport` was designed for browser use (dashboard). Using it in the daemon (Bun) may expose browser-specific assumptions (e.g., `window`, `localStorage`, `performance.now()`).

**Mitigation**: `WsTransport` is in `@orka/client`, which is a shared package. Audit for browser-only APIs. The `OrkaClient` already works in Bun, so the WebSocket layer is compatible. The push subscription and reconnection logic should work identically.

### 6.8 Daemon Memory Usage

**Risk**: Session cache grows unbounded with many remote sessions.

**Mitigation**: Cache only `SessionSummary` (small objects, ~500 bytes each). Even with 10 nodes x 1000 sessions each = 10K summaries ≈ 5 MB. Acceptable. Add a configurable limit if needed.

### 6.9 Open Question: Should the Aggregator Store Events?

The architecture-target.md mentions the aggregator "stores aggregated events in its own DB for historical queries". For v1, the daemon aggregator does NOT store remote events locally. It caches `SessionSummary` objects and proxies timeline/event queries to the owning node. This is simpler and avoids data duplication. If historical queries across offline nodes are needed, that's a v2 feature.

---

## Dependency Graph

```
                    ┌─────────────────┐
                    │  3.1 Mode       │
                    │  Selection      │ S
                    └───┬─────┬───────┘
                        │     │
              ┌─────────┘     └──────────┐
              ▼                          ▼
    ┌─────────────────┐        ┌─────────────────┐
    │  3.2 Transport  │        │  3.3 Component  │
    │  Setup by Mode  │ S      │  Behavior       │ M
    └─────────────────┘        └──────┬──────────┘
                                      │
                                      ▼
                               ┌─────────────────┐
                               │  3.4 Keep        │
                               │  Hosted Code     │ S
                               └─────────────────┘


    ┌─────────────────┐
    │  1.1 Node       │
    │  Registry       │ S
    └───┬─────────────┘
        │
        ▼
    ┌─────────────────┐
    │  1.2 Remote     │◄───── 1.3 Push Subs (M)
    │  Node Conns     │ L          (part of 1.2)
    └───┬──┬──────────┘
        │  │
        │  ├────────────────────────┐
        │  │                        │
        ▼  ▼                        ▼
  ┌───────────────┐    ┌─────────────────┐
  │ 1.5 Session   │    │ 1.8 Context     │
  │ Cache         │ M  │ Changes         │ S
  └───┬───────────┘    └─────────────────┘
      │
      ▼
  ┌───────────────┐
  │ 1.4 Session   │◄──── 1.6 Spawn Routing (S)
  │ Aggregation   │ L         (part of 1.4)
  └───┬───────────┘
      │
      ▼
  ┌───────────────┐
  │ 1.7 Push      │
  │ Forwarding    │ M
  └───────────────┘


    ┌─────────────────┐
    │  2.1 Client     │ ◄── depends on 1.1, 1.2
    │  Pairing RPCs   │ L
    └───┬─────────────┘
        │
        ▼
    ┌─────────────────┐
    │  2.2 Dashboard  │ ◄── depends on 3.1
    │  Pairing UI     │ M
    └───┬─────────────┘
        │
        ▼
    ┌─────────────────┐
    │  2.3 Node Mgmt  │
    │  RPCs           │ S
    └─────────────────┘
```

## Recommended Implementation Order

| Order | Task | Size | Rationale |
|-------|------|------|-----------|
| 1 | 1.1 Node Registry | S | Foundation — no other work without this |
| 2 | 1.8 DaemonContext Changes | S | Wire registry into daemon |
| 3 | 1.2 + 1.3 Remote Node Connections | L | Core aggregator capability |
| 4 | 1.5 Session Cache | M | Needed for efficient aggregation |
| 5 | 1.4 + 1.6 Session Aggregation + Routing | L | The main feature — merged views |
| 6 | 1.7 Push Forwarding | M | Real-time updates for remote sessions |
| 7 | 3.1 Mode Selection | S | Prerequisite for dashboard changes |
| 8 | 3.2 Transport Setup | S | Mode-aware connection |
| 9 | 2.1 Client Pairing RPCs | L | Daemon-side pairing |
| 10 | 2.2 + 2.3 Dashboard Pairing + Node Mgmt | M | UI for pairing through daemon |
| 11 | 3.3 + 3.4 Component Behavior | M | Polish — mode-conditional UI |

**Total estimated effort**: ~4 large + ~4 medium + ~5 small tasks.

Steps 1-6 (daemon aggregator) can be developed and tested independently of steps 7-11 (dashboard changes). The CLI can exercise the aggregator via direct RPC before the dashboard is updated.
