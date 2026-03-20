# Agent Session Supervision & Stall Detection Research

## Incident Context

Session `sess-ef13a1c7` completed all work (wrote a 402-line research doc) but hung for 1+ hour without committing or exiting. The orchestrator had no way to detect this. The user had to manually notice and investigate.

This document researches detection mechanisms, analyzes what signals we already have, compares industry approaches, and proposes a design.

---

## 1. Current Signal Inventory

### What We Track

| Signal | Location | Description |
|--------|----------|-------------|
| **Orchestration events** | `orchestration_events` table | Every provider event persisted with `timestamp`, `seq`, `type`, `provider` |
| **Session status** | `sessions` table | `status` field: queued → preparing → running → idle → completed/failed/cancelled/hibernated |
| **Timestamps** | `sessions` table | `created_at`, `started_at`, `finished_at` |
| **In-memory idle timers** | `sessionRuntime.idleTimers` | `setTimeout` handles, keyed by session ID |
| **Rate limit state** | `sessionRuntime.pendingRateLimits` | Pending rejections with `resetsAt` timestamp |
| **Turn counts** | `sessionRuntime.turnCounts` | Checkpoint turn sequence counter per session |
| **Process handle** | Provider adapter | Bun subprocess reference with `process.exited` promise |

### What We Don't Track

| Missing Signal | Impact |
|----------------|--------|
| **Last event timestamp per session** | Cannot query "sessions with no events in N minutes" |
| **Per-status transition timestamps** | Cannot determine "how long has this session been running without output?" |
| **Process-level health (CPU, memory)** | Cannot distinguish "thinking hard" from "stuck" |
| **Heartbeat / keepalive** | No periodic signal that process is alive |
| **Active turn duration** | No timer on how long a single turn has been executing |

### Existing Timeout Mechanisms

| Mechanism | Scope | Default | Status |
|-----------|-------|---------|--------|
| **Idle timeout** | Between turns (session in "idle" state) | 10 min | **Implemented** — `startIdleTimer()` in orchestrator.ts |
| **Approval timeout** | Per pending approval request | 5 min | **Implemented** — `ApprovalManager` auto-denies |
| **Session timeout** | Total session lifetime | 60 min | **Defined in config schema, NOT implemented** |
| **Turn/stall timeout** | During active turn | None | **Not implemented** |

### The Gap

The idle timer only fires when a session is in "idle" state (between turns). During an active turn — when the provider is running — there is **no watchdog**. A provider process that hangs mid-turn (no events, no exit) keeps the session in "running" state indefinitely.

---

## 2. Event Signals During Normal vs. Stalled Sessions

### Normal Session: Event Cadence

A healthy Claude Code session emits events at high frequency during active work:

```
[T+0s]    session.started
[T+0s]    turn.started
[T+1s]    content.delta (reasoning_text)     # thinking
[T+3s]    content.delta (assistant_text)     # response text
[T+4s]    item.started (file_read)           # tool use begins
[T+4s]    content.delta (command_output)     # tool output
[T+5s]    item.completed                     # tool done
[T+6s]    item.started (file_edit)           # next tool
[T+7s]    content.delta (file_change_output)
[T+8s]    item.completed
...       (repeating pattern every 1-10s)
[T+120s]  turn.completed                     # turn ends
[T+120s]  → idle state, idle timer starts
```

**Typical gap between events**: 1-10 seconds during active tool use, up to 30-60s during extended thinking.

### Stalled Session: What It Looks Like

The incident session had a pattern like:
```
[T+0]     ... normal event flow ...
[T+N]     last event (content.delta or item.completed)
[T+N+1h]  ... silence, no events, process still alive ...
```

Key observation: **the process didn't exit and didn't emit events.** The orchestrator's `for await (const event of handle.events)` loop was blocked waiting for the next event that never came.

### Legitimate Long Silences

Not all gaps are stalls. These are valid reasons for extended silence:

| Scenario | Expected Gap | How to Distinguish |
|----------|-------------|-------------------|
| **Extended thinking** (complex reasoning) | 30s-3min | Claude Code emits `content.delta` with `reasoning_text` periodically |
| **Long tool execution** (test suite, build) | 1-15min | `item.started` was emitted, `item.completed` hasn't arrived yet |
| **Context compaction** | 10-30s | `session.compacted` event follows |
| **API retry** | 5-60s | `api.retry` event emitted with attempt count |
| **Rate limit pause** | 1-60min | `rate.limit` event with `resetsAt` |
| **Approval wait** | 0-5min | `request.opened` event pending |
| **Actual stall** | 15min+ | No events of any kind, no pending approval, no rate limit |

### Distinguishing Signals

The strongest stall signal: **no events of any type for an extended period while no approval is pending and no rate limit is active.**

Even during long tool executions, Claude Code emits `tool.progress` events with elapsed time. Complete silence is abnormal.

---

## 3. How Others Handle This

### T3Code (Codex Wrapper)

- **Per-RPC timeout**: Every JSON-RPC request has a 20-second timeout. If the Codex process doesn't respond, the request rejects.
- **Startup health probe**: 4-second timeout on `codex --version` and `codex login status`.
- **Process exit listeners**: Detects unexpected process termination immediately.
- **No session-level stall detection**: T3Code is request-reply, so individual RPC timeouts cover the gap.

**Applicable insight**: Per-request timeouts are effective for RPC-style protocols but don't map directly to streaming event protocols.

### CI Systems (GitHub Actions, CircleCI)

- **Job timeout**: GitHub Actions defaults to 360 minutes (6 hours). Configurable per workflow.
- **Step timeout**: `timeout-minutes` per step, no default limit per step.
- **No heartbeat**: CI systems don't check if the job is *doing useful work* — they only enforce wall-clock time.
- **Log flushing**: Jobs that produce no output for extended periods get warnings but don't auto-cancel (GitHub Actions).

**Applicable insight**: Wall-clock timeouts are the simplest approach and catch all stalls. The `sessionTimeoutMinutes` config we already define (but don't implement) is exactly this pattern.

### Kubernetes Liveness/Readiness Probes

- **Liveness probe**: Periodic check (HTTP GET, TCP socket, or exec command). Default: 10s period, 3 failure threshold → restart container.
- **Readiness probe**: Same mechanism, controls traffic routing rather than restart.
- **Startup probe**: Extended grace period during initialization.
- **Key design**: Probes are **pull-based** (orchestrator checks the process) not push-based (process reports health).

**Applicable insight**: The probe pattern maps well to our architecture. The daemon (orchestrator) could periodically check each running session for recent event activity — a "liveness check" on the event stream.

### Systemd Watchdog

- **WatchdogSec**: Service must call `sd_notify(WATCHDOG=1)` within a configured interval or systemd restarts it.
- **Push-based**: The service is responsible for signaling health.
- **Simple**: Binary alive/dead signal, no application-level semantics.

**Applicable insight**: Push-based watchdogs require modifying the provider (Claude Code, Codex) to emit heartbeats. We don't control these providers, so pull-based is more practical.

### Process Supervisors (supervisord)

- **startsecs**: Minimum time process must stay alive to be considered "started".
- **autorestart**: Restart on unexpected exit.
- **No application-level health**: Pure process monitoring; doesn't detect hangs.

**Applicable insight**: Process-level monitoring (is the PID alive?) is necessary but insufficient. Our stalled session had a live process — it just wasn't doing anything.

---

## 4. Stall Detection Heuristics

### Heuristic 1: Event Gap Timeout (Recommended)

**Rule**: If a session in "running" state has not emitted any event for `stallTimeoutMinutes` (configurable, default 15 min), it is considered stalled.

**Implementation**:
- Track `lastEventAt` per session (in-memory, updated on every event).
- A periodic watchdog (e.g., every 60s) scans running sessions and checks `now - lastEventAt > threshold`.
- Before declaring stall, check for mitigating conditions:
  - Is an approval request pending? → Not stalled (waiting for user).
  - Is the session rate-limited? → Not stalled (known pause).

**False positive analysis**:
| Scenario | 15min gap possible? | Mitigation |
|----------|---------------------|------------|
| Long test suite | Unlikely — `tool.progress` events emit | Claude Code emits progress |
| Extended thinking | Very unlikely >15min | Even 5min thinking emits reasoning deltas |
| Large file read | No — tool completes in seconds | N/A |
| Network issue (API) | Possible — retries take time | `api.retry` events would still emit |
| Rate limit | Yes | Check `pendingRateLimits` map |
| Approval wait | Yes | Check `ApprovalManager.pending` |
| Context compaction | No — takes <30s | `session.compacted` event |
| **Actual hang** | Yes | **This is what we're catching** |

**Risk**: 15 minutes is conservative. Even a 10-minute threshold would have very few false positives given that Claude Code emits `tool.progress` during long operations.

### Heuristic 2: Turn Duration Timeout

**Rule**: If a single turn has been executing for longer than `maxTurnDurationMinutes` (e.g., 30 min), flag it.

**Rationale**: Most turns complete in 1-5 minutes. A 30-minute turn is unusual and worth investigating.

**Advantage over Heuristic 1**: Catches cases where events trickle in but the agent is going in circles (not technically stalled, but not making progress).

**Disadvantage**: Harder to set a universal threshold. Some tasks legitimately take 30+ minutes per turn (large refactors, test suite runs).

### Heuristic 3: Wall-Clock Session Timeout

**Rule**: Total session duration exceeds `sessionTimeoutMinutes` (already in config, default 60 min).

**Implementation**: Simple — already have `started_at` in DB. Check `now - started_at > sessionTimeoutMinutes`.

**Advantage**: Catches all runaway sessions regardless of event cadence.

**Disadvantage**: Kills legitimately long-running sessions. Needs per-session override ability.

### Heuristic 4: Process Resource Monitoring

**Rule**: Check if the provider process is consuming CPU/memory. A hung process often shows 0% CPU.

**Implementation**: `ps -o %cpu -p <pid>` periodically.

**Advantage**: Strong signal — 0% CPU for extended period + no events = definitely stalled.

**Disadvantage**: Adds OS-level monitoring complexity. CPU could be low during legitimate network waits (API calls). Not portable across all environments.

**Verdict**: Good supplementary signal, not sufficient alone.

### Recommended Combination

For the minimal useful version, combine **Heuristic 1 (event gap)** + **Heuristic 3 (wall-clock timeout)**:

- Event gap catches mid-turn hangs (the incident scenario).
- Wall-clock timeout catches runaway sessions that technically stay "active" but never finish.
- Both are simple to implement and have low false-positive rates.

---

## 5. Recommended Design

### Architecture: Watchdog Timer in Orchestrator

The stall detection lives in the orchestrator as a periodic scan, not as a separate process. This follows the existing pattern (idle timers, rate limit timers are already in the orchestrator).

```
┌──────────────────────────────────────┐
│            Orchestrator              │
│                                      │
│  ┌──────────┐  ┌──────────────────┐  │
│  │ Idle     │  │ Stall Watchdog   │  │
│  │ Timers   │  │ (setInterval)    │  │
│  │ (per     │  │                  │  │
│  │ session) │  │ Every 60s:       │  │
│  │          │  │  - scan running  │  │
│  │          │  │    sessions      │  │
│  │          │  │  - check lastEvt │  │
│  │          │  │  - check wallclk │  │
│  └──────────┘  └──────────────────┘  │
│                                      │
│  SessionRuntime:                     │
│   + lastEventAt: Map<id, number>     │
│   + stallWarned: Set<id>             │
└──────────────────────────────────────┘
```

### Minimal Version (v1)

**New config fields** (in `LimitsSchema`):
```typescript
stallTimeoutMinutes: z.number().default(15),    // 0 = disabled
```

**New runtime state** (in `SessionRuntimeState`):
```typescript
lastEventAt: Map<string, number>    // sessionId → Date.now() of last event
stallWarned: Set<string>            // sessions already warned (avoid spam)
```

**Event tracking** — in the event consumer (`consumeProviderEvents`):
```typescript
// On every event received:
ctx.sessionRuntime.lastEventAt.set(sessionId, Date.now());
```

**Watchdog interval** — started in daemon boot:
```typescript
const watchdog = setInterval(() => {
  scanForStalledSessions(ctx);
}, 60_000); // check every 60s
watchdog.unref();
```

**Scan logic**:
```typescript
function scanForStalledSessions(ctx: DaemonContext): void {
  const stallTimeout = ctx.config.limits.stallTimeoutMinutes;
  if (stallTimeout <= 0) return; // disabled

  const thresholdMs = stallTimeout * 60_000;
  const now = Date.now();

  for (const [sessionId, lastEvent] of ctx.sessionRuntime.lastEventAt) {
    const session = ctx.db.getSession(sessionId);
    if (!session || session.status !== "running") continue;
    if (now - lastEvent < thresholdMs) continue;

    // Check mitigating conditions
    if (ctx.approvalManager.hasPendingFor(sessionId)) continue;
    if (ctx.sessionRuntime.pendingRateLimits.has(sessionId)) continue;

    // Stall detected
    handleStalledSession(ctx, sessionId, now - lastEvent);
  }
}
```

**Stall action** — preserve work, then stop:
```typescript
async function handleStalledSession(
  ctx: DaemonContext, sessionId: string, silenceDurationMs: number
): Promise<void> {
  const minutes = Math.round(silenceDurationMs / 60_000);

  // 1. Capture checkpoint (preserve any uncommitted work)
  await captureCheckpoint(ctx, sessionId, "stall-detected");

  // 2. Emit stall event for logging/dashboard
  ctx.orchestrationEngine.ingest(sessionId, {
    type: "session.stall_detected",
    provider: "orka",
    timestamp: new Date().toISOString(),
    silenceMinutes: minutes,
  });

  // 3. Stop the session
  await stopSession(ctx, sessionId);

  // 4. Set status to indicate stall (not just "cancelled")
  ctx.db.updateSessionStatus(sessionId, "failed");
}
```

### Full Version (v2)

Building on v1, add:

1. **Wall-clock timeout**: Enforce `sessionTimeoutMinutes` (already in config):
   ```typescript
   // In the same watchdog scan:
   const sessionTimeout = ctx.config.limits.sessionTimeoutMinutes;
   if (sessionTimeout > 0 && session.started_at) {
     const elapsed = now - new Date(session.started_at).getTime();
     if (elapsed > sessionTimeout * 60_000) {
       handleSessionTimeout(ctx, sessionId, elapsed);
     }
   }
   ```

2. **Graduated response** (warn → nudge → stop):
   - **At 50% of stall threshold** (e.g., 7.5 min): Log warning, broadcast to dashboard.
   - **At 75% of threshold** (e.g., 11 min): Attempt to nudge the provider (send a newline or ping via stdin). Some stalled processes recover from a nudge.
   - **At 100% of threshold** (15 min): Checkpoint + stop.

3. **Per-session override**: Allow spawn-time configuration:
   ```
   orka spawn --stall-timeout 30 "run the full test suite"
   ```

4. **Stall recovery**: Instead of stopping, attempt to resume:
   - Capture checkpoint.
   - Kill process.
   - Mark as "hibernated" (not "failed").
   - User can `orka retry` to resume with preserved context.

5. **Dashboard integration**:
   - Show stall warnings in real-time.
   - Show "last activity" timestamp in session detail view.
   - Color sessions yellow when approaching stall threshold.

---

## 6. Interaction with Existing Features

### Idle Timer

| Aspect | Idle Timer | Stall Watchdog |
|--------|-----------|----------------|
| **When** | Session is "idle" (between turns) | Session is "running" (during turn) |
| **Trigger** | `turn.completed` event | Periodic scan (every 60s) |
| **Action** | Hibernate | Checkpoint + stop (or warn + nudge + stop) |
| **Default** | 10 minutes | 15 minutes |
| **Overlap** | None — mutually exclusive states | None |

The two mechanisms are complementary. Idle timer handles inactive sessions between turns. Stall watchdog handles stuck sessions during turns.

### Rate Limiting

Rate-limited sessions are in `"rate_limited"` status (not `"running"`), so the stall watchdog naturally skips them. Additionally, the scan explicitly checks `pendingRateLimits` as a safety measure.

When a rate limit auto-resume fires, the session transitions back to "running" and `lastEventAt` is updated, so the stall timer resets.

### Approval Manager

Sessions waiting for user approval are in "running" status but have a pending request in `ApprovalManager`. The stall scan checks for this and skips those sessions.

If the approval itself times out (5 min default), the approval is auto-denied, which generates an event and resets the stall timer.

### Daemon Recovery

On daemon restart, `recoverStaleSessions()` already marks orphaned "running" sessions as "hibernated". The stall watchdog enhances this by catching sessions that are still running (process alive) but not making progress.

### Checkpoints

The stall handler captures a checkpoint before stopping, which preserves the git state at the moment of stall detection. This integrates with the existing `captureCheckpoint()` infrastructure used for per-turn snapshots.

### Graceful Shutdown

During daemon shutdown, the watchdog interval is cleared. Sessions are handled by the existing graceful shutdown logic (drain + timeout).

---

## 7. Implementation Plan

### Phase 1: Minimal Stall Detection (v1)

1. **Add `lastEventAt` tracking** to `SessionRuntimeState` in `daemon-context.ts`.
2. **Update event consumer** in `consumer.ts` to set `lastEventAt` on every event.
3. **Add `stallTimeoutMinutes`** to `LimitsSchema` in `config.ts` (default 15).
4. **Implement `scanForStalledSessions()`** in `orchestrator.ts`.
5. **Start watchdog interval** in daemon boot (`startServer()` or `createDaemonContext()`).
6. **Add `session.stall_detected` event type** to `provider-events.ts`.
7. **Handle stall**: checkpoint → emit event → stop session.
8. **Test**: Unit test for scan logic. E2E test with mock provider that stops emitting events.

**Estimated scope**: ~150-200 lines of code across 4-5 files.

### Phase 2: Wall-Clock Timeout

1. **Implement `sessionTimeoutMinutes` enforcement** in the same watchdog scan.
2. **Add `session.timeout` event type**.
3. **Test**: Session that runs past the configured timeout gets stopped.

**Estimated scope**: ~30-50 lines (mostly in the existing scan function).

### Phase 3: Graduated Response & Dashboard

1. **Warning threshold** at 50% of stall timeout.
2. **Nudge mechanism** at 75% — send stdin newline to provider.
3. **Dashboard** — show last-activity timestamp, stall warnings.
4. **Per-session timeout override** via spawn options.

### Phase 4: Smart Recovery

1. **Hibernate instead of fail** on stall detection.
2. **Auto-retry** with context from checkpoint.
3. **Configurable stall action**: `warn`, `nudge`, `stop`, `hibernate`.

---

## 8. Open Questions

1. **Should `sessionTimeoutMinutes` apply to wall-clock time or active (non-idle, non-rate-limited) time?** Wall-clock is simpler but penalizes sessions that spend time rate-limited. Active time is fairer but harder to track.

2. **Should stall detection be opt-out or opt-in?** Recommendation: opt-out (enabled by default with `stallTimeoutMinutes: 15`, set to 0 to disable).

3. **What's the right default threshold?** 15 minutes is conservative. Analysis of the incident shows the session was silent for 60+ minutes. Even a 10-minute threshold would catch this with no false positives. But legitimate long tool executions (e.g., `bun test` on a large suite) could approach 10 minutes. 15 minutes provides margin.

4. **Should we try to nudge before killing?** Sending a stdin newline to Claude Code is low-risk and might recover a process stuck on input. Worth trying as a graduated step. Codex's JSON-RPC protocol makes this harder (can't just send arbitrary input).

5. **Should we distinguish stall reasons in the session status?** Currently the plan uses "failed" status. A dedicated "stalled" status would make reporting cleaner but adds another state to the state machine.
