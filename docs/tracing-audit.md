# Tracing Audit: Dashboard ↔ Daemon

_Audit date: 2026-03-21_

## Trace Data Analysis

Source: `~/.orka/traces.jsonl` (37,497 spans total, last 10,000 analyzed)

### Span Frequency (top 15)

| Span | Count (of 10k) | Notes |
|------|------:|-------|
| `orka.provider.get_handle` | 8,489 | **Span storm** — 85% of all spans |
| `orka.push.broadcast` | 218 | Normal — one per event ingested |
| `orka.db.insertOrchestrationEvent` | 201 | Normal — DB insert per event |
| `orka.orchestration.get_session_events` | 198 | Normal — read events for ingest |
| `orka.orchestration.ingest` | 198 | Normal — provider event ingestion |
| `orka.client.rpc` | 123 | Client-side RPC calls |
| `orka.rpc.handle` / `orka.rpc.dispatch` | 90 each | Server-side RPC handling |
| `orka.push.send` | 81 | Push delivery to subscribers |
| `orka.db.listSessionItems` | 30 | Session list queries |
| `orka.db.getSessionTagsBatch` | 30 | Tag batch queries |
| `orka.db.getSession` | 27 | Session detail lookups |
| `orka.client.ws` | 23 | WebSocket connection lifecycle |
| `orka.push.welcome` | 22 | Welcome message on WS connect |
| `orka.dashboard.session.select` | 6 | **Only dashboard span in data** |
| `orka.checkpoint.capture` | 3 | Checkpoint operations |

### Performance

- **No slow spans** (>200ms) in the last 10,000 entries
- All DB operations complete in <25ms
- Push broadcasts complete in <0.1ms
- Orchestration ingest averages ~10ms

### Errors (47 total in last 10k spans)

| Error | Count | Impact |
|-------|------:|--------|
| `orka.client.ws`: WebSocket closed abnormally (code=1006) | ~6 | Transient WS disconnects |
| `orka.client.rpc`: Request timeout: `listNodes` | ~6 | `listNodes` RPC consistently timing out |
| `orka.client.rpc`: Connection closed | ~3 | Mid-flight RPC failures |

**Finding**: `listNodes` timeouts suggest either the relay is slow to respond or the method is expensive. Worth investigating.

### Parent-Child Relationships

- **9,818 of 10,000 spans are root spans** (no `parentSpanId`)
- Only 182 spans (1.8%) have parent relationships
- This means **trace chains are almost entirely flat** — individual operations are traced but not linked into request-scoped traces

**Impact**: Cannot follow a single user action (e.g., "spawn session") through the full call chain from CLI → RPC → LocalClient → Orchestrator → Provider. Each layer creates independent root spans.

## Current Coverage Summary

### Well-Traced (Full)

| Component | Spans | Assessment |
|-----------|-------|------------|
| RPC handler | `orka.rpc.handle`, `orka.rpc.dispatch` with method, duration, payload size, slow flag | Excellent — includes `traceparent` propagation |
| DB operations | All CRUD via `withSpanSync` | Excellent — every query traced |
| Checkpointing | capture, diff, revert, prune, deleteRefsAfter | Excellent — with attributes for ref, size, turn |
| Worktree ops | create, remove, list, commits_ahead, merge, branch | Excellent |
| Orchestrator lifecycle | spawn, resume, stop, close, hibernate, sendTurn, cancelTurn, reap | Good |
| Provider service | start, sendTurn, interrupt, stop, respond | Good |

### Partially Traced

| Component | What's Traced | What's Missing |
|-----------|--------------|----------------|
| Consumer | `consumeProviderEvents`, `captureSessionDiff`, `tryAutoMerge` | `finalizeSession()`, `handleRequestOpened()`, `handleTurnCompleted()`, per-event-type routing |
| Server | startup, Noise handshake, push welcome/errors | WS connect/disconnect lifecycle, tool approval endpoint |
| Dashboard | `session.select` (ChatView), `session.stop`, `draft.spawn` | Store transitions, page load, RPC latency per-method, error boundaries |
| CLI | Top-level `orka.cli.${command}` spans | Daemon auto-start, key verification |
| Adapters | startSession, interruptTurn, stopSession | sendTurn (claude), stream parsing errors |

### Not Traced (None)

| Component | Impact |
|-----------|--------|
| **LocalClient** (50+ methods) | Service layer is invisible — RPC handler traces dispatch but actual work (spawn, stop, getDiff, merge, getResult, terminal ops) has zero spans |
| **Supervised hook** | Approval flow (permission evaluation, decision, latency) completely dark |
| **AggregatingClient** | Multi-node routing, node selection, fallback — opaque |
| **Relay state** | Node registration, transport binding, client lifecycle — no spans |
| **Dashboard stores** | State propagation, WebSocket reconnects, error handling — silent |

## Performance Issues

### P1: Span Storm — `orka.provider.get_handle` (85% of all spans)

`orka.provider.get_handle` accounts for **8,489 of 10,000 spans** (85%). This is a simple map lookup in `ProviderService.getHandle()` that returns a session handle or null.

**Problem**: This function is called on every provider event, every status check, and every RPC that touches a session. Tracing a synchronous map lookup generates massive span volume with zero diagnostic value.

**Recommendation**: Remove the `withSpanSync` wrapper from `getHandle()`. It's a pure data lookup — trace the callers instead.

**Estimated impact**: Reduces trace file growth by ~85%, reduces file exporter I/O, makes traces.jsonl actually useful for finding real operations.

### P2: Flat Trace Chains (98% root spans)

Almost all spans are independent roots. The `traceparent` propagation exists in `rpc-handler.ts` (line 47-50), but:
- CLI commands create their own root spans (`orka.cli.${name}`)
- RPC handler creates root spans when no `traceparent` header is present
- Dashboard operations create independent root spans
- Orchestrator operations create independent root spans inside LocalClient calls

**Result**: A single "spawn session" request produces ~5-10 disconnected root spans instead of one trace tree.

**Recommendation**: Thread `traceparent` from:
1. CLI → RPC client (already partially done in WsTransport)
2. RPC handler → LocalClient method calls (missing — LocalClient doesn't accept span context)
3. LocalClient → Orchestrator calls (missing — orchestrator creates new root spans)
4. Dashboard → RPC client (partially done via `injectSpanContext`)

### P3: `listNodes` RPC Timeouts

6 timeout errors for `listNodes` in the trace data. Either:
- The relay is slow to respond to node listing
- The RPC timeout is too aggressive for this endpoint
- Network issues between client and relay

**Recommendation**: Add response time attributes to `listNodes` handler, check if the relay's node list query is expensive.

## Tracing Gaps: Specific Recommendations

### P1 — Critical for debugging

| # | Gap | File | Function(s) | Why |
|---|-----|------|-------------|-----|
| 1 | **Remove `getHandle` span** | `orchestration/provider-service.ts` | `getHandle()` | 85% of all spans are this no-op lookup. Removing it fixes the span storm. |
| 2 | **Instrument LocalClient** | `local-client.ts` | `spawn`, `stop`, `getResult`, `getDiff`, `merge`, `getSessionTimeline`, `getChatMessages`, `pruneSessions` | Service layer is the biggest blind spot. These are the most-called methods. |
| 3 | **Instrument `finalizeSession`** | `orchestration/consumer.ts` | `finalizeSession()` | Session completion/failure is a critical state transition with no span. |
| 4 | **Instrument supervised hook** | `hooks/supervised-hook.ts` | permission evaluation, approval request, decision | Approval hangs are undiagnosable without tracing. |

### P2 — High value

| # | Gap | File | Function(s) | Why |
|---|-----|------|-------------|-----|
| 5 | **Link trace chains** | `local-client.ts`, `orchestrator.ts` | Accept and propagate `SpanContext` from RPC handler | 98% root spans means you can't follow a request through the system. |
| 6 | **Instrument `launchProviderSession`** | `orchestrator.ts` | `launchProviderSession()` | Provider process startup is critical and untraced. |
| 7 | **Instrument AggregatingClient** | `aggregating-client.ts` | All methods | Multi-node routing is completely opaque. |
| 8 | **Dashboard store transitions** | `dashboard/src/stores/` | Session selection, WS reconnect, error states | Dashboard has 6 spans in 37k total traces — effectively untraced. |
| 9 | **Instrument `handleRequestOpened`** | `orchestration/consumer.ts` | `handleRequestOpened()` | Tool approval flow has no visibility. |
| 10 | **Instrument `handleTurnCompleted`** | `orchestration/consumer.ts` | `handleTurnCompleted()` | Turn completion triggers idle timer, auto-merge — untraced. |

### P3 — Nice to have

| # | Gap | File | Function(s) | Why |
|---|-----|------|-------------|-----|
| 11 | **Relay state management** | `relay/src/state.ts` | Node/client/transport ops | Relay routing failures invisible. |
| 12 | **Relay API per-endpoint** | `relay/src/api.ts` | Individual API handlers | Single wrapper span hides per-endpoint performance. |
| 13 | **Git command tracing** | `checkpointing.ts` | `runGit()` | Git subprocess duration and stderr invisible. |
| 14 | **WS connect/disconnect** | `server.ts` | `open()`, `close()` handlers | Connection lifecycle not tracked. |
| 15 | **Dashboard page load** | `dashboard/src/` | App initialization | No initial render span. |
| 16 | **Config parse/merge** | `config.ts` | Config loading internals | Only top-level load traced. |

## Trace Coverage Test Allowlist Review

`packages/daemon/src/trace-coverage.test.ts` enforces `withSpan` on all exported async functions. The allowlist contains 16 entries:

| Allowlisted Function | Should Stay? | Reason |
|---------------------|:---:|--------|
| `ClaudeCodeAdapter.replayRawLog` | Yes | Legacy log replay, internals traced |
| `ClaudeCodeAdapter.respondToRequest` | Yes | Lightweight state query |
| `ClaudeCodeAdapter.sendTurn` | **No** | Should be traced — stdin write to provider process |
| `CodexAdapter.replayRawLog` | Yes | Legacy log replay |
| `evaluateDynamicEnv` | Yes | Internal config helper |
| `resolveProjectEnv` | Yes | Internal config helper |
| `createDaemonContext` | Yes | Composition root |
| `migrateDb` | Yes | Schema migration |
| `openTestDb` | Yes | Test helper |
| `001_initial.up` | Yes | Migration |
| `002_backfill.up` | Yes | Migration |
| `003_checkpoints.up` | Yes | Migration |
| `handleRpcRequest` | **Review** | Already traced internally — allowlist may be correct (wraps itself with `withSpan` inside the function body rather than at the export level) |
| `withTestTracing` | Yes | Test helper |
| `shutdownTracing` | Yes | Infrastructure |
| `withSpan` | Yes | Tracing utility itself |

**Action items**:
- Remove `ClaudeCodeAdapter.sendTurn` from allowlist and add tracing
- Verify `handleRpcRequest` — if it calls `withSpan` internally, the allowlist entry is correct but should have a comment explaining why

## Summary

| Category | Finding |
|----------|---------|
| **Biggest problem** | `orka.provider.get_handle` span storm — 85% of all trace data is a no-op map lookup |
| **Biggest gap** | LocalClient (50+ methods, zero spans) — the entire service layer is invisible |
| **Trace linkage** | 98% root spans — cannot follow requests through the system |
| **Dashboard** | 6 spans in 37k total — effectively no dashboard tracing in practice |
| **Performance** | No slow spans (>200ms), DB ops healthy (<25ms), push near-instant |
| **Errors** | `listNodes` RPC timeouts worth investigating; WS disconnects are transient |
| **Test coverage** | `trace-coverage.test.ts` is solid; 1 allowlist entry should be removed (`sendTurn`) |
