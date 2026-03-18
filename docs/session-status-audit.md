# Session Status Correctness Audit

## 1. Status Flow Diagram

Every path from session creation to terminal state, with the code that triggers each transition.

```
                                 spawnSession()
                                      │
                                      ▼
                              ┌──────────────┐
                              │  preparing    │  orchestrator.ts:232
                              └──────┬───────┘
                                     │ launchProviderSession() succeeds
                                     │ orchestrator.ts:277
                                     ▼
                              ┌──────────────┐◄─────────────────────────┐
                              │   running     │                         │
                              └──┬───┬───┬───┘                         │
                                 │   │   │                              │
           turn.completed        │   │   │  session.exited              │
           consumer.ts:216       │   │   │  consumer.ts:284-294         │
                                 │   │   │                              │
                    ┌────────────┘   │   └──────────┐                   │
                    ▼                │              ▼                    │
             ┌──────────┐           │    ┌─────────────────┐            │
             │   idle    │           │    │ completed/failed │            │
             └──┬──┬──┬─┘           │    │   /cancelled    │            │
                │  │  │             │    └─────────────────┘            │
                │  │  │             │                                   │
   ┌────────────┘  │  └──────────┐  │                                   │
   │               │             │  │                                   │
   │  auto-merge   │  idle timer │  │ user sends input                  │
   │  (first idle) │  fires      │  │ orchestrator.ts:489-491           │
   │  consumer.ts  │  orch:37-39 │  │                                   │
   │  :223-236     │             │  └───────────────────────────────────┘
   │               │             │
   ▼               │             ▼
┌──────────┐       │      ┌──────────────┐
│completed │       │      │ hibernated   │
└──────────┘       │      └──────┬───────┘
                   │             │
                   │             │ user sends input (resumeSession)
                   │             │ orchestrator.ts:513-517
                   │             │
                   │             └───────────────────────────────────────┐
                   │                                                     │
                   ▼                                                     ▼
            ┌──────────┐                                          ┌──────────────┐
            │completed │  (via closeSession)                      │   running     │
            └──────────┘  orchestrator.ts:445                     │  (resumed)    │
                                                                  └──────────────┘
```

### Transition Table (from `db.ts` VALID_TRANSITIONS)

| From | To | Trigger |
|------|-----|---------|
| queued | preparing, cancelled | (not currently used) |
| preparing | running | Provider process started (`orchestrator.ts:277`) |
| preparing | cancelled, failed | Stop/error before process starts |
| running | idle | `turn.completed` event (`consumer.ts:216`) |
| running | completed | `session.exited` with graceful exit (`consumer.ts:293`) |
| running | failed | `session.exited` with error exit (`consumer.ts:289`) |
| running | cancelled | `session.exited` with user stop reason (`consumer.ts:286`) |
| idle | running | User sends input (`orchestrator.ts:489`) |
| idle | hibernated | Idle timer fires (`orchestrator.ts:37-54`) |
| idle | completed | Auto-merge succeeds (`consumer.ts:230`) OR `closeSession()` (`orchestrator.ts:445`) |
| idle | failed, cancelled | Stop/error while idle |
| hibernated | running | Resume via `sendTurnToSession()` (`orchestrator.ts:513-517`) |
| completed | running | Resume via `sendTurnToSession()` (`orchestrator.ts:514-516`) |

### What Makes Each Terminal Status

| Status | Meaning | Set By |
|--------|---------|--------|
| `completed` | Session finished work successfully | `finalizeSession()` (graceful exit), auto-merge path, `closeSession()` |
| `failed` | Session hit an error | `finalizeSession()` (error exit), consumer catch block |
| `cancelled` | User explicitly stopped | `finalizeSession()` (user stop reason), `stopSession()` fallback |
| `hibernated` | Process killed to save resources, resumable | `hibernateSession()` (idle timer) |

## 2. The Core Bug: One-Shot Background Sessions End Up `hibernated`

### Root Cause

**Claude Code does not exit after completing a one-shot task.** The process stays alive with stdin open, waiting for more input. This is by design — the adapter comment at `claude-adapter.ts:189` says:

```typescript
// stdin stays open for ALL sessions — multi-turn by default.
// Process stays alive after first turn, waiting for more input.
```

The session lifecycle for a one-shot background task (without `--auto-merge`):

1. `orka spawn "do X"` → `preparing` → `running`
2. Agent reads code, makes changes, commits → emits `turn.completed`
3. `handleTurnCompleted()` → status becomes `idle` → idle timer starts (10 min)
4. Process is still alive, waiting for stdin input that will never come
5. 10 minutes later → idle timer fires → `hibernateSession()` → `hibernated`
6. Process killed, session stuck in `hibernated` forever

**The only path from `idle` to `completed` without process exit is auto-merge** (`consumer.ts:223-236`). Without `--auto-merge`, there is NO mechanism to detect "task is done, mark completed."

### Why Codex Doesn't Have This Problem (as badly)

The Codex adapter has an `interactive` flag and a `CodexSessionProjection` that tracks session state. For non-interactive sessions, it auto-unsubscribes when the session reaches idle state (`codex-adapter.ts:177-178`):

```typescript
// Normal idle completion only triggers unsubscribe for background (non-interactive) sessions.
const shouldExit = this.hasTerminalError || (this.isSessionReady && !this.isInteractive);
```

This causes the Codex process to exit, which triggers `session.exited` → `finalizeSession()` → `completed`. The Claude adapter has no equivalent mechanism.

### Impact

- **Dashboard**: Shows sessions as "Paused" (hibernated) instead of "Done" (completed)
- **`orka show`**: Reports `finished: (not finished)` because `finishedAt` is never set (only set on true terminal transitions)
- **`orka wait`**: Works by accident — `idle` and `hibernated` are in its `terminalStatuses` set, so it stops waiting. But semantics are wrong.
- **`orka result`**: Returns `isError: false` with correct output (because it reads from orchestration events, not status). So the result is right but the status is wrong.
- **Worktree cleanup**: Never happens automatically for hibernated sessions — worktrees accumulate.
- **Metrics**: `sessionsCompleted` counter is never incremented for these sessions. `sessionDuration` is never recorded. Observability is broken.

## 3. Secondary Issues Found

### 3a. `orka wait` Terminal Statuses Are Too Broad

```typescript
// packages/cli/src/index.ts:1421
const terminalStatuses = new Set(["idle", "hibernated", "completed", "failed", "cancelled", "interrupted"]);
```

`idle` is NOT a terminal status — it means the process is alive and waiting for input. Including it here means `wait` returns prematurely for interactive sessions (before the agent is truly done). Currently this "works" because:
- Background sessions transition through idle quickly (auto-merge → completed, or idle timer → hibernated)
- But if idle timeout is set to 0 (no auto-hibernate), `wait` returns immediately when the first turn completes, even for multi-turn sessions

### 3b. No `finishedAt` on Hibernation

When `hibernateSession()` fires, it only sets status to `hibernated` — it does NOT set `finishedAt`. This means `orka show` displays `finished: (not finished)` for sessions that are effectively done. The `sessionDuration` metric is also not recorded.

### 3c. `closeSession()` Is Invisible

There exists `closeSession()` (`orchestrator.ts:434-458`) which correctly marks a session `completed` and kills the process. The CLI exposes this via `OrkaService.closeSession()`. But there's no clear UX path for users to call this. If a user runs `orka stop`, that calls `stopSession()` which marks as `cancelled`, not `completed`. To mark completed, users would need a separate `orka close` command (which doesn't appear to exist as a CLI command).

### 3d. Diff Capture Missed for Hibernated Sessions

`captureSessionDiff()` is only called in `finalizeSession()` (`consumer.ts:261`). But `finalizeSession()` returns early when status is already `hibernated` (`consumer.ts:253`). This means the diff is never captured for sessions that go through the hibernation path — which is currently ALL one-shot background sessions.

### 3e. Worktree Cleanup Only on `cancelled`

In `finalizeSession()` (`consumer.ts:279-281`):
```typescript
if (status === "cancelled") {
  await callbacks.cleanupWorktree?.();
}
```

Worktree cleanup never runs for `completed` or `failed` sessions that exit naturally. This may be intentional (preserve for inspection), but combined with the hibernation bug, it means worktrees accumulate for ALL background sessions.

## 4. Proposed Fixes

### Fix 1: Close stdin after first turn for non-interactive sessions (Recommended)

The cleanest fix: when a background session's first turn completes, close stdin to signal Claude Code to exit. The process will exit gracefully, emit `session.exited`, and `finalizeSession()` will mark it `completed`.

**Implementation:**

Add an `interactive` field to `Session` / `SpawnRequest` (or infer it from `autoMerge`). In `handleTurnCompleted()`, if the session is not interactive and it's the first turn, close stdin:

```typescript
// In consumer.ts handleTurnCompleted()
async function handleTurnCompleted(sessionId, callbacks) {
  callbacks.updateSessionStatus(sessionId, "idle");
  // ... broadcast ...

  // Auto-merge path (existing)
  if (callbacks.autoMerge && ...) { ... }

  // NEW: For non-interactive sessions, close stdin to trigger graceful exit
  if (!callbacks.interactive) {
    callbacks.closeStdin?.(sessionId);
    return; // Don't start idle timer — process will exit
  }

  // Interactive sessions get idle timer
  callbacks.onSessionIdle?.(sessionId);
}
```

When `closeStdin()` is called, Claude Code will detect EOF on stdin and exit with code 0. The `consumeClaudeOutput()` function will then emit `session.exited` with `exitKind: "graceful"`, and `finalizeSession()` will mark the session `completed`.

**Pros:**
- Minimal changes — just close stdin at the right time
- Claude Code handles EOF gracefully (exits with code 0)
- `session.exited` → `finalizeSession()` → proper `completed` status, diff capture, metrics
- Works for both Claude Code and Codex (Codex already handles this internally for non-interactive)

**Cons:**
- Need to plumb `interactive` flag through `SpawnRequest` → `Session` → consumer callbacks
- Need to plumb `closeStdin` callback through consumer callbacks

### Fix 2: Complete on first idle for non-interactive sessions (Simpler but less clean)

Instead of closing stdin (which triggers a proper process exit lifecycle), directly mark the session `completed` when the first turn completes for a non-interactive session:

```typescript
// In consumer.ts handleTurnCompleted()
if (!callbacks.interactive) {
  callbacks.updateSessionStatus(sessionId, "completed", { finishedAt: new Date().toISOString() });
  // Kill the process since we're done
  callbacks.stopSession?.(sessionId);
  return;
}
```

**Pros:**
- Even simpler — no stdin plumbing needed
- Immediate status transition

**Cons:**
- Process kill is "unnatural" — we're killing a healthy process
- Race condition: need to set status before kill (same pattern as hibernation)
- Skips the normal `finalizeSession()` path, so need to duplicate diff capture, approval cleanup, etc.

### Fix 3: Treat first idle with auto-merge=false as "completed" (Minimal change)

Extend the auto-merge block to also handle non-auto-merge background sessions:

```typescript
// In consumer.ts handleTurnCompleted()
if (!callbacks.interactive && !callbacks.autoMergeFired?.has(sessionId)) {
  callbacks.autoMergeFired?.add(sessionId);

  if (callbacks.autoMerge) {
    await tryAutoMerge(sessionId, callbacks);
  }

  // Capture diff before marking completed
  await captureSessionDiff(sessionId, callbacks);

  callbacks.updateSessionStatus(sessionId, "completed", { finishedAt: new Date().toISOString() });
  // ... broadcast, kill process ...
  return;
}
```

### Fix 4: Fix `orka wait` and metrics independently (Band-aid)

If the above fixes are too invasive, at minimum:
- Remove `idle` from `wait`'s terminal statuses (it's not terminal)
- Set `finishedAt` in `hibernateSession()` so duration is recorded
- Capture diff before hibernation
- Treat `hibernated` as a valid "done" state in the dashboard

This doesn't fix the root cause but makes the symptoms less painful.

## 5. Additional Fixes Needed

### 5a. Fix `orka wait` terminal statuses

Remove `idle` from `terminalStatuses`. For background sessions, `wait` should only stop on: `completed`, `failed`, `cancelled`, `hibernated`. For interactive sessions, `wait` behavior needs more thought — probably wait until `completed`/`failed`/`cancelled` only.

### 5b. Set `finishedAt` on hibernation

In `hibernateSession()`, add `finishedAt`:
```typescript
ctx.db.updateSessionStatus(sessionId, "hibernated", { finishedAt: new Date().toISOString() });
```

### 5c. Capture diff before hibernation

Call `captureSessionDiff()` in `hibernateSession()` before killing the process.

### 5d. Add `orka close` CLI command

Expose `closeSession()` as `orka close <id>` so users can explicitly mark a session completed (vs `orka stop` which cancels).

## 6. Questions for the User

1. **Should all `orka spawn` sessions without `--auto-merge` be treated as interactive?** Currently there's no `--interactive` flag. The implicit assumption is: `--auto-merge` = background (one-shot), no `--auto-merge` = interactive (multi-turn). Is this the right default? Or should background/one-shot be the default with `--interactive` as opt-in?

2. **Should `orka stop` produce `cancelled` or `completed`?** Currently it produces `cancelled`, which triggers worktree cleanup. If a user runs `orka stop` on a session that has committed useful work, they may not want the worktree deleted. Should there be separate `stop` (cancel) vs `close` (complete) commands?

3. **What should happen to worktrees for `completed` sessions?** Currently worktree cleanup only runs on `cancelled`. Should completed sessions also auto-clean their worktrees (respecting `kept`/uncommitted/commits-ahead guards)?

4. **Is the 10-minute idle timeout correct for interactive sessions?** If we fix the background/interactive distinction, the idle timeout only matters for interactive sessions. 10 minutes feels short for a human reviewing and typing a follow-up. Should it be configurable per-session or have a longer default?

5. **Should `hibernated` remain a separate status?** With proper background completion detection, `hibernated` would only apply to interactive sessions that go idle. Is it worth keeping as a distinct status, or should it be folded into something else?

## 7. Recommendation

**Fix 1 (close stdin for non-interactive sessions)** is the cleanest approach because:

- It uses the natural process exit lifecycle — Claude Code handles EOF on stdin by exiting gracefully
- This triggers the existing `finalizeSession()` path, which handles diff capture, approval cleanup, metrics, and status transitions correctly
- No duplication of finalization logic needed
- The Codex adapter already does the equivalent (auto-unsubscribe for non-interactive)
- It makes the mental model simple: background sessions run to completion and exit; interactive sessions stay alive for follow-ups

The key decision is: **how do we determine "interactive" vs "background"?** Options:
- **Explicit flag**: Add `--interactive` to `orka spawn`. Default: background (non-interactive).
- **Infer from `autoMerge`**: `--auto-merge` implies background. But this couples two independent concepts.
- **Infer from context**: If stdin is a TTY, interactive. If not, background. But orka sessions never have a user TTY.

Recommendation: Add an explicit `--interactive` / `--mode interactive|background` flag to `SpawnRequest`. Default to `background`. This is the most predictable and composable approach.
