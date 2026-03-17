# Codex CLI Multi-Turn Research

> Research date: 2026-03-17
> Codex version: codex-cli 0.114.0 (Rust)
> Binary: /home/ilyagulya/.bun/bin/codex

## Executive Summary

Codex has **two distinct multi-turn mechanisms**, both fully functional:

1. **`codex exec resume <thread-id> "new prompt"`** — CLI-level resume for `codex exec` sessions. Loads session from disk by thread UUID, sends a new turn, outputs JSONL, exits. Suitable for stateless orchestration.

2. **`codex app-server`** — JSON-RPC 2.0 server over stdio or WebSocket. Full multi-turn via `thread/start` + repeated `turn/start` calls on the same thread. This is what the VSCode extension uses. **Our CodexAdapter already uses this mode.**

The app-server approach is strictly superior for Orka because the process stays alive, context is maintained in-memory, and we get structured JSON-RPC events including approval requests, tool call details, and token usage.

---

## 1. Codex Subcommands

### Top-level commands
| Command | Purpose |
|---------|---------|
| `codex [PROMPT]` | Interactive TUI session |
| `codex exec [PROMPT]` | Non-interactive headless execution |
| `codex exec resume <ID> [PROMPT]` | Resume a previous exec session with new prompt |
| `codex resume [ID] [PROMPT]` | Resume interactive TUI session |
| `codex fork [ID] [PROMPT]` | Fork interactive session (new branch of conversation) |
| `codex review` | Non-interactive code review |
| `codex app-server` | JSON-RPC server (stdio or WebSocket) |
| `codex mcp-server` | MCP server over stdio |
| `codex login/logout` | Auth management |
| `codex mcp` | Manage external MCP servers |
| `codex apply` | Apply last diff as `git apply` |
| `codex sandbox` | Run commands in Codex sandbox |
| `codex debug app-server` | Debug tooling for app-server |
| `codex features list` | List feature flags |
| `codex cloud` | Browse Codex Cloud tasks |
| `codex completion` | Shell completions |

### Key flags on `codex exec`
- `--json` — JSONL event output to stdout
- `--dangerously-bypass-approvals-and-sandbox` — full auto mode
- `--full-auto` — sandbox workspace-write + on-request approval
- `--ephemeral` — don't persist session to disk
- `--output-schema <FILE>` — constrain final response to JSON Schema
- `-o, --output-last-message <FILE>` — write last agent message to file
- `--skip-git-repo-check` — allow running outside git repo

---

## 2. Codex exec --json JSONL Format

When running `codex exec --json`, the output is **NOT** the app-server JSON-RPC protocol. It's a simplified event stream:

```jsonl
{"type":"thread.started","thread_id":"019cfc57-4e03-7273-9757-ed376cb30811"}
{"type":"turn.started"}
{"type":"agent_message","message":"...","phase":"commentary"}
{"type":"exec_command_begin","command":"...","workdir":"..."}
{"type":"exec_command_output_delta","stream":"stdout","delta":"..."}
{"type":"exec_command_end","exit_code":0}
{"type":"agent_message","message":"...","phase":"final"}
{"type":"token_count","info":{...},"rate_limits":{...}}
{"type":"turn.completed","turn_id":"...","last_agent_message":"..."}
{"type":"turn.failed","error":{"message":"..."}}
```

Key observations:
- `thread.started` includes the `thread_id` (UUID v7)
- `turn.completed` includes `last_agent_message` (the final text)
- `token_count` includes usage info and rate limits
- Error events: `turn.failed` with error message

---

## 3. Codex exec resume

### CLI usage
```bash
codex exec resume <SESSION_ID> "new prompt" --json
codex exec resume --last "new prompt" --json
```

### How it works
- SESSION_ID is a UUID (thread ID) or thread name
- `--last` picks the most recent session
- `--all` shows all sessions (disables cwd filtering)
- Accepts a new prompt as second positional arg or via stdin (`-`)
- Supports all exec flags (`--json`, `--full-auto`, etc.)

### Session storage
Sessions are stored as rollout JSONL files:
```
~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<UUID>.jsonl
```

Each rollout file contains the full event history including:
- `session_meta` — session metadata (id, timestamp, cwd, model, base instructions, git info)
- `response_item` — conversation items (user messages, assistant messages, function calls, function outputs)
- `event_msg` — runtime events (task_started, task_complete, agent_message, exec_command_*, token_count)
- `turn_context` — per-turn configuration (approval policy, sandbox, model, personality, effort)

### Session ID in JSONL output
The `thread.started` event in `--json` output provides the `thread_id`:
```json
{"type":"thread.started","thread_id":"019cfc57-4e03-7273-9757-ed376cb30811"}
```

### State persistence via SQLite
Codex also persists state to `~/.codex/state_5.sqlite` and logs to `~/.codex/logs_1.sqlite`.

---

## 4. App-Server Mode (What Our CodexAdapter Uses)

### Transport
```bash
codex app-server                          # stdio (default)
codex app-server --listen ws://0.0.0.0:8080  # WebSocket
```

### Protocol: JSON-RPC 2.0

The app-server uses a full JSON-RPC 2.0 protocol with:

**Client → Server requests:**

| Method | Purpose |
|--------|---------|
| `initialize` | Handshake with capabilities negotiation |
| `thread/start` | Create a new thread (returns thread ID) |
| `thread/resume` | Resume existing thread by ID, path, or history |
| `thread/fork` | Fork a thread at a specific point |
| `thread/list` | List available threads |
| `thread/read` | Read thread state |
| `thread/archive` | Archive thread |
| `thread/unarchive` | Unarchive thread |
| `thread/unsubscribe` | Stop receiving events for thread |
| `thread/compact/start` | Trigger context compaction |
| `thread/rollback` | Rollback to previous turn |
| `thread/name/set` | Set thread name |
| `thread/metadata/update` | Update thread metadata |
| `thread/backgroundTerminals/clean` | Clean up background terminals |
| `turn/start` | Start a new turn in a thread |
| `turn/interrupt` | Interrupt current turn |
| `turn/steer` | Send additional input during an active turn |
| `model/list` | List available models |
| `config/read` | Read configuration |
| `config/value/write` | Write configuration value |
| `skills/list` | List available skills |
| `review/start` | Start code review |
| `command/exec` | Execute shell command |
| `command/exec/write` | Write to command stdin |
| `command/exec/terminate` | Terminate command |
| `thread/realtime/start` | Start realtime (voice) session |
| `thread/realtime/appendAudio` | Send audio frames |
| `thread/realtime/appendText` | Send text in realtime |
| `thread/realtime/stop` | Stop realtime session |

**Server → Client notifications:**

| Method | Purpose |
|--------|---------|
| `thread/started` | Thread created |
| `thread/status/changed` | Thread status changed |
| `thread/closed` | Thread closed |
| `turn/started` | Turn started |
| `turn/completed` | Turn completed |
| `item/agentMessage/delta` | Streaming agent message |
| `item/commandExecution/outputDelta` | Command output streaming |
| `item/fileChange/outputDelta` | File change streaming |
| `item/started` | Item started |
| `item/completed` | Item completed |
| `thread/tokenUsage/updated` | Token usage update |
| `thread/name/updated` | Thread name changed |
| `thread/compacted` | Context was compacted |
| `model/rerouted` | Model was rerouted |

**Server → Client requests (approval flow):**

| Method | Purpose |
|--------|---------|
| `item/commandExecution/requestApproval` | Ask to approve command execution |
| `item/fileChange/requestApproval` | Ask to approve file change |
| `item/tool/requestUserInput` | Ask user for input |
| `item/permissions/requestApproval` | Ask to approve permissions |
| `item/tool/call` | Dynamic tool call |
| `applyPatchApproval` | Approve patch application |
| `execCommandApproval` | Approve command execution (legacy) |

### Multi-turn flow in app-server

```
Client                              Server
  |                                    |
  |-- initialize ---------------------->|
  |<-- {userAgent} --------------------|
  |-- initialized (notification) ------>|
  |                                    |
  |-- thread/start -------------------->|
  |<-- {thread: {id: "UUID"}} ---------|
  |                                    |
  |-- turn/start {threadId, input} ---->|
  |<-- turn/started (notification) ----|
  |<-- item/agentMessage/delta --------|  (streaming)
  |<-- item/commandExecution/* --------|  (tool use)
  |<-- turn/completed (notification) --|
  |                                    |
  |  (user sends another turn)        |
  |-- turn/start {threadId, input} ---->|
  |<-- turn/started -------------------|
  |<-- ... (events) -------------------|
  |<-- turn/completed -----------------|
  |                                    |
  |-- thread/unsubscribe -------------->|
```

### Key types

**ThreadStartParams:**
```typescript
{
  model?: string,
  modelProvider?: string,
  cwd?: string,
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never",
  sandbox?: "read-only" | "workspace-write" | "danger-full-access",
  baseInstructions?: string,
  developerInstructions?: string,
  ephemeral?: boolean,
  experimentalRawEvents: boolean,
  persistExtendedHistory: boolean,
}
```

**TurnStartParams:**
```typescript
{
  threadId: string,
  input: Array<UserInput>,
  cwd?: string,
  approvalPolicy?: AskForApproval,
  model?: string,
  effort?: "low" | "medium" | "high",
  outputSchema?: JsonValue,
  collaborationMode?: CollaborationMode,
}
```

**UserInput:**
```typescript
{ type: "text", text: string, text_elements: [] }
| { type: "image", url: string }
| { type: "localImage", path: string }
| { type: "skill", name: string, path: string }
| { type: "mention", name: string, path: string }
```

**TurnSteerParams** (mid-turn injection):
```typescript
{
  threadId: string,
  input: Array<UserInput>,
  expectedTurnId: string,  // must match active turn
}
```

**ThreadResumeParams:**
```typescript
{
  threadId: string,
  history?: Array<ResponseItem>,  // UNSTABLE - Codex Cloud only
  path?: string,                  // UNSTABLE - resume by rollout path
  model?: string,
  cwd?: string,
  approvalPolicy?: string,
  sandbox?: string,
  persistExtendedHistory: boolean,
}
```

---

## 5. Our Current CodexAdapter Implementation

Location: `packages/daemon/src/adapters/codex-adapter.ts`

**What it already does:**
- Spawns `codex --model <model> --dangerously-bypass-approvals-and-sandbox app-server`
- Communicates via stdio JSON-RPC
- Sends `initialize` → `initialized` → `thread/start` → `turn/start`
- Handles multi-turn via `sendTurn()` method which calls `turn/start` on existing thread
- Handles `turn/interrupt` for stopping active turns
- Handles `thread/unsubscribe` for graceful shutdown
- Maps all server notifications to Orka's `ProviderRuntimeEvent` types
- Handles server requests (approval flows) with `respondToRequest()`
- Tracks `providerThreadId`, `activeTurnId`, token usage per turn
- Supports interactive mode (process stays alive between turns)

**Multi-turn is already implemented at the adapter level:**
1. `startSession()` creates the app-server process and thread
2. `sendTurn()` calls `turn/start` with new input on the same thread
3. `interruptTurn()` calls `turn/interrupt`
4. `stopSession()` calls `thread/unsubscribe` and kills process

**What the adapter does NOT yet support:**
- `thread/resume` for resuming across process restarts (cold resume)
- `turn/steer` for injecting input mid-turn
- `thread/fork` for branching conversations
- `thread/compact/start` for explicit context compaction
- `thread/rollback` for undoing turns
- Persisting thread history for cross-process resume (`persistExtendedHistory: false, ephemeral: true`)

---

## 6. Feature Flags

Notable flags from `codex features list`:
- `multi_agent` (experimental) — multi-agent collaboration
- `collaboration_modes` (removed but true) — different interaction modes
- `steer` (removed but true) — mid-turn steering
- `memories` (under development) — persistent memory
- `realtime_conversation` (under development) — voice/realtime
- `fast_mode` (stable, true) — faster output mode
- `undo` (stable, false) — undo capability
- `shell_tool` (stable, true) — shell execution
- `unified_exec` (stable, true) — unified execution path

---

## 7. Codex exec vs App-Server: Comparison

| Feature | `codex exec` | `codex app-server` |
|---------|-------------|-------------------|
| Transport | Process per turn | Long-lived process |
| Multi-turn | `exec resume` (new process per turn) | `turn/start` (same process) |
| Protocol | Simplified JSONL events | Full JSON-RPC 2.0 |
| Context | Loaded from disk per turn | In-memory, persistent |
| Approval flow | None (always auto) | Full request/response cycle |
| Latency per turn | High (process spawn + disk load) | Low (in-memory) |
| IDE integration | No | Yes (VSCode extension) |
| Thread management | Implicit | Explicit (start/resume/fork) |

---

## 8. Comparison with Claude Code Multi-Turn

| Capability | Claude Code (Agent SDK) | Codex (app-server) |
|------------|------------------------|---------------------|
| Multi-turn in-process | `query()` AsyncGenerator | `turn/start` JSON-RPC |
| Resume across restarts | `resume: sessionId` option | `thread/resume` by ID or path |
| Mid-turn injection | Write to stdin | `turn/steer` RPC |
| Fork conversation | Not supported | `thread/fork` |
| Rollback | Not supported | `thread/rollback` |
| Context compaction | Automatic | `thread/compact/start` or automatic |
| Approval flow | Via stdin messages | Server→Client requests |
| Protocol | stream-json over stdio | JSON-RPC 2.0 over stdio/WS |
| Process model | Spawn per session | Long-lived server |

---

## 9. Recommended Approach for Unified Multi-Turn

### Current state (already works)
Our CodexAdapter already supports multi-turn via app-server:
1. `startSession()` → spawns `codex app-server`, creates thread
2. `sendTurn()` → sends `turn/start` on existing thread
3. Session stays alive between turns (interactive mode)

### What needs to change for unified model

**Warm multi-turn (process alive, "interactive" mode):**
- Already works. `sendTurn()` sends `turn/start` to the running app-server.
- The `CodexSessionProjection` already tracks `isInteractive` and prevents auto-unsubscribe.
- Orchestrator's `continueSession()` needs to route to `sendTurn()` for Codex sessions.

**Cold resume (hibernate/wake, process restart):**
- Option A: Use `codex exec resume <threadId> "prompt" --json` (new process per turn, simpler but slower)
- Option B: Spawn new `codex app-server`, use `thread/resume { threadId }` to reload from disk (faster, keeps app-server benefits)
- **Recommendation: Option B** — it preserves the rich JSON-RPC protocol and approval flow.
- Requires: Set `persistExtendedHistory: true` and `ephemeral: false` in `thread/start` so sessions survive restarts.

**`turn/steer` for mid-turn input:**
- The protocol supports `turn/steer` for injecting input during an active turn.
- Useful for `orka send` to a session that's currently processing.
- The `expectedTurnId` field prevents races.

### Implementation priority
1. **Enable warm multi-turn** — Wire `continueSession()` → `codex.sendTurn()` in orchestrator (small change)
2. **Store providerThreadId** — Persist in session record for cold resume
3. **Set non-ephemeral mode** — Change `ephemeral: false, persistExtendedHistory: true` in thread/start
4. **Implement cold resume** — Spawn new app-server, call `thread/resume { threadId }`, then `turn/start`
5. **Expose turn/steer** — For `orka send` during active turns

### Codex exec resume as fallback
For the simplest possible cold resume (no app-server persistence needed):
```bash
codex exec resume <threadId> "new prompt" --json --dangerously-bypass-approvals-and-sandbox
```
This works but loses the app-server benefits (approval flow, structured events, lower latency).

---

## 10. Appendix: Session Rollout File Format

Each session is persisted at `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<UUID>.jsonl`

Line types:
```
session_meta      — session ID, cwd, model, base_instructions, git info
response_item     — conversation items (messages, function calls, outputs)
event_msg         — runtime events (task_started, task_complete, agent_message, etc.)
turn_context      — per-turn config snapshot (approval, sandbox, model, effort)
```

The `session_meta.payload.id` is the UUID used for `exec resume` and `thread/resume`.

---

## 11. Appendix: App-Server Schema Generation

```bash
# Generate full JSON Schema (with experimental fields)
codex app-server generate-json-schema --out /path/to/schema --experimental

# Generate TypeScript bindings
codex app-server generate-ts --out /path/to/ts --experimental
```

This is how the types in this document were derived. Schemas are available at:
- `/tmp/codex-research/schema/` — JSON Schema files
- `/tmp/codex-research/ts/` — TypeScript type definitions
