# Provider Migration Plan

Verified on 2026-03-11 by reading the live daemon path, the dormant provider runtime, the related tests, and the local CLIs:

- `codex app-server --help` reports `stdio://` as the default transport and `ws://IP:PORT` as an optional transport.
- `codex app-server` accepted line-delimited JSON-RPC-style requests over stdio in a live probe.
- `codex app-server generate-json-schema --out <dir>` and `generate-ts --out <dir>` show the actual request/notification surface.
- `codex exec --help` and `claude --help` were used to verify the live CLI flags.

## a) Adapter gap analysis

### Cross-cutting gap before individual adapters

`ProviderSessionStartInput` and `ProviderSendTurnInput` are too small for production parity with the live path. They currently carry `threadId`, `cwd`, `model`, and prompt/input text, but the live path also needs or already uses:

- Orka session identity vs provider-native thread identity
- reasoning effort
- approval/sandbox policy
- log/output persistence
- session completion semantics

That interface gap shows up most clearly in the Codex adapter.

### `claude-code`

Live tmux path today:

- Command built in [packages/daemon/src/backends.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/backends.ts): `claude --model <model>? --append-system-prompt "[orka session: <id>]" -p --verbose --output-format stream-json --permission-mode auto <prompt>`
- Wrapped with tee-to-log and a completion callback in [packages/daemon/src/orchestrator.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestrator.ts)

Adapter today:

- Command in [packages/daemon/src/adapters/claude-adapter.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/adapters/claude-adapter.ts): `claude -p --verbose --output-format stream-json --permission-mode auto [--model ...]`
- Prompt is written to stdin, then stdin is closed

Equivalent or working:

- The non-interactive Claude mode is the right one. The adapter uses the same core CLI mode as the live path.
- Event mapping for `system/init`, assistant text, tool use, and `result` is covered by [packages/daemon/src/adapters/claude-adapter.test.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/adapters/claude-adapter.test.ts).
- Single-turn lifecycle is plausible because `claude -p` naturally exits after the prompt finishes.

Missing or incorrect relative to the live path:

- No `--append-system-prompt "[orka session: <id>]"`, so the live path's explicit Orka session context is lost.
- No log tee, no log file, no result-compatible output persistence.
- No worktree/DB/session-status integration.
- No push integration.
- `sendTurn()` is intentionally unsupported, which is fine for one-shot background sessions but not for a general multi-turn provider API.
- The adapter emits `content.delta` and `turn.completed` without a `turnId`; [packages/daemon/src/orchestration/ingestion.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestration/ingestion.ts) assumes `turnId!`, so the current Claude path would feed undefined turn ids into the orchestration layer.
- Claude CLI supports `--effort`, but neither the live path nor the adapter passes it today. That is parity with current Orka behavior, not an adapter-only bug.

### `codex`

Live tmux path today:

- Command built in [packages/daemon/src/backends.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/backends.ts): `codex exec --dangerously-bypass-approvals-and-sandbox --json --skip-git-repo-check [--model ...] [--config model_reasoning_effort=...] <prompt>`
- Wrapped with tee-to-log and completion callback in [packages/daemon/src/orchestrator.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestrator.ts)
- This is a one-shot execution model, not a persistent thread/turn protocol

Adapter today:

- Starts `codex app-server` in [packages/daemon/src/adapters/codex-adapter.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/adapters/codex-adapter.ts)
- Sends JSON objects with methods `startSession`, `sendMessage`, `interrupt`, and `stop`
- Expects top-level events with `raw.type` values like `session.started`, `message.delta`, `turn.completed`, and `session.ended`

What live verification found:

- `codex app-server` is real.
- It uses stdio by default and can also listen on websocket.
- It accepted a live `initialize` request over stdio and returned a response.
- The generated protocol and live probe both show actual client requests such as `initialize`, `thread/start`, `turn/start`, `turn/interrupt`, and `thread/unsubscribe`.
- A live `turn/start` probe emitted structured notifications like `thread/status/changed`, `turn/started`, `item/started`, `item/completed`, `error`, and `turn/completed`.
- The same probe also emitted legacy `codex/event/...` notifications in parallel, so duplicate streams are a real concern.

What works:

- Choosing `codex app-server` is directionally correct if Orka wants a provider runtime instead of `codex exec`.
- The real app-server protocol can express model, cwd, sandbox, approval policy, reasoning effort, thread lifecycle, turn lifecycle, approvals, and token usage.

What is broken today:

- Request methods are wrong. `startSession`, `sendMessage`, `interrupt`, and `stop` do not match the real protocol.
- No `initialize` handshake is performed.
- The adapter conflates Orka `threadId` with the provider's real thread id. The real `thread/start` response generates the provider thread id; it is not supplied by the client.
- The adapter tries to pass the initial prompt during session start, but the real protocol separates `thread/start` from `turn/start`.
- Event parsing is wrong. The real app-server emits JSON-RPC notifications with `{ method, params }`, not top-level `{ type, ... }` events.
- `stopSession()` is wrong. The generated protocol does not expose a `stop` request matching the adapter's assumption.
- Completion detection is wrong. The adapter only treats subprocess exit as session end, but the real app-server stays alive after a turn completes. In a live probe, a failed turn emitted `turn/completed` and the app-server process remained running.
- Usage mapping is wrong. The adapter looks for `turn.completed.usage`; the real protocol exposes token usage via `thread/tokenUsage/updated`.
- Approval handling is missing even though the protocol exposes server requests such as `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, and `item/tool/requestUserInput`.
- No log tee, no log file, no result-compatible output persistence.
- No DB/worktree/push integration.

### `shell`

Live tmux path today:

- The live shell backend is just the raw prompt command from [packages/daemon/src/backends.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/backends.ts), wrapped with tee-to-log and the completion callback
- The shell session exits when that command exits

Adapter today:

- Still uses `SessionRunner`/tmux in [packages/daemon/src/adapters/shell-adapter.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/adapters/shell-adapter.ts)
- Writes a script containing the initial command and then `exec "${SHELL:-/bin/bash}" -i`
- Polls tmux every 500 ms and diffs captured output to emit `content.delta`

What works:

- It can drive an interactive shell session through the existing runner.
- `sendTurn()` and `interruptTurn()` are implemented.
- [packages/daemon/src/adapters/shell-adapter.test.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/adapters/shell-adapter.test.ts) covers start, stop, output, and interrupt behavior.

What is not equivalent to the live path:

- It still depends on tmux, so it does not replace the tmux path.
- It does not create a log file or tee output anywhere.
- It does not report exit codes.
- It does not integrate with DB, worktrees, or push.
- It does not auto-complete one-shot sessions because it opens an interactive shell after the initial command. That is a semantic mismatch with the live shell backend.
- Output capture is polling-based and bounded by the tmux capture window (`CAPTURE_LINES = 1000`), so large bursts can be dropped.

## b) Integration gap analysis

### What `spawnSession()` does today that the adapter stack does not

`spawnSession()` in [packages/daemon/src/orchestrator.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestrator.ts) currently owns all of this:

- backend installation check
- concurrent-session limit enforcement
- task id/session id/workspace id creation
- task DB insert
- worktree creation for branch/background sessions
- session DB insert
- tag persistence
- log-file path creation
- backend command construction
- script-file creation
- tmux spawn
- transition from `preparing` to `running`

The provider stack currently does none of those. [packages/daemon/src/provider-service.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/provider-service.ts) only starts an adapter and keeps the returned handle in memory.

### Worktree management, DB records, and log files

Current ownership:

- worktrees: [packages/daemon/src/orchestrator.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestrator.ts)
- DB task/session/tag/diff/usage records: [packages/daemon/src/orchestrator.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestrator.ts), [packages/daemon/src/local-client.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/local-client.ts), [packages/daemon/src/db.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/db.ts)
- log files and log streaming: [packages/daemon/src/backends.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/backends.ts), [packages/daemon/src/log-tailer.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/log-tailer.ts)

Provider stack today:

- no DB writes
- no worktree lifecycle
- no log files
- no result parsing path
- no durable usage persistence

So the adapter system cannot replace the live path just by swapping process launch. The live path's persistence and workspace responsibilities have to stay somewhere.

### Event consumer loop

This is the biggest missing runtime piece.

The adapters expose `AsyncIterable<ProviderRuntimeEvent>`, but nowhere in the daemon does code do:

```ts
for await (const event of handle.events) {
  // consume event
}
```

Search confirmed there is no consumer loop outside tests. That means:

- adapters can emit events
- the engine can ingest events
- but nothing connects them

That consumer needs to be started from the live session spawn path, not from tests. It should be responsible for:

- feeding `OrchestrationEngine`
- updating session status in the DB
- storing output/result-compatible data
- forwarding approval requests into `ApprovalManager`
- broadcasting push updates
- triggering completion/cleanup

### Session completion

Live path today:

- the generated script calls `/session-ended?id=<sessionId>&exitCode=$_ORKA_EXIT`
- [packages/daemon/src/server.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/server.ts) ignores the query `exitCode` and simply calls `svc.reap()`
- `reapSessions()` decides completion by checking whether the tmux session is gone and then parsing `[orka] exit_code=...` from the log

Important verified detail:

- the tee wrapper in [packages/daemon/src/backends.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/backends.ts) does not currently preserve the backend command's exit status; a shell reproduction wrote `[orka] exit_code=0` for a failing command

So the live path's current completion path is:

- tmux disappearance is real
- completion callback is real
- exit-code fidelity is weaker than intended

Provider stack needs a different completion model:

- Claude can use provider-process exit plus mapped `result`
- Codex app-server must use protocol events (`turn/completed`, `thread/status/changed`, errors) rather than subprocess exit
- Shell must either become one-shot or remain non-production for background sessions

### Query/API compatibility gaps

Several existing RPC-facing methods in [packages/daemon/src/local-client.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/local-client.ts) assume tmux or log files:

- `captureOutput()`
- `getLogContent()`
- `getResult()`
- `getUsage()` persistence flow
- `isAlive()`
- `sendInput()`

If provider sessions do not create compatible logs or a structured event store, those APIs regress immediately.

## c) OrchestrationEngine gaps

### State model alignment

`OrchestrationEngine` in [packages/daemon/src/orchestration/engine.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestration/engine.ts) uses:

- `created`
- `started`
- `running`
- `completed`
- `failed`

Core `SessionStatus` in [packages/core/src/types.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/core/src/types.ts) uses:

- `queued`
- `preparing`
- `running`
- `completed`
- `failed`
- `cancelled`

Current mismatches:

- engine has `created` and `started`, which are not core statuses
- engine has no `preparing`
- engine has no `cancelled`
- engine defaults to `created` even when no DB session exists

### Event persistence

Persistence is currently in-memory only:

- provider handles in [packages/daemon/src/provider-service.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/provider-service.ts)
- orchestration log in [packages/daemon/src/orchestration/engine.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestration/engine.ts)
- checkpoints in [packages/daemon/src/orchestration/checkpoint.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestration/checkpoint.ts)

That is fine for dormant code and tests. It is not production-grade for daemon restarts or post-hoc result queries.

### Ingestion completeness and correctness

[packages/daemon/src/orchestration/ingestion.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestration/ingestion.ts) currently maps only a small subset of provider events:

- `session.started`
- `turn.started`
- `content.delta`
- `turn.completed`
- `session.exited`
- `request.opened`
- `request.resolved`

Gaps:

- ignores `session.state.changed`
- ignores `turn.aborted`
- ignores `item.started` / `item.updated` / `item.completed`
- ignores `tool.progress`
- ignores `runtime.error` / `runtime.warning`
- ignores reasoning streams
- ignores structured token-usage updates
- ignores provider approval request details beyond the generic request-opened shape

Incorrectness:

- `session.exited` always maps to `session.completed` with `exitCode: null`, even when the provider says the exit was an error
- `content.delta` and `turn.completed` use `event.turnId!`; that is unsafe with the current Claude mapping and with the current Codex adapter

### Push integration

`OrchestrationEngine` can already broadcast:

- `orchestration.event`
- `orchestration.sessionUpdated`

via [packages/daemon/src/push-hub.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/push-hub.ts), but in the live daemon path:

- no engine instance is created
- no provider-event consumer exists
- `pushHub` only sees spawn/stop/reap updates and log tail output

So push support exists in pieces, but not in the actual runtime path.

### Checkpoint reactor

`CheckpointReactor` is also dormant because it only listens to engine events. Even if wired in, `CheckpointService` currently stores only in-memory commit-based checkpoints. If production rollout expects checkpoints to survive restart or reflect uncommitted file changes, more work is needed.

## d) Concrete step-by-step migration plan

1. Extend the provider contract in [packages/core/src/provider-adapter.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/core/src/provider-adapter.ts).
   What to change:
   - Stop using `threadId` as the only identity field. Keep Orka session id separate from provider-native thread id.
   - Add the runtime inputs the real adapters need: reasoning effort, approval policy, sandbox policy, and possibly session context/developer instructions.
   - Keep the provider handle's `meta` for provider-specific ids, but make the Orka-facing id explicit.

2. Rewrite the Codex adapter in [packages/daemon/src/adapters/codex-adapter.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/adapters/codex-adapter.ts) to the real app-server protocol.
   What to change:
   - Implement `initialize` and any required post-initialize notification.
   - Use `thread/start` to create the provider thread.
   - Use `turn/start` for the prompt.
   - Use `turn/interrupt` for cancellation.
   - Use `thread/unsubscribe` and/or process shutdown for cleanup instead of the nonexistent `stop` RPC.
   - Parse JSON-RPC responses, notifications, and server requests.
   - Either opt out of legacy `codex/event/...` notifications at initialize time or ignore/dedupe them.
   - Store provider thread id and active turn id in `handle.meta`.

3. Add proper Codex event mapping in [packages/daemon/src/adapters/codex-adapter.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/adapters/codex-adapter.ts).
   What to change:
   - Map `thread/status/changed`, `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `item/reasoning/textDelta`, `thread/tokenUsage/updated`, `error`, and approval server requests into canonical provider events.
   - Translate failed turns into canonical failure events, not only session exit.

4. Bring the Claude adapter to live-path parity in [packages/daemon/src/adapters/claude-adapter.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/adapters/claude-adapter.ts).
   What to change:
   - Add `--append-system-prompt "[orka session: <id>]"`.
   - Emit stable turn ids so ingestion does not depend on undefined `turnId`.
   - Keep it single-turn unless Orka wants to expand the contract.

5. Decide whether the shell adapter is in scope for production replacement and then change [packages/daemon/src/adapters/shell-adapter.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/adapters/shell-adapter.ts) accordingly.
   What to change:
   - If shell is meant to replace the one-shot live shell backend, remove the trailing interactive shell and emit completion/exit status.
   - If shell is only for interactive terminal sessions, do not route background `spawnSession()` through it.

6. Add a provider-event consumer loop in a new module, for example [packages/daemon/src/orchestration/consumer.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestration/consumer.ts), or inside [packages/daemon/src/provider-service.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/provider-service.ts).
   What to change:
   - Start one consumer task per spawned provider session.
   - For each event, update DB state, ingest into the engine, write output persistence, update approvals, and broadcast push events.
   - Handle terminal events exactly once and then clean up the provider handle.

7. Keep orchestration ownership in [packages/daemon/src/orchestrator.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestrator.ts), but add a provider-backed execution branch.
   What to change:
   - Preserve current task/session/tag/worktree/concurrency responsibilities there.
   - After DB/session creation, dispatch either to the legacy tmux backend or the provider runtime based on a feature flag/config.
   - For provider sessions, mark `running` after the adapter starts and the consumer loop is launched.
   - Keep auto-merge and worktree cleanup in the orchestrator layer, not in adapters.

8. Add provider-runtime persistence in [packages/daemon/src/db.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/db.ts).
   What to change:
   - Add migration(s) for provider metadata such as provider thread id, active turn id, and last runtime error.
   - Add either a structured event table or a compatibility log/event blob so `getResult`, `captureOutput`, and `getLogContent` remain meaningful.

9. Update result/output readers in [packages/daemon/src/local-client.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/local-client.ts) and [packages/daemon/src/result-parser.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/result-parser.ts).
   What to change:
   - Stop assuming every session has a tmux capture or a legacy log file.
   - Either teach `result-parser.ts` to understand persisted provider events or add a new provider-result reader.
   - Make `captureOutput()` and `getLogContent()` work from structured persisted output when tmux/logs are absent.

10. Wire the runtime into [packages/daemon/src/local-client.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/local-client.ts).
    What to change:
    - Instantiate `ProviderAdapterRegistry`, register Claude/Codex/Shell adapters, create `ProviderService`, create `OrchestrationEngine`, and attach `CheckpointReactor`.
    - Route `spawn`, `stop`, `isAlive`, `sendInput`, `getPendingApprovals`, and `resolveApproval` to the provider runtime for provider-backed sessions.
    - Leave legacy behavior intact for sessions still using tmux during rollout.

11. Wire push integration in [packages/daemon/src/server.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/server.ts) and [packages/daemon/src/orchestration/engine.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestration/engine.ts).
    What to change:
    - Construct the engine with `pushHub`.
    - Keep `/session-ended` for legacy sessions only.
    - Decide whether `session.logLine` stays legacy-only or whether provider output should also be mirrored there.

12. Fix ingestion/projection in [packages/daemon/src/orchestration/ingestion.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestration/ingestion.ts) and [packages/daemon/src/orchestration/engine.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestration/engine.ts).
    What to change:
    - Align projection status values with core `SessionStatus`.
    - Add mappings for runtime errors, turn aborts, item lifecycle, reasoning, approvals, and token usage.
    - Map error exits to `failed` and user stops to `cancelled`.

13. Add a rollout flag in [packages/daemon/src/config.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/config.ts).
    What to change:
    - Add a config field such as `providers.use_runtime` or similar.
    - Default it off.
    - Allow per-backend rollout if possible, because Claude is much closer than Codex and Shell.

14. Expand tests.
    Files to add/change:
    - [packages/daemon/src/adapters/codex-adapter.test.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/adapters/codex-adapter.test.ts): replace the current fictional protocol fixtures with real app-server method/notification fixtures derived from `generate-ts` output.
    - [packages/daemon/src/adapters/claude-adapter.test.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/adapters/claude-adapter.test.ts): add turn-id and session-context coverage.
    - [packages/daemon/src/orchestration/engine.test.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestration/engine.test.ts): align status expectations with core statuses.
    - Add end-to-end daemon tests that verify spawn, completion, stop, approval round-trip, push events, result retrieval, worktree cleanup, and auto-merge under the provider runtime.

## e) Risk assessment

### Main risks

- Codex protocol mismatch: if the adapter keeps the current fictional RPC/event assumptions, Codex sessions will start incorrectly or never complete.
- Duplicate event streams from app-server: the live probe showed both legacy `codex/event/...` and structured notifications. Without filtering or dedupe, Orka will double-ingest events.
- Query/API regressions: `getResult`, `captureOutput`, `getLogContent`, and usage reporting all currently depend on legacy log/tmux assumptions.
- Daemon-restart durability: the provider runtime is currently memory-only. Inference: direct `Bun.spawn` children plus in-memory handles do not provide the same recovery story as tmux-backed sessions.
- Completion bugs: Codex completion must be based on turn/thread events, not provider subprocess exit.
- Shell session hangs: the current shell adapter is not one-shot and can keep sessions alive forever.
- Approval handling: Codex app-server supports approvals, but the current runtime has no wiring between provider server requests and `ApprovalManager`.
- Push regressions: `orchestration.event` exists in the protocol but is currently dormant; if partially wired, clients may see inconsistent state transitions.

### Rollback plan

- Keep the legacy tmux/log/reap path in [packages/daemon/src/orchestrator.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/orchestrator.ts) during rollout.
- Add a config flag in [packages/daemon/src/config.ts](/home/ilyagulya/.orka/worktrees/sess-9cc093df/packages/daemon/src/config.ts) and default it off.
- Roll out backend by backend:
  - Claude first
  - Codex only after the protocol rewrite and approval flow are correct
  - Shell only after deciding whether it is interactive-only or truly replacing one-shot shell sessions
- Leave `/session-ended` and legacy log tailing in place until provider-backed sessions have equivalent status, output, and result behavior.

### What should be tested before flipping the flag

- spawn -> running -> completed for successful Claude and Codex sessions
- spawn -> failed for provider/runtime errors
- user stop -> cancelled
- worktree creation and cleanup
- auto-merge on successful sessions
- `getResult`, `getUsage`, `captureOutput`, and `getLogContent`
- approval request open/resolve flow for Codex
- push channels: `orchestration.sessionUpdated`, `orchestration.event`, and any compatibility `session.logLine` behavior
- duplicate-notification suppression for Codex app-server
- daemon restart behavior, or an explicit documented limitation if restart survival is not supported

## Notes on existing tests

The existing adapter/provider/orchestration tests are mostly mapper/unit tests. A local run of:

- `bun test packages/daemon/src/adapters/claude-adapter.test.ts ...`

did not run in this worktree because dependencies such as `@opentelemetry/api` and `zod/v4` were missing from the test environment. That does not change the code analysis above, but it means the dormant stack does not currently have a verified green test run in this workspace.
