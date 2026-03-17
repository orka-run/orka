# Session Lifecycle Refactor Plan

## Current State: All Session Creation & Resume Paths

### Path 1: `spawnSession()` — Fresh session
**File:** `packages/daemon/src/orchestrator.ts:118-266`
**Trigger:** CLI `orka spawn`, dashboard spawn, `orka retry`

| Step | What happens | Line |
|------|-------------|------|
| 1 | Verify backend installed | 125 |
| 2 | Check concurrent limit | 128-137 |
| 3 | Generate IDs, create worktree | 139-171 |
| 4 | Generate `providerSessionId` (claude-code only) | 182 |
| 5 | Insert session record (status=preparing) | 184-205 |
| 6 | Insert tags | 207-211 |
| 7 | Build `supervisedEnv` if `permissionMode=supervised` | 214-223 |
| 8 | Call `providerService.startSession()` | 226-237 |
| 9 | Update status to `running`, record `startedAt` | 242 |
| 10 | Start `consumeProviderEvents()` | 245-254 |

### Path 2: `resumeSession()` — Hibernated/completed session
**File:** `packages/daemon/src/orchestrator.ts:272-376`
**Trigger:** `sendTurnToSession()` when status is hibernated/completed

| Step | What happens | Line |
|------|-------------|------|
| 1 | Recreate worktree if cleaned up | 282-304 |
| 2 | Clear stale provider handle | 307 |
| 3 | Build prompt (prepend context if no `providerSessionId`) | 312-323 |
| 4 | Detect `permissionMode` from `.claude/settings.json` | 325-328 |
| 5 | Call `providerService.startSession()` with `resumeSessionId` | 330-338 |
| 6 | Emit `user.input` event | 342-349 |
| 7 | Reset session to `running` via `resetSessionForContinue()` | 352 |
| 8 | Broadcast `sessionUpdated` | 353 |
| 9 | Start `consumeProviderEvents()` | 359-368 |

### Path 3: `sendTurnToSession()` — Input to running/idle session
**File:** `packages/daemon/src/orchestrator.ts:413-472`
**Trigger:** CLI `orka send`, dashboard chat input

| Step | What happens | Line |
|------|-------------|------|
| 1 | Clear idle timer | 423 |
| 2 | If running/idle with live handle: write to stdin | 427-458 |
| 3 | If idle → running transition + broadcast | 437-439 |
| 4 | Emit `user.input` event (DB + pushHub) | 442-455 |
| 5 | Call `providerService.sendTurn()` | 457 |
| 6 | If hibernated/completed: delegate to `resumeSession()` | 461-465 |

### Path 4: `closeSession()` — Explicit completion
**File:** `packages/daemon/src/orchestrator.ts:382-406`

### Path 5: `stopSession()` — User stop
**File:** `packages/daemon/src/orchestrator.ts:477-512`

### Path 6: `recoverStaleSessions()` — Daemon restart
**File:** `packages/daemon/src/orchestrator.ts:522-557`

---

## State Transition Diagram

```
                    ┌────────────┐
                    │  preparing │
                    └─────┬──────┘
                          │ startSession() succeeds
                          ▼
              ┌──────────────────────┐
       ┌──────│      running        │◄────────────────────┐
       │      └──────┬───────┬──────┘                     │
       │             │       │                            │
       │  turn.completed   session.exited              sendTurn/
       │             │       │                         resume
       │             ▼       ├──► completed             │
       │      ┌──────────┐   ├──► failed                │
       │      │   idle   │   └──► cancelled             │
       │      └────┬─────┘                              │
       │           │                                    │
       │    idle timeout                                │
       │           │                                    │
       │           ▼                                    │
       │    ┌─────────────┐                             │
       │    │ hibernated  │─────────────────────────────┘
       │    └─────────────┘
       │
       │    ┌─────────────┐
       └───►│  completed  │─────────────────────────────┘
            └─────────────┘
```

**Status update locations (14 total):**

| Location | File:Line | Transition |
|----------|-----------|------------|
| `spawnSession` | orchestrator.ts:242 | preparing → running |
| `resumeSession` | orchestrator.ts:352 | hibernated/completed → running |
| `sendTurnToSession` | orchestrator.ts:438 | idle → running |
| `hibernateSession` | orchestrator.ts:54 | idle → hibernated |
| `closeSession` | orchestrator.ts:393,396 | any → completed |
| `stopSession` | orchestrator.ts:502 | running/idle → cancelled |
| `recoverStaleSessions` | orchestrator.ts:536 | running/idle → hibernated/cancelled |
| `consumeProviderEvents` catch | consumer.ts:79 | any → failed |
| `handleTurnCompleted` | consumer.ts:217 | running → idle |
| `handleTurnCompleted` (auto-merge) | consumer.ts:231 | idle → completed |
| `finalizeSession` | consumer.ts:264 | any → completed/failed/cancelled |

---

## Problem Areas

### 1. Duplicated provider session launch logic

**`spawnSession()` vs `resumeSession()` both:**
- Call `providerService.startSession()` (orchestrator.ts:226 vs 330)
- Start `consumeProviderEvents()` (orchestrator.ts:245 vs 359)
- Build consumer callbacks via `buildConsumerCallbacks()` (orchestrator.ts:246 vs 360)
- Record metrics via `recordSessionStartedMetrics()` (orchestrator.ts:243 vs 354)
- Set up `.finally()` cleanup (orchestrator.ts:258-261 vs 372-374)

**But diverge on:**
- `supervisedEnv` injection: spawn builds it (214-223), resume doesn't
- Permission mode: spawn gets from request (235), resume detects from filesystem (325-328)
- `user.input` event: spawn doesn't emit one, resume does (342-349)
- `autoMerge`: spawn reads from request, resume hardcodes `false`
- Status update: spawn calls `updateSessionStatus` (242), resume calls `resetSessionForContinue` (352)
- Env vars: spawn passes `req.env` (234), resume doesn't pass env at all

### 2. permissionMode not persisted in DB

**File:** `packages/daemon/src/db.ts` — no `permission_mode` column in sessions table.

The `Session` type has `permissionMode?: PermissionMode` (core/types.ts:74), and the API response DTO has it (service.ts:35), but the DB schema has no column for it. The field is populated at the DTO mapping layer from... nowhere useful:
- `sessionToDetail()` at local-client.ts:887 reads `session.permissionMode` which is always `undefined` from DB
- Resume path at orchestrator.ts:325-328 detects from `.claude/settings.json` file existence — fragile

**Impact:** If a supervised session is resumed, the only way to know it was supervised is by checking if the hook settings file exists in the worktree. If the worktree was cleaned up and recreated, the hook settings are lost.

### 3. Env vars lost on resume

**`resumeSession()` at orchestrator.ts:330-338** does not pass:
- `session.env` (user-specified env vars from original spawn)
- `supervisedEnv` (ORKA_PERMISSION_RULES) — even when supervised is detected
- `model` / `reasoningEffort` from the original session

Only `systemPrompt` and `allowedTools` are restored from the session record.

### 4. user.input event emission is inconsistent

- **Spawn:** No `user.input` event emitted for the initial prompt
- **Resume:** Explicit `user.input` event at orchestrator.ts:342-349
- **SendTurn (running/idle):** Explicit `user.input` event at orchestrator.ts:442-455
- **SendTurn (hibernated/completed):** Delegates to resume which emits it

The initial prompt is lost from the orchestration event timeline.

### 5. Supervised hook setup is split across orchestrator and adapter

- **Orchestrator** (orchestrator.ts:214-223): Builds `supervisedEnv` with `ORKA_PERMISSION_RULES`
- **Claude adapter** (claude-adapter.ts:120-125): Writes `.claude/settings.json` and injects `ORKA_SESSION_ID` + `ORKA_DAEMON_URL`

The orchestrator knows about adapter-specific env vars. The adapter knows about orchestrator concerns (supervised hook settings). Neither owns the complete picture.

### 6. Duplicate broadcast in RPC handler

**`rpc-handler.ts:94-100`** broadcasts `orchestration.sessionUpdated` after spawn, but `spawnSession()` already transitions status internally. The consumer also broadcasts on status changes. This means spawn can produce **duplicate broadcasts**: one from orchestrator's status update, one from `rpc-handler.ts`.

Similarly for `closeSession` (rpc-handler.ts:103-108) and `stop` (rpc-handler.ts:111-120).

### 7. Module-level singleton state

- `idleTimers` map (orchestrator.ts:21)
- `autoMergeFired` set (consumer.ts:210)

Both are module-level singletons, violating DI policy. Not testable in isolation.

### 8. Consumer callbacks are a flat bag

`ProviderEventConsumerCallbacks` (consumer.ts:23-48) has 15 optional fields. Most are always provided. The interface is a catch-all instead of composed dependencies.

### 9. Codex doesn't support resume

`CodexAdapter` doesn't use `resumeSessionId` or `providerSessionId`. Resume on codex sessions just starts a fresh process with a context block. This is implicit — not documented or validated.

### 10. No status transition validation

Any code path can set any status. There's no state machine enforcing valid transitions. Examples of theoretically possible invalid transitions:
- `completed → failed` (if consumer races with closeSession)
- `cancelled → running` (if resume is called on a cancelled session)

The `finalizeSession` guard at consumer.ts:254 only checks for `hibernated` and `completed`. A cancelled session could theoretically be overwritten.

---

## Proposed Architecture

### Phase 1: Extract `launchProviderSession()` — Single entry point

Extract the common logic from `spawnSession()` and `resumeSession()` into a single function:

```typescript
interface LaunchProviderOptions {
  sessionId: string;
  session: Session;
  prompt: string;
  resumeSessionId?: string;
  permissionMode?: PermissionMode;
  env?: Record<string, string>;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  systemPrompt?: string;
  allowedTools?: string[];
  autoMerge: boolean;
}

async function launchProviderSession(
  ctx: DaemonContext,
  opts: LaunchProviderOptions,
): Promise<void> {
  // 1. Build supervised env if needed
  // 2. Call providerService.startSession()
  // 3. Emit user.input event
  // 4. Update session status to running
  // 5. Record metrics
  // 6. Start consumeProviderEvents() with .finally() cleanup
}
```

**Changes to `spawnSession()`:**
- Keep: ID generation, worktree creation, session record insertion, tag insertion
- Replace: lines 214-261 with `await launchProviderSession(ctx, { ... })`

**Changes to `resumeSession()`:**
- Keep: worktree recovery, stale handle cleanup
- Replace: lines 325-375 with `await launchProviderSession(ctx, { ... })`
- Load permissionMode from DB (after Phase 2), env from session record

### Phase 2: Persist `permissionMode` in DB

Add migration:
```sql
ALTER TABLE sessions ADD COLUMN permission_mode TEXT;
```

Update:
- `insertSession()`: write `permission_mode` from spawn request
- `SessionRowSchema`: add `permission_mode` field
- `rowToSession()`: map to domain type
- Resume: read from DB instead of filesystem detection

### Phase 3: Fix env restoration on resume

In `launchProviderSession()`:
- Read `session.env` (already persisted as `env_json`)
- Read `session.model` from task record (already persisted)
- Build `supervisedEnv` from config (same as spawn)
- Pass merged env to adapter

### Phase 4: Consistent `user.input` event emission

Move `user.input` emission into `launchProviderSession()` so every path (spawn, resume, sendTurn) emits it consistently. For spawn, the initial prompt becomes the first `user.input` event.

### Phase 5: Move supervised hook setup entirely into adapter

The orchestrator should not know about `.claude/settings.json` or `ORKA_PERMISSION_RULES`. Instead:
- Pass `permissionMode` + `permissionRules` to `startSession()` input
- Adapter handles all env injection and settings file creation
- Remove `supervisedEnv` building from orchestrator

Update `ProviderSessionStartInput`:
```typescript
interface ProviderSessionStartInput {
  // ...existing fields...
  permissionRules?: { autoApprove: string[]; alwaysDeny: string[] };
}
```

### Phase 6: Remove duplicate broadcasts from rpc-handler

The orchestrator already broadcasts on every status transition. The rpc-handler should not broadcast again. Remove the redundant `pushHub.broadcast` calls from `rpc-handler.ts:94-100`, `103-108`, `111-120`.

### Phase 7: Session state machine (optional, lower priority)

Introduce explicit transition validation:

```typescript
const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  preparing: ["running", "cancelled"],
  running: ["idle", "completed", "failed", "cancelled"],
  idle: ["running", "hibernated", "completed", "failed", "cancelled"],
  hibernated: ["running"],
  completed: ["running"],  // resume
  failed: [],
  cancelled: [],
};

function assertTransition(current: SessionStatus, next: SessionStatus): void {
  if (!VALID_TRANSITIONS[current]?.includes(next)) {
    throw new Error(`Invalid session transition: ${current} → ${next}`);
  }
}
```

Wrap `updateSessionStatus()` with this validation. Log warnings initially, throw errors after stabilization.

### Phase 8: Move idle timer and autoMerge tracking into DaemonContext

Replace module-level `idleTimers` and `autoMergeFired` with injectable state:

```typescript
// In daemon-context.ts or a new SessionState class
interface SessionRuntimeState {
  idleTimers: Map<string, ReturnType<typeof setTimeout>>;
  autoMergeFired: Set<string>;
}
```

Pass through `DaemonContext` or consumer callbacks.

---

## Migration Steps (Ordered)

### Step 1: Persist permissionMode (Phase 2)
**Risk:** Low. Additive DB migration, no behavior change.
- Add `permission_mode TEXT` column
- Write it on insert/spawn
- Read it in `resumeSession()`
- Keep filesystem detection as fallback for existing sessions

### Step 2: Extract `launchProviderSession()` (Phase 1)
**Risk:** Medium. Core refactor, must preserve all behavior.
- Extract common code from spawn and resume
- Both paths call the shared function
- Test: spawn, resume, sendTurn all still work
- Test: supervised mode works on spawn and resume
- Test: autoMerge only fires on spawn (not resume)

### Step 3: Fix env on resume (Phase 3)
**Risk:** Low. Bug fix, not behavior change.
- Read `env_json` from session record on resume
- Pass to `launchProviderSession()`
- Test: env vars survive hibernation cycle

### Step 4: Consistent user.input events (Phase 4)
**Risk:** Low. Additive — adds events that were missing.
- Emit `user.input` for initial spawn prompt
- Verify dashboard/timeline shows initial prompt

### Step 5: Move supervised hooks to adapter (Phase 5)
**Risk:** Medium. Changes responsibility boundary.
- Add `permissionRules` to `ProviderSessionStartInput`
- Move `supervisedEnv` building into adapter
- Remove from orchestrator
- Test: supervised mode works end-to-end

### Step 6: Remove duplicate broadcasts (Phase 6)
**Risk:** Low. Removing redundant calls.
- Remove broadcasts from rpc-handler for spawn/stop/close
- Verify dashboard still receives real-time updates

### Step 7: State machine + DI fixes (Phases 7-8)
**Risk:** Low. Defensive hardening.
- Add transition validation (log-only initially)
- Move module-level state into DaemonContext

---

## Priority Ordering

1. **P1 — Step 1 (permissionMode persistence):** Fixes a known bug where permission mode is lost on resume. Small, safe change.
2. **P1 — Step 3 (env restoration):** Fixes env vars being lost on resume. Small, safe change.
3. **P2 — Step 2 (extract launchProviderSession):** Core refactor that enables all other improvements. Requires careful testing.
4. **P2 — Step 4 (user.input consistency):** Fixes timeline gap. Easy once Step 2 is done.
5. **P3 — Step 5 (supervised hooks to adapter):** Clean separation of concerns. Can be done independently.
6. **P3 — Step 6 (remove duplicate broadcasts):** Minor cleanup.
7. **P4 — Step 7 (state machine + DI):** Hardening. Do after the core refactor stabilizes.
