# Test Coverage Audit — Recent Features

**Date:** 2026-03-20
**Scope:** Integration and E2E test coverage for features implemented in the last few days.
**Out of scope:** Unit tests for pure functions (schema validation, parsing, formatting).

## 1. Coverage Matrix

| # | Feature | Unit | Integration | E2E | Verdict |
|---|---------|------|-------------|-----|---------|
| 1 | Workspaces (DB, RPC, auto-creation, dashboard) | DB CRUD only | **NONE** | **NONE** | **CRITICAL GAP** |
| 2 | Per-turn checkpoints (capture, diff, revert, prune) | DB CRUD, git ops, orchestration reactor | consumer checkpoint callback | **NONE** | Partial |
| 3 | .orka.toml project config | Schema, load, merge, resolve, dynamic env | **NONE** | **NONE** | **CRITICAL GAP** |
| 4 | allowedActions | Single test in local-client.test.ts | **NONE** | **NONE** | **CRITICAL GAP** |
| 5 | Rate limit / API retry events | Adapter mapping, consumer state transition | Consumer loop test | **NONE** | Partial |
| 6 | Follow-up message queue | local-client queue test | Consumer delivery test | **NONE** | Partial |
| 7 | Codex turn/steer and turn/cancel | Adapter event mapping | **NONE** | **NONE** | **CRITICAL GAP** |
| 8 | Delta sync on reconnect | Push sequence gap detection (wsTransport) | **NONE** | **NONE** | **CRITICAL GAP** |
| 9 | In-place sessions (--no-worktree) | — | — | Used as convenience in E2E | Incidental only |
| 10 | Workspace resolution (resolveProject) | projects.test.ts (2 cases) | **NONE** | **NONE** | Weak |
| 11 | Session state machine (valid transitions) | **NONE** | Consumer tests cover some transitions | **NONE** | **CRITICAL GAP** |
| 12 | Kysely migration system | **NONE** | Implicitly run in every DB test | **NONE** | Implicit only |

## 2. Critical Gaps (Features with ZERO Integration/E2E Tests)

### Gap 1: Workspaces — Full CRUD + Auto-Creation

**What exists:** `db.test.ts` seeds sessions with `workspaceId` but never tests workspace CRUD methods (`insertWorkspace`, `getWorkspace`, `listWorkspaces`, `resolveWorkspaceForPath`). `aggregating-client.test.ts` mocks all workspace methods with no-ops. `orka-client.test.ts` tests `updateWorkspace` RPC wire format only.

**What's missing:**
- No test creates a workspace, adds paths, queries it back
- No test verifies `resolveWorkspaceForPath()` lookup + fallback logic
- No test verifies auto-creation during spawn (`orchestrator.ts:402-409`)
- No test verifies workspace backfill migration (`002_backfill_workspaces.ts`)
- No E2E test exercises any `orka workspace` CLI command
- No test verifies session counts in `listWorkspaces` response

### Gap 2: .orka.toml — Config Merging → Spawn Env Propagation

**What exists:** `config.test.ts` thoroughly tests schema parsing, file loading, merging, and `evaluateDynamicEnv()` in isolation.

**What's missing:**
- No test verifies that a spawned session actually receives env vars from `.orka.toml`
- No test verifies project config overrides user config in a real spawn
- No test verifies `beforeSpawn` / `afterComplete` hooks fire
- No test verifies per-backend defaults resolve correctly during spawn

### Gap 3: allowedActions — State × Worktree Matrix

**What exists:** One test in `local-client.test.ts` checks two states (completed, idle).

**What's missing:**
- No test covers the full state matrix (running, rate_limited, hibernated, failed, cancelled, queued, preparing)
- No test verifies `noWorktree=true` suppresses merge action
- No test verifies actions change when a session transitions states
- No E2E test verifies the dashboard/CLI receives correct actions

### Gap 4: Codex turn/steer and turn/cancel

**What exists:** `codex-adapter.test.ts` tests event mapping (thread/started → session.started, etc.) but not turn/steer or turn/cancel mechanics.

**What's missing:**
- No test sends a steer request to an active Codex turn
- No test verifies steer failure falls back to queue
- No test sends a cancel and verifies turn interruption
- No test verifies queued messages are cleared on cancel

### Gap 5: Delta Sync on Reconnect

**What exists:** `wsTransport.test.ts` tests push sequence gap reporting in the client transport. `rpc-handler.test.ts` tests `reportEventGap` traceparent propagation.

**What's missing:**
- No test simulates a WebSocket disconnect + reconnect and verifies the client receives only missed events
- No test verifies `snapshotSequence` in `SessionListResult` is correct
- No E2E test exercises the full reconnect → delta-fetch → UI-update path

### Gap 6: Session State Machine

**What exists:** `VALID_TRANSITIONS` map in `db.ts` and `isValidTransition()` function exist but have zero direct tests. Consumer tests implicitly exercise some transitions (running → idle → completed, running → rate_limited).

**What's missing:**
- No test validates every allowed transition succeeds
- No test validates invalid transitions are rejected
- No test verifies edge transitions (completed → running resume, failed → running resume)

### Gap 7: Kysely Migration System

**What exists:** Every `db.test.ts` and E2E test implicitly runs migrations via `createDaemonContext()`. But no test verifies migration behavior explicitly.

**What's missing:**
- No test verifies fresh DB runs all migrations in order
- No test verifies idempotency (running migrations twice is safe)
- No test verifies legacy `schema_migrations` → Kysely tracking table transition
- No test verifies backup creation before migration
- No test verifies migration failure rollback

## 3. Partially Covered Features

### Checkpoints (Partial)

**What exists:**
- `checkpointing.test.ts`: Tests `captureCheckpoint()`, diff, revert, prune against real git repos (4 tests)
- `orchestration/checkpoint.test.ts`: Tests `CheckpointService` and `CheckpointReactor` with in-memory orchestration events (4 tests)
- `consumer.test.ts`: "requests a turn checkpoint without blocking idle transition" — verifies callback fires
- `db.test.ts`: "stores, reads, and deletes checkpoints" — verifies DB CRUD

**What's missing:**
- No E2E test spawns a session, waits for turn completion, and verifies checkpoints are captured
- No test exercises `revertToCheckpoint` or `revertSession` RPC through the full stack
- No test verifies `getTurnDiff` RPC returns correct patch content
- No test verifies the oversized (>10MB) guard path end-to-end
- No test verifies checkpoint pruning on session deletion

### Rate Limit Events (Partial)

**What exists:**
- `claude-adapter.test.ts`: Maps `rate_limit_event` → `session.rate_limited`
- `codex-adapter.test.ts`: Maps similar events
- `consumer.test.ts`: "transitions failed sessions to rate_limited when the provider exhausts a rate limit"

**What's missing:**
- No test verifies the auto-resume timer fires and resumes the session
- No test verifies stall watchdog respects `pendingRateLimits`
- No E2E test with a provider that emits rate limit events

### Follow-up Message Queue (Partial)

**What exists:**
- `local-client.test.ts`: "queues follow-up input while a session is running" — verifies queue insertion
- `consumer.test.ts`: "delivers queued follow-up messages before auto-merge or idle timers"

**What's missing:**
- No test verifies multiple queued messages are joined with `\n\n`
- No test verifies queue is cleared on session exit/cancel
- No E2E test sends input to a running session and verifies delivery

### In-place Sessions (Incidental)

**What exists:** `noWorktree: true` is used in E2E tests as a convenience to avoid worktree setup. `worktree.e2e.test.ts` line 95 verifies `workingDir === testRepo` when `noWorktree: true`.

**What's missing:**
- No test verifies in-place sessions don't create worktree branches
- No test verifies merge action is suppressed for in-place sessions
- No test verifies git operations (checkpoint, diff) work correctly in-place

## 4. Recommended Test Plan (Priority Order)

### P0 — Write Immediately (core integration flows)

#### T1: Workspace Integration Test (`packages/daemon/src/workspace.integration.test.ts`)

```
Test: "workspace lifecycle through LocalClient"
Setup: createDaemonContext(tempDir)
Cases:
  - createWorkspace → listWorkspaces → getWorkspace round-trip
  - addWorkspacePath / removeWorkspacePath → verify listWorkspaces paths
  - resolveWorkspaceForPath returns correct workspace
  - resolveWorkspaceForPath with nodeId fallback to local
  - spawn auto-creates workspace when projectPath has no mapping
  - spawn reuses existing workspace when projectPath matches
  - deleteWorkspace unlinks sessions (workspace_id cleared)
  - listWorkspaces returns correct sessionCount and activeCount
```

Runs in-process with real SQLite. No Docker needed.

#### T2: Session State Machine Unit Test (`packages/daemon/src/state-machine.test.ts`)

```
Test: "session state machine validates transitions"
Cases:
  - Every entry in VALID_TRANSITIONS succeeds
  - Every transition NOT in the map is rejected
  - Cover resume paths: completed→running, failed→running, cancelled→running
  - Cover terminal-like paths: queued→cancelled, preparing→cancelled
  - updateSessionStatus in db.ts rejects invalid transitions
```

Pure unit test, no external dependencies.

#### T3: allowedActions Full Matrix (`packages/daemon/src/allowed-actions.test.ts`)

```
Test: "computeAllowedActions covers full state × worktree matrix"
Cases:
  - One test per status value with worktree=true
  - One test per status value with worktree=false
  - One test per status value with noWorktree=true
  - Verify merge only present when worktree exists AND noWorktree=false
  - Verify running → [sendTurn, cancelTurn, stop]
  - Verify idle → [sendTurn, stop, merge?]
  - Verify rate_limited → [sendTurn, stop]
```

Pure function test, no dependencies.

### P1 — Write Soon (multi-component integration)

#### T4: Checkpoint E2E Test (`tests/e2e/checkpoints.e2e.test.ts`)

```
Test: "per-turn checkpoints through daemon"
Setup: startServer with TestShellAdapter, init git repo
Cases:
  - Spawn session, emit turn.completed events → getCheckpoints returns entries
  - getTurnDiff between turns returns valid patch
  - revertToCheckpoint restores file state
  - revertSession with files_and_conversation deletes events after turn
  - Checkpoint capture doesn't block session idle transition
```

Needs real git repo in temp dir. Uses existing E2E infrastructure.

#### T5: .orka.toml Spawn Integration (`packages/daemon/src/project-config.integration.test.ts`)

```
Test: "project config propagates to spawned sessions"
Setup: createDaemonContext, write .orka.toml to temp project dir
Cases:
  - Static env vars from .orka.toml appear in spawn environment
  - Dynamic env (shell command) evaluates and propagates
  - Per-backend defaults apply (e.g. [defaults.codex].model)
  - Project config overrides user config for same keys
  - Missing .orka.toml is handled gracefully (no crash)
```

Needs temp dir with .orka.toml. May need to inspect spawned process env.

#### T6: Follow-up Queue E2E (`tests/e2e/daemon.e2e.test.ts` — add to existing)

```
Test: "follow-up messages delivered after turn completion"
Setup: Spawn interactive session, first turn running
Cases:
  - sendTurn while running → message queued (not lost)
  - Turn completes → queued message automatically delivered as next turn
  - Multiple queued messages joined with \n\n
  - cancelTurn clears queued messages
```

Extend existing daemon.e2e.test.ts suite.

### P2 — Write When Possible (resilience and edge cases)

#### T7: Delta Sync E2E (`tests/e2e/delta-sync.e2e.test.ts`)

```
Test: "dashboard receives delta events after reconnect"
Setup: Start daemon with WS, connect client, spawn session
Cases:
  - Connect → receive events → disconnect → reconnect with last sequence
  - After reconnect, only missed events are delivered
  - snapshotSequence in listSessions matches push hub state
  - reportEventGap triggers re-broadcast of missed events
```

Needs WS client simulation. Complex but no Docker.

#### T8: Codex Steer/Cancel Integration (`packages/daemon/src/adapters/codex-steer.integration.test.ts`)

```
Test: "Codex turn/steer and turn/cancel through orchestrator"
Setup: Mock Codex adapter with controllable responses
Cases:
  - Send steer to active turn → adapter receives turn/steer
  - Steer failure → input queued for delivery after turn
  - Send cancel → adapter receives turn/interrupt
  - Cancel clears pending message queue
```

Needs mock Codex subprocess or adapter stub.

#### T9: Kysely Migration Lifecycle (`packages/core/src/migrate.test.ts`)

```
Test: "migration runner handles fresh and incremental migrations"
Setup: Temp SQLite databases
Cases:
  - Fresh DB: all migrations run in order, tables exist
  - Already-migrated DB: no migrations re-run
  - Legacy schema_migrations table: Kysely tracking table pre-seeded
  - Backup file created before migration
  - Migration failure: partial state doesn't corrupt DB
```

Pure test with temp SQLite files.

#### T10: In-place Session Behavior (`tests/e2e/worktree.e2e.test.ts` — extend)

```
Test: "in-place session lifecycle"
Cases:
  - noWorktree: true → no branch created, no worktree dir
  - Merge action not available for in-place sessions
  - Stop + prune don't try to clean up nonexistent worktree
  - Checkpoint capture works in project dir directly
```

Extend existing worktree E2E suite.

## 5. Summary

| Priority | Tests | Features Covered | Estimated Effort |
|----------|-------|-----------------|------------------|
| **P0** | T1, T2, T3 | Workspaces, State Machine, allowedActions | Small — pure logic, no infra |
| **P1** | T4, T5, T6 | Checkpoints E2E, .orka.toml, Follow-up Queue | Medium — needs git repos, process env |
| **P2** | T7, T8, T9, T10 | Delta Sync, Codex Steer, Migrations, In-place | Medium-Large — WS simulation, adapter mocks |

**6 of 12 features have zero integration or E2E tests.** The most urgent gaps are:
1. **Workspaces** — entirely untested CRUD + auto-creation, high surface area
2. **Session state machine** — zero validation of the transition map that guards all status changes
3. **allowedActions** — only 2 of 10+ states tested, drives all UI action visibility
