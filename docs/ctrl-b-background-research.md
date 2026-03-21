# Claude Code Ctrl+B "Push to Background" — Protocol Research

**Date:** 2026-03-21
**Claude Code version analyzed:** 2.1.81
**Claude Agent SDK version:** 0.2.81

## Summary

Ctrl+B is a **TUI-only feature** implemented in Claude Code's React/Ink terminal renderer. There is **no stream-json protocol message** to trigger "push to background". However, background tasks ARE visible in the stream-json output, and there are **indirect ways** to achieve similar functionality.

---

## How Ctrl+B Works Internally

### Key Binding Registration

The key binding is registered in the default binding table:

```js
{ context: "Task", bindings: { "ctrl+b": "task:background" } }
```

The action name is `"task:background"`. It's registered via a `useInput`-like hook (`W1()`) in the React/Ink TUI components.

**tmux awareness:** When `$TERM` indicates tmux, the UI shows "ctrl+b ctrl+b (twice)" since Ctrl+B is tmux's prefix key.

### What Ctrl+B Does

When pressed, it calls `My8()` which backgrounds ALL running foreground tasks:

```js
function My8(getState, dispatch) {
  let state = getState();

  // Background all non-backgrounded bash tasks with shell commands
  let bashTasks = Object.keys(state.tasks).filter((id) => {
    let t = state.tasks[id];
    return isBashTask(t) && !t.isBackgrounded && t.shellCommand;
  });
  for (let id of bashTasks) backgroundBashTask(id, getState, dispatch);

  // Background all non-backgrounded agent tasks
  let agentTasks = Object.keys(state.tasks).filter((id) => {
    let t = state.tasks[id];
    return isAgentTask(t) && !t.isBackgrounded;
  });
  for (let id of agentTasks) backgroundAgentTask(id, getState, dispatch);
}
```

### For Bash Commands

The `QG1` class (shell command process manager) has a `background(taskId)` method:

1. Changes internal status from `"running"` to `"backgrounded"`
2. Cleans up terminal rendering timers
3. If stdout is already spilling to file, starts polling file size
4. Otherwise calls `spillToDisk()` to redirect stdout from memory buffer to a temp file

The process itself **keeps running** — backgrounding only changes how output is captured (memory → disk) and how the UI renders it.

### For Agent Tasks

Agent tasks are backgrounded by simply setting `isBackgrounded: true` in the React state. The agent subprocess continues running; the TUI just stops rendering it inline and instead shows periodic progress updates.

### Tool Result Messages

When a command is backgrounded, the tool result includes specific fields:

```typescript
interface BashOutput {
  backgroundTaskId?: string;           // ID of the background task
  backgroundedByUser?: boolean;        // true if user pressed Ctrl+B
  assistantAutoBackgrounded?: boolean; // true if auto-backgrounded by timeout
}
```

Result messages vary:
- **User Ctrl+B:** `"Command was manually backgrounded by user with ID: {id}. Output is being written to: {path}"`
- **Auto-background:** `"Command exceeded the assistant-mode blocking budget (15s) and was moved to the background with ID: {id}..."`
- **Explicit `run_in_background: true`:** `"Command running in background with ID: {id}. Output is being written to: {path}"`

---

## Auto-Background Mechanism

### For Bash Commands

Commands auto-background after **2 seconds** (`qwq = 2000`) in normal mode, or **15 seconds** in assistant mode. The flow:

1. Command starts running
2. After 2s timeout, a polling loop begins
3. If `shouldAutoBackground` is true, it creates a background task via `Mzq()` and updates the UI
4. Only `sleep` commands are excluded from auto-backgrounding

### For Agent Tasks

When `CLAUDE_AUTO_BACKGROUND_TASKS` env var is set (or feature flag `tengu_auto_background_agents`), agents auto-background after **120 seconds** (120000ms).

### Disabling Background Tasks

`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` disables all background functionality:
- Removes `run_in_background` from Bash/Agent tool schemas
- Makes Ctrl+B a no-op
- Suppresses auto-background timeouts

---

## Stream-JSON Protocol Analysis

### Output Messages (stdout)

Background tasks produce these stream-json events:

| Event Type | Subtype | Description |
|---|---|---|
| `system` | `task_started` | Background task created (includes `task_id`, `description`, `task_type`, `prompt`) |
| `system` | `task_progress` | Periodic progress update (includes `task_id`, `usage`, `last_tool_name`, `summary`) |
| `system` | `task_notification` | Task completed/failed/stopped (includes `task_id`, `status`, `output_file`, `summary`, `usage`) |
| `tool_progress` | — | Tool execution timing (includes `tool_use_id`, `tool_name`, `elapsed_time_seconds`, `task_id`) |

### Input Messages (stdin)

The stream-json input protocol accepts `SDKUserMessage`:

```typescript
type SDKUserMessage = {
  type: 'user';
  message: MessageParam;         // Anthropic API message format
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  priority?: 'now' | 'next' | 'later';
  timestamp?: string;
  uuid?: UUID;
  session_id: string;
};
```

### Control Requests (via SDK)

The SDK provides `SDKControlRequest` messages sent as control frames. Relevant ones:

```typescript
// Interrupt current turn
{ type: 'control_request', request_id: string, request: { subtype: 'interrupt' } }

// Stop a specific background task
{ type: 'control_request', request_id: string, request: { subtype: 'stop_task', task_id: string } }
```

**There is NO `push_to_background` or `background_task` control request.** The SDK's `Query` interface exposes:
- `interrupt()` — stop the current turn
- `setPermissionMode()` — change permission mode
- `setModel()` — change model
- `setMaxThinkingTokens()` — adjust thinking budget
- `applyFlagSettings()` — update settings

No `background()` or `pushToBackground()` method exists.

---

## Signal Handling

Claude Code handles these signals:
- **SIGINT** — In `--print` mode: ignored. Otherwise triggers shutdown
- **SIGTERM** — Triggers shutdown
- **SIGHUP** — Triggers shutdown
- **SIGCONT** — Used by Ink renderer to redraw after Ctrl+Z suspend

**No signal triggers background mode.** SIGUSR1/SIGUSR2 are not handled.

---

## Conclusion: Can We Trigger Background from the Dashboard?

### What's NOT possible:
1. **No stream-json message** to push a foreground task to background
2. **No signal** to trigger background mode
3. **No control request** for backgrounding in the SDK protocol

### What IS possible:

1. **Use `run_in_background: true`** — When Claude decides to run a bash command or spawn an agent, it can pass `run_in_background: true` in the tool input. This is decided by the LLM, not the user.

2. **Set `CLAUDE_AUTO_BACKGROUND_TASKS=1`** — Agents auto-background after 120s. Bash commands auto-background after 2s.

3. **Use the SDK `interrupt()` method** — You can interrupt the current turn, which stops processing. Not the same as backgrounding but can be used to regain control.

4. **Background is TUI-internal state** — The "backgrounded" state only affects:
   - How the React/Ink TUI renders the task (inline vs. progress indicator)
   - How bash command stdout is captured (memory buffer vs. disk file)
   - Whether the model receives a `backgroundedByUser: true` flag in the tool result

5. **For Orka's use case**, since we don't render inline bash output in a terminal, the "background" concept maps differently:
   - Our sessions already run detached (like "always backgrounded")
   - What we'd want is more like "interrupt current tool and continue" which maps to `interrupt()`
   - Or "don't block the conversation on this command" which maps to `run_in_background: true` (but that's the model's decision)

### Recommendation for Orka Dashboard:

Since Orka sessions already run as background processes with event-sourced output, the Ctrl+B feature doesn't directly apply. The closest equivalent would be:

1. **`interrupt()`** — Send interrupt control request to stop the current turn
2. **Auto-background env var** — Set `CLAUDE_AUTO_BACKGROUND_TASKS=1` when spawning sessions so long-running tools auto-background
3. **System prompt guidance** — Include instructions to use `run_in_background: true` for long commands

The fundamental insight is that Ctrl+B is a **UI-layer feature** that changes how the TUI displays a running task. The underlying process is unaffected — it keeps running regardless. In Orka's architecture, all tasks effectively run in "background mode" already since we stream events rather than rendering an interactive terminal.
