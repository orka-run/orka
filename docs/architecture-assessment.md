# Architecture Assessment

## Executive Summary

The codebase is split between two architectures:

1. The live system is tmux-first, log-file-first, and status-row-first.
2. The newer system is provider-adapter-first, event-shaped, and push-oriented.

Only the first one actually runs end to end today.

That is the core problem. The repository contains a non-trivial amount of architecture that looks like the future system, but it is not in the live path. That creates false confidence, duplicate concepts, and a growing surface area of code that can pass tests while delivering nothing to users.

The dashboard makes this especially obvious. Real-time updates are currently just:

- coarse `orchestration.sessionUpdated` status pushes,
- raw `session.logLine` streaming from log files,
- polling for diff and result data,
- a fake `ChatView` timeline built from placeholders.

This is not a push-first event architecture. It is a tmux session manager with a WebSocket shell around it.

## Scope And Method

I reviewed the code in:

- `packages/core/src`
- `packages/daemon/src`
- `packages/dashboard/src`
- `packages/cli/src/index.ts`
- `packages/relay/src`

I also attempted the requested backlog review with:

```bash
bd list --status=open -n 60 --json
bd ready --json
```

Both fail in this worktree because beads is pointing at database `orka`, while the local Dolt server only exposes the default `dolt` database. `bd doctor` reports the same failure, and `bd dolt status` shows the local server using `.beads/dolt`. So the backlog is not actually reviewable from this checkout. That is itself a project-management failure and should be treated as a blocking issue.

## a) Dead Code Vs Live Path Analysis

### Live path

The live path is straightforward:

- `LocalClient.spawn()` calls `spawnSession()` in the old orchestrator path: `packages/daemon/src/local-client.ts:55-64`.
- `spawnSession()` creates DB rows, creates a worktree, writes a shell script, launches tmux, and marks the session `running`: `packages/daemon/src/orchestrator.ts:43-162`.
- The backend command is still just a shell command built by `buildBackendCommand()`: `packages/daemon/src/backends.ts:35-97`.
- Completion is detected by a shell-script callback to `/session-ended`, which then calls `svc.reap()`: `packages/daemon/src/orchestrator.ts:145-151`, `packages/daemon/src/server.ts:69-82`.
- Reaping checks tmux liveness, parses an exit code marker from the log, persists diff data, updates DB status, and broadcasts `orchestration.sessionUpdated`: `packages/daemon/src/orchestrator.ts:165-234`.
- Real-time dashboard output is log-tail streaming from files, not provider events: `packages/daemon/src/log-tailer.ts:32-80`, `packages/dashboard/src/components/LogPanel.tsx:24-78`.

That is the real system.

### Substantial code that exists but is not wired into the live path

#### Provider adapter layer

The provider abstraction is real code, not stubs:

- canonical provider interface: `packages/core/src/provider-adapter.ts:7-39`
- canonical event model: `packages/core/src/provider-events.ts:10-215`
- registry: `packages/daemon/src/provider-registry.ts`
- session manager: `packages/daemon/src/provider-service.ts:11-98`
- adapters:
  - `packages/daemon/src/adapters/codex-adapter.ts:79-238`
  - `packages/daemon/src/adapters/claude-adapter.ts:80-198`
  - `packages/daemon/src/adapters/shell-adapter.ts:86-251`

But none of it is instantiated in the daemon runtime. `ProviderService` and `OrchestrationEngine` only show up in tests and exports, not in the daemon startup path or RPC path. The live spawn path still bypasses all of it.

Consequence: the codebase is paying the maintenance cost of a provider runtime without getting any runtime value from it.

#### Orchestration engine and event ingestion

`OrchestrationEngine` can ingest provider events, maintain a projection, and broadcast `orchestration.event`: `packages/daemon/src/orchestration/engine.ts:19-134`.

`CheckpointReactor` can listen to orchestration events and capture git checkpoints: `packages/daemon/src/orchestration/checkpoint-reactor.ts:6-45`.

`CheckpointService` can capture, diff, and roll back checkpoints: `packages/daemon/src/orchestration/checkpoint.ts:23-165`.

But again, none of this is constructed in the live daemon path. There is no ingestion loop consuming provider events, no persistent event log, and no dashboard subscriber using `orchestration.event`.

Consequence: the entire event-driven orchestration layer is effectively dormant.

#### Chat timeline path

The push protocol explicitly defines `orchestration.event`: `packages/core/src/push-protocol.ts:6-63`.

The engine can broadcast it: `packages/daemon/src/orchestration/engine.ts:42-46`.

The dashboard transport supports subscription and tests cover `orchestration.event`.

But the actual app only subscribes to `orchestration.sessionUpdated` and `orchestration.sessionDeleted`: `packages/dashboard/src/App.tsx:42-70`.

`ChatView` is fully synthetic. It literally says “Placeholder events” and builds mock entries from session metadata: `packages/dashboard/src/components/ChatView.tsx:44-88`, `packages/dashboard/src/components/ChatView.tsx:165-239`.

Consequence: the code contains a protocol for a real session timeline, but the product ships a fake one.

#### Approvals

The service contract includes approvals: `packages/core/src/service.ts:113-115`.

`ApprovalManager` exists: `packages/daemon/src/approval-manager.ts:3-51`.

`LocalClient` exposes `getPendingApprovals()` and `resolveApproval()`.

But nothing in the live path adds approval requests into the manager. The provider event path that could have populated it is not wired, and the adapters mostly either auto-approve or do not support approvals at all.

Consequence: approval support exists on paper, not in the runtime.

#### Terminal subsystem

`TerminalManager` is real and exposed through RPC: `packages/daemon/src/terminal-manager.ts:35-171`, `packages/daemon/src/rpc-handler.ts:140-152`.

But there is no dashboard UI for it, and the relay does not allow terminal RPC methods in `ALLOWED_METHODS`: `packages/relay/src/index.ts:34-38`.

Consequence: terminal access is only partially wired and cannot be considered a finished remote feature.

### Code that is not dead, but is strategically awkward

`ShellAdapter` is the clearest example. It lives in the “new” provider layer, but internally it spawns tmux and polls capture output: `packages/daemon/src/adapters/shell-adapter.ts:91-250`.

That means the supposed abstraction boundary is already leaking. The “new” provider architecture still has tmux embedded inside it for shell. That is not clean layering. It is architecture overlap.

## b) Architecture Gaps

### There is no single source of truth for runtime state

The clean version of this system would have one authoritative session runtime:

- start session
- emit canonical events
- project state from those events
- persist events and projection
- push events to subscribers

Instead, Orka currently has three overlapping notions of session state:

1. DB session rows with coarse statuses.
2. tmux process existence.
3. provider runtime events in a dormant subsystem.

This causes real pain:

- status transitions are manual and duplicated,
- completion detection is brittle,
- chat and approvals cannot be built cleanly,
- tests can pass around dormant code while production still runs differently.

### The system is not event-sourced in any meaningful sense

`OrchestrationEngine` keeps an in-memory event log only: `packages/daemon/src/orchestration/engine.ts:20`.

That log is not persisted, not replayed after restart, and not fed from live sessions. So even if it were wired tomorrow, it would still not be an event-sourced architecture. It would be an in-memory sidecar.

Pain caused:

- daemon restart loses runtime narrative,
- dashboard reconnect cannot rebuild chat state from events,
- approvals/checkpoints would be ephemeral,
- projections cannot be trusted across process boundaries.

### The push path is incomplete and inconsistent

Push channels exist, but only two are truly used in production:

- `orchestration.sessionUpdated`
- `session.logLine`

Even those are not projection-driven. They are manually broadcast from RPC handlers, the orchestrator, and the `/session-ended` callback: `packages/daemon/src/rpc-handler.ts:70-86`, `packages/daemon/src/orchestrator.ts:203-210`, `packages/daemon/src/server.ts:69-80`.

Pain caused:

- every lifecycle change needs manual broadcast plumbing,
- session metadata can go stale because known sessions only update `status`,
- UI state is coupled to ad hoc side effects instead of a consistent feed.

### `ChatView` gets the wrong data entirely

What it gets now:

- session summary data from Zustand,
- fake timestamps,
- fake assistant text,
- fake tool activity.

What it could get:

- `content.delta`
- `item.started` / `item.completed`
- `request.opened` / `request.resolved`
- `turn.started` / `turn.completed`
- `runtime.error`

The canonical model already exists in `packages/core/src/provider-events.ts`. The dashboard simply cannot access it because the daemon never produces it on the live path.

Pain caused:

- the flagship “chat” view is misleading,
- users cannot distinguish tool actions from model output,
- there is no path to approvals UX without a real event feed.

### Session completion detection is fundamentally improvised

Completion is currently inferred through a mix of:

- a shell-script `curl` callback to `/session-ended`: `packages/daemon/src/orchestrator.ts:145-151`
- tmux absence during reap: `packages/daemon/src/orchestrator.ts:173-193`
- an exit-code marker written into the log file: `packages/daemon/src/orchestrator.ts:29-40`
- later parsing of result JSON from log files: `packages/daemon/src/result-parser.ts:7-133`

That is not clean lifecycle management. It is a collection of heuristics.

Pain caused:

- completion depends on local daemon reachability and a hardcoded HTTP callback path,
- result extraction is backend-specific log scraping,
- the runtime has no canonical “session.exited” event in production,
- cancellation, failure, and successful completion are not unified under one model.

### Relay and push-first architecture do not compose

The relay forwards JSON-RPC requests and responses, keyed by `id`: `packages/relay/src/index.ts:339-520`.

It does not forward daemon push envelopes. `handleNodeMessage()` assumes node messages are RPC responses with an `id` and resolves them against pending RPC requests: `packages/relay/src/index.ts:479-520`.

On top of that, the relay method allowlist excludes approvals, usage, and terminal operations: `packages/relay/src/index.ts:34-38`.

Pain caused:

- remote multi-node architecture does not support the push model the dashboard expects,
- the service contract and relay contract are already diverging,
- some features work daemon-direct but not through relay.

## c) Task Backlog Review

### First: the backlog is not currently reviewable

I cannot honestly evaluate the current P0/P1 issue list because beads is broken in this checkout.

Facts:

- `bd list --status=open -n 60 --json` fails.
- `bd ready --json` fails.
- `bd doctor` reports `database "orka" not found on Dolt server at 127.0.0.1:13572`.
- `bd dolt status` shows the server using `.beads/dolt`, but `dolt sql -q "show databases"` only exposes `dolt`, not `orka`.

So the immediate backlog problem is that the backlog itself is operationally unavailable.

### What that means for prioritization

Any existing P0/P1 prioritization is effectively unverifiable from the repo state. That makes the backlog process unreliable. A broken issue tracker in a repo that explicitly depends on it is not bookkeeping noise. It is a blocker.

### Code-derived judgment on likely good vs bad priorities

Even without ticket visibility, some prioritization calls are obvious from the code.

#### Work that is likely mis-prioritized if it is currently P0/P1

- More dashboard polish before real event wiring.
- More checkpoint features before the orchestration engine is live.
- Approval UX before approval events can actually enter the system.
- Additional provider adapters before deciding whether the provider path is the live path.

That work would be building on a disconnected foundation.

#### Work that is definitely missing or should be elevated

1. Repair beads/backlog access in this repo.
2. Make an explicit architectural decision: tmux/log path vs provider/event path.
3. If provider/event path is the future, wire it into the daemon runtime and stop treating it as optional scaffolding.
4. Persist orchestration events and projections instead of keeping them in memory only.
5. Replace `ChatView` placeholders with real event-driven data.
6. Unify session completion semantics under a single runtime lifecycle model.
7. Make relay support the same contract the daemon exposes, including push if remote dashboard use is part of the plan.

### Dependency judgment

The correct dependency chain is not “UI first, runtime later”. It is the opposite.

The real dependency order is:

1. runtime architecture decision
2. live event production
3. persistence/replay
4. dashboard timeline and approvals
5. relay parity

If the current backlog has those inverted, it is wrong.

## d) Integration Risk Assessment

### Risk level: high

Wiring the dormant subsystems into the live path is not a low-risk refactor. It is a runtime migration with semantic mismatches.

### Main risks

#### Backend behavior mismatch

The live tmux path and the provider adapters are not equivalent backends.

- Live Codex background mode uses `codex exec --json`: `packages/daemon/src/backends.ts:79-96`.
- The dormant Codex adapter uses `codex app-server`: `packages/daemon/src/adapters/codex-adapter.ts:82-152`.
- Live Claude interactive mode is plain `claude`; background is `claude -p --output-format stream-json`: `packages/daemon/src/backends.ts:67-77`.
- The dormant Claude adapter is only `claude -p` style and explicitly does not support multi-turn: `packages/daemon/src/adapters/claude-adapter.ts:156-157`.

These are not interchangeable implementations.

#### State-model mismatch

Core session status includes `queued`, `preparing`, `running`, `completed`, `failed`, `cancelled`: `packages/core/src/types.ts`.

The orchestration engine projection only models `created`, `started`, `running`, `completed`, `failed`: `packages/daemon/src/orchestration/engine.ts:7-17`.

If you make the engine authoritative tomorrow, you immediately lose or distort real statuses, especially `preparing` and `cancelled`.

#### Event-model incompleteness

`mapProviderEvent()` only maps a subset of provider events and currently converts `session.exited` directly to `session.completed`, regardless of exit kind: `packages/daemon/src/orchestration/ingestion.ts`.

That is too lossy to be production truth.

#### Persistence gap

Provider sessions, orchestration events, approvals, and checkpoints are all in memory in the dormant path.

If they are wired live without persistence:

- daemon restarts will drop state,
- reconnects will not reconstruct chat history,
- outstanding approvals will disappear,
- checkpoint history will vanish.

#### Relay incompatibility

The relay is RPC-centric, not push-centric, and its allowlist already lags the service contract.

If the daemon becomes event-driven but the relay remains response-only, remote deployments will diverge further.

### Migration strategy that minimizes damage

Do not do a flag day rewrite.

Safer approach:

1. Keep the current orchestrator path running.
2. Add a shadow event pipeline that emits canonical events from the live tmux/log path first.
3. Compare projected state against current DB status.
4. Persist events before making the dashboard depend on them.
5. Only then consider replacing tmux-specific lifecycle control with provider-managed lifecycle where the backend semantics truly match.

## e) Recommended Execution Order

### 1. Fix beads first

If the team cannot inspect the backlog from the repo, prioritization is broken at the process layer. Repair the tracker before pretending the P0/P1 list is actionable.

### 2. Choose the runtime architecture explicitly

The project needs a hard decision:

- either the tmux/log path remains the core runtime and the provider/event system is deleted or demoted,
- or the provider/event system becomes the runtime and the tmux/log path becomes a compatibility layer.

Continuing to keep both half-alive is the worst option.

### 3. Make the live runtime produce canonical events

Before replacing anything, make the real session lifecycle emit canonical provider/orchestration events. That can be done by adapting the current live path into the canonical model.

This unlocks:

- real chat timeline
- consistent status projection
- checkpoint capture
- approval plumbing

without forcing an immediate backend-process migration.

### 4. Persist event history and session projections

Until events survive restart and reconnect, “push-first” is marketing, not architecture.

### 5. Replace `ChatView` placeholders with real event consumption

Only after step 3 and step 4.

Right now the UI is ahead of the runtime and therefore fake.

### 6. Unify completion detection

Move toward one authoritative completion signal. The current mix of callback, tmux liveness, log markers, and result scraping is too brittle to keep extending.

### 7. Bring relay to contract parity

If relay-backed remote operation matters, it must support the same service and push semantics as the direct daemon path. Right now it does not.

### 8. Then do approvals, terminals, and higher-level UX

Those features make sense only after the runtime contract is stable.

## Final Assessment

The architecture is not fundamentally unsalvageable, but it is currently incoherent.

The biggest issue is not that some features are unfinished. The biggest issue is that the codebase is pretending to be farther along than it is. There is a polished-looking event/provider architecture in the tree, but the product still runs on tmux scripts, log scraping, and manual status broadcasts.

That mismatch is now the main source of risk.

If the team keeps adding features on top of both architectures at once, the codebase will get harder to migrate, not easier. The next correct move is not “more features”. It is choosing the runtime model, making it real, and deleting the lie that the other path is already integrated.
