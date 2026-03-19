# Observability Audit

_Audit date: 2026-03-19_

## Coverage Table

| Module | File | Tracing | Metrics | Logging | Coverage |
|--------|------|---------|---------|---------|----------|
| **Daemon — Tracing infra** | `daemon/src/tracing.ts` | Full setup (withSpan, exporters, rotation) | 10 metrics (session/RPC/WS counters, histograms) | — | **Full** |
| **Daemon — Orchestrator** | `daemon/src/orchestrator.ts` | spawn, resume, stop, close, hibernate, sendTurn, worktree cleanup, rate-limit resume | Session started/completed/failed/cancelled, active count, duration | 3 console.error (consumer fail, resume fail, stale recovery) | **Partial** |
| **Daemon — DB** | `daemon/src/db.ts` | All CRUD ops via withSpanSync | None | 1 console.warn (invalid transition), 1 console.log (migration summary) | **Partial** |
| **Daemon — Checkpointing** | `daemon/src/checkpointing.ts` | capture, diff, revert, prune, deleteRefsAfter | None | None (errors via span.recordException) | **Partial** |
| **Daemon — Consumer** | `daemon/src/orchestration/consumer.ts` | consumeProviderEvents, captureSessionDiff, tryAutoMerge | Terminal status metrics | None | **Partial** |
| **Daemon — Engine** | `daemon/src/orchestration/engine.ts` | ingest, onEvent, getSessionEvents/Timeline/State, loadSessionEvents, lifecycle timing | None | None | **Partial** |
| **Daemon — ProviderService** | `daemon/src/orchestration/provider-service.ts` | start, sendTurn, interrupt, stop, respond, getHandle, clearHandle, listActive | None | None | **Full** |
| **Daemon — Claude adapter** | `daemon/src/adapters/claude-adapter.ts` | startSession, interruptTurn, stopSession, consumeClaudeOutput, JSON parse failures, exit events | None | None | **Partial** |
| **Daemon — Codex adapter** | `daemon/src/adapters/codex-adapter.ts` | startSession, sendTurn, interruptTurn, stopSession, respondToRequest, sendRequest, consumeCodexOutput | None | None | **Partial** |
| **Daemon — Server** | `daemon/src/server.ts` | server.start, register_relay, noise events, push.welcome | wsConnections (up/down) | 4 console.log (encryption, relay, shutdown) | **Partial** |
| **Daemon — RPC handler** | `daemon/src/rpc-handler.ts` | orka.rpc.handle (with traceparent), orka.rpc.dispatch, payload size events, slow RPC warning | rpcRequests, rpcErrors, rpcDuration | None | **Full** |
| **Daemon — LocalClient** | `daemon/src/local-client.ts` | Only pairing relay connection span | None | 1 console.warn (checkpoint prune fail) | **None** |
| **Daemon — Worktree** | `daemon/src/worktree.ts` | create, remove, list, commits_ahead, has_changes, branch, merge, delete_branch, is_git_repo | None | 1 console.warn (hook fail) | **Full** |
| **Daemon — Config** | `daemon/src/config.ts` | config.load, config.load_project | None | None | **Partial** |
| **Daemon — Supervised hook** | `daemon/src/hooks/supervised-hook.ts` | None | None | None | **None** |
| **Daemon — AggregatingClient** | `daemon/src/aggregating-client.ts` | None | None | None | **None** |
| **Relay — Tracing infra** | `relay/src/tracing.ts` | withSpan, file exporter | 11 custom metrics (bytes, connections, auth, abuse) | — | **Full** |
| **Relay — Server** | `relay/src/index.ts` | relay.start, node_register, connection.open/close, shutdown, transport.bind | connectionsOpened/Closed, activeConnections, registeredNodes, activeTransportSessions, bytesIn | 2 console.log (shutdown) | **Partial** |
| **Relay — API** | `relay/src/api.ts` | orka.relay.api.handle (single wrapper span) | None | None | **Partial** |
| **Relay — DB** | `relay/src/db.ts` | ~60% of CRUD ops via withSpanSync | None | None | **Partial** |
| **Relay — State** | `relay/src/state.ts` | None | None | None | **None** |
| **Client — OrkaClient** | `client/src/orka-client.ts` | rpc.connect, rpc.noise_handshake, rpc.request | None | None | **Partial** |
| **Client — WsTransport** | `client/src/ws-transport.ts` | Connection lifecycle, noise handshake, push events, per-RPC spans, reconnection | None | None | **Full** |
| **CLI** | `cli/src/index.ts` | Top-level orka.cli.${name} span per command | None | 14 console.error (daemon, encryption, permissions) | **Partial** |
| **Dashboard — Tracing** | `dashboard/src/lib/tracing.ts` | WebTracerProvider with OTLP exporter | None | None | **Partial** |
| **Dashboard — RPC client** | `dashboard/src/lib/rpcClient.ts` | None (delegates to WsTransport) | None | None | **None** |
| **Dashboard — RPC latency** | `dashboard/src/lib/rpcLatencyStore.ts` | None | Circular buffer: per-method avg/p95/p99/min/max | None | **Partial** |
| **Dashboard — Stores** | `dashboard/src/stores/` | None | None | None | **None** |

**Legend:** Full = all major operations instrumented. Partial = some operations traced, gaps exist. None = zero observability.

## Missing Spans

### Critical — blocks debugging production issues

1. **LocalClient methods (~50 methods)** — the daemon's OrkaService implementation has zero per-method spans. `spawn()`, `stop()`, `getResult()`, `getDiff()`, `merge()`, `pruneSessions()`, all terminal ops, all workspace ops, all checkpoint ops — none traced. This is the biggest gap: RPC handler traces dispatch, but the actual work is invisible.

2. **Supervised hook script** — the entire approval flow (permission rule evaluation, daemon HTTP request for approval, auto-approve/deny decisions) has zero instrumentation. When an approval hangs or is wrongly denied, there is no trace evidence.

3. **AggregatingClient** — multi-node routing, node selection, fallback decisions are completely opaque. Operators cannot diagnose cross-node latency or routing failures.

4. **Relay state management** — node registration, client addition/removal, transport binding creation/removal — all core relay routing operations have no spans.

5. **Daemon auto-start** (CLI) — health checks, PID validation, timeout waiting — only console.error, no spans. Startup hangs are invisible.

### High — improves observability significantly

6. **`launchProviderSession()` in orchestrator** — adapter call and its failure modes have no tracing.

7. **Idle timer management** — `startIdleTimer()`, `clearIdleTimer()` have no tracing; timeout behavior is hard to debug.

8. **Pending message queue** — no visibility into when messages are queued, delivered, or cleared.

9. **Checkpoint capture queueing** — `queueCheckpointCapture()` has no tracing; failures only console.warn.

10. **Git command execution** — `runGit()` calls in checkpointing have no tracing; individual git commands, their duration, and stderr are invisible.

11. **Consumer event subtype handling** — no tracing per provider event subtype (content.delta, request.opened, etc.).

12. **Approval auto-decision logic** — `evaluatePermission()` calls not traced; which rules matched is invisible.

13. **Relay API endpoints** — signup, key creation, key revocation, account mutations wrapped in a single span; individual operations invisible.

14. **~40% of relay DB operations** — `getAccountCount()`, `updateAccountTier()`, `listAccounts()`, `updateRateLimits()`, `getRateLimits()`, `getApiKeyByHash()`, `updateApiKeyLastUsed()` have no spans.

### Medium — nice to have

15. **Config merging and defaults resolution** — only load is traced, not parse/merge steps.

16. **Claude adapter: sendTurn()** — stdin write has no span (only startSession does).

17. **Codex adapter: thread initialization** — `initialize()` RPC not shown in full flow.

18. **Dashboard page load/render** — no initial render span.

19. **Svelte store state transitions** — no observability on propagation delays.

20. **CLI known_hosts / TOFU verification** — key verification flow has no spans.

## Missing Metrics

### Daemon

| Metric | Type | Why needed |
|--------|------|------------|
| `checkpoint.capture.duration_ms` | Histogram | Detect slow checkpoint captures |
| `checkpoint.capture.size_bytes` | Histogram | Track diff sizes, detect oversized diffs |
| `checkpoint.captures.skipped` | Counter (reason label) | Count oversized/empty skips |
| `workspace.operations` | Counter (op label: create/update/delete) | Track workspace CRUD volume |
| `db.query.duration_ms` | Histogram (query label) | Detect slow queries, lock contention |
| `worktree.create.duration_ms` | Histogram | Detect slow git operations |
| `worktree.merge.duration_ms` | Histogram | Track merge performance |
| `approval.decisions` | Counter (decision label: auto_approve/auto_deny/daemon) | Track permission decisions |
| `approval.latency_ms` | Histogram | Track time from request to decision |
| `pending_messages.queue_depth` | Gauge | Monitor message backlog per session |
| `idle_timer.fires` | Counter | Track how often sessions time out |
| `rate_limit.events` | Counter (provider label) | Track rate limit frequency by provider |
| `git.command.duration_ms` | Histogram (command label) | Track subprocess performance |

### Relay

| Metric | Type | Why needed |
|--------|------|------------|
| `api.requests` | Counter (endpoint, status_code labels) | Track API usage and error rates |
| `api.latency_ms` | Histogram (endpoint label) | Track API performance |
| `signup.attempts` | Counter (result label: success/rate_limited/duplicate) | Track signup funnel |
| `transport.message.size_bytes` | Histogram (direction label) | Track message sizes |
| `transport.messages` | Counter (direction label) | Track message throughput |
| `state.transport_bindings` | Gauge | Current binding count |
| `db.query.duration_ms` | Histogram | Detect slow relay DB queries |

### Client / Dashboard

| Metric | Type | Why needed |
|--------|------|------------|
| `rpc.timeout` | Counter (method label) | Track which RPCs timeout most |
| `noise.handshake.duration_ms` | Histogram | Track encryption overhead |
| `connection.reconnects` | Counter | Track connection stability |
| `dashboard.page_load_ms` | Histogram | Track initial render performance |

## Missing Error Tracking

1. **Error categorization is sparse** — most exceptions recorded via `span.recordException()` but not classified by cause (network, timeout, permission, resource, git, sqlite). All errors look the same in traces.

2. **Adapter stream parsing errors** — malformed JSON from claude/codex is logged as a warning event but not counted. No metrics on parse failure rate.

3. **Database schema validation failures** — Zod parsing failures in row mappers are thrown but never recorded in spans.

4. **Invalid session state transitions** — only console.warn; not recorded as span events with attributes.

5. **Config TOML parse errors** — caught, silently return defaults. No span event, no metric.

6. **Relay auth/rate-limit rejections** — metrics exist for counts, but no span events with details (which account, which limit, how close to threshold).

7. **Git command stderr** — subprocess errors from git operations are caught but stderr content is not recorded in spans.

8. **RPC timeout vs server error** — client cannot distinguish; both appear as generic promise rejection.

9. **Hook approval failures** — supervised hook errors are caught and re-thrown with no tracing context.

10. **Checkpoint file parsing** — `parseDiffFiles()` silently skips malformed lines with no error event.

## Logging Gaps

1. **Structured logging does not exist** — all logging is ad-hoc `console.log/warn/error`. No log levels, no structured fields, no correlation with trace IDs.

2. **LocalClient operations** — the service layer has 1 console.warn across 50+ methods. Session merge, prune, workspace ops, terminal ops — all silent.

3. **Relay message routing** — client-to-node and node-to-client forwarding produces zero log output on success or failure.

4. **Relay API mutations** — signup, key creation, account status changes produce no logs.

5. **State transitions** — session status changes (running -> idle -> completed) produce no console output at orchestrator level.

6. **Dashboard errors** — only Lexical editor has error logging. RPC failures, store update failures, render errors — silent.

7. **Provider event consumption** — individual event processing produces no logs; only batch-level errors logged.

8. **Adapter process lifecycle** — claude/codex process spawn success is not logged; only failures are visible through spans.

## Recommendations (prioritized)

### P0 — Critical for debugging production issues

1. **Instrument LocalClient methods** — wrap each public method with `withSpan()`. This is the single biggest gap: the daemon's service layer is the most-called code path and has zero observability. Start with: `spawn`, `stop`, `getResult`, `getDiff`, `merge`, `pruneSessions`.

2. **Instrument supervised hook** — add spans for permission rule evaluation, daemon approval request, and decision outcome. Without this, approval hangs are undiagnosable.

3. **Add error categorization** — define error categories (network, timeout, permission, resource, git, sqlite, parse) and set them as span attributes on every `span.recordException()` call.

### P1 — High-value improvements

4. **Instrument AggregatingClient** — add spans for node selection, routing decisions, and fallback logic. Multi-node debugging requires this.

5. **Add DB query duration metrics** — instrument daemon and relay DB layers with a histogram. Use `withSpanSync` return value timing or wrap the query.

6. **Add git command tracing** — wrap `runGit()` and `$()` git calls with spans recording command, duration, exit code, and stderr.

7. **Trace relay state management** — node registration, transport binding, client lifecycle in `state.ts`.

8. **Add checkpoint metrics** — capture duration, diff size, skip reason counters.

9. **Trace daemon auto-start** (CLI) — wrap health check loop and daemon spawn with spans.

### P2 — Valuable but lower urgency

10. **Fill relay DB tracing gaps** — add spans to the ~40% of operations that lack them.

11. **Trace relay API endpoints individually** — replace single wrapper span with per-endpoint spans.

12. **Add pending message queue metrics** — gauge for queue depth, counter for deliveries.

13. **Add approval latency metrics** — histogram for time from request to decision.

14. **Instrument adapter sendTurn** — add spans for stdin write (claude) and turn payload construction (codex).

### P3 — Nice to have

15. **Structured logging** — replace console.log/warn/error with a structured logger that includes trace ID correlation.

16. **Dashboard page load span** — measure time to interactive.

17. **Noise handshake duration metric** — track encryption overhead.

18. **Message throughput metrics** — counters for relay messages forwarded per second.

19. **Svelte store transition events** — emit span events on critical state changes.

## Can we debug a production issue using only traces?

**Partially.** Here's what works and what doesn't:

| Scenario | Debuggable? | Why / Why not |
|----------|-------------|---------------|
| Session spawn fails | Yes | Orchestrator span + adapter start span capture exceptions |
| Session hangs mid-execution | Partially | Provider events are traced, but idle timer and pending message state are invisible |
| Worktree merge fails | Partially | `worktree.merge` span exists, but LocalClient.merge() is not traced — gap in call chain |
| Approval takes too long | No | Supervised hook has zero instrumentation |
| Rate limit cascading | Yes | Rate limit auto-resume has dedicated span with lifecycle events |
| Relay routing failure | No | State management and message forwarding have no traces |
| Slow RPC | Yes | rpc-handler has duration metrics, slow-RPC warning events |
| Checkpoint corruption | Partially | Capture/revert spans exist, but git command internals are invisible |
| Dashboard not updating | No | Stores, push handlers, and RPC client have no observability |
| Multi-node session routing | No | AggregatingClient has zero traces |
| Database lock contention | No | No DB query duration metrics, no lock monitoring |
| Daemon won't start | No | CLI auto-start logic has no spans, only console.error |

**Bottom line:** Top-level session lifecycle (spawn/stop/complete) and RPC handling are well-traced. The service layer (LocalClient), approval system, relay routing, and multi-node aggregation are blind spots. Adding spans to LocalClient and the supervised hook would cover the two most impactful gaps.
