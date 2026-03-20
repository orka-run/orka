# Delta Sync on WS Reconnect — Research

## Problem

When the dashboard WebSocket reconnects after a disconnection, there is a window where push events were missed. Currently:

- Push subscriptions are re-established via `syncSubscriptions()`
- The outbox of pending RPCs is flushed
- The server sends its latest cached push value per channel
- **No automatic backfill** of events missed during the gap

The gap detection system (`reportEventGap()`) fires telemetry but does not trigger recovery. If the client was disconnected for N minutes, transient events (status transitions, orchestration events, log lines) are silently lost until the user manually refreshes.

## Existing Primitives

Before evaluating approaches, it's worth noting what Orka already has:

| Primitive | Location | Notes |
|-----------|----------|-------|
| Per-session event sequence (`seq`) | `orchestration_events` table | Monotonic, gapless, per-session |
| Per-channel push sequence | `PushHub.broadcastSequences` | Monotonic, per-channel |
| Per-client push sequence | `PushHub.directSequences` | Monotonic, per-client |
| Gap detection | `ws-transport.ts` | Detects non-consecutive sequences |
| `backfillSession()` RPC | `OrkaService` | Replays orchestration events for one session |
| `getSessionTimeline()` RPC | `OrkaService` | Full event history for a session |
| Latest push cache | `PushHub` + `WsTransport` | Caches most recent push per channel |
| Append-only event log | `orchestration_events` | Immutable, indexed by `(session_id, seq)` |

## Approaches

### 1. Cursor / Sequence-Based Delta Sync

**How it works:** Client tracks the highest push sequence seen. On reconnect, sends `lastSeq` to server. Server replays all pushes with `seq > lastSeq`.

**Requires:**
- Global push sequence (not per-channel, not per-session) — or one cursor per channel
- Server-side push log (ring buffer or bounded table) to replay from
- New RPC: `catchUp({ lastSequence, channels[] }) → PushEnvelope[]`

**Pros:**
- Minimal data transfer — only missed events
- Exact — no duplicates if sequences are gapless
- Natural fit — PushHub already tracks sequences

**Cons:**
- Requires persisting push history (currently ephemeral, in-memory only)
- Ring buffer sizing: too small = can't catch up after long disconnects, too large = memory
- Must handle buffer overflow (fallback to full reload)

**Complexity:** Medium. New server-side push log + catchUp RPC + client cursor tracking.

### 2. Timestamp-Based Delta Sync

**How it works:** Client records wall-clock time of last received event. On reconnect, requests all changes since that timestamp.

**Requires:**
- Server query: `SELECT * FROM orchestration_events WHERE timestamp > ? ORDER BY timestamp`
- Session-level: `SELECT * FROM sessions WHERE updated_at > ?` (needs new column)

**Pros:**
- Simple mental model
- Works across restarts (timestamps survive process death)

**Cons:**
- Clock skew between client and server
- No `updated_at` column on sessions table currently
- Timestamp resolution issues (multiple events in same millisecond)
- Cannot detect deletions (pruned sessions)

**Complexity:** Low-Medium. Needs `updated_at` column + timestamp query + deletion tracking.

### 3. Generation / Epoch Counter

**How it works:** Server maintains a monotonic generation counter. Every mutation increments it. Client sends its last-known generation on reconnect; server diffs.

**Requires:**
- Global generation counter (single row table or in-memory atomic)
- Generation stamped on every session row mutation
- Diff query: `SELECT * FROM sessions WHERE generation > ?`
- Deletion log: `INSERT INTO deletions (id, generation) ...`

**Pros:**
- No clock skew — pure logical ordering
- Single cursor covers all entity types
- Efficient: one integer comparison

**Cons:**
- Does not naturally cover orchestration events (they're per-session, not global)
- Need a deletion log for pruned sessions
- Hot counter — every write touches the same global state

**Complexity:** Medium. New counter + generation column + deletion log.

### 4. Event Log / WAL Replay

**How it works:** All state changes are persisted as an ordered event log. On reconnect, client replays events from its last checkpoint.

**Requires:**
- Unified event log covering all push-worthy mutations (not just orchestration events)
- Session status changes, deletions, workspace changes all recorded
- Client-side projection that can apply events incrementally

**Pros:**
- Complete — captures everything including deletions
- Naturally idempotent if events have IDs
- Already have `orchestration_events` — could extend it

**Cons:**
- Orchestration events are per-session scoped, not global
- Session-list-level changes (create, delete, status) aren't in the event log
- Requires client-side event application logic (duplicates server projection)
- Unbounded growth without compaction

**Complexity:** High. Requires unifying all mutations into one log + client-side projectors.

### 5. Snapshot + Catch-Up (Hybrid)

**How it works:** On reconnect, client fetches a lightweight snapshot (session list with statuses), then subscribes to live events. Server compares client state to current state and sends deltas.

**Variant A — Client sends state hash:**
- Client sends hash of its session list (or sorted ID+status pairs)
- Server compares, returns diff (added, removed, changed sessions)
- For changed sessions, client fetches timeline from last-known `seq`

**Variant B — Server snapshot with sequence (t3code pattern):**
- Client requests snapshot, which includes a `snapshotSequence`
- Client sets `lastSeq = snapshotSequence`
- Live events after `snapshotSequence` flow through push
- Deduplication via sequence comparison

**Pros:**
- Simple to implement (Variant B is what t3code uses)
- Self-healing — snapshot corrects any drift
- No server-side push history needed
- Handles long disconnects gracefully

**Cons:**
- Snapshot can be large if many sessions
- Variant A: requires diffing logic on server
- Variant B: small race window between snapshot fetch and push subscription

**Complexity:** Low (Variant B). Needs `snapshotSequence` on snapshot response + client dedup.

## Reference: t3code Implementation

The `/tmp/t3code/` codebase uses **Variant B (Snapshot + Sequence)**:

1. Global sequence counter on all push messages
2. Client tracks `latestSequence` — discards events with `seq <= latestSequence`
3. On reconnect: fetch full `OrchestrationReadModel` snapshot (includes `snapshotSequence`)
4. Set `latestSequence = max(latestSequence, snapshotSequence)`
5. Resume live push events — dedup prevents double-processing
6. Has `replayEvents(fromSequenceExclusive)` RPC but does NOT use it in production

**Why they chose snapshot over replay:** Simpler reconnection logic, self-healing, no need to persist push history. Trades slightly higher bandwidth for much simpler correctness.

## Reference: Industry Patterns

| System | Approach | Notes |
|--------|----------|-------|
| Figma | Operation log + snapshot | CRDT-based, snapshot for initial load, ops for incremental |
| Linear | Sync engine with delta log | Cursor-based, client tracks sync cursor, server sends deltas |
| Liveblocks | Event log + snapshot | Yjs CRDT with periodic snapshots, events in between |
| Firebase RTDB | Snapshot + listener | Full snapshot on subscribe, then incremental patches |
| Supabase Realtime | WAL-based | Postgres WAL → WebSocket, cursor is WAL LSN |
| Phoenix LiveView | Full re-render | Server re-renders on reconnect, sends full diff |

## Comparison Matrix

| Criteria | Cursor/Seq | Timestamp | Generation | Event Log | Snapshot+Catch-Up |
|----------|------------|-----------|------------|-----------|-------------------|
| **Implementation effort** | Medium | Low-Med | Medium | High | **Low** |
| **Bandwidth efficiency** | Best | Good | Good | Best | Moderate |
| **Handles long disconnects** | No (buffer overflow) | Yes | Yes | Yes (if unbounded) | **Yes** |
| **Handles deletions** | Yes (if logged) | No | Yes (if logged) | Yes | **Yes** |
| **Clock dependency** | No | Yes | No | No | **No** |
| **Self-healing** | No | No | No | No | **Yes** |
| **Existing primitives** | Partial | Partial | None | Partial | **Partial** |
| **Server memory cost** | Ring buffer | None | Counter | Log growth | **None** |
| **Correctness risk** | Buffer overflow | Clock skew | Hot counter | Projection bugs | **Race window** |

## Recommendation: Snapshot + Catch-Up (Approach 5B)

**Why:** Lowest implementation cost, self-healing, handles all edge cases (long disconnects, deletions, server restarts), proven in production by t3code/Firebase/Phoenix. The slight bandwidth overhead of a session-list snapshot is negligible for Orka's scale (tens to low hundreds of sessions).

### Proposed Design

#### Phase 1 — Session List Sync (covers 90% of reconnect pain)

1. **Add `snapshotSequence` to session list response:**
   - Server tracks a global push sequence counter (already exists in PushHub)
   - `listSessions()` response includes `{ sessions, snapshotSequence }`
   - Client stores `lastSnapshotSequence`

2. **On reconnect:**
   - Client calls `listSessions()` → gets fresh snapshot + `snapshotSequence`
   - Replaces local session store with snapshot
   - Sets `lastPushSequence = snapshotSequence`
   - Subscribes to push channels
   - Incoming pushes with `sequence <= lastPushSequence` are discarded (dedup)

3. **During normal operation:**
   - Push events update local store incrementally (existing behavior)
   - Client tracks `lastPushSequence` from each push

#### Phase 2 — Timeline Catch-Up (for open session detail views)

4. **Add cursor support to `getSessionTimeline()`:**
   - New param: `afterSeq?: number`
   - Returns only events with `seq > afterSeq` for that session
   - Client stores `lastEventSeq` per viewed session

5. **On reconnect with open session detail:**
   - Client calls `getSessionTimeline({ sessionId, afterSeq: lastEventSeq })`
   - Appends new events to existing timeline
   - Avoids re-fetching potentially thousands of events

#### Phase 3 — Optimizations (optional, if scale demands)

6. **Lightweight diff endpoint:**
   - Client sends `{ sessionIds: string[], lastSequence: number }`
   - Server returns `{ added, removed, changed }` session IDs
   - Client fetches detail only for changed sessions
   - Only needed if session list snapshot becomes too large

### What NOT to Build

- **Server-side push history ring buffer** — adds complexity, snapshot is simpler and self-healing
- **Client-side event projection** — duplicates server logic, bug-prone
- **Global event log unifying all mutations** — over-engineered for current scale
- **CRDT / OT** — Orka is not a collaborative editor; server is authoritative

### Migration Path

Phase 1 is a backward-compatible addition:
- Add `snapshotSequence` field to list response (new clients use it, old clients ignore it)
- Client reconnect logic: fetch snapshot → subscribe → dedup
- No schema changes needed — PushHub sequence counter already exists
- No breaking changes to push protocol
