# API Error Handling & Retry Design

## Problem

When upstream provider APIs return transient errors (529 overloaded, 500 internal, 503 unavailable, rate limits), sessions immediately transition to `failed` with a cryptic error like "Claude Code exited with code 1" or "Codex app-server exited with code 1". There is zero retry logic — every transient failure is treated as permanent.

## Current Error Flow

```
Provider process exits (non-zero)
  → Adapter emits session.exited { exitKind: "error", reason: "...exited with code N" }
    → consumer.finalizeSession() sets status = "failed"
      → Dashboard shows red "Failed" pill, CLI shows red status
```

### Per-Backend Error Surfaces

**Claude Code** (`claude-adapter.ts`):
- Process exits with non-zero code. Stderr is drained but **not captured** — the error reason is only `"Claude Code exited with code {N}"`.
- If a `result` event was emitted before exit, `is_error: true` in the result maps to `turn.completed { state: "failed" }`, but the `session.exited` event is the terminal signal.
- API errors (529, 500, etc.) surface as Claude Code's own exit code 1 — we don't get the HTTP status code directly.
- Claude Code's `--resume` flag can resume the conversation context on re-spawn if we have `providerSessionId`.

**Codex** (`codex-adapter.ts`):
- Structured error notifications via JSON-RPC `error` method with `{ error: { message } }` — these arrive as `runtime.error` events with class `provider_error`.
- `thread/status/changed` to `systemError` state → `session.state.changed { state: "error" }`.
- Process exit with non-zero code as fallback.
- `CodexSessionProjection.shouldUnsubscribe()` detects terminal errors and initiates cleanup.
- No `--resume` equivalent — Codex threads are ephemeral. Retry means a fresh thread.

### What Consumers See Today

| Layer | Failed Session Display |
|-------|----------------------|
| Dashboard sidebar | Red dot + "Failed" label |
| Dashboard chat | Red alert box: "Session failed — Claude Code exited with code 1" |
| Dashboard input | Disabled (terminal status) |
| CLI `orka ps` | Red text status |
| CLI `orka result` | Red "STATUS: ERROR" |
| CLI `orka attach` | Stream ends, shows raw error if any |

---

## A. Error Classification

### Transient (retryable)

| Signal | Source | Detection |
|--------|--------|-----------|
| HTTP 529 (overloaded) | Claude API | Exit code 1 + stderr contains "overloaded" or "529" |
| HTTP 500 (internal) | Claude API, OpenAI API | Exit code 1 + stderr contains "500" or "internal server error" |
| HTTP 503 (unavailable) | Claude API, OpenAI API | Exit code 1 + stderr contains "503" or "service unavailable" |
| HTTP 429 (rate limit) | Claude API, OpenAI API | Exit code 1 + stderr contains "429" or "rate limit" |
| Network timeout | Any | Exit code 1 + stderr contains "timeout", "ETIMEDOUT", "ECONNRESET" |
| Codex `systemError` | Codex app-server | `session.state.changed { state: "error" }` + error message pattern |
| Codex JSON-RPC error | Codex app-server | `runtime.error { class: "provider_error" }` + message pattern |

### Fatal (not retryable)

| Signal | Source | Detection |
|--------|--------|-----------|
| HTTP 401/403 (auth) | Any API | stderr contains "401", "403", "unauthorized", "forbidden", "invalid api key" |
| HTTP 400 (bad request) | Any API | stderr contains "400", "bad request", "invalid" |
| Process crash (SIGSEGV, etc.) | CLI binary | Exit code > 128 (signal death) |
| Permission denied | OS | stderr contains "EACCES", "permission denied" |
| Binary not found | OS | Exit code 127 |
| Explicit user stop | Orka | `reason ∈ {"stopped", "cancelled", "canceled"}` |
| Config/validation error | Adapter | stdio not available, thread init failure |

### Classification Strategy

**Phase 1 — stderr heuristics**: Capture stderr from spawned processes (currently drained and discarded) and pattern-match against known error strings. This is imprecise but covers 90% of cases.

**Phase 2 — structured error parsing**: If Claude Code or Codex add structured error codes to their output (exit events, JSON error payloads), parse those directly.

**Implementation**: A `classifyExitError(exitCode: number, stderr: string, provider: BackendKind)` function returns:

```typescript
interface ErrorClassification {
  retryable: boolean;
  category: "overloaded" | "rate_limit" | "server_error" | "network" | "auth" | "config" | "crash" | "unknown";
  message: string;        // Human-readable error description
  rawStderr?: string;     // First 2000 chars of stderr for debugging
  suggestedDelay?: number; // ms, from Retry-After header if available
}
```

---

## B. Retry Strategy

### Where Retries Happen

Retries belong in the **orchestrator** (`orchestrator.ts`), not in adapters or the consumer. The adapter's job is to faithfully report what the process did. The consumer's job is to map events. The orchestrator owns session lifecycle and is the right place to decide "this session should be retried."

```
Adapter (reports facts)
  → Consumer (maps events, calls finalizeSession)
    → Orchestrator retry hook (intercepts failure, decides retry)
      → Re-launches adapter (new process)
```

### Retry Mechanism

Instead of adding retry logic inside `consumeProviderEvents`, we wrap the provider launch + consume lifecycle in the orchestrator. The key insight: **we already have `resumeSession()` which spawns a new process for a hibernated session**. Retry is semantically identical — re-spawn the process for a session that died transiently.

**New function: `retrySession(ctx, sessionId, classification)`**:
1. Classify the error (transient vs fatal).
2. If fatal → proceed to `failed` status as today.
3. If transient → set status to `retrying`, emit `session.retry_scheduled` event, schedule re-launch after backoff delay.
4. On re-launch, call `launchProviderSession()` with the same parameters (including `resumeSessionId` for Claude Code).
5. If re-launch succeeds → set status back to `running`.
6. If re-launch fails → increment attempt count, go back to step 1.
7. If max attempts exhausted → set status to `failed` with enriched error.

### Integration Point

In `consumeProviderEvents`, the `finalizeSession` function currently unconditionally sets terminal status. We modify it to call a retry callback instead:

```typescript
// In consumer callbacks
onSessionFailed?: (sessionId: string, error: string, stderr: string) => Promise<boolean>;
// Returns true if retry was initiated, false if error is terminal
```

If `onSessionFailed` returns `true`, `finalizeSession` skips setting the terminal status — the orchestrator handles it.

### Backoff Parameters

```typescript
interface RetryConfig {
  maxAttempts: number;      // default: 3
  initialDelayMs: number;   // default: 5_000 (5s)
  maxDelayMs: number;       // default: 120_000 (2min)
  backoffMultiplier: number; // default: 2
  jitterFactor: number;     // default: 0.2 (±20%)
}
```

Delay formula: `min(initialDelay * multiplier^attempt * (1 ± jitter), maxDelay)`

Example progression: 5s → 10s → 20s (with ±20% jitter applied).

If the error response includes a `Retry-After` header (extractable from stderr), use that instead of the computed delay.

### What Gets Retried

**Claude Code**: Re-spawn the `claude` process with `--resume <providerSessionId>`. This resumes the conversation context — the agent picks up where it left off. No duplicate work.

**Codex**: Re-spawn the `codex` process, re-initialize, create a new thread, and start a new turn with the original prompt (or continuation prompt). Since Codex threads are ephemeral, there's no resume — but the worktree retains all file changes the agent made before the crash.

### What About Partial Responses?

If the session already received `content.delta` events (partial output) before dying:
- **Claude Code with `--resume`**: Claude Code handles this internally — the resumed session has the full conversation context, including any partial turn.
- **Codex without resume**: The partial content is already persisted in orchestration events. The new turn starts fresh, but the user sees the history. The new turn prompt should note "Continue from where you left off — check git status for any partial work."
- **Decision**: Do NOT attempt to "roll back" partial events on retry. They represent real work the agent did. The retried session appends new events after a `session.retry_started` marker.

---

## C. User-Facing Display

### New Session Status: `retrying`

Add `"retrying"` to `SessionStatusSchema`. This is a distinct visible state — the user should know the session is not running but also not dead.

### Dashboard — Sidebar

```typescript
retrying: { dotClass: "bg-status-warning animate-pulse", label: "Retrying" }
```

Pulsing amber dot with "Retrying" label. Visually distinct from both "Running" (green pulse) and "Failed" (red static).

### Dashboard — Chat View

When a `session.retry_scheduled` event arrives, render a system entry:

```
[!] API error (overloaded) — retrying in 10s (attempt 2/3)
    ████████░░ 8s remaining
```

- Amber warning style (not red error).
- Shows the error category, delay, and attempt count.
- Optional countdown progress bar (updates via `setTimeout` on the client — no server push needed).
- If retry succeeds, the next `session.started` / `turn.started` event naturally continues the chat.
- If all retries exhaust, the final `session.failed` event renders as today's red error box, but with an enriched message: "Failed after 3 retries: API overloaded. Last attempt at 14:23:05."

### Dashboard — Cancel Retries

Add a button to the retry system entry (or to the session header when status is `retrying`):

```
[Stop Retrying] → calls orka stop <sessionId>
```

This cancels the pending retry timer and transitions to `cancelled`. The existing `stopSession` flow handles this — we just need to clear the retry timer.

### Dashboard — Input State

The `deriveInputState()` function should treat `retrying` as a non-terminal busy state:

```typescript
case "retrying":
  return "busy"; // Input disabled, but session is not dead
```

### CLI — `orka ps`

```
sess-abc123  retrying  claude-code  "Fix the login bug"  (attempt 2/3, retry in 8s)
```

Yellow/amber color (ANSI 33), same as `cancelled`/`interrupted`. Show attempt info in verbose mode.

### CLI — `orka attach` / `orka logs -f`

During retry, stream a status line:

```
[orka] API error: overloaded — retrying in 10s (attempt 2/3)
[orka] Retry started...
```

Then resume normal log streaming when the new process starts.

### CLI — `orka result`

If the session completed after retries:

```
STATUS: SUCCESS (after 2 retries)
```

If it failed after exhausting retries:

```
STATUS: ERROR (failed after 3 retries)
  last error: API overloaded (529)
```

---

## D. Events and Status

### New Orchestration Events

```typescript
// Add to OrchestrationEvent union in core/orchestration.ts:

| OrchestrationEventEnvelope<"session.retry_scheduled", {
    attempt: number;       // 1-indexed attempt number
    maxAttempts: number;
    delayMs: number;
    category: string;      // "overloaded" | "rate_limit" | "server_error" | "network"
    error: string;         // Human-readable error message
  }>
| OrchestrationEventEnvelope<"session.retry_started", {
    attempt: number;
    maxAttempts: number;
  }>
| OrchestrationEventEnvelope<"session.retry_exhausted", {
    attempts: number;
    lastError: string;
    lastCategory: string;
  }>
```

### New SessionStatus Value

```typescript
// In core/types.ts SessionStatusSchema:
export const SessionStatusSchema = z.enum([
  "queued",
  "preparing",
  "running",
  "idle",
  "retrying",      // ← NEW
  "hibernated",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
```

### Event Flow on Retry

```
1. Process exits with error
2. Consumer calls onSessionFailed callback
3. Orchestrator classifies error → transient
4. DB: status = "retrying"
5. Engine emits: session.retry_scheduled { attempt: 1, delayMs: 5000, ... }
6. PushHub broadcasts: orchestration.sessionUpdated { status: "retrying" }
7. Timer fires after delay
8. Orchestrator calls launchProviderSession()
9. Engine emits: session.retry_started { attempt: 1 }
10. DB: status = "running"
11. PushHub broadcasts: orchestration.sessionUpdated { status: "running" }
12. New consumeProviderEvents() loop starts
```

### Engine Projection Updates

In `OrchestrationEngine.projectSessionState()`, handle the new events:

```typescript
case "session.retry_scheduled":
  projection.status = "retrying";
  projection.currentTurnId = null;
  break;
case "session.retry_started":
  projection.status = "preparing";
  break;
case "session.retry_exhausted":
  projection.status = "failed";
  projection.currentTurnId = null;
  break;
```

---

## E. Configuration

### config.toml

```toml
[retry]
enabled = true                 # default: true. Set to false to disable auto-retry.
max_attempts = 3               # default: 3. Total attempts (including the first).
initial_delay_seconds = 5      # default: 5
max_delay_seconds = 120        # default: 120
backoff_multiplier = 2.0       # default: 2.0

# Per-backend overrides (optional):
[retry.claude-code]
max_attempts = 5               # Claude Code can resume, so more retries are cheaper

[retry.codex]
max_attempts = 2               # Codex can't resume, so retries are expensive
```

### Config Schema

```typescript
const RetrySchema = z.object({
  enabled: z.boolean().default(true),
  maxAttempts: z.number().default(3),
  initialDelaySeconds: z.number().default(5),
  maxDelaySeconds: z.number().default(120),
  backoffMultiplier: z.number().default(2),
});

// In ConfigSchema:
retry: RetrySchema.default(RetrySchema.parse({})),
retryOverrides: z.record(z.string(), RetrySchema.partial()).default({}),
```

### Per-Spawn Override

Add `noRetry?: boolean` to `SpawnRequest` for cases where the caller knows retries are inappropriate (e.g., a one-shot diagnostic command).

---

## F. Edge Cases

### 1. Session was partially complete

If the session received events before dying (content deltas, tool executions, file changes):

- **Events are preserved** — they're already persisted in SQLite via the orchestration engine.
- **Worktree changes are preserved** — the agent may have written files, made git commits.
- **Claude Code with `--resume`** picks up the full conversation context, including the partial turn.
- **Codex without resume** starts a fresh turn. The retry prompt includes: "Continue the task — check the worktree for any work already completed."
- The `session.retry_started` event serves as a visible marker in the timeline separating pre-retry and post-retry events.

### 2. Multiple retries exhaust

When `attempt >= maxAttempts`:
- Emit `session.retry_exhausted` event with the full error history.
- Set status to `failed`.
- The error message is enriched: "Failed after {N} retries. Last error: {category} — {message}. First failure at {timestamp}."
- Dashboard shows the full retry history in the chat view (each `session.retry_scheduled` event is visible).

### 3. User sends input during retry

If `sendTurnToSession()` is called while status is `retrying`:
- **Cancel the pending retry timer.**
- **Resume immediately** — the user's input serves as the retry trigger.
- Call `resumeSession(ctx, sessionId, text)` which re-spawns the process with the user's message.
- This is the most natural UX — the user sees the session failed, types a message, and the session restarts with their input.

### 4. Concurrent limit hit during retry

Retrying sessions **should NOT count against `maxConcurrent`** while waiting (status = `retrying`). But when the retry timer fires and we're about to spawn:
- Check the concurrent limit.
- If at capacity, **delay the retry** — don't fail it. Extend the timer by another backoff interval.
- Emit a `runtime.warning` event: "Retry delayed — concurrent session limit reached."

### 5. User stops a retrying session

`stopSession()` for a session in `retrying` status:
- Clear the retry timer.
- Set status to `cancelled`.
- Emit `session.cancelled` event.
- No process to kill (it's already dead, we're just waiting for the timer).

### 6. Daemon restart during retry

On daemon restart, `recoverStaleSessions()` finds sessions with status `retrying`:
- Treat them like `running` sessions with no active handle — transition to `hibernated` (if they have `providerSessionId`) or `cancelled`.
- The retry timer is lost, but the session can be manually resumed.

### 7. Auto-merge sessions that succeed after retry

If `autoMerge` is set and the session completes successfully after retries:
- Auto-merge proceeds normally — the retry history is irrelevant to the merge.
- The `handleTurnCompleted` path fires on the first idle after retry, triggering auto-merge as usual.

### 8. Error during `launchProviderSession` (not process exit)

If `launchProviderSession()` throws (e.g., binary not found, worktree gone):
- This is a **pre-spawn failure**, not a process exit error.
- Classify it — if it's `binary_not_found` or `worktree_missing`, it's fatal (no retry).
- If it's a transient error (e.g., file system temporarily unavailable), retry.
- Currently, this error propagates to the `.catch()` in `spawnSession()` — we need to intercept it in the retry loop.

---

## G. Phased Implementation

### Phase 1: Stderr Capture + Error Classification (foundation)

**Goal**: Capture stderr from provider processes and classify errors. No behavior change — just better error messages.

1. **Capture stderr** in both adapters (currently `drainStream()` discards it). Store the last 4KB in the handle meta.
2. **Implement `classifyExitError()`** with pattern matching on stderr + exit code.
3. **Enrich `session.exited` reason** from "Claude Code exited with code 1" to "Claude Code exited: API overloaded (529)".
4. **Pass stderr to `finalizeSession`** so the orchestration event includes the real error.

Deliverables:
- Modified `claude-adapter.ts`: capture stderr into buffer instead of draining.
- Modified `codex-adapter.ts`: same.
- New `packages/daemon/src/error-classification.ts`.
- Updated `session.exited` reason strings in both adapters.
- Updated `session.failed` error strings in dashboard/CLI.

### Phase 2: Retry Loop in Orchestrator

**Goal**: Automatic retry for transient errors with exponential backoff.

1. **Add `retrying` status** to `SessionStatusSchema`.
2. **Add retry config** to `config.toml` schema.
3. **Add new orchestration events** (`session.retry_scheduled`, `session.retry_started`, `session.retry_exhausted`).
4. **Implement retry loop** in `orchestrator.ts` — new `retrySession()` function + retry state tracking.
5. **Modify `consumeProviderEvents`** to call `onSessionFailed` callback instead of unconditionally finalizing.
6. **Update `OrchestrationEngine.projectSessionState()`** to handle new events.
7. **Update `recoverStaleSessions()`** to handle `retrying` status.
8. **Update `stopSession()`** to clear retry timers.
9. **Update `sendTurnToSession()`** to handle user input during retry.

Deliverables:
- New `packages/daemon/src/retry.ts` (retry state machine, timer management).
- Modified `orchestrator.ts` (integration with retry).
- Modified `consumer.ts` (`onSessionFailed` callback).
- Modified `engine.ts` (projection for new events).
- Modified `config.ts` (retry schema).
- Modified `core/types.ts` (`retrying` status).
- Modified `core/orchestration.ts` (new event types).

### Phase 3: User-Facing Polish

**Goal**: Dashboard and CLI show retry state beautifully.

1. **Dashboard sidebar**: amber pulsing pill for `retrying`.
2. **Dashboard chat**: retry event rendering with countdown.
3. **Dashboard input**: `retrying` → `busy` state.
4. **Dashboard**: "Stop Retrying" button.
5. **CLI `orka ps`**: amber status with attempt info.
6. **CLI `orka attach`**: retry status lines.
7. **CLI `orka result`**: retry history in output.

### Phase 4: Per-Backend Resume Optimization

**Goal**: Maximize context preservation on retry.

1. **Claude Code**: Verify `--resume` works correctly after error exit (test with real 529s).
2. **Codex**: Build a continuation prompt template that helps the agent pick up where it left off.
3. **Worktree state verification**: Before retry, check that the worktree is in a clean state (no lock files, no broken git state).

---

## H. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Retry storm under sustained outage | Multiple sessions retry simultaneously, amplifying load | Global retry concurrency limit (e.g., max 2 concurrent retries). Respect `Retry-After` headers. |
| Infinite retry on misclassified errors | Session never fails, wastes resources | Hard cap on attempts (default 3). Classification errs on side of "fatal" for unknown patterns. |
| Stale worktree state after retry | Agent confused by partial changes | Worktree state check before retry. For Codex, include `git status` output in continuation prompt. |
| Stderr capture memory pressure | Long-running sessions accumulate stderr | Cap buffer at 4KB, ring-buffer style (keep tail). |
| Race between user stop and retry timer | Timer fires after stop, re-spawning a cancelled session | Clear timer in `stopSession()`. Check session status is still `retrying` before re-launching. |
